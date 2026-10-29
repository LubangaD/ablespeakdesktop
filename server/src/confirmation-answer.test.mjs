/**
 * A question waiting for a spoken yes or no ("Close this window? … Say yes to
 * confirm, or anything else to cancel"): whatever is said next answers it.
 * "Cancel", "stop", "no, stop" and "go to sleep" used to be taken as controls
 * (the interrupt, the media pause) and left the question waiting, so the next
 * phrase starting "okay…" closed the window (test script SF-05, SF-06).
 * Run with:  node --test src/confirmation-answer.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsProxy } from './ws-proxy.js';

const CLOSE_PROMPT = 'Close this window? Any unsaved work could be lost. Say "yes" to confirm, or anything else to cancel.';

function makeProxy() {
  const ran = [];
  const aiEngine = {
    toolRegistry: {
      executeTool: async (tool, args, _proxy, opts = {}) => {
        ran.push({ tool, args, confirmed: !!opts.confirmed });
        return { status: 'success', message: 'Closed.' };
      },
    },
  };
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine });
  proxy._heartbeatInterval?.unref?.();
  const broadcasts = [];
  proxy._broadcastDashboard = (msg) => broadcasts.push(msg);
  let nextText = '';
  proxy.voiceHandler.transcribe = async () => ({ text: nextText });
  const ws = { send: () => {} };
  const ask = () => { proxy._pendingConfirmation = { tool: 'close_application', args: {}, prompt: CLOSE_PROMPT }; };
  const say = async (text) => {
    nextText = text;
    await proxy._processVoiceAudio(ws, { audio: 'a'.repeat(5000), mimeType: 'audio/webm' });
  };
  const replies = () => broadcasts.filter(b => b.type === 'chat_assistant_message').map(b => b.text);
  return { proxy, ran, broadcasts, ws, ask, say, replies };
}

for (const said of ['Cancel.', 'Stop.', 'Never mind.', 'Abort.', 'Cancel that.']) {
  test(`"${said}" cancels the waiting question, and a later "okay" runs nothing`, async () => {
    const { proxy, ran, ask, say, replies } = makeProxy();
    ask();
    await say(said);
    assert.equal(proxy._pendingConfirmation, null, 'the question is no longer waiting');
    assert.deepEqual(replies(), ['Okay, cancelled.']);
    // The bug: the question stayed, and this closed the window
    assert.equal(await proxy._resolvePendingConfirmation('Okay, open Notepad.'), false);
    assert.deepEqual(ran, []);
  });
}

test('"No, stop" cancels the question instead of pausing the music', async () => {
  const { proxy, ran, ask, say, replies } = makeProxy();
  ask();
  await say('No, stop.');
  assert.equal(proxy._pendingConfirmation, null);
  assert.deepEqual(replies(), ['Okay, cancelled.']);
  assert.deepEqual(ran, [], 'no media pause, no close');
});

test('"Go to sleep", "hide" or "who am I" with a question waiting cancel it too', async () => {
  for (const said of ['Go to sleep.', 'Stop listening.', 'Hide.', 'Who am I?']) {
    const { proxy, ran, ask, say, replies } = makeProxy();
    ask();
    await say(said);
    assert.equal(proxy._pendingConfirmation, null, `"${said}" left the question waiting`);
    assert.deepEqual(replies(), ['Okay, cancelled.'], said);
    assert.equal(await proxy._resolvePendingConfirmation('Yes.'), false, said);
    assert.deepEqual(ran, [], said);
  }
});

test('"stop" typed on the Chat page, or from the browser\'s own speech, cancels it the same way', async () => {
  const { proxy, ran, ws, ask, replies } = makeProxy();
  ask();
  await proxy._handleUtterance(ws, 'stop', { typed: true });
  assert.equal(proxy._pendingConfirmation, null);
  assert.deepEqual(replies(), ['Okay, cancelled.']);
  ask();
  // The browser-speech path (voice_text) calls the voice controls first, then the answer
  assert.equal(proxy._handleVoiceControl('cancel'), false, 'left for the question to take as its answer');
  assert.deepEqual(ran, []);
});

test('"yes" still confirms, and "stop" with nothing waiting still interrupts', async () => {
  const { proxy, ran, broadcasts, ask, say } = makeProxy();
  ask();
  await say('Yes.');
  assert.deepEqual(ran, [{ tool: 'close_application', args: {}, confirmed: true }]);
  assert.equal(proxy._pendingConfirmation, null);
  assert.equal(proxy._handleVoiceControl('stop'), true);
  assert.equal(broadcasts.at(-1).type, 'voice_cancelled');
});
