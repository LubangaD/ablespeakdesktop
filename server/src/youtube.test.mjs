/**
 * YouTube as a profile of its own (ideas from the Voqal library's youtube
 * profile, Apache-2.0): its tools only there, its page in the AI's context,
 * quick commands for "next video" / "play the second one", and the "ignore" tool.
 * Run with:  node --test src/youtube.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFastCommand, placeNumber } from './fast-commands.js';
import { ToolRegistry, onSite } from './tool-registry.js';
import { AIEngine } from './ai-engine.js';
import { WsProxy } from './ws-proxy.js';

const YT = 'https://www.youtube.com/results?search_query=michael+jackson';

test('on YouTube: next / previous video and "play the second one" run without the AI', () => {
  const on = said => matchFastCommand(said, { activeUrl: YT });
  assert.equal(on('next video').tool, 'youtube_next_video');
  assert.equal(on('previous video').tool, 'youtube_previous_video');
  assert.deepEqual(on('play the second video').args, { number: 2 });
  assert.deepEqual(on('play the first one').args, { number: 1 });
  assert.deepEqual(on('play video number 3').args, { number: 3 });
  assert.equal(on('play thriller'), null, 'a title goes to the AI, which opens it by ID');
  assert.equal(matchFastCommand('play the second video', { activeUrl: 'https://www.google.com/' }), null, 'only on YouTube');
  assert.equal(placeNumber('2nd'), 2);
  assert.equal(placeNumber('thriller'), null);
});

test("YouTube's tools are offered on YouTube, or when the words are about it", () => {
  const tools = new ToolRegistry();
  const names = (url, said) => tools.getToolsForContext({ extensionConnected: true, activeTab: url ? { url } : null }, said).map(t => t.name);
  assert.ok(names(YT, 'next one').includes('youtube_play_result'));
  assert.ok(!names('https://www.google.com/', 'open my email').includes('youtube_play_result'));
  assert.ok(names('https://www.google.com/', 'play thriller').includes('youtube_play_result'), 'search, then pick one');
  assert.ok(names(null, 'hello').includes('ignore'), 'ignore is always there');
  assert.ok(onSite('https://m.youtube.com/watch?v=1', 'youtube.com'));
  assert.ok(!onSite('https://notyoutube.com/', 'youtube.com'));
});

test('the AI sees the YouTube page: what plays, and the videos with their IDs', () => {
  const engine = new AIEngine({ toolRegistry: new ToolRegistry(), wsHub: null });
  const moment = engine._describeMoment({
    youtube: {
      status: 'success', page: 'results', title: null, adShowing: false,
      videos: [{ id: 'sOnqjkJTMaA', title: 'Michael Jackson - Thriller', channel: 'Michael Jackson' }, { id: 'oRdxUFDoQe0', title: 'Beat It', channel: '' }],
    },
  });
  assert.match(moment, /## YouTube\nSearch results, in order:\n1\. "Michael Jackson - Thriller" — Michael Jackson \| id: sOnqjkJTMaA\n2\. "Beat It" \| id: oRdxUFDoQe0/);
});

test('the YouTube page is asked for only when the active tab is YouTube, and never holds a command up', async () => {
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null });
  proxy._heartbeatInterval?.unref?.();
  proxy.extensionClients.add({});
  const asked = [];
  proxy.sendToolToExtension = async (type, payload) => { asked.push([type, payload]); return { status: 'success', videos: [] }; };
  assert.equal(await proxy._youtubeContext({ url: 'https://www.google.com/' }), null);
  assert.equal((await proxy._youtubeContext({ url: YT })).status, 'success');
  assert.deepEqual(asked, [['youtube', { action: 'state' }]]);
  proxy.sendToolToExtension = () => new Promise(() => {}); // never answers
  const started = Date.now();
  assert.equal(await proxy._youtubeContext({ url: YT }), null);
  assert.ok(Date.now() - started < 1600);
});

test('what the AI ignores (lyrics, a video, other people) is passed over quietly', async () => {
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null });
  proxy._heartbeatInterval?.unref?.();
  const shown = [];
  proxy._broadcastDashboard = msg => shown.push(msg.type);
  proxy.aiEngine = {
    toolRegistry: { executeTool: async () => ({ status: 'success' }) },
    processChat: async () => ({ text: '', toolCalls: [{ tool: 'ignore', args: { reason: 'song lyrics' }, result: { status: 'success', ignored: true, reason: 'song lyrics' } }] }),
  };
  const sent = [];
  await proxy._handleUtterance({ send: raw => sent.push(JSON.parse(raw)) }, 'I keep on telling the story of my heart');
  assert.equal(sent.at(-1)?.type, 'voice_no_speech');
  assert.ok(!shown.includes('chat_assistant_message'), 'nothing said, no "could you rephrase it?"');
});
