/**
 * T4 Two-DB Integration Test — no sockets, two temp DB files.
 *
 * The db module is a singleton, so the sequence is:
 *   Phase 1: init SENDER DB → seed → buildSyncBatch (opt-in filter ON) → encrypt → close
 *   Phase 2: init RECEIVER DB → decrypt → ingestRows → assert → close
 *
 * Proves the acceptance criteria:
 *   - opt-in student's data flows device → device with origin_device stamped
 *   - opt-out student's rows NEVER leave the sender (asserted on the DECRYPTED
 *     payload itself, not just the receiver DB)
 *   - re-ingesting the same payload is idempotent (all skipped)
 *   - the opt-in student's speech profile row is upserted on the receiver
 *   - a wrong classroomKey cannot decrypt the payload
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import {
  initDatabase, closeDatabase, getDb,
  upsertStudent, insertCommand, saveSpeechProfile,
  getRowsSince, ingestRows,
} from './db.js';
import { buildSyncBatch, SYNC_TABLES } from './sync-client.js';
import { encryptPayload, decryptPayload } from './sync-crypto.js';

const KEY = 'integration-classroom-key';
const SENDER_DEVICE = 'student-laptop-A';

function tmpFile(name) {
  return join(tmpdir(), `ablespeak-integration-${name}-${Date.now()}.db`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
    try { if (existsSync(p + '.tmp')) unlinkSync(p + '.tmp'); } catch {}
  }
}

function queryAll(sql) {
  const stmt = getDb().prepare(sql);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

test('two-DB sync: opt-in flows with origin_device; opt-out never leaves sender; idempotent; wrong key rejected', async () => {
  const senderPath = tmpFile('sender');
  const receiverPath = tmpFile('receiver');

  try {
    // ══ Phase 1: SENDER DB ══
    await initDatabase(senderPath);

    // Student A: opt-in (default). Student B: opt-out.
    upsertStudent({ id: 'stu-A', display_name: 'Alice OptIn' });
    upsertStudent({ id: 'stu-B', display_name: 'Bob OptOut' });
    getDb().run(`UPDATE students SET sync_opt_in=0 WHERE id='stu-B'`);

    // Commands for both + one unattributed (NULL student)
    insertCommand({ id: 'cmd-A1', type: 'voice', direction: 'user_to_ai', student_id: 'stu-A', outcome: 'success' });
    insertCommand({ id: 'cmd-A2', type: 'voice', direction: 'user_to_ai', student_id: 'stu-A', outcome: 'success' });
    insertCommand({ id: 'cmd-B1', type: 'voice', direction: 'user_to_ai', student_id: 'stu-B', outcome: 'success' });
    insertCommand({ id: 'cmd-null', type: 'voice', direction: 'user_to_ai', student_id: null });

    // Speech profiles for both students
    saveSpeechProfile({ id: 'prof-A', student_id: 'stu-A', min_confidence: 0.3 });
    saveSpeechProfile({ id: 'prof-B', student_id: 'stu-B', min_confidence: 0.6 });

    // Build the batch exactly as the sender does — opt-in filter ON at payload build time
    const cursors = Object.fromEntries(SYNC_TABLES.map(t => [t, '0']));
    const { batches, empty } = buildSyncBatch(
      SYNC_TABLES,
      (table, cursor) => getRowsSince(table, cursor, { optInStudentIdsOnly: true }),
      cursors,
    );
    assert.equal(empty, false);

    const pkg = encryptPayload({ batches }, KEY);
    await closeDatabase();

    // ── Assert on the DECRYPTED PAYLOAD (what actually left the device) ──
    const payload = decryptPayload(pkg, KEY);
    const wire = JSON.stringify(payload);

    const cmdBatch = payload.batches.find(b => b.table === 'commands');
    const cmdIds = cmdBatch.rows.map(r => r.id);
    assert.ok(cmdIds.includes('cmd-A1') && cmdIds.includes('cmd-A2'), 'opt-in commands in payload');
    assert.ok(!cmdIds.includes('cmd-B1'), 'opt-out student commands must NOT be in the payload');
    assert.ok(!cmdIds.includes('cmd-null'), 'NULL-student commands must NOT be in the payload');
    assert.ok(!wire.includes('stu-B'), 'no trace of the opt-out student anywhere in the payload');
    assert.ok(!wire.includes('Bob OptOut'), 'opt-out student name must not leave the device');
    assert.ok(!wire.includes('prof-B'), 'opt-out student profile must not leave the device');

    const stuBatch = payload.batches.find(b => b.table === 'students');
    assert.deepEqual(stuBatch.rows.map(r => r.id), ['stu-A'], 'only opt-in student row synced');

    const profBatch = payload.batches.find(b => b.table === 'speech_profiles');
    assert.deepEqual(profBatch.rows.map(r => r.id), ['prof-A'], 'only opt-in profile synced');

    // ── Wrong classroomKey → decrypt throws ──
    assert.throws(() => decryptPayload(pkg, 'wrong-classroom-key'), /Decryption failed/);

    // ══ Phase 2: RECEIVER DB ══
    await initDatabase(receiverPath);

    const received = decryptPayload(pkg, KEY);
    const firstCounts = {};
    for (const b of received.batches) {
      firstCounts[b.table] = ingestRows(b.table, b.rows, SENDER_DEVICE);
    }

    // A's commands present with origin_device stamped
    const cmds = queryAll(`SELECT id, student_id, origin_device FROM commands ORDER BY id`);
    assert.deepEqual(cmds.map(c => c.id), ['cmd-A1', 'cmd-A2']);
    for (const c of cmds) {
      assert.equal(c.student_id, 'stu-A');
      assert.equal(c.origin_device, SENDER_DEVICE, 'origin_device must identify the sending device');
    }

    // B's data absent from receiver too (it never arrived)
    const stuRows = queryAll(`SELECT id FROM students`);
    assert.deepEqual(stuRows.map(r => r.id), ['stu-A']);

    // A's speech profile upserted
    const profRows = queryAll(`SELECT id, student_id, min_confidence FROM speech_profiles`);
    assert.equal(profRows.length, 1);
    assert.equal(profRows[0].id, 'prof-A');
    assert.equal(profRows[0].min_confidence, 0.3);

    // ── Idempotent re-ingest: same payload again → everything skipped ──
    for (const b of received.batches) {
      const again = ingestRows(b.table, b.rows, SENDER_DEVICE);
      assert.equal(again.inserted, 0, `${b.table}: second ingest must insert nothing`);
      assert.equal(again.skipped, b.rows.length, `${b.table}: all rows skipped on re-ingest`);
    }

    // No duplicates appeared
    const cmdsAfter = queryAll(`SELECT id FROM commands`);
    assert.equal(cmdsAfter.length, 2);
  } finally {
    await closeDatabase();
    cleanup(senderPath, receiverPath);
  }
});

test('two-DB sync: mutable profile update flows on second cycle (last-write-wins)', async () => {
  const senderPath = tmpFile('sender-lww');
  const receiverPath = tmpFile('receiver-lww');

  try {
    // Sender: student + profile v1
    await initDatabase(senderPath);
    upsertStudent({ id: 'stu-L', display_name: 'Lena' });
    saveSpeechProfile({ id: 'prof-L', student_id: 'stu-L', min_confidence: 0.4 });
    let { rows: profRows1 } = getRowsSince('speech_profiles', '0', { optInStudentIdsOnly: true });
    const pkg1 = encryptPayload({ batches: [{ table: 'speech_profiles', rows: profRows1, nextCursor: '1' }] }, KEY);

    // Sender updates the profile (newer updated_at) — force a later timestamp
    getDb().run(`UPDATE speech_profiles SET min_confidence=0.7, updated_at=datetime('now','localtime','+1 hour') WHERE id='prof-L'`);
    let { rows: profRows2 } = getRowsSince('speech_profiles', '0', { optInStudentIdsOnly: true });
    const pkg2 = encryptPayload({ batches: [{ table: 'speech_profiles', rows: profRows2, nextCursor: '1' }] }, KEY);
    await closeDatabase();

    // Receiver: ingest v1 then v2 — v2 (newer) wins; re-ingesting v1 (older) is skipped
    await initDatabase(receiverPath);
    for (const b of decryptPayload(pkg1, KEY).batches) ingestRows(b.table, b.rows, 'dev-L');
    for (const b of decryptPayload(pkg2, KEY).batches) ingestRows(b.table, b.rows, 'dev-L');

    let rows = queryAll(`SELECT min_confidence FROM speech_profiles WHERE id='prof-L'`);
    assert.equal(rows[0].min_confidence, 0.7, 'newer profile version wins');

    // Stale v1 re-ingest must NOT downgrade
    for (const b of decryptPayload(pkg1, KEY).batches) {
      const r = ingestRows(b.table, b.rows, 'dev-L');
      assert.equal(r.inserted, 0, 'stale row must be skipped');
    }
    rows = queryAll(`SELECT min_confidence FROM speech_profiles WHERE id='prof-L'`);
    assert.equal(rows[0].min_confidence, 0.7, 'stale row did not overwrite newer data');
  } finally {
    await closeDatabase();
    cleanup(senderPath, receiverPath);
  }
});
