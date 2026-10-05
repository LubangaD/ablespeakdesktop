/**
 * "Say AbleSpeak first" in the voice pipeline (ws-proxy.js + wake-name.js):
 * with the option on, only phrases that start with the name reach a command.
 * Run with:  node --test src/wake-name-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsProxy } from './ws-proxy.js';
import { normaliseProfile } from './student-profile.js';

function makeProxy({ needsName = true } = {}) {
  const profile = normaliseProfile({ listening: { needsName } }).profile;
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null, profile: () => profile });
  proxy._heartbeatInterval?.unref?.();
  const broadcasts = [];
  proxy._broadcastDashboard = (msg) => broadcasts.push(msg);
  const vocabularies = [];
  let nextText = '';
  proxy.voiceHandler.transcribe = async (_audio, _mime, { vocabulary } = {}) => {
    vocabularies.push(vocabulary);
    return { text: nextText };
  };
  const handled = [];
  proxy._handleUtterance = async (_ws, text) => { handled.push(text); };
  const typed = [];
  proxy._dictateAndReport = async (text) => { typed.push(text); return null; };
  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  const say = async (text) => { nextText = text; await proxy._processVoiceAudio(ws, { audio: 'a'.repeat(5000), mimeType: 'audio/webm' }); };
  return { proxy, broadcasts, handled, typed, sent, say, vocabularies };
}

test('talk without the name is dropped quietly, before anything is shown', async () => {
  const { handled, sent, broadcasts, say } = makeProxy();
  await say('Victor, si yule alibongea');
  assert.deepEqual(handled, []);
  assert.equal(sent.at(-1).type, 'voice_no_speech');
  assert.equal(broadcasts.filter(b => b.type === 'voice_transcription').length, 0, 'nothing appears on the voice bar');
});

test('"AbleSpeak, open Word" runs "open Word"', async () => {
  const { handled, say } = makeProxy();
  await say('AbleSpeak, open Word.');
  assert.deepEqual(handled, ['open Word.']);
});

test('just "AbleSpeak" answers "Yes?" and the next phrase needs no name', async () => {
  const { handled, broadcasts, say } = makeProxy();
  await say('AbleSpeak.');
  assert.equal(broadcasts.find(b => b.type === 'chat_assistant_message')?.text, 'Yes?');
  await say('open Word');
  assert.deepEqual(handled, ['open Word']);
  await say('open Excel');
  assert.deepEqual(handled, ['open Word'], 'only the one next phrase');
});

test('the answer to a yes/no question needs no name', async () => {
  const { proxy, handled, say } = makeProxy();
  proxy._pendingConfirmation = { tool: 'close_application', args: {}, prompt: 'Close Word?' };
  await say('yes');
  assert.deepEqual(handled, ['yes']);
});

test('the name is added to speech recognition, only when it is needed', async () => {
  const on = makeProxy({ needsName: true });
  await on.say('AbleSpeak, scroll down');
  assert.ok(on.vocabularies[0].includes('AbleSpeak'));
  const off = makeProxy({ needsName: false });
  await off.say('open Word');
  assert.ok(!off.vocabularies[0].includes('AbleSpeak'));
  assert.deepEqual(off.handled, ['open Word'], 'with the option off, everything is heard as before');
});
