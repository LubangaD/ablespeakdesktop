/**
 * The Chrome extension's service worker (chrome-integration-master), run in a
 * VM context with fake Chrome APIs and a fake WebSocket — the unmodified file,
 * as Chrome would load it. Technique from the Voqal Clone Lab's core.test.mjs.
 * Run with:  node --test src/extension-sw.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import vm from 'vm';

const SOURCE = readFileSync(new URL('../../chrome-integration-master/service-worker.js', import.meta.url), 'utf8');
const tick = () => new Promise(r => setImmediate(r));

/**
 * Two browser windows: window 1 shows YouTube (its tab is "active" in that
 * window), window 2 — the one the person used last — shows a new tab page.
 * `sendMessage(tabId, state)` answers page actions; state.injected says
 * whether the content script has been added to the tab.
 */
function loadWorker({ sendMessage } = {}) {
  const windows = [
    { id: 1, tabs: [{ id: 11, windowId: 1, active: true, url: 'https://www.youtube.com/results?search_query=x', title: 'YouTube' }] },
    { id: 2, tabs: [{ id: 21, windowId: 2, active: true, url: 'chrome://newtab/', title: 'New Tab' }] },
  ];
  const allTabs = windows.flatMap(w => w.tabs);
  const calls = [];
  const sockets = [];
  const timers = [];
  const state = { injected: false };

  class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(msg) { return this.onmessage({ data: JSON.stringify(msg) }); }
  }

  const listener = () => ({ addListener() {} });
  const chrome = {
    tabs: {
      query: async (q = {}) => allTabs.filter(t => (q.active ? t.active : true)),
      update: async (id, props) => { calls.push(['tabs.update', id, props]); const t = allTabs.find(x => x.id === id); return t && { ...t, ...props }; },
      create: async props => { calls.push(['tabs.create', props]); return { id: 99, ...props }; },
      sendMessage: (tabId, msg, cb) => {
        calls.push(['sendMessage', tabId]);
        const answer = sendMessage ? sendMessage(tabId, state) : { response: { result: { status: 'success' } } };
        chrome.runtime.lastError = answer.error ? { message: answer.error } : undefined;
        cb(answer.response);
        chrome.runtime.lastError = undefined;
      },
      onActivated: listener(), onUpdated: listener(),
    },
    windows: {
      getLastFocused: async () => windows[1],
      update: async (id, props) => { calls.push(['windows.update', id, props]); },
      onFocusChanged: listener(),
    },
    runtime: { onInstalled: listener(), lastError: undefined },
    scripting: {
      executeScript: async opts => {
        calls.push(['executeScript', opts.target.tabId, opts.files ? opts.files.join() : 'func']);
        if (opts.files) { state.injected = true; return []; }
        return [{ result: { pageTitle: 'page', viewportElements: [] } }];
      },
    },
    // Chrome answers storage reads asynchronously, after the script has loaded
    storage: { local: { get: (keys, cb) => Promise.resolve().then(() => cb({ enabled: true, wsToken: 'test-token' })), set() {} } },
    alarms: { create() {}, onAlarm: listener() },
    action: { setIcon() {}, onClicked: listener() },
  };

  const context = vm.createContext({
    chrome,
    WebSocket: FakeSocket,
    console: { log() {}, warn() {}, error() {} },
    performance,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/130.0' },
    fetch: async () => ({ ok: false }),
    AbortSignal,
    // Timers are recorded, never run on their own (the reconnect loop would run forever)
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  });
  vm.runInContext(SOURCE, context);
  const run = code => vm.runInContext(code, context);
  return { run, calls, sockets, timers };
}

async function connected(options) {
  const worker = loadWorker(options);
  for (let i = 0; i < 5 && !worker.sockets.length; i++) await tick();
  worker.sockets[0].open();
  return worker;
}

test('the page AbleSpeak is told about is the tab commands act on (last window used)', async () => {
  const { run } = await connected();
  const update = await run('defaultContextUpdater()');
  assert.equal(update.result.activeTab.id, 21, 'not the YouTube tab of the other window');
  assert.equal(update.result.activeTab.windowId, 2);
  assert.ok(update.result.updatedAt > 0);
});

test('a page reader without code is refused, and the every-second update keeps one updater', async () => {
  const { run, sockets } = await connected();
  await sockets[0].receive({ type: 'context_updater', payload: {}, replyTo: 'r1' });
  assert.deepEqual(sockets[0].sent.at(-1), { result: { status: 'error', message: 'context_updater needs code' }, replyTo: 'r1' });
  assert.equal(run('contextUpdaters.length'), 1);
});

test('after the connection drops it tries again within two seconds', async () => {
  const { sockets, timers } = await connected();
  timers.length = 0;
  sockets[0].close();
  const retries = timers.filter(t => t.ms >= 1000);
  assert.ok(retries.length >= 1, 'a retry is scheduled');
  assert.ok(retries.every(t => t.ms <= 2000), `retry delays: ${retries.map(t => Math.round(t.ms)).join(', ')} ms`);
});

test('an older connection closing leaves the current one alone', async () => {
  const { run, sockets } = await connected();
  run("_doConnect('ws://localhost:3001/ws/extension?token=x', null)");
  const [older, current] = sockets;
  current.open();
  older.close();
  assert.equal(run('webSocket'), current);
});

test('two connects while the first is still starting open only one socket', async () => {
  const worker = loadWorker();
  worker.run('connect(); connect();'); // the wake-up and the heartbeat alarm, together
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(worker.sockets.length, 1);
});

test('a tab without the content script gets one, and the page action is tried again', async () => {
  const { sockets, calls } = await connected({
    sendMessage: (_tabId, state) => state.injected
      ? { response: { result: { status: 'success', value: 42 } } }
      : { error: 'Could not establish connection. Receiving end does not exist.' },
  });
  await sockets[0].receive({ type: 'javascript', payload: 'run something', replyTo: 'r2' });
  assert.ok(calls.some(c => c[0] === 'executeScript' && c[1] === 21 && c[2] === 'scripts/content.js'));
  assert.deepEqual(sockets[0].sent.at(-1), { result: { status: 'success', value: 42 }, replyTo: 'r2' });
});

test('a page that can\'t be scripted is reported as an error, never as success', async () => {
  const { sockets } = await connected({ sendMessage: () => ({ error: 'Cannot access a chrome:// URL' }) });
  await sockets[0].receive({ type: 'javascript', payload: 'search', replyTo: 'r3' });
  assert.deepEqual(sockets[0].sent.at(-1), { result: { status: 'error', message: 'Cannot access a chrome:// URL' }, replyTo: 'r3' });
});

test('open_url opens in the tab the person is on', async () => {
  const { sockets, calls } = await connected();
  await sockets[0].receive({ type: 'open_url', payload: { url: 'https://example.com' }, replyTo: 'r4' });
  assert.equal(JSON.stringify(calls.find(c => c[0] === 'tabs.update')), JSON.stringify(['tabs.update', 21, { url: 'https://example.com' }]));
});

test('switching to a tab brings its window forward', async () => {
  const { sockets, calls } = await connected();
  await sockets[0].receive({ type: 'make_tab_active', payload: { tab_id: '11' }, replyTo: 'r5' });
  assert.equal(JSON.stringify(calls.find(c => c[0] === 'windows.update')), JSON.stringify(['windows.update', 1, { focused: true }]));
});
