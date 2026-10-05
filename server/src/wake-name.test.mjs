/**
 * "Say AbleSpeak first" (wake-name.js).
 * Run with:  node --test src/wake-name.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripName, gateByName } from './wake-name.js';

test('the name is found however speech recognition spells it, and removed', () => {
  for (const said of ['AbleSpeak, open Word.', 'Able speak open Word.', 'able-speak: open Word.', 'Abel Speak, open Word.', 'Hey AbleSpeak, open Word.', 'OK, Able Speak open Word.']) {
    assert.deepEqual(stripName(said), { named: true, rest: 'open Word.' }, said);
  }
});

test('phrases without the name are not for AbleSpeak', () => {
  assert.deepEqual(gateByName('open Word'), { action: 'ignore' });
  assert.deepEqual(gateByName('Victor, si yule alibongea'), { action: 'ignore' });
  assert.deepEqual(gateByName('I was able to speak to her'), { action: 'ignore' }, 'the words in the middle of a sentence do not count');
});

test('the name with a command runs the command', () => {
  assert.deepEqual(gateByName('AbleSpeak, scroll down'), { action: 'run', text: 'scroll down' });
});

test('just the name means "I am listening", and the next phrase needs no name', () => {
  assert.deepEqual(gateByName('AbleSpeak.'), { action: 'listen' });
  assert.deepEqual(gateByName('Hey AbleSpeak'), { action: 'listen' });
  assert.deepEqual(gateByName('open Word', { inWindow: true }), { action: 'run', text: 'open Word' });
});
