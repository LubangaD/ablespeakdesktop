/**
 * Office context: what Excel and Word tell assistive technology about the
 * cell or word the student is on, through their custom UI Automation
 * properties (https://learn.microsoft.com/en-us/office/uia/). The screen
 * model sees a cell as "B2"; this adds its formula, number format, drop-down
 * and table position, and Word's Editor pane adds the spelling error and its
 * suggestions, so "what's the formula here" and "fix that spelling" can be
 * answered.
 *
 * The C# half (uia/office-uia-cs.js) is compiled into the PowerShell worker.
 */
import { runPowerShell } from './system-tools.js';

const INT = 1, BOOL = 2, STRING = 3;

// name, GUID and type of each property, from Microsoft's reference pages.
const EXCEL_PROPS = [
  ['CellFormula', 'E244641A-2785-41E9-A4A7-5BE5FE531507', STRING],
  ['CellNumberFormat', '626CF4A0-A5AE-448B-A157-5EA4D1D057D7', STRING],
  ['DataValidationPrompt', '7AAEE221-E14D-4DA4-83FE-842AAF06A9B7', STRING],
  ['HasDataValidationDropdown', '1B93A5CD-0956-46ED-9BBF-016C1B9FD75F', BOOL],
  ['HasFilterDropdown', '0097284B-3573-4AAB-8E22-6092B87F8FDD', BOOL],
  // Counted from 0 with the header as row 0. A cell outside any table also
  // reads 0, 0, so only a header cell or a row above 0 is inside one.
  // (The matching row and column counts are 0 on cells, so are not read.)
  ['TableFullRowPosition', '0E4B8FA7-2C81-4DF8-A390-935633EE10E5', INT],
  ['TableFullColumnPosition', '81FB2803-ECA3-470A-B636-F2DCC46B9361', INT],
  ['SpilledFromAnchor', 'D02E2EF6-2D91-420A-BBFC-6C34295883ED', STRING],
];

// UIA control types of a focused worksheet cell (checked on build 16.0.20326).
const DATA_ITEM = 50029, HEADER_ITEM = 50035;

const WORD_FOCUS_PROPS = [
  ['MathML', 'FA170AB3-3229-4E7C-827F-DD05EE0481D9', STRING],
];

// All on the Editor pane's node with this AutomationId, only while the pane
// is showing an error.
const WORD_EDITOR_NODE = 'DrillInPane_EditorCustomProps';
const WORD_EDITOR_PROPS = [
  ['ProofingErrorCategory', '8F6DE213-292A-413F-8366-2D09A8968B7E', STRING],
  ['ProofingErrorSubcategory', '931DDE14-CCE2-417B-AF8D-9BD1932E1D80', STRING],
  ['ProofingDecoratedText', 'D841CB98-D0CD-4C78-8BCC-8584EADE5E5C', STRING],
  ['ProofingContextText', 'FBB41D65-64DB-4946-A627-E9BB1E4EFBF7', STRING],
  ['ProofingSuggestionsJson', '50D64A2B-1327-40A7-9950-9FB6670DBB98', STRING],
];

const KINDS = { excel: 'excel', winword: 'word', powerpnt: 'powerpoint' };

/** 'excel', 'word' or 'powerpoint' for an Office process name, else null. */
export function officeKind(processName) {
  return KINDS[String(processName || '').toLowerCase()] || null;
}

const specs = props => `@(${props.map(([name, guid, type]) => `'${name}|{${guid}}|${type}'`).join(', ')})`;

