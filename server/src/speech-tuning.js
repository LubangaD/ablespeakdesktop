/**
 * AbleSpeak Speech Tuning — pure functions for per-student speech thresholds,
 * fuzzy repair candidates, and transcript evaluation.
 *
 * Students with dysarthria, apraxia, or low volume produce quiet audio and
 * near-miss transcripts. These functions replace the pipeline's hard-coded
 * rejection thresholds with per-student profile values and a repair path.
 *
 * REUSES safety.js classifyTranscript (never duplicated).
 */

import { classifyTranscript } from './safety.js';
import { matchFastCommand } from './fast-commands.js';

const PROFILE_DEFAULTS = {
  custom_vocabulary: '[]', min_audio_b64: 4000, min_confidence: 0.45,
  fuzzy_threshold: 0.34, silence_threshold: 15, silence_duration_ms: 2000, repair_enabled: 1,
};

/** Lowercase, trim, collapse internal whitespace. */
function normalize(s) {
  return String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Levenshtein(a,b) / max(len); 0 for two empty strings.
 *  Case-insensitive, whitespace-collapsed before comparing.
 */
export function normalizedEditDistance(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0;
  return levenshtein(na, nb) / maxLen;
}

/** Parse a profile's custom_vocabulary (JSON string or array) → array of strings. */
export function parseVocabulary(customVocabulary) {
  let list = customVocabulary;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.filter(v => typeof v === 'string' && v.trim() !== '').map(v => v.trim());
}

/** Best fuzzy match among knownCommands within fuzzyThreshold, or null.
 *  Ties → lowest distance, then shortest candidate. Also compares
 *  space-stripped forms so "scrolldown" finds "scroll down".
 */
export function findRepairCandidate(transcript, knownCommands, fuzzyThreshold) {
  const t = normalize(transcript);
  const tStripped = t.replace(/\s+/g, '');
  let best = null;
  for (const cmd of knownCommands || []) {
    const c = normalize(cmd);
    if (c === '') continue;
    const d1 = normalizedEditDistance(t, c);
    const cStripped = c.replace(/\s+/g, '');
    const maxStripped = Math.max(tStripped.length, cStripped.length);
    const d2 = maxStripped === 0 ? 0 : levenshtein(tStripped, cStripped) / maxStripped;
    const distance = Math.min(d1, d2);
    if (distance > fuzzyThreshold) continue;
    if (!best || distance < best.distance ||
        (distance === best.distance && cmd.length < best.candidate.length)) {
      best = { candidate: cmd, distance };
    }
  }
  return best;
}

/** Decide what to do with a transcript given per-student thresholds.
 *  → { action: 'accept' | 'repair' | 'reject', candidate?, reason }
 */
export function evaluateTranscript({ transcript, confidence, profile, knownCommands }) {
  const p = { ...PROFILE_DEFAULTS, ...(profile || {}) };

  // 1. Genuine silence is still silence — reuse safety.js classification.
  const cls = classifyTranscript(transcript);
  if (cls.status === 'no_speech') return { action: 'reject', reason: 'no_speech' };
  const text = cls.text;

  const phrases = [...(knownCommands || []), ...parseVocabulary(p.custom_vocabulary)];
  const normText = normalize(text);
  const isExact = matchFastCommand(text) != null || phrases.some(ph => normalize(ph) === normText);
  const repairEnabled = !!p.repair_enabled;

  // 2/3. Confidence known (Web Speech path)
  if (confidence != null) {
    if (confidence >= p.min_confidence) return { action: 'accept', reason: 'confidence_ok' };
    // Low confidence: trust exact matches over the score.
    if (isExact) return { action: 'accept', reason: 'exact_match' };
    if (repairEnabled) {
      const found = findRepairCandidate(text, phrases, p.fuzzy_threshold);
      if (found) return { action: 'repair', candidate: found.candidate, reason: 'near_miss' };
    }
    return { action: 'reject', reason: 'low_confidence' };
  }

  // 4. Confidence unknown (Gemini fallback — no scores): accept unless a
  //    repair candidate is strictly closer than the (non-)exact transcript.
  if (isExact) return { action: 'accept', reason: 'exact_match' };
  if (repairEnabled) {
    const found = findRepairCandidate(text, phrases, p.fuzzy_threshold);
    if (found) return { action: 'repair', candidate: found.candidate, reason: 'near_miss' };
  }
  return { action: 'accept', reason: 'transcript_ok' };
}

/** Per-student audio-size floor. → { pass, floor } */
export function checkAudioFloor(audioBase64Length, profile) {
  const floor = profile?.min_audio_b64 ?? PROFILE_DEFAULTS.min_audio_b64;
  return { pass: (audioBase64Length || 0) >= floor, floor };
}

/**
 * Wake-word matcher — returns true when `transcript` matches any phrase in
 * `phrases` using tolerant (case / space / punctuation-insensitive) containment
 * OR normalizedEditDistance ≤ 0.35 (also tried on space-stripped forms).
 *
 * Examples that must match for ["hey able", "able speak"]:
 *   "hey able" (exact), "hey abel" (NED≈0.11), "heyable" (stripped containment),
 *   "Hey Able" (case), "hey, able!" (punctuation stripped).
 *
 * Duplicate logic is intentionally inlined in overlay.html (no module system
 * available there) — see the isWakeWord comment block in that file.
 *
 * @param {string} transcript
 * @param {string[]} phrases
 * @returns {boolean}
 */
export function isWakeWord(transcript, phrases) {
  // Normalize: lowercase, strip punctuation, collapse whitespace
  function normWake(s) {
    return String(s ?? '').toLowerCase().replace(/[^\w\s]/g, '').trim().replace(/\s+/g, ' ');
  }
  const t = normWake(transcript);
  const tNoSp = t.replace(/\s/g, '');
  for (const phrase of (phrases || [])) {
    const p = normWake(phrase);
    if (!p) continue;
    const pNoSp = p.replace(/\s/g, '');
    // Containment: normal and space-stripped forms
    if (t.includes(p)) return true;
    if (pNoSp && tNoSp.includes(pNoSp)) return true;
    // Fuzzy (normal form)
    const maxLen = Math.max(t.length, p.length);
    if (maxLen > 0 && levenshtein(t, p) / maxLen <= 0.35) return true;
    // Fuzzy (space-stripped form)
    if (pNoSp && tNoSp) {
      const maxLenSp = Math.max(tNoSp.length, pNoSp.length);
      if (maxLenSp > 0 && levenshtein(tNoSp, pNoSp) / maxLenSp <= 0.35) return true;
    }
  }
  return false;
}
