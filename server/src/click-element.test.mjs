/**
 * "Click on sign up button" clicks the button on the real page, and an empty
 * reply from the model is asked again before the person is told to rephrase.
 * Run with:  node --test src/click-element.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, clickScript, clickWords, xpathForLabel } from './tool-registry.js';
import { AIEngine } from './ai-engine.js';

// ── A page small enough to hold in a test ──

function element({ tag = 'button', text = '', xpath = '', attrs = {}, link = null, shown = true, disabled = false }) {
  const el = {
    tag, xpath, innerText: text, value: '', disabled, clicks: 0, events: [],
    getAttribute: name => attrs[name] ?? null,
    getBoundingClientRect: () => (shown ? { width: 80, height: 30, top: 100, bottom: 130 } : { width: 0, height: 0, top: 0, bottom: 0 }),
    closest: () => link,
    scrollIntoView() {},
    focus() {},
    dispatchEvent(e) { el.events.push(e.type); },
    click() { el.clicks += 1; },
  };
  return el;
}

/** Runs the click script against a page made of `elements`. */
function runOn(elements, args) {
  const document = {
    evaluate: xpath => ({ singleNodeValue: elements.find(el => el.xpath === xpath) || null }),
    querySelectorAll: () => elements,
  };
  class MouseEvent { constructor(type) { this.type = type; } }
  const run = new Function('document', 'getComputedStyle', 'innerHeight', 'XPathResult', 'MouseEvent', 'window',
    `return ${clickScript(args)};`);
  return run(document, () => ({ display: 'block', visibility: 'visible' }), 800, { FIRST_ORDERED_NODE_TYPE: 9 }, MouseEvent, {});
}

const kisePage = () => {
  const signIn = element({ text: 'Sign In', xpath: '/html/body/div/button[1]' });
  const signUp = element({ text: 'Sign Up', xpath: '/html/body/div/button[2]' });
  const submit = element({ text: ' Sign In', xpath: '/html/body/div/form/button' });
  return { signIn, signUp, submit, all: [signIn, signUp, submit] };
};

test('the words that name an element leave out "the", "button", "click on"', () => {
  assert.deepEqual(clickWords('the Sign Up button'), ['sign', 'up']);
  assert.deepEqual(clickWords('Click on sign up button'), ['sign', 'up']);
  assert.deepEqual(clickWords(''), []);
});

test('an xpath that is on the page is clicked', () => {
  const page = kisePage();
  const done = runOn(page.all, { xpath: '/html/body/div/button[2]' });
  assert.equal(done.status, 'success');
  assert.equal(done.label, 'Sign Up');
  assert.equal(page.signUp.clicks, 1);
  assert.deepEqual(page.signUp.events, ['mousedown', 'mouseup']);
});

test('an xpath that matches nothing falls back to the words on the element', () => {
  const page = kisePage();
  const done = runOn(page.all, { xpath: '/html/body/div/button[9]', label: 'sign up button' });
  assert.equal(done.status, 'success');
  assert.equal(page.signUp.clicks, 1);
  assert.equal(page.signIn.clicks, 0);
});

test('an xpath that points at a different element loses to the words', () => {
  const page = kisePage();
  runOn(page.all, { xpath: '/html/body/div/button[1]', label: 'Sign Up' });
  assert.equal(page.signUp.clicks, 1);
  assert.equal(page.signIn.clicks, 0);
});

test('nothing on the page by that name is an error, and nothing is clicked', () => {
  const page = kisePage();
  const done = runOn(page.all, { xpath: '/html/body/nope', label: 'Register' });
  assert.equal(done.status, 'error');
  assert.match(done.message, /not found/i);
  assert.equal(page.all.reduce((n, el) => n + el.clicks, 0), 0);
});

test('a hidden element is not the one clicked', () => {
  const hidden = element({ text: 'Sign Up', shown: false });
  const seen = element({ text: 'Sign Up' });
  runOn([hidden, seen], { label: 'Sign Up' });
  assert.equal(hidden.clicks, 0);
  assert.equal(seen.clicks, 1);
});

test('a link that opens a new tab is handed back to be opened, not clicked', () => {
  const anchor = { target: '_blank', href: 'https://application.kise.ac.ke/', getAttribute: () => 'https://application.kise.ac.ke/' };
  const link = element({ tag: 'a', text: 'Online Application', link: anchor });
  const done = runOn([link], { label: 'online application' });
  assert.equal(done.href, 'https://application.kise.ac.ke/');
  assert.equal(link.clicks, 0);
});

