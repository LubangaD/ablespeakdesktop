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
  'scroll_into_view', 'scroll_up', 'scroll_down', 'scroll_left', 'scroll_right', 'read_text',
]);

let cache = null; // { hwnd, title, at, model }

export function invalidateScreenModel() {
  cache = null;
}

const isOwnWindow = w => /^AbleSpeak/i.test(w.title || '');

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
  const reuse = !fresh && cache && cache.hwnd === win.hwnd && cache.title === win.title
    && Date.now() - cache.at < CACHE_MS && cache.model.elements.length >= Math.min(maxElements, cache.model.total);
  if (reuse) return cache.model;

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
    return { status: 'error', code: 'MINIMIZED', message: `"${win.title}" is minimized. Bring it to the front first.` };
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
  cache = { hwnd: win.hwnd, title: win.title, at: Date.now(), model };
  return model;
}

const BROWSERS = new Set(['chrome', 'msedge', 'brave', 'firefox', 'opera']);

/**
 * The controls of the window the student is using, for the AI's prompt
 * (Stage 3 step 3). Browsers are skipped while the Chrome extension reads the
 * page itself. Never waits long: a slow read is dropped, not waited for.
 */
export async function screenContextForAgent({ extensionConnected = false, limit = 60, timeoutMs = 1500 } = {}) {
  const read = (async () => {
    const win = await resolveTargetWindow();
    if (!win) return null;
    if (extensionConnected && BROWSERS.has(String(win.process).toLowerCase())) return null;
    const model = await getScreenModel({ target: win, maxElements: 150 });
    if (model.status !== 'success' || !model.elements.length) return null;
    // Excel and Word also say what is in the cell or word the student is on.
    const office = describeOfficeContext(await readOfficeContext(win).catch(() => null));
    return {
      window: model.window,
      app: model.app,
      total: model.total,
      truncated: model.total > limit,
      summary: describeElements(model, limit),
      ...(office ? { office } : {}),
    };
  })().catch(() => null);
  const late = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
  return Promise.race([read, late]);
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
    ].filter(Boolean).join(', ');
    const actions = e.actions.length ? ` [${e.actions.join(', ')}]` : '';
    return `${e.ref} ${e.type} "${e.name}"${actions}${state ? ` (${state})` : ''}`;
  }).join('\n');
}

const normalise = text => String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The control a spoken name most likely means. Exact names beat prefixes,
 * prefixes beat partial matches; enabled controls with actions come first.
 */
export function findElement(model, name, { type } = {}) {
  const wanted = normalise(name);
  if (!wanted) return null;
  const words = wanted.split(' ');
  const candidates = model.elements.filter(e => !type || e.type.toLowerCase() === String(type).toLowerCase());
  const score = e => {
    const label = normalise(e.name);
    if (!label) return 0;
    let points = 0;
    if (label === wanted) points = 100;
    else if (label.startsWith(wanted)) points = 70;
    else if (label.includes(wanted)) points = 50;
    else if (words.every(word => label.includes(word))) points = 30;
    else return 0;
    if (e.actions.length) points += 10;
    if (e.enabled !== false) points += 5;
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
    : findElement(model, name, { type });
  if (!element) {
    record({ app: model.app, method: 'not_found', action, started, studentId });
    return {
      status: 'error',
      message: `I couldn't find "${name || ref}" in ${model.window}.`,
      notFound: true,
    };
  }

  const chosen = action || defaultAction(element);
  if (!ACTIONS.has(chosen)) return { status: 'error', message: `Unknown action "${chosen}"` };
  if (!REF_RE.test(element.ref)) return { status: 'error', message: 'That control cannot be reached' };

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
    message: describeDone(chosen, element, value),
    action: chosen,
    element: { ref: element.ref, type: element.type, name: element.name },
    window: model.window,
    ...(result.text !== undefined ? { text: result.text } : {}),
  };
}

function describeDone(action, element, value) {
  const label = element.name || element.type;
  switch (action) {
    case 'invoke': return `Pressed "${label}"`;
    case 'toggle': return `Switched "${label}"`;
    case 'select': return `Selected "${label}"`;
    case 'expand': return `Opened "${label}"`;
    case 'collapse': return `Closed "${label}"`;
    case 'set_value': return `Typed "${String(value ?? '').slice(0, 60)}" into "${label}"`;
    case 'focus': return `Moved to "${label}"`;
    case 'read_text': return `Read "${label}"`;
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
