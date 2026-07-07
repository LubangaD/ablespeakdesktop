/**
 * Atypical-speech fixture harness.
 *
 * Runs every fixture sample through checkAudioFloor + evaluateTranscript with
 * the DEFAULT profile and a TUNED per-student profile, proving the tuned
 * profile eliminates false rejections of dysarthric/quiet-speaker input
 * while both profiles still reject legitimate silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAudioFloor, evaluateTranscript } from './speech-tuning.js';
import { listCanonicalPhrases } from './fast-commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samples = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'atypical-speech.json'), 'utf8'));

const DEFAULT_PROFILE = {
  custom_vocabulary: '[]', min_audio_b64: 4000, min_confidence: 0.45,
  fuzzy_threshold: 0.34, silence_threshold: 15, silence_duration_ms: 2000, repair_enabled: 1,
};

const TUNED_PROFILE = {
  min_audio_b64: 1800, min_confidence: 0.30, fuzzy_threshold: 0.45,
  repair_enabled: 1, custom_vocabulary: ['open seesaw', 'open chrome'],
};

const knownCommands = listCanonicalPhrases();

/** Full per-sample pipeline: audio floor first, then transcript evaluation. */
function runSample(sample, profile) {
  const floor = checkAudioFloor(sample.audioB64Len, profile);
  if (!floor.pass) return { action: 'reject', reason: 'audio_floor' };
  return evaluateTranscript({
    transcript: sample.transcript,
    confidence: sample.confidence,
    profile,
    knownCommands,
  });
}

const validSamples = samples.filter(s => s.intent != null);
const silenceSamples = samples.filter(s => s.intent == null);
const atypicalValid = validSamples.filter(s => s.id.startsWith('quiet-') || s.id.startsWith('miss-'));

function falseRejections(profile) {
  return atypicalValid.filter(s => runSample(s, profile).action === 'reject').length;
}

const defaultFR = falseRejections(DEFAULT_PROFILE);
const tunedFR = falseRejections(TUNED_PROFILE);

// ── Fixture shape sanity ──

test('fixture set: >=14 samples with required categories', () => {
  assert.ok(samples.length >= 14, `expected >=14 samples, got ${samples.length}`);
  assert.equal(samples.filter(s => s.id.startsWith('quiet-')).length, 4, '4 quiet-audio cases');
  assert.equal(samples.filter(s => s.id.startsWith('miss-')).length, 5, '5 low-confidence near-misses');
  assert.equal(silenceSamples.length, 2, '2 legitimate silences');
  assert.equal(samples.filter(s => s.id.startsWith('clear-')).length, 3, '3 clear commands');
  for (const s of samples) {
    assert.ok(typeof s.id === 'string' && s.id, 'sample has id');
    assert.ok('transcript' in s && 'confidence' in s && 'audioB64Len' in s && 'intent' in s, `${s.id}: full schema`);
  }
});

test('fixture ranges match the brief', () => {
  for (const s of samples.filter(x => x.id.startsWith('quiet-'))) {
    assert.ok(s.audioB64Len >= 2000 && s.audioB64Len <= 3900, `${s.id}: quiet audioB64Len 2000-3900`);
  }
  for (const s of samples.filter(x => x.id.startsWith('miss-'))) {
    assert.ok(s.confidence >= 0.30 && s.confidence <= 0.44, `${s.id}: near-miss confidence 0.30-0.44`);
  }
  for (const s of samples.filter(x => x.id.startsWith('clear-'))) {
    assert.ok(s.confidence >= 0.6, `${s.id}: clear confidence >=0.6`);
  }
});

// ── (a) Default profile falsely rejects atypical-but-valid speech ──

test(`(a) default profile falsely rejects >=5 of the ${atypicalValid.length} atypical-but-valid samples (actual: ${defaultFR})`, () => {
  assert.equal(atypicalValid.length, 9, '9 atypical-but-valid samples');
  assert.ok(defaultFR >= 5, `default profile should falsely reject >=5, rejected ${defaultFR}`);
});

// ── (b) Tuned profile accepts or repairs ALL atypical-but-valid samples ──

test('(b) tuned profile accepts or repairs all 9 atypical-but-valid samples', () => {
  for (const s of atypicalValid) {
    const r = runSample(s, TUNED_PROFILE);
    assert.ok(r.action === 'accept' || r.action === 'repair',
      `${s.id} ("${s.transcript}"): expected accept/repair, got ${r.action} (${r.reason})`);
    if (r.action === 'repair') {
      assert.equal(r.candidate, s.intent, `${s.id}: repair candidate should match intent`);
    }
  }
  assert.equal(tunedFR, 0, 'tuned profile false rejections must be 0');
});

// ── (c) Both profiles still reject legitimate silence ──

test('(c) both profiles reject the 2 legitimate silences', () => {
  for (const s of silenceSamples) {
    for (const [name, profile] of [['default', DEFAULT_PROFILE], ['tuned', TUNED_PROFILE]]) {
      const r = runSample(s, profile);
      assert.equal(r.action, 'reject', `${s.id} under ${name} profile: expected reject, got ${r.action}`);
    }
  }
});

// ── (d) Improvement visible in test output ──

test(`(d) false rejections: tuned (${tunedFR}) < default (${defaultFR}) — tuning recovers ${defaultFR - tunedFR} of 9 atypical samples`, () => {
  assert.ok(tunedFR < defaultFR,
    `falseRejections(tuned)=${tunedFR} must be < falseRejections(default)=${defaultFR}`);
});
