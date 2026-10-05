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
const NAME_RE = /^\s*(?:(?:hey|hi|hello|ok|okay)[\s,]+)?(?:able[\s-]*speak|abel[\s-]*speak|able[\s-]*speech|ablespeech|i[\s-]*both[\s-]*speak|a[\s-]*bull[\s-]*speak)\b[\s,.:;!?-]*/i;

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
