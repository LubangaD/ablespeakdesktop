/**
 * Screen model (Stage 2): what is in the window the student is using, read
 * from Windows UI Automation rather than pixels.
 *
 * Each read lists the window's controls with a `ref`, their type, name,
 * position, state and the actions they support. Reads are cached briefly
 * and dropped when the window changes or after any action, so the agent
 * never acts on a stale picture of the screen.
 */
import { runPowerShell, listVisibleWindows } from './system-tools.js';
import { pickWindow } from './app-names.js';
import { logResolution } from './db.js';
import { readOfficeContext, describeOfficeContext } from './office-uia.js';

const CACHE_MS = 4000;
const REF_RE = /^-?\d+(\.-?\d+)*$/;
const ACTIONS = new Set([
  'invoke', 'toggle', 'select', 'expand', 'collapse', 'set_value', 'focus',
  'scroll_into_view', 'scroll_up', 'scroll_down', 'scroll_left', 'scroll_right', 'read_text', 'set_range',
]);

// How much of a document read_text reads: the value given with it.
export const TEXT_SCOPES = new Set(['all', 'selection', 'word', 'line', 'paragraph', 'page']);

let cache = null; // { hwnd, title, at, model }

export function invalidateScreenModel() {
  cache = null;
}

// "AbleSpeak", "AbleSpeak Overlay" and "AbleSpeak — …" only, as in
// system-tools.js: a tab or document that merely starts with "AbleSpeak" is
// the student's window
const isOwnWindow = w => /^AbleSpeak(?:$| Overlay$| [-—–] )/.test(String(w.title || '').trim());

/**
 * The window to read: the named app's, or else the front-most window that
 * isn't AbleSpeak's own overlay or dashboard.
 */
export async function resolveTargetWindow(app) {
  const windows = await listVisibleWindows();
  if (app) return pickWindow(windows, app);
  return windows.find(w => !isOwnWindow(w) && w.title !== 'Program Manager') || null;
}

/**
 * Read a window's controls. Returns
 * { status, app, window, elements, total, actionable, truncated, ms } or
 * { status: 'error', message }.
 */
export async function getScreenModel({ app, fresh = false, maxElements = 150, target = null, restore = false } = {}) {
  const win = target || await resolveTargetWindow(app);
  if (!win) {
    return { status: 'error', message: app ? `I couldn't find an open window for "${app}".` : 'There is no window to read.' };
  }
  // Within the time limit, a read is reused only if focus has not moved
  // since (one cheap call instead of reading the whole window again).
  if (!fresh && isCacheFresh(cache, win, { maxElements })) {
    const changes = await focusChanges();
    if (isCacheFresh(cache, win, { maxElements, focusChanges: changes })) return cache.model;
  }

  const started = Date.now();
  const limit = Math.max(1, Math.min(400, Math.floor(maxElements)));
  const snapshot = `[ScreenModel]::Snapshot([long]${Number(win.hwnd)}, ${limit})`;
  // A minimized window exposes almost nothing; bring it back first if asked.
  const script = restore
    ? `if ([Win32Input]::IsIconic([IntPtr]${Number(win.hwnd)})) { [Win32Input]::ForceFocus([IntPtr]${Number(win.hwnd)}) | Out-Null; Start-Sleep -Milliseconds 400 }
${snapshot}`
    : snapshot;
  const raw = await runPowerShell(script, 20000);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'error', message: `Could not read "${win.title}": ${String(raw).slice(0, 160)}` };
  }
  if (parsed.error === 'MINIMIZED') {
    // Which window, so the dashboard can show it on the taskbar
    return { status: 'error', code: 'MINIMIZED', window: win.title, app: win.process, message: `"${win.title}" is minimized. Bring it to the front first.` };
  }
  if (parsed.error) {
    return { status: 'error', message: `Could not read "${win.title}": ${parsed.message || parsed.error}` };
  }

  const model = {
    status: 'success',
    app: win.process,
    hwnd: win.hwnd,
    window: parsed.window.name || win.title,
    rect: parsed.window.rect,
    elements: parsed.elements,
    total: parsed.total,
    actionable: parsed.actionable,
    truncated: parsed.truncated,
    readMs: parsed.readMs,
    ms: Date.now() - started,
  };
  cache = { hwnd: win.hwnd, title: win.title, at: Date.now(), focusChanges: parsed.focusChanges ?? -1, model };
  return model;
}

/**
 * Whether a cached read still describes the window: the same window, read
 * recently, with enough controls, and (when the worker is watching focus,
 * so focusChanges >= 0) keyboard focus has not moved since. Focus can only
 * make a read stale early, never keep one longer: typing changes a field
 * without moving focus.
 */