async function read(call) {
  const raw = await runPowerShell(
    `if (-not ('OfficeUia' -as [type])) { Write-Output '{"error":"not compiled"}'; return }\n${call}`,
    8000,
  );
  try {
    const parsed = JSON.parse(raw);
    return parsed.error ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * The Office properties for a window from resolveTargetWindow: the focused
 * cell for Excel; the focused element and the Editor pane for Word. Returns
 * { kind, focus, editor } (either part may be null), or null when the window
 * is not an Office app.
 */
export async function readOfficeContext(win) {
  const kind = officeKind(win?.process);
  if (!kind) return null;
  const hwnd = Number(win.hwnd);
  if (kind === 'excel') {
    return { kind, focus: await read(`[OfficeUia]::ReadFocused([long]${hwnd}, [string[]]${specs(EXCEL_PROPS)})`), editor: null };
  }
  if (kind === 'word') {
    const focus = await read(`[OfficeUia]::ReadFocused([long]${hwnd}, [string[]]${specs(WORD_FOCUS_PROPS)})`);
    const editor = await read(`[OfficeUia]::ReadNode([long]${hwnd}, '${WORD_EDITOR_NODE}', [string[]]${specs(WORD_EDITOR_PROPS)})`);
    return { kind, focus, editor };
  }
  return { kind, focus: null, editor: null };
}

const quote = (text, max = 80) => {
  const s = String(text);
  return `"${s.length > max ? s.slice(0, max) + '…' : s}"`;
};

/** Word's suggestions as plain words, or [] while it is still working them out. */
export function proofingSuggestions(json) {
  try {
    const parsed = JSON.parse(json);
    if (parsed.isContentPending) return [];
    return (parsed.suggestions || []).map(s => s.suggestedWord).filter(Boolean);
  } catch {
    return [];
  }
}

/** One or two lines for the AI's prompt, or '' when there is nothing to add. */
export function describeOfficeContext(ctx) {
  if (!ctx) return '';
  const lines = [];
  const f = ctx.focus;
  // Focus on the ribbon or a dialog is not a cell.
  if (ctx.kind === 'excel' && (f?.controlType === DATA_ITEM || f?.controlType === HEADER_ITEM)) {
    const facts = [];
    if (f.CellFormula) facts.push(`formula ${quote(f.CellFormula)}`);
    if (f.CellNumberFormat && f.CellNumberFormat !== 'General') facts.push(`number format ${quote(f.CellNumberFormat, 40)}`);
    if (f.SpilledFromAnchor) facts.push(`spilled from ${f.SpilledFromAnchor}`);
    if (f.HasDataValidationDropdown) facts.push('has a drop-down list');
    if (f.DataValidationPrompt) facts.push(`input hint ${quote(f.DataValidationPrompt)}`);
    if (f.HasFilterDropdown) facts.push('has a filter button');
    const column = (f.TableFullColumnPosition || 0) + 1;
    if (f.controlType === HEADER_ITEM) facts.push(`header of table column ${column}`);
    else if (f.TableFullRowPosition > 0) facts.push(`table row ${f.TableFullRowPosition} (under the header), column ${column}`);
    const cell = f.name ? `Selected cell ${quote(f.name, 60)}` : 'Selected cell';
    lines.push(facts.length ? `${cell}: ${facts.join('; ')}.` : `${cell}: no formula.`);
  }
  if (ctx.kind === 'word' && f?.MathML) {
    lines.push(`The student is on an equation (MathML): ${quote(f.MathML, 300)}`);
  }
  const e = ctx.editor;
  if (ctx.kind === 'word' && e?.ProofingDecoratedText) {
    const category = [e.ProofingErrorCategory, e.ProofingErrorSubcategory].filter(Boolean).join(', ') || 'Error';
    const suggestions = proofingSuggestions(e.ProofingSuggestionsJson);
    lines.push(`Word's Editor pane shows: ${category} on ${quote(e.ProofingDecoratedText, 60)}`
      + (e.ProofingContextText ? ` in ${quote(e.ProofingContextText, 120)}` : '')
      + (suggestions.length ? `. Suggestions, in order: ${suggestions.slice(0, 5).map(s => quote(s, 40)).join(', ')}.` : '.'));
  }
  return lines.join('\n');
}
