/**
 * AI interaction agent (Stage 3): plan → act → check → recover.
 *
 * "Open my email and find the message from John" becomes a short plan. Each
 * step is one tool call chosen against the current screen. After acting, the
 * agent reads the screen again and checks it changed as planned — the
 * student cannot look over and check, so a silent failure is the worst
 * outcome. A failed check re-plans (at most twice); after that the agent
 * undoes any typing it did, stops, and says what happened.
 *
 * Every tool call still goes through the tool registry, so irreversible
 * actions keep asking the student first; the task pauses there and resumes
 * after "yes".
 */
import { toolFailed } from './tool-outcome.js';
import { classifyPlan } from './safety.js';
import { screenFingerprint } from './screen-change.js';
import { isBrowserTool } from './fast-commands.js';

export const MAX_STEPS = 8;          // steps in a plan the model makes
export const MAX_ROUTINE_STEPS = 10; // steps in a student's routine (student-profile.js)
export const MAX_REPLANS = 2;

// How long an unchanged screen is watched after an action before the step is
// checked. Opening or switching an app takes a second or more; on 23 Oct 2026
// the agent read the screen at once, judged "Notepad did not open" and
// re-planned from there (agent-eval baseline). ARTEMIS waits 400 ms after
// every action and polls for what it expects.
export const SETTLE_POLL_MS = 400;
// 4 s for anything else: a Save As dialog took longer than the 1.2 s, then
// the 2.5 s, this was, and the step was judged "nothing changed" (24 Oct
// 2026). The wait only runs while nothing has changed yet, so steps that
// work are not slowed; a step that truly changes nothing is judged 4 s later.
const SETTLE_MS = { slow: 6000, normal: 4000 };
const SLOW_TOOLS = new Set(['open_application', 'focus_application', 'close_application', 'open_url', 'create_tab', 'navigate', 'search_web', 'search_youtube']);

// The Chrome extension's tools act on its own browser. Those that act on the
// web page in front only make sense when that browser is in front: on
// 23 Oct 2026 "press Enter" in Notepad and in Edge went to Chrome and got no
// answer. Opening a website (open_url, search_web) works from anywhere.
const BROWSERS = new Set(['chrome', 'msedge', 'brave', 'firefox', 'opera', 'vivaldi']);
const PAGE_TOOLS = new Set([
  'press_key_combination', 'type_text', 'click_element', 'right_click', 'select_option', 'clear_field',
  'scroll', 'scroll_to_top', 'scroll_to_bottom', 'scroll_element', 'focus_next', 'focus_prev',
  'search_in_page', 'get_page_content', 'get_page_state', 'media_control', 'zoom_tab', 'execute_javascript',
]);
const DESKTOP_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete']);

/**
 * A Save As / Open / folder dialog is in front. Words like "open Documents"
 * mean a folder inside it, not the Documents window: the quick "open an app"
 * match must not run there (it opened File Explorer over a Save As dialog,
 * 24 Oct 2026).
 */
export function isFileDialog(screen) {
  if (!screen) return false;
  if (/^(?:save as|save|open|browse for folder|select folder|select file|choose file)$/i.test(String(screen.window || '').trim())) return true;
  return (screen.elements || []).some(e => /^(?:Edit|ComboBox)$/.test(e.type) && /^file ?name:?$/i.test(String(e.name || '').trim()));
}

/** A quick command meant for a web page, as the same thing for the window in front ("scroll down" in Notepad). */
function forWindow(quick) {
  if (quick.tool === 'scroll' && ['up', 'down'].includes(quick.args?.direction)) return { tool: 'desktop_scroll', args: { direction: quick.args.direction } };
  if (quick.tool === 'press_key_combination' && DESKTOP_KEYS.has(quick.args?.key) && Object.keys(quick.args).length === 1) return { tool: 'send_system_keys', args: { keys: quick.args.key } };
  return null;
}

const ACTION_VERBS = /\b(open|find|search|look up|click|press|type|write|send|reply|go to|play|close|save|read|select|choose|scroll|create|make|delete|copy|paste|check|show|switch to|start|download|print|attach|email)\b/g;
const CONNECTOR = /\b(and then|then|after that|and|next|followed by)\b|,/;

