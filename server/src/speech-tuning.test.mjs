import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedEditDistance, findRepairCandidate, evaluateTranscript, checkAudioFloor } from './speech-tuning.js';

const DEFAULTS = {
  custom_vocabulary: '[]', min_audio_b64: 4000, min_confidence: 0.45,
  fuzzy_threshold: 0.34, silence_threshold: 15, silence_duration_ms: 2000, repair_enabled: 1,
};

const COMMANDS = ['scroll down', 'scroll up', 'go back', 'close tab', 'volume up', 'open chrome'];

// ── normalizedEditDistance ──

test('normalizedEditDistance: identical strings → 0', () => {
  assert.equal(normalizedEditDistance('scroll down', 'scroll down'), 0);
});

test('normalizedEditDistance: two empty strings → 0', () => {
  assert.equal(normalizedEditDistance('', ''), 0);
});

test('normalizedEditDistance: empty vs non-empty → 1', () => {
  assert.equal(normalizedEditDistance('abc', ''), 1);
  assert.equal(normalizedEditDistance('', 'abc'), 1);
});

test('normalizedEditDistance: kitten/sitting → 3/7', () => {
  assert.ok(Math.abs(normalizedEditDistance('kitten', 'sitting') - 3 / 7) < 1e-9);
});

test('normalizedEditDistance: case-insensitive', () => {
  assert.equal(normalizedEditDistance('Scroll Down', 'scroll down'), 0);
});

test('normalizedEditDistance: whitespace-collapsed', () => {
  assert.equal(normalizedEditDistance('scroll    down', ' scroll down '), 0);
});

test('normalizedEditDistance: scoll down vs scroll down → 1/11', () => {
  assert.ok(Math.abs(normalizedEditDistance('scoll down', 'scroll down') - 1 / 11) < 1e-9);
});

// ── findRepairCandidate ──

test('findRepairCandidate: scolldown → scroll down (space-stripped match)', () => {
  const r = findRepairCandidate('scrolldown', COMMANDS, 0.34);
  assert.ok(r);
  assert.equal(r.candidate, 'scroll down');
  assert.equal(r.distance, 0);
});

test('findRepairCandidate: scoll down → scroll down repair', () => {
  const r = findRepairCandidate('scoll down', COMMANDS, 0.34);
  assert.ok(r);
  assert.equal(r.candidate, 'scroll down');
  assert.ok(r.distance <= 0.34);
});

test('findRepairCandidate: gibberish → null', () => {
  assert.equal(findRepairCandidate('xylophone quartz', COMMANDS, 0.34), null);
});

test('findRepairCandidate: tie broken by lowest distance then shortest candidate', () => {
  // 'ab' vs 'a' → 1/2 = 0.5; 'ab' vs 'abcd' → 2/4 = 0.5 — tie → shortest wins
  const r = findRepairCandidate('ab', ['abcd', 'a'], 0.6);
  assert.ok(r);
  assert.equal(r.candidate, 'a');
  assert.equal(r.distance, 0.5);
});

test('findRepairCandidate: empty command list → null', () => {
  assert.equal(findRepairCandidate('scroll down', [], 0.34), null);
});

// ── evaluateTranscript: no_speech via safety.js classifyTranscript ──

