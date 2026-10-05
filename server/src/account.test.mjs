/**
 * Email-code sign-in (account.js) against a fake Supabase: no network.
 * Run with:  node --test src/account.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { createHash } from 'crypto';
import { createAccount, createAccountRouter, createAuthCallbackRouter, createSecureStore } from './account.js';

const URL = 'https://example.supabase.co';
const KEY = 'sb_publishable_test';
const CALLBACK = 'http://127.0.0.1:3001/auth/callback';
let calls, replies, account, server, port, opened, focused;

// A fake Supabase Auth: records each call and answers from `replies`
function fakeFetch(url, init) {
  const path = url.replace(`${URL}/auth/v1/`, '');
  calls.push({ path, headers: init.headers, body: JSON.parse(init.body) });
  const [status, body] = replies[path] || [200, {}];
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const memoryStore = () => createSecureStore('unused', { loadSafeStorage: async () => null });

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        Host: `localhost:${port}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* an HTML page, e.g. /auth/callback */ }
        resolve({ status: res.statusCode, body, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeEach(async () => {
  calls = [];
  replies = {
    otp: [200, {}],
    verify: [200, { access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_in: 3600, user: { id: 'u1', email: 'amina@example.com' } }],
    logout: [204, {}],
    'token?grant_type=pkce': [200, { access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_in: 3600, user: { id: 'u2', email: 'derrick@gmail.com' } }],
  };
  opened = [];
  account = createAccount({
    url: URL, key: KEY, store: memoryStore(), fetchImpl: fakeFetch,
    callbackUrl: CALLBACK, openUrl: async u => { opened.push(u); },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/account', createAccountRouter(account));
  focused = 0;
  app.use(createAuthCallbackRouter(account, { onSignedIn: () => { focused += 1; } }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
});

afterEach(() => server.close());

test('asking for a code emails it through Supabase with the publishable key', async () => {
  const { status, body } = await request('POST', '/api/account/sign-in/email', { body: { email: ' Amina@Example.com ' } });
  assert.equal(status, 200);
  assert.deepEqual(body, { sent: true, email: 'amina@example.com' });
  assert.equal(calls[0].path, 'otp');
  assert.equal(calls[0].headers.apikey, KEY);
  assert.deepEqual(calls[0].body, { email: 'amina@example.com', create_user: true });
});

test('a mistyped email is caught before anything is sent', async () => {
  const { status, body } = await request('POST', '/api/account/sign-in/email', { body: { email: 'amina at example' } });
  assert.equal(status, 400);
  assert.match(body.error, /email address/);
  assert.equal(calls.length, 0);
});

test('the right code signs in, and no token ever reaches the dashboard', async () => {
  const signedIn = await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: '123 456' } });
  assert.equal(signedIn.status, 200);
  assert.deepEqual(signedIn.body, { signedIn: true, user: { email: 'amina@example.com' } });
  assert.deepEqual(calls[0].body, { type: 'email', email: 'amina@example.com', token: '123456' });

  const status = await request('GET', '/api/account/status');
  assert.deepEqual(status.body, { configured: true, signedIn: true, skipped: false, user: { email: 'amina@example.com', role: null } });
  assert.doesNotMatch(signedIn.text + status.text, /SECRET/);
});

test('a wrong or expired code says so plainly and signs nobody in', async () => {
  replies.verify = [403, { code: 'otp_expired', msg: 'Token has expired or is invalid' }];
  const { status, body } = await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: '000000' } });
  assert.equal(status, 401);
  assert.match(body.error, /didn’t work, or it has expired/);
  assert.equal((await request('GET', '/api/account/status')).body.signedIn, false);
});

test('codes that are not numbers are refused before asking Supabase', async () => {
  const { status } = await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: 'abc' } });
  assert.equal(status, 400);
  assert.equal(calls.length, 0);
});

test('too many requests get a plain wait-a-minute message', async () => {
  replies.otp = [429, { msg: 'rate limit' }];
  const { status, body } = await request('POST', '/api/account/sign-in/email', { body: { email: 'amina@example.com' } });
  assert.equal(status, 429);
  assert.match(body.error, /Wait a minute/);
});

