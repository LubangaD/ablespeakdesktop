/**
 * Tests for the task agent (Stage 3): when a plan is needed, plan → act →
 * check → re-plan → safe stop, pausing for confirmation, being stopped by
 * the student, routines, and shortcuts learned from corrections.
 * Run with: node --test src/agent.test.mjs
 *
 * The model, tools and screen are fakes, so each test scripts exactly what
 * the model says and what the screen shows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskAgent, needsPlan, parseJsonReply, diffScreens, MAX_REPLANS } from './agent.js';
import { classifyPlan } from './safety.js';
import { WsProxy } from './ws-proxy.js';
import { AIEngine } from './ai-engine.js';

const screen = (window, elements = []) => ({ window, app: 'test', elements });
const button = (name, extra = {}) => ({ ref: name, type: 'Button', name, actions: ['invoke'], ...extra });

/**
 * A fake agent. `replies` answers model calls in order, by kind:
 * plan / choose / check / summary. `screens` are returned by readScreen in order.
 */
function makeAgent({ plans = [], chooses = [], checks = [], summary = 'All done.', screens = [], results = {}, cancelled = () => false } = {}) {
  const calls = { llm: [], tools: [], events: [] };
  let screenIndex = 0;
  const agent = new TaskAgent({
    llm: async ({ system, messages, tools }) => {
      calls.llm.push({ system, messages, tools });
      if (system.startsWith('You plan tasks')) return { text: JSON.stringify(plans.shift() ?? { steps: [] }) };
      if (system.startsWith('You check')) return { text: JSON.stringify(checks.shift() ?? { ok: true, why: 'fine' }) };
      if (system.startsWith('You are AbleSpeak. In one')) return { text: summary };
      const next = chooses.shift();
      return next === 'DONE' ? { text: 'DONE' } : { text: '', toolCalls: next ? [next] : null };
    },
    systemPrompt: () => 'You are AbleSpeak, the full tool guide.',
    toolsFor: () => [{ name: 'uia_act' }],
    execute: async (name, args) => {
      calls.tools.push({ name, args });
      const result = results[name];
      return typeof result === 'function' ? result(args) : (result ?? { status: 'success' });
    },
    readScreen: async () => screens[Math.min(screenIndex++, screens.length - 1)] ?? null,
    fastMatch: text => (text === 'scroll down' ? { tool: 'scroll', args: { direction: 'down' } } : null),
    report: event => calls.events.push(event),
    isCancelled: cancelled,
  });
  return { agent, calls };
}

// ── Deciding to plan ───────────────────────────────────────────────────────

test('instructions with several actions get a plan; single commands do not', () => {
  assert.equal(needsPlan('Open my email and find the message from John'), true);
  assert.equal(needsPlan('open word, then type my name'), true);
  assert.equal(needsPlan('scroll down'), false);
  assert.equal(needsPlan('what time is it'), false);
  assert.equal(needsPlan('open chrome and'), false, 'too short to be two actions');
  assert.equal(needsPlan('search for rock and roll'), false, 'one action with "and" in it');
});

