/**
 * A student's speech profile (Stage 1, carried to other machines in Stage 4).
 *
 * - listening: how sensitive the microphone is and how long a pause ends a
 *   command. One setting for everyone discards quiet or slow speakers.
 * - vocabulary: names and words the recogniser should expect.
 * - aliases: the student's own phrases for commands ("my music" → "open spotify").
 * - macros: named routines ("start my homework" → several commands).
 *
 * Profiles are plain JSON so they can be exported from one computer and
 * imported on another.
 */
import { getStudentProfileRow, saveStudentProfileRow } from './db.js';
import { MAX_ROUTINE_STEPS } from './agent.js';

export const PROFILE_VERSION = 1;

export const SENSITIVITY = {
  // speech: level that counts as speech; silence: below this is quiet;
  // quiet: voice-level sound too soft to count (the "didn't catch that" cue)
  // Lowered 17 Oct 2026 from 45 / 28 / 60. Measured through the voice bar's own
  // mic path, a normal speaking voice peaked at 31–93 per phrase and the room
  // at 1–12: Standard at 45 missed 6 of 30 phrases and Noisy room at 60 missed
  // 13, so people shouted. (The level averages every pitch up to 24 kHz while
  // a voice is mostly under 4 kHz, which is why it reads lower than it sounds.)
  standard: { speech: 32, silence: 15, quiet: 21 },
  quiet: { speech: 22, silence: 10, quiet: 14 },
  // Noisy room: no "say it louder" band (quiet = speech), because there it is
  // mostly other people talking. Automatic gain stays on (see listeningSettings).
  noisy: { speech: 45, silence: 22, quiet: 45 },
};

// Where speech is recognised (local-asr.js, WsProxy._transcribeClip):
// auto: commands on this computer, everything else with Gemini;
// local: this computer only, never the internet; online: Gemini only.
export const SPEECH_ENGINES = ['auto', 'local', 'online'];

export const DEFAULT_PROFILE = Object.freeze({
  version: PROFILE_VERSION,
  // needsName: only act on phrases that start with "AbleSpeak" (noisy places; wake-name.js)
  // cleanUpDictation: dictated words are corrected by Gemini before they are
  // typed (misheard words, punctuation, capitals, um/uh), like Claude's or
  // Wispr Flow's dictation. The text goes to Google; never in an exam.
  listening: Object.freeze({ sensitivity: 'standard', pauseSeconds: 1.5, needsName: false, speechEngine: 'auto', cleanUpDictation: true }),
  vocabulary: Object.freeze([]),
  aliases: Object.freeze([]),
  macros: Object.freeze([]),
});

const LIMITS = { vocabulary: 100, word: 40, aliases: 50, say: 60, means: 200, macros: 20, steps: MAX_ROUTINE_STEPS, step: 200, name: 60 };

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = value => clean(value).toLowerCase().replace(/[.,!?;:]+$/g, '');

/**
 * Check and tidy a profile. Returns { profile, errors }; `profile` is always
 * complete, with defaults for anything missing.
 */
export function normaliseProfile(input = {}) {
  const errors = [];
  const source = input && typeof input === 'object' ? input : {};

  const listening = { ...DEFAULT_PROFILE.listening };
  if (source.listening !== undefined) {
    const { sensitivity, pauseSeconds, needsName, speechEngine, cleanUpDictation } = source.listening || {};
    if (needsName !== undefined) {
      if (typeof needsName === 'boolean') listening.needsName = needsName;
      else errors.push('listening.needsName must be true or false');
    }
    if (cleanUpDictation !== undefined) {
      if (typeof cleanUpDictation === 'boolean') listening.cleanUpDictation = cleanUpDictation;
      else errors.push('listening.cleanUpDictation must be true or false');
    }
    if (speechEngine !== undefined) {
      if (SPEECH_ENGINES.includes(speechEngine)) listening.speechEngine = speechEngine;
      else errors.push(`listening.speechEngine must be one of: ${SPEECH_ENGINES.join(', ')}`);
    }
    if (sensitivity !== undefined) {
      if (Object.hasOwn(SENSITIVITY, sensitivity)) listening.sensitivity = sensitivity;
      else errors.push(`listening.sensitivity must be one of: ${Object.keys(SENSITIVITY).join(', ')}`);
    }
    if (pauseSeconds !== undefined) {
      const seconds = Number(pauseSeconds);
      if (Number.isFinite(seconds) && seconds >= 0.8 && seconds <= 4) listening.pauseSeconds = Math.round(seconds * 10) / 10;
      else errors.push('listening.pauseSeconds must be between 0.8 and 4');
    }
  }

  const vocabulary = [];
  if (source.vocabulary !== undefined) {
    if (!Array.isArray(source.vocabulary)) errors.push('vocabulary must be a list of words');
    else {
      const seen = new Set();
      for (const item of source.vocabulary) {
        const word = clean(item);
        if (!word || seen.has(word.toLowerCase())) continue;
        if (word.length > LIMITS.word) { errors.push(`"${word.slice(0, 20)}…" is longer than ${LIMITS.word} characters`); continue; }
        seen.add(word.toLowerCase());
        vocabulary.push(word);
      }
      if (vocabulary.length > LIMITS.vocabulary) errors.push(`Keep the vocabulary to ${LIMITS.vocabulary} words`);
    }
  }

  const aliases = [];
  if (source.aliases !== undefined) {
    if (!Array.isArray(source.aliases)) errors.push('aliases must be a list');
    else {
      const seen = new Set();
      for (const item of source.aliases) {
        const say = clean(item?.say);
        const means = clean(item?.means);
        if (!say && !means) continue;
        if (!say || !means) { errors.push('Each shortcut needs both what the student says and what it means'); continue; }
        if (say.length > LIMITS.say || means.length > LIMITS.means) { errors.push(`The shortcut "${say.slice(0, 20)}" is too long`); continue; }
        if (seen.has(key(say))) { errors.push(`"${say}" is listed twice`); continue; }
        seen.add(key(say));
        // `learned`: added by AbleSpeak from the student's corrections
        aliases.push(item?.learned === true ? { say, means, learned: true } : { say, means });
      }
      if (aliases.length > LIMITS.aliases) errors.push(`Keep shortcuts to ${LIMITS.aliases}`);
    }
  }

  const macros = [];
  if (source.macros !== undefined) {
    if (!Array.isArray(source.macros)) errors.push('macros must be a list');
    else {
      const seen = new Set();
      for (const item of source.macros) {
        const name = clean(item?.name);
        const steps = Array.isArray(item?.steps) ? item.steps.map(clean).filter(Boolean) : [];
        if (!name && !steps.length) continue;
        if (!name || !steps.length) { errors.push('Each routine needs a name and at least one step'); continue; }
        if (name.length > LIMITS.name) { errors.push(`The routine name "${name.slice(0, 20)}…" is too long`); continue; }
        if (steps.length > LIMITS.steps) { errors.push(`"${name}" has more than ${LIMITS.steps} steps`); continue; }
        if (steps.some(step => step.length > LIMITS.step)) { errors.push(`A step in "${name}" is too long`); continue; }
        if (seen.has(key(name))) { errors.push(`The routine "${name}" is listed twice`); continue; }
        seen.add(key(name));
        macros.push({ name, steps });
      }
      if (macros.length > LIMITS.macros) errors.push(`Keep routines to ${LIMITS.macros}`);
    }
  }

  return { profile: { version: PROFILE_VERSION, listening, vocabulary, aliases, macros }, errors };
}

