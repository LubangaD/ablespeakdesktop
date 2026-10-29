/**
 * A busy or slow AI model is swapped for its backup for that one call; a
 * spoken "stop" is never retried; the task agent's calls get temperature 0.
 * Run with:  node --test src/ai-engine-reliability.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIEngine } from './ai-engine.js';
import { newSpend } from './speed-meter.js';

const BUSY = 'Gemini API error 503: {"error":{"status":"UNAVAILABLE","message":"The model is overloaded."}}';

/** An engine on Gemini 2.5 Flash whose calls fail with `failFor(model)` (an error message) or answer. */
function makeEngine(failFor = () => null) {
  const engine = new AIEngine({ toolRegistry: { getToolsForContext: () => [] }, wsHub: null });
  engine.provider = 'gemini';
  engine.model = 'gemini-2.5-flash';
  engine.listModels = async () => ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'];
  const calls = [];
  engine._dispatch = function (system, tools, opts) {
    calls.push({ model: this.model, opts });
    const message = failFor(this.model);
    if (!message) return Promise.resolve({ text: `answered by ${this.model}` });
    return Promise.reject(message instanceof Error ? message : new Error(message));
  };
  return { engine, calls };
}

test('a busy model: the same call goes to the backup model at once, and the main model stays chosen', async () => {
  const { engine, calls } = makeEngine(model => (model === 'gemini-2.5-flash' ? BUSY : null));
  const result = await engine._callLLM('system', []);
  assert.equal(result.text, 'answered by gemini-2.5-flash-lite');
  assert.deepEqual(calls.map(c => c.model), ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.equal(engine.model, 'gemini-2.5-flash');
});

test('a model that timed out is asked again on the backup model', async () => {
  const timeout = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const { engine, calls } = makeEngine(model => (model === 'gemini-2.5-flash' ? timeout : null));
  assert.equal((await engine._callLLM('system', [])).text, 'answered by gemini-2.5-flash-lite');
  assert.equal(calls.length, 2);
});

test('after three busy answers in a row the main model is skipped for a while', async () => {
  const { engine, calls } = makeEngine(model => (model === 'gemini-2.5-flash' ? BUSY : null));
  for (let i = 0; i < 3; i++) await engine._callLLM('system', []);
  calls.length = 0;
  await engine._callLLM('system', []);
  assert.deepEqual(calls.map(c => c.model), ['gemini-2.5-flash-lite'], 'straight to the backup');
});

test('a spoken "stop" is not retried on any model', async () => {
  const stop = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const { engine, calls } = makeEngine(() => stop);
  engine._activeAbortController = new AbortController();
  engine._activeAbortController.abort();
  await assert.rejects(engine._callLLM('system', []), /aborted/);
  assert.equal(calls.length, 1);
});

test('a bad request or a refused key fails at once, without the backup', async () => {
  for (const message of ['Gemini API error 400: INVALID_ARGUMENT', 'Gemini API error 403: PERMISSION_DENIED']) {
    const { engine, calls } = makeEngine(() => message);
    await assert.rejects(engine._callLLM('system', []));
    assert.equal(calls.length, 1, message);
  }
});

test('the task agent\'s calls (complete) get the same backup, its temperature, and are counted', async () => {
  const { engine, calls } = makeEngine(model => (model === 'gemini-2.5-flash' ? BUSY : null));
  const spend = newSpend('gemini-2.5-flash');
  const result = await engine.complete({ system: 'plan', messages: [{ role: 'user', content: 'x' }], temperature: 0, spend });
  assert.equal(result.text, 'answered by gemini-2.5-flash-lite');
  assert.deepEqual(calls.map(c => c.opts.temperature), [0, 0]);
  assert.equal(spend.model, 'gemini-2.5-flash-lite');
});
