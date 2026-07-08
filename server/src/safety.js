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
      if (['delete', 'remove', 'trash', 'destroy'].some(w => tk.has(w))) return true;
      const keys = String(args?.keys || args?.key || '').toLowerCase().replace(/\s+/g, '');
      return tool === 'send_system_keys' && keys.includes('shift+del');
    },
    prompt: 'Delete this? This may not be reversible. Say "yes" to confirm, or anything else to cancel.',
  },
  {
    id: 'send',
    test: (tool) => {
      if (tool === 'send_system_keys' || tool === 'send_keys' || tool === 'press_key_combination') return false;
      const tk = toolTokens(tool);
      return ['send', 'submit', 'post', 'publish', 'email', 'share', 'purchase', 'buy', 'pay', 'order'].some(w => tk.has(w));
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

const AFFIRMATIVES = /^(yes|yeah|yep|yup|confirm|confirmed|do it|go ahead|proceed|okay|ok|sure|affirmative)\b/i;

/** Anything that is not a clear affirmative is treated as a cancel (safe default). */
export function isAffirmative(text) {
  return AFFIRMATIVES.test(String(text || '').trim());
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