/** The saved profile, or the default one. */
export function getProfile(studentId) {
  if (studentId == null) return normaliseProfile({}).profile;
  const row = getStudentProfileRow(studentId);
  if (!row) return normaliseProfile({}).profile;
  try {
    return normaliseProfile(JSON.parse(row.profile)).profile;
  } catch {
    return normaliseProfile({}).profile;
  }
}

/** Merge `changes` into the saved profile. Throws with every problem found. */
export function saveProfile(studentId, changes) {
  const current = getProfile(studentId);
  const merged = {
    ...current,
    ...changes,
    listening: { ...current.listening, ...(changes?.listening || {}) },
  };
  const { profile, errors } = normaliseProfile(merged);
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.errors = errors;
    throw err;
  }
  saveStudentProfileRow(studentId, JSON.stringify(profile));
  return profile;
}

/** What the overlay needs to listen well for this student. */
export function listeningSettings(profile) {
  const { sensitivity, pauseSeconds, needsName, speechEngine } = profile.listening;
  const levels = SENSITIVITY[sensitivity] || SENSITIVITY.standard;
  return {
    sensitivity,
    needsName: !!needsName,
    speechEngine: speechEngine || 'auto',
    speechThreshold: levels.speech,
    silenceThreshold: levels.silence,
    quietThreshold: levels.quiet,
    // Automatic gain stays on for every profile. Turning it off in a noisy
    // room (tried 5 Oct 2026) left the person's own voice below the speech
    // level on a laptop mic, so nothing was ever heard. For voices nearby,
    // use "Say AbleSpeak first" (listening.needsName) instead.
    autoGain: true,
    commandPauseMs: Math.round(pauseSeconds * 1000),
    // Dictation always waits a little longer than a command.
    dictationPauseMs: Math.max(1800, Math.round(pauseSeconds * 1000) + 300),
  };
}

/** How many times the same correction must happen before it is learned. */
export const LEARN_AFTER = 2;

/**
 * Save "heard → meant" as a shortcut the student did not have to ask for,
 * unless that phrase already means something. Returns true if added.
 */
export function learnAlias(studentId, heard, meant) {
  const say = clean(heard).replace(/[.,!?;:]+$/g, '');
  const means = clean(meant).replace(/[.,!?;:]+$/g, '');
  if (!say || !means || key(say) === key(means)) return false;
  const profile = getProfile(studentId);
  if (profile.aliases.some(alias => key(alias.say) === key(say))) return false;
  if (profile.aliases.length >= LIMITS.aliases) return false;
  try {
    saveProfile(studentId, { aliases: [...profile.aliases, { say, means, learned: true }] });
    return true;
  } catch {
    return false;
  }
}

/** The command a student's own phrase stands for, or null. */
export function expandAlias(profile, text) {
  const said = key(text);
  if (!said) return null;
  return profile.aliases.find(alias => key(alias.say) === said)?.means ?? null;
}

/** The routine a phrase names ("start my homework"), or null. */
export function findMacro(profile, text) {
  const said = key(text).replace(/^(please |can you |run |do |start )?/, '');
  if (!said) return null;
  return profile.macros.find(macro => {
    const name = key(macro.name);
    return name === key(text) || name === said || name.replace(/^(run |do |start )/, '') === said;
  }) ?? null;
}
