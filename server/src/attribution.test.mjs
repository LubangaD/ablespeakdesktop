/**
 * Attribution integration test — db-level, no sockets.
 * Proves two-student session attribution correctness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import {
  initDatabase, closeDatabase, getDb,
  upsertStudent, getStudents,
  insertSession, endSession,
  insertCommand, getCommands,
} from './db.js';
import { v4 as uuidv4 } from 'uuid';

function tmpFile(name) {
  return join(tmpdir(), `ablespeak-test-${name}-${Date.now()}.db`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
    try { if (existsSync(p + '.tmp')) unlinkSync(p + '.tmp'); } catch {}
  }
}

test('attribution: two-student session correctness', async () => {
  const path = tmpFile('attribution');
  try {
    await initDatabase(path);

    // Seed two students
    const idA = uuidv4();
    const idB = uuidv4();
    upsertStudent({ id: idA, display_name: 'Alice Brown', external_ref: 'EXT-A' });
    upsertStudent({ id: idB, display_name: 'Bob Smith', external_ref: 'EXT-B' });

    const students = getStudents();
    assert.equal(students.length, 2);

    // Start session A
    const sessionAId = uuidv4();
    insertSession({ id: sessionAId, started_at: new Date().toISOString(), student_id: idA });

    // Insert 2 commands attributed to student A
    insertCommand({
      id: uuidv4(), type: 'voice', direction: 'user_to_ai',
      payload: '{}', result: '{}', latency_ms: 100,
      session_id: sessionAId, student_id: idA,
    });
    insertCommand({
      id: uuidv4(), type: 'voice_fast', direction: 'user_to_ai',
      payload: '{}', result: '{}', latency_ms: 50,
      session_id: sessionAId, student_id: idA,
    });

    // End session A
    endSession(sessionAId);

    // Start session B
    const sessionBId = uuidv4();
    insertSession({ id: sessionBId, started_at: new Date().toISOString(), student_id: idB });

    // Insert 1 command attributed to student B
    insertCommand({
      id: uuidv4(), type: 'voice', direction: 'user_to_ai',
      payload: '{}', result: '{}', latency_ms: 80,
      session_id: sessionBId, student_id: idB,
    });

    // Query and verify attribution
    const allCmds = getCommands({ limit: 10 });
    assert.equal(allCmds.length, 3, 'should have 3 commands total');

    const aCmds = allCmds.filter(c => c.student_id === idA);
    const bCmds = allCmds.filter(c => c.student_id === idB);
    assert.equal(aCmds.length, 2, 'student A should have 2 commands');
    assert.equal(bCmds.length, 1, 'student B should have 1 command');

    // Verify session A has ended_at set
    const db = getDb();
    const sessionARow = db.exec(`SELECT * FROM sessions WHERE id='${sessionAId}'`);
    const sessionAData = sessionARow[0]?.values[0];
    assert.ok(sessionAData, 'session A row should exist');
    // columns: id, started_at, ended_at, command_count, prompt_switches, student_id
    const cols = sessionARow[0].columns;
    const endedAtIdx = cols.indexOf('ended_at');
    assert.ok(sessionAData[endedAtIdx], 'session A ended_at should be set');

    // Verify session B has no ended_at
    const sessionBRow = db.exec(`SELECT * FROM sessions WHERE id='${sessionBId}'`);
    const sessionBData = sessionBRow[0]?.values[0];
    const sessionBEndedAt = sessionBData[endedAtIdx];
    assert.equal(sessionBEndedAt, null, 'session B ended_at should be null');

    // Verify session student_id attribution
    const studentIdIdx = cols.indexOf('student_id');
    assert.equal(sessionAData[studentIdIdx], idA, 'session A student_id matches');
    const sessionBStudentId = sessionBData[studentIdIdx];
    assert.equal(sessionBStudentId, idB, 'session B student_id matches');

  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('attribution: insertSession accepts student_id additively (old callers work)', async () => {
  const path = tmpFile('attr-compat');
  try {
    await initDatabase(path);
    // Old-style call without student_id — must not throw
    const sid = uuidv4();
    insertSession({ id: sid, started_at: new Date().toISOString() });
    const db = getDb();
    const row = db.exec(`SELECT id FROM sessions WHERE id='${sid}'`);
    assert.equal(row[0]?.values[0][0], sid);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('attribution: endSession sets ended_at', async () => {
  const path = tmpFile('attr-end');
  try {
    await initDatabase(path);
    const sid = uuidv4();
    insertSession({ id: sid, started_at: new Date().toISOString(), student_id: 's-test' });
    endSession(sid);
    const db = getDb();
    const row = db.exec(`SELECT ended_at FROM sessions WHERE id='${sid}'`);
    assert.ok(row[0]?.values[0][0], 'ended_at should be set after endSession');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});