test('model replies are read even with fences or chatter around the JSON', () => {
  assert.deepEqual(parseJsonReply('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(parseJsonReply('Sure! {"steps":[]} Hope that helps'), { steps: [] });
  assert.equal(parseJsonReply('no json here'), null);
});

test('the screen diff names what appeared, went, and changed', () => {
  const before = screen('Inbox - Outlook', [button('New mail'), { ...button('Unread'), toggled: 'off' }]);
  const after = screen('Message - Outlook', [button('Reply'), { ...button('Unread'), toggled: 'on', focused: true }]);
  const diff = diffScreens(before, after);
  assert.match(diff, /window changed from "Inbox - Outlook" to "Message - Outlook"/);
  assert.match(diff, /Appeared: Button "Reply"/);
  assert.match(diff, /Gone: Button "New mail"/);
  assert.match(diff, /toggled: "off" → "on"/);
  assert.match(diff, /Focus is now on Button "Unread"/);
  assert.equal(diffScreens(before, before), 'Nothing visible changed.');
});

test('steps that will ask first are flagged in the plan', () => {
  const flagged = classifyPlan([
    { do: 'open Outlook' },
    { do: 'send the email to John' },
    { do: 'delete the draft' },
    { do: 'close the tab' },
    { do: 'close Word' },
  ]);
  assert.deepEqual(flagged, [{ index: 1, id: 'send' }, { index: 2, id: 'delete' }, { index: 4, id: 'close-app' }]);
});

// ── Plan → act → check ─────────────────────────────────────────────────────

test('a two-step task: each step acts once and is checked against the screen', async () => {
  const { agent, calls } = makeAgent({
    plans: [{ steps: [{ do: 'open Outlook', expect: 'Outlook inbox is showing' }, { do: 'open the message from John', expect: 'the message is open' }] }],
    chooses: [
      { name: 'open_application', arguments: { app_name: 'outlook' } },
      { name: 'uia_act', arguments: { name: 'John' } },
    ],
    checks: [{ ok: true, why: 'inbox open' }, { ok: true, why: 'message open' }],
    screens: [screen('Desktop'), screen('Desktop'), screen('Inbox'), screen('Inbox'), screen('Message from John')],
    summary: 'John says the trip is on Friday.',
  });

  const outcome = await agent.run('open my email and find the message from John');
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.text, 'John says the trip is on Friday.');
  assert.deepEqual(calls.tools.map(t => t.name), ['open_application', 'uia_act']);
  assert.deepEqual(calls.events.map(e => e.type), ['plan', 'step', 'check', 'step', 'check', 'done']);
  const checkPrompt = calls.llm.find(c => c.system.startsWith('You check')).messages[0].content;
  assert.match(checkPrompt, /window changed from "Desktop" to "Inbox"/);
});

test('a step the router knows skips the model', async () => {
  const { agent, calls } = makeAgent({
    screens: [screen('Doc')],
  });
  const outcome = await agent.run('my routine', {}, { plan: [{ do: 'scroll down', expect: '' }] });
  assert.equal(outcome.status, 'done');
  assert.deepEqual(calls.tools, [{ name: 'scroll', args: { direction: 'down' } }]);
  assert.equal(calls.llm.filter(c => !c.system.startsWith('You are AbleSpeak. In one')).length, 0, 'no plan, choose or check calls');
});

test('a step already done on screen is not repeated', async () => {
  const { agent, calls } = makeAgent({
    plans: [{ steps: [{ do: 'open Word', expect: 'Word is open' }, { do: 'type hello', expect: 'hello typed' }] }],
    chooses: ['DONE', { name: 'system_type_text', arguments: { text: 'hello' } }],
    screens: [screen('Word')],
  });
  const outcome = await agent.run('open word and type hello');
  assert.equal(outcome.status, 'done');
  assert.deepEqual(calls.tools.map(t => t.name), ['system_type_text']);
});

// ── Recovery ───────────────────────────────────────────────────────────────

test('a failed check re-plans instead of retrying the same action', async () => {
  const { agent, calls } = makeAgent({
    plans: [
      { steps: [{ do: 'click Send', expect: 'message sent' }] },
      { steps: [{ do: 'press Ctrl+Enter', expect: 'message sent' }] },
    ],
    chooses: [
      { name: 'uia_act', arguments: { name: 'Send' } },
      { name: 'send_system_keys', arguments: { keys: 'Ctrl+Enter' } },
    ],
    checks: [{ ok: false, why: 'the message is still in the draft' }, { ok: true, why: 'sent' }],
    screens: [screen('Draft')],
  });
  const outcome = await agent.run('reply to John and send it');
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.replans, 1);
  const replan = calls.llm.filter(c => c.system.startsWith('You plan tasks'))[1].messages[0].content;
  assert.match(replan, /This step did not work: "click Send" — the message is still in the draft/);
  assert.ok(calls.events.some(e => e.type === 'replan'));
});

test(`after ${MAX_REPLANS} re-plans the task stops, takes back its typing, and says where it got to`, async () => {
  const typing = { name: 'system_type_text', arguments: { text: 'hi' } };
  const { agent, calls } = makeAgent({
    plans: [
      { steps: [{ do: 'type hi', expect: 'hi appears' }, { do: 'save', expect: 'saved' }] },
      { steps: [{ do: 'save another way', expect: 'saved' }] },
      { steps: [{ do: 'save a third way', expect: 'saved' }] },
    ],
    chooses: [typing, { name: 'uia_act', arguments: { name: 'Save' } }, { name: 'uia_act', arguments: { name: 'Save' } }, { name: 'uia_act', arguments: { name: 'Save' } }],
    checks: [{ ok: true, why: 'typed' }, { ok: false, why: 'no save button' }, { ok: false, why: 'still unsaved' }, { ok: false, why: 'still unsaved' }],
    screens: [screen('Notepad')],
  });
  const outcome = await agent.run('type hi and save it');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.replans, MAX_REPLANS);
  // Each re-plan replaces the steps still to do, so the last plan had two.
  assert.match(outcome.text, /^I couldn't finish: still unsaved\. I did 1 of 2 steps\. I took back the typing I did\.$/);
  assert.deepEqual(calls.tools.at(-1), { name: 'send_system_keys', args: { keys: 'Ctrl+Z' } });
});

