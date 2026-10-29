/**
 * Questions answered from a live Google search, like Google's AI mode
 * (web-answer.js): the request, the answer with its sources and Google's
 * Search Suggestions, the quick phrases that go straight to it, the answer
 * said exactly as given, and searches counted on the Speed tab.
 * Run with:  node --test src/web-answer.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webAnswer } from './web-answer.js';
import { matchFastCommand } from './fast-commands.js';
import { AIEngine } from './ai-engine.js';
import { ToolRegistry } from './tool-registry.js';
import { speedReport, speedOfTurn, newSpend, addSpend } from './speed-meter.js';

const ANSWER = 'Derrick Lubanga is a Kenyan data scientist and the founder of Tunga Innovation, which makes AbleSpeak.';
const grounded = {
  candidates: [{
    content: { parts: [{ text: ANSWER }] },
    groundingMetadata: {
      webSearchQueries: ['Derrick Lubanga'],
      groundingChunks: [
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/a', title: 'raeng.org.uk' } },
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/b', title: 'himalayas.app' } },
        { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/c', title: 'raeng.org.uk' } },
      ],
      searchEntryPoint: { renderedContent: '<div class="chip">Derrick Lubanga</div>' },
    },
  }],
  usageMetadata: { promptTokenCount: 42, toolUsePromptTokenCount: 57, candidatesTokenCount: 114 },
};

test('a question is answered from a Google search, with its sources and Google’s search suggestions', async () => {
  let asked;
  const fetchImpl = async (url, options) => { asked = { url, options }; return { ok: true, status: 200, json: async () => grounded }; };
  const answer = await webAnswer('Who is Derrick Lubanga?', { apiKey: 'test-key', fetchImpl });
  assert.equal(answer.status, 'success');
  assert.equal(answer.text, ANSWER);
  assert.equal(answer.message, ANSWER, 'what a quick command says');
  assert.deepEqual(answer.sources.map(s => s.title), ['raeng.org.uk', 'himalayas.app'], 'each site once');
  assert.deepEqual(answer.queries, ['Derrick Lubanga']);
  assert.equal(answer.suggestions.html, '<div class="chip">Derrick Lubanga</div>');
  assert.equal(answer.usage.searches, 1);
  assert.equal(answer.usage.input, 99, 'the search\'s own tokens count as input');
  const body = JSON.parse(asked.options.body);
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.equal(body.contents[0].parts[0].text, 'Who is Derrick Lubanga?');
  assert.match(asked.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.ok(!asked.url.includes('test-key'), 'the key is sent in a header, never in the address');
  assert.equal(asked.options.headers['x-goog-api-key'], 'test-key');
});

test('a search that can’t be done says so plainly', async () => {
  assert.match((await webAnswer('Who is X?', { apiKey: '' })).message, /Gemini key/);
  assert.match((await webAnswer('', { apiKey: 'k' })).message, /What should I look up/);
  const refused = await webAnswer('Who is X?', { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) }) });
  assert.equal(refused.status, 'error');
  const slow = await webAnswer('Who is X?', { apiKey: 'k', fetchImpl: async () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; } });
  assert.equal(slow.message, 'The search took too long.');
  const empty = await webAnswer('Who is X?', { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [] } }] }) }) });
  assert.equal(empty.message, 'The search didn’t find an answer.');
});

test('a question asked of Google goes straight to a web answer; a plain search still opens Google', () => {
  const question = said => matchFastCommand(said)?.args?.question;
  assert.equal(question('Tell me who derrick Lubanga is from google'), 'tell me who derrick lubanga is');
  assert.equal(question('google who won the AFCON final'), 'who won the afcon final');
  assert.equal(question('look up when the KCSE exams start'), 'when the kcse exams start');
  assert.equal(question('what is the weather in Nairobi on the internet'), 'what is the weather in nairobi');
  assert.equal(question('who is the president of Kenya online'), 'who is the president of kenya');
  assert.equal(matchFastCommand('search for Michael Jackson').tool, 'search_web');
  assert.equal(matchFastCommand('google Michael Jackson').tool, 'search_web');
  assert.equal(matchFastCommand('who is Michael Jackson'), null, 'the AI decides');
});

test('the web answer is said exactly as given, remembered for follow-ups, and its search counted', async () => {
  const tools = new ToolRegistry();
  tools.executeTool = async (name) => (name === 'web_answer'
    ? { status: 'success', text: ANSWER, message: ANSWER, sources: [], queries: ['Derrick Lubanga'], usage: { model: 'gemini-2.5-flash', calls: 1, ms: 2400, searches: 1, input: 99, output: 114 } }
    : { status: 'error', message: 'not in this test' });
  const engine = new AIEngine({ toolRegistry: tools, wsHub: null });
  engine._dispatch = async () => ({
    text: 'Let me look that up for you.',
    toolCalls: [{ name: 'web_answer', arguments: { question: 'Who is Derrick Lubanga?' } }],
    usage: { input: 3000, output: 12 },
  });
  const result = await engine.processChat('who is derrick lubanga', {});
  assert.equal(result.text, ANSWER, 'not the model’s own words');
  assert.equal(result.usage.searches, 1);
  assert.equal(result.usage.calls, 2, 'the model’s call and the search answer’s');
  assert.equal(engine.conversationHistory.at(-1).content, ANSWER, 'for "and where does he work?"');
  assert.match(engine._instructions(), /call `web_answer` with the whole question/);
});

test('a quick web answer joins the conversation, so a follow-up knows who it was about', async () => {
  const { WsProxy } = await import('./ws-proxy.js');
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null });
  proxy._heartbeatInterval?.unref?.();
  const engine = new AIEngine({ toolRegistry: new ToolRegistry(), wsHub: null });
  engine.toolRegistry.executeTool = async () => ({ status: 'success', text: ANSWER, message: ANSWER, queries: ['Derrick Lubanga'] });
  proxy.aiEngine = engine;
  const sent = [];
  await proxy._handleUtterance({ send: raw => sent.push(JSON.parse(raw)) }, 'tell me who derrick lubanga is from google', { typed: true });
  assert.deepEqual(engine.conversationHistory.slice(-2).map(m => m.content), ['tell me who derrick lubanga is from google', ANSWER]);
});

test('the Speed tab counts Google searches; only those past the free 1,500 a day cost', () => {
  const think = addSpend(newSpend('gemini-2.5-flash'), { input: 99, output: 114, searches: 1 }, 2400);
  const speed = speedOfTurn({ started: 0, heardAt: 500, think, doneAt: 3200, path: 'quick' });
  assert.equal(speed.ai.searches, 1);
  const rows = [{ id: 1, created_at: '2026-10-19 10:06:47', transcript: 'who is derrick lubanga', speed }];
  const report = speedReport({ rows, today: '2026-10-19' });
  assert.deepEqual({ count: report.today.searches.count, cost: report.today.searches.cost }, { count: 1, cost: 0 });
});
