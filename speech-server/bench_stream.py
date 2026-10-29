"""Step 0 of real-time speech on Modal: measure before building.

Converts a CDLI Whisper fine-tune to CTranslate2 (what faster-whisper runs)
and times it the way a live stream would use it: the whole utterance so far
transcribed again every half second, then once more at the end.

    modal run speech-server/bench_stream.py::convert --key small
    modal run speech-server/bench_stream.py --key small --gpus T4,L4,A10G

Runs as a temporary app: nothing stays deployed, and GPUs stop with the run.
The converted model is kept in the volume `ablespeak-stream-models` for the
streaming service to load.
"""
import io
import json
import time
import wave
from pathlib import Path

import modal

MODELS = {
    # Kenyan English non-standard speech, CDLI test WER 0.21 (base 0.26)
    "small": "cdli/whisper-small_finetuned_kenyan_english_nonstandard_speech_v1.0",
    # The same, large-v3: WER 0.14 (base 0.20)
    "large-v3": "cdli/whisper-large-v3_finetuned_kenyan_english_nonstandard_speech_v1.0",
}
MODEL_DIR = "/models"

models = modal.Volume.from_name("ablespeak-stream-models", create_if_missing=True)

convert_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install("ctranslate2>=4.5,<5", "transformers>=4.44,<5", "huggingface_hub", "safetensors")
)

# faster-whisper's CTranslate2 needs CUDA 12 with cuDNN 9
gpu_image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .pip_install("faster-whisper>=1.1,<2", "numpy<2")
)

app = modal.App("ablespeak-stream-bench")


@app.function(image=convert_image, volumes={MODEL_DIR: models}, cpu=4, memory=24576, timeout=3600)
def convert(key: str = "small"):
    """Hugging Face checkpoint → CTranslate2, with the files faster-whisper needs."""
    import shutil
    import subprocess

    from huggingface_hub import list_repo_files
    from transformers import WhisperTokenizerFast

    repo = MODELS[key]
    out = Path(MODEL_DIR) / f"{key}-ct2"
    if (out / "model.bin").exists():
        return f"{out} already converted: {sorted(p.name for p in out.iterdir())}"
    files = set(list_repo_files(repo))
    # Without preprocessor_config.json faster-whisper assumes 80 mel bands
    # (large-v3 needs 128); without tokenizer.json it falls back to a tokenizer
    # whose special-token ids are wrong for large-v3. Neither repo ships the latter.
    copy = [f for f in ("preprocessor_config.json", "tokenizer.json") if f in files]
    started = time.time()
    subprocess.run(
        ["ct2-transformers-converter", "--model", repo, "--output_dir", str(out),
         "--quantization", "float16", *(["--copy_files", *copy] if copy else [])],
        check=True,
    )
    if "tokenizer.json" not in copy:
        WhisperTokenizerFast.from_pretrained(repo).save_pretrained("/tmp/tok")
        shutil.copy("/tmp/tok/tokenizer.json", out / "tokenizer.json")
    models.commit()
    return f"converted {repo} in {time.time() - started:.0f} s: {sorted(p.name for p in out.iterdir())}"


def _pcm(wav_bytes: bytes):
    import numpy as np

    with wave.open(io.BytesIO(wav_bytes)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def _bench(key: str, clips: dict, compute_types: list) -> dict:
    """Load the model and time every way the live stream would call it."""
    import subprocess

    t0 = time.time()
    from faster_whisper import WhisperModel
    gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                         capture_output=True, text=True).stdout.strip()
    report = {"gpu": gpu, "import_s": round(time.time() - t0, 2), "runs": []}
    audio = {name: _pcm(data) for name, data in clips.items()}
    opts = dict(language="en", beam_size=1, temperature=0.0, without_timestamps=True,
                condition_on_previous_text=False, vad_filter=False)

    for compute_type in compute_types:
        t = time.time()
        model = WhisperModel(str(Path(MODEL_DIR) / f"{key}-ct2"), device="cuda", compute_type=compute_type)
        run = {"compute_type": compute_type, "load_s": round(time.time() - t, 2), "clips": {}, "stream": {}}
        list(model.transcribe(audio[next(iter(audio))][:16000], **opts)[0])  # warm up

        # Whole clips: the final transcript at the end of an utterance
        for name, pcm in audio.items():
            t = time.time()
            segments, _ = model.transcribe(pcm, **opts)
            text = " ".join(s.text.strip() for s in segments)
            run["clips"][name] = {"seconds": round(len(pcm) / 16000, 1), "ms": round((time.time() - t) * 1000), "text": text}

        # Live partials: the utterance so far, every 0.5 s
        for name in [n for n in audio if n.startswith("stream-")]:
            pcm, times = audio[name], []
            for end in range(8000, len(pcm) + 1, 8000):
                t = time.time()
                list(model.transcribe(pcm[:end], **opts)[0])
                times.append(round((time.time() - t) * 1000))
            run["stream"][name] = {"updates": len(times), "mean_ms": round(sum(times) / len(times)), "max_ms": max(times)}
        report["runs"].append(run)
        del model
    report["total_s"] = round(time.time() - t0, 1)
    return report


common = dict(image=gpu_image, volumes={MODEL_DIR: models}, timeout=1200)


@app.function(gpu="T4", **common)
def bench_t4(key: str, clips: dict, compute_types: list):
    return _bench(key, clips, compute_types)


@app.function(gpu="L4", **common)
def bench_l4(key: str, clips: dict, compute_types: list):
    return _bench(key, clips, compute_types)


@app.function(gpu="A10G", **common)
def bench_a10g(key: str, clips: dict, compute_types: list):
    return _bench(key, clips, compute_types)


BENCH = {"T4": bench_t4, "L4": bench_l4, "A10G": bench_a10g}


@app.local_entrypoint()
def main(key: str = "small", gpus: str = "T4,L4,A10G", clips_dir: str = "", compute: str = "float16,int8_float16"):
    """Times each GPU in turn; the first call to each includes its cold start."""
    folder = Path(clips_dir) if clips_dir else Path(__file__).parent / "bench-clips"
    clips = {p.stem: p.read_bytes() for p in sorted(folder.glob("*.wav"))}
    print(f"{len(clips)} clips from {folder}: {', '.join(clips)}")
    results = {}
    for gpu in gpus.split(","):
        started = time.time()
        report = BENCH[gpu].remote(key, clips, compute.split(","))
        report["call_s"] = round(time.time() - started, 1)  # includes the cold start
        results[gpu] = report
        print(json.dumps({gpu: report}, indent=1))
    out = Path(__file__).parent / f"bench-{key}.json"
    out.write_text(json.dumps(results, indent=1))
    print(f"saved {out}")