test('evaluateTranscript: SILENCE → reject no_speech', () => {
  const r = evaluateTranscript({ transcript: 'SILENCE', confidence: null, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'reject');
  assert.equal(r.reason, 'no_speech');
});

test('evaluateTranscript: empty transcript → reject no_speech', () => {
  const r = evaluateTranscript({ transcript: '', confidence: 0.9, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'reject');
  assert.equal(r.reason, 'no_speech');
});

// ── evaluateTranscript: confidence paths ──

test('evaluateTranscript: high confidence → accept', () => {
  const r = evaluateTranscript({ transcript: 'scroll down', confidence: 0.85, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

test('evaluateTranscript: confidence exactly at threshold → accept', () => {
  const r = evaluateTranscript({ transcript: 'scroll down', confidence: 0.45, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

test('evaluateTranscript: low-confidence exact fast-command match → accept (trust exact)', () => {
  const r = evaluateTranscript({ transcript: 'scroll down', confidence: 0.2, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

test('evaluateTranscript: low-confidence near-miss → repair with candidate', () => {
  const r = evaluateTranscript({ transcript: 'scoll down', confidence: 0.3, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'repair');
  assert.equal(r.candidate, 'scroll down');
});

test('evaluateTranscript: low-confidence gibberish → reject low_confidence', () => {
  const r = evaluateTranscript({ transcript: 'xylophone quartz banana', confidence: 0.2, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'reject');
  assert.equal(r.reason, 'low_confidence');
});

test('evaluateTranscript: repair_enabled=0 → no repair, low-confidence near-miss rejects', () => {
  const profile = { ...DEFAULTS, repair_enabled: 0 };
  const r = evaluateTranscript({ transcript: 'scoll down', confidence: 0.3, profile, knownCommands: COMMANDS });
  assert.equal(r.action, 'reject');
  assert.equal(r.reason, 'low_confidence');
});

test('evaluateTranscript: per-student min_confidence honoured', () => {
  const profile = { ...DEFAULTS, min_confidence: 0.1 };
  const r = evaluateTranscript({ transcript: 'scoll down', confidence: 0.3, profile, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

// ── evaluateTranscript: custom vocabulary ──

test('evaluateTranscript: vocabulary phrase repair — open see saw → open seesaw', () => {
  const profile = { ...DEFAULTS, custom_vocabulary: '["open seesaw"]' };
  const r = evaluateTranscript({ transcript: 'open see saw', confidence: 0.3, profile, knownCommands: COMMANDS });
  assert.equal(r.action, 'repair');
  assert.equal(r.candidate, 'open seesaw');
});

test('evaluateTranscript: vocabulary accepts array form too', () => {
  const profile = { ...DEFAULTS, custom_vocabulary: ['open seesaw'] };
  const r = evaluateTranscript({ transcript: 'open see saw', confidence: 0.3, profile, knownCommands: COMMANDS });
  assert.equal(r.action, 'repair');
  assert.equal(r.candidate, 'open seesaw');
});

test('evaluateTranscript: exact vocabulary phrase at low confidence → accept', () => {
  const profile = { ...DEFAULTS, custom_vocabulary: '["open seesaw"]' };
  const r = evaluateTranscript({ transcript: 'open seesaw', confidence: 0.2, profile, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

test('evaluateTranscript: malformed vocabulary JSON is ignored, not fatal', () => {
  const profile = { ...DEFAULTS, custom_vocabulary: '{not json' };
  const r = evaluateTranscript({ transcript: 'scroll down', confidence: 0.9, profile, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

// ── evaluateTranscript: null confidence (Gemini fallback — no scores) ──

test('evaluateTranscript: null confidence + exact command → accept', () => {
  const r = evaluateTranscript({ transcript: 'scroll down', confidence: null, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

test('evaluateTranscript: null confidence + near-miss → repair', () => {
  const r = evaluateTranscript({ transcript: 'scoll down', confidence: null, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'repair');
  assert.equal(r.candidate, 'scroll down');
});

test('evaluateTranscript: null confidence + free text → accept (no repair candidate)', () => {
  const r = evaluateTranscript({ transcript: 'open my email and read the first message', confidence: null, profile: DEFAULTS, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

test('evaluateTranscript: null confidence + near-miss + repair_enabled=0 → accept (never repair)', () => {
  const profile = { ...DEFAULTS, repair_enabled: 0 };
  const r = evaluateTranscript({ transcript: 'scoll down', confidence: null, profile, knownCommands: COMMANDS });
  assert.equal(r.action, 'accept');
});

// ── checkAudioFloor ──

test('checkAudioFloor: default profile rejects below 4000', () => {
  const r = checkAudioFloor(3900, DEFAULTS);
  assert.equal(r.pass, false);
  assert.equal(r.floor, 4000);
});

test('checkAudioFloor: default profile passes at/above 4000', () => {
  assert.equal(checkAudioFloor(4000, DEFAULTS).pass, true);
  assert.equal(checkAudioFloor(9000, DEFAULTS).pass, true);
});

test('checkAudioFloor: tuned profile lowers the floor per student', () => {
  const profile = { ...DEFAULTS, min_audio_b64: 1800 };
  const r = checkAudioFloor(2000, profile);
  assert.equal(r.pass, true);
  assert.equal(r.floor, 1800);
});

test('checkAudioFloor: tuned profile still rejects below its floor', () => {
  const profile = { ...DEFAULTS, min_audio_b64: 1800 };
  assert.equal(checkAudioFloor(1500, profile).pass, false);
});
