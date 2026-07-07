import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRetryDelay } from './reconnect.js';

test('nextRetryDelay: attempt 0 → baseMs (500)', () => {
  assert.equal(nextRetryDelay(0), 500);
});

test('nextRetryDelay: attempt 1 → 1000', () => {
  assert.equal(nextRetryDelay(1), 1000);
});

test('nextRetryDelay: attempt 2 → 2000', () => {
  assert.equal(nextRetryDelay(2), 2000);
});

test('nextRetryDelay: attempt 10 → capped at 15000', () => {
  assert.equal(nextRetryDelay(10), 15000);
});

test('nextRetryDelay: custom baseMs=1000 cap=8000 attempt 0 → 1000', () => {
  assert.equal(nextRetryDelay(0, { baseMs: 1000, capMs: 8000 }), 1000);
});

test('nextRetryDelay: custom baseMs=1000 cap=8000 attempt 3 → capped at 8000', () => {
  assert.equal(nextRetryDelay(3, { baseMs: 1000, capMs: 8000 }), 8000);
});

test('nextRetryDelay: never exceeds capMs for any attempt 0..30', () => {
  for (let i = 0; i <= 30; i++) {
    assert.ok(nextRetryDelay(i) <= 15000, `attempt ${i} exceeded cap`);
  }
});

test('nextRetryDelay: doubles each step until cap', () => {
  assert.equal(nextRetryDelay(0), 500);
  assert.equal(nextRetryDelay(1), 1000);
  assert.equal(nextRetryDelay(2), 2000);
  assert.equal(nextRetryDelay(3), 4000);
  assert.equal(nextRetryDelay(4), 8000);
  assert.equal(nextRetryDelay(5), 15000); // capped: would be 16000
});
