/**
 * "Say AbleSpeak first" — for noisy places.
 *
 * With the listening option on, AbleSpeak only acts on phrases that start
 * with its name ("AbleSpeak, open Word", "Hey AbleSpeak, scroll down") and
 * ignores everything else it hears: other people, TV, music. Saying just the
 * name opens a short window in which the next phrase needs no name.
 *
 * Speech recognition writes the name in several ways ("Able speak",
 * "Able-Speak", "Abel speak", "Able speech"), so all of them count.
 */

export const NAME_WORD = 'AbleSpeak'; // added to the speech recognition vocabulary
export const NAME_WINDOW_MS = 8000;   // after just "AbleSpeak", the next phrase needs no name

// Includes what Gemini has actually heard for it: "I both speak", "A bull speak"
const NAME = '(?:able[\\s-]*speak|abel[\\s-]*speak|able[\\s-]*speech|ablespeech|i[\\s-]*both[\\s-]*speak|a[\\s-]*bull[\\s-]*speak)';
const NAME_RE = new RegExp(`^\\s*(?:(?:hey|hi|hello|ok|okay)[\\s,]+)?${NAME}\\b[\\s,.:;!?-]*`, 'i');
const NAME_AT_END_RE = new RegExp(`[\\s,.:;!?-]+${NAME}[\\s.,!?]*$`, 'i');

// What wakes AbleSpeak from sleep, or brings back a hidden voice bar.
const WAKE_WORDS = /^(?:wake up|wake|wake up now|i'?m back|i am back|listen|start listening|resume|come back|show yourself)$/;

/**
 * A wake phrase, however it is said: "wake up", "Wake up, AbleSpeak.",
 * "AbleSpeak, wake up", "Hey AbleSpeak", "okay wake up please", or just the
 * name. Anything more ("wake up and open Word") is not, so room talk that
 * happens to contain "wake up" does not wake it.
 */
export function isWakePhrase(text) {
  const { named, rest } = stripName(text);
  let core = rest.replace(NAME_AT_END_RE, '');
  const namedAtEnd = core !== rest;
  core = core.toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:please|okay|ok|hey|hi|hello|now) )+/, '')
    .replace(/(?: (?:please|now|again))+$/, '');
  if (!core) return named || namedAtEnd;
  return WAKE_WORDS.test(core);
}

/**
 * "AbleSpeak, open Word." → { named: true, rest: 'open Word.' }
 * "open Word"            → { named: false, rest: 'open Word' }
 */
export function stripName(text) {
  const said = String(text || '');
  const match = said.match(NAME_RE);
  if (!match) return { named: false, rest: said.trim() };
  const rest = said.slice(match[0].length).trim();
  // "AbleSpeak." alone leaves only punctuation
  return { named: true, rest: /^[\s.,!?]*$/.test(rest) ? '' : rest };
}

/**
 * The words after the name, wherever in the phrase it was said: with music
 * playing a recording often starts on the song ("…a melody in. AbleSpeak,
 * pause the music" → "pause the music"). '' for the name last; null without it.
 */
export function afterName(text) {
  const said = String(text || '');
  const inside = new RegExp(`(?:^|[\\s,.:;!?-])(?:(?:hey|hi|hello|ok|okay)[\\s,]+)?${NAME}\\b[\\s,.:;!?-]*`, 'ig');
  let last = null;
  for (const match of said.matchAll(inside)) last = match;
  if (!last) return null;
  const rest = said.slice(last.index + last[0].length).trim();
  return /^[\s.,!?]*$/.test(rest) ? '' : rest;
}

/**
 * Decide what to do with a phrase when the name is required.
 *   → { action: 'run', text }   act on text (name removed)
 *   → { action: 'listen' }      just the name: answer "Yes?" and wait
 *   → { action: 'ignore' }      no name: not meant for AbleSpeak
 * `inWindow` is true right after the person said just the name.
 */
export function gateByName(text, { inWindow = false } = {}) {
  const { named, rest } = stripName(text);
  if (named) return rest ? { action: 'run', text: rest } : { action: 'listen' };
  if (inWindow && rest) return { action: 'run', text: rest };
  return { action: 'ignore' };
}