test('a failed action is never judged a success by the model', async () => {
  const { agent, calls } = makeAgent({
    plans: [{ steps: [{ do: 'open Excel', expect: 'Excel open' }] }, { steps: [] , reason: 'Excel is not installed' }],
    chooses: [{ name: 'open_application', arguments: { app_name: 'excel' } }],
    results: { open_application: { status: 'error', message: 'Excel is not installed' } },
    screens: [screen('Desktop')],
  });
  const outcome = await agent.run('open excel and make a chart');
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.text, /Excel is not installed/);
  assert.equal(calls.llm.filter(c => c.system.startsWith('You check')).length, 0);
});

test('an impossible task is refused with the reason', async () => {
  const { agent, calls } = makeAgent({ plans: [{ steps: [], reason: 'There is no printer on this computer.' }] });
  const outcome = await agent.run('print my essay and staple it');
  assert.equal(outcome.status, 'cannot');
  assert.equal(outcome.text, 'There is no printer on this computer.');
  assert.equal(calls.tools.length, 0);
});

test('"stop" ends the task at once and keeps the student\'s typing', async () => {
  let stop = false;
  const { agent, calls } = makeAgent({
    plans: [{ steps: [{ do: 'type a', expect: '' }, { do: 'type b', expect: '' }] }],
    chooses: [{ name: 'system_type_text', arguments: { text: 'a' } }],
    results: { system_type_text: () => { stop = true; return { status: 'success' }; } },
    cancelled: () => stop,
    screens: [screen('Doc')],
  });
  const outcome = await agent.run('type a and then type b');
  assert.equal(outcome.status, 'stopped');
  assert.equal(calls.tools.filter(t => t.name === 'send_system_keys').length, 0);
  assert.match(outcome.text, /^Stopped\. I did 1 of 2 steps\.$/);
});

// ── Confirmation in the middle of a task ───────────────────────────────────

test('a step that needs a yes pauses the task, and "yes" carries on', async () => {
  const { agent, calls } = makeAgent({
    plans: [{ steps: [{ do: 'delete the draft', expect: '' }, { do: 'open the inbox', expect: '' }] }],
    chooses: [
      { name: 'uia_act', arguments: { name: 'Delete' } },
      { name: 'uia_act', arguments: { name: 'Inbox' } },
    ],
    results: { uia_act: args => (args.name === 'Delete' ? { status: 'needs_confirmation', prompt: 'Delete this?' } : { status: 'success' }) },
    screens: [screen('Mail')],
  });
  const paused = await agent.run('delete the draft and open the inbox');
  assert.equal(paused.status, 'needs_confirmation');
  assert.equal(paused.prompt, 'Delete this?');
  assert.ok(calls.events[0].asksFirst.length, 'the plan said it would ask');

  const resumed = await agent.resume('delete the draft and open the inbox', {}, paused.state, { status: 'success', message: 'Deleted' });
  assert.equal(resumed.status, 'done');
  assert.deepEqual(calls.tools.map(t => t.args.name), ['Delete', 'Inbox']);
});

test('"no" to a paused step stops the task', async () => {
  const { agent } = makeAgent({
    plans: [{ steps: [{ do: 'send it', expect: '' }] }],
    chooses: [{ name: 'uia_act', arguments: { name: 'Send' } }],
    results: { uia_act: { status: 'needs_confirmation', prompt: 'Send this?' } },
    screens: [screen('Mail')],
  });
  const paused = await agent.run('write to John and send it');
  const stopped = await agent.resume('write to John and send it', {}, paused.state, null);
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.text, /^Okay, I stopped the task\./);
});

// ── Through the voice pipeline ─────────────────────────────────────────────

function pipeline({ replies, onCorrection } = {}) {
  const engine = new AIEngine({ toolRegistry: { getToolsForContext: () => [], executeTool: async () => ({ status: 'success' }) }, wsHub: null });
  const queue = [...replies];
  engine._dispatch = async () => queue.shift() || { text: '' };
  const tools = [];
  // Like the real registry: an unconfirmed Send is held and recorded on the hub.
  engine.toolRegistry.executeTool = async (name, args, hub, opts = {}) => {
    tools.push({ name, args });
    if (name === 'uia_act' && args.name === 'Send' && !opts.confirmed) {
      hub._pendingConfirmation = { tool: name, args, prompt: 'Send this?' };
      return { status: 'needs_confirmation', prompt: 'Send this?' };
    }
    return { status: 'success', message: 'ok' };
  };
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: engine, onCorrection });
  proxy._heartbeatInterval?.unref?.();
  const broadcasts = [];
  proxy._broadcastDashboard = msg => broadcasts.push(msg);
  proxy._autoFocusBrowser = () => {};
  return { proxy, engine, tools, broadcasts };
}

