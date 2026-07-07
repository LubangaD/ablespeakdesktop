/**
 * T4 Sync Client Tests (TDD — RED first)
 * buildSyncBatch: pure batching logic (empty, cursor advance, opt-out/null-student
 * exclusion is delegated to the injected getRows — verified via injection here and
 * end-to-end in sync-integration.test.mjs).
 * SyncClient.syncOnce: success advances cursors, failure leaves them, retry scheduling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncBatch, SyncClient, SYNC_TABLES } from './sync-client.js';
import { decryptPayload } from './sync-crypto.js';

// ── buildSyncBatch (pure) ──

test('buildSyncBatch: all tables empty → empty=true, no batches', () => {
  const getRows = () => ({ rows: [], nextCursor: '0' });
  const cursors = { commands: '0', sessions: '0' };
  const result = buildSyncBatch(['commands', 'sessions'], getRows, cursors);
  assert.equal(result.empty, true);
  assert.deepEqual(result.batches, []);
});

test('buildSyncBatch: rows present → batch with table, rows, nextCursor', () => {
  const getRows = (table, cursor) => {
    if (table === 'commands') return { rows: [{ id: 'c1' }, { id: 'c2' }], nextCursor: '7' };
    return { rows: [], nextCursor: cursor };
  };
  const result = buildSyncBatch(['commands', 'sessions'], getRows, { commands: '3', sessions: '0' });
  assert.equal(result.empty, false);
  assert.equal(result.batches.length, 1);
  assert.deepEqual(result.batches[0], { table: 'commands', rows: [{ id: 'c1' }, { id: 'c2' }], nextCursor: '7' });
});

test('buildSyncBatch: passes each table its own cursor', () => {
  const seen = {};
  const getRows = (table, cursor) => {
    seen[table] = cursor;
    return { rows: [], nextCursor: cursor };
  };
  buildSyncBatch(['commands', 'students'], getRows, { commands: '11', students: '22' });
  assert.equal(seen.commands, '11');
  assert.equal(seen.students, '22');
});

test('buildSyncBatch: missing cursor defaults to "0"', () => {
  let seenCursor = null;
  const getRows = (table, cursor) => { seenCursor = cursor; return { rows: [], nextCursor: cursor }; };
  buildSyncBatch(['commands'], getRows, {});
  assert.equal(seenCursor, '0');
});

test('buildSyncBatch: opt-out filtering is upstream — batch contains exactly what getRows returns', () => {
  // getRows simulates the db layer already excluding opt-out + null-student rows
  const getRows = () => ({ rows: [{ id: 'c-optin', student_id: 's-in' }], nextCursor: '5' });
  const result = buildSyncBatch(['commands'], getRows, { commands: '0' });
  const ids = result.batches[0].rows.map(r => r.id);
  assert.deepEqual(ids, ['c-optin']);
});

// ── SyncClient.syncOnce ──

const KEY = 'test-classroom-key';

function makeSettings(overrides = {}) {
  return {
    deviceId: 'device-test-1',
    sync: {
      enabled: true, role: 'sender',
      targetUrl: 'http://teacher.local:3001',
      classroomKey: KEY, intervalMs: 30000,
      ...overrides,
    },
  };
}

function makeFakeDb() {
  const cursors = {};
  const rowsByTable = { commands: [{ id: 'c1', student_id: 's1' }] };
  return {
    cursors,
    getSyncCursor: (t) => cursors[t] ?? '0',
    setSyncCursor: (t, c) => { cursors[t] = c; },
    getRowsSince: (t, cursor, opts) => {
      const rows = rowsByTable[t] || [];
      return parseInt(cursor) > 0
        ? { rows: [], nextCursor: cursor }
        : { rows, nextCursor: rows.length ? '9' : cursor };
    },
  };
}

test('syncOnce: success (200) advances cursors', async () => {
  const db = makeFakeDb();
  const posted = [];
  const fetchImpl = async (url, opts) => {
    posted.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new SyncClient({ settings: makeSettings(), fetchImpl, dbApi: db });
  const result = await client.syncOnce();
  assert.equal(result.ok, true);
  assert.equal(db.cursors.commands, '9', 'cursor advanced after confirmed 200');
  assert.equal(posted.length, 1);
  assert.ok(posted[0].url.endsWith('/api/sync/ingest'));
});

test('syncOnce: POST body contains deviceId and encrypted package, never plaintext or key', async () => {
  const db = makeFakeDb();
  let body = null;
  const fetchImpl = async (url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new SyncClient({ settings: makeSettings(), fetchImpl, dbApi: db });
  await client.syncOnce();
  assert.equal(body.deviceId, 'device-test-1');
  assert.ok(body.package.salt && body.package.iv && body.package.tag && body.package.data);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(KEY), 'classroomKey must not appear on the wire');
  assert.ok(!raw.includes('"c1"'), 'row data must not appear in plaintext');
  // The receiver CAN decrypt with the shared key
  const payload = decryptPayload(body.package, KEY);
  assert.equal(payload.batches[0].table, 'commands');
  assert.equal(payload.batches[0].rows[0].id, 'c1');
});

test('syncOnce: failure (500) does NOT advance cursors and does not throw', async () => {
  const db = makeFakeDb();
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const client = new SyncClient({ settings: makeSettings(), fetchImpl, dbApi: db });
  const result = await client.syncOnce();
  assert.equal(result.ok, false);
  assert.equal(db.cursors.commands, undefined, 'cursor must not advance on failure');
});

test('syncOnce: network error (fetch throws) does NOT advance cursors and does not throw', async () => {
  const db = makeFakeDb();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const client = new SyncClient({ settings: makeSettings(), fetchImpl, dbApi: db });
  const result = await client.syncOnce();
  assert.equal(result.ok, false);
  assert.equal(db.cursors.commands, undefined);
});

test('syncOnce: rows re-sent on next cycle after failure (no data loss)', async () => {
  const db = makeFakeDb();
  let failNext = true;
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (failNext) { failNext = false; return { ok: false, status: 502, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new SyncClient({ settings: makeSettings(), fetchImpl, dbApi: db });
  await client.syncOnce(); // fails
  await client.syncOnce(); // succeeds
  const p1 = decryptPayload(bodies[0].package, KEY);
  const p2 = decryptPayload(bodies[1].package, KEY);
  assert.deepEqual(p1.batches[0].rows, p2.batches[0].rows, 'same rows re-sent after failure');
  assert.equal(db.cursors.commands, '9', 'cursor advanced after eventual success');
});

test('syncOnce: empty batch → skips POST entirely', async () => {
  const db = makeFakeDb();
  db.setSyncCursor('commands', '9'); // already synced
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200, json: async () => ({}) }; };
  const client = new SyncClient({ settings: makeSettings(), fetchImpl, dbApi: db });
  const result = await client.syncOnce();
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.equal(called, 0, 'no POST for empty batch');
});

test('syncOnce: disabled sync → no-op', async () => {
  const db = makeFakeDb();
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200, json: async () => ({}) }; };
  const client = new SyncClient({ settings: makeSettings({ enabled: false }), fetchImpl, dbApi: db });
  const result = await client.syncOnce();
  assert.equal(result.skipped, true);
  assert.equal(called, 0);
});

test('syncOnce: receiver role → no-op (never pushes)', async () => {
  const db = makeFakeDb();
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200, json: async () => ({}) }; };
  const client = new SyncClient({ settings: makeSettings({ role: 'receiver' }), fetchImpl, dbApi: db });
  const result = await client.syncOnce();
  assert.equal(result.skipped, true);
  assert.equal(called, 0);
});

test('syncOnce: failures increase retry attempt; success resets it (backoff wiring)', async () => {
  const db = makeFakeDb();
  let fail = true;
  const fetchImpl = async () => fail
    ? { ok: false, status: 500, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ ok: true }) };
  const client = new SyncClient({ settings: makeSettings(), fetchImpl, dbApi: db });

  await client.syncOnce();
  const d1 = client.nextDelayMs();
  await client.syncOnce();
  const d2 = client.nextDelayMs();
  assert.ok(d2 > d1, `backoff should grow on consecutive failures (${d1} → ${d2})`);
  assert.ok(d1 < 30000 && d2 <= 30000, 'retry delays bounded');

  fail = false;
  await client.syncOnce();
  const d3 = client.nextDelayMs();
  assert.equal(d3, makeSettings().sync.intervalMs, 'after success, next delay = normal interval');
});

test('syncOnce: settings re-read each cycle via function (live settings changes)', async () => {
  const db = makeFakeDb();
  let enabled = false;
  let called = 0;
  const fetchImpl = async () => { called++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const client = new SyncClient({
    settings: () => makeSettings({ enabled }),
    fetchImpl, dbApi: db,
  });
  await client.syncOnce();
  assert.equal(called, 0, 'disabled — no POST');
  enabled = true;
  await client.syncOnce();
  assert.equal(called, 1, 'enabled without restart — POST happens');
});

test('SyncClient: start()/stop() manage timer cleanly (suite exits)', async () => {
  const db = makeFakeDb();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const client = new SyncClient({ settings: makeSettings({ intervalMs: 60000 }), fetchImpl, dbApi: db });
  client.start();
  assert.ok(client.isRunning());
  client.stop();
  assert.ok(!client.isRunning());
});

test('SYNC_TABLES covers the brief tables', () => {
  for (const t of ['students', 'speech_profiles', 'goals', 'commands', 'sessions', 'progress_points', 'phase_changes', 'decision_flags']) {
    assert.ok(SYNC_TABLES.includes(t), `${t} must be synced`);
  }
});
