/**
 * Regression tests for command→student attribution (TCH-1). Run with:
 *   node --test src/db.test.mjs
 *
 * Before TCH-1, every insertCommand() call site in ws-proxy.js omitted
 * session_id, so it was always NULL — and getTeacherAnalytics()'s
 * `session_id LIKE '<student.session_prefix>%'` join can never match NULL in
 * SQLite, so 0 commands ever attributed to any student regardless of real
 * usage. These tests exercise db.js directly against a throwaway sqlite file.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { initDatabase, closeDatabase, insertCommand, addStudent, getTeacherAnalytics } from './db.js';

const dbPath = join(tmpdir(), `ablespeak-test-${process.pid}-${Date.now()}.sqlite`);

before(async () => {
  await initDatabase(dbPath);
});

after(() => {
  closeDatabase();
  try { rmSync(dbPath, { force: true }); } catch {}
  try { rmSync(dbPath + '.tmp', { force: true }); } catch {}
});

test('a command with no session_id (the pre-TCH-1 bug) attributes to nobody', () => {
  const student = addStudent({ name: 'Unattributed Test', session_prefix: 'unattributed-test' });
  insertCommand({
    id: 'cmd-null-session',
    type: 'voice',
    direction: 'user_to_ai',
    payload: '{}',
    result: '{"status":"success"}',
    latency_ms: 50,
    // session_id intentionally omitted — this was the bug.
  });

  const { students } = getTeacherAnalytics();
  const row = students.find(s => s.id === student.id);
  assert.equal(row.commands, 0, 'a NULL session_id must never match any student');
});

test('TCH-1: a command tagged with a session_id sharing the student prefix attributes correctly', () => {
  const student = addStudent({ name: 'Attributed Test', session_prefix: 'attributed-test' });
  insertCommand({
    id: 'cmd-attributed-1',
    type: 'voice',
    direction: 'user_to_ai',
    payload: '{}',
    result: '{"status":"success"}',
    latency_ms: 120,
    session_id: 'attributed-test-abc123', // shape ws-proxy.js now generates: `${prefix}-${uuid}`
  });
  insertCommand({
    id: 'cmd-attributed-2',
    type: 'voice_fast',
    direction: 'user_to_ai',
    payload: '{}',
    result: '{"status":"error","error":"boom"}',
    latency_ms: 80,
    session_id: 'attributed-test-def456',
  });

  const { students } = getTeacherAnalytics();
  const row = students.find(s => s.id === student.id);
  assert.equal(row.commands, 2);
  assert.equal(row.successRate, 50); // 1 of 2 results contained "error"
});

test('a session_id that does not share the prefix is not misattributed to an unrelated student', () => {
  const student = addStudent({ name: 'Other Student', session_prefix: 'other-student' });
  insertCommand({
    id: 'cmd-unrelated',
    type: 'voice',
    direction: 'user_to_ai',
    payload: '{}',
    result: '{"status":"success"}',
    latency_ms: 90,
    session_id: 'some-completely-different-session-999',
  });

  const { students } = getTeacherAnalytics();
  const row = students.find(s => s.id === student.id);
  assert.equal(row.commands, 0);
});

test('the class success rate uses the same rule as each student\'s rate', () => {
  const student = addStudent({ name: 'Rate Student', session_prefix: 'rate-student' });
  const base = { direction: 'user_to_ai', payload: '{}', latency_ms: 50, student_id: student.id };
  insertCommand({ ...base, id: 'rate-1', type: 'voice_fast', result: '{"status":"error"}', outcome: 'superseded' });
  insertCommand({ ...base, id: 'rate-2', type: 'voice_fast', result: '{}', outcome: 'repaired' });
  insertCommand({ ...base, id: 'rate-3', type: 'voice', result: '{}', outcome: 'error' });
  // Typed on the Chat page: no outcome, so it doesn't count either way.
  insertCommand({ ...base, id: 'rate-4', type: 'chat', result: '{"text":"Error handling explained"}' });

  const { summary, students } = getTeacherAnalytics();
  const row = students.find(s => s.id === student.id);
  assert.equal(row.successRate, 50); // repaired counts, the superseded try doesn't
  const everyone = students.filter(s => s.commands > 0);
  const tried = everyone.reduce((n, s) => n + s.commands, 0);
  const worked = everyone.reduce((n, s) => n + Math.round(s.successRate * s.commands / 100), 0);
  assert.equal(summary.successRate, Math.round((worked / tried) * 100));
});
