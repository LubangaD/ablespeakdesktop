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