test('signing out ends the session at Supabase and forgets it here', async () => {
  await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: '123456' } });
  const out = await request('POST', '/api/account/sign-out');
  assert.deepEqual(out.body, { signedIn: false });
  const logout = calls.find(c => c.path === 'logout');
  assert.equal(logout.headers.Authorization, 'Bearer ACCESS-SECRET');
  assert.equal((await request('GET', '/api/account/status')).body.signedIn, false);
});

test('another website open in the browser can’t send codes or see who is signed in', async () => {
  const crossSite = { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' };
  assert.equal((await request('GET', '/api/account/status', { headers: crossSite })).status, 403);
  assert.equal((await request('POST', '/api/account/sign-in/email', { body: { email: 'victim@example.com' }, headers: crossSite })).status, 403);
  assert.equal(calls.length, 0);
});

// ── Google, through the browser (PKCE) ──

const challengeOf = verifier => createHash('sha256').update(verifier).digest('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('Google sign-in opens the browser at Supabase with a PKCE challenge', async () => {
  const { status, body } = await request('POST', '/api/account/sign-in/google');
  assert.equal(status, 200);
  assert.deepEqual(body, { opened: true });
  const url = new globalThis.URL(opened[0]);
  assert.equal(url.origin + url.pathname, `${URL}/auth/v1/authorize`);
  assert.equal(url.searchParams.get('provider'), 'google');
  assert.equal(url.searchParams.get('redirect_to'), CALLBACK);
  assert.equal(url.searchParams.get('code_challenge_method'), 's256');
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
});

test('the browser coming back signs in, using the secret that matches the challenge', async () => {
  await request('POST', '/api/account/sign-in/google');
  const challenge = new globalThis.URL(opened[0]).searchParams.get('code_challenge');
  const page = await request('GET', '/auth/callback?code=google-code-1');
  assert.equal(page.status, 200);
  assert.match(page.text, /You’re signed in/);
  assert.match(page.text, /derrick@gmail\.com/);
  assert.equal(focused, 1, 'AbleSpeak is brought to the front');
  assert.doesNotMatch(page.text, /SECRET/);
  const exchange = calls.find(c => c.path === 'token?grant_type=pkce');
  assert.equal(exchange.body.auth_code, 'google-code-1');
  assert.equal(challengeOf(exchange.body.code_verifier), challenge);
  assert.deepEqual((await request('GET', '/api/account/status')).body, { configured: true, signedIn: true, skipped: false, user: { email: 'derrick@gmail.com', role: null } });
});

test('a callback AbleSpeak did not start is refused, and a code works only once', async () => {
  const unasked = await request('GET', '/auth/callback?code=forged');
  assert.equal(unasked.status, 400);
  assert.equal(calls.length, 0);

  await request('POST', '/api/account/sign-in/google');
  await request('GET', '/auth/callback?code=google-code-1');
  const again = await request('GET', '/auth/callback?code=google-code-1');
  assert.equal(again.status, 400);
  assert.equal(calls.filter(c => c.path === 'token?grant_type=pkce').length, 1);
});

test('cancelling at Google, or Google refusing, says so and signs nobody in', async () => {
  await request('POST', '/api/account/sign-in/google');
  const cancelled = await request('GET', '/auth/callback?error=access_denied&error_description=denied');
  assert.equal(cancelled.status, 400);
  assert.match(cancelled.text, /cancelled/);

  replies['token?grant_type=pkce'] = [400, { error: 'invalid_grant' }];
  await request('POST', '/api/account/sign-in/google');
  const refused = await request('GET', '/auth/callback?code=bad');
  assert.equal(refused.status, 401);
  assert.equal((await request('GET', '/api/account/status')).body.signedIn, false);
});

test('another website can’t start a Google sign-in', async () => {
  const crossSite = { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' };
  assert.equal((await request('POST', '/api/account/sign-in/google', { headers: crossSite })).status, 403);
  assert.equal(opened.length, 0);
});

// ── Roles set in Supabase (app_metadata.ablespeak_role) ──

test('an admin role set in Supabase comes with the sign-in', async () => {
  replies.verify[1].user.app_metadata = { provider: 'email', ablespeak_role: 'admin' };
  await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: '123456' } });
  assert.equal(account.role(), 'admin');
  assert.equal((await request('GET', '/api/account/status')).body.user.role, 'admin');
});