test('the task pauses for "send", and a spoken yes finishes it', async () => {
  const { proxy, tools, broadcasts } = pipeline({
    replies: [
      { text: '{"steps":[{"do":"write hello to John","expect":""},{"do":"send it","expect":""}]}' },
      { text: '', toolCalls: [{ name: 'system_type_text', arguments: { text: 'hello' } }] },
      { text: '', toolCalls: [{ name: 'uia_act', arguments: { name: 'Send' } }] },
      { text: 'Sent your message to John.' },
    ],
  });

  await proxy._runTask('write hello to John and send it', {});
  assert.equal(broadcasts.at(-1).model, 'confirmation-prompt');
  assert.equal(broadcasts.at(-1).text, 'Send this?');
  assert.ok(proxy._pendingConfirmation.plan, 'the paused task waits on this question');

  const handled = await proxy._resolvePendingConfirmation('yes');
  assert.equal(handled, true);
  const final = broadcasts.at(-1);
  assert.equal(final.provider, 'agent');
  assert.equal(final.text, 'Sent your message to John.');
  assert.equal(final.task.status, 'done');
  assert.deepEqual(tools.map(t => t.name), ['system_type_text', 'uia_act', 'uia_act']);
  assert.equal(proxy._agentRunning, false);
  assert.equal(proxy._voiceProcessing, false, 'the voice turn taken for the resume was released');
});

test('"stop" during a model call ends the task as stopped, not failed', async () => {
  const { proxy, engine, broadcasts } = pipeline({ replies: [] });
  engine._dispatch = async () => {
    proxy._agentCancelled = true;
    throw new Error('This operation was aborted');
  };
  const outcome = await proxy._runTask('open word and type hello', {});
  assert.equal(outcome.status, 'stopped');
  assert.equal(broadcasts.at(-1).text, 'Stopped.');
  assert.equal(broadcasts.at(-1).error, false);
});

test('a yes said during dictation answers the waiting question instead of being typed', async () => {
  const { proxy, tools } = pipeline({ replies: [] });
  const typed = [];
  proxy._dictateAndReport = async text => { typed.push(text); return null; };
  proxy._dictationMode = true;
  proxy._pendingConfirmation = { tool: 'close_application', args: { app_name: 'word' }, prompt: 'Close this window?' };
  proxy.voiceHandler.transcribe = async () => ({ text: 'Yes.' });
  await proxy._onVoiceAudio({ send: () => {} }, { audio: 'x'.repeat(8000), source: 'overlay' });
  assert.deepEqual(typed, []);
  assert.deepEqual(tools, [{ name: 'close_application', args: { app_name: 'word' } }]);

  // Anything other than yes or no drops the question and is typed.
  proxy._pendingConfirmation = { tool: 'close_application', args: { app_name: 'word' }, prompt: 'Close this window?' };
  proxy.voiceHandler.transcribe = async () => ({ text: 'The river is long.' });
  await proxy._onVoiceAudio({ send: () => {} }, { audio: 'x'.repeat(8000), source: 'overlay' });
  assert.deepEqual(typed, ['The river is long. ']);
  assert.equal(proxy._pendingConfirmation, null);
});

test('a phrase heard twice as the same correction becomes a shortcut', () => {
  let count = 0;
  const { proxy } = pipeline({
    replies: [],
    onCorrection: () => { count++; return { learned: count >= 2 }; },
  });
  const wrong = { text: 'scroll town' };
  assert.equal(proxy._learnCorrection(wrong, 'scroll down'), '');
  assert.equal(proxy._learnCorrection(wrong, 'scroll down'), ' I\'ll remember that "scroll town" means "scroll down".');
  assert.equal(proxy._learnCorrection(null, 'scroll down'), '');
});

test('complete() uses its own messages and leaves the conversation alone', async () => {
  const engine = new AIEngine({ toolRegistry: { getToolsForContext: () => [] }, wsHub: null });
  engine.conversationHistory = [{ role: 'user', content: 'earlier' }];
  let seen;
  engine._dispatch = () => { seen = engine.conversationHistory; return Promise.resolve({ text: 'ok' }); };
  const reply = await engine.complete({ system: 'x', messages: [{ role: 'user', content: 'plan this' }] });
  assert.equal(reply.text, 'ok');
  assert.deepEqual(seen, [{ role: 'user', content: 'plan this' }]);
  assert.deepEqual(engine.conversationHistory, [{ role: 'user', content: 'earlier' }]);
});