/**
 * Does this instruction need a plan (several actions), rather than one
 * tool call? "Open my email and find the message from John" does; "scroll
 * down" and "what time is it" do not.
 */
export function needsPlan(text) {
  const said = String(text || '').toLowerCase();
  const verbs = said.match(ACTION_VERBS) || [];
  return new Set(verbs).size >= 2 && CONNECTOR.test(said) && said.split(/\s+/).length >= 5;
}

/** The first JSON object in a model reply (tolerates code fences and prose). */
export function parseJsonReply(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanSteps(steps, limit) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map(step => ({ do: String(step?.do || '').trim().slice(0, 200), expect: String(step?.expect || '').trim().slice(0, 200) }))
    .filter(step => step.do)
    .slice(0, limit);
}

const elementKey = e => `${e.type} "${e.name}"`;

/** What changed on screen between two reads, in words for the checker. */
export function diffScreens(before, after) {
  if (!before || !after) return 'The screen could not be read, so nothing can be compared.';
  const lines = [];
  if (before.window !== after.window) lines.push(`The window changed from "${before.window}" to "${after.window}".`);

  const beforeByKey = new Map(before.elements.map(e => [elementKey(e), e]));
  const afterByKey = new Map(after.elements.map(e => [elementKey(e), e]));
  const added = [...afterByKey.keys()].filter(k => !beforeByKey.has(k));
  const removed = [...beforeByKey.keys()].filter(k => !afterByKey.has(k));
  if (added.length) lines.push(`Appeared: ${added.slice(0, 12).join(', ')}${added.length > 12 ? ` and ${added.length - 12} more` : ''}.`);
  if (removed.length) lines.push(`Gone: ${removed.slice(0, 12).join(', ')}${removed.length > 12 ? ` and ${removed.length - 12} more` : ''}.`);

  const changed = [];
  for (const [key, now] of afterByKey) {
    const was = beforeByKey.get(key);
    if (!was) continue;
    for (const field of ['value', 'toggled', 'expanded', 'selected']) {
      if ((was[field] ?? null) !== (now[field] ?? null)) {
        changed.push(`${key} ${field}: ${JSON.stringify(was[field] ?? null)} → ${JSON.stringify(now[field] ?? null)}`);
      }
    }
  }
  if (changed.length) lines.push(`Changed: ${changed.slice(0, 8).join('; ')}.`);

  const focusBefore = before.elements.find(e => e.focused);
  const focusAfter = after.elements.find(e => e.focused);
  if (focusAfter && (!focusBefore || elementKey(focusBefore) !== elementKey(focusAfter))) {
    lines.push(`Focus is now on ${elementKey(focusAfter)}.`);
  }
  return lines.length ? lines.join('\n') : 'Nothing visible changed.';
}

function describeScreen(screen) {
  if (!screen) return 'The screen could not be read.';
  const controls = screen.elements.slice(0, 50).map(e => {
    const state = [e.focused ? 'focused' : '', e.value ? `value "${String(e.value).slice(0, 30)}"` : '', e.toggled ? `toggle ${e.toggled}` : '', e.expanded || '', e.selected ? 'selected' : '']
      .filter(Boolean).join(', ');
    return `- ${elementKey(e)}${e.actions?.length ? ` [${e.actions.join(', ')}]` : ''}${state ? ` (${state})` : ''}`;
  });
  return `Window: "${screen.window}" (${screen.app})\n${controls.join('\n')}`;
}

const brief = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

// Typing can be taken back with Ctrl+Z; other actions are left as they are.
const UNDOABLE = new Set(['system_type_text', 'type_text']);
const isUndoable = call => UNDOABLE.has(call.name) || (call.name === 'uia_act' && call.arguments?.action === 'set_value');

