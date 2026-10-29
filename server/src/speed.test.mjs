/**
 * Speed work of 17 Oct 2026: no fixed 2 s after a page change (ai-engine.js
 * waitForFreshPage), and the screen read while the person is still speaking
 * (ws-proxy.js _prefetchScreen / _screenForAgent).
 * Run with:  node --test src/speed.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForFreshPage, AIEngine } from './ai-engine.js';
import { WsProxy } from './ws-proxy.js';
import { ToolRegistry } from './tool-registry.js';

test('Gemini gets the same instructions every time; the screen goes with the words, and is not kept', async () => {
  const engine = new AIEngine({ toolRegistry: new ToolRegistry(), wsHub: null });
  engine.provider = 'gemini';
  engine.model = 'gemini-2.5-flash';
  const bodies = [];
  engine._fetchWithRetry = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Okay.' }] } }] }) };
  };
  const context = { extensionConnected: true, screenModel: { window: 'Spotify Premium', app: 'Spotify', total: 3, summary: '- Button "Play" [invoke]' } };
  await engine.processChat('next song', context);
  await engine.processChat('volume up', { ...context, screenModel: { ...context.screenModel, summary: '- Button "Pause" [invoke]' } });
  const [first, second] = bodies;
  assert.equal(first.system_instruction.parts[0].text, second.system_instruction.parts[0].text, 'the same instructions both times');
  assert.ok(!first.system_instruction.parts[0].text.includes('Spotify Premium'));
  const said = second.contents.at(-1).parts[0].text;
  assert.match(said, /What is on the screen now:[\s\S]*Button "Pause"[\s\S]*What the person said: volume up/);
  assert.ok(!second.contents.some(c => c.parts[0].text.includes('Button "Play"')), 'an earlier screen is not sent again');
  assert.equal(engine.conversationHistory.find(m => m.role === 'user').content, 'next song', 'the history keeps only the words');
});

test('rarely needed tools are sent only when the words ask for them', () => {
  const tools = new ToolRegistry();
  const names = said => tools.getToolsForContext({ extensionConnected: true }, said).map(t => t.name);
  assert.ok(!names('next song').includes('pin_tab'));
  assert.ok(names('pin this tab').includes('pin_tab'));
  assert.ok(names('zoom in').includes('zoom_tab'));
  assert.ok(names('next song').includes('system_media_control'), 'everyday tools always go');
  assert.equal(tools.getToolsForContext({ extensionConnected: true }).length, tools.getToolsForContext({ extensionConnected: true }, '').length, 'without words: every tool, as before');
});

test('the next step goes as soon as the new page arrives, not after a fixed 2 s', async () => {
  const before = { url: 'https://www.google.com/', at: Date.now() };
  const wsHub = { browserContext: { activeTab: { url: before.url }, receivedAt: before.at - 50, pageContext: { viewportElements: [{}] } } };
  setTimeout(() => {
    wsHub.browserContext = { activeTab: { url: 'https://www.youtube.com/results?q=x' }, receivedAt: Date.now(), pageContext: { viewportElements: [{}, {}] } };
  }, 150);
  const waited = await waitForFreshPage(wsHub, before, { maxMs: 2000, stepMs: 20 });
  assert.ok(waited < 600, `waited ${waited} ms`);
});

test('without a new page it gives up at the limit', async () => {
  const before = { url: 'https://a.example/', at: Date.now() };
  const wsHub = { browserContext: { activeTab: { url: before.url }, receivedAt: before.at - 10, pageContext: { viewportElements: [{}] } } };
  const waited = await waitForFreshPage(wsHub, before, { maxMs: 200, stepMs: 20 });
  assert.ok(waited >= 200 && waited < 400, `waited ${waited} ms`);
});

function proxyWithScreen() {
  let reads = 0;
  const proxy = new WsProxy({
    server: { on: () => {} }, aiEngine: null,
    readScreen: async () => { reads++; await new Promise(r => setTimeout(r, 30)); return { window: `read ${reads}` }; },
  });
  proxy._heartbeatInterval?.unref?.();
  return { proxy, reads: () => reads };
}

test('the screen is read once when speech starts, and the AI command uses that read', async () => {
  const { proxy, reads } = proxyWithScreen();
  proxy._onStreamStart({ utt: 'u1' });
  proxy._prefetchScreen('u1'); // the early check for the same phrase asks again
  assert.equal(reads(), 1, 'one read per phrase');
  const screen = await proxy._screenForAgent();
  assert.equal(screen.window, 'read 1');
  assert.equal(reads(), 1, 'no second read after the words');
  await proxy._screenForAgent();
  assert.equal(reads(), 2, 'used once: the next command reads afresh');
});

test('a new phrase reads the screen again', async () => {
  const { proxy, reads } = proxyWithScreen();
  proxy._prefetchScreen('u1');
  proxy._prefetchScreen('u2');
  assert.equal(reads(), 2);
  assert.equal((await proxy._screenForAgent()).window, 'read 2');
});

function proxyWithSpeechService() {
  const calls = { finish: 0, cancel: 0 };
  const remoteAsr = {
    ready: true, configured: true, state: 'ready',
    peek: async () => ({ text: 'Open my history notes', no_speech_prob: 0.01, avg_logprob: -0.2 }),
    finish: async () => { calls.finish++; return { text: 'Open my history notes please', ms: 200, waitedMs: 550 }; },
    cancel: () => { calls.cancel++; },
    beginUtterance: () => {},
  };
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null, remoteAsr });
  proxy._heartbeatInterval?.unref?.();
  return { proxy, calls };
}

test('nothing said after the early check: its words are used, not heard again', async () => {
  const { proxy, calls } = proxyWithSpeechService();
  const sent = [];
  await proxy._onVoicePeek({ send: raw => sent.push(JSON.parse(raw)) }, { id: 1, streamUtt: 'u1', source: 'overlay' });
  assert.equal(sent.at(-1).taken, false, 'not a quick command: the clip carries on');
  const heard = await proxy._transcribeClip({ streamUtt: 'u1', wordsAtPeek: true, audio: '', mimeType: 'audio/webm' });
  assert.equal(heard.text, 'Open my history notes');
  assert.deepEqual(calls, { finish: 0, cancel: 1 });
});

test('more said after the early check: the whole phrase is heard as usual', async () => {
  const { proxy, calls } = proxyWithSpeechService();
  await proxy._onVoicePeek({ send: () => {} }, { id: 1, streamUtt: 'u1', source: 'overlay' });
  const heard = await proxy._transcribeClip({ streamUtt: 'u1', wordsAtPeek: false, audio: '', mimeType: 'audio/webm' });
  assert.equal(heard.text, 'Open my history notes please');
  assert.equal(calls.finish, 1);
});

function proxyForClicks({ front, controls = [], page = [], extension = true } = {}) {
  const proxy = new WsProxy({
    server: { on: () => {} }, aiEngine: null,
    frontWindow: async () => front,
    windowControls: async () => ({ status: 'success', elements: controls }),
  });
  proxy._heartbeatInterval?.unref?.();
  if (extension) proxy.extensionClients.add({});
  proxy.browserContext = { pageContext: { viewportElements: page } };
  return proxy;
}
const spotify = { hwnd: 1, process: 'Spotify', title: 'Spotify Premium' };
const control = (ref, name, actions = ['invoke']) => ({ ref, name, type: 'Button', actions });

test('"click play" presses the one Play button in the app in front, without the AI', async () => {
  const proxy = proxyForClicks({ front: spotify, controls: [control('1.1', 'Play'), control('1.2', 'Next'), control('1.3', 'Play', [])] });
  assert.deepEqual(await proxy._clickByName('Click play.'), { tool: 'uia_act', args: { ref: '1.1', app_name: 'Spotify' }, silent: true, byName: true });
  assert.equal((await proxy._clickByName('press the next button')).args.ref, '1.2');
});

test('two controls with the name, or none: left to the AI', async () => {
  const proxy = proxyForClicks({ front: spotify, controls: [control('1.1', 'Play'), control('2.1', 'Play')] });
  assert.equal(await proxy._clickByName('click play'), null);
  assert.equal(await proxy._clickByName('click the artist profile'), null);
  assert.equal(await proxy._clickByName('open spotify'), null, 'not a click');
});

test('in a browser, the page element with exactly that label', async () => {
  const chrome = { hwnd: 2, process: 'chrome', title: 'Sign up - Google Chrome' };
  const page = [{ label: 'Sign up', xpath: '/a[1]' }, { label: 'Sign up for news', xpath: '/a[2]' }];
  const proxy = proxyForClicks({ front: chrome, page });
  assert.deepEqual((await proxy._clickByName('click sign up')).args, { xpath: '/a[1]', label: 'Sign up' });
  assert.equal(await proxyForClicks({ front: chrome, page, extension: false })._clickByName('click sign up'), null, 'no extension: the AI says so');
});

test('a click by name that does not work goes on to the AI', async () => {
  const proxy = proxyForClicks({ front: spotify, controls: [control('1.1', 'Play')] });
  const calls = [];
  proxy.aiEngine = {
    toolRegistry: { executeTool: async name => { calls.push(name); return { status: 'error', message: 'That control is gone' }; } },
    processChat: async text => { calls.push(`ai: ${text}`); return { text: 'Playing.', toolCalls: null }; },
  };
  proxy._broadcastDashboard = () => {};
  await proxy._handleUtterance({ send: () => {} }, 'click play');
  assert.deepEqual(calls, ['uia_act', 'ai: click play']);
});

test('nothing is read in privacy mode', async () => {
  const { proxy, reads } = proxyWithScreen();
  proxy._privacyMode = true;
  proxy._prefetchScreen('u1');
  assert.equal(reads(), 0);
  assert.equal(await proxy._screenForAgent(), null);
});
