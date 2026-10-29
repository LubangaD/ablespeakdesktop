/**
 * What a student says → what is written in their answer. Only what they
 * said: spoken punctuation ("full stop", "new paragraph") becomes marks, and
 * in maths mode spoken maths ("x squared plus three") becomes symbols.
 * Nothing is reworded, corrected or added.
 */

// Names that are only ever punctuation, wherever they are said
const PUNCTUATION = [
  [/\bnew paragraph\b/gi, '\n\n'],
  [/\bnew line\b/gi, '\n'],
  [/\bfull stop\b/gi, '.'],
  [/\bcomma\b/gi, ','],
  [/\bquestion mark\b/gi, '?'],
  [/\b(exclamation mark|exclamation point)\b/gi, '!'],
  [/\bsemi ?colon\b/gi, ';'],
  [/\b(open bracket|open brackets|left bracket|open parenthesis)\b/gi, '('],
  [/\b(close bracket|close brackets|right bracket|close parenthesis)\b/gi, ')'],
  [/\b(open quote|open quotes|begin quote)\b/gi, '“'],
  [/\b(close quote|close quotes|end quote|unquote)\b/gi, '”'],
];

// Ordinary words too ("the colon", "the Jurassic period"): punctuation only when said on their own
const ALONE = { period: '.', colon: ':', hyphen: '-', dash: '-' };

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_WORD = `(?:${Object.keys(NUMBER_WORDS).join('|')}|hundred)`;

/** "twenty one" → 21, "7" → 7, "a hundred and five" → 105; null if it is not a number. */
export function wordsToNumber(text) {
  const t = String(text || '').toLowerCase().replace(/-/g, ' ').trim();
  if (/^\d+$/.test(t)) return Number(t);
  const words = t.split(/\s+/).filter(w => w && w !== 'and');
  if (!words.length) return null;
  let total = 0;
  for (const [i, w] of words.entries()) {
    if (w in NUMBER_WORDS) total += NUMBER_WORDS[w];
    else if (w === 'hundred') total = (total || 1) * 100;
    else if (w === 'a' && i === 0) continue;
    else return null;
  }
  return total;
}

const MATHS = [
  [/\bsquare root of\b/gi, '√'],
  [/\bcube root of\b/gi, '∛'],
  [/\bto the power of (\w+)/gi, (_, n) => `^${wordsToNumber(n) ?? n}`],
  [/\bsquared\b/gi, '²'],
  [/\bcubed\b/gi, '³'],
  [/\b(multiplied by|times)\b/gi, ' × '],
  [/\bdivided by\b/gi, ' ÷ '],
  [/\b(is )?greater than or equal to\b/gi, ' ≥ '],
  [/\b(is )?less than or equal to\b/gi, ' ≤ '],
  [/\b(is equal to|equals|equal to)\b/gi, ' = '],
  [/\b(is )?greater than\b/gi, ' > '],
  [/\b(is )?less than\b/gi, ' < '],
  [/\bplus\b/gi, ' + '],
  [/\bminus\b/gi, ' − '],
  [/\bover\b/gi, ' / '],
  [/\bpercent\b/gi, '%'],
  [/\bdegrees\b/gi, '°'],
  [/\bpi\b/gi, 'π'],
];

/** Number words → digits: "question twenty one" → "question 21", "three point five" → "3.5". */
export function digits(text) {
  const run = new RegExp(`\\b${NUMBER_WORD}(?:[\\s-]+(?:and\\s+)?${NUMBER_WORD})*\\b`, 'gi');
  return text
    .replace(run, m => String(wordsToNumber(m) ?? m))
    .replace(/(\d)\s+point\s+(\d)/gi, '$1.$2');
}

/**
 * Tidy the spaces around punctuation and symbols, without changing any word.
 * No space is ever added, so "e.g." stays "e.g.". Line breaks said on their
 * own ("new paragraph") are kept.
 */
function tidy(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/ +([.,;:?!)”%°²³])/g, '$1')
    .replace(/([(“√∛]) +/g, '$1')
    .replace(/([.,;:?!])(?:[ \t]*[.,;:?!])+/g, '$1')    // "movement, , of" → "movement, of"
    .replace(/\n[ \t]*[.,;:?!]+/g, '\n')                // "New paragraph." → a break, not a break and a full stop
    .replace(/ +\^/g, '^')
    .replace(/^[ \t]+|[ \t]+$/g, '');
}

