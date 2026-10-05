/**
 * Tests for the admin PIN that keeps developer pages away from students.
 * Run with:  node --test src/admin-pin.test.mjs
 *
 * Each test gets a fresh express app on a random local port, a temp .env file
 * and a fake clock, so lockouts and token expiry are checked without waiting.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAdminGate, hashPin, pinMatches, PIN_ENV, HELPER_PIN_ENV } from './admin-pin.js';

const savedPin = process.env[PIN_ENV];
const savedHelperPin = process.env[HELPER_PIN_ENV];
let dir, envPath, server, port, clock, gate;

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
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const envText = () => (existsSync(envPath) ? readFileSync(envPath, 'utf8') : '');
const asAdmin = token => ({ headers: { 'X-AbleSpeak-Admin': token } });

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-admin-'));
  envPath = join(dir, '.env');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedPin === undefined) delete process.env[PIN_ENV];
  else process.env[PIN_ENV] = savedPin;
  if (savedHelperPin === undefined) delete process.env[HELPER_PIN_ENV];
  else process.env[HELPER_PIN_ENV] = savedHelperPin;
});

beforeEach(async () => {
  delete process.env[PIN_ENV];
  delete process.env[HELPER_PIN_ENV];
  rmSync(envPath, { force: true });
  clock = 1_000_000;
  gate = createAdminGate({ envPath: () => envPath, now: () => clock });
  gate.openSetup(10 * 60 * 1000); // as the tray's "Set admin PIN…" does
  const app = express();
  app.use(express.json());
  app.use('/api/admin', gate.router);
  app.get('/api/secret', gate.requireAdmin, (req, res) => res.json({ ok: true }));
  app.get('/api/users-page', gate.requireHelper, (req, res) => res.json({ ok: true }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
});

afterEach(() => server.close());

test('hashPin/pinMatches: right PIN matches, wrong PIN and junk do not', () => {
  const stored = hashPin('2468');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(pinMatches('2468', stored), true);
  assert.equal(pinMatches('2469', stored), false);
  assert.equal(pinMatches('2468', ''), false);
  assert.equal(pinMatches('2468', 'plain$text'), false);
});

test('status: no PIN set and locked out of nothing', async () => {
  const { status, body } = await request('GET', '/api/admin/status');
  assert.equal(status, 200);
  assert.deepEqual(body, { pinSet: false, setupOpen: true, unlocked: false, role: null, helperPinSet: false, byAccount: false, signedInRole: null, adminAccount: null, lockedForSeconds: 0 });
});

test('protected route refuses without a token, and says a PIN is needed', async () => {
  const { status, body } = await request('GET', '/api/secret');
  assert.equal(status, 403);
  assert.equal(body.adminRequired, true);
  assert.equal(body.pinSet, false);
});

test('setting the first PIN saves only a hash and unlocks', async () => {
  const { status, body } = await request('POST', '/api/admin/pin', { body: { pin: '4321' } });
  assert.equal(status, 200);
  assert.ok(body.token);
  assert.doesNotMatch(envText(), /4321/);
  assert.match(envText(), /^ADMIN_PIN_HASH=scrypt\$/m);

  const ok = await request('GET', '/api/secret', asAdmin(body.token));
  assert.equal(ok.status, 200);
});

test('PIN must be 4 to 8 digits', async () => {
  for (const pin of ['123', '123456789', 'abcd', '12 34', '']) {
    const { status } = await request('POST', '/api/admin/pin', { body: { pin } });
    assert.equal(status, 400, `pin ${JSON.stringify(pin)}`);
  }
});

test('unlock with the right PIN gives a token; wrong PIN does not', async () => {
  await request('POST', '/api/admin/pin', { body: { pin: '1357' } });
  const wrong = await request('POST', '/api/admin/unlock', { body: { pin: '0000' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.token, undefined);

  const right = await request('POST', '/api/admin/unlock', { body: { pin: '1357' } });
  assert.equal(right.status, 200);
  const status = await request('GET', '/api/admin/status', asAdmin(right.body.token));
  assert.equal(status.body.unlocked, true);
});

test('unlock before any PIN is set is refused', async () => {
  const { status, body } = await request('POST', '/api/admin/unlock', { body: { pin: '1234' } });
  assert.equal(status, 409);
  assert.equal(body.pinSet, false);
});

test('changing the PIN needs the current one and signs old tokens out', async () => {
  const first = await request('POST', '/api/admin/pin', { body: { pin: '1111' } });
  const noCurrent = await request('POST', '/api/admin/pin', { body: { pin: '2222' } });
  assert.equal(noCurrent.status, 403);

  const changed = await request('POST', '/api/admin/pin', { body: { pin: '2222', currentPin: '1111' } });
  assert.equal(changed.status, 200);
  assert.equal((await request('GET', '/api/secret', asAdmin(first.body.token))).status, 403);
  assert.equal((await request('GET', '/api/secret', asAdmin(changed.body.token))).status, 200);
});

test('five wrong PINs lock unlocking for five minutes, even for the right PIN', async () => {
  await request('POST', '/api/admin/pin', { body: { pin: '9876' } });
  for (let i = 0; i < 5; i++) {
    assert.equal((await request('POST', '/api/admin/unlock', { body: { pin: '0000' } })).status, 403);
  }
  const locked = await request('POST', '/api/admin/unlock', { body: { pin: '9876' } });
  assert.equal(locked.status, 429);
  assert.ok(locked.body.lockedForSeconds > 0);

  clock += 5 * 60 * 1000;
  assert.equal((await request('POST', '/api/admin/unlock', { body: { pin: '9876' } })).status, 200);
});

test('tokens expire after 15 minutes', async () => {
  const { body } = await request('POST', '/api/admin/pin', { body: { pin: '5555' } });
  clock += 14 * 60 * 1000;
  assert.equal((await request('GET', '/api/secret', asAdmin(body.token))).status, 200);
  clock += 2 * 60 * 1000;
  assert.equal((await request('GET', '/api/secret', asAdmin(body.token))).status, 403);
});

test('lock forgets the token', async () => {
  const { body } = await request('POST', '/api/admin/pin', { body: { pin: '5555' } });
  await request('POST', '/api/admin/lock', asAdmin(body.token));
  assert.equal((await request('GET', '/api/secret', asAdmin(body.token))).status, 403);
});

test('admin routes refuse requests addressed to another host', async () => {
  const { status } = await request('POST', '/api/admin/pin', {
    body: { pin: '1234' }, headers: { Host: `evil.example:${port}` },
  });
  assert.equal(status, 403);
  assert.equal(process.env[PIN_ENV], undefined);
});

test('the first PIN can only be set while the tray has opened setup', async () => {
  clock += 11 * 60 * 1000; // the 10-minute setup window has passed
  const refused = await request('POST', '/api/admin/pin', { body: { pin: '1234' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.setupOpen, false);
  assert.equal(process.env[PIN_ENV], undefined);

  gate.openSetup(10 * 60 * 1000);
  assert.equal((await request('POST', '/api/admin/pin', { body: { pin: '1234' } })).status, 200);
});

test('setup closes once the first PIN is saved', async () => {
  await request('POST', '/api/admin/pin', { body: { pin: '1234' } });
  const { body } = await request('GET', '/api/admin/status');
  assert.equal(body.setupOpen, false);
});

// ── Helper PIN: the lower tier, Users page only ──

async function withHelperPin(adminPin = '1111', helperPin = '2222') {
  const admin = await request('POST', '/api/admin/pin', { body: { pin: adminPin } });
  const set = await request('POST', '/api/admin/helper-pin', { body: { pin: helperPin }, ...asAdmin(admin.body.token) });
  assert.equal(set.status, 200);
  assert.equal(set.body.helperPinSet, true);
  return admin.body.token;
}

test('the helper PIN opens the Users page but not the admin pages', async () => {
  await withHelperPin();
  assert.match(envText(), /^HELPER_PIN_HASH=scrypt\$/m);
  assert.doesNotMatch(envText(), /2222/);

  const helper = await request('POST', '/api/admin/unlock', { body: { pin: '2222' } });
  assert.equal(helper.status, 200);
  assert.equal(helper.body.role, 'helper');
  assert.equal((await request('GET', '/api/users-page', asAdmin(helper.body.token))).status, 200);
  const refused = await request('GET', '/api/secret', asAdmin(helper.body.token));
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /admin PIN/);

  const status = await request('GET', '/api/admin/status', asAdmin(helper.body.token));
  assert.equal(status.body.unlocked, true);
  assert.equal(status.body.role, 'helper');
  assert.equal(status.body.helperPinSet, true);
});

test('the admin PIN opens both tiers', async () => {
  await withHelperPin();
  const admin = await request('POST', '/api/admin/unlock', { body: { pin: '1111' } });
  assert.equal(admin.body.role, 'admin');
  assert.equal((await request('GET', '/api/users-page', asAdmin(admin.body.token))).status, 200);
  assert.equal((await request('GET', '/api/secret', asAdmin(admin.body.token))).status, 200);
});

test('only an admin can set the helper PIN, and it must differ from the admin PIN', async () => {
  const adminToken = await withHelperPin();
  const helper = await request('POST', '/api/admin/unlock', { body: { pin: '2222' } });
  assert.equal((await request('POST', '/api/admin/helper-pin', { body: { pin: '3333' }, ...asAdmin(helper.body.token) })).status, 403);
  assert.equal((await request('POST', '/api/admin/helper-pin', { body: { pin: '3333' } })).status, 403);
  const same = await request('POST', '/api/admin/helper-pin', { body: { pin: '1111' }, ...asAdmin(adminToken) });
  assert.equal(same.status, 400);
  assert.equal((await request('POST', '/api/admin/helper-pin', { body: { pin: '12' }, ...asAdmin(adminToken) })).status, 400);
});

test('the helper PIN cannot change the admin PIN', async () => {
  await withHelperPin();
  const changed = await request('POST', '/api/admin/pin', { body: { pin: '4444', currentPin: '2222' } });
  assert.equal(changed.status, 403);
});

test('removing or changing the helper PIN signs helpers out, not admins', async () => {
  const adminToken = await withHelperPin();
  const helper = await request('POST', '/api/admin/unlock', { body: { pin: '2222' } });
  const removed = await request('POST', '/api/admin/helper-pin', { body: { pin: null }, ...asAdmin(adminToken) });
  assert.equal(removed.body.helperPinSet, false);
  assert.doesNotMatch(envText(), /HELPER_PIN_HASH/);
  assert.equal((await request('GET', '/api/users-page', asAdmin(helper.body.token))).status, 403);
  assert.equal((await request('GET', '/api/secret', asAdmin(adminToken))).status, 200);
  assert.equal((await request('POST', '/api/admin/unlock', { body: { pin: '2222' } })).status, 403);
});

// ── Admin account: every page open, no PIN, but only from AbleSpeak's own pages ──

async function withAccountGate(status, fn) {
  const saved = { on: status.on };
  const accountGate = createAdminGate({
    envPath: () => envPath, now: () => clock,
    adminAccount: { status: () => ({ ...status, on: saved.on }), set: on => { saved.on = on; return { ...status, on }; } },
  });
  accountGate.openSetup(10 * 60 * 1000);
  const app = express();
  app.use(express.json());
  app.use('/api/admin', accountGate.router);
  app.get('/api/secret', accountGate.requireAdmin, (req, res) => res.json({ ok: true }));
  const accountServer = app.listen(0, '127.0.0.1');
  await new Promise(r => accountServer.once('listening', r));
  const mainPort = port;
  port = accountServer.address().port;
  try { await fn(saved); } finally { port = mainPort; accountServer.close(); }
}

const ACCOUNT = { account: 'User', on: true, blocked: null, reason: null };
const crossSite = { headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' } };

test('on an admin account, the dashboard gets admin pages with no PIN', async () => {
  await withAccountGate(ACCOUNT, async () => {
    assert.equal((await request('GET', '/api/secret', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    const { body } = await request('GET', '/api/admin/status');
    assert.equal(body.role, 'admin');
    assert.equal(body.byAccount, true);
    assert.equal(body.adminAccount.account, 'User');
  });
});

test('another website open in the browser never gets admin from the account', async () => {
  await withAccountGate(ACCOUNT, async () => {
    assert.equal((await request('GET', '/api/secret', crossSite)).status, 403);
    const sameSiteOtherPort = { headers: { 'Sec-Fetch-Site': 'same-site', Origin: 'http://localhost:5173' } };
    assert.equal((await request('GET', '/api/secret', sameSiteOtherPort)).status, 403);
  });
});

test('when the account is not an admin account, the PIN is needed as before', async () => {
  await withAccountGate({ ...ACCOUNT, on: false }, async () => {
    assert.equal((await request('GET', '/api/secret')).status, 403);
    assert.equal((await request('GET', '/api/admin/status')).body.byAccount, false);
  });
});

test('only an admin can turn the admin account on or off', async () => {
  await withAccountGate({ ...ACCOUNT, on: false }, async (saved) => {
    assert.equal((await request('POST', '/api/admin/account', { body: { on: true } })).status, 403);
    await request('POST', '/api/admin/pin', { body: { pin: '1111' } });
    const admin = await request('POST', '/api/admin/unlock', { body: { pin: '1111' } });
    assert.equal((await request('POST', '/api/admin/account', { body: { on: 'yes' }, ...asAdmin(admin.body.token) })).status, 400);
    const turned = await request('POST', '/api/admin/account', { body: { on: true }, ...asAdmin(admin.body.token) });
    assert.equal(turned.status, 200);
    assert.equal(saved.on, true);
  });
});

test('a blocked account (shared computer) is refused with the reason', async () => {
  const blocked = { account: 'Guest', on: false, blocked: 'guest', reason: 'This looks like a guest account.' };
  const accountGate = createAdminGate({
    envPath: () => envPath, now: () => clock,
    adminAccount: { status: () => blocked, set: () => { throw new Error(blocked.reason); } },
  });
  accountGate.openSetup(10 * 60 * 1000);
  const app = express();
  app.use(express.json());
  app.use('/api/admin', accountGate.router);
  const accountServer = app.listen(0, '127.0.0.1');
  await new Promise(r => accountServer.once('listening', r));
  const mainPort = port;
  port = accountServer.address().port;
  try {
    await request('POST', '/api/admin/pin', { body: { pin: '1111' } });
    const admin = await request('POST', '/api/admin/unlock', { body: { pin: '1111' } });
    const refused = await request('POST', '/api/admin/account', { body: { on: true }, ...asAdmin(admin.body.token) });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /guest/);
  } finally { port = mainPort; accountServer.close(); }
});

// ── A signed-in account with a role set in Supabase ──

async function withSignedInRole(role, fn) {
  const roleGate = createAdminGate({ envPath: () => envPath, now: () => clock, accountRole: () => role });
  roleGate.openSetup(10 * 60 * 1000);
  const app = express();
  app.use(express.json());
  app.use('/api/admin', roleGate.router);
  app.get('/api/secret', roleGate.requireAdmin, (req, res) => res.json({ ok: true }));
  app.get('/api/users-page', roleGate.requireHelper, (req, res) => res.json({ ok: true }));
  const roleServer = app.listen(0, '127.0.0.1');
  await new Promise(r => roleServer.once('listening', r));
  const mainPort = port;
  port = roleServer.address().port;
  try { await fn(); } finally { port = mainPort; roleServer.close(); }
}

test('a signed-in admin account opens every page with no PIN, but never for another website', async () => {
  await withSignedInRole('admin', async () => {
    assert.equal((await request('GET', '/api/secret')).status, 200);
    const { body } = await request('GET', '/api/admin/status');
    assert.equal(body.role, 'admin');
    assert.equal(body.byAccount, true);
    assert.equal(body.signedInRole, 'admin');
    assert.equal((await request('GET', '/api/secret', crossSite)).status, 403);
  });
});

test('a signed-in helper account opens the Users page only; the admin PIN still works', async () => {
  await withSignedInRole('helper', async () => {
    assert.equal((await request('GET', '/api/users-page')).status, 200);
    assert.equal((await request('GET', '/api/secret')).status, 403);
    await request('POST', '/api/admin/pin', { body: { pin: '1111' } });
    const admin = await request('POST', '/api/admin/unlock', { body: { pin: '1111' } });
    assert.equal((await request('GET', '/api/secret', asAdmin(admin.body.token))).status, 200);
  });
});

test('a signed-in account with no role gets nothing extra', async () => {
  await withSignedInRole(null, async () => {
    assert.equal((await request('GET', '/api/users-page')).status, 403);
    assert.equal((await request('GET', '/api/admin/status')).body.byAccount, false);
  });
});

test('wrong helper guesses count toward the same lockout', async () => {
  await withHelperPin();
  for (let i = 0; i < 5; i++) await request('POST', '/api/admin/unlock', { body: { pin: '0000' } });
  assert.equal((await request('POST', '/api/admin/unlock', { body: { pin: '2222' } })).status, 429);
});