test('only admin and helper count as roles; anything else is no role', async () => {
  replies.verify[1].user.app_metadata = { ablespeak_role: 'superuser' };
  await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: '123456' } });
  assert.equal(account.role(), null);
});

test('renewing at start picks up a role given since the last sign-in', async () => {
  await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: '123456' } });
  assert.equal(account.role(), null);
  replies['token?grant_type=refresh_token'] = [200, {
    access_token: 'ACCESS-2', refresh_token: 'REFRESH-2', expires_in: 3600,
    user: { id: 'u1', email: 'amina@example.com', app_metadata: { ablespeak_role: 'admin' } },
  }];
  await account.refresh();
  assert.equal(account.role(), 'admin');
  assert.equal(calls.find(c => c.path === 'token?grant_type=refresh_token').body.refresh_token, 'REFRESH-SECRET');
});

test('a renewal Supabase refuses signs out here; no internet keeps the session', async () => {
  await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: '123456' } });
  const offlineStore = memoryStore();
  await offlineStore.save({ refresh_token: 'R', user: { email: 'amina@example.com', role: 'admin' } });
  const offline = createAccount({ url: URL, key: KEY, store: offlineStore, fetchImpl: () => Promise.reject(new Error('offline')) });
  await offline.refresh();
  assert.equal(offline.role(), 'admin', 'no internet: the saved sign-in and its role stay');

  replies['token?grant_type=refresh_token'] = [400, { error: 'invalid_grant' }];
  await account.refresh();
  assert.equal(account.role(), null);
  assert.equal((await request('GET', '/api/account/status')).body.signedIn, false);
});

test('signing out drops the role', async () => {
  replies.verify[1].user.app_metadata = { ablespeak_role: 'admin' };
  await request('POST', '/api/account/sign-in/code', { body: { email: 'amina@example.com', code: '123456' } });
  await request('POST', '/api/account/sign-out');
  assert.equal(account.role(), null);
});

test('"Not now" is remembered until sign-out, so the voice bar can start', async () => {
  assert.equal((await request('GET', '/api/account/status')).body.skipped, false);
  assert.deepEqual((await request('POST', '/api/account/not-now')).body, { skipped: true });
  assert.equal((await request('GET', '/api/account/status')).body.skipped, true);
  await request('POST', '/api/account/sign-out');
  assert.equal((await request('GET', '/api/account/status')).body.skipped, false);
});

test('another website can’t skip sign-in', async () => {
  const crossSite = { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' };
  assert.equal((await request('POST', '/api/account/not-now', { headers: crossSite })).status, 403);
});

test('without Supabase settings, sign-in says it is not set up yet', async () => {
  const bare = createAccount({ url: '', key: '', store: memoryStore(), fetchImpl: fakeFetch });
  assert.deepEqual(await bare.status(), { configured: false, signedIn: false, skipped: false, user: null });
  await assert.rejects(() => bare.sendCode('amina@example.com'), /isn’t set up/);
});

test('the store keeps the session encrypted when secure storage is available', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const dir = mkdtempSync(join(tmpdir(), 'ablespeak-account-'));
  const file = join(dir, 'account.bin');
  // Stand-in for Electron's safeStorage: reversible, and never plain JSON on disk
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: s => Buffer.from(s).reverse(),
    decryptString: b => Buffer.from(b).reverse().toString(),
  };
  const store = createSecureStore(file, { loadSafeStorage: async () => fakeSafe });
  await store.save({ refresh_token: 'REFRESH-SECRET', user: { email: 'a@b.co' } });
  assert.doesNotMatch(readFileSync(file).toString(), /REFRESH-SECRET/);
  assert.equal((await store.load()).refresh_token, 'REFRESH-SECRET');
  await store.clear();
  assert.equal(await store.load(), null);
  rmSync(dir, { recursive: true, force: true });
});
