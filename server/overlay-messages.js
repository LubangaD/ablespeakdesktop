/**
 * What the voice bar says, in the person's words (UI/UX spec §5, §18, §26).
 *
 * The server's results are written for the AI and for developers: tool names,
 * "Extension manifest must request permission…", "element not found". This
 * turns them into short, plain sentences with a next step, and names the
 * voice bar's modes. The raw text still goes to the app log for diagnostics.
 *
 * Loaded by overlay.html as a plain script (window.AbleSpeakMessages) and by
 * src/overlay-messages.test.mjs in a vm sandbox, so keep it dependency-free.
 */
(function (root) {
  'use strict';

  // The voice bar's modes, as the person sees them (spec §17)
  const MODES = {
    ready: 'Ready',
    listening: 'Listening…',
    processing: 'Working…',
    dictating: 'Dictating…',
    confirmation: 'Please confirm',
    speaking: 'Speaking…',
    sleeping: 'Asleep',
    offline: 'Voice unavailable',
    error: "Didn't work",
    done: 'Done',
    off: 'Mic off',
  };

  const TRY_AGAIN = 'Try again, or say it a different way.';

  // Words that mean a message was written for developers, not for the person
  const TECHNICAL = /\b[a-z]+_[a-z_]+\b|\b(uia|websocket|powershell|api|http|json|stack|undefined|null|exception|manifest|selector|xpath|hwnd|ref|ECONN\w*|ENOTFOUND|EAI_AGAIN|status code)\b|\b[45]\d\d\b|0x[0-9a-f]+/i;

  // Known technical causes → what to tell the person (spec §26)
  const CAUSES = [
    [/cannot access contents|extension manifest|no chrome extension|extension (is )?not connected|chrome.*not connected|no tab with media/i,
      { message: "I can't control this webpage right now.", hint: 'Check that Chrome is open, then try again.' }],
    [/\b(element|control|node|ref)\b[^.]*\bnot found\b|\bno (matching )?(element|control)\b|not found in the screen/i,
      { message: "I couldn't find that on the screen.", hint: 'Try saying the words you can see on it.' }],
    [/timed? ?out|timeout|took too long/i,
      { message: 'That took too long.', hint: 'Try again.' }],
    [/access is denied|permission denied|not permitted|requires elevation/i,
      { message: "AbleSpeak doesn't have permission to do that.", hint: 'Ask your helper to check the setup.' }],
    [/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network (is )?(down|unavailable)|no internet/i,
      { message: 'Voice control is unavailable — no internet.', hint: 'I’ll reconnect automatically.' }],
  ];

  /** Strip prefixes and advice meant for the AI ("Use uia_query to …"). */
  function clean(text) {
    return plainUrls(text)
      .replace(/^\s*(that didn'?t work|didn'?t work|error|failed)\s*:\s*/i, '')
      .replace(/\s*Use [a-z]+_[a-z_]+ (with [^.]*?)?to [^.]*\.?/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const isPlain = text => !!text && text.length <= 140 && !TECHNICAL.test(text);

  /**
   * A failure → { message, hint }: what happened, and what to do now.
   * The server's own sentence is kept when it is already plain.
   */
  function friendlyFailure(raw) {
    const text = clean(raw);
    for (const [pattern, said] of CAUSES) if (pattern.test(text)) return { ...said };
    if (isPlain(text)) return { message: text, hint: TRY_AGAIN };
    return { message: "I couldn't do that.", hint: TRY_AGAIN };
  }

  /**
   * A finished command → { kind, text } for the result line: what actually
   * happened ("✓ Paused Spotify") rather than a bare "Done" when the reply
   * says it plainly, and "waiting" when the reply asks the person something.
   */
  // A reply that says it could not do the thing is a failure, not a ✓
  const COULD_NOT = /^((i\s*(am|'m)\s+)?sorry[,.!]?\s*(but\s+)?)?(i\s*(am|'m)\s+(still\s+)?(unable|not able)|i\s+(still\s+)?(can'?t|cannot|couldn'?t|could not|was(n'?t| not) able)|unable to|(that|it)\s+(didn'?t|did not) work)/i;

  function resultFor(reply) {
    const text = clean(reply);
    if (!text || /^done\.?$/i.test(text)) return { kind: 'done', text: '✓ Done' };
    if (COULD_NOT.test(text)) {
      const first = text.split(/(?<=[.!])\s+/)[0].replace(/[.!]+$/, '');
      return { kind: 'failed', text: `✗ ${first.length <= 60 ? first : 'I couldn’t do that'}` };
    }
    if (/\?\s*$/.test(text)) return { kind: 'waiting', text: 'Your turn — answer when you’re ready' };
    const first = text.split(/(?<=[.!])\s+/)[0].replace(/[.!]+$/, '');
    if (first.length <= 48 && isPlain(first)) return { kind: 'done', text: `✓ ${first}` };
    return { kind: 'done', text: '✓ Done' };
  }

  /**
   * Web addresses as a person would say them: "https://en.wikipedia.org/wiki/X"
   * → "wikipedia.org". A reply should never show or read out a raw address.
   */
  function plainUrls(text) {
    return String(text || '').replace(/\bhttps?:\/\/([^\s/?#:)]+)[^\s)]*/gi, (_, host) => (
      host.toLowerCase()
        .replace(/^(www|m)\./, '')
        .replace(/^[a-z]{2,3}\.(m\.)?(wikipedia\.org)$/, '$2') || 'the page'
    ));
  }

  root.AbleSpeakMessages = { MODES, friendlyFailure, resultFor, clean, plainUrls };
})(typeof window !== 'undefined' ? window : globalThis);