export function isCacheFresh(cached, win, { maxElements = 150, focusChanges = undefined, now = Date.now() } = {}) {
  if (!cached || cached.hwnd !== win.hwnd || cached.title !== win.title) return false;
  if (now - cached.at >= CACHE_MS) return false;
  if (cached.model.elements.length < Math.min(maxElements, cached.model.total)) return false;
  if (focusChanges === undefined) return true; // not asked yet
  if (focusChanges < 0 || cached.focusChanges < 0) return true; // no watch: timing only
  return focusChanges === cached.focusChanges;
}

/** How often focus has moved, from the worker's watch; -1 if unknown. */
async function focusChanges() {
  try {
    const n = parseInt(await runPowerShell('[ScreenModel]::FocusChanges()', 3000), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

const BROWSERS = new Set(['chrome', 'msedge', 'brave', 'firefox', 'opera']);

/**
 * The controls of the window the student is using, for the AI's prompt
 * (Stage 3 step 3). Browsers are skipped while the Chrome extension reads the
 * page itself. Never waits long: a slow read is dropped, not waited for.
 */
export async function screenContextForAgent({ extensionConnected = false, limit = 60, timeoutMs = 1500 } = {}) {
  const started = Date.now();
  let win;
  try { win = await resolveTargetWindow(); } catch { return null; }
  if (!win) return null;
  if (extensionConnected && BROWSERS.has(String(win.process).toLowerCase())) return null;
  // Which app is in front is always worth saying, even when its controls
  // take too long to read: without it the AI assumes the browser.
  const inFront = { window: win.title, app: win.process, summary: null };
  const read = (async () => {
    const model = await getScreenModel({ target: win, maxElements: 150 });
    if (model.status !== 'success' || !model.elements.length) return null;
    // Excel and Word also say what is in the cell or word the student is on.
    const office = describeOfficeContext(await readOfficeContext(win).catch(() => null));
    // Notepad: its whole text, so the AI can read it out and edit it (document-text.js)
    const { isTextApp, readDocumentText, MAX_DOCUMENT_CHARS } = await import('./document-text.js');
    const doc = isTextApp(model.app) ? await readDocumentText().catch(() => null) : null;
    return {
      window: model.window,
      app: model.app,
      total: model.total,
      truncated: model.total > limit,
      summary: describeElements(model, limit),
      ...(office ? { office } : {}),
      ...(doc ? { document: { text: doc.text.slice(0, MAX_DOCUMENT_CHARS), chars: doc.text.length } } : {}),
    };
  })().catch(() => null);
  const left = Math.max(0, timeoutMs - (Date.now() - started));
  const late = new Promise(resolve => setTimeout(() => resolve(null), left));
  return (await Promise.race([read, late])) || inFront;
}

/** One line per control, for the model's prompt. */
export function describeElements(model, limit = 60) {
  return model.elements.slice(0, limit).map(e => {
    const state = [
      e.enabled === false ? 'disabled' : '',
      e.focused ? 'focused' : '',
      e.toggled ? `toggle ${e.toggled}` : '',
      e.expanded ? e.expanded : '',
      e.selected ? 'selected' : '',
      e.value ? `value "${e.value.slice(0, 40)}"` : '',
      e.range ? `position ${e.range[0]} of ${e.range[1]}–${e.range[2]}` : '',
    ].filter(Boolean).join(', ');
    const actions = e.actions.length ? ` [${e.actions.join(', ')}]` : '';
    return `${e.ref} ${e.type} "${e.name}"${actions}${state ? ` (${state})` : ''}`;
  }).join('\n');
}

const normalise = text => String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The one element whose name is exactly the spoken name (case and punctuation
 * aside), or null when none or several are: certain enough to act on without
 * asking the AI. `nameOf` reads the name (a web page's elements call it label).
 */
export function uniqueByName(elements, name, nameOf = e => e.name) {
  const wanted = normalise(name);
  if (!wanted) return null;
  const hits = (elements || []).filter(e => normalise(nameOf(e)) === wanted);
  return hits.length === 1 ? hits[0] : null;
}

// The spoken words begin the name, as whole words or with a plural ending:
// "send" → "Send now", "download" → "Downloads"; not "add" → "Address bar"
const startsWithWords = (label, wanted) => label.startsWith(wanted) && /^(?:s|es)?(?: |$)/.test(label.slice(wanted.length));

// A digit and its name are the same control: Calculator's keys are "Seven",
// "Zero", and "press 7" found nothing (agent eval, 23 Oct 2026)
const DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const sameName = (label, wanted) => label === wanted || (/^\d$/.test(wanted) && label === DIGIT_NAMES[wanted]);

/**
 * How well a control's name matches the spoken one: 'exact', 'prefix' (it
 * begins with the spoken words), 'partial' (the words are only somewhere
 * inside it: "add" → "Memory add") or null.
 */
export function nameMatch(controlName, spoken) {
  const label = normalise(controlName);
  const wanted = normalise(spoken);
  if (!label || !wanted) return null;
  if (sameName(label, wanted)) return 'exact';
  if (startsWithWords(label, wanted)) return 'prefix';
  if (label.includes(wanted) || wanted.split(' ').every(word => label.includes(word))) return 'partial';
  return null;
}

// Which kinds of control suit an action: a Save As dialog has a Text label,
// a ComboBox and an Edit all called "File name:", and typing went to the
// label (agent eval, 24 Oct 2026). Typing wants the field; pressing wants
// the button; a label is never the one meant.
const SUITS = {
  set_value: { Edit: 15, Document: 12, ComboBox: 10, Text: -20 },
  read_text: { Document: 15, Edit: 12, Text: 5 },
  invoke: { Button: 10, MenuItem: 10, ListItem: 8, TreeItem: 8, Hyperlink: 8, SplitButton: 8, TabItem: 6, Text: -10 },
  toggle: { CheckBox: 15, Button: 8, Text: -10 },
  select: { ListItem: 12, TabItem: 12, TreeItem: 12, RadioButton: 12, Text: -10 },
  expand: { MenuItem: 10, TreeItem: 10, ComboBox: 10, Button: 5, Text: -10 },
};
SUITS.collapse = SUITS.expand;
SUITS.focus = SUITS.set_value; // "focus the File name box": the field, not its label

/**
 * The control a spoken name most likely means. Exact names beat prefixes,
 * prefixes beat whole words inside the name, which beat parts of words;
 * enabled controls with actions come first, and the kind of control that
 * suits the `action` (typing wants a field, not its label) beats the rest.
 */
export function findElement(model, name, { type, action } = {}) {
  const wanted = normalise(name);
  if (!wanted) return null;
  const words = wanted.split(' ');
  const candidates = model.elements.filter(e => !type || e.type.toLowerCase() === String(type).toLowerCase());
  const suits = SUITS[action] || {};
  const score = e => {
    const label = normalise(e.name);
    if (!label) return 0;
    let points = 0;
    if (sameName(label, wanted)) points = 100;
    else if (startsWithWords(label, wanted)) points = 70;
    else if (` ${label} `.includes(` ${wanted} `)) points = 50;
    else if (label.includes(wanted)) points = 35;
    else if (words.every(word => label.includes(word))) points = 30;
    else return 0;
    if (e.actions.length) points += 10;
    if (e.enabled !== false) points += 5;
    points += suits[e.type] || 0;
    return points - Math.min(label.length - wanted.length, 20) * 0.1;
  };
  let best = null;
  let bestScore = 0;
  for (const e of candidates) {
    const s = score(e);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}

/**
 * The text the student means by "read this": the focused control that can be
 * read, else the window's document, else its first readable field.
 */
export function findDocument(model) {
  const readable = model.elements.filter(e => e.actions.includes('read_text'));
  return readable.find(e => e.focused)
    || readable.find(e => e.type === 'Document')
    || readable.find(e => e.type === 'Edit')
    || null;
}

// Ways of pressing a control, and actions that only look at it or move to it
const PRESS_ACTIONS = new Set(['invoke', 'toggle', 'select', 'expand', 'collapse']);
const LOOK_ACTIONS = new Set(['read_text', 'focus', 'scroll_into_view']);
const supports = (element, action) => element.actions.includes(action === 'expand' || action === 'collapse' ? 'expand_collapse' : action);

/**
 * What to do with a control found for a request: { action } to carry out,
 * or { closest } when it was found only by part of its name and is not to
 * be acted on.
 *  - Calculator's "Memory add" was pressed for "Add" (agent eval, 23 Oct
 *    2026): a name found only inside another is not acted on, and the AI is
 *    told the closest name, to ask again with it if it is the one.
 *  - A control asked to be pressed in a way it doesn't take ("select" on a
 *    Settings link that only invokes, and the other way round) is pressed
 *    the way it does.
 */
export function planAction(element, { ref, name, action } = {}) {
  const wanted = action || defaultAction(element);
  if (!ref && name && !LOOK_ACTIONS.has(wanted) && nameMatch(element.name, name) === 'partial') return { closest: element.name };
  if (PRESS_ACTIONS.has(wanted) && !supports(element, wanted) && PRESS_ACTIONS.has(defaultAction(element))) return { action: defaultAction(element) };
  return { action: wanted };
}

/** What "press it" means for this control. */
export function defaultAction(element) {
  const has = a => element.actions.includes(a);
  if (has('invoke')) return 'invoke';
  if (has('toggle')) return 'toggle';
  if (has('select')) return 'select';
  if (has('expand_collapse')) return element.expanded === 'expanded' ? 'collapse' : 'expand';
  return 'focus';
}

const psQuote = value => `'${String(value ?? '').replace(/'/g, "''")}'`;

/**
 * Act on a control through its accessibility pattern.
 * Find it by `ref` (from a read) or by `name`. Returns { status, message, ... }.
 */
export async function actOnElement({ app, ref, name, type, action, value, studentId = null, log = true } = {}) {
  const started = Date.now();
  const record = log ? recordResolution : () => {};
  // As many controls as uia_query lists, so any ref it gave can be found.
  const model = await getScreenModel({ app, restore: true, maxElements: 400 });
  if (model.status !== 'success') return model;

  const element = ref
    ? model.elements.find(e => e.ref === ref)
    : name ? findElement(model, name, { type, action })
    : action === 'read_text' ? findDocument(model)
    : null;
  if (!element) {
    record({ app: model.app, method: 'not_found', action, started, studentId });
    return {
      status: 'error',
      message: name || ref
        ? `I couldn't find "${name || ref}" in ${model.window}.`
        : `There is no document to read in ${model.window}.`,
      notFound: true,
    };
  }

  const plan = planAction(element, { ref, name, action });
  if (plan.closest) {
    record({ app: model.app, method: 'not_found', action, started, studentId });
    return {
      status: 'error',
      message: `Nothing in ${model.window} is called "${name}". The closest is "${plan.closest}": if that is the one, ask for it by that name.`,
      notFound: true,
      closest: plan.closest,
    };
  }
  const chosen = plan.action;
  if (!ACTIONS.has(chosen)) return { status: 'error', message: `Unknown action "${chosen}"` };
  if (!REF_RE.test(element.ref)) return { status: 'error', message: 'That control cannot be reached' };

  if (chosen === 'set_range' && !Number.isFinite(Number(value))) {
    return { status: 'error', message: 'Give the number to set it to, as value.' };
  }
  if (chosen === 'read_text' && value && !TEXT_SCOPES.has(value)) {
    return { status: 'error', message: `read_text reads ${[...TEXT_SCOPES].join(', ')}.` };
  }

  const raw = await runPowerShell(
    `[ScreenModel]::Act([long]${Number(model.hwnd)}, ${psQuote(element.ref)}, ${psQuote(chosen)}, ${psQuote(value)})`,
    10000,
  );
  invalidateScreenModel();

  let result;
  try { result = JSON.parse(raw); } catch { result = { error: 'FAILED', message: String(raw).slice(0, 160) }; }
  if (result.error) {
    record({ app: model.app, method: 'uia', action: chosen, started, studentId, found: true, ok: false });
    return {
      status: 'error',
      message: result.message || result.error,
      code: result.error,
      element,
      window: model.window,
    };
  }

  record({ app: model.app, method: 'uia', action: chosen, started, studentId, found: true, ok: true });
  return {
    status: 'success',
    // A slider stops at its ends, so say where it actually went.
    message: describeDone(chosen, element, result.value !== undefined ? result.value : value, result.shown),
    action: chosen,
    element: { ref: element.ref, type: element.type, name: element.name },
    window: model.window,
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.scope !== undefined ? { scope: result.scope } : {}),
    ...(result.value !== undefined ? { value: result.value, min: result.min, max: result.max } : {}),
    ...(result.shown !== undefined ? { shown: result.shown } : {}),
  };
}

function describeDone(action, element, value, shown) {
  const label = element.name || element.type;
  switch (action) {
    case 'invoke': return `Pressed "${label}"`;
    case 'toggle': return `Switched "${label}"`;
    case 'select': return `Selected "${label}"`;
    case 'expand': return `Opened "${label}"`;
    case 'collapse': return `Closed "${label}"`;
    case 'set_value': return `Typed "${String(value ?? '').slice(0, 60)}" into "${label}"`;
    case 'focus': return `Moved to "${label}"`;
    case 'read_text': return value && value !== 'all' ? `Read the ${value} in "${label}"` : `Read "${label}"`;
    case 'set_range': return `Moved "${label}" to position ${value}${shown ? `; it now shows "${shown}"` : ''}`;
    default: return `${action.replace(/_/g, ' ')} on "${label}"`;
  }
}

/** Log how a target was found, for the UIA resolution rate (Stage 2). */
export function recordResolution({ app, method, action, started, studentId, found = method !== 'not_found', ok = null }) {
  try {
    logResolution({
      app: String(app || 'unknown').toLowerCase(),
      method,
      action: action || null,
      found,
      ok,
      ms: Date.now() - started,
      student_id: studentId,
    });
  } catch {
    // The database may not be open (tests, scripts); the action still counts.
  }
}
