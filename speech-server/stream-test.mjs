// Stream test clips to the speech service the way AbleSpeak will: 100 ms of
// 16 kHz audio at a time, in real time, then "end". Prints the live words as
// they arrive and how long the final words took after the end of speech.
//   node speech-server/stream-test.mjs [clip names…]
// Reads ABLESPEAK_ASR_URL and ABLESPEAK_ASR_TOKEN from server/.env.
import { readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');

const env = Object.fromEntries(readFileSync(new URL('../server/.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(line => /^ABLESPEAK_ASR_/.test(line)).map(line => line.split(/=(.*)/s).slice(0, 2)));
const url = env.ABLESPEAK_ASR_URL;
const clipsDir = new URL('./bench-clips/', import.meta.url);
const wanted = process.argv.slice(2);
const clips = readdirSync(clipsDir).filter(f => f.endsWith('.wav') && (!wanted.length || wanted.includes(f.replace('.wav', ''))));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The PCM samples of a 16 kHz mono 16-bit WAV (finds the "data" chunk)
function pcmOf(file) {
  const buf = readFileSync(new URL(file, clipsDir));
  let at = 12;
  while (at < buf.length - 8) {
    const id = buf.toString('ascii', at, at + 4), size = buf.readUInt32LE(at + 4);
    if (id === 'data') return buf.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error(`no audio in ${file}`);
}

const started = performance.now();
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${env.ABLESPEAK_ASR_TOKEN}` } });
const waiting = new Map(); // what each awaited message type resolves
const on = type => new Promise(resolve => waiting.set(type, resolve));
let utt = 0, uttStart = 0, endSent = 0;
const finals = [];

ws.on('message', raw => {
  const msg = JSON.parse(raw);
  const t = Math.round(performance.now() - uttStart);
  if (msg.type === 'partial') console.log(`   +${String(t).padStart(5)} ms  live: "${msg.text}" (GPU ${msg.ms} ms)`);
  if (msg.type === 'final') {
    const after = Math.round(performance.now() - endSent);
    finals.push(after);
    console.log(`   final ${after} ms after the end of speech (GPU ${msg.ms} ms): "${msg.text}"  no-speech ${msg.no_speech_prob}`);
  }
  waiting.get(msg.type)?.(msg);
});
ws.on('unexpected-response', (_req, res) => { console.log(`refused: HTTP ${res.statusCode}`); process.exit(1); });
ws.on('error', err => { console.log(`error: ${err.message}`); process.exit(1); });

const ready = await on('ready');
console.log(`ready after ${Math.round(performance.now() - started)} ms (includes waking the service) on ${ready.gpu}`);

// Network round trip on the open connection
const pings = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  ws.send(JSON.stringify({ type: 'ping', t }));
  await on('pong');
  pings.push(Math.round(performance.now() - t));
}
pings.sort((a, b) => a - b);
console.log(`round trip: median ${pings[5]} ms, min ${pings[0]} ms, max ${pings[9]} ms`);

for (const file of clips) {
  const pcm = pcmOf(file);
  console.log(`\n${file} (${(pcm.length / 32000).toFixed(1)} s)`);
  utt += 1;
  uttStart = performance.now();
  ws.send(JSON.stringify({ type: 'start', utt, prompt: 'AbleSpeak' }));
  for (let at = 0; at < pcm.length; at += 3200) {
    ws.send(pcm.subarray(at, at + 3200));
    await sleep(100); // real time
  }
  endSent = performance.now();
  ws.send(JSON.stringify({ type: 'end', utt }));
  await on('final');
}
finals.sort((a, b) => a - b);
console.log(`\nfinal words after the end of speech: median ${finals[Math.floor(finals.length / 2)]} ms, min ${finals[0]} ms, max ${finals.at(-1)} ms`);
ws.close();
