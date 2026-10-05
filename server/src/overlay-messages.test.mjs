/**
 * The voice bar's plain-language messages (overlay-messages.js).
 * Run with:  node --test src/overlay-messages.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = {};
vm.runInNewContext(readFileSync(join(here, '..', 'overlay-messages.js'), 'utf8'), sandbox);
const { MODES, friendlyFailure, resultFor, plainUrls } = sandbox.AbleSpeakMessages;

test('web addresses are shown and said as the site name only', () => {
  assert.equal(
    plainUrls('Navigated to: https://en.wikipedia.org/wiki/Michael_Jackson'),
    'Navigated to: wikipedia.org',
  );
  assert.equal(plainUrls('See https://www.bbc.co.uk/news/world for more'), 'See bbc.co.uk for more');
  assert.equal(plainUrls('No address here.'), 'No address here.');
});

test('the result line never shows a raw address', () => {
  assert.doesNotMatch(resultFor('Opened https://en.wikipedia.org/w/index.php?search=x').text, /https?:/);
  assert.doesNotMatch(friendlyFailure('Could not open https://example.com/a/b/c').message, /https?:/);
});

test('every mode has a plain label', () => {
  for (const mode of ['ready', 'listening', 'processing', 'dictating', 'confirmation', 'speaking', 'sleeping', 'offline', 'error']) {
    assert.ok(MODES[mode], mode);
  }
});

test('a successful reply says what happened', () => {
  assert.deepEqual({ ...resultFor('Paused Spotify.') }, { kind: 'done', text: '✓ Paused Spotify' });
  assert.deepEqual({ ...resultFor('Opened Word. It is ready for you.') }, { kind: 'done', text: '✓ Opened Word' });
});

test('an empty, technical or long reply falls back to Done', () => {
  assert.equal(resultFor('').text, '✓ Done');
  assert.equal(resultFor('Done').text, '✓ Done');
  assert.equal(resultFor('[executed: system_type_text]').text, '✓ Done');
  assert.equal(resultFor('I have opened the document you asked for and scrolled to the second page of it.').text, '✓ Done');
});

test('a reply saying it could not do the thing is a failure, not a ✓', () => {
  assert.equal(resultFor('I am unable to read the contents of this page.').kind, 'failed');
  assert.equal(resultFor('I\'m sorry, I still can\'t retrieve the content of the page.').kind, 'failed');
  assert.equal(resultFor('Sorry, but I couldn\'t find that.').kind, 'failed');
  assert.equal(resultFor('I can see three links on this page.').kind, 'done');
  assert.match(resultFor('I am unable to read the contents of this page.').text, /^✗ /);
});

test('a reply that asks something waits for the answer', () => {
  assert.equal(resultFor('Which file do you want to open?').kind, 'waiting');
});

test('the Chrome permission error becomes a plain sentence', () => {
  const said = friendlyFailure("That didn't work: Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
  assert.equal(said.message, "I can't control this webpage right now.");
  assert.match(said.hint, /Chrome/);
});

test('a missing control tells the person what to try', () => {
  const said = friendlyFailure('Element ref 14 not found in the current screen model');
  assert.equal(said.message, "I couldn't find that on the screen.");
  assert.match(said.hint, /words you can see/);
});

test('timeouts, permissions and no internet are named plainly', () => {
  assert.equal(friendlyFailure('PowerShell timed out after 8000ms').message, 'That took too long.');
  assert.match(friendlyFailure('Access is denied.').message, /permission/);
  assert.match(friendlyFailure('fetch failed').message, /no internet/);
});

test("the server's own plain sentence is kept, without advice meant for the AI", () => {
  assert.equal(friendlyFailure('Spotify is not running. Say "open Spotify" first.').message, 'Spotify is not running. Say "open Spotify" first.');
  assert.equal(friendlyFailure("I couldn't pause the music.").message, "I couldn't pause the music.");
  assert.equal(
    friendlyFailure('Sent the key to Spotify but nothing started playing. Use click_desktop_element with name:"Play", app_name:"spotify" to click the Play button directly.').message,
    'Sent the key to Spotify but nothing started playing.',
  );
});

test('anything technical that is not recognised becomes a general apology', () => {
  const said = friendlyFailure('TypeError: Cannot read properties of undefined (reading "hwnd")');
  assert.equal(said.message, "I couldn't do that.");
  assert.match(said.hint, /Try again/);
});
