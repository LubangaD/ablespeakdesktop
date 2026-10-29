/**
 * The gateway's side of the Chrome extension connection (ws-proxy.js):
 * one connection at a time, commands that fail as soon as it drops, a short
 * wait while it reconnects, and only the extension's own page context.
 * Run with:  node --test src/extension-connection.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WsProxy } from './ws-proxy.js';
import { initDatabase, closeDatabase } from './db.js';

let dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-ext-'));
  await initDatabase(join(dir, 'ablespeak.db'));
});
after(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

/** A fake extension socket: what the gateway sends, and a way to answer. */
function fakeExtension() {
  const ws = new EventEmitter();
  ws.readyState = 1; // OPEN
  ws.sent = [];
  ws.send = raw => ws.sent.push(JSON.parse(raw));
  ws.closedWith = null;
  ws.close = code => { ws.closedWith = code; ws.readyState = 3; ws.emit('close'); };
  ws.answer = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  return ws;
}

function makeProxy() {
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null });
  proxy._heartbeatInterval?.unref?.();
  proxy._broadcastDashboard = () => {};
  return proxy;
}

test('a newer extension connection replaces the older one', () => {
  const proxy = makeProxy();
  const older = fakeExtension();
  const newer = fakeExtension();
  proxy._handleExtensionConnect(older);
  proxy._handleExtensionConnect(newer);
  assert.equal(older.closedWith, 4000);
  assert.deepEqual([...proxy.extensionClients], [newer]);
});

test('a command fails at once when its connection drops, not after 10 seconds', async () => {
  const proxy = makeProxy();
  const ext = fakeExtension();
  proxy._handleExtensionConnect(ext);
  const started = Date.now();
  const result = proxy.sendToolToExtension('scroll', { direction: 'down' });
  await new Promise(r => setImmediate(r));
  assert.equal(ext.sent.at(-1).type, 'scroll');
  ext.close();
  const answer = await result;
  assert.equal(answer.status, 'error');
  assert.match(answer.error, /disconnected/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(proxy.pendingToolCalls.size, 0);
});

test('a command waits for the extension to reconnect, then runs', async () => {
  const proxy = makeProxy();
  const result = proxy.sendToolToExtension('scroll', { direction: 'down' });
  await new Promise(r => setTimeout(r, 300));
  const ext = fakeExtension();
  proxy._handleExtensionConnect(ext);
  for (let i = 0; i < 20 && !ext.sent.length; i++) await new Promise(r => setTimeout(r, 50));
  const sent = ext.sent.at(-1);
  assert.equal(sent.type, 'scroll');
  ext.answer({ replyTo: sent.replyTo, result: { status: 'success', scrolled: 'page' } });
  assert.deepEqual(await result, { status: 'success', scrolled: 'page' });
});

test('with no extension at all, it says so after the short wait', async () => {
  const proxy = makeProxy();
  const started = Date.now();
  await assert.rejects(proxy.sendToolToExtension('scroll', {}), /No Chrome extension connected/);
  assert.ok(Date.now() - started >= 2900, 'waited for a reconnect first');
});

test('only the extension\'s own context says what the person sees', () => {
  const proxy = makeProxy();
  const ext = fakeExtension();
  proxy._handleExtensionConnect(ext);
  ext.answer({ type: 'context_update', context: 'integration', result: { tabs: [{ id: 21 }], activeTab: { id: 21, url: 'chrome://newtab/' } } });
  ext.answer({ type: 'context_update', context: 'library', name: 'emails', result: { emails: [] } });
  assert.equal(proxy.browserContext.activeTab.id, 21);
  assert.ok(proxy.browserContext.receivedAt > 0);
});

test('messages from a replaced connection are ignored', () => {
  const proxy = makeProxy();
  const older = fakeExtension();
  proxy._handleExtensionConnect(older);
  const newer = fakeExtension();
  proxy._handleExtensionConnect(newer);
  older.emit('message', Buffer.from(JSON.stringify({ type: 'context_update', context: 'integration', result: { tabs: [], activeTab: { id: 1 } } })));
  assert.notEqual(proxy.browserContext.activeTab?.id, 1);
});