test('a switched-off button says so', () => {
  const done = runOn([element({ text: 'Sign Up', disabled: true })], { label: 'Sign Up' });
  assert.equal(done.status, 'error');
  assert.match(done.message, /switched off/);
});

test('the label finds its xpath among the elements on screen', () => {
  const elements = [{ label: 'Sign In', xpath: '/a' }, { label: 'Sign Up', xpath: '/b' }];
  assert.equal(xpathForLabel(elements, 'the sign up button'), '/b');
  assert.equal(xpathForLabel(elements, 'Register'), null);
});

// ── The tool: where the click is sent, and what comes back ──

function hub(replies) {
  const sent = [];
  return {
    sent,
    browserContext: { pageContext: { viewportElements: [{ label: 'Sign Up', xpath: '/html/body/div/button[2]' }] } },
    sendToolToExtension: async (type, payload) => { sent.push({ type, payload }); return replies[type]?.(payload); },
  };
}

test('click_element runs in the page itself, not the sandbox copy', async () => {
  const wsHub = hub({ execute_script: () => ({ status: 'success', value: { status: 'success', clicked: true, label: 'Sign Up' } }) });
  const result = await new ToolRegistry().executeTool('click_element', { xpath: '/html/body/div/button[2]', label: 'Sign Up' }, wsHub);
  assert.equal(result.status, 'success');
  assert.deepEqual(wsHub.sent.map(s => s.type), ['execute_script']);
});

test('click_element reports an element that is not there as an error', async () => {
  const wsHub = hub({ execute_script: () => ({ status: 'success', value: { status: 'error', message: 'Element not found on this page: register' } }) });
  const result = await new ToolRegistry().executeTool('click_element', { label: 'Register' }, wsHub);
  assert.equal(result.status, 'error');
});

test('click_element opens a new-tab link itself, and says its name, not its address', async () => {
  const wsHub = hub({
    execute_script: () => ({ status: 'success', value: { status: 'success', href: 'https://application.kise.ac.ke/', label: 'Online Application' } }),
    open_url: () => ({ status: 'success' }),
  });
  const result = await new ToolRegistry().executeTool('click_element', { label: 'online application' }, wsHub);
  assert.deepEqual(wsHub.sent.map(s => s.type), ['execute_script', 'open_url']);
  assert.equal(wsHub.sent[1].payload.url, 'https://application.kise.ac.ke/');
  assert.doesNotMatch(result.message, /https?:/);
});

test('a page that refuses the script is clicked by the extension instead', async () => {
  const wsHub = hub({
    execute_script: () => ({ status: 'success', value: 'Script error: Refused to evaluate a string as JavaScript' }),
    javascript: () => ({ action: 'click', xpath: '/html/body/div/button[2]' }),
  });
  const result = await new ToolRegistry().executeTool('click_element', { label: 'Sign Up' }, wsHub);
  assert.equal(result.status, 'success');
  assert.equal(wsHub.sent[1].type, 'javascript');
  assert.match(wsHub.sent[1].payload, /"action":"click","xpath":"\/html\/body\/div\/button\[2\]"/);
});

// ── An empty reply from the model ──

function engineWith(replies) {
  const engine = new AIEngine({
    toolRegistry: {
      getToolsForContext: () => [{ name: 'click_element', description: '', parameters: {} }],
      executeTool: async () => ({ status: 'success', message: 'Clicked “Sign Up”.' }),
    },
    wsHub: null,
  });
  engine._buildSystemPrompt = () => 'system';
  const calls = [];
  engine._callLLM = async (_prompt, _tools, opts = {}) => { calls.push(opts); return replies.shift(); };
  return { engine, calls };
}

test('an empty reply is asked again with a tool required, and the click then happens', async () => {
  const { engine, calls } = engineWith([
    { text: '', toolCalls: null },
    { text: '', toolCalls: [{ name: 'click_element', arguments: { label: 'Sign Up' } }] },
  ]);
  const result = await engine.processChat('Click on sign up button', { extensionConnected: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].requireTool, true);
  assert.equal(result.toolCalls[0].tool, 'click_element');
  assert.notEqual(result.noAction, true);
});

test('two empty replies: the person is asked to rephrase, and the turn is not kept', async () => {
  const { engine } = engineWith([{ text: '', toolCalls: null }, { text: '', toolCalls: null }]);
  const result = await engine.processChat('Click on sign up button', { extensionConnected: true });
  assert.equal(result.noAction, true);
  assert.equal(engine.conversationHistory.length, 0);
});
