/**
 * Tests that deleting a person removes ALL of their rows, everywhere
 * (Phase 2 Step 1, section 4 of the accounts plan — today deleteStudent only
 * touches students/student_profiles/correction_pairs, leaving commands, voice
 * turns, sessions, goals and progress behind). Run with:
 *   node --test src/delete-student.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import {
  initDatabase, closeDatabase, getDb,
  addStudent, deleteStudent, getStudent,
  insertCommand, insertSession, logVoiceTurn, recordCorrection, logResolution,
  saveStudentProfileRow, insertGoal, upsertProgressPoint, insertPhaseChange, insertDecisionFlag,
  setDeviceState, getDeviceState,
} from './db.js';

const dbPath = join(tmpdir(), `ablespeak-delete-test-${process.pid}-${Date.now()}.sqlite`);

/** Every row, anywhere, that carries this student's id, by table. */
function rowCounts(studentId) {
  const db = getDb();
  const count = (sql, params) => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    return row.n;
  };
  return {
    students: count('SELECT COUNT(*) AS n FROM students WHERE id = ?', [studentId]),
    student_profiles: count('SELECT COUNT(*) AS n FROM student_profiles WHERE student_id = ?', [studentId]),
    commands: count('SELECT COUNT(*) AS n FROM commands WHERE student_id = ?', [studentId]),
    sessions: count('SELECT COUNT(*) AS n FROM sessions WHERE student_id = ?', [studentId]),
    voice_turns: count('SELECT COUNT(*) AS n FROM voice_turns WHERE student_id = ?', [studentId]),
    correction_pairs: count('SELECT COUNT(*) AS n FROM correction_pairs WHERE student_id = ?', [studentId]),
    resolution_log: count('SELECT COUNT(*) AS n FROM resolution_log WHERE student_id = ?', [studentId]),
    goals: count('SELECT COUNT(*) AS n FROM goals WHERE student_id = ?', [studentId]),
    progress_points: count('SELECT COUNT(*) AS n FROM progress_points WHERE student_id = ?', [studentId]),
    phase_changes: count(
      'SELECT COUNT(*) AS n FROM phase_changes WHERE goal_id IN (SELECT id FROM goals WHERE student_id = ?)',
      [studentId],
    ),
    decision_flags: count(
      'SELECT COUNT(*) AS n FROM decision_flags WHERE goal_id IN (SELECT id FROM goals WHERE student_id = ?)',
      [studentId],
    ),
  };
}

/** Give a student at least one row in every table that references students. */
function populateEverything(name) {
  const student = addStudent({ name });
  const id = student.id;

  insertSession({ id: `sess-${uuidv4()}`, started_at: '2026-01-01 00:00:00', student_id: id });
  insertCommand({
    id: `cmd-${uuidv4()}`, type: 'voice', payload: { text: 'open word' }, result: {},
    latency_ms: 100, student_id: id, outcome: 'success',
  });
  logVoiceTurn({ student_id: id, outcome: 'command', transcript: 'open word' });
  recordCorrection({ student_id: id, heard: 'opun word', meant: 'open word' });
  logResolution({ app: 'word', method: 'uia', action: 'click', found: true, ok: true, ms: 10, student_id: id });
  saveStudentProfileRow(id, JSON.stringify({ listening: {}, vocabulary: [], aliases: [], macros: [] }));

  const goalId = uuidv4();
  insertGoal({
    id: goalId, student_id: id, measure: 'independence_rate',
    baseline_value: 10, baseline_date: '2026-01-01', target_value: 20, target_date: '2026-06-01',
  });
  upsertProgressPoint({ id: uuidv4(), goal_id: goalId, student_id: id, measured_at: '2026-01-02', value: 12 });
  insertPhaseChange({ id: uuidv4(), goal_id: goalId, changed_at: '2026-01-02', label: 'baseline' });
  insertDecisionFlag({ id: uuidv4(), goal_id: goalId, rule: '4_below_aim', fired_at: '2026-01-03', detail: 'test' });

  return student;
}

before(async () => {
  await initDatabase(dbPath);
});

after(() => {
  closeDatabase();
  try { rmSync(dbPath, { force: true }); } catch {}
  try { rmSync(dbPath + '.tmp', { force: true }); } catch {}
});

test('deleting a student removes every row of theirs, in every table', () => {
  const victim = populateEverything('Delete Me');
  const before = rowCounts(victim.id);
  // Sanity: the test actually put something in every table first.
  for (const [table, n] of Object.entries(before)) {
    assert.ok(n > 0, `expected at least one ${table} row before deleting`);
  }

  deleteStudent(victim.id);

  const after = rowCounts(victim.id);
  for (const [table, n] of Object.entries(after)) {
    assert.equal(n, 0, `${table} should have zero rows for a deleted student`);
  }
  assert.equal(getStudent(victim.id), null);
});

test('deleting a student never touches another person\'s rows', () => {
  const victim = populateEverything('Delete Me Too');
  const bystander = populateEverything('Leave Me Alone');
  const bystanderBefore = rowCounts(bystander.id);

  deleteStudent(victim.id);

  const bystanderAfter = rowCounts(bystander.id);
  assert.deepEqual(bystanderAfter, bystanderBefore, 'the other person\'s rows are untouched');
  assert.ok(getStudent(bystander.id), 'the other person still exists');
});

test('deleting the active student clears active_student_id in device_state', () => {
  const student = populateEverything('Was Active');
  setDeviceState('active_student_id', student.id);
  deleteStudent(student.id);
  assert.equal(getDeviceState('active_student_id'), null);
});

test('deleting a student clears their active_student_id only, not someone else\'s', () => {
  const student = populateEverything('Not Active');
  const other = populateEverything('Still Active');
  setDeviceState('active_student_id', other.id);
  deleteStudent(student.id);
  assert.equal(Number(getDeviceState('active_student_id')), other.id, 'another student\'s active flag is untouched');
});

test('deleting a student removes any windows_user link that points at them', () => {
  const student = populateEverything('Linked To Windows');
  const other = populateEverything('Also Linked');
  setDeviceState('windows_user:amina.k', student.id);
  setDeviceState('windows_user:brian', other.id);
  deleteStudent(student.id);
  assert.equal(getDeviceState('windows_user:amina.k'), null, 'the link to the deleted student is gone');
  assert.equal(Number(getDeviceState('windows_user:brian')), other.id, 'an unrelated link is untouched');
});
