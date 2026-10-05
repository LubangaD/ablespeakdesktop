/**
 * AbleSpeak Safety Layer
 *
 * Pure, dependency-free functions that protect a student who cannot grab a
 * mouse to undo a mistake.
 *
 *   1. classifyConsequential(tool, args) — is this action irreversible enough
 *      to require an explicit spoken confirmation before it runs?
 *   2. detectHallucination(text, opts)  — is this transcript a phantom / noise
 *      / echo rather than a real command?
 *
 * Both are pure functions, unit-tested in safety.test.mjs.
 */

// ── 1. Consequential-action classification ────────────────────────────────

// Tool names are snake_case; split on _, -, spaces to get real tokens
// ("\b" is useless because "_" is itself a word character).
function toolTokens(tool) {
  return new Set(String(tool || '').toLowerCase().split(/[_\s-]+/).filter(Boolean));
}

const DELETE_WORDS = ['delete', 'remove', 'trash', 'destroy'];
const SEND_WORDS = ['send', 'submit', 'post', 'publish', 'email', 'share', 'purchase', 'buy', 'pay', 'order'];

// Tools whose real target is a labeled element, not the tool name itself — a
// misheard "click delete" must be gated the same way close_application already
// is (CVA-1). click_element may be called with only an xpath; tool-registry.js
// resolves that to args.resolvedLabel before the gate sees it.
const ELEMENT_TARGET_TOOLS = new Set(['click_element', 'click_desktop_element', 'select_option', 'uia_act']);

// uia_act only presses a control with these actions (none given means
// "press it"); typing into a field labelled "Email" is not sending one.
const PRESS_ACTIONS = new Set(['invoke', 'toggle', 'select']);

/** Best available human-readable text for what an element-targeting tool is about to act on. */
function targetLabel(args) {
  return String(args?.resolvedLabel || args?.label || args?.name || args?.text || '').toLowerCase();
}

/** True if the tool's target label is entirely made of / contains one of `words` as a whole word. */
function labelMatches(tool, args, words) {
  if (!ELEMENT_TARGET_TOOLS.has(tool)) return false;
  if (tool === 'uia_act' && args?.action && !PRESS_ACTIONS.has(args.action)) return false;
  const label = targetLabel(args);
  if (!label) return false;
  const tokens = label.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some(w => tokens.includes(w));
}

