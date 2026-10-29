"""AbleSpeak's real-time speech recognition, on Modal.

The desktop streams 16 kHz audio over one WebSocket and gets words back while
the person is still speaking (CDLI Whisper small, about every half second),
then the final words when they stop (CDLI Whisper large-v3, WER 0.14 on Kenyan
English non-standard speech). Both models stay loaded on one GPU in Europe,
the nearest Modal region to Kenya.

    modal secret create ablespeak-stream STREAM_TOKEN=<long random string>
    modal deploy speech-server/stream_service.py

The models come from the volume `ablespeak-stream-models`, filled by
bench_stream.py::convert. The service sleeps when nobody is connected and
wakes on the first connection (AbleSpeak connects when it opens).

Protocol: wss://<url>/v1/stream with the header Authorization: Bearer <token>
  server → {"type":"ready","models":[…],"gpu":"…"}
  client → {"type":"start","utt":7,"prompt":"AbleSpeak, Derrick"} then binary
           frames of 16 kHz mono PCM16 (about 100 ms each)
  server → {"type":"partial","utt":7,"text":"scroll do","ms":58}   (about every 0.5 s)
  client → {"type":"end","utt":7}    or {"type":"cancel","utt":7}
  server → {"type":"final","utt":7,"text":"Scroll down.","no_speech_prob":0.01,
            "avg_logprob":-0.21,"ms":231,"seconds":1.8,"model":"large-v3"}
  client → {"type":"peek","utt":7,"id":3}   (the words so far, at a short pause;
           the utterance carries on)
  server → {"type":"peeked","utt":7,"id":3,"text":"Scroll down.","no_speech_prob":…,"ms":170}
  client → {"type":"ping","t":…}  server → {"type":"pong","t":…}
"""
import asyncio
import hmac
import json
import os
import subprocess
import time

import modal

MODEL_DIR = "/models"
SAMPLE_RATE = 16000
PARTIAL_EVERY_S = 0.5          # live words while speaking
PARTIAL_NEW_AUDIO_S = 0.25     # …only when this much new sound has arrived
MAX_UTTERANCE_S = 30           # Whisper's window; longer speech is cut here

models = modal.Volume.from_name("ablespeak-stream-models")
image = (
    # faster-whisper's CTranslate2 needs CUDA 12 with cuDNN 9
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .pip_install("faster-whisper>=1.1,<2", "numpy<2", "fastapi[standard]")
)
app = modal.App("ablespeak-stream", image=image)


@app.cls(
    gpu=["A10G", "L4"],            # A10G first (large-v3 final in ~0.2 s); L4 if none is free
    region="eu",
    routing_region="eu-west",      # requests enter Modal in Europe, not the US
    volumes={MODEL_DIR: models},
    secrets=[modal.Secret.from_name("ablespeak-stream")],
    min_containers=0,              # asleep (and free) when nobody is connected
    max_containers=2,              # a ceiling on cost
    scaledown_window=300,          # stays awake 5 min after the last connection
    timeout=3600,                  # a connection lasts up to an hour; the desktop reconnects
)
@modal.concurrent(max_inputs=8)   # several people share one GPU
class Stream:
    @modal.enter()
    def load(self):
        import numpy as np
        from faster_whisper import WhisperModel

        started = time.time()
        self.live = WhisperModel(f"{MODEL_DIR}/small-ct2", device="cuda", compute_type="int8_float16", num_workers=4)
        self.final = WhisperModel(f"{MODEL_DIR}/large-v3-ct2", device="cuda", compute_type="float16", num_workers=2)
        # The first call at each length was slow in Step 0 (up to 2.5 s): do those now
        for seconds in (1, 3, 6, 10):
            silence = np.zeros(SAMPLE_RATE * seconds, dtype=np.float32)
            self.transcribe(self.live, silence)
            self.transcribe(self.final, silence)
        self.load_s = round(time.time() - started, 1)
        self.gpu = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                                  capture_output=True, text=True).stdout.strip()
        print(f"models ready in {self.load_s} s on {self.gpu}")

    def transcribe(self, model, audio, prompt=None):
        """Words, no-speech probability and mean log-probability for one clip."""
        segments, _ = model.transcribe(
            audio, language="en", beam_size=1, temperature=0.0, without_timestamps=True,
            condition_on_previous_text=False, vad_filter=False, initial_prompt=prompt or None,
        )
        segments = list(segments)
        text = " ".join(s.text.strip() for s in segments).strip()
        no_speech = round(segments[0].no_speech_prob, 3) if segments else 1.0
        logprob = round(sum(s.avg_logprob for s in segments) / len(segments), 3) if segments else None
        return text, no_speech, logprob

    @modal.asgi_app(label="ablespeak-stream")
    def web(self):
        from fastapi import FastAPI, Header, HTTPException, WebSocket

        expected = f"Bearer {os.environ['STREAM_TOKEN']}"
        authorised = lambda value: hmac.compare_digest(value or "", expected)
        api = FastAPI()

        @api.get("/health")
        def health(authorization: str | None = Header(default=None)):
            if not authorised(authorization):
                raise HTTPException(status_code=401)
            return {"ready": True, "models": ["small", "large-v3"], "gpu": self.gpu, "load_s": self.load_s}

        @api.websocket("/v1/stream")
        async def stream(ws: WebSocket):
            if not authorised(ws.headers.get("authorization")):
                await ws.close(code=1008)  # before accept: the handshake is refused (403)
                return
            await ws.accept()
            await Session(self, ws).run()

        return api


