/**
 * Tests for the user being whoever is signed in to Windows: their own
 * profile opens on start, is made once, and an earlier choice still wins.
 * Run with: node --test src/windows-user.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDatabase, closeDatabase, getStudents, addStudent, setDeviceState } from './db.js';
import { startDeviceSession, endDeviceSession, setActiveStudent, displayNameFor } from './student-session.js';

let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-winuser-'));
  await initDatabase(join(dir, 'ablespeak.db'));
});

after(() => {
  endDeviceSession();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

test('a Windows account name becomes a name to show', () => {
  assert.equal(displayNameFor('amina.k'), 'Amina K');
  assert.equal(displayNameFor('john_doe'), 'John Doe');
  assert.equal(displayNameFor('Derrick'), 'Derrick');
  assert.equal(displayNameFor(''), 'Me');
});

test('the person signed in to Windows gets their own profile, made once', () => {
  const first = startDeviceSession({ windowsAccount: 'amina.k' });
  assert.equal(first.student?.name, 'Amina K');
  endDeviceSession();
  const again = startDeviceSession({ windowsAccount: 'Amina.K' });
  assert.equal(again.student?.id, first.student.id, 'the same account (any case) opens the same profile');
  assert.equal(getStudents().filter(s => s.name === 'Amina K').length, 1);
});

test('an admin’s saved choice wins over the Windows account', () => {
  const other = addStudent({ name: 'Brian' });
  setActiveStudent(other.id);
  endDeviceSession();
  assert.equal(startDeviceSession({ windowsAccount: 'amina.k' }).student?.name, 'Brian');
});

test('another Windows account on the same computer gets a profile of its own', () => {
  setDeviceState('active_student_id', null);
  endDeviceSession();
  assert.equal(startDeviceSession({ windowsAccount: 'john_doe' }).student?.name, 'John Doe');
});

test('without a Windows account nobody is signed in, as before', () => {
  setDeviceState('active_student_id', null);
  endDeviceSession();
  assert.equal(startDeviceSession().student, null);
});

test('a user’s own progress counts only their commands, by day', async () => {
  const { insertCommand, getStudentProgress } = await import('./db.js');
  const me = addStudent({ name: 'Progress Me' });
  const someoneElse = addStudent({ name: 'Someone Else' });
  insertCommand({ id: 'p1', type: 'voice', payload: { text: 'Open Word' }, result: {}, latency_ms: 400, student_id: me.id, outcome: 'success' });
  insertCommand({ id: 'p2', type: 'voice', payload: { text: 'open word.' }, result: {}, latency_ms: 600, student_id: me.id, outcome: 'error' });
  insertCommand({ id: 'p3', type: 'voice', payload: { text: 'scroll down' }, result: {}, latency_ms: 200, student_id: me.id, outcome: 'superseded' });
  insertCommand({ id: 'p4', type: 'voice', payload: { text: 'open word' }, result: {}, latency_ms: 300, student_id: someoneElse.id, outcome: 'success' });
  const p = getStudentProgress(me.id, { since: '2000-01-01 00:00:00' });
  assert.equal(p.period.total, 2, 'the replaced try is not counted, nor someone else’s');
  assert.equal(p.period.succeeded, 1);
  assert.equal(p.allTime.total, 2);
  assert.deepEqual(p.topCommands, [{ text: 'open word', count: 2 }], 'the same words however they were written');
  assert.equal(p.days.length, 1);
  assert.deepEqual({ total: p.days[0].total, succeeded: p.days[0].succeeded }, { total: 2, succeeded: 1 });
});

test('loading a profile file into the signed-in profile keeps it, renamed', async () => {
  const express = (await import('express')).default;
  const { createApiRouter } = await import('./routes/api.js');
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ wsProxy: { broadcastToDashboard() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const guest = addStudent({ name: 'Guest' });
    const file = { kind: 'ablespeak-student-profile', student: { name: 'Amina K' }, profile: { vocabulary: ['Wanjiku'] } };
    const before = getStudents().length;
    const res = await fetch(`${url}/students/profile/import?into=${guest.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file),
    });
    const answer = await res.json();
    assert.equal(res.status, 200, JSON.stringify(answer));
    assert.equal(answer.student.id, guest.id, 'into the profile asked for');
    assert.equal(answer.student.name, 'Amina K', 'which takes the file’s name');
    assert.equal(answer.created, false);
    assert.equal(getStudents().length, before, 'no second profile');
    assert.deepEqual(answer.profile.vocabulary, ['Wanjiku']);

    const missing = await fetch(`${url}/students/profile/import?into=999999`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file),
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
