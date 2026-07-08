/**
 * Tests for the safety layer. Run with:  node --test src/safety.test.mjs
 * No external deps — uses node:test + node:assert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyConsequential,
  isAffirmative,
  detectHallucination,
} from './safety.js';

// ── classifyConsequential ────────────────────────────────────────────────

test('closing an app via close_application is consequential', () => {
  const r = classifyConsequential('close_application', { app_name: 'Word' });
  assert.ok(r, 'should be flagged');
  assert.equal(r.id, 'close-app');
});

test('Alt+F4 via send_system_keys is consequential', () => {
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Alt+F4' }).id, 'close-app');
  assert.equal(classifyConsequential('send_system_keys', { keys: 'alt + f4' }).id, 'close-app');
});

test('send / submit / publish tools are consequential', () => {
  assert.equal(classifyConsequential('send_email', {}).id, 'send');
  assert.equal(classifyConsequential('submit_form', {}).id, 'send');
  assert.equal(classifyConsequential('publish_post', {}).id, 'send');
});

test('permanent delete is consequential', () => {
  assert.equal(classifyConsequential('delete_file', {}).id, 'delete');
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Shift+Delete' }).id, 'delete');
});

test('reversible / benign actions are NOT gated', () => {
  // closing a tab is reopenable with Ctrl+Shift+T → no confirmation
  assert.equal(classifyConsequential('close_tab', {}), null);
  assert.equal(classifyConsequential('scroll', { direction: 'down' }), null);
  assert.equal(classifyConsequential('click_element', { index: 2 }), null);
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Ctrl+C' }), null);
  assert.equal(classifyConsequential('press_key_combination', { key: 'Enter' }), null);
  assert.equal(classifyConsequential(null), null);
});

// ── isAffirmative ─────────────────────────────────────────────────────────

test('affirmatives confirm, everything else cancels', () => {
  for (const yes of ['yes', 'Yeah', 'confirm', 'do it', 'go ahead', 'OK', 'sure']) {
    assert.equal(isAffirmative(yes), true, `${yes} should confirm`);
  }
  for (const no of ['no', 'cancel', 'wait', 'stop', 'actually never mind', '']) {
    assert.equal(isAffirmative(no), false, `${no} should cancel`);
  }
});

// ── detectHallucination ───────────────────────────────────────────────────

test('known phantom phrases are filtered', () => {
  assert.equal(detectHallucination('Thanks for watching!').hallucination, true);
  assert.equal(detectHallucination('please subscribe to my channel').hallucination, true);
  assert.equal(detectHallucination('Subtitles by the Amara.org community').hallucination, true);
});

test('near-duplicate phantoms are caught (the live-observed gap)', () => {
  // The audit noted one phantom got filtered and an almost-identical one did not.
  assert.equal(detectHallucination('thank you for watching').hallucination, true);
  assert.equal(detectHallucination('Thank you for watching.').hallucination, true);
  assert.equal(detectHallucination('thank  you   for watching!!!').hallucination, true);
});

test('repetitive ASR-on-noise output is filtered', () => {
  assert.equal(detectHallucination('you you you you you').hallucination, true);
  assert.equal(
    detectHallucination('I love you I love you I love you I love you').hallucination,
    true,
  );
});

test('overly long transcripts (song lyrics) are filtered', () => {
  const long = 'la '.repeat(150);
  assert.equal(detectHallucination(long).hallucination, true);
});

test('echo of our own TTS is filtered', () => {
  const tts = 'Opening Gmail in a new tab now';
  assert.equal(detectHallucination('opening gmail in a new tab', { lastTTS: tts }).hallucination, true);
});

test('real commands pass through', () => {
  for (const cmd of ['scroll down', 'open gmail', 'click the second link', 'go back', 'search for cats']) {
    assert.equal(detectHallucination(cmd).hallucination, false, `${cmd} should pass`);
  }
});

test('a real command is not mistaken for an echo of unrelated TTS', () => {
  assert.equal(
    detectHallucination('scroll down', { lastTTS: 'Opening Gmail in a new tab now' }).hallucination,
    false,
  );
});
