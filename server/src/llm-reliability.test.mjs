/**
 * A busy AI model is swapped for its backup; a refused key or a spoken "stop" is not.
 * Run with:  node --test src/llm-reliability.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, CircuitBreaker, pickFallbackModel, FALLBACK_PREFER } from './llm-reliability.js';

test('busy answers from each provider are told apart from other failures', () => {
  assert.equal(classifyFailure(new Error('Gemini API error 503: {"error":{"status":"UNAVAILABLE","message":"The model is overloaded."}}')), 'busy');
  assert.equal(classifyFailure(new Error('Gemini API error 429: RESOURCE_EXHAUSTED')), 'busy');
  assert.equal(classifyFailure(new Error('OpenAI API error 500: server error')), 'busy');
  assert.equal(classifyFailure(new Error('Anthropic API error 529: overloaded_error')), 'busy');
  assert.equal(classifyFailure(new Error('Gemini API error 400: INVALID_ARGUMENT')), 'other');
  assert.equal(classifyFailure(new Error('OpenAI API error 401: Incorrect API key provided')), 'auth');
  assert.equal(classifyFailure(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), 'timeout');
  assert.equal(classifyFailure(new TypeError('fetch failed')), 'network');
});

test('a spoken "stop" is never retried, whatever the error says', () => {
  assert.equal(classifyFailure(new Error('Gemini API error 503'), { stopped: true }), 'stopped');
});

test('a model busy three times in a row is skipped for a minute, then tried again', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ threshold: 3, coolMs: 60_000, now: () => now });
  assert.equal(breaker.failure('gemini-2.5-flash'), false);
  assert.equal(breaker.failure('gemini-2.5-flash'), false);
  assert.equal(breaker.failure('gemini-2.5-flash'), true);
  assert.equal(breaker.isOpen('gemini-2.5-flash'), true);
  assert.equal(breaker.isOpen('gemini-2.5-flash-lite'), false);
  now = 60_001;
  assert.equal(breaker.isOpen('gemini-2.5-flash'), false);
});

test('one answer that works clears the busy count', () => {
  const breaker = new CircuitBreaker({ threshold: 3 });
  breaker.failure('m');
  breaker.failure('m');
  breaker.success('m');
  assert.equal(breaker.failure('m'), false);
});

test('the backup is a lighter model of the same provider, never the one that failed', () => {
  const live = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-3.8-flash'];
  assert.equal(pickFallbackModel(live, 'gemini-2.5-flash', FALLBACK_PREFER.gemini), 'gemini-2.5-flash-lite');
  assert.equal(pickFallbackModel(live, 'gemini-2.5-flash-lite', FALLBACK_PREFER.gemini), 'gemini-2.5-flash');
  assert.equal(pickFallbackModel(['gemini-2.5-flash'], 'gemini-2.5-flash', FALLBACK_PREFER.gemini), null);
});

test('LLM_FALLBACK_MODEL wins, unless it is the model that failed', () => {
  assert.equal(pickFallbackModel([], 'gpt-4o-mini', FALLBACK_PREFER.openai, 'gpt-4.1'), 'gpt-4.1');
  assert.equal(pickFallbackModel(['gpt-4o'], 'gpt-4.1', FALLBACK_PREFER.openai, 'gpt-4.1'), 'gpt-4o');
});
