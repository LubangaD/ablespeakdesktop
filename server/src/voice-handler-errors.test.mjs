/**
 * How Gemini transcription failures are reported (voice-handler.js): a slow
 * reply is not "no internet", and a cancelled request returns at once.
 * Run with:  node --test src/voice-handler-errors.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceHandler } from './voice-handler.js';

const clip = 'a'.repeat(5000);

test('a timeout soon after a good reply is "slow", not "offline"', async (t) => {
  const handler = new VoiceHandler('test-key');
  handler._getRateLimitDelay = () => 0;
  handler._lastOkAt = Date.now();
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  const result = await handler.transcribe(clip, 'audio/webm');
  assert.equal(result.error, 'slow');
  assert.match(result.message, /slow/);
});

test('a timeout with no recent reply is still "offline"', async (t) => {
  const handler = new VoiceHandler('test-key');
  handler._getRateLimitDelay = () => 0;
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  const result = await handler.transcribe(clip, 'audio/webm');
  assert.equal(result.error, 'offline');
});

test('a cancelled request returns at once and is not retried', async (t) => {
  const handler = new VoiceHandler('test-key');
  handler._getRateLimitDelay = () => 0;
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    calls++;
    controller.abort();
    throw signal.reason ?? new DOMException('aborted', 'AbortError');
  });
  const started = Date.now();
  const result = await handler.transcribe(clip, 'audio/webm', { signal: controller.signal });
  assert.equal(result.error, 'cancelled');
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1000, 'no 2 s retry wait');
});