/** True if execute_javascript's code calls .submit() — form submission IS the "send" action. */
function jsSubmitCall(tool, args) {
  if (tool !== 'execute_javascript') return false;
  return /\.submit\s*\(/.test(String(args?.code || '').toLowerCase());
}

/** True if execute_javascript's code clicks something AND mentions one of `words` (CVA-1). */
function jsClickMatches(tool, args, words) {
  if (tool !== 'execute_javascript') return false;
  const code = String(args?.code || '').toLowerCase();
  if (!code || !/\.click\s*\(/.test(code)) return false;
  return words.some(w => code.includes(w));
}

const CONSEQUENTIAL_RULES = [
  {
    id: 'close-app',
    test: (tool, args) => {
      if (tool === 'close_application') return true;
      const keys = String(args?.keys || args?.key || '').toLowerCase().replace(/\s+/g, '');
      return (tool === 'send_system_keys' || tool === 'press_key_combination') && keys.includes('alt+f4');
    },
    prompt: 'Close this window? Any unsaved work could be lost. Say "yes" to confirm, or anything else to cancel.',
  },
  {
    id: 'delete',
    test: (tool, args) => {
      const tk = toolTokens(tool);
      if (DELETE_WORDS.some(w => tk.has(w))) return true;
      const keys = String(args?.keys || args?.key || '').toLowerCase().replace(/\s+/g, '');
      if (tool === 'send_system_keys' && keys.includes('shift+del')) return true;
      if (labelMatches(tool, args, DELETE_WORDS)) return true;
      if (jsClickMatches(tool, args, DELETE_WORDS)) return true;
      return false;
    },
    prompt: 'Delete this? This may not be reversible. Say "yes" to confirm, or anything else to cancel.',
  },
  {
    id: 'send',
    test: (tool, args) => {
      if (tool === 'send_system_keys' || tool === 'send_keys' || tool === 'press_key_combination') return false;
      const tk = toolTokens(tool);
      if (SEND_WORDS.some(w => tk.has(w))) return true;
      if (labelMatches(tool, args, SEND_WORDS)) return true;
      if (jsSubmitCall(tool, args)) return true;
      if (jsClickMatches(tool, args, SEND_WORDS)) return true;
      return false;
    },
    prompt: 'Send this? It will go out and cannot be unsent. Say "yes" to confirm, or anything else to cancel.',
  },
];

/**
 * @returns {{id:string, prompt:string}|null} null when safe to run immediately.
 */
export function classifyConsequential(tool, args = {}) {
  if (!tool) return null;
  for (const rule of CONSEQUENTIAL_RULES) {
    try {
      if (rule.test(tool, args)) return { id: rule.id, prompt: rule.prompt };
    } catch {
      // a faulty rule must never crash command processing
    }
  }
  return null;
}

const CLOSE_WORDS = ['close', 'quit', 'exit', 'shut'];

/**
 * Steps of a multi-step plan that will stop for a spoken yes/no (Stage 3).
 * Each tool call is still gated on its own; this only lets the plan say so
 * up front. Returns [{ index, id }].
 */
export function classifyPlan(steps = []) {
  const flagged = [];
  steps.forEach((step, index) => {
    const words = String(step?.do || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some(w => DELETE_WORDS.includes(w))) flagged.push({ index, id: 'delete' });
    else if (words.some(w => SEND_WORDS.includes(w))) flagged.push({ index, id: 'send' });
    else if (words.some(w => CLOSE_WORDS.includes(w)) && !words.includes('tab')) flagged.push({ index, id: 'close-app' });
  });
  return flagged;
}

const AFFIRMATIVES = /^(yes|yeah|yep|yup|confirm|confirmed|do it|go ahead|proceed|okay|ok|sure|affirmative)\b/i;

const NEGATIVES = /^(no|nope|nah|cancel|don'?t|do not|never ?mind|stop)\b/i;

/** A clear "no" — used where other words should not count as an answer. */
export function isNegative(text) {
  return NEGATIVES.test(String(text || '').trim());
}

/** Anything that is not a clear affirmative is treated as a cancel (safe default). */
export function isAffirmative(text) {
  return AFFIRMATIVES.test(String(text || '').trim());
}

/**
 * Whether what was heard is AbleSpeak's own question coming back through the
 * microphone ("…yes to confirm or anything else to cancel"), not the
 * student's answer. Needs four of the question's words in their order, and
 * mostly its words: "yes", "yes close it" and "yes, close this window" are
 * answers, because the question never says them in that order. An echo of
 * a question about deleting must never count as a yes, nor as a no.
 */
export function isEchoOf(heard, spoken) {
  const words = text => String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const said = words(spoken);
  const got = words(heard);
  if (got.length < 4 || said.length < 4) return false;
  const saidText = ` ${said.join(' ')} `;
  let inOrder = false;
  for (let i = 0; i + 4 <= got.length && !inOrder; i++) {
    inOrder = saidText.includes(` ${got.slice(i, i + 4).join(' ')} `);
  }
  if (!inOrder) return false;
  const vocabulary = new Set(said);
  return got.filter(w => vocabulary.has(w)).length / got.length >= 0.7;
}

// ── 2. Hallucination / noise / echo detection ─────────────────────────────

export const HALLUCINATION_PHRASES = [
  'the quick brown fox',
  'thank you for watching',
  'thanks for watching',
  'please subscribe',
  'like and subscribe',
  'subtitles by',
  'subtitles created by',
  'music playing',
  'music',
  "i'm not sure if i'm going to",
  "i don't know what to say",
  "i'm going to be late",
  "i'll be right back",
  'i have to go now',
  'can you hear me',
  'is anybody there',
  'hello is anyone there',
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text
 * @param {{lastTTS?:string, echoRatio?:number, maxLength?:number}} opts
 * @returns {{hallucination:boolean, reason:string|null}}
 */
export function detectHallucination(text, opts = {}) {
  const echoRatio = opts.echoRatio ?? 0.4;
  const maxLength = opts.maxLength ?? 300;
  const lastTTS = opts.lastTTS ?? '';
  const raw = String(text || '');
  const norm = normalize(raw);

  if (!norm) return { hallucination: true, reason: 'empty' };

  for (const phrase of HALLUCINATION_PHRASES) {
    if (norm.includes(normalize(phrase))) {
      return { hallucination: true, reason: 'denylist' };
    }
  }

  if (raw.length > maxLength) {
    return { hallucination: true, reason: 'too-long' };
  }

  const words = norm.split(' ').filter(Boolean);

  if (words.length >= 4) {
    const trigrams = new Map();
    for (let i = 0; i + 2 < words.length; i++) {
      const g = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2];
      trigrams.set(g, (trigrams.get(g) || 0) + 1);
    }
    for (const count of trigrams.values()) {
      if (count >= 3) return { hallucination: true, reason: 'repetition' };
    }
    if (new Set(words).size <= 2) {
      return { hallucination: true, reason: 'repetition' };
    }
  }

  if (lastTTS) {
    const ttsWords = new Set(normalize(lastTTS).split(' ').filter(w => w.length > 2));
    const heard = words.filter(w => w.length > 2);
    if (ttsWords.size > 0 && heard.length > 0) {
      const overlap = heard.filter(w => ttsWords.has(w)).length;
      const ratio = overlap / Math.min(ttsWords.size, heard.length);
      if (ratio > echoRatio) return { hallucination: true, reason: 'echo' };
    }
  }

  return { hallucination: false, reason: null };
}
