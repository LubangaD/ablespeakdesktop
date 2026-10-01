/**
 * Tests for the screen model (Stage 2): choosing the control a student named,
 * what "press it" means, the prompt summary, the safety gate on uia_act, and
 * (on Windows) that the C# reader compiles and answers.
 * Run with: node --test src/screen-model.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { findElement, defaultAction, describeElements, TEXT_SCOPES, findDocument, isCacheFresh } from './screen-model.js';
import { classifyConsequential } from './safety.js';
import { ToolRegistry } from './tool-registry.js';

const MODEL = {
  elements: [
    { ref: '1', type: 'Button', name: 'Save as', rect: [0, 0, 10, 10], actions: ['invoke'] },
    { ref: '2', type: 'Button', name: 'Save', rect: [0, 0, 10, 10], actions: ['invoke'] },
    { ref: '3', type: 'Text', name: 'Save your work often', rect: [0, 0, 10, 10], actions: [] },
    { ref: '4', type: 'CheckBox', name: 'Bold', rect: [0, 0, 10, 10], actions: ['toggle'], toggled: 'off' },
    { ref: '5', type: 'MenuItem', name: 'File', rect: [0, 0, 10, 10], actions: ['expand_collapse'], expanded: 'collapsed' },
    { ref: '6', type: 'Edit', name: 'Search', rect: [0, 0, 10, 10], actions: ['set_value'], value: 'road lines' },
    { ref: '7', type: 'Button', name: 'Next page', rect: [0, 0, 10, 10], actions: ['invoke'], enabled: false },
    { ref: '8', type: 'TabItem', name: 'Insert', rect: [0, 0, 10, 10], actions: ['select'] },
  ],
};

test('an exact name wins over a longer one', () => {
  assert.equal(findElement(MODEL, 'save').ref, '2');
  assert.equal(findElement(MODEL, 'Save as').ref, '1');
});

test('controls beat plain text with the same words', () => {
  assert.equal(findElement(MODEL, 'save your').ref, '3', 'only the text matches this');
  assert.equal(findElement(MODEL, 'bold').ref, '4');
});

test('words in any order still find the control', () => {
  assert.equal(findElement(MODEL, 'page next').ref, '7');
});

test('a type narrows the search, and unknown names find nothing', () => {
  assert.equal(findElement(MODEL, 'search', { type: 'Edit' }).ref, '6');
  assert.equal(findElement(MODEL, 'save', { type: 'Edit' }), null);
  assert.equal(findElement(MODEL, 'print'), null);
  assert.equal(findElement(MODEL, ''), null);
});

test('"press it" uses the control\'s own action', () => {
  const byRef = ref => MODEL.elements.find(e => e.ref === ref);
  assert.equal(defaultAction(byRef('2')), 'invoke');
  assert.equal(defaultAction(byRef('4')), 'toggle');
  assert.equal(defaultAction(byRef('5')), 'expand');
  assert.equal(defaultAction({ ...byRef('5'), expanded: 'expanded' }), 'collapse');
  assert.equal(defaultAction(byRef('8')), 'select');
  assert.equal(defaultAction(byRef('3')), 'focus');
});

test('the summary gives the model refs, actions and state', () => {
  const lines = describeElements(MODEL).split('\n');
  assert.equal(lines[0], '1 Button "Save as" [invoke]');
  assert.equal(lines[3], '4 CheckBox "Bold" [toggle] (toggle off)');
  assert.equal(lines[5], '6 Edit "Search" [set_value] (value "road lines")');
  assert.equal(lines[6], '7 Button "Next page" [invoke] (disabled)');
});

test('a slider shows the number on screen and its position on the app\'s own scale', () => {
  // As Word shows its zoom: 100% is position 1000 of 0-2000.
  const zoom = { ref: '9', type: 'Slider', name: 'Zoom', rect: [0, 0, 10, 10], actions: ['set_range'], value: '100', range: [1000, 0, 2000] };
  assert.equal(describeElements({ elements: [zoom] }), '9 Slider "Zoom" [set_range] (value "100", position 1000 of 0–2000)');
});

test('"read this" means the focused text, else the document, else a field', () => {
  const doc = { ref: 'd', type: 'Document', name: 'Essay', actions: ['scroll', 'read_text'] };
  const field = { ref: 'f', type: 'Edit', name: 'Search', actions: ['set_value', 'read_text'] };
  const button = { ref: 'b', type: 'Button', name: 'Save', actions: ['invoke'], focused: true };
  assert.equal(findDocument({ elements: [button, field, doc] }).ref, 'd', 'a focused button is not text');
  assert.equal(findDocument({ elements: [doc, { ...field, focused: true }] }).ref, 'f');
  assert.equal(findDocument({ elements: [button, field] }).ref, 'f');
  assert.equal(findDocument({ elements: [button] }), null);
});

test('a cached read is reused only while it is recent and focus has not moved', () => {
  const win = { hwnd: '10', title: 'Essay - Word' };
  const cached = { hwnd: '10', title: 'Essay - Word', at: 1000, focusChanges: 7, model: { elements: [{}, {}], total: 2 } };
  assert.ok(isCacheFresh(cached, win, { now: 2000 }), 'recent, focus not checked yet');
  assert.ok(isCacheFresh(cached, win, { now: 2000, focusChanges: 7 }), 'focus has not moved');
  assert.ok(!isCacheFresh(cached, win, { now: 2000, focusChanges: 8 }), 'focus moved: read again');
  assert.ok(!isCacheFresh(cached, win, { now: 9000, focusChanges: 7 }), 'too old, even with focus still');
  assert.ok(!isCacheFresh(cached, { ...win, title: 'Other - Word' }, { now: 2000 }), 'another window');
  assert.ok(isCacheFresh(cached, win, { now: 2000, focusChanges: -1 }), 'no watch: timing alone');
  assert.ok(isCacheFresh({ ...cached, focusChanges: -1 }, win, { now: 2000, focusChanges: 9 }), 'read before the watch began: timing alone');
  const partial = { ...cached, model: { elements: [{}, {}], total: 5 } };
  assert.ok(!isCacheFresh(partial, win, { now: 2000, maxElements: 50 }), 'fewer controls kept than now wanted');
  assert.ok(!isCacheFresh(null, win));
});

test('read_text knows how much of a document to read', () => {
  for (const scope of ['all', 'selection', 'word', 'line', 'paragraph', 'page']) assert.ok(TEXT_SCOPES.has(scope), scope);
  assert.ok(!TEXT_SCOPES.has('sentence'), 'UI Automation has no sentence unit');
});

test('pressing a Delete or Send control through uia_act asks first', () => {
  assert.equal(classifyConsequential('uia_act', { name: 'Delete' })?.id, 'delete');
  assert.equal(classifyConsequential('uia_act', { name: 'Send', action: 'invoke' })?.id, 'send');
  assert.equal(classifyConsequential('uia_act', { resolvedLabel: 'Move to trash' })?.id, 'delete');
});

test('typing into a field named Email, or reading it, does not', () => {
  assert.equal(classifyConsequential('uia_act', { name: 'Email', action: 'set_value', value: 'x' }), null);
  assert.equal(classifyConsequential('uia_act', { name: 'Sent items', action: 'read_text' }), null);
  assert.equal(classifyConsequential('uia_query', { name: 'Delete' }), null);
});

test('a control pressed by ref is gated by its real name', async () => {
  const registry = new ToolRegistry();
  const controls = { r1: { ref: 'r1', type: 'Button', name: 'Delete message' }, r2: { ref: 'r2', type: 'Button', name: 'Send/Receive' } };
  registry.findDesktopControl = async args => (args.ref ? controls[args.ref] : controls.r2);
  const hub = {};
  const byRef = await registry.executeTool('uia_act', { ref: 'r1' }, hub);
  assert.equal(byRef.status, 'needs_confirmation');
  assert.equal(hub._pendingConfirmation.tool, 'uia_act');
  const fuzzy = await registry.executeTool('click_desktop_element', { name: 'receive' }, {});
  assert.equal(fuzzy.status, 'needs_confirmation', '"receive" presses Send/Receive');
});

after(async () => {
  if (process.platform === 'win32') (await import('./system-tools.js')).stopSystemTools();
});

test('the C# reader compiles and answers for a window that does not exist', { skip: process.platform !== 'win32' }, async () => {
  const { runPowerShell } = await import('./system-tools.js');
  const ready = await runPowerShell(`if ('ScreenModel' -as [type]) { 'READY' } else { 'MISSING' }`, 60000);
  assert.equal(ready, 'READY');
  const snapshot = JSON.parse(await runPowerShell('[ScreenModel]::Snapshot([long]1, 10)', 20000));
  assert.ok(['NO_WINDOW', 'READ_FAILED'].includes(snapshot.error), JSON.stringify(snapshot));
  const act = JSON.parse(await runPowerShell(`[ScreenModel]::Act([long]1, '1.2', 'invoke', '')`, 20000));
  assert.ok(['NO_WINDOW', 'NOT_FOUND'].includes(act.error), JSON.stringify(act));
});

test('the worker listens for focus changes', { skip: process.platform !== 'win32' }, async () => {
  const { runPowerShell } = await import('./system-tools.js');
  // Registering runs in the background and can take several seconds.
  let changes = -1;
  for (let waited = 0; changes < 0 && waited < 30000; waited += 500) {
    changes = parseInt(await runPowerShell('[ScreenModel]::FocusChanges()', 60000), 10);
    if (changes < 0) await new Promise(r => setTimeout(r, 500));
  }
  const why = await runPowerShell('[ScreenModel]::FocusWatchError', 5000);
  assert.ok(changes >= 0, `the watch is running (got ${changes}${why ? `: ${why}` : ''})`);
  const last = JSON.parse(await runPowerShell('[ScreenModel]::LastFocus()', 20000));
  assert.equal(last.changes >= changes, true);
  assert.equal(typeof last.name, 'string');
});

test('text from speech reaches PowerShell intact and cannot break out of its quotes', { skip: process.platform !== 'win32' }, async () => {
  const { runPowerShell } = await import('./system-tools.js');
  assert.equal(await runPowerShell(`Write-Output 'café — Wanjiku'`, 30000), 'café — Wanjiku');
  // In the ANSI code page, a byte of "В" reads as a closing quote.
  const value = 'xВ) ; Write-Output INJECTED ; #';
  const out = await runPowerShell(`$v = '${value.replace(/'/g, "''")}'; Write-Output $v.Length`, 30000);
  assert.equal(out, String(value.length));
});
