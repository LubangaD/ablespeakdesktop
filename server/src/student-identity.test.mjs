/**
 * Tests for real student identity (AT-50) and task outcomes for the progress
 * engine: who a command belongs to, sessions, retries and corrections.
 * Run with: node --test src/student-identity.test.mjs
 *
 * Uses a throwaway database file and a real express app on a local port.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initDatabase, closeDatabase, getDb, addStudent, deleteStudent, insertCommand,
  getTeacherAnalytics, getSessions, getCommands, setDeviceState,
} from './db.js';
import {
  startDeviceSession, endDeviceSession, setActiveStudent, getActiveStudent, commandAttribution,
} from './student-session.js';
import { WsProxy, isLikelyRetry, aiCommandFailed } from './ws-proxy.js';
import { computeProbeValue } from './probe-computer.js';
import { localDate, localDateTime, addDays } from './local-time.js';
import { createApiRouter } from './routes/api.js';

let dir, dbPath;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-identity-'));
  dbPath = join(dir, 'ablespeak.db');
  await initDatabase(dbPath);
  startDeviceSession();
});

after(() => {
  endDeviceSession();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

async function restartApp() {
  endDeviceSession();
  closeDatabase();
  await initDatabase(dbPath);
  return startDeviceSession();
}

const commandsById = () => Object.fromEntries(getCommands({ limit: 500 }).map(c => [c.id, c]));

// ── Who is using this computer ─────────────────────────────────────────────

test('the chosen student survives an app restart', async () => {
  const amina = addStudent({ name: 'Amina' });
  setActiveStudent(amina.id);
  const after = await restartApp();
  assert.equal(after.student?.name, 'Amina');
  assert.deepEqual(commandAttribution(), { session_id: after.sessionId, student_id: amina.id });
});

test('voice commands are saved against the chosen student and session', () => {
  const brian = addStudent({ name: 'Brian' });
  const { sessionId } = setActiveStudent(brian.id);
  insertCommand({ id: 'brian-1', type: 'voice', result: { status: 'success' }, ...commandAttribution() });
  insertCommand({ id: 'brian-chat', type: 'chat', result: {}, ...commandAttribution() });

  const row = getTeacherAnalytics().students.find(s => s.id === brian.id);
  assert.equal(row.commands, 1, 'chat traffic is never a student\'s data');
  const session = getSessions({ studentId: brian.id }).find(s => s.id === sessionId);
  assert.equal(session.command_count, 2);
});

test('switching students ends the previous session and starts a new one', () => {
  const chege = addStudent({ name: 'Chege' });
  const dina = addStudent({ name: 'Dina' });
  const first = setActiveStudent(chege.id);
  const second = setActiveStudent(dina.id);
  assert.notEqual(first.sessionId, second.sessionId);
  const ended = getSessions({ studentId: chege.id }).find(s => s.id === first.sessionId);
  assert.ok(ended.ended_at, 'the earlier session has an end time');
  assert.equal(getActiveStudent().student.name, 'Dina');
});

test('choosing nobody records commands without a student', () => {
  setActiveStudent(null);
  assert.equal(commandAttribution().student_id, null);
  assert.throws(() => setActiveStudent(999999), /Student not found/);
});

test('a removed student is not restored after a restart', async () => {
  const eli = addStudent({ name: 'Eli' });
  setActiveStudent(eli.id);
  deleteStudent(eli.id);
  const after = await restartApp();
  assert.equal(after.student, null);
});

test('commands saved under the old name-prefix scheme are matched once', async () => {
  const faith = addStudent({ name: 'Faith', session_prefix: 'faith-laptop' });
  getDb().run(`INSERT INTO commands (id, type, session_id, student_id) VALUES ('legacy-1', 'voice', 'faith-laptop-123', NULL)`);
  setDeviceState('prefix_attribution_migrated', null);
  await restartApp();
  assert.equal(commandsById()['legacy-1'].student_id, faith.id);
});

// ── API ────────────────────────────────────────────────────────────────────

test('the Teacher page can read and change who is using the computer', async () => {
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ wsProxy: { broadcastToDashboard: m => broadcasts.push(m) } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { Host: `localhost:${port}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  try {
    const created = await call('POST', '/api/teacher/students', { name: '  Grace  ' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Grace');
    assert.equal((await call('POST', '/api/teacher/students', { name: '   ' })).status, 400);

    const chosen = await call('PUT', '/api/students/active', { student_id: created.body.id });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.student.name, 'Grace');
    assert.equal(broadcasts.at(-1).type, 'active_student');
    assert.equal((await call('GET', '/api/students/active')).body.student.name, 'Grace');

    assert.equal((await call('PUT', '/api/students/active', { student_id: '7' })).status, 400);
    assert.equal((await call('PUT', '/api/students/active', { student_id: 424242 })).status, 404);

    // Removing the chosen student clears the choice.
    await call('DELETE', `/api/teacher/students/${created.body.id}`);
    assert.equal((await call('GET', '/api/students/active')).body.student, null);

    // Another website open in the browser cannot read students' data.
    const foreign = await call('GET', '/api/teacher/students', undefined, { Origin: 'https://example.com' });
    assert.equal(foreign.status, 403);
  } finally {
    server.close();
  }
});

// ── Tasks, retries and corrections ─────────────────────────────────────────

function makeProxy() {
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null, attribution: commandAttribution });
  proxy._heartbeatInterval?.unref?.();
  proxy._broadcastDashboard = () => {};
  return proxy;
}

test('a failed command tried again counts as one repaired task', () => {
  const hana = addStudent({ name: 'Hana' });
  setActiveStudent(hana.id);
  const proxy = makeProxy();
  proxy._recordVoiceCommand({ id: 'hana-1', type: 'voice_fast', text: 'scroll town', payload: {}, result: { status: 'error' }, failed: true });
  proxy._recordVoiceCommand({ id: 'hana-2', type: 'voice_fast', text: 'scroll down', payload: {}, result: { status: 'success' }, failed: false });

  const rows = commandsById();
  assert.equal(rows['hana-1'].outcome, 'superseded');
  assert.equal(rows['hana-2'].outcome, 'repaired');
  assert.equal(rows['hana-2'].prompt_count, 1);
  assert.equal(rows['hana-2'].student_id, hana.id);
});

test('a different command after a failure is a new task', () => {
  const proxy = makeProxy();
  proxy._recordVoiceCommand({ id: 'new-1', type: 'voice_fast', text: 'open chrome', payload: {}, result: {}, failed: true });
  proxy._recordVoiceCommand({ id: 'new-2', type: 'voice_fast', text: 'open word', payload: {}, result: {}, failed: false });
  const rows = commandsById();
  assert.equal(rows['new-1'].outcome, 'error');
  assert.equal(rows['new-2'].outcome, 'success');
  assert.equal(rows['new-2'].prompt_count, 0);
});

test('"no, I meant …" marks the wrong command and repairs the task', () => {
  const proxy = makeProxy();
  proxy._recordVoiceCommand({ id: 'fix-1', type: 'voice_fast', text: 'open spotify', payload: {}, result: {}, failed: false });
  const wrong = proxy._markLastCommandWrong();
  proxy._recordVoiceCommand({ id: 'fix-2', type: 'voice_fast', text: 'word', payload: {}, result: {}, failed: false, retryOf: wrong });
  const rows = commandsById();
  assert.equal(rows['fix-1'].outcome, 'superseded');
  assert.equal(rows['fix-2'].outcome, 'repaired');
});

test('"undo that" turns a success into a failure', () => {
  const proxy = makeProxy();
  proxy._recordVoiceCommand({ id: 'undo-1', type: 'voice_fast', text: 'close tab', payload: {}, result: {}, failed: false });
  proxy._markLastCommandWrong();
  assert.equal(commandsById()['undo-1'].outcome, 'error');
});

test("a correction never reaches into another student's session", () => {
  const ada = addStudent({ name: 'Ada' });
  setActiveStudent(ada.id);
  const proxy = makeProxy();
  proxy._recordVoiceCommand({ id: 'ada-1', type: 'voice_fast', text: 'close tab', payload: {}, result: {}, failed: true });

  const ben = addStudent({ name: 'Ben' });
  setActiveStudent(ben.id);
  assert.equal(proxy._markLastCommandWrong(), null, "nothing of Ben's to undo");
  proxy._recordVoiceCommand({ id: 'ben-1', type: 'voice_fast', text: 'close tab', payload: {}, result: {}, failed: false });

  const rows = commandsById();
  assert.equal(rows['ada-1'].outcome, 'error', "Ada's row is untouched");
  assert.equal(rows['ben-1'].outcome, 'success', "not a repair of Ada's try");
  assert.equal(rows['ben-1'].student_id, ben.id);
});

test('retry detection', () => {
  assert.equal(isLikelyRetry('scroll town', 'scroll down'), true);
  assert.equal(isLikelyRetry('open chrome', 'open google chrome'), true);
  assert.equal(isLikelyRetry('click the submit button', 'click submit'), true);
  assert.equal(isLikelyRetry('open chrome', 'open word'), false);
  assert.equal(isLikelyRetry('scroll down', 'play music'), false);
  assert.equal(isLikelyRetry('', 'play music'), false);
});

test('an AI turn that did nothing counts as a failure', () => {
  assert.equal(aiCommandFailed({ text: 'Opened it', toolCalls: [{ tool: 'x', result: { status: 'success' } }] }), false);
  assert.equal(aiCommandFailed({ text: 'It is 3 pm.', toolCalls: null }), false);
  assert.equal(aiCommandFailed({ text: 'I did not perform any action…', toolCalls: null, noAction: true }), true);
  assert.equal(aiCommandFailed({ toolCalls: [{ tool: 'x', result: { status: 'error' } }] }), true);
  assert.equal(aiCommandFailed({ error: true }), true);
});

test('progress measures count each task once', () => {
  const rows = [
    { outcome: 'superseded', prompt_count: 0 },
    { outcome: 'repaired', prompt_count: 1 },
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'error', prompt_count: 0 },
  ];
  assert.deepEqual(computeProbeValue('task_completion', rows), { value: 3 / 4, sampleSize: 4 });
  assert.deepEqual(computeProbeValue('independence_rate', rows), { value: 2 / 4, sampleSize: 4 });
});

// ── Local dates ────────────────────────────────────────────────────────────

test('days are counted in local time, like the saved commands', () => {
  const lateNight = new Date(2026, 8, 17, 1, 30, 0); // 01:30 local
  assert.equal(localDate(lateNight), '2026-09-17');
  assert.equal(localDateTime(lateNight), '2026-09-17 01:30:00');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
