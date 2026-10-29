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
import { sanitizeForPS, escapeForPSString, mediaAppName, sessionReply, mediaSessionName, pickLaunchedWindow, keyPlan, matchFileInFolder, saveFolderSpec } from './system-tools.js';

// ── "Save as X in Documents": where the folder is (24 Oct 2026) ──

test('a spoken folder becomes a shell folder, a full path stays as it is, nothing means the dialog\'s own folder', () => {
  assert.deepEqual(saveFolderSpec('Documents'), { shell: 'shell:Personal' });
  assert.deepEqual(saveFolderSpec('my Downloads folder'), { shell: 'shell:Downloads' });
  assert.deepEqual(saveFolderSpec('C:\\Users\\Amina\\Essays'), { path: 'C:\\Users\\Amina\\Essays' });
  assert.equal(saveFolderSpec(''), null);
  assert.equal(saveFolderSpec('the cloud'), null, 'unknown folders are refused, not guessed');
});

// ── Opening a file in a folder window by name (Explorer hides extensions; 24 Oct 2026) ──

test('a file is found by its full name, or by its name without the extension', () => {
  const files = ['ablespeak-eval.txt', 'ablespeak-eval.pdf', 'Essay draft.docx', 'notes'];
  assert.deepEqual(matchFileInFolder(files, 'ablespeak-eval.txt'), { name: 'ablespeak-eval.txt' });
  assert.deepEqual(matchFileInFolder(files, 'ABLESPEAK-EVAL.PDF'), { name: 'ablespeak-eval.pdf' });
  assert.deepEqual(matchFileInFolder(files, 'essay draft'), { name: 'Essay draft.docx' });
  assert.deepEqual(matchFileInFolder(files, 'notes'), { name: 'notes' });
  assert.equal(matchFileInFolder(files, 'homework'), null);
});

test('two files shown with the same name are a question, not a guess', () => {
  assert.deepEqual(matchFileInFolder(['ablespeak-eval.txt', 'ablespeak-eval.pdf'], 'ablespeak-eval'), { ambiguous: ['ablespeak-eval.txt', 'ablespeak-eval.pdf'] });
});

// ── The Windows key (agent eval, 24 Oct 2026: "press the Windows key" did nothing) ──

test('the Windows key on its own is a tap of the real key (the Start menu)', () => {
  for (const said of ['Windows', 'win', 'LWin', 'windows key', 'Super']) assert.deepEqual(keyPlan(said), { vk: [] }, said);
});

test('Windows-key shortcuts are pressed as key codes with the key held', () => {
  assert.deepEqual(keyPlan('Win+D'), { vk: [0x44] });
  assert.deepEqual(keyPlan('Windows+Left'), { vk: [0x25] });
  assert.match(keyPlan('Win+F13').error, /can't press Windows\+f13/);
});

test('ordinary shortcuts still map to SendKeys text', () => {
  assert.deepEqual(keyPlan('Ctrl+Shift+S'), { sendKeys: '^+s' });
  assert.deepEqual(keyPlan('Enter'), { sendKeys: '{ENTER}' });
  assert.deepEqual(keyPlan('Alt+F4'), { sendKeys: '%{F4}' });
});

// ── Opening an app brings its new window forward (agent eval, 23 Oct 2026) ──

test('the window an app just opened is the new one, not one that was already there', () => {
  const chrome = { hwnd: '10', process: 'chrome', title: 'Notepad tips - Google Chrome' };
  const oldNotepad = { hwnd: '11', process: 'Notepad', title: 'shopping.txt - Notepad' };
  const newNotepad = { hwnd: '12', process: 'Notepad', title: 'Untitled - Notepad' };
  const before = new Set(['10', '11']);
  assert.equal(pickLaunchedWindow(before, [chrome, oldNotepad, newNotepad], 'notepad').hwnd, '12');
  assert.equal(pickLaunchedWindow(before, [chrome, oldNotepad], 'notepad'), null, 'not open yet');
});

test('a named app finds its own media session, never "any app"', () => {
  assert.equal(mediaSessionName('spotify'), 'spotify', 'not split on the letter s');
  assert.equal(mediaSessionName('Spotify Premium'), 'spotify');
  assert.equal(mediaSessionName('  VLC  media player '), 'vlc');
});

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

test('what a media session did, in words for the person and the AI', () => {
  const spotify = { app: 'Spotify', track: 'Bebe Rexha - New Religion' };
  assert.equal(sessionReply('play', { ...spotify, wasPlaying: false, playing: true }).message, 'Playing Bebe Rexha - New Religion.');
  assert.equal(sessionReply('play', { ...spotify, wasPlaying: false, playing: false }).status, 'error');
  assert.equal(sessionReply('play_pause', { ...spotify, wasPlaying: true, playing: false }).message, 'Paused Spotify.');
  assert.equal(sessionReply('pause', { ...spotify, wasPlaying: true, playing: true }).status, 'error', 'still playing');
  assert.equal(sessionReply('next', { ...spotify, wasPlaying: true, playing: true }).message, 'Now playing Bebe Rexha - New Religion.');
});
