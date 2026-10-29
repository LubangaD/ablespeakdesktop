/**
 * Command autocorrect: a phrase that sounds like a known command runs as that
 * command ("pose the song" → "pause the song", "scroll dawn" → "scroll down",
 * "close this tub" → "close this tab"), instantly and on this computer, instead
 * of waiting for the AI or failing. What sounds alike is compared, not spelling:
 * each word is reduced to its consonant sounds, with voiced and voiceless pairs
 * (b/p, d/t, g/k, v/f, z/s) taken as the same.
 *
 * Only short phrases, never questions, and only when one command is clearly
 * closest: anything less certain goes to the AI as before, which understands
 * meaning but takes 1–3 s.
 */
import { matchFastCommand } from './fast-commands.js';
import { stripName } from './wake-name.js';

// Commands people say, in their usual words. Each is checked against the quick
// commands when this loads, so a phrase AbleSpeak can't run is never suggested.
const PHRASES = [
  'scroll down', 'scroll up', 'scroll left', 'scroll right', 'scroll down again', 'scroll up again',
  'scroll to the top', 'scroll to the bottom', 'go back', 'go forward', 'new tab', 'close this tab',
  'close tab', 'reload the page', 'refresh the page', 'next tab', 'previous tab', 'zoom in', 'zoom out',
  'pause', 'pause the song', 'pause the music', 'pause the video', 'play the song', 'play the music',
  'stop the music', 'next song', 'previous song', 'next track', 'skip', 'volume up', 'volume down',
  'mute', 'unmute', 'mute the sound', 'turn the volume up', 'turn the volume down',
  'minimise this window', 'minimise this tab', 'maximise the window', 'restore the window',
  'snap left', 'snap right', 'open word', 'open excel', 'open powerpoint', 'open chrome', 'open spotify',
  'open notepad', 'open file explorer', 'open settings', 'open youtube', 'start dictation', 'stop dictation',
  'go to sleep', 'wake up', 'read this page', 'select all', 'copy', 'paste', 'undo', 'redo', 'save',
  'go home', 'show my progress', 'skip the ad', 'skip ads', 'click skip the ad',
  'next video', 'previous video', 'skip the sponsor', 'back to the start',
];

// How commands that take words of the person's own start ("search for
// Michael Jackson"): only these opening words are corrected, the rest is kept
// ("Such for Michael Jackson" → "search for Michael Jackson")
const OPENINGS = ['search for', 'search youtube for', 'switch to', 'go to'];

/** "pause" → "PS", "song" → "SNK": a word's consonant sounds, voiced and voiceless alike. */
export function soundOf(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w.replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^ps/, 's').replace(/mb$/, 'm')
    .replace(/ph/g, 'f').replace(/gh/g, '').replace(/ck/g, 'k').replace(/sch/g, 'sk')
    .replace(/th/g, 't').replace(/sh/g, 's').replace(/ch/g, 'k')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks')
    .replace(/b/g, 'p').replace(/v/g, 'f').replace(/d/g, 't').replace(/g/g, 'k').replace(/z/g, 's');
  const first = /^[aeiou]/.test(w) ? 'A' : '';
  const consonants = w.replace(/[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1');
  return (first + consonants).toUpperCase();
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

const words = text => String(text || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const QUESTION = /^(what|who|whom|whose|why|when|where|which|how|can|could|would|should|is|are|was|were|do|does|did|will|tell|explain|describe)\b/;

// The phrases that are commands where the person is ("next video" only on
// YouTube), each with its sound and what it does. Never a correction that
// couldn't run on this page. Kept per site: the list depends only on it.
const knownBySite = new Map();
function knownFor(activeUrl = '') {
  let site = '';
  try { site = new URL(activeUrl).hostname; } catch { /* no page */ }
  if (!knownBySite.has(site)) {
    if (knownBySite.size > 50) knownBySite.clear();
    knownBySite.set(site, PHRASES.map(phrase => {
      const match = matchFastCommand(phrase, { activeUrl });
      return match && {
        phrase,
        sound: words(phrase).map(soundOf).join(' '),
        size: words(phrase).length,
        action: { tool: match.tool, args: match.args || {} },
      };
    }).filter(Boolean));
  }
  return knownBySite.get(site);
}

// What a command does, whatever words said it: "scroll up" and "scroll down"
// are the same tool but opposite actions, so never "the same command"
const actionKey = action => JSON.stringify([action.tool, action.args]);

const OPENING_SOUNDS = OPENINGS.map(phrase => ({ phrase, words: words(phrase), sound: words(phrase).map(soundOf).join(' ') }));

/** How alike two sound strings are, 0–1. */
function alike(a, b) {
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - distance(a, b) / longest : 0;
}

/**
 * The known command these words most likely were, among those that work on
 * the page the person is on (`activeUrl`), or null.
 * → { phrase, score, action: { tool, args } }
 */
export function autocorrectCommand(text, { activeUrl = '' } = {}) {
  const said = words(stripName(String(text || '')).rest);
  if (said.length === 0 || said.length > 6 || QUESTION.test(said.join(' '))) return null;
  const sound = said.map(soundOf).join(' ');
  if (sound.replace(/\s/g, '').length < 2) return null;
  const scored = knownFor(activeUrl)
    .filter(k => Math.abs(k.size - said.length) <= 1)
    .map(k => ({ phrase: k.phrase, score: alike(sound, k.sound), action: k.action }))
    .sort((a, b) => b.score - a.score);
  const [best] = scored;
  if (!best || best.score < 0.85) return correctOpening(said, activeUrl);
  // Another action about as close (even the same tool the other way): not
  // certain enough to pick one, so the AI hears what was said
  const rival = scored.find(s => actionKey(s.action) !== actionKey(best.action));
  if (rival && rival.score > best.score - 0.1) return null;
  if (best.phrase === said.join(' ')) return null; // already right
  return best;
}

/** "such for michael jackson" → "search for michael jackson", when that is a command here. */
function correctOpening(said, activeUrl) {
  for (const opening of OPENING_SOUNDS) {
    const size = opening.words.length;
    if (said.length <= size || said.slice(0, size).join(' ') === opening.phrase) continue;
    const score = alike(said.slice(0, size).map(soundOf).join(' '), opening.sound);
    if (score < 0.8) continue;
    const phrase = [opening.phrase, ...said.slice(size)].join(' ');
    const match = matchFastCommand(phrase, { activeUrl });
    if (match) return { phrase, score, action: { tool: match.tool, args: match.args || {} } };
  }
  return null;
}
