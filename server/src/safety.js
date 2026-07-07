/**
 * AbleSpeak Safety Module — pure functions, no I/O, no app-module imports.
 * Guards destructive voice actions for hands-free confirmation.
 */

// Browser names from tool-registry.js:582 — must stay in sync
const BROWSER_NAMES = ['chrome', 'brave', 'edge', 'firefox', 'safari', 'opera'];

// Keyboard chords that require confirmation before sending
const GUARDED_CHORDS = new Set(['alt+f4', 'ctrl+w', 'ctrl+shift+w', 'ctrl+f4']);

/** Classify a raw transcript from the speech-to-text layer.
 *  → { status: 'ok'|'no_speech', text: <trimmed> }
 */
export function classifyTranscript(text) {
  if (text == null) return { status: 'no_speech', text: '' };
  const trimmed = text.trim();
  if (trimmed === '' || /^silence[.!]?$/i.test(trimmed)) return { status: 'no_speech', text: '' };
  return { status: 'ok', text: trimmed };
}

/** Returns true when name (case-insensitive substring) is a protected browser.
 *  Mirrors the browser list hard-coded in tool-registry.js:582.
 */
export function isProtectedApplication(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return BROWSER_NAMES.some(b => lower.includes(b));
}

/** Decide whether a tool call requires spoken confirmation before executing.
 *  → { required: boolean, prompt?: string }
 */
export function requiresConfirmation(toolName, args) {
  if (toolName === 'close_application') {
    const appName = args?.app_name || args?.name || '';
    if (isProtectedApplication(appName)) return { required: false };
    return { required: true, prompt: `Close ${appName} — yes or no?` };
  }
  if (toolName === 'send_system_keys') {
    const chord = (args?.keys || '').toLowerCase().replace(/\s+/g, '');
    if (GUARDED_CHORDS.has(chord)) return { required: true, prompt: `Press ${chord} — yes or no?` };
  }
  return { required: false };
}

/** Parse a voice reply to a yes/no confirmation prompt.
 *  → 'yes' | 'no' | 'unclear'
 *  Case-insensitive word-boundary matching on the trimmed transcript.
 */
export function parseConfirmationReply(text) {
  if (!text) return 'unclear';
  const lower = text.trim().toLowerCase();

  const YES_PATTERNS = [
    /\byes\b/, /\byeah\b/, /\byep\b/, /\byup\b/, /\bsure\b/,
    /\bconfirm\b/, /\bok\b/, /\bokay\b/, /\bdo it\b/, /\bgo ahead\b/,
  ];
  const NO_PATTERNS = [
    /\bno\b/, /\bnope\b/, /\bnah\b/, /\bcancel\b/, /\bstop\b/,
    /\bdon'?t\b/, /\bnever mind\b/, /\bnegative\b/,
  ];

  const isYes = YES_PATTERNS.some(p => p.test(lower));
  const isNo  = NO_PATTERNS.some(p => p.test(lower));

  if (isYes && !isNo) return 'yes';
  if (isNo && !isYes) return 'no';
  return 'unclear';
}
