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

export const MAX_STEPS = 8;          // steps in a plan the model makes
export const MAX_ROUTINE_STEPS = 10; // steps in a student's routine (student-profile.js)
export const MAX_REPLANS = 2;

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
For each step, say what to do and what the screen should show afterwards.
Only include what the student asked for. Do not add extra actions.
Reply with JSON only, no other text: {"steps":[{"do":"...","expect":"..."}]}
If it cannot be done on this computer, reply {"steps":[],"reason":"a short reason the student will hear"}.`;

const CHECK_SYSTEM = `You check whether one step of a task worked, for a student who cannot see the screen easily.
Compare what the step should have done with the tool's result and with what changed on the screen.
Say it worked only if the evidence shows it. If nothing changed and the step needed a change, it did not work.
Reply with JSON only: {"ok":true or false,"why":"one short sentence"}`;

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
   */
  constructor({ llm, systemPrompt, toolsFor, execute, readScreen, fastMatch = () => null, report = () => {}, isCancelled = () => false }) {
    Object.assign(this, { llm, systemPrompt, toolsFor, execute, readScreen, fastMatch, report, isCancelled });
  }

  async plan(instruction, screen, context) {
    const reply = await this.llm({
      system: PLAN_SYSTEM,
      messages: [{ role: 'user', content: `Instruction: "${instruction}"\n\nWhat is on screen now:\n${describeScreen(screen)}${context?.activeTab ? `\nBrowser tab: ${context.activeTab.title || ''} ${context.activeTab.url || ''}` : ''}` }],
    });
    const parsed = parseJsonReply(reply?.text);
    return { steps: cleanSteps(parsed?.steps, MAX_STEPS), reason: parsed?.reason ? String(parsed.reason) : null };
  }

  async replan(instruction, done, failed, why, screen) {
    const history = done.map((s, i) => `${i + 1}. ${s.do} — worked`).join('\n') || '(none yet)';
    const reply = await this.llm({
      system: PLAN_SYSTEM,
      messages: [{
        role: 'user',
        content: `Instruction: "${instruction}"\n\nSteps already done:\n${history}\n\nThis step did not work: "${failed.do}" — ${why}\n\nWhat is on screen now:\n${describeScreen(screen)}\n\nGive new steps to finish the instruction from here (at most 6). Try a different way from the one that failed.`,
      }],
    });
    const parsed = parseJsonReply(reply?.text);
    return { steps: cleanSteps(parsed?.steps, 6), reason: parsed?.reason ? String(parsed.reason) : null };
  }

  /** One tool call for a step, or { done: true } if the screen already shows it. */
  async chooseAction(instruction, steps, index, screen, context) {
    const step = steps[index];
    const quick = this.fastMatch(step.do);
    if (quick && quick.tool !== 'dictation_mode') return { name: quick.tool, arguments: quick.args };

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
      'If the screen already shows the expected result, call no tool and reply with the single word DONE.',
    ].join('\n');

    const reply = await this.llm({
      system: guidance,
      messages: [{ role: 'user', content: `Do step ${index + 1}: ${step.do}` }],
      tools: this.toolsFor(context),
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
    const reply = await this.llm({
      system: CHECK_SYSTEM,
      messages: [{
        role: 'user',
        content: `Step: ${step.do}\nShould show afterwards: ${step.expect}\nTool used: ${call.name} ${JSON.stringify(call.arguments || {})}\nTool result: ${brief(result)}\n\nWhat changed on screen:\n${diffScreens(before, after)}\n\nScreen now:\n${describeScreen(after)}`,
      }],
    });
    const parsed = parseJsonReply(reply?.text);
    if (typeof parsed?.ok !== 'boolean') return { ok: true, why: 'could not check; the action reported success' };
    return { ok: parsed.ok, why: String(parsed.why || '').slice(0, 200) };
  }

  async summarise(instruction, record) {
    const reply = await this.llm({
      system: SUMMARY_SYSTEM,
      messages: [{
        role: 'user',
        content: `The student asked: "${instruction}"\n\nWhat happened:\n${record.map((r, i) => `${i + 1}. ${r.do} → ${r.ok ? 'worked' : 'failed'}; result: ${brief(r.result)}`).join('\n')}`,
      }],
    }).catch(() => null);
    return String(reply?.text || '').trim() || 'Done.';
  }

  /**
   * Run a task. `state` resumes one that paused for a confirmation.
   * Returns { status: 'done' | 'failed' | 'stopped' | 'needs_confirmation' | 'cannot', text, steps, replans, toolCalls, state }.
   */
  async run(instruction, context = {}, { plan = null, state = null } = {}) {
    const run = state || { steps: null, index: 0, record: [], replans: 0, calls: [], typed: 0 };

    if (!run.steps) {
      const screen = await this.readScreen();
      const planned = plan ? { steps: cleanSteps(plan, MAX_ROUTINE_STEPS), reason: null } : await this.plan(instruction, screen, context);
      if (!planned.steps.length) {
        return this.finish(run, 'cannot', planned.reason || "I couldn't work out how to do that on this computer.");
      }
      run.steps = planned.steps;
      this.report({ type: 'plan', steps: run.steps, asksFirst: classifyPlan(run.steps) });
    }

    while (run.index < run.steps.length) {
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
        const after = await this.readScreen();
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

    const text = await this.summarise(instruction, run.record);
    return this.finish(run, 'done', text);
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
