/**
 * Tests for the Office context: which windows count as Office, how a cell or
 * a Word proofing error is described for the AI, and (on Windows) that the
 * UIA3 reader compiles in the worker and answers.
 * Run with: node --test src/office-uia.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { officeKind, describeOfficeContext, proofingSuggestions, readOfficeContext } from './office-uia.js';

test('Office apps are known by their process names', () => {
  assert.equal(officeKind('EXCEL'), 'excel');
  assert.equal(officeKind('WINWORD'), 'word');
  assert.equal(officeKind('POWERPNT'), 'powerpoint');
  assert.equal(officeKind('notepad'), null);
  assert.equal(officeKind(undefined), null);
});

// Shapes as read from Excel 16.0.20326: a table A1:B4 with a header row.
const cell = focus => ({ kind: 'excel', focus: { pid: 1, controlType: 50029, TableFullRowPosition: 0, TableFullColumnPosition: 0, ...focus }, editor: null });

test('an Excel cell is described with its formula, format and table place', () => {
  const text = describeOfficeContext(cell({ name: 'B4', CellFormula: '=SUM(B2:B3)', CellNumberFormat: 'Number', TableFullRowPosition: 3, TableFullColumnPosition: 1 }));
  assert.equal(text, 'Selected cell "B4": formula "=SUM(B2:B3)"; number format "Number"; table row 3 (under the header), column 2.');
});

test('table places count from the header, and a header cell says it is one', () => {
  assert.equal(describeOfficeContext(cell({ name: 'A2', CellNumberFormat: 'General', TableFullRowPosition: 1 })),
    'Selected cell "A2": table row 1 (under the header), column 1.');
  assert.equal(describeOfficeContext(cell({ name: 'A1', controlType: 50035, HasFilterDropdown: true })),
    'Selected cell "A1": has a filter button; header of table column 1.');
});

test('a plain cell outside a table says so, and General format is not worth mentioning', () => {
  assert.equal(describeOfficeContext(cell({ name: 'F8', CellNumberFormat: 'General' })), 'Selected cell "F8": no formula.');
  assert.equal(describeOfficeContext(cell({ name: 'D2', HasDataValidationDropdown: true })), 'Selected cell "D2": has a drop-down list.');
});

test('focus on the ribbon is not described as a cell', () => {
  assert.equal(describeOfficeContext({ kind: 'excel', focus: { pid: 1, name: 'Home', controlType: 50019 }, editor: null }), '');
});

test('nothing is said when the read failed or the app is not Office', () => {
  assert.equal(describeOfficeContext(null), '');
  assert.equal(describeOfficeContext({ kind: 'excel', focus: null, editor: null }), '');
  assert.equal(describeOfficeContext({ kind: 'powerpoint', focus: null, editor: null }), '');
});

test('Word\'s Editor pane gives the error and its suggestions in order', () => {
  const text = describeOfficeContext({
    kind: 'word',
    focus: null,
    editor: {
      ProofingErrorCategory: 'Spelling', ProofingErrorSubcategory: 'Not in Dictionary',
      ProofingDecoratedText: 'provvides', ProofingContextText: 'It provvides help',
      ProofingSuggestionsJson: '{"isContentPending":false,"suggestions":[{"index":0,"suggestedWord":"provides"},{"index":1,"suggestedWord":"provide"}]}',
    },
  });
  assert.equal(text, 'Word\'s Editor pane shows: Spelling, Not in Dictionary on "provvides" in "It provvides help". Suggestions, in order: "provides", "provide".');
});

test('suggestions still being worked out, or unreadable, are none', () => {
  assert.deepEqual(proofingSuggestions('{"isContentPending":true,"suggestions":[{"suggestedWord":"x"}]}'), []);
  assert.deepEqual(proofingSuggestions('not json'), []);
  assert.deepEqual(proofingSuggestions(undefined), []);
});

test('a window that is not Office is not read at all', async () => {
  assert.equal(await readOfficeContext({ process: 'notepad', hwnd: '1' }), null);
  assert.equal(await readOfficeContext(null), null);
});

after(async () => {
  if (process.platform === 'win32') (await import('./system-tools.js')).stopSystemTools();
});

test('the UIA3 reader compiles and answers for a window that does not exist', { skip: process.platform !== 'win32' }, async () => {
  const { runPowerShell } = await import('./system-tools.js');
  assert.equal(await runPowerShell(`if ('OfficeUia' -as [type]) { 'READY' } else { 'MISSING' }`, 60000), 'READY');
  const spec = `[string[]]@('CellFormula|{E244641A-2785-41E9-A4A7-5BE5FE531507}|3')`;
  const focused = JSON.parse(await runPowerShell(`[OfficeUia]::ReadFocused([long]1, ${spec})`, 20000));
  assert.ok(focused.error, 'focus is never in a window that does not exist: ' + JSON.stringify(focused));
  const node = JSON.parse(await runPowerShell(`[OfficeUia]::ReadNode([long]1, 'DrillInPane_EditorCustomProps', ${spec})`, 20000));
  assert.ok(node.error, JSON.stringify(node));
});

test('fixing a spelling asks Word for the mistake at the cursor or the word named', async () => {
  const { fixSpellingScript } = await import('./office-uia.js');
  const first = fixSpellingScript();
  assert.match(first, /\$choice = 1\b/);
  assert.match(first, /\$want = ''/);
  assert.match(fixSpellingScript({ choice: 0 }), /\$choice = 0\b/, '0 only lists the suggestions');
  assert.match(fixSpellingScript({ choice: 99 }), /\$choice = 9\b/, 'a silly number is kept in range');
  // A word with a quote cannot break out of the PowerShell string
  assert.match(fixSpellingScript({ word: "Wanjiku's'; Remove-Item x" }), /\$want = 'Wanjiku''s''; Remove-Item x'/);
});
