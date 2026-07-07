/**
 * T4 Sync Receiver Route Tests — real express router over HTTP, temp DB + temp settings.
 * Covers: 404 when not receiver, 401 on any decrypt failure, 413 size cap,
 * successful ingest with origin_device, status endpoint never leaks classroomKey.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { initDatabase, closeDatabase, getDb } from './db.js';
import { createSyncRouter } from './routes/sync.js';
import { encryptPayload } from './sync-crypto.js';
import { saveAppSettings, _setSettingsPath } from './app-settings.js';

const KEY = 'route-test-classroom-key';

function tmpFile(name) {
  return join(tmpdir(), `ablespeak-test-${name}-${Date.now()}.db`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
    try { if (existsSync(p + '.tmp')) unlinkSync(p + '.tmp'); } catch {}
  }
}

let settingsDir = null;
function useTmpSettings(settings) {
  settingsDir = mkdtempSync(join(tmpdir(), 'ablespeak-sync-route-'));
  _setSettingsPath(join(settingsDir, 'app-settings.json'));
  saveAppSettings(settings);
}
function cleanupSettings() {
  _setSettingsPath(null);
  if (settingsDir) { try { rmSync(settingsDir, { recursive: true, force: true }); } catch {} settingsDir = null; }
}

async function withServer(fn, { syncClient } = {}) {
  const app = express();
  // No global body parser here: createSyncRouter provides express.json({ limit: '6mb' })
  // on the ingest route, matching the production setup where the sync router is mounted
  // before the global body parser in index.js. This makes test and prod 413 paths identical.
  app.use('/api', createSyncRouter({ syncClient }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

function post(base, body) {
  return fetch(`${base}/sync/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('ingest: 404 when sync disabled or role is sender', async () => {
  const path = tmpFile('route-404');
  try {
    await initDatabase(path);

    useTmpSettings({ sync: { enabled: false, role: 'receiver', classroomKey: KEY } });
    await withServer(async (base) => {
      let res = await post(base, { deviceId: 'd1', package: encryptPayload({ batches: [] }, KEY) });
      assert.equal(res.status, 404);
    });
    cleanupSettings();

    useTmpSettings({ sync: { enabled: true, role: 'sender', classroomKey: KEY } });
    await withServer(async (base) => {
      const res = await post(base, { deviceId: 'd1', package: encryptPayload({ batches: [] }, KEY) });
      assert.equal(res.status, 404);
    });
  } finally {
    cleanupSettings();
    await closeDatabase();
    cleanup(path);
  }
});

test('ingest: 401 on wrong key, tampered package, and malformed package — identical responses', async () => {
  const path = tmpFile('route-401');
  try {
    await initDatabase(path);
    useTmpSettings({ sync: { enabled: true, role: 'receiver', classroomKey: KEY } });

    await withServer(async (base) => {
      // Wrong key
      const wrongPkg = encryptPayload({ batches: [] }, 'some-other-key');
      let res1 = await post(base, { deviceId: 'd1', package: wrongPkg });
      assert.equal(res1.status, 401);
      const body1 = await res1.json();

      // Tampered data
      const pkg = encryptPayload({ batches: [] }, KEY);
      const dataBytes = Buffer.from(pkg.data, 'base64');
      if (dataBytes.length > 0) dataBytes[0] ^= 0xff;
      let res2 = await post(base, { deviceId: 'd1', package: { ...pkg, data: dataBytes.toString('base64') } });
      assert.equal(res2.status, 401);
      const body2 = await res2.json();

      // Malformed package (garbage fields)
      let res3 = await post(base, { deviceId: 'd1', package: { salt: 'x', iv: 'y', tag: 'z', data: 'w' } });
      assert.equal(res3.status, 401);
      const body3 = await res3.json();

      // Identical response body for every failure mode
      assert.deepEqual(body1, body2);
      assert.deepEqual(body2, body3);
      // No key material anywhere
      for (const b of [body1, body2, body3]) {
        assert.ok(!JSON.stringify(b).includes(KEY));
      }
    });
  } finally {
    cleanupSettings();
    await closeDatabase();
    cleanup(path);
  }
});

test('ingest: 413 when payload exceeds 5MB', async () => {
  const path = tmpFile('route-413');
  try {
    await initDatabase(path);
    useTmpSettings({ sync: { enabled: true, role: 'receiver', classroomKey: KEY } });

    await withServer(async (base) => {
      const pkg = encryptPayload({ batches: [] }, KEY);
      pkg.data = 'A'.repeat(6 * 1024 * 1024); // 6MB of base64-ish data
      const res = await post(base, { deviceId: 'd1', package: pkg });
      assert.equal(res.status, 413);
    });
  } finally {
    cleanupSettings();
    await closeDatabase();
    cleanup(path);
  }
});

test('ingest: 400 when deviceId or package missing', async () => {
  const path = tmpFile('route-400');
  try {
    await initDatabase(path);
    useTmpSettings({ sync: { enabled: true, role: 'receiver', classroomKey: KEY } });

    await withServer(async (base) => {
      let res = await post(base, { package: encryptPayload({ batches: [] }, KEY) });
      assert.equal(res.status, 400);
      res = await post(base, { deviceId: 'd1' });
      assert.equal(res.status, 400);
    });
  } finally {
    cleanupSettings();
    await closeDatabase();
    cleanup(path);
  }
});

test('ingest: valid package inserts rows with origin_device; response has counts', async () => {
  const path = tmpFile('route-ok');
  try {
    await initDatabase(path);
    useTmpSettings({ sync: { enabled: true, role: 'receiver', classroomKey: KEY } });

    await withServer(async (base) => {
      const pkg = encryptPayload({
        batches: [{
          table: 'commands',
          rows: [{ id: 'cmd-r1', type: 'voice', direction: 'user_to_ai', student_id: 's1' }],
          nextCursor: '1',
        }],
      }, KEY);
      const res = await post(base, { deviceId: 'student-laptop-7', package: pkg });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.counts.commands.inserted, 1);

      const stmt = getDb().prepare(`SELECT origin_device FROM commands WHERE id='cmd-r1'`);
      stmt.step();
      const row = stmt.getAsObject();
      stmt.free();
      assert.equal(row.origin_device, 'student-laptop-7');
    });
  } finally {
    cleanupSettings();
    await closeDatabase();
    cleanup(path);
  }
});

test('status: exposes role/enabled/deviceId/cursors but NEVER the classroomKey', async () => {
  const path = tmpFile('route-status');
  try {
    await initDatabase(path);
    useTmpSettings({ sync: { enabled: true, role: 'receiver', classroomKey: KEY, targetUrl: '', intervalMs: 30000 } });

    await withServer(async (base) => {
      // Ingest once so devicesSeen is populated
      const pkg = encryptPayload({ batches: [] }, KEY);
      await post(base, { deviceId: 'dev-42', package: pkg });

      const res = await fetch(`${base}/sync/status`);
      assert.equal(res.status, 200);
      const raw = await res.text();
      assert.ok(!raw.includes(KEY), 'classroomKey must never appear in status response');

      const body = JSON.parse(raw);
      assert.equal(body.role, 'receiver');
      assert.equal(body.enabled, true);
      assert.equal(body.configured, true);
      assert.ok(!('classroomKey' in body));
      assert.ok(body.cursors && typeof body.cursors === 'object');
      assert.ok(body.lastIngestAt, 'lastIngestAt set after ingest');
      assert.equal(body.devicesSeen.length, 1);
      assert.equal(body.devicesSeen[0].deviceId, 'dev-42');
    });
  } finally {
    cleanupSettings();
    await closeDatabase();
    cleanup(path);
  }
});