const PLAN_SYSTEM = `You plan tasks for AbleSpeak, which operates a Windows computer for a student who cannot use a keyboard or mouse.
Break the student's instruction into the fewest concrete steps, at most ${MAX_STEPS}. Each step is ONE action: open or switch to an app, open a website, press a control, type text, search, scroll, open an item, or read something.
To open or switch to an app, the step is "Open <app>" or "Switch to <app>": never through the Start menu or the Windows key.
Inside an app, standard commands are keyboard shortcuts, not menus or buttons: save = press Ctrl+S, save as = press Ctrl+Shift+S, find = Ctrl+F, select all = Ctrl+A, undo = Ctrl+Z, new = Ctrl+N.
To save under a name, one step: "Save the document as <name> in <folder>" (the save_document_as tool does the whole dialog). Never a folder tree, a Save button, an Alt shortcut or a typed path.
For each step, say what to do and what the screen should show afterwards.
Only include what the student asked for. Do not add extra actions.
Reply with JSON only, no other text: {"steps":[{"do":"...","expect":"..."}]}
If it cannot be done on this computer, reply {"steps":[],"reason":"a short reason the student will hear"}.`;

// Evidence rules after ARTEMIS's checker (Apache-2.0): judge what the step
// was for, a selected item is not an opened one, and no evidence is "unsure",
// not "failed". On 23 Oct 2026 the old wording passed "Downloads selected in
// the tree" as "Downloads open", and failed steps that had worked.
const CHECK_SYSTEM = `You check whether one step of a task worked, for a student who cannot see the screen easily.
Compare what the step was for with the tool's result and with what changed on the screen.
- Judge the step's purpose, not every word of the expected result: if the screen shows what the step was for, it worked, even when a detail (a highlight, which control has focus) can't be seen in the list of controls.
- Selecting or focusing an item is not opening it: an opened folder, page, app or document shows in the window title or in the controls.
- If nothing changed and the step needed a change, it failed.
- If the evidence shows neither that it worked nor that it failed, say "unsure".
Reply with JSON only: {"verdict":"worked" or "failed" or "unsure","why":"one short sentence"}`;

const FINAL_SYSTEM = `You decide whether a whole task is finished, for a student who cannot see the screen.
Look at the screen now: does it show what the student asked for? Judge the end result, not the steps.
- An opened folder, page, app or document shows in the window title or in the controls; a selected or focused item is not opened.
- Typed text shows in a control's value or in the document.
- If the screen can't show it either way (the result is in another window, or is a sound), say "unsure".
Reply with JSON only: {"verdict":"done" or "not_done" or "unsure","why":"one short sentence the student will hear"}`;

/** A checker's verdict, as { ok, why, unsure }. `ok: true` and the older shape are read too. */
function readVerdict(parsed, { worked = 'worked', failed = 'failed' } = {}) {
  if (typeof parsed?.ok === 'boolean') return { ok: parsed.ok, why: String(parsed.why || '').slice(0, 200) };
  const verdict = String(parsed?.verdict || '').toLowerCase();
  const why = String(parsed?.why || '').slice(0, 200);
  if (verdict === worked) return { ok: true, why };
  if (verdict === failed) return { ok: false, why };
  if (verdict === 'unsure') return { ok: true, why: why ? `not sure: ${why}` : 'not sure', unsure: true };
  return null;
}

const SUMMARY_SYSTEM = `You are AbleSpeak. In one or two short spoken sentences, tell the student what was done. If they asked for information (a message, an answer, what something says), give it. No lists, no markdown.`;

export class TaskAgent {
  /**
   * @param {object} deps
   * @param {(req:{system:string,messages:object[],tools?:object[]}) => Promise<{text:string,toolCalls:?object[]}>} deps.llm
   * @param {(context:object) => string} deps.systemPrompt  full tool guidance for choosing actions
   * @param {(context:object) => object[]} deps.toolsFor
   * @param {(name:string, args:object) => Promise<object>} deps.execute  goes through the safety gate
   * @param {() => Promise<object|null>} deps.readScreen  the front window's controls
   * @param {(text:string) => ({tool:string,args:object}|null)} [deps.fastMatch]
   * @param {(event:object) => void} [deps.report]
   * @param {() => boolean} [deps.isCancelled]
   * @param {(ms:number) => Promise<void>} [deps.wait]
   * @param {() => Promise<string|null>} [deps.readDocument]  the text of the document in front, to check typing
   * @param {() => string|null} [deps.extensionBrowser]  the process the Chrome extension runs in ("chrome"), null if not connected
   */
  constructor({ llm, systemPrompt, toolsFor, execute, readScreen, fastMatch = () => null, report = () => {}, isCancelled = () => false, wait = ms => new Promise(r => setTimeout(r, ms)), readDocument = async () => null, extensionBrowser = () => 'chrome' }) {
    Object.assign(this, { llm, systemPrompt, toolsFor, execute, readScreen, fastMatch, report, isCancelled, wait, readDocument, extensionBrowser });
  }

