/**
 * The connection to AbleSpeak's speech service (remote-asr.js), against a fake
 * service speaking the same protocol as speech-server/stream_service.py.
 * Run with:  node --test src/remote-asr.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { RemoteAsr } from './remote-asr.js';

const TOKEN = 'test-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A fake speech service. `heard` is what its "model" returns for any audio. */
async function fakeService({ heard = 'Scroll down.', finalDelayMs = 10, sendReady = true, answerFinals = true } = {}) {
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: info => info.req.headers.authorization === `Bearer ${TOKEN}`,
  });
  await new Promise(resolve => wss.once('listening', resolve));
  const seen = { messages: [], audioBytes: 0, sockets: [] };
  wss.on('connection', ws => {
    seen.sockets.push(ws);
    let utt = null;
    if (sendReady) ws.send(JSON.stringify({ type: 'ready', models: ['small', 'large-v3'], gpu: 'Fake GPU' }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        seen.audioBytes += raw.length;
        if (utt != null) ws.send(JSON.stringify({ type: 'partial', utt, text: heard.slice(0, 6) }));
        return;
      }
      const msg = JSON.parse(raw);
      seen.messages.push(msg);
      if (msg.type === 'start') utt = msg.utt;
      if (msg.type === 'peek') ws.send(JSON.stringify({ type: 'peeked', utt: msg.utt, id: msg.id, text: heard, no_speech_prob: 0.01, ms: 5 }));
      if (msg.type === 'end' && answerFinals) {
        const ended = msg.utt;
        utt = null;
        setTimeout(() => ws.send(JSON.stringify({ type: 'final', utt: ended, text: heard, no_speech_prob: 0.02, avg_logprob: -0.2, ms: 7 })), finalDelayMs);
      }
      if (msg.type === 'cancel') utt = null;
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}/v1/stream`;
  return { url, seen, close: () => new Promise(r => { for (const s of seen.sockets) s.terminate(); wss.close(r); }) };
}

async function readyClient(service, options = {}) {
  const partials = [];
  const asr = new RemoteAsr({ url: service.url, token: TOKEN, onPartial: (utt, text) => partials.push([utt, text]), ...options });
  asr.start();
  for (let i = 0; i < 100 && !asr.ready; i++) await sleep(10);
  return { asr, partials };
}

test('without an address and key it stays unconfigured and never connects', () => {
  const asr = new RemoteAsr({});
  assert.equal(asr.state, 'unconfigured');
  asr.start();
  assert.equal(asr.state, 'unconfigured');
  assert.equal(asr.beginUtterance('a-1'), false);
});

test('connects with its key and is ready when the service says so', async () => {
  const service = await fakeService();
  const states = [];
  const { asr } = await readyClient(service, { onChange: s => states.push(s) });
  try {
    assert.equal(asr.ready, true);
    assert.equal(asr.status().gpu, 'Fake GPU');
    assert.deepEqual(states, ['connecting', 'ready']);
  } finally { asr.stop(); await service.close(); }
});

test('a refused key is reported, not retried every second', async () => {
  const service = await fakeService();
  const asr = new RemoteAsr({ url: service.url, token: 'wrong' });
  asr.start();
  for (let i = 0; i < 100 && asr.state !== 'failed'; i++) await sleep(10);
  try {
    assert.equal(asr.state, 'failed');
    assert.match(asr.status().error, /refused/);
  } finally { asr.stop(); await service.close(); }
});

test('streams an utterance and collects its final words', async () => {
  const service = await fakeService({ heard: 'Scroll down.' });
  const { asr, partials } = await readyClient(service);
  try {
    assert.equal(asr.beginUtterance('p-1', 'AbleSpeak'), true);
    asr.sendAudio('p-1', Buffer.alloc(3200));
    asr.sendAudio('p-1', Buffer.alloc(3200));
    await sleep(30);
    asr.end('p-1');
    const result = await asr.finish('p-1', 1000);
    assert.equal(result.text, 'Scroll down.');
    assert.ok(result.waitedMs >= 0);
    assert.equal(service.seen.audioBytes, 6400);
    assert.deepEqual(service.seen.messages.find(m => m.type === 'start'), { type: 'start', utt: 'p-1', prompt: 'AbleSpeak' });
    assert.ok(partials.length >= 1 && partials.every(([utt]) => utt === 'p-1'), 'live words for this utterance');
  } finally { asr.stop(); await service.close(); }
});

test('a final that arrived before its clip is still collected (dictation queues)', async () => {
  const service = await fakeService({ heard: 'the weather is sunny' });
  const { asr } = await readyClient(service);
  try {
    asr.beginUtterance('p-2');
    asr.end('p-2');
    await sleep(80);
    assert.equal((await asr.finish('p-2', 100)).text, 'the weather is sunny');
  } finally { asr.stop(); await service.close(); }
});

test('finish() gives up after its timeout, and on an utterance never streamed', async () => {
  const service = await fakeService({ answerFinals: false });
  const { asr } = await readyClient(service);
  try {
    asr.beginUtterance('p-3');
    const started = Date.now();
    assert.deepEqual(await asr.finish('p-3', 150), { error: 'timeout' });
    assert.ok(Date.now() - started < 1000);
    assert.equal((await asr.finish('never', 100)).error, 'not streamed');
  } finally { asr.stop(); await service.close(); }
});

test('the real-time check returns the words so far without ending the utterance', async () => {
  const service = await fakeService({ heard: 'Go back.' });
  const { asr } = await readyClient(service);
  try {
    asr.beginUtterance('p-4');
    const peeked = await asr.peek('p-4', 1000);
    assert.equal(peeked.text, 'Go back.');
    assert.equal(service.seen.messages.some(m => m.type === 'end'), false);
    assert.equal((await asr.peek('other', 100)).error, 'not streamed');
  } finally { asr.stop(); await service.close(); }
});

test('a dropped connection ends the waiting at once and reconnects by itself', async () => {
  const service = await fakeService({ answerFinals: false });
  const states = [];
  const { asr } = await readyClient(service, { onChange: s => states.push(s) });
  try {
    asr.beginUtterance('p-5');
    asr.end('p-5');
    const waiting = asr.finish('p-5', 5000);
    for (const s of service.seen.sockets) s.terminate();
    const result = await waiting;
    assert.match(result.error, /closed/);
    assert.equal(asr.beginUtterance('p-6'), false, 'nothing streams while reconnecting');
    for (let i = 0; i < 300 && !asr.ready; i++) await sleep(10);
    assert.equal(asr.ready, true, 'back after about a second');
    assert.ok(states.includes('reconnecting'));
  } finally { asr.stop(); await service.close(); }
});

test('cancel drops the utterance; later audio for it is not sent', async () => {
  const service = await fakeService();
  const { asr } = await readyClient(service);
  try {
    asr.beginUtterance('p-7');
    asr.cancel('p-7');
    assert.equal(asr.sendAudio('p-7', Buffer.alloc(3200)), false);
    await sleep(30);
    assert.equal(service.seen.messages.at(-1).type, 'cancel');
  } finally { asr.stop(); await service.close(); }
});
