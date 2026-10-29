/**
 * Tests for the safety layer. Run with:  node --test src/safety.test.mjs
 * No external deps — uses node:test + node:assert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyConsequential,
  isAffirmative,
  isEchoOf,
  detectHallucination,
} from './safety.js';

// ── classifyConsequential ────────────────────────────────────────────────

test('closing an app via close_application is consequential', () => {
  const r = classifyConsequential('close_application', { app_name: 'Word' });
  assert.ok(r, 'should be flagged');
  assert.equal(r.id, 'close-app');
});

test('Alt+F4 via send_system_keys is consequential', () => {
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Alt+F4' }).id, 'close-app');
  assert.equal(classifyConsequential('send_system_keys', { keys: 'alt + f4' }).id, 'close-app');
});

test('send / submit / publish tools are consequential', () => {
  assert.equal(classifyConsequential('send_email', {}).id, 'send');
  assert.equal(classifyConsequential('submit_form', {}).id, 'send');
  assert.equal(classifyConsequential('publish_post', {}).id, 'send');
});

test('permanent delete is consequential', () => {
  assert.equal(classifyConsequential('delete_file', {}).id, 'delete');
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Shift+Delete' }).id, 'delete');
});

test('reversible / benign actions are NOT gated', () => {
  // closing a tab is reopenable with Ctrl+Shift+T → no confirmation
  assert.equal(classifyConsequential('close_tab', {}), null);
  assert.equal(classifyConsequential('scroll', { direction: 'down' }), null);
  assert.equal(classifyConsequential('click_element', { index: 2 }), null);
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Ctrl+C' }), null);
  assert.equal(classifyConsequential('press_key_combination', { key: 'Enter' }), null);
  assert.equal(classifyConsequential(null), null);
});

// ── Keys that send or delete only in some apps (test script SF-08, WRK-10) ──
// Ctrl+Enter / Alt+S send in Outlook and webmail; Delete / Ctrl+D delete in
// File Explorer and Outlook. Elsewhere they are a page break, a fill, a
// character. The gate is told the app in front and the browser's tab; when
// it can't say, it asks anyway.

const keys = (k, where) => classifyConsequential('send_system_keys', { keys: k }, where)?.id || null;
const tabKey = (args, tabUrl) => classifyConsequential('press_key_combination', args, { tabUrl })?.id || null;

test('Ctrl+Enter and Alt+S ask first in Outlook, classic or new', () => {
  for (const frontApp of ['OUTLOOK', 'olk', 'HxOutlook']) {
    assert.equal(keys('Ctrl+Enter', { frontApp }), 'send', frontApp);
    assert.equal(keys('Alt+S', { frontApp }), 'send', frontApp);
  }
  assert.equal(keys('ctrl + enter', { frontApp: 'OUTLOOK' }), 'send');
  assert.equal(keys('Control+Return', { frontApp: 'OUTLOOK' }), 'send');
});

test('Ctrl+Enter and Alt+S ask first in a webmail tab, and not on other pages', () => {
  for (const tabUrl of ['https://mail.google.com/mail/u/0/#inbox', 'https://outlook.office.com/mail/', 'https://outlook.live.com/mail/0/', 'https://mail.yahoo.com/d/folders/1']) {
    assert.equal(keys('Ctrl+Enter', { frontApp: 'chrome', tabUrl }), 'send', tabUrl);
    assert.equal(keys('Alt+S', { frontApp: 'msedge', tabUrl }), 'send', tabUrl);
    assert.equal(tabKey({ key: 'Enter', ctrl: true }, tabUrl), 'send', tabUrl);
  }
  assert.equal(keys('Ctrl+Enter', { frontApp: 'chrome', tabUrl: 'https://docs.google.com/document/d/1' }), null);
  assert.equal(tabKey({ key: 'Enter', ctrl: true }, 'https://docs.google.com/document/d/1'), null);
});

test('Ctrl+Enter and Alt+S stay quick in Word, Excel and other apps', () => {
  for (const frontApp of ['WINWORD', 'EXCEL', 'notepad', 'POWERPNT', 'explorer']) {
    assert.equal(keys('Ctrl+Enter', { frontApp }), null, frontApp);
    assert.equal(keys('Alt+S', { frontApp }), null, frontApp);
  }
});

test('Delete and Ctrl+D ask first in File Explorer and Outlook', () => {
  for (const frontApp of ['explorer', 'OUTLOOK', 'olk']) {
    assert.equal(keys('Delete', { frontApp }), 'delete', frontApp);
    assert.equal(keys('Del', { frontApp }), 'delete', frontApp);
    assert.equal(keys('Ctrl+D', { frontApp }), 'delete', frontApp);
  }
  assert.equal(keys('Delete', { frontApp: 'chrome', tabUrl: 'https://outlook.office.com/mail/' }), 'delete');
  assert.equal(tabKey({ key: 'Delete' }, 'https://outlook.live.com/mail/0/'), 'delete');
});

test('Delete and Ctrl+D stay quick while editing, and on other pages', () => {
  for (const frontApp of ['WINWORD', 'EXCEL', 'notepad']) {
    assert.equal(keys('Delete', { frontApp }), null, frontApp);
    assert.equal(keys('Ctrl+D', { frontApp }), null, frontApp);
  }
  assert.equal(keys('Delete', { frontApp: 'chrome', tabUrl: 'https://mail.google.com/mail/u/0/' }), null);
  assert.equal(tabKey({ key: 'Delete' }, 'https://docs.google.com/document/d/1'), null);
});

test('when the app in front or the tab is not known, these keys ask anyway', () => {
  assert.equal(keys('Ctrl+Enter'), 'send');
  assert.equal(keys('Alt+S', {}), 'send');
  assert.equal(keys('Delete', { frontApp: null }), 'delete');
  assert.equal(keys('Ctrl+D', { frontApp: '' }), 'delete');
  assert.equal(keys('Ctrl+Enter', { frontApp: 'chrome' }), 'send', 'a browser, page not known');
  assert.equal(keys('Delete', { frontApp: 'chrome' }), 'delete', 'a browser, page not known');
  assert.equal(tabKey({ key: 'Enter', ctrl: true }), 'send');
  assert.equal(tabKey({ key: 'Delete' }), 'delete');
});

test('the tool\'s own arguments cannot say which app is in front', () => {
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Ctrl+Enter', frontApp: 'WINWORD' }).id, 'send');
});

test('other keys are never asked about, even in Outlook or Explorer', () => {
  for (const k of ['Enter', 'Ctrl+C', 'Ctrl+S', 'Ctrl+Z', 'Backspace', 'Ctrl+Shift+Enter', 'Alt+D', 'Tab']) {
    assert.equal(keys(k, { frontApp: 'OUTLOOK' }), null, k);
    assert.equal(keys(k, { frontApp: 'explorer' }), null, k);
  }
  // Already asked everywhere: permanent delete, closing a window
  assert.equal(keys('Shift+Delete', { frontApp: 'WINWORD' }), 'delete');
  assert.equal(keys('Alt+F4', { frontApp: 'WINWORD' }), 'close-app');
});

// ── CVA-1: element-targeting tools gated by what they actually click, not just
// the tool name (a voice-driven click is the product's core interaction, and
// its tool name is always click_element/select_option/click_desktop_element —
// never "delete") ────────────────────────────────────────────────────────────

test('click_element on a "Delete account" label is consequential', () => {
  const r = classifyConsequential('click_element', { label: 'Delete account' });
  assert.ok(r, 'should be flagged');
  assert.equal(r.id, 'delete');
});

test('click_element on a "Submit" label is consequential', () => {
  assert.equal(classifyConsequential('click_element', { label: 'Submit' }).id, 'send');
});

test('click_element resolved from xpath-only (resolvedLabel) is gated the same way', () => {
  // tool-registry.js resolves xpath → resolvedLabel before the gate sees it,
  // since the AI often calls click_element with only an xpath and no label.
  const r = classifyConsequential('click_element', { xpath: '//button[3]', resolvedLabel: 'Remove item' });
  assert.ok(r);
  assert.equal(r.id, 'delete');
});

test('click_desktop_element on a "Delete" name is consequential', () => {
  assert.equal(classifyConsequential('click_desktop_element', { name: 'Delete', app_name: 'Explorer' }).id, 'delete');
});

test('select_option on a "Purchase" label is consequential', () => {
  assert.equal(classifyConsequential('select_option', { label: 'Purchase' }).id, 'send');
});

test('reversible clicks (nav links, toggles, unresolved xpath) are NOT falsely gated', () => {
  assert.equal(classifyConsequential('click_element', { label: 'Home' }), null);
  assert.equal(classifyConsequential('click_element', { label: 'Next' }), null);
  assert.equal(classifyConsequential('click_element', { label: 'Dark mode' }), null);
  assert.equal(classifyConsequential('click_element', { xpath: '//button[3]' }), null); // no label resolved
  assert.equal(classifyConsequential('click_desktop_element', { x: 100, y: 200 }), null); // coordinate click, no name
});

test('a label merely containing a flagged word as a substring is not falsely gated', () => {
  // "Sending" and "Senders" must not match the whole-word "send" rule.
  assert.equal(classifyConsequential('click_element', { label: 'Sending preferences' }), null);
  assert.equal(classifyConsequential('click_element', { label: 'Manage senders' }), null);
});

test('execute_javascript calling .submit() is consequential, even with no flagged wording', () => {
  const r = classifyConsequential('execute_javascript', { code: 'document.forms[0].submit();' });
  assert.ok(r);
  assert.equal(r.id, 'send');
});

test('execute_javascript clicking a delete-labeled element is consequential', () => {
  const code = `document.querySelector('[aria-label="Delete post"]').click();`;
  assert.equal(classifyConsequential('execute_javascript', { code }).id, 'delete');
});

test('execute_javascript with an ordinary, unflagged .click() is NOT gated', () => {
  const code = `document.querySelector('#next-page').click();`;
  assert.equal(classifyConsequential('execute_javascript', { code }), null);
});

test('execute_javascript that only reads the page (no click/submit) is NOT gated', () => {
  const code = `return document.body.innerText.includes('delete');`;
  assert.equal(classifyConsequential('execute_javascript', { code }), null);
});

// ── isAffirmative ─────────────────────────────────────────────────────────

test('affirmatives confirm, everything else cancels', () => {
  for (const yes of ['yes', 'Yeah', 'confirm', 'do it', 'go ahead', 'OK', 'sure']) {
    assert.equal(isAffirmative(yes), true, `${yes} should confirm`);
  }
  for (const no of ['no', 'cancel', 'wait', 'stop', 'actually never mind', '']) {
    assert.equal(isAffirmative(no), false, `${no} should cancel`);
  }
});

// ── detectHallucination ───────────────────────────────────────────────────

test('known phantom phrases are filtered', () => {
  assert.equal(detectHallucination('Thanks for watching!').hallucination, true);
  assert.equal(detectHallucination('please subscribe to my channel').hallucination, true);
  assert.equal(detectHallucination('Subtitles by the Amara.org community').hallucination, true);
});

test('near-duplicate phantoms are caught (the live-observed gap)', () => {
  // The audit noted one phantom got filtered and an almost-identical one did not.
  assert.equal(detectHallucination('thank you for watching').hallucination, true);
  assert.equal(detectHallucination('Thank you for watching.').hallucination, true);
  assert.equal(detectHallucination('thank  you   for watching!!!').hallucination, true);
});

test('repetitive ASR-on-noise output is filtered', () => {
  assert.equal(detectHallucination('you you you you you').hallucination, true);
  assert.equal(
    detectHallucination('I love you I love you I love you I love you').hallucination,
    true,
  );
});

test('overly long transcripts (song lyrics) are filtered', () => {
  const long = 'la '.repeat(150);
  assert.equal(detectHallucination(long).hallucination, true);
});

test('echo of our own TTS is filtered', () => {
  const tts = 'Opening Gmail in a new tab now';
  assert.equal(detectHallucination('opening gmail in a new tab', { lastTTS: tts }).hallucination, true);
});

test('real commands pass through', () => {
  for (const cmd of ['scroll down', 'open gmail', 'click the second link', 'go back', 'search for cats']) {
    assert.equal(detectHallucination(cmd).hallucination, false, `${cmd} should pass`);
  }
});

test('a real command is not mistaken for an echo of unrelated TTS', () => {
  assert.equal(
    detectHallucination('scroll down', { lastTTS: 'Opening Gmail in a new tab now' }).hallucination,
    false,
  );
});

// ── isEchoOf: the confirmation question heard back through the mic ──
const CLOSE_PROMPT = 'Close this window? Any unsaved work could be lost. Say yes to confirm or anything else to cancel.';

test('the question coming back through the mic is an echo, not an answer', () => {
  // Both heard on 2026-10-01 while closing Word.
  assert.ok(isEchoOf('Say yes to confirm or anything else to cancel.', CLOSE_PROMPT));
  assert.ok(isEchoOf('lost\nYes to confirm or anything else to cancel\nYes to confirm', CLOSE_PROMPT));
  assert.ok(isEchoOf('any unsaved work could be lost', CLOSE_PROMPT));
});

test('real answers are never taken for an echo', () => {
  for (const answer of ['yes', 'Yes.', 'no', 'yes close it', 'Yes, close the document.', 'Yes, close this window', 'no leave it open', 'cancel']) {
    assert.ok(!isEchoOf(answer, CLOSE_PROMPT), answer);
  }
});

// ── Replacing a file asks first (24 Oct 2026) ──────────────────────────────

test('replacing a file asks: save_document_as with replace, or Enter in the "replace?" box', () => {
  assert.equal(classifyConsequential('save_document_as', { name: 'notes', replace: true })?.id, 'replace');
  assert.equal(classifyConsequential('save_document_as', { name: 'notes' }), null, 'a new name is safe');
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Enter' }, { frontTitle: 'Confirm Save As' })?.id, 'replace');
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Alt+Y' }, { frontTitle: 'Confirm Save As' })?.id, 'replace');
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Escape' }, { frontTitle: 'Confirm Save As' }), null, 'cancelling is safe');
  assert.equal(classifyConsequential('send_system_keys', { keys: 'Enter' }, { frontTitle: 'notes.txt - Notepad' }), null, 'Enter elsewhere is safe');
});
