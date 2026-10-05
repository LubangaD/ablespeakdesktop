/**
 * Tests for WsProxy's server-owned voice control-phrase gating: interrupt,
 * sleep/wake, and dismiss/restore (HFI-1). Run with: node --test src/ws-proxy.test.mjs
 *
 * These exercise _handleVoiceControl() directly rather than going through a real
 * WebSocket, since that's where the control-phrase logic (and the bug HFI-1 fixes)
 * actually lives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsProxy } from './ws-proxy.js';
import { ToolRegistry } from './tool-registry.js';

function makeProxy() {
  const fakeServer = { on: () => {} };
  const proxy = new WsProxy({ server: fakeServer, aiEngine: null });
  // The constructor starts a heartbeat setInterval for real WS clients; unref it
  // so a test process that never opens a socket can still exit on its own.
  proxy._heartbeatInterval?.unref?.();
  const broadcasts = [];
  proxy._broadcastDashboard = (msg) => broadcasts.push(msg);
  return { proxy, broadcasts };
}

// ── Dismiss / restore (HFI-1) ──────────────────────────────────────────────

test('"dismiss" hides the overlay and starts ignoring commands', () => {
  const { proxy, broadcasts } = makeProxy();
  const handled = proxy._handleVoiceControl('dismiss');
  assert.equal(handled, true);
  assert.equal(proxy._dismissed, true);
  assert.equal(broadcasts.at(-1).type, 'voice_dismissed');
});

test('"close", "hide", and "go away" all dismiss too', () => {
  for (const phrase of ['close', 'hide', 'go away']) {
    const { proxy } = makeProxy();
    proxy._handleVoiceControl(phrase);
    assert.equal(proxy._dismissed, true, `"${phrase}" should dismiss`);
  }
});

test('while dismissed, an ordinary command is swallowed, not executed', () => {
  const { proxy, broadcasts } = makeProxy();
  proxy._handleVoiceControl('dismiss');
  const handled = proxy._handleVoiceControl('open google.com');
  // Consumed by the gate — caller must NOT fall through to the fast-matcher/AI,
  // otherwise a command would silently execute while the student can't see the
  // overlay to know it happened.
  assert.equal(handled, true);
  assert.equal(proxy._dismissed, true, 'stays dismissed until the wake phrase');
  assert.equal(broadcasts.at(-1).type, 'voice_no_speech');
});

test('the wake phrase restores the overlay from dismissed', () => {
  const { proxy, broadcasts } = makeProxy();
  proxy._handleVoiceControl('dismiss');
  const handled = proxy._handleVoiceControl('AbleSpeak');
  assert.equal(handled, true);
  assert.equal(proxy._dismissed, false);
  assert.equal(broadcasts.at(-1).type, 'voice_restored');
});

test('"come back" and "show yourself" also restore from dismissed', () => {
  for (const phrase of ['come back', 'show yourself']) {
    const { proxy } = makeProxy();
    proxy._handleVoiceControl('dismiss');
    proxy._handleVoiceControl(phrase);
    assert.equal(proxy._dismissed, false, `"${phrase}" should restore`);
  }
});

test('dismiss phrases only match as the WHOLE utterance', () => {
  const { proxy } = makeProxy();
  // A student saying "close the tab please" wants a browser tab closed, not to
  // dismiss the overlay — the gate must not swallow ordinary commands that
  // merely contain a dismiss word.
  const handled = proxy._handleVoiceControl('close the tab please');
  assert.equal(handled, false);
  assert.equal(proxy._dismissed, false);
});

test('waking from dismissed also clears sleep, so state never gets stuck crossed', () => {
  const { proxy } = makeProxy();
  proxy._handleVoiceControl('dismiss');
  proxy._sleeping = true; // simulate an overlapping state from a prior turn
  proxy._handleVoiceControl('ablespeak');
  assert.equal(proxy._dismissed, false);
  assert.equal(proxy._sleeping, false);
});

// ── Sleep / wake (pre-existing — must survive sharing WAKE_PHRASES_RE with dismiss) ──

test('sleep/wake still works independently of dismiss', () => {
  const { proxy, broadcasts } = makeProxy();
  proxy._handleVoiceControl('sleep');
  assert.equal(proxy._sleeping, true);
  proxy._handleVoiceControl('wake up');
  assert.equal(proxy._sleeping, false);
  assert.equal(broadcasts.at(-1).type, 'voice_awake');
});

// ── Interrupt (pre-existing — must survive the new dismissed-branch ordering) ──

test('interrupt still cancels immediately', () => {
  const { proxy, broadcasts } = makeProxy();
  const handled = proxy._handleVoiceControl('stop');
  assert.equal(handled, true);
  assert.equal(broadcasts.at(-1).type, 'voice_cancelled');
});

// ── WS token resolution (EXT-2) ──────────────────────────────────────────
//
// The actual auto-generate-and-persist policy lives in index.js (it needs a
// writable VOQAL_HOME on disk); these just cover the contract WsProxy itself
// promises the caller: use an explicitly-passed token, otherwise fall back to
// the env var, otherwise null — never silently ignore a resolved token.

test('an explicitly passed wsToken is used as-is', () => {
  const fakeServer = { on: () => {} };
  const proxy = new WsProxy({ server: fakeServer, aiEngine: null, wsToken: 'explicit-token-123' });
  proxy._heartbeatInterval?.unref?.();
  assert.equal(proxy._wsToken, 'explicit-token-123');
});

test('falls back to ABLESPEAK_WS_TOKEN when no explicit token is passed', () => {
  const prev = process.env.ABLESPEAK_WS_TOKEN;
  process.env.ABLESPEAK_WS_TOKEN = 'env-token-456';
  try {
    const fakeServer = { on: () => {} };
    const proxy = new WsProxy({ server: fakeServer, aiEngine: null });
    proxy._heartbeatInterval?.unref?.();
    assert.equal(proxy._wsToken, 'env-token-456');
  } finally {
    if (prev === undefined) delete process.env.ABLESPEAK_WS_TOKEN;
    else process.env.ABLESPEAK_WS_TOKEN = prev;
  }
});

// ── Dictation failures must be audible, not silent (CVA-3) ─────────────────
//
// dictateText()/executeDictationCommand() shell out to PowerShell/COM, so
// these tests exercise the broadcast contract _dictateAndReport() feeds into
// rather than re-invoking real system calls.

test('a successful dictation broadcasts plain success, no error field', () => {
  const { proxy, broadcasts } = makeProxy();
  proxy._broadcastDictationTyped('hello world', null);
  const msg = broadcasts.at(-1);
  assert.equal(msg.type, 'dictation_typed');
  assert.equal(msg.text, 'hello world');
  assert.equal(msg.error, undefined);
});

test('a failed dictation broadcasts an audible error, not a silent success shape', () => {
  const { proxy, broadcasts } = makeProxy();
  proxy._broadcastDictationTyped('hello world', 'PowerShell timed out');
  const msg = broadcasts.at(-1);
  assert.equal(msg.type, 'dictation_typed');
  assert.equal(msg.error, true);
  assert.match(msg.message, /PowerShell timed out/);
});

// ── sendToolToExtension with no extension connected must fail loudly (CVA-4) ──

test('create_tab with no extension connected rejects instead of faking success', async () => {
  const { proxy } = makeProxy();
  assert.equal(proxy.extensionClients.size, 0);
  await assert.rejects(
    () => proxy.sendToolToExtension('create_tab', { url: 'https://example.com' }),
    /No Chrome extension connected/
  );
});

test('open_url with no extension connected rejects the same way (no special-casing by type)', async () => {
  const { proxy } = makeProxy();
  await assert.rejects(
    () => proxy.sendToolToExtension('open_url', { url: 'https://example.com' }),
    /No Chrome extension connected/
  );
});

test('going through ToolRegistry.executeTool(), the rejection becomes an explicit error result, not a silent no-op or an unhandled rejection', async () => {
  const { proxy } = makeProxy();
  const toolRegistry = new ToolRegistry();
  const result = await toolRegistry.executeTool('create_tab', { url: 'https://example.com' }, proxy);
  assert.equal(result.status, 'error');
  assert.match(result.error, /No Chrome extension connected/);
  assert.notEqual(result.status, 'success');
  assert.equal(result.simulated, undefined);
});
