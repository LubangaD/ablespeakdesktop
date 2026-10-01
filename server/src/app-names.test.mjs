/**
 * Tests for switching apps by voice: spoken names → programs, choosing the
 * right window, and routing "switch to Word"-style phrases.
 * Run with: node --test src/app-names.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppName, pickWindow, spokenWindowName } from './app-names.js';
import { matchFastCommand } from './fast-commands.js';

// Front-to-back, as listVisibleWindows() returns them.
const WINDOWS = [
  { hwnd: '1', process: 'chrome', title: 'Every Word Explained - YouTube - Google Chrome' },
  { hwnd: '2', process: 'electron', title: 'AbleSpeak - Voice Command Center' },
  { hwnd: '3', process: 'WINWORD', title: 'Essay draft - Word' },
  { hwnd: '4', process: 'WINWORD', title: 'Document1 - Word' },
  { hwnd: '5', process: 'Spotify', title: 'Spotify Premium' },
  { hwnd: '6', process: 'explorer', title: 'Program Manager' },
  { hwnd: '7', process: 'explorer', title: 'Downloads - File Explorer' },
];

test('the ways students name Word all mean Word', () => {
  for (const said of ['word', 'Word document', 'word documents', 'Microsoft Word', 'my document', 'one document', 'one', 'on word']) {
    assert.equal(resolveAppName(said).app, 'Word', `"${said}"`);
  }
});

test('other common apps are recognised by everyday names', () => {
  assert.equal(resolveAppName('my spreadsheet').app, 'Excel');
  assert.equal(resolveAppName('the presentation').app, 'PowerPoint');
  assert.equal(resolveAppName('outlook').app, 'Outlook');
  assert.equal(resolveAppName('my email').app, null, 'could be Gmail — the AI decides');
  assert.equal(resolveAppName('file explorer').app, 'File Explorer');
  assert.equal(resolveAppName('spotify').app, null, 'unknown names are matched by window instead');
  assert.equal(resolveAppName('onenote').app, null, 'OneNote is not Word');
});

test('"Word" picks the front Word window, never a browser tab mentioning "word"', () => {
  assert.equal(pickWindow(WINDOWS, 'word document').hwnd, '3');
  assert.equal(pickWindow(WINDOWS, 'one document').hwnd, '3');
});

test('a document can be picked by its title', () => {
  assert.equal(pickWindow(WINDOWS, 'document1').hwnd, '4');
  assert.equal(pickWindow(WINDOWS, 'my essay').hwnd, '3');
});

test('other apps match by program name', () => {
  assert.equal(pickWindow(WINDOWS, 'spotify').hwnd, '5');
  assert.equal(pickWindow(WINDOWS, 'files').hwnd, '7', 'skips the desktop (Program Manager)');
});

test('an app that is not open, or AbleSpeak itself, is not picked', () => {
  assert.equal(pickWindow(WINDOWS, 'excel'), null);
  assert.equal(pickWindow(WINDOWS, 'ablespeak'), null);
  assert.equal(pickWindow(WINDOWS, ''), null);
});

test('"switch to", "go to" and "focus on" an app bring it to the front', () => {
  for (const [said, app] of [
    ['Switch to Word.', 'word'],
    ['switch to chrome', 'Chrome'],
    ['Go to Word.', 'word'],
    ['Focus on Word', 'word'],
    ['Bring up Spotify', 'spotify'],
    ['Bring one document to the front.', 'one document'],
  ]) {
    assert.deepEqual(matchFastCommand(said), { tool: 'focus_application', args: { app_name: app }, silent: true }, said);
  }
});

test('page and option phrases keep their own meaning', () => {
  assert.equal(matchFastCommand('Show settings').tool, 'navigate_dashboard');
  assert.equal(matchFastCommand('go to settings').tool, 'navigate_dashboard');
  assert.equal(matchFastCommand('Go to the top').tool, 'scroll_to_top');
  assert.equal(matchFastCommand('Switch to dark mode').tool, 'select_option');
});

test('a window is named briefly enough to say aloud', () => {
  assert.equal(spokenWindowName('Essay - Word'), 'Essay in Word');
  assert.equal(spokenWindowName('notepad  -  Read-Only  -  Last saved by user - Word'), 'notepad in Word');
  assert.equal(spokenWindowName('Untitled - Notepad'), 'Untitled in Notepad');
  assert.equal(spokenWindowName('Spotify Premium'), 'Spotify Premium');
  assert.equal(spokenWindowName(''), '');
});
