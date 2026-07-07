/**
 * T4 Sync DB Helpers Tests
 * Tests: getRowsSince, ingestRows, getSyncCursor, setSyncCursor, opt-in filter
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import {
  initDatabase, closeDatabase, getDb,
  upsertStudent, insertCommand, insertSession,
  getRowsSince, ingestRows, getSyncCursor, setSyncCursor,
} from './db.js';

function tmpFile(name) {
  return join(tmpdir(), `ablespeak-syncdb-test-${name}-${Date.now()}.db`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
    try { if (existsSync(p + '.tmp')) unlinkSync(p + '.tmp'); } catch {}
  }
}

// ── getSyncCursor / setSyncCursor ──

test('getSyncCursor returns "0" for unknown table', async () => {
  const path = tmpFile('cursor-init');
  try {
    await initDatabase(path);
    assert.equal(getSyncCursor('commands'), '0');
    assert.equal(getSyncCursor('sessions'), '0');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('setSyncCursor persists; getSyncCursor reads back', async () => {
  const path = tmpFile('cursor-rw');
  try {
    await initDatabase(path);
    setSyncCursor('commands', '42');
    assert.equal(getSyncCursor('commands'), '42');
    // Upsert
    setSyncCursor('commands', '99');
    assert.equal(getSyncCursor('commands'), '99');
    // Other tables unaffected
    assert.equal(getSyncCursor('sessions'), '0');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── getRowsSince – cursor and opt-in filter ──

test('getRowsSince: returns empty when no rows', async () => {
  const path = tmpFile('grs-empty');
  try {
    await initDatabase(path);
    const { rows, nextCursor } = getRowsSince('commands', '0');
    assert.equal(rows.length, 0);
    assert.equal(nextCursor, '0');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('getRowsSince: returns rows after cursor, advances nextCursor', async () => {
  const path = tmpFile('grs-cursor');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's1', display_name: 'Alice' });
    // Insert two commands
    insertCommand({ id: 'cmd-1', type: 'voice', direction: 'user_to_ai', student_id: 's1' });
    insertCommand({ id: 'cmd-2', type: 'voice', direction: 'user_to_ai', student_id: 's1' });

    const first = getRowsSince('commands', '0');
    assert.equal(first.rows.length, 2);
    assert.ok(parseInt(first.nextCursor) > 0, 'nextCursor should be > 0');
    // No _sync_cursor in returned rows
    assert.ok(!('_sync_cursor' in first.rows[0]), 'rows must not contain _sync_cursor');

    // Advance cursor - no new rows
    const second = getRowsSince('commands', first.nextCursor);
    assert.equal(second.rows.length, 0);
    assert.equal(second.nextCursor, first.nextCursor);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('getRowsSince: optInStudentIdsOnly excludes opt-out students and NULL student_id rows', async () => {
  const path = tmpFile('grs-optin');
  try {
    await initDatabase(path);
    upsertStudent({ id: 'opt-in', display_name: 'Alice' });
    upsertStudent({ id: 'opt-out', display_name: 'Bob' });
    // Set Bob opt-out
    getDb().run(`UPDATE students SET sync_opt_in=0 WHERE id='opt-out'`);

    // Commands for both + one with NULL student_id
    insertCommand({ id: 'cmd-A', type: 'voice', direction: 'user_to_ai', student_id: 'opt-in' });
    insertCommand({ id: 'cmd-B', type: 'voice', direction: 'user_to_ai', student_id: 'opt-out' });
    insertCommand({ id: 'cmd-null', type: 'voice', direction: 'user_to_ai', student_id: null });

    const { rows } = getRowsSince('commands', '0', { optInStudentIdsOnly: true });

    const ids = rows.map(r => r.id);
    assert.ok(ids.includes('cmd-A'), 'opt-in command should be present');
    assert.ok(!ids.includes('cmd-B'), 'opt-out command should be absent');
    assert.ok(!ids.includes('cmd-null'), 'null-student command should be absent');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('getRowsSince: students table filtered by sync_opt_in', async () => {
  const path = tmpFile('grs-students');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-in', display_name: 'Alice' });
    upsertStudent({ id: 's-out', display_name: 'Bob' });
    getDb().run(`UPDATE students SET sync_opt_in=0 WHERE id='s-out'`);

    const { rows } = getRowsSince('students', '0', { optInStudentIdsOnly: true });
    const ids = rows.map(r => r.id);
    assert.ok(ids.includes('s-in'));
    assert.ok(!ids.includes('s-out'));
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── ingestRows – evidence tables ──

test('ingestRows: evidence table INSERT OR IGNORE is idempotent', async () => {
  const path = tmpFile('ingest-idem');
  try {
    await initDatabase(path);
    const rows = [{ id: 'cmd-x', type: 'voice', direction: 'user_to_ai', student_id: null }];
    const r1 = ingestRows('commands', rows, 'device-A');
    assert.equal(r1.inserted, 1);
    assert.equal(r1.skipped, 0);

    const r2 = ingestRows('commands', rows, 'device-A');
    assert.equal(r2.inserted, 0);
    assert.equal(r2.skipped, 1);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('ingestRows: stamps origin_device on commands', async () => {
  const path = tmpFile('ingest-origin');
  try {
    await initDatabase(path);
    ingestRows('commands', [{ id: 'cmd-od', type: 'voice', direction: 'user_to_ai', student_id: null }], 'sender-device-1');
    const db = getDb();
    const stmt = db.prepare(`SELECT origin_device FROM commands WHERE id='cmd-od'`);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    assert.equal(row.origin_device, 'sender-device-1');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── ingestRows – mutable tables (last-write-wins) ──

test('ingestRows: students mutable – newer row wins', async () => {
  const path = tmpFile('ingest-mutable');
  try {
    await initDatabase(path);
    // Local row with older updated_at (LWW now compares updated_at, not created_at)
    getDb().run(`INSERT INTO students (id, display_name, updated_at) VALUES ('s-mutable','OldName','2024-01-01 00:00:00')`);

    // Ingest newer row (updated_at later → wins)
    const r1 = ingestRows('students', [{ id: 's-mutable', display_name: 'NewName', active: 1, updated_at: '2025-01-01 00:00:00', sync_opt_in: 1 }], 'dev');
    assert.equal(r1.inserted, 1);
    const stmt = getDb().prepare(`SELECT display_name FROM students WHERE id='s-mutable'`);
    stmt.step();
    const after = stmt.getAsObject();
    stmt.free();
    assert.equal(after.display_name, 'NewName');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('ingestRows: students mutable – older row does not overwrite', async () => {
  const path = tmpFile('ingest-mutable-skip');
  try {
    await initDatabase(path);
    // Local row with newer updated_at
    getDb().run(`INSERT INTO students (id, display_name, updated_at) VALUES ('s-new','CurrentName','2025-06-01 00:00:00')`);

    // Ingest older row (updated_at earlier → skipped by LWW)
    const r1 = ingestRows('students', [{ id: 's-new', display_name: 'StaleOldName', active: 1, updated_at: '2024-01-01 00:00:00', sync_opt_in: 1 }], 'dev');
    assert.equal(r1.skipped, 1, 'older incoming row should be skipped');
    const stmt = getDb().prepare(`SELECT display_name FROM students WHERE id='s-new'`);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    assert.equal(row.display_name, 'CurrentName', 'local name must not be overwritten by stale row');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('ingestRows: empty rows returns zero counts', async () => {
  const path = tmpFile('ingest-empty');
  try {
    await initDatabase(path);
    const r = ingestRows('commands', [], 'device-X');
    assert.equal(r.inserted, 0);
    assert.equal(r.skipped, 0);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});
