/**
 * Learned commands (learned-commands.js): an AI command done the same way, with
 * success, 3 times in the same place is learned; anything else is not.
 * Run with:  node --test src/learned-commands.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnFrom, findLearned, phraseKey, placeOf, stepsOf } from './learned-commands.js';

const next = [{ tool: 'system_media_control', args: { action: 'next', app_name: 'Spotify' }, result: { status: 'success' } }];
const row = (text, toolCalls, { outcome = 'success', front = { app: 'Spotify' }, site } = {}) => ({
  payload: JSON.stringify({ text, ...(front ? { front } : {}), ...(site ? { site } : {}) }),
  result: JSON.stringify({ toolCalls }),
  outcome,
});

test('three identical successes in the same app are learned', () => {
  const learned = learnFrom([row('Next song.', next), row('next song', next), row('AbleSpeak, next song', next)]);
  const hit = findLearned(learned, 'Next song!', { front: { app: 'Spotify' } });
  assert.deepEqual(hit.steps, [{ tool: 'system_media_control', args: { action: 'next', app_name: 'Spotify' } }]);
  assert.equal(hit.successes, 3);
  assert.equal(findLearned(learned, 'next song', { front: { app: 'Chrome' } }), null, 'only where it was learned');
});

test('two successes are not enough, and a recent failure or undo stops it', () => {
  assert.equal(learnFrom([row('next song', next), row('next song', next)]).size, 0);
  const failed = [{ ...next[0], result: { status: 'error' } }];
  assert.equal(learnFrom([row('next song', next), row('next song', failed), row('next song', next), row('next song', next), row('next song', next)]).size, 0);
  assert.equal(learnFrom([row('next song', next, { outcome: 'error' }), row('next song', next), row('next song', next), row('next song', next)]).size, 0, 'undone');
});

test('done differently lately: the newest way has to be repeated 3 times', () => {
  const pause = [{ tool: 'system_media_control', args: { action: 'pause', app_name: 'Spotify' }, result: { status: 'success' } }];
  assert.equal(learnFrom([row('stop it', pause), row('stop it', next), row('stop it', next), row('stop it', next)]).size, 0);
});

test('never learned: closing, reading, typing, or a step aimed at a place on the screen', () => {
  const learn = calls => learnFrom([row('do it', calls), row('do it', calls), row('do it', calls)]).size;
  assert.equal(learn([{ tool: 'close_application', args: { app_name: 'Word' }, result: { status: 'success' } }]), 0);
  assert.equal(learn([{ tool: 'window_control', args: { action: 'close' }, result: { status: 'success' } }]), 0);
  assert.equal(learn([{ tool: 'get_page_content', args: {}, result: { status: 'success' } }]), 0);
  assert.equal(learn([{ tool: 'system_type_text', args: { text: 'hello' }, result: { status: 'success' } }]), 0);
  assert.equal(learn([{ tool: 'uia_act', args: { ref: '42.1.2' }, result: { status: 'success' } }]), 0);
  assert.equal(learn([{ tool: 'system_media_control', result: { status: 'success' } }]), 0, 'saved before arguments were kept');
});

test('learned from the saved commands themselves', async () => {
  const { mkdtempSync, rmSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const { initDatabase, closeDatabase, insertCommand, getRecentAiCommands } = await import('./db.js');
  const dir = mkdtempSync(join(tmpdir(), 'ablespeak-learn-'));
  try {
    await initDatabase(join(dir, 'ablespeak.db'));
    for (let i = 0; i < 3; i++) {
      insertCommand({
        id: `c${i}`, type: 'voice', direction: 'user_to_ai', session_id: 's1', student_id: 7, outcome: 'success',
        payload: { text: 'next song', front: { app: 'Spotify' } }, result: { toolCalls: next },
      });
    }
    insertCommand({ id: 'other', type: 'voice', direction: 'user_to_ai', session_id: 's2', student_id: 8, outcome: 'success', payload: { text: 'next song', front: { app: 'Spotify' } }, result: { toolCalls: next } });
    assert.equal(getRecentAiCommands(7).length, 3, "only this student's");
    assert.ok(findLearned(learnFrom(getRecentAiCommands(7)), 'next song', { front: { app: 'Spotify' } }));
    assert.equal(learnFrom(getRecentAiCommands(8)).size, 0, 'another student has said it once');
  } finally {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('words and places are compared plainly', () => {
  assert.equal(phraseKey('Able speak, Open  YouTube!'), 'open youtube');
  assert.equal(placeOf({ front: { app: 'Spotify' }, site: 'youtube.com' }), 'spotify', 'the app in front first');
  assert.equal(placeOf({ site: 'YouTube.com' }), 'youtube.com');
  assert.deepEqual(stepsOf([{ tool: 'scroll', args: { direction: 'down' }, result: {} }]), [{ tool: 'scroll', args: { direction: 'down' } }]);
});