  /**
   * Which tools can work on the window in front: all of them in the
   * extension's browser; none of the extension's in another browser (Edge);
   * none that act on a web page in a desktop app.
   */
  usableTools(screen) {
    const app = String(screen?.app || '').toLowerCase();
    if (!app) return () => true;
    if (BROWSERS.has(app)) return app === this.extensionBrowser() ? () => true : name => !isBrowserTool(name);
    return name => !PAGE_TOOLS.has(name);
  }

  /** The end of the document's text, as evidence that typing worked; '' when it can't be read. */
  async documentEvidence() {
    const text = await this.readDocument().catch(() => null);
    if (typeof text !== 'string') return '';
    const tail = text.replace(/\r\n?/g, '\n').slice(-400);
    return `\n\nText in the document now${text.length > 400 ? ' (its end)' : ''}: ${JSON.stringify(tail)}`;
  }

  /**
   * A JSON answer from the model (temperature 0). A reply that isn't JSON is
   * asked for once more, as ARTEMIS does, so a stray sentence isn't taken as
   * "no steps" or "could not check". Null if the second reply isn't JSON either.
   */
  async askJson(request) {
    const reply = await this.llm({ ...request, temperature: 0 });
    const parsed = parseJsonReply(reply?.text);
    if (parsed) return parsed;
    const last = request.messages.length - 1;
    const again = await this.llm({
      ...request,
      temperature: 0,
      messages: request.messages.map((m, i) => (i === last ? { ...m, content: `${m.content}\n\nYour last reply was not valid JSON. Reply with the JSON object only.` } : m)),
    }).catch(() => null);
    return parseJsonReply(again?.text);
  }

  async plan(instruction, screen, context) {
    const parsed = await this.askJson({
      system: PLAN_SYSTEM,
      messages: [{ role: 'user', content: `Instruction: "${instruction}"\n\nWhat is on screen now:\n${describeScreen(screen)}${context?.activeTab ? `\nBrowser tab: ${context.activeTab.title || ''} ${context.activeTab.url || ''}` : ''}` }],
    });
    return { steps: cleanSteps(parsed?.steps, MAX_STEPS), reason: parsed?.reason ? String(parsed.reason) : null };
  }

  async replan(instruction, done, failed, why, screen) {
    const history = done.map((s, i) => `${i + 1}. ${s.do} — worked`).join('\n') || '(none yet)';
    const parsed = await this.askJson({
      system: PLAN_SYSTEM,
      messages: [{
        role: 'user',
        content: `Instruction: "${instruction}"\n\nSteps already done:\n${history}\n\nThis step did not work: "${failed.do}" — ${why}\n\nWhat is on screen now:\n${describeScreen(screen)}\n\nGive new steps to finish the instruction from here (at most 6). Try a different way from the one that failed.`,
      }],
    });
    return { steps: cleanSteps(parsed?.steps, 6), reason: parsed?.reason ? String(parsed.reason) : null };
  }

  /**
   * The screen after an action. An app takes a moment to open or redraw, so
   * while the screen still looks exactly as it did before, it is read again
   * every SETTLE_POLL_MS, for up to 4 s after opening or switching an app
   * and 1.2 s after anything else.
   */
  async settledScreen(before, call) {
    let after = await this.readScreen();
    // Focus alone moving (to a dialog that is still opening) is not a change
    const settled = screen => screenFingerprint(screen, { ignoreFocus: true });
    const was = settled(before);
    if (!was) return after;
    const limit = SLOW_TOOLS.has(call.name) ? SETTLE_MS.slow : SETTLE_MS.normal;
    for (let waited = 0; waited < limit && settled(after) === was && !this.isCancelled(); waited += SETTLE_POLL_MS) {
      await this.wait(SETTLE_POLL_MS);
      after = await this.readScreen();
    }
    return after;
  }

