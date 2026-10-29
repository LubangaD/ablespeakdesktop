/**
 * The AI hears when its actions changed nothing, or went in a circle.
 * Run with:  node --test src/screen-change.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenFingerprint, screenChangeNote } from './screen-change.js';

const screen = (window, ...elements) => ({ window, elements });
const button = (name, extra = {}) => ({ type: 'Button', name, ...extra });

test('the same window and controls give the same fingerprint', () => {
  assert.equal(screenFingerprint(screen('Calculator', button('One'), button('Two'))), screenFingerprint(screen('Calculator', button('One'), button('Two'))));
});

test('a value, toggle or focus change is a change', () => {
  const base = screenFingerprint(screen('Settings', button('Wi-Fi', { toggled: 'off' })));
  assert.notEqual(screenFingerprint(screen('Settings', button('Wi-Fi', { toggled: 'on' }))), base);
  assert.notEqual(screenFingerprint(screen('Settings', button('Wi-Fi', { toggled: 'off', focused: true }))), base);
  assert.notEqual(screenFingerprint(screen('Settings - Display', button('Wi-Fi', { toggled: 'off' }))), base);
});

test('with focus ignored, only focus moving is no change (a dialog still opening)', () => {
  const editing = screen('Doc', button('Save'), { type: 'Edit', name: 'Text editor', focused: true });
  const unfocused = screen('Doc', button('Save'), { type: 'Edit', name: 'Text editor', focused: false });
  assert.notEqual(screenFingerprint(editing), screenFingerprint(unfocused));
  assert.equal(screenFingerprint(editing, { ignoreFocus: true }), screenFingerprint(unfocused, { ignoreFocus: true }));
  assert.notEqual(screenFingerprint(screen('Save as', button('Save')), { ignoreFocus: true }), screenFingerprint(editing, { ignoreFocus: true }));
});

test('an unread screen has no fingerprint', () => {
  assert.equal(screenFingerprint(null), null);
  assert.equal(screenFingerprint({ status: 'error' }), null);
});

test('nothing changed: the AI is told not to repeat itself', () => {
  assert.match(screenChangeNote(['a'], 'a'), /nothing on the screen changed/);
});

test('back where an earlier step started: the AI is told it went in a circle', () => {
  assert.match(screenChangeNote(['a', 'b'], 'a'), /back to how it was before step 1/);
});

test('a new screen, or a read that failed, needs no note', () => {
  assert.equal(screenChangeNote(['a'], 'b'), '');
  assert.equal(screenChangeNote(['a'], null), '');
  assert.equal(screenChangeNote([null], 'a'), '');
  assert.equal(screenChangeNote([], 'a'), '');
});
