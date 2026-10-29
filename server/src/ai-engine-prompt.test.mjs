/**
 * "What's on my screen" reads the window the person is using, not always Chrome.
 * Run with:  node --test src/ai-engine-prompt.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIEngine } from './ai-engine.js';

const prompt = context => AIEngine.prototype._buildSystemPrompt.call(Object.create(AIEngine.prototype), {
  extensionConnected: true, ...context,
});

test('with Word in front, reading the screen reads Word, not a Chrome tab', () => {
  const text = prompt({ screenModel: { window: 'Report.docx - Word', app: 'Microsoft Word', summary: null } });
  assert.match(text, /## Reading the screen/);
  assert.match(text, /using Microsoft Word, NOT Chrome/);
  assert.match(text, /read_text/);
  assert.match(text, /do NOT call `get_page_content`/);
});

test('with Chrome in front, reading the screen reads the web page', () => {
  const text = prompt({ screenModel: { window: 'Gmail - Google Chrome', app: 'Google Chrome', summary: null } });
  assert.match(text, /web page in Google Chrome/);
  assert.doesNotMatch(text, /do NOT call `get_page_content`/);
});

// ── Questions are answered out loud, and a step that worked is not repeated ──

test('"Tell me about Michael Jackson" searches once at most, then answers out loud', async () => {
  let ran = 0;
  const engine = new AIEngine({
    toolRegistry: {
      getToolsForContext: () => [],
      executeTool: async () => { ran += 1; return { status: 'success' }; },
    },
    wsHub: null,
  });
  engine._buildSystemPrompt = () => 'system';
  const search = { name: 'search_web', arguments: { query: 'Michael Jackson' } };
  const replies = [
    { text: '', toolCalls: [search] },
    { text: '', toolCalls: [search] }, // the model tries the same search again
    { text: 'Michael Jackson was an American singer and dancer, called the King of Pop.', toolCalls: [] },
  ];
  engine._callLLM = async () => replies.shift();
  const result = await engine.processChat('Tell me about Michael Jackson');
  assert.equal(ran, 1, 'the same search is not opened again');
  assert.match(result.text, /King of Pop/);
});

test('the prompt tells the AI to answer questions out loud, not just open a search', () => {
  const text = prompt({ screenModel: null });
  assert.match(text, /## Questions: answer out loud/);
  assert.match(text, /Do NOT open a search page for this/);
});

// ── No screenshot is attached (electron-main.cjs capture-screen is off) ──

test('without a screenshot the AI is never told to click by position', () => {
  const paint = { window: 'Untitled - Paint', app: 'mspaint', summary: '1 Button "Brush" [invoke]' };
  const text = prompt({ screenModel: paint });
  assert.doesNotMatch(text, /SCREENSHOT/);
  assert.doesNotMatch(text, /use the screenshot/i);
  assert.match(text, /Never guess x and y/);
  assert.match(prompt({ screenModel: paint, screenshot: 'jpeg' }), /attached screenshot and click_desktop_element with x and y/);
});

// ── After a round of actions (ARTEMIS-style screen checks; reads reach the AI) ──

function loopEngine({ result, screens }) {
  const engine = new AIEngine({
    toolRegistry: { getToolsForContext: () => [], executeTool: async () => result },
    wsHub: screens ? { readScreenForAgent: async () => screens.shift() ?? null } : null,
  });
  engine._buildSystemPrompt = () => 'system';
  return engine;
}
const toolResultsSent = engine => engine.conversationHistory.find(m => m.role === 'user' && /Tool results/.test(m.content))?.content || '';

test('a desktop action that changed nothing: the AI is told so before its next step', async () => {
  const calculator = { window: 'Calculator', elements: [{ type: 'Button', name: 'Equals' }, { type: 'Text', name: 'Display is 0' }] };
  const engine = loopEngine({ result: { status: 'success', message: 'Pressed "Equals"' }, screens: [calculator, calculator, calculator] });
  const replies = [
    { text: '', toolCalls: [{ name: 'uia_act', arguments: { name: 'Equals' } }] },
    { text: 'The calculator did not respond.', toolCalls: [] },
  ];
  engine._callLLM = async () => replies.shift();
  await engine.processChat('press equals');
  assert.match(toolResultsSent(engine), /^Screen check: nothing on the screen changed/);
});

test('a desktop action that changed the screen gets no note', async () => {
  const before = { window: 'Calculator', elements: [{ type: 'Text', name: 'Display is 0' }] };
  const after = { window: 'Calculator', elements: [{ type: 'Text', name: 'Display is 42' }] };
  const engine = loopEngine({ result: { status: 'success', message: 'Pressed "Equals"' }, screens: [before, after] });
  const replies = [
    { text: '', toolCalls: [{ name: 'uia_act', arguments: { name: 'Equals' } }] },
    { text: 'It shows 42.', toolCalls: [] },
  ];
  engine._callLLM = async () => replies.shift();
  await engine.processChat('press equals');
  assert.doesNotMatch(toolResultsSent(engine), /Screen check/);
});

test('what a read found reaches the AI, so it can say it', async () => {
  const engine = loopEngine({ result: { status: 'success', message: 'Read the paragraph in "Essay"', text: 'Photosynthesis turns light into sugar.' } });
  const replies = [
    { text: '', toolCalls: [{ name: 'uia_act', arguments: { action: 'read_text', value: 'paragraph' } }] },
    { text: 'Photosynthesis turns light into sugar.', toolCalls: [] },
  ];
  engine._callLLM = async () => replies.shift();
  await engine.processChat('read this paragraph');
  assert.match(toolResultsSent(engine), /Photosynthesis turns light into sugar/);
});