  /** One tool call for a step, or { done: true } if the screen already shows it. */
  async chooseAction(instruction, steps, index, screen, context) {
    const step = steps[index];
    const usable = this.usableTools(screen);
    const inDialog = isFileDialog(screen);
    const fast = this.fastMatch(step.do);
    const quick = fast && (usable(fast.tool) ? fast : forWindow(fast));
    const appSwitch = tool => /^(?:open|focus)_application$/.test(tool);
    if (quick && quick.tool !== 'dictation_mode' && usable(quick.tool) && !(inDialog && appSwitch(quick.tool))) return { name: quick.tool, arguments: quick.args };

    const guidance = [
      this.systemPrompt({ ...context, screenModel: null }),
      '',
      '## You are carrying out one step of a planned task',
      `Task: "${instruction}"`,
      `Plan:\n${steps.map((s, i) => `${i + 1}. ${s.do}${i === index ? '   ← this step' : ''}`).join('\n')}`,
      `Expected after this step: ${step.expect || '(not stated)'}`,
      '',
      `## What is on screen now\n${describeScreen(screen)}`,
      '',
      'Call exactly ONE tool to do this step. For desktop controls use uia_act with the control\'s name (refs are not shown here).',
      'To go to a website or search the web, use open_url or search_web: type_text types into the web page, never into the browser\'s address bar.',
      'To open or switch to an app use open_application or focus_application, never the Start menu or the Windows key (the Start menu cannot be seen afterwards). Inside an app, standard commands are send_system_keys shortcuts, not menus: save Ctrl+S, save as Ctrl+Shift+S, find Ctrl+F, select all Ctrl+A, undo Ctrl+Z, new Ctrl+N.',
      'To save the document under a name, call save_document_as with the name (and the folder, if one was named): it drives the whole Save As dialog. Never type a path or press Alt shortcuts for this.',
      ...(inDialog ? ['A Save As or Open dialog is in front: a folder named in the step is a folder INSIDE this dialog, never open_application. For saving, call save_document_as; for opening, put the file name into the "File name" box with uia_act set_value, then press Enter with send_system_keys.'] : []),
      'If the screen already shows the expected result, call no tool and reply with the single word DONE.',
    ].join('\n');

    const reply = await this.llm({
      system: guidance,
      messages: [{ role: 'user', content: `Do step ${index + 1}: ${step.do}` }],
      tools: this.toolsFor(context).filter(t => usable(t.name)),
      temperature: 0,
    });
    const call = reply?.toolCalls?.[0];
    if (call?.name) return { name: call.name, arguments: call.arguments || {} };
    if (/\bDONE\b/.test(reply?.text || '')) return { done: true };
    return null;
  }

  async check(step, call, result, before, after) {
    if (toolFailed(result)) return { ok: false, why: result?.message || result?.error || 'the action failed' };
    // Nothing to compare against (no stated result, or the screen can't be
    // read, e.g. in privacy mode): go by what the action reported.
    if (!step.expect || !before || !after) return { ok: true, why: 'the action worked' };
    // Typed text often isn't in the window's controls (Word's page): without
    // the document's text the checker could only say "unsure", and Word tasks
    // were reported done with nothing typed (23 Oct 2026)
    const typed = isUndoable(call) ? await this.documentEvidence() : '';
    const parsed = await this.askJson({
      system: CHECK_SYSTEM,
      messages: [{
        role: 'user',
        content: `Step: ${step.do}\nShould show afterwards: ${step.expect}\nTool used: ${call.name} ${JSON.stringify(call.arguments || {})}\nTool result: ${brief(result)}\n\nWhat changed on screen:\n${diffScreens(before, after)}\n\nScreen now:\n${describeScreen(after)}${typed}`,
      }],
    });
    return readVerdict(parsed) || { ok: true, why: 'could not check; the action reported success' };
  }

