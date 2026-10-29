"""Step 0: how long a message takes from this computer to Modal and back.

A tiny CPU service (no GPU, no data) with an HTTP ping and a WebSocket echo,
in Modal's default US-East region and in Europe:

    modal serve speech-server/latency_probe.py

then run `node speech-server/probe-latency.mjs <url> <url>` against the two
printed URLs. `modal serve` keeps it up only while the command runs.
"""
import modal

image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]")
app = modal.App("ablespeak-latency-probe", image=image)


def _server():
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect

    web = FastAPI()

    @web.get("/ping")
    def ping():
        return {"ok": True}

    @web.websocket("/echo")
    async def echo(ws: WebSocket):
        await ws.accept()
        try:
            while True:
                message = await ws.receive()
                if message.get("bytes") is not None:
                    await ws.send_bytes(message["bytes"])
                elif message.get("text") is not None:
                    await ws.send_text(message["text"])
                else:
                    break
        except WebSocketDisconnect:
            pass

    return web


@app.function(min_containers=1)
@modal.asgi_app(label="ablespeak-probe-us")
def probe_us():
    return _server()


@app.function(min_containers=1, region="eu", routing_region="eu-west")
@modal.asgi_app(label="ablespeak-probe-eu")
def probe_eu():
    return _server()
