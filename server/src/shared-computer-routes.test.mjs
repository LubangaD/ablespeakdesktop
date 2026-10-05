/**
 * Tests for the shared-computer admin settings API (Phase 2 Step 1):
 *   GET /api/settings/shared-computer
 *   PUT /api/settings/shared-computer
 * Run with: node --test src/shared-computer-routes.test.mjs
 *
 * Two things are checked: the routes' own behaviour (using createSettingsRouter
 * directly, as settings-routes.test.mjs does), and that in the real app they
 * sit behind the admin PIN exactly like the other settings routes — wiring
 * createAdminGate().requireAdmin in front of '/api/settings', the same way
 * src/index.js does, since createSettingsRouter itself only checks localOnly.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AIEngine } from './ai-engine.js';
import { initDatabase, closeDatabase } from './db.js';
import { setSharedComputer } from './shared-computer.js';
import { createSettingsRouter } from './routes/settings.js';
import { createAdminGate } from './admin-pin.js';

let dir, dbDir, server, port, engine;

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
      // Parsed safely: a route that doesn't exist yet (TDD red) returns HTML,
      // not JSON, and a thrown parse error here would never settle the
      // promise, leaving the server open and the whole test run hanging.
      res.on('end', () => {
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { nonJson: text }; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-shared-pc-routes-'));
  dbDir = mkdtempSync(join(tmpdir(), 'ablespeak-shared-pc-db-'));
  await initDatabase(join(dbDir, 'ablespeak.db'));
  engine = new AIEngine({ toolRegistry: { getToolsForContext: () => [] }, wsHub: null });
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRouter({ aiEngine: engine, envPath: () => join(dir, '.env') }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
});

after(() => {
  server.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => {
  setSharedComputer(false);
  delete process.env.ABLESPEAK_NO_WINDOWS_USER;
  delete process.env.USERNAME;
});

test('GET reports the device as not shared by default', async () => {
  const { status, body } = await request('GET', '/api/settings/shared-computer');
  assert.equal(status, 200);
  assert.equal(body.shared, false);
});

test('PUT turns the shared-computer flag on and off, and GET reflects it', async () => {
  const on = await request('PUT', '/api/settings/shared-computer', { body: { shared: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.shared, true);
  assert.equal((await request('GET', '/api/settings/shared-computer')).body.shared, true);

  const off = await request('PUT', '/api/settings/shared-computer', { body: { shared: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.shared, false);
});

test('PUT refuses anything that is not a plain boolean', async () => {
  for (const shared of ['true', 1, null, undefined, {}, []]) {
    const { status } = await request('PUT', '/api/settings/shared-computer', { body: { shared } });
    assert.equal(status, 400, JSON.stringify(shared));
  }
});

test('GET says whether the current Windows account looks like a guest account', async () => {
  process.env.USERNAME = 'Guest';
  assert.equal((await request('GET', '/api/settings/shared-computer')).body.guestAccount, true);

  process.env.USERNAME = 'amina.k';
  assert.equal((await request('GET', '/api/settings/shared-computer')).body.guestAccount, false);
});

// ── The PIN guard, wired exactly as src/index.js wires the other settings routes ──

test('without the admin PIN, the shared-computer routes refuse both GET and PUT', async () => {
  const gate = createAdminGate({ envPath: () => join(dir, 'admin.env') });
  const gatedApp = express();
  gatedApp.use(express.json());
  gatedApp.use('/api/admin', gate.router);
  gatedApp.use(['/api/settings'], gate.requireAdmin);
  gatedApp.use('/api/settings', createSettingsRouter({ aiEngine: engine, envPath: () => join(dir, '.env') }));
  const gatedServer = gatedApp.listen(0, '127.0.0.1');
  await new Promise(r => gatedServer.once('listening', r));
  const gatedPort = gatedServer.address().port;

  const req = (method, path, opts) => new Promise((resolve, reject) => {
    const data = opts?.body === undefined ? null : JSON.stringify(opts.body);
    const r = http.request({
      host: '127.0.0.1', port: gatedPort, method, path,
      headers: {
        Host: `localhost:${gatedPort}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(opts?.headers || {}),
      },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { nonJson: text }; }
        resolve({ status: res.statusCode, body });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });

  try {
    const getNoToken = await req('GET', '/api/settings/shared-computer');
    assert.equal(getNoToken.status, 403);
    assert.equal(getNoToken.body.adminRequired, true);

    const putNoToken = await req('PUT', '/api/settings/shared-computer', { body: { shared: true } });
    assert.equal(putNoToken.status, 403);
    assert.equal(putNoToken.body.adminRequired, true);

    // Set the PIN (the tray's "Set admin PIN…" opens the setup window).
    gate.openSetup(10 * 60 * 1000);
    const pinResult = await req('POST', '/api/admin/pin', { body: { pin: '1234' } });
    assert.equal(pinResult.status, 200);
    const token = pinResult.body.token;

    const getWithToken = await req('GET', '/api/settings/shared-computer', { headers: { 'X-AbleSpeak-Admin': token } });
    assert.equal(getWithToken.status, 200);

    const putWithToken = await req('PUT', '/api/settings/shared-computer', {
      body: { shared: true }, headers: { 'X-AbleSpeak-Admin': token },
    });
    assert.equal(putWithToken.status, 200);
    assert.equal(putWithToken.body.shared, true);
  } finally {
    gatedServer.close();
  }
});