/** A dictated piece of an answer, as it is written. */
export function spokenToText(spoken, { maths = false } = {}) {
  let text = String(spoken || '');
  const alone = ALONE[text.toLowerCase().replace(/[^a-z]/g, '')];
  if (alone) return alone;
  for (const [re, to] of PUNCTUATION) text = text.replace(re, to);
  if (maths) {
    text = digits(text);
    for (const [re, to] of MATHS) text = text.replace(re, to);
  }
  return tidy(text);
}

/**
 * The answer so far + a new piece: a space between them, and a capital
 * letter where a sentence starts (when `capitalise`).
 */
export function appendToAnswer(answer, piece, { capitalise = true } = {}) {
  const before = String(answer || '');
  let add = String(piece || '');
  if (!add) return before;
  const startsSentence = !before.trim() || /[.?!]\s*$/.test(before) || /\n\s*$/.test(before);
  if (capitalise && startsSentence) add = add.replace(/^([“(]?)([a-z])/, (_, q, c) => q + c.toUpperCase());
  if (!before) return add;
  const joiner = /\n$/.test(before) || /^\n/.test(add) || /^[.,;:?!)”]/.test(add) ? '' : ' ';
  return before + joiner + add;
}

/** The answer without its last word. */
export function dropLastWord(answer) {
  return String(answer || '').replace(/\s*\S+\s*$/, '');
}

/** Where the last sentence starts: just after the last ". ", "? ", "! " or line break before the end. */
function lastSentenceStart(text) {
  const body = text.replace(/[.?!\s]+$/, '');
  const m = body.match(/^[\s\S]*[.?!\n]/);
  return m ? m[0].length : 0;
}

/** The answer without its last sentence. */
export function dropLastSentence(answer) {
  const text = String(answer || '').replace(/\s+$/, '');
  return text.slice(0, lastSentenceStart(text)).replace(/[ \t]+$/, '');
}

/** The last sentence written, to read back. */
export function lastSentence(answer) {
  const text = String(answer || '').replace(/\s+$/, '');
  return text.slice(lastSentenceStart(text)).trim();
}

/** Text as it should be read aloud: symbols said in words. */
export function forSpeech(text) {
  return String(text || '')
    .replace(/\n+/g, '. ')
    .replace(/²/g, ' squared').replace(/³/g, ' cubed')
    .replace(/×/g, ' times ').replace(/÷/g, ' divided by ').replace(/−/g, ' minus ')
    .replace(/√/g, ' square root of ').replace(/∛/g, ' cube root of ')
    .replace(/≥/g, ' greater than or equal to ').replace(/≤/g, ' less than or equal to ')
    .replace(/\^(\d+)/g, ' to the power of $1').replace(/π/g, ' pi ').replace(/°/g, ' degrees')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Osmosis" → "capital O, s, m, o, s, i, s" — each letter said on its own. */
export function spellOut(word) {
  return [...String(word || '')]
    .filter(c => c.trim())
    .map(c => (/[A-Z]/.test(c) ? `capital ${c}` : c))
    .join(', ');
}

/** "m i t o", "M-I-T-O", "em eye tee oh" → "mito"; null if these are not all letters. */
export function lettersToWord(spoken) {
  const NAMES = {
    ay: 'a', bee: 'b', be: 'b', see: 'c', sea: 'c', dee: 'd', ee: 'e', ef: 'f', eff: 'f', gee: 'g', aitch: 'h', eych: 'h',
    eye: 'i', jay: 'j', kay: 'k', el: 'l', ell: 'l', em: 'm', en: 'n', oh: 'o', pee: 'p', cue: 'q', queue: 'q', ar: 'r',
    are: 'r', es: 's', ess: 's', tee: 't', tea: 't', you: 'u', vee: 'v', ex: 'x', why: 'y', zed: 'z', zee: 'z',
  };
  const tokens = String(spoken || '').toLowerCase().replace(/[.,]/g, ' ').split(/[\s-]+/).filter(Boolean);
  let capital = false;
  let word = '';
  for (const t of tokens) {
    if (t === 'capital') { capital = true; continue; }
    const letter = t.length === 1 && /[a-z]/.test(t) ? t : NAMES[t];
    if (!letter) return null;
    word += capital ? letter.toUpperCase() : letter;
    capital = false;
  }
  return word || null;
}