class Session:
    """One desktop's connection: one utterance at a time."""

    def __init__(self, service, ws):
        import numpy as np

        self.np = np
        self.service = service
        self.ws = ws
        self.send_lock = asyncio.Lock()
        self.utt = None          # the utterance being spoken, or None
        self.chunks = []
        self.samples = 0
        self.partial_at = 0      # samples heard when the last live words were made
        self.prompt = None

    async def send(self, message):
        async with self.send_lock:
            await self.ws.send_text(json.dumps(message))

    def audio(self):
        return self.np.concatenate(self.chunks) if self.chunks else self.np.zeros(0, dtype=self.np.float32)

    async def run(self):
        await self.send({"type": "ready", "models": ["small", "large-v3"], "gpu": self.service.gpu})
        live = asyncio.create_task(self.live_words())
        try:
            while True:
                message = await self.ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    if self.utt is not None and self.samples < SAMPLE_RATE * MAX_UTTERANCE_S:
                        pcm = self.np.frombuffer(message["bytes"], dtype=self.np.int16).astype(self.np.float32) / 32768
                        self.chunks.append(pcm)
                        self.samples += len(pcm)
                    continue
                data = json.loads(message.get("text") or "{}")
                kind = data.get("type")
                if kind == "start":
                    self.utt, self.chunks, self.samples, self.partial_at = data.get("utt"), [], 0, 0
                    self.prompt = data.get("prompt") or None
                elif kind == "end" and data.get("utt") == self.utt:
                    utt, audio, prompt = self.utt, self.audio(), self.prompt
                    self.utt, self.chunks, self.samples = None, [], 0
                    asyncio.create_task(self.final_words(utt, audio, prompt))
                elif kind == "peek" and data.get("utt") == self.utt:
                    asyncio.create_task(self.peek_words(self.utt, data.get("id"), self.audio(), self.prompt))
                elif kind == "cancel":
                    self.utt, self.chunks, self.samples = None, [], 0
                elif kind == "ping":
                    await self.send({"type": "pong", "t": data.get("t")})
        finally:
            live.cancel()

    async def live_words(self):
        while True:
            await asyncio.sleep(PARTIAL_EVERY_S)
            if self.utt is None or self.samples - self.partial_at < SAMPLE_RATE * PARTIAL_NEW_AUDIO_S:
                continue
            utt, audio, prompt = self.utt, self.audio(), self.prompt
            self.partial_at = self.samples
            started = time.time()
            text, _, _ = await asyncio.to_thread(self.service.transcribe, self.service.live, audio, prompt)
            if utt == self.utt and text:  # not after the utterance has ended
                await self.send({"type": "partial", "utt": utt, "text": text, "ms": round((time.time() - started) * 1000)})

    async def peek_words(self, utt, peek_id, audio, prompt):
        """The accurate words so far, at a short pause: is it a whole command yet?"""
        started = time.time()
        text, no_speech, _ = ("", 1.0, None) if len(audio) < SAMPLE_RATE * 0.2 else \
            await asyncio.to_thread(self.service.transcribe, self.service.final, audio, prompt)
        await self.send({"type": "peeked", "utt": utt, "id": peek_id, "text": text, "no_speech_prob": no_speech,
                         "ms": round((time.time() - started) * 1000)})

    async def final_words(self, utt, audio, prompt):
        started = time.time()
        if len(audio) < SAMPLE_RATE * 0.2:
            await self.send({"type": "final", "utt": utt, "text": "", "no_speech_prob": 1.0, "ms": 0, "seconds": 0, "model": "large-v3"})
            return
        text, no_speech, logprob = await asyncio.to_thread(self.service.transcribe, self.service.final, audio, prompt)
        await self.send({
            "type": "final", "utt": utt, "text": text, "no_speech_prob": no_speech, "avg_logprob": logprob,
            "ms": round((time.time() - started) * 1000), "seconds": round(len(audio) / SAMPLE_RATE, 1), "model": "large-v3",
        })