  /**
   * Before saying "done": does the screen show the whole task finished? (After
   * ARTEMIS's final review.) Null when there is no screen to judge, or the
   * checker gave no usable answer; "unsure" counts as finished.
   */
  async finalCheck(instruction, record, screen, { typed = false } = {}) {
    if (!screen) return null;
    const text = typed ? await this.documentEvidence() : '';
    const parsed = await this.askJson({
      system: FINAL_SYSTEM,
      messages: [{
        role: 'user',
        content: `The student asked: "${instruction}"\n\nSteps done:\n${record.map((r, i) => `${i + 1}. ${r.do} → ${r.ok ? 'worked' : 'failed'}`).join('\n')}\n\nScreen now:\n${describeScreen(screen)}${text}`,
      }],
    }).catch(() => null);
    return readVerdict(parsed, { worked: 'done', failed: 'not_done' });
  }

  async summarise(instruction, record, { unverified = false } = {}) {
    const reply = await this.llm({
      system: SUMMARY_SYSTEM,
      messages: [{
        role: 'user',
        content: `The student asked: "${instruction}"\n\nWhat happened:\n${record.map((r, i) => `${i + 1}. ${r.do} → ${r.ok ? 'worked' : 'failed'}; result: ${brief(r.result)}`).join('\n')}${unverified ? '\n\nThe end result could not be checked on the screen: say so in a few words.' : ''}`,
      }],
    }).catch(() => null);
    return String(reply?.text || '').trim() || 'Done.';
  }

  /**
   * Run a task. `state` resumes one that paused for a confirmation.
   * Returns { status: 'done' | 'failed' | 'stopped' | 'needs_confirmation' | 'cannot', text, steps, replans, toolCalls, state }.
   */
  async run(instruction, context = {}, { plan = null, state = null } = {}) {
    const run = state || { steps: null, index: 0, record: [], replans: 0, calls: [], typed: 0, routine: !!plan };

    if (!run.steps) {
      const screen = await this.readScreen();
      const planned = plan ? { steps: cleanSteps(plan, MAX_ROUTINE_STEPS), reason: null } : await this.plan(instruction, screen, context);
      if (!planned.steps.length) {
        return this.finish(run, 'cannot', planned.reason || "I couldn't work out how to do that on this computer.");
      }
      run.steps = planned.steps;
      this.report({ type: 'plan', steps: run.steps, asksFirst: classifyPlan(run.steps) });
    }

    while (run.index < run.steps.length || await this.moreToDo(instruction, run)) {
      if (this.isCancelled()) return this.stop(run, 'stopped', 'Stopped.', { undo: false });
      const step = run.steps[run.index];
      this.report({ type: 'step', index: run.index, total: run.steps.length, step });

      const before = await this.readScreen();
      const call = await this.chooseAction(instruction, run.steps, run.index, before, context);
      if (this.isCancelled()) return this.stop(run, 'stopped', 'Stopped.', { undo: false });

      let verdict;
      let result = null;
      if (call?.done) {
        verdict = { ok: true, why: 'the screen already showed it' };
      } else if (!call) {
        verdict = { ok: false, why: "I couldn't find a way to do this step" };
      } else {
        result = await this.execute(call.name, call.arguments);
        run.calls.push({ tool: call.name, args: call.arguments, result });
        if (result?.status === 'needs_confirmation') {
          run.pending = { call, step };
          return { status: 'needs_confirmation', text: result.prompt, prompt: result.prompt, steps: run.steps, replans: run.replans, toolCalls: run.calls, state: run };
        }
        if (isUndoable(call) && !toolFailed(result)) run.typed++;
        const after = toolFailed(result) ? await this.readScreen() : await this.settledScreen(before, call);
        verdict = await this.check(step, call, result, before, after);
      }
      run.record.push({ ...step, tool: call?.name || null, ok: verdict.ok, why: verdict.why, result });
      this.report({ type: 'check', index: run.index, total: run.steps.length, step, ok: verdict.ok, why: verdict.why });

      if (verdict.ok) {
        run.index++;
        continue;
      }

      // Check failed: re-plan, never retry the same thing blindly.
      if (run.replans >= MAX_REPLANS) {
        return this.stop(run, 'failed', `I couldn't finish: ${verdict.why}.`);
      }
      run.replans++;
      const now = await this.readScreen();
      const replanned = await this.replan(instruction, run.record.filter(r => r.ok), step, verdict.why, now);
      if (!replanned.steps.length) {
        return this.stop(run, 'failed', `I couldn't finish: ${replanned.reason || verdict.why}.`);
      }
      this.report({ type: 'replan', attempt: run.replans, steps: replanned.steps, why: verdict.why });
      run.steps = [...run.steps.slice(0, run.index), ...replanned.steps];
    }
    if (run.outcome) return run.outcome;

    const text = await this.summarise(instruction, run.record, { unverified: run.unverified });
    return this.finish(run, 'done', text);
  }

