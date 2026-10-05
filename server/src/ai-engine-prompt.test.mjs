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
