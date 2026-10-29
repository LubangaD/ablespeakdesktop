/**
 * Learned commands (in shadow mode for now).
 *
 * A phrase the AI handled the same way, successfully, 3 times in the same app
 * or on the same site is learned: next time those steps could run straight
 * away, without asking the AI (1–3.5 s a command). While in shadow mode it is
 * only compared with what the AI does, and the agreement is logged, so it can
 * be trusted before it acts. Learned per student, from their saved commands
 * (each AI action is saved with its arguments since 17 Oct 2026).
 *
 * Only actions with steady arguments are learned. Never closing, deleting,
 * sending or typing, never reading a page (the AI has to answer), and never a
 * step aimed at a control's place on the screen (refs, xpaths), which changes.
 */
import { stripName } from './wake-name.js';
import { toolFailed } from './tool-outcome.js';

export const LEARN_AFTER_SUCCESSES = 3;
// A failure among the phrase's last few runs means it isn't settled yet
const RECENT_RUNS = 5;

export const REPLAYABLE = new Set([
  'system_media_control', 'system_volume', 'open_application', 'focus_application', 'window_control',
  'open_url', 'search_web', 'search_youtube', 'create_tab', 'go_back', 'go_forward', 'reload_tab',
  'scroll', 'scroll_to_top', 'scroll_to_bottom', 'media_control', 'zoom_tab', 'navigate_dashboard',
  'toggle_continuous_mode', 'desktop_scroll',
]);

/** "AbleSpeak, Next song." → "next song": how a phrase is recognised again. */
export function phraseKey(text) {
  return stripName(String(text || '')).rest.toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Where a command was said: the app in front, or the website when the browser
 * is in front (the browser's page is known even while Spotify is in front).
 */
export function placeOf({ site, front } = {}) {
  return String(front?.app || site || '').toLowerCase();
}

function replayable(step) {
  if (!REPLAYABLE.has(step.tool) || !step.args || typeof step.args !== 'object') return false;
  if (step.tool === 'window_control' && /close/i.test(String(step.args.action))) return false;
  return true;
}

const parse = text => { try { return JSON.parse(text); } catch { return null; } };

/**
 * The learned commands in a student's recent AI commands (newest first).
 * → Map "phrase|place" → { phrase, place, steps: [{ tool, args }], successes }
 */
export function learnFrom(rows) {
  const runs = new Map(); // key → its runs, newest first
  for (const row of rows || []) {
    const payload = parse(row.payload) || {};
    const phrase = phraseKey(payload.text);
    if (!phrase || phrase.split(' ').length > 12) continue;
    const place = placeOf(payload);
    const key = `${phrase}|${place}`;
    const calls = (parse(row.result)?.toolCalls || []).map(c => ({ tool: c.tool || c.name, args: c.args, ok: !toolFailed(c.result) }));
    const good = row.outcome === 'success' && calls.length > 0 && calls.every(c => c.ok && replayable(c));
    if (!runs.has(key)) runs.set(key, { phrase, place, list: [] });
    runs.get(key).list.push(good ? JSON.stringify(calls.map(({ tool, args }) => ({ tool, args }))) : null);
  }
  const learned = new Map();
  for (const [key, { phrase, place, list }] of runs) {
    if (list.slice(0, RECENT_RUNS).includes(null)) continue;
    // The newest way, counted back until it was done differently
    let successes = 0;
    while (successes < list.length && list[successes] === list[0]) successes++;
    if (successes >= LEARN_AFTER_SUCCESSES) learned.set(key, { phrase, place, steps: JSON.parse(list[0]), successes });
  }
  return learned;
}

/** The learned command for these words in this place, or null. */
export function findLearned(learned, text, where = {}) {
  return learned.get(`${phraseKey(text)}|${placeOf(where)}`) || null;
}

/** The AI's actions in the same shape as learned steps, to compare them. */
export function stepsOf(toolCalls) {
  return (toolCalls || []).map(c => ({ tool: c.tool || c.name, args: c.args }));
}