  /**
   * Every step went through: does the screen show the whole task finished?
   * True when new steps were planned to finish it. When it can't be
   * finished, `run.outcome` holds the reply, and the typing is left alone
   * (each step worked). A routine's steps are the student's own, so they
   * are not judged.
   */
  async moreToDo(instruction, run) {
    if (run.routine || this.isCancelled()) return false;
    const final = await this.finalCheck(instruction, run.record, await this.readScreen(), { typed: run.typed > 0 });
    // "Unsure" lets the task finish, but the student is told it wasn't checked
    run.unverified = !!final?.unsure;
    if (!final || final.ok) return false;
    this.report({ type: 'final_check', ok: false, why: final.why });
    const unfinished = why => `The task doesn't look finished: ${String(why).replace(/[.!\s]+$/, '')}.`;
    if (run.replans >= MAX_REPLANS) {
      run.outcome = await this.stop(run, 'failed', unfinished(final.why), { undo: false });
      return false;
    }
    run.replans++;
    const replanned = await this.replan(instruction, run.record.filter(r => r.ok), { do: 'finish the task' }, final.why, await this.readScreen());
    if (!replanned.steps.length) {
      run.outcome = await this.stop(run, 'failed', unfinished(replanned.reason || final.why), { undo: false });
      return false;
    }
    this.report({ type: 'replan', attempt: run.replans, steps: replanned.steps, why: final.why });
    run.steps = [...run.steps, ...replanned.steps];
    return true;
  }

  /**
   * Continue after the student answered a confirmation. `confirmedResult`
   * is the result of the action they said yes to, or null if they said no.
   */
  async resume(instruction, context, state, confirmedResult) {
    const { call, step } = state.pending || {};
    delete state.pending;
    if (!confirmedResult) return this.stop(state, 'stopped', 'Okay, I stopped the task.', { undo: false });
    state.calls.push({ tool: call.name, args: call.arguments, result: confirmedResult });
    const ok = !toolFailed(confirmedResult);
    state.record.push({ ...step, tool: call.name, ok, why: ok ? 'confirmed and done' : 'the confirmed action failed', result: confirmedResult });
    if (!ok) return this.stop(state, 'failed', `I couldn't finish: ${confirmedResult.message || confirmedResult.error || 'that action failed'}.`);
    state.index++;
    this.report({ type: 'resume', steps: state.steps, index: state.index });
    return this.run(instruction, context, { state });
  }

  /**
   * Report where the task stopped. After a failure, take back the typing it
   * did; when the student said "stop", leave their text alone.
   */
  async stop(run, status, reason, { undo = true } = {}) {
    let undone = 0;
    for (let i = 0; undo && i < run.typed; i++) {
      const r = await this.execute('send_system_keys', { keys: 'Ctrl+Z' }).catch(() => null);
      if (r && !toolFailed(r)) undone++;
    }
    const finished = run.record.filter(r => r.ok).length;
    const total = run.steps?.length || 0;
    const where = total ? ` I did ${finished} of ${total} steps.` : '';
    const took = undone ? ' I took back the typing I did.' : '';
    return this.finish(run, status, `${reason}${where}${took}`);
  }

  finish(run, status, text) {
    this.report({ type: status, text });
    return { status, text, steps: run.steps || [], record: run.record, replans: run.replans, toolCalls: run.calls, state: null };
  }
}
