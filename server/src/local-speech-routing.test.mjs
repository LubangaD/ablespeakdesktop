/**
 * Speech recognised on this computer (local-asr.js) and with Gemini, as
 * WsProxy._transcribeClip combines them: commands run on the local words with
 * no Gemini request; everything else waits for Gemini, with the local words
 * as the fallback.
 * Run with:  node --test src/local-speech-routing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsProxy } from './ws-proxy.js';
import { normaliseProfile } from './student-profile.js';

function makeProxy({ speechEngine = 'auto', local = '', online = { text: '' }, localReady = true } = {}) {
  const profile = normaliseProfile({ listening: { speechEngine } }).profile;
  const calls = { local: 0, online: 0 };
  const localAsr = {
    get ready() { return localReady; },
    transcribe: async () => { calls.local++; return typeof local === 'string' ? { text: local, ms: 300 } : local; },
  };
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null, profile: () => profile, localAsr });
  proxy._heartbeatInterval?.unref?.();
  proxy._broadcastDashboard = () => {};
  proxy.voiceHandler.transcribe = async () => { calls.online++; return online; };
  const handled = [];
  proxy._handleUtterance = async (_ws, text) => { handled.push(text); };
  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  const say = (msg = {}) => proxy._processVoiceAudio(ws, { audio: 'a'.repeat(5000), wav: 'UklGRg==', mimeType: 'audio/webm', ...msg });
  return { proxy, calls, handled, sent, say };
}

test('a command heard on this computer runs at once, with no Gemini request', async () => {
  const { calls, handled, say } = makeProxy({ local: 'Scroll down.' });
  await say();
  assert.deepEqual(handled, ['Scroll down.']);
  assert.equal(calls.online, 0);
});

test('"AbleSpeak, open Notepad" counts as a command too', async () => {
  const { calls, handled, say } = makeProxy({ local: 'AbleSpeak, open Notepad.' });
  await say();
  assert.deepEqual(handled, ['AbleSpeak, open Notepad.'], 'the name is taken off later, in _handleUtterance');
  assert.equal(calls.online, 0);
});

test('anything else uses Gemini\'s words', async () => {
  const { calls, handled, say } = makeProxy({ local: 'what is the capital of kenya', online: { text: 'What is the capital of Kenya?' } });
  await say();
  assert.deepEqual(handled, ['What is the capital of Kenya?']);
  assert.equal(calls.online, 1);
});

test('in dictation, when Gemini cannot be reached, the local words are typed', async () => {
  const { proxy, handled, say } = makeProxy({ local: 'the weather is sunny today', online: { text: '', error: 'offline' } });
  proxy._dictationMode = true;
  await say();
  assert.deepEqual(handled, ['the weather is sunny today']);
});

test('outside dictation, local words that are not a command never stand in for Gemini', async () => {
  const { handled, sent, say } = makeProxy({ local: 'but it a quite a', online: { text: '', error: 'offline', message: 'no internet' } });
  await say();
  assert.deepEqual(handled, [], 'room talk heard on this computer is not run as a command');
  assert.equal(sent.at(-1).type, 'voice_error');
  assert.equal(sent.at(-1).error, 'offline');
});

test('when Gemini hears no speech, nothing runs', async () => {
  const { handled, sent, say } = makeProxy({ local: 'hello there', online: { text: '', error: 'no_speech' } });
  await say();
  assert.deepEqual(handled, []);
  assert.equal(sent.at(-1).type, 'voice_no_speech');
});

test('when nothing was heard locally, Gemini decides', async () => {
  const { handled, say } = makeProxy({ local: '', online: { text: 'Habari yako' } });
  await say();
  assert.deepEqual(handled, ['Habari yako']);
});

test('"Online only" never uses this computer', async () => {
  const { calls, handled, say } = makeProxy({ speechEngine: 'online', local: 'scroll down', online: { text: 'Scroll up.' } });
  await say();
  assert.deepEqual(handled, ['Scroll up.']);
  assert.equal(calls.local, 0);
});

test('"This computer only" never uses the internet', async () => {
  const { calls, handled, say } = makeProxy({ speechEngine: 'local', local: 'what is the time', online: { text: 'never' } });
  await say();
  assert.deepEqual(handled, ['what is the time']);
  assert.equal(calls.online, 0);
});

test('"This computer only" with nothing heard is no speech', async () => {
  const { handled, sent, say } = makeProxy({ speechEngine: 'local', local: '' });
  await say();
  assert.deepEqual(handled, []);
  assert.equal(sent.at(-1).type, 'voice_no_speech');
});

test('"This computer only" never falls back to the internet, and says why', async () => {
  for (const setup of [{ localReady: false }, { local: { error: 'timeout' } }]) {
    const { calls, handled, sent, say } = makeProxy({ speechEngine: 'local', online: { text: 'never' }, ...setup });
    await say();
    assert.equal(calls.online, 0);
    assert.deepEqual(handled, []);
    assert.equal(sent.at(-1).type, 'voice_error');
    assert.equal(sent.at(-1).error, 'local_failed');
    assert.match(sent.at(-1).message, /this computer/);
  }
  const noWav = makeProxy({ speechEngine: 'local', local: 'scroll down', online: { text: 'never' } });
  await noWav.say({ wav: undefined });
  assert.equal(noWav.calls.online, 0);
  assert.equal(noWav.sent.at(-1).error, 'local_failed');
});

test('a WAV that is not text, or far too big, is ignored rather than crashing', async () => {
  for (const wav of [12345, { x: 1 }, 'a'.repeat(9 * 1024 * 1024)]) {
    const { calls, handled, say } = makeProxy({ local: 'scroll down', online: { text: 'Scroll down.' } });
    await say({ wav });
    assert.equal(calls.local, 0);
    assert.deepEqual(handled, ['Scroll down.']);
  }
});

test('an engine that throws is treated as a failure, and Gemini answers', async () => {
  const { proxy, handled, say } = makeProxy({ online: { text: 'Open Chrome.' } });
  proxy.localAsr.transcribe = async () => { throw new Error('boom'); };
  await say();
  assert.deepEqual(handled, ['Open Chrome.']);
});

test('only a short "stop" or "cancel" skips Gemini', () => {
  const { proxy } = makeProxy();
  assert.ok(proxy._isKnownCommand('cancel that'));
  assert.ok(!proxy._isKnownCommand('cancel my meeting with John tomorrow'));
});

test('until the engine is ready, or with no WAV in the clip, Gemini hears everything', async () => {
  const notReady = makeProxy({ localReady: false, online: { text: 'Scroll down.' } });
  await notReady.say();
  assert.equal(notReady.calls.local, 0);
  assert.deepEqual(notReady.handled, ['Scroll down.']);
  const noWav = makeProxy({ online: { text: 'Scroll down.' } });
  await noWav.say({ wav: undefined });
  assert.equal(noWav.calls.local, 0);
});

test('a failed local engine falls back to Gemini', async () => {
  const { handled, say } = makeProxy({ local: { error: 'timeout' }, online: { text: 'Open Chrome.' } });
  await say();
  assert.deepEqual(handled, ['Open Chrome.']);
});

test('yes/no to a pending question, stop, sleep and wake count as commands', async () => {
  const { proxy } = makeProxy();
  proxy._pendingConfirmation = { tool: 'close_application', args: {}, prompt: 'Close Word?' };
  assert.ok(proxy._isKnownCommand('Yes.'));
  proxy._pendingConfirmation = null;
  assert.ok(proxy._isKnownCommand('Stop.'));
  assert.ok(proxy._isKnownCommand('go to sleep'));
  assert.ok(proxy._isKnownCommand('Wake up, AbleSpeak.'));
  assert.ok(!proxy._isKnownCommand('tell me a story about lions'));
});

test('while asleep only a wake phrase is acted on locally', async () => {
  const { proxy } = makeProxy();
  proxy._sleeping = true;
  assert.ok(!proxy._isKnownCommand('scroll down'));
  assert.ok(proxy._isKnownCommand('wake up'));
});

test('the overlay is told to send WAV audio only when the engine is in use', () => {
  assert.equal(makeProxy().proxy._listeningForOverlay().localSpeech, true);
  assert.equal(makeProxy({ speechEngine: 'online' }).proxy._listeningForOverlay().localSpeech, false);
  assert.equal(makeProxy({ localReady: false }).proxy._listeningForOverlay().localSpeech, false);
});

test('"AbleSpeak" alone answers "Yes?" even with "Say AbleSpeak first" off', async () => {
  const { proxy, handled, say } = makeProxy({ local: 'AbleSpeak.' });
  const replies = [];
  proxy._broadcastDashboard = msg => { if (msg.type === 'chat_assistant_message') replies.push(msg.text); };
  await say();
  assert.deepEqual(replies, ['Yes?']);
  assert.deepEqual(handled, [], 'not sent to the AI as a question');
});

test('asleep, room talk is not sent to Gemini', async () => {
  const { proxy, calls, say } = makeProxy({ local: 'he said he would come later', online: { text: 'never' } });
  proxy._sleeping = true;
  await say();
  assert.equal(calls.online, 0);
});

test('Gemini is told to stop once the local words are used', async () => {
  const { proxy, say } = makeProxy({ local: 'stop dictation' });
  proxy._dictationMode = true;
  let signal;
  proxy.voiceHandler.transcribe = (_a, _m, opts) => { signal = opts.signal; return new Promise(() => {}); };
  await say();
  assert.ok(signal?.aborted, 'the parallel Gemini request was cancelled');
});

test('real time: a command heard at the first pause runs at once', async () => {
  const { proxy, calls, handled, sent } = makeProxy({ local: 'Scroll down.' });
  const ws = { send: raw => sent.push(JSON.parse(raw)) };
  await proxy._onVoicePeek(ws, { type: 'voice_peek', id: 7, wav: 'UklGRg==', source: 'overlay' });
  assert.deepEqual(sent[0], { type: 'voice_peek_result', id: 7, taken: true });
  assert.deepEqual(handled, ['Scroll down.']);
  assert.equal(calls.local, 1, 'heard once, not again for the turn');
  assert.equal(calls.online, 0);
});

test('real time: anything that is not yet a command is left to the full clip', async () => {
  // "search for" (then "Michael Jackson"), "close" (Alt+F4; then "the tab"), "play" (then a song),
  // the name alone (then the command), and anything that isn't a command
  for (const setup of [{ local: 'search for' }, { local: 'Close.' }, { local: 'play' }, { local: 'AbleSpeak.' },
    { local: 'type' }, { local: 'what is the capital' }, { local: '' }]) {
    const { proxy, handled, sent } = makeProxy(setup);
    const ws = { send: raw => sent.push(JSON.parse(raw)) };
    await proxy._onVoicePeek(ws, { type: 'voice_peek', id: 1, wav: 'UklGRg==' });
    assert.deepEqual(sent, [{ type: 'voice_peek_result', id: 1, taken: false }], JSON.stringify(setup));
    assert.deepEqual(handled, []);
  }
});

test('real time: no checks while dictating, busy, or with the engine off', async () => {
  const cases = [
    p => { p._dictationMode = true; },
    p => { p._voiceProcessing = true; p._voiceTurn = {}; },
    p => { p.localAsr = null; },
  ];
  for (const setUp of cases) {
    const { proxy, calls, handled, sent } = makeProxy({ local: 'scroll down' });
    setUp(proxy);
    const ws = { send: raw => sent.push(JSON.parse(raw)) };
    await proxy._onVoicePeek(ws, { type: 'voice_peek', id: 2, wav: 'UklGRg==' });
    assert.equal(sent[0].taken, false);
    assert.equal(calls.local, 0);
    assert.deepEqual(handled, []);
  }
});

test('real time: with "Say AbleSpeak first", a command without the name waits for the full clip', async () => {
  const profile = normaliseProfile({ listening: { needsName: true } }).profile;
  const { proxy, handled, sent } = makeProxy({ local: 'scroll down' });
  proxy._profile = () => profile;
  const ws = { send: raw => sent.push(JSON.parse(raw)) };
  await proxy._onVoicePeek(ws, { type: 'voice_peek', id: 3, wav: 'UklGRg==' });
  assert.equal(sent[0].taken, false);
  assert.deepEqual(handled, []);
});

test('real time: complete commands act at the first pause', async () => {
  for (const said of ['Go back.', 'Page down', 'new tab', 'AbleSpeak, scroll up', 'volume up']) {
    const { proxy, handled, sent } = makeProxy({ local: said });
    const ws = { send: raw => sent.push(JSON.parse(raw)) };
    await proxy._onVoicePeek(ws, { type: 'voice_peek', id: 9, wav: 'UklGRg==' });
    assert.equal(sent[0].taken, true, said);
    assert.equal(handled.length, 1, said);
  }
});

test('real time: "stop" and "go to sleep" count as complete', () => {
  const { proxy } = makeProxy();
  assert.ok(proxy._isCompleteCommand('Stop.'));
  assert.ok(proxy._isCompleteCommand('go to sleep'));
  assert.ok(!proxy._isCompleteCommand('stop the'));
});

// ── The speech service (remote-asr.js): words streamed while they were said ──
function withRemote(setup = {}, remote = {}) {
  const made = makeProxy({ localReady: false, ...setup });
  const calls = { finish: 0, peek: 0, cancel: 0 };
  made.proxy.remoteAsr = {
    ready: remote.ready ?? true,
    finish: async () => { calls.finish++; return remote.final ?? { text: 'Scroll down.', no_speech_prob: 0.02, avg_logprob: -0.2, ms: 180, waitedMs: 420 }; },
    peek: async () => { calls.peek++; return remote.peeked ?? { text: 'Go back.', no_speech_prob: 0.01 }; },
    cancel: () => { calls.cancel++; },
  };
  return { ...made, remoteCalls: calls };
}

test('the speech service\'s final words are used, with no Gemini request', async () => {
  const { calls, remoteCalls, handled, say } = withRemote({ online: { text: 'never' } });
  await say({ streamUtt: 'x-1', wav: undefined });
  assert.deepEqual(handled, ['Scroll down.']);
  assert.equal(remoteCalls.finish, 1);
  assert.equal(calls.online, 0);
});

test('when the speech service doesn\'t answer, the clip is heard another way', async () => {
  const { calls, handled, say } = withRemote({ online: { text: 'Open Chrome.' } }, { final: { error: 'timeout' } });
  await say({ streamUtt: 'x-2', wav: undefined });
  assert.deepEqual(handled, ['Open Chrome.']);
  assert.equal(calls.online, 1);
});

test('silence the speech service is sure about is no speech', async () => {
  const { handled, sent, say } = withRemote({}, { final: { text: 'you', no_speech_prob: 0.9, avg_logprob: -1.4 } });
  await say({ streamUtt: 'x-3', wav: undefined });
  assert.deepEqual(handled, []);
  assert.equal(sent.at(-1).type, 'voice_no_speech');
});

test('"Online only" never uses the speech service', async () => {
  const { remoteCalls, handled, say } = withRemote({ speechEngine: 'online', online: { text: 'Scroll up.' } });
  await say({ streamUtt: 'x-4', wav: undefined });
  assert.equal(remoteCalls.finish, 0);
  assert.deepEqual(handled, ['Scroll up.']);
});

test('the real-time check can use the speech service, and drops the rest of the stream', async () => {
  const { proxy, remoteCalls, handled, sent } = withRemote();
  const ws = { send: raw => sent.push(JSON.parse(raw)) };
  await proxy._onVoicePeek(ws, { type: 'voice_peek', id: 4, streamUtt: 'x-5', source: 'overlay' });
  assert.deepEqual(sent[0], { type: 'voice_peek_result', id: 4, taken: true });
  assert.deepEqual(handled, ['Go back.']);
  assert.equal(remoteCalls.peek, 1);
  assert.equal(remoteCalls.cancel, 1);
});

test('the voice bar streams only when the service is ready, in "auto", outside exams', () => {
  assert.equal(withRemote().proxy._listeningForOverlay().speechStream, true);
  assert.equal(withRemote({}, { ready: false }).proxy._listeningForOverlay().speechStream, false);
  assert.equal(withRemote({ speechEngine: 'online' }).proxy._listeningForOverlay().speechStream, false);
  const exam = withRemote().proxy;
  exam.examSession = { active: true };
  assert.equal(exam._listeningForOverlay().speechStream, false);
});

test('speaking while the speech service sleeps wakes it (this phrase is heard another way)', async () => {
  const { proxy, handled } = makeProxy({ localReady: false, online: { text: 'Scroll down.' } });
  let started = 0;
  proxy.remoteAsr = { configured: true, state: 'asleep', ready: false, start: () => { started++; } };
  const ws = { send: () => {} };
  await proxy._onVoiceAudio(ws, { audio: 'a'.repeat(5000), mimeType: 'audio/webm', source: 'overlay' });
  assert.equal(started, 1);
  assert.deepEqual(handled, ['Scroll down.']);
});

test('"search for" on a page Chrome won\'t let AbleSpeak touch becomes a Google search', async () => {
  const { proxy } = makeProxy();
  const ran = [];
  proxy.aiEngine = { toolRegistry: { executeTool: async (tool, args) => { ran.push([tool, args]); return { status: 'success' }; } } };
  const result = await proxy._searchFallback(
    { tool: 'search_in_page', args: { query: 'michael jackson' } },
    { status: 'error', message: 'Cannot access a chrome:// URL' });
  assert.deepEqual(ran, [['search_web', { query: 'michael jackson' }]]);
  assert.equal(result.status, 'success');
  const other = await proxy._searchFallback({ tool: 'search_in_page', args: { query: 'x' } }, { status: 'error', message: 'No search box' });
  assert.equal(other.message, 'No search box', 'other failures are left alone');
  assert.equal(ran.length, 1);
});
