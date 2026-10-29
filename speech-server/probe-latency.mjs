// Step 0: time messages from this computer to the latency probe and back.
//   node speech-server/probe-latency.mjs <probe url> [<probe url> …]
// For each URL: HTTP ping on one kept-alive connection, then a WebSocket
// echo of a short text and of 100 ms of 16 kHz audio (3,200 bytes), as the
// live stream would send it.
import { createRequire } from 'module';
import https from 'https';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');

const percentile = (list, p) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))];
const summary = list => `median ${percentile(list, 0.5)} ms, p90 ${percentile(list, 0.9)} ms, min ${Math.min(...list)} ms`;

async function httpPings(base, count = 15) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  const get = () => new Promise((resolve, reject) => {
    const started = performance.now();
    https.get(`${base}/ping`, { agent }, res => { res.resume(); res.on('end', () => resolve(performance.now() - started)); }).on('error', reject);
  });
  const first = Math.round(await get()); // includes TLS and a possible wake-up
  const times = [];
  for (let i = 0; i < count; i++) times.push(Math.round(await get()));
  agent.destroy();
  return { first, times };
}

function wsEcho(base, count = 20) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/echo`);
    const text = [], audio = [];
    let connectMs = 0;
    const frame = Buffer.alloc(3200);
    const once = payload => new Promise(done => {
      const t = performance.now();
      ws.once('message', () => done(Math.round(performance.now() - t)));
      ws.send(payload);
    });
    ws.on('open', async () => {
      connectMs = Math.round(performance.now() - started);
      for (let i = 0; i < count; i++) text.push(await once(`ping ${i}`));
      for (let i = 0; i < count; i++) audio.push(await once(frame));
      ws.close();
      resolve({ connectMs, text, audio });
    });
    ws.on('error', reject);
  });
}

for (const url of process.argv.slice(2)) {
  const base = url.replace(/\/$/, '');
  console.log(`\n${base}`);
  try {
    const http = await httpPings(base);
    console.log(`  HTTP ping: first ${http.first} ms, then ${summary(http.times)}`);
    const ws = await wsEcho(base);
    console.log(`  WebSocket connect ${ws.connectMs} ms`);
    console.log(`  WebSocket echo, text: ${summary(ws.text)}`);
    console.log(`  WebSocket echo, 100 ms of audio: ${summary(ws.audio)}`);
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }
}
