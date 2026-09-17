/**
 * Tests for continuous dictation: starting it, queueing phrases spoken while
 * earlier ones are typed, commands said mid-dictation, and the reply and
 * transcript filters that kept reading junk aloud.
 * Run with: node --test src/dictation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsProxy, matchDictationPrefixCommand } from './ws-proxy.js';
import { matchFastCommand } from './fast-commands.js';
import { VoiceHandler, isInventedTranscript } from './voice-handler.js';
import { AIEngine, cleanReply } from './ai-engine.js';

const INVENTED = "I'm going to go ahead and say that I'm not going to be able to make it to the meeting today.";

function makeProxy() {
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null });
  proxy._heartbeatInterval?.unref?.();
  const broadcasts = [];
  proxy._broadcastDashboard = (msg) => broadcasts.push(msg);

  // Each clip's transcription stays pending until the test answers it.
  const transcribing = new Map();
  proxy.voiceHandler.transcribe = (audio) => new Promise(resolve => transcribing.set(audio, resolve));

  const typed = [];
  proxy._dictateAndReport = async (text) => { typed.push(text); return null; };

  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  return { proxy, broadcasts, transcribing, typed, sent, ws };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

// ── Starting dictation ─────────────────────────────────────────────────────

test('"dictate <text>" starts dictation and keeps the text as spoken', () => {
  assert.deepEqual(matchFastCommand('dictate My name is Derek Lubanga.').args,
    { enabled: true, initialText: 'My name is Derek Lubanga.' });
});

test('"<text>. Dictate." starts dictation with the sentence before it', () => {
  assert.deepEqual(matchFastCommand('My name is Derek Lubanga. Dictate.').args,
    { enabled: true, initialText: 'My name is Derek Lubanga.' });
  assert.deepEqual(matchFastCommand('My name is Derek, dictate').args,
    { enabled: true, initialText: 'My name is Derek' });
});

test('a sentence that only mentions dictation does not start it', () => {
  for (const phrase of ['I want to dictate', 'Let me dictate.', 'This is the end of dictation', 'Hello world dictation', "Please don't dictate", 'I will not dictate']) {
    assert.equal(matchFastCommand(phrase), null, `"${phrase}"`);
  }
});

test('the plain start and stop phrases still work', () => {
  assert.deepEqual(matchFastCommand('Dictation.').args, { enabled: true });
  assert.deepEqual(matchFastCommand('start dictation').args, { enabled: true });
  assert.deepEqual(matchFastCommand('stop dictation').args, { enabled: false });
});

// ── Commands said during dictation ─────────────────────────────────────────

test('"AbleSpeak, <command>" is a command; other sentences with the name are text', () => {
  assert.equal(matchDictationPrefixCommand('AbleSpeak, open Chrome.'), 'open Chrome.');
  assert.equal(matchDictationPrefixCommand('Able speak scroll down'), 'scroll down');
  assert.equal(matchDictationPrefixCommand('Hey AbleSpeak, stop dictation.'), 'stop dictation.');
  assert.equal(matchDictationPrefixCommand('AbleSpeak is great'), null);
  assert.equal(matchDictationPrefixCommand('AbleSpeak helps me write'), null);
  assert.equal(matchDictationPrefixCommand('I love AbleSpeak, open it'), null);
});

test('in dictation, "AbleSpeak, scroll down" runs the command instead of typing it', async () => {
  const { proxy, transcribing, typed, ws } = makeProxy();
  const tools = [];
  proxy.aiEngine = {
    toolRegistry: { executeTool: async (tool, args) => { tools.push({ tool, args }); return { status: 'success' }; } },
  };
  proxy._dictationMode = true;

  const done = proxy._onVoiceAudio(ws, { audio: 'clip' });
  await settle();
  transcribing.get('clip')({ text: 'AbleSpeak, scroll down.' });
  await done;

  assert.deepEqual(typed, []);
  assert.deepEqual(tools, [{ tool: 'scroll', args: { direction: 'down' } }]);
  assert.equal(proxy._dictationMode, true, 'dictation stays on for the next phrase');
});

test('in dictation, a sentence that merely starts with the name is typed', async () => {
  const { proxy, transcribing, typed, ws } = makeProxy();
  proxy._dictationMode = true;

  const done = proxy._onVoiceAudio(ws, { audio: 'clip' });
  await settle();
  transcribing.get('clip')({ text: 'AbleSpeak is great.' });
  await done;

  assert.deepEqual(typed, ['AbleSpeak is great. ']);
});

// ── Talking while earlier speech is typed ──────────────────────────────────

test('phrases spoken during dictation wait their turn and are typed in order', async () => {
  const { proxy, transcribing, typed, sent, ws } = makeProxy();
  proxy._dictationMode = true;

  const first = proxy._onVoiceAudio(ws, { audio: 'clip-1' });
  const second = proxy._onVoiceAudio(ws, { audio: 'clip-2' });
  const third = proxy._onVoiceAudio(ws, { audio: 'clip-3' });
  await settle();
  assert.deepEqual([...transcribing.keys()], ['clip-1'], 'one phrase at a time');
  assert.deepEqual(sent, [], 'nothing is turned away');

  transcribing.get('clip-1')({ text: 'My name is Derek.' });
  await first;
  await settle();
  transcribing.get('clip-2')({ text: 'I live in Nairobi.' });
  await second;
  await settle();
  transcribing.get('clip-3')({ text: 'I study computer science.' });
  await third;

  assert.deepEqual(typed, ['My name is Derek. ', 'I live in Nairobi. ', 'I study computer science. ']);
  assert.equal(proxy._voiceProcessing, false);
  assert.deepEqual(proxy._voiceTurnWaiters, []);
});

test('a phrase that transcribes to nothing does not hold up the next one', async () => {
  const { proxy, transcribing, typed, sent, ws } = makeProxy();
  proxy._dictationMode = true;

  const first = proxy._onVoiceAudio(ws, { audio: 'clip-1' });
  const second = proxy._onVoiceAudio(ws, { audio: 'clip-2' });
  await settle();
  transcribing.get('clip-1')({ text: '', error: 'no_speech' });
  await first;
  await settle();
  transcribing.get('clip-2')({ text: 'Hello.' });
  await second;

  assert.deepEqual(sent.map(m => m.type), ['voice_no_speech']);
  assert.deepEqual(typed, ['Hello. ']);
});

test('outside dictation, a clip during a running command is still turned away', async () => {
  const { proxy, transcribing, sent, ws } = makeProxy();

  const first = proxy._onVoiceAudio(ws, { audio: 'clip-1' });
  await proxy._onVoiceAudio(ws, { audio: 'clip-2' });
  assert.deepEqual(sent.map(m => m.type), ['voice_busy']);
  assert.equal(transcribing.has('clip-2'), false);

  transcribing.get('clip-1')({ text: '', error: 'no_speech' });
  await first;
});

test('a full dictation queue turns further phrases away instead of growing forever', async () => {
  const { proxy, transcribing, sent, ws } = makeProxy();
  proxy._dictationMode = true;

  const running = [];
  for (let i = 0; i < 10; i++) running.push(proxy._onVoiceAudio(ws, { audio: `clip-${i}` }));
  await settle();
  assert.deepEqual(sent.map(m => m.type), ['voice_busy'], 'one in progress, eight waiting, the tenth refused');

  for (let i = 0; i < 9; i++) {
    await settle();
    transcribing.get(`clip-${i}`)({ text: '', error: 'no_speech' });
    await running[i];
  }
  assert.equal(proxy._voiceProcessing, false);
});

test('after a stuck clip is released, queued phrases still go first, in order', async () => {
  const { proxy, transcribing, typed, ws } = makeProxy();
  proxy._dictationMode = true;

  proxy._onVoiceAudio(ws, { audio: 'stuck' });            // never answers
  const second = proxy._onVoiceAudio(ws, { audio: 'clip-2' });
  await settle();
  proxy._voiceProcessingSince = Date.now() - 61000;        // looks hung
  const third = proxy._onVoiceAudio(ws, { audio: 'clip-3' });
  await settle();
  assert.deepEqual([...transcribing.keys()], ['stuck', 'clip-2'], 'clip-2 is handed the turn, not clip-3');

  transcribing.get('clip-2')({ text: 'Second.' });
  await second;
  await settle();
  transcribing.get('clip-3')({ text: 'Third.' });
  await third;
  assert.deepEqual(typed, ['Second. ', 'Third. ']);
});

test('a turn that was force-released cannot free the turn that replaced it', () => {
  const { proxy } = makeProxy();
  const stuck = proxy._beginVoiceTurn();
  proxy._endVoiceTurn(stuck);
  const current = proxy._beginVoiceTurn();
  proxy._endVoiceTurn(stuck);
  assert.equal(proxy._voiceProcessing, true);
  proxy._endVoiceTurn(current);
  assert.equal(proxy._voiceProcessing, false);
});

// ── Junk that used to be typed or read aloud ───────────────────────────────

test('the meeting sentence Gemini invents for background noise is recognised', () => {
  assert.equal(isInventedTranscript(INVENTED), true);
  assert.equal(isInventedTranscript("I can't make it to the meeting today."), false);
});

test('transcribe() reports no speech for the invented meeting sentence', async (t) => {
  const handler = new VoiceHandler('test-key');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: INVENTED }] } }],
  }), { status: 200 }));
  const result = await handler.transcribe('a'.repeat(5000));
  assert.deepEqual(result, { text: '', error: 'no_speech' });
});

test('cleanReply removes the internal "[executed: …]" note', () => {
  assert.equal(cleanReply('[executed: system_type_text]'), '');
  assert.equal(cleanReply('Typed it. [executed: system_type_text, open_application]'), 'Typed it.');
  assert.equal(cleanReply(null), null);
});

function makeEngine(llmReply) {
  const engine = new AIEngine({
    toolRegistry: {
      getToolsForContext: () => [],
      executeTool: async () => ({ status: 'success' }),
    },
    wsHub: null,
  });
  engine._buildSystemPrompt = () => 'system';
  engine._callLLM = async () => llmReply;
  return engine;
}

test('a reply that is only the internal note is never returned to be spoken', async () => {
  const engine = makeEngine({ text: '[executed: system_type_text]', toolCalls: [] });
  const result = await engine.processChat('type my name');
  assert.doesNotMatch(result.text, /executed/i);
  assert.ok(result.text.trim(), 'the student still hears something');
});

test('a finished action never returns the internal note either', async () => {
  const engine = makeEngine({
    text: 'Done. [executed: system_type_text]',
    toolCalls: [{ name: 'system_type_text', arguments: { text: 'Derek' } }],
  });
  const result = await engine.processChat('type Derek');
  assert.equal(result.text, 'Done.');
});
