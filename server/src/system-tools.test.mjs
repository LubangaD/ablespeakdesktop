/**
 * Regression tests for the PowerShell string-safety helpers (CVA-2). Run with:
 *   node --test src/system-tools.test.mjs
 *
 * system-tools.js otherwise shells out to real PowerShell/COM and is Windows-only,
 * so these tests target the two pure escaping/sanitizing functions directly rather
 * than the functions that invoke them — that's where the injection bug actually was.
 * typeTextSystem() and dictateText() both now delegate to escapeForPSString(), so
 * proving it safe here covers both call sites by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForPS, escapeForPSString, mediaAppName } from './system-tools.js';

/**
 * Minimal PowerShell double-quoted-string scanner: backtick escapes the next
 * character literally; an unescaped quote terminates the string. Used to prove
 * an escaped value can never break out of `"${escaped}"` early, and that
 * decoding it round-trips to the original text.
 */
function scanPSDoubleQuoted(escaped) {
  let i = 0;
  let decoded = '';
  while (i < escaped.length) {
    const c = escaped[i];
    if (c === '`') {
      if (i + 1 < escaped.length) { decoded += escaped[i + 1]; i += 2; continue; }
      i += 1;
      continue;
    }
    if (c === '"') {
      return { brokeOutAt: i, decoded }; // unescaped quote — string ends here
    }
    decoded += c;
    i += 1;
  }
  return { brokeOutAt: null, decoded }; // consumed the whole thing safely
}

// ── escapeForPSString (dictateText / typeTextSystem) ───────────────────────

test('adversarial quote/backtick/dollar combinations cannot break out of the string', () => {
  const adversarial = [
    '"; Remove-Item C:\\ -Recurse -Force; "',
    '$(Remove-Item C:\\ -Recurse -Force)',
    '`"',                         // the exact case that broke typeTextSystem's old escaping order
    '`$',
    '``',
    'a"b`c$d',
    '""""',
    '````',
    '$env:USERPROFILE',
  ];
  for (const raw of adversarial) {
    const escaped = escapeForPSString(raw);
    const { brokeOutAt, decoded } = scanPSDoubleQuoted(escaped);
    assert.equal(brokeOutAt, null, `"${raw}" broke out of the string at index ${brokeOutAt}`);
    assert.equal(decoded, raw, `"${raw}" did not round-trip through escaping`);
  }
});

test('non-string input is coerced safely instead of throwing', () => {
  assert.equal(escapeForPSString(undefined), '');
  assert.equal(escapeForPSString(null), '');
});

// ── sanitizeForPS (sendKeys' unrecognized-token path) ───────────────────────

test('sanitizeForPS strips everything a PowerShell subexpression injection needs', () => {
  assert.equal(sanitizeForPS('$(calc)'), 'calc');

  const stripped = sanitizeForPS('"; Remove-Item C:\\ -Recurse -Force; "');
  assert.ok(!stripped.includes('"'), 'quote must be stripped');
  assert.ok(!stripped.includes(';'), 'semicolon (statement separator) must be stripped');
  assert.ok(!stripped.includes('$'), 'dollar (subexpression trigger) must be stripped');
  assert.ok(!stripped.includes('`'), 'backtick (escape char) must be stripped');
});

test('sanitizeForPS leaves ordinary alphanumeric key tokens untouched', () => {
  assert.equal(sanitizeForPS('a'), 'a');
  assert.equal(sanitizeForPS('F13'), 'F13');
});

test('mediaAppName: a Windows media session as a name to say', () => {
  assert.equal(mediaAppName('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'), 'Spotify');
  assert.equal(mediaAppName('chrome.exe'), 'Chrome');
  assert.equal(mediaAppName('Chrome'), 'Chrome');
  assert.equal(mediaAppName('msedge.exe'), 'Edge');
  assert.equal(mediaAppName(String.raw`C:\Program Files\VideoLAN\VLC\vlc.exe`), 'Vlc');
  assert.equal(mediaAppName(''), 'the music');
});
