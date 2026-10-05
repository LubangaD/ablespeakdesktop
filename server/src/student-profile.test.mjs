/**
 * Tests for Stage 1 speech profiles: listening settings, vocabulary,
 * shortcuts, the recognition readout, and moving a profile between
 * computers. Run with: node --test src/student-profile.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDatabase, closeDatabase, getDb, addStudent, deleteStudent, getStudents, logVoiceTurn, insertCommand, getRecognitionStats, getRetriesAround } from './db.js';
import {
  normaliseProfile, getProfile, saveProfile, listeningSettings, expandAlias, findMacro,
} from './student-profile.js';
import { startDeviceSession, endDeviceSession, setActiveStudent, commandAttribution } from './student-session.js';
import { transcriptionPrompt } from './voice-handler.js';
import { WsProxy } from './ws-proxy.js';
import { createApiRouter } from './routes/api.js';

let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-profile-'));
  await initDatabase(join(dir, 'ablespeak.db'));
  startDeviceSession();
});

after(() => {
  endDeviceSession();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// ── The profile itself ─────────────────────────────────────────────────────

test('an empty profile gets the standard settings', () => {
  const { profile, errors } = normaliseProfile({});
  assert.deepEqual(errors, []);
  assert.deepEqual(profile.listening, { sensitivity: 'standard', pauseSeconds: 1.5 });
  assert.deepEqual(profile.vocabulary, []);
});

test('a profile is tidied: blanks and repeats dropped, spaces trimmed', () => {
  const { profile, errors } = normaliseProfile({
    vocabulary: ['  Amina ', 'amina', '', 'Kiswahili'],
    aliases: [{ say: ' My music ', means: ' open spotify ' }, { say: '', means: '' }],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(profile.vocabulary, ['Amina', 'Kiswahili']);
  assert.deepEqual(profile.aliases, [{ say: 'My music', means: 'open spotify' }]);
});

test('every problem is reported, not just the first', () => {
  const { errors } = normaliseProfile({
    listening: { sensitivity: 'loud', pauseSeconds: 9 },
    aliases: [{ say: 'go', means: '' }],
    macros: [{ name: 'homework', steps: [] }],
  });
  assert.equal(errors.length, 4, errors.join(' | '));
});

test('saving merges changes into what is already saved', () => {
  const student = addStudent({ name: 'Joy' });
  saveProfile(student.id, { vocabulary: ['Joy'] });
  saveProfile(student.id, { listening: { pauseSeconds: 2.5 } });
  const profile = getProfile(student.id);
  assert.deepEqual(profile.vocabulary, ['Joy']);
  assert.deepEqual(profile.listening, { sensitivity: 'standard', pauseSeconds: 2.5 });
  assert.throws(() => saveProfile(student.id, { listening: { sensitivity: 'shouty' } }), /sensitivity/);
});

test('a quiet speaker gets lower levels; a slow speaker a longer pause', () => {
  const quiet = listeningSettings(normaliseProfile({ listening: { sensitivity: 'quiet', pauseSeconds: 3 } }).profile);
  const standard = listeningSettings(normaliseProfile({}).profile);
  assert.ok(quiet.speechThreshold < standard.speechThreshold);
  assert.equal(quiet.commandPauseMs, 3000);
  assert.equal(quiet.dictationPauseMs, 3300);
  assert.equal(standard.dictationPauseMs, 1800, 'dictation never waits less than before');
});

test('a noisy room turns off automatic gain and the "say it louder" prompt; soft speakers keep gain', () => {
  const noisy = listeningSettings(normaliseProfile({ listening: { sensitivity: 'noisy' } }).profile);
  const quiet = listeningSettings(normaliseProfile({ listening: { sensitivity: 'quiet' } }).profile);
  const standard = listeningSettings(normaliseProfile({}).profile);
  assert.equal(noisy.autoGain, false, 'distant voices are not turned up');
  assert.equal(noisy.quietThreshold, noisy.speechThreshold, 'no "too quiet" band for background talk');
  assert.equal(quiet.autoGain, true);
  assert.equal(standard.autoGain, true);
});

test('a shortcut matches the whole phrase, whatever the case or full stop', () => {
  const { profile } = normaliseProfile({ aliases: [{ say: 'my music', means: 'open spotify' }] });
  assert.equal(expandAlias(profile, 'My music.'), 'open spotify');
  assert.equal(expandAlias(profile, 'play my music'), null);
});

test('a routine is found by its name, with or without "start"', () => {
  const { profile } = normaliseProfile({ macros: [{ name: 'my homework', steps: ['open word'] }] });
  assert.equal(findMacro(profile, 'Start my homework.')?.name, 'my homework');
  assert.equal(findMacro(profile, 'my homework')?.name, 'my homework');
  assert.equal(findMacro(profile, 'my maths homework'), null);
});

test('the student\'s words guide Gemini\'s spelling', () => {
  const prompt = transcriptionPrompt(['Wanjiku', 'Kisumu "town"\n']);
  assert.match(prompt, /spell it exactly like this: Wanjiku, Kisumu town/);
  assert.match(prompt, /Do not include them unless they were said/);
  assert.equal(transcriptionPrompt([]).includes('spell it exactly'), false);
});

// ── In the voice pipeline ──────────────────────────────────────────────────

function makeProxy(profile) {
  const proxy = new WsProxy({
    server: { on: () => {} }, aiEngine: null,
    attribution: commandAttribution,
    profile: () => profile,
  });
  proxy._heartbeatInterval?.unref?.();
  proxy._broadcastDashboard = () => {};
  const sent = [];
  const ws = { send: raw => sent.push(JSON.parse(raw)) };
  return { proxy, ws, sent };
}

test('a shortcut runs its command, and the vocabulary reaches the recogniser', async () => {
  const student = addStudent({ name: 'Kip' });
  setActiveStudent(student.id);
  const { profile } = normaliseProfile({
    vocabulary: ['Kip'],
    aliases: [{ say: 'go down a bit', means: 'scroll down' }],
  });
  const { proxy, ws } = makeProxy(profile);
  let options;
  proxy.voiceHandler.transcribe = async (audio, mime, opts) => { options = opts; return { text: 'Go down a bit.' }; };
  const tools = [];
  proxy.aiEngine = { toolRegistry: { executeTool: async (tool, args) => { tools.push({ tool, args }); return { status: 'success' }; } } };

  await proxy._onVoiceAudio(ws, { audio: 'x'.repeat(8000), source: 'overlay' });

  assert.deepEqual(options, { vocabulary: ['Kip'] });
  assert.deepEqual(tools, [{ tool: 'scroll', args: { direction: 'down' } }]);
  const stats = getRecognitionStats(student.id, { since: '2000-01-01 00:00:00' });
  assert.equal(stats.turns, 1);
  assert.equal(stats.heard, 1);
  assert.equal(stats.firstTime, 1);
});

test('every clip is logged, including the ones that were not usable', async () => {
  const student = addStudent({ name: 'Lulu' });
  setActiveStudent(student.id);
  const { proxy, ws } = makeProxy(normaliseProfile({}).profile);
  const answers = [
    { text: '', error: 'no_speech' },
    { text: 'thanks for watching and please subscribe' },
    { text: '', error: 'Transcription failed: 503' },
    { text: 'go to sleep' },
  ];
  proxy.voiceHandler.transcribe = async () => answers.shift();
  for (let i = 0; i < 4; i++) await proxy._onVoiceAudio(ws, { audio: 'x'.repeat(8000), source: 'overlay' });

  const stats = getRecognitionStats(student.id, { since: '2000-01-01 00:00:00' });
  assert.equal(stats.turns, 4);
  assert.equal(stats.noSpeech, 1);
  assert.equal(stats.filtered, 1);
  assert.equal(stats.errors, 1);
  assert.equal(stats.heard, 1, 'only "go to sleep" was a real instruction');
  assert.equal(stats.heardRate, 0.25);
});

test('the Chat page microphone is not the student speaking', async () => {
  const student = addStudent({ name: 'Mo' });
  setActiveStudent(student.id);
  const { proxy, ws } = makeProxy(normaliseProfile({}).profile);
  proxy.aiEngine = { toolRegistry: { executeTool: async () => ({ status: 'success' }) } };
  proxy.voiceHandler.transcribe = async () => ({ text: 'scroll down' });
  await proxy._onVoiceAudio(ws, { audio: 'x'.repeat(8000) }); // from the dashboard: no source
  const stats = getRecognitionStats(student.id, { since: '2000-01-01 00:00:00' });
  assert.equal(stats.turns, 0);
  assert.equal(stats.tasks, 0);
});

// ── API: profile, readout, export and import ──────────────────────────────

async function withApi(fn) {
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    wsProxy: {
      broadcastToDashboard: m => broadcasts.push(m),
      broadcastListeningSettings: () => broadcasts.push({ type: 'listening_settings' }),
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { Host: `localhost:${port}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  try {
    await fn(call, broadcasts);
  } finally {
    server.close();
  }
}

test('the Teacher page can read and change a profile', async () => {
  const student = addStudent({ name: 'Mercy' });
  setActiveStudent(student.id);
  await withApi(async (call, broadcasts) => {
    const read = await call('GET', `/api/students/${student.id}/profile`);
    assert.equal(read.body.listening.sensitivity, 'standard');

    const saved = await call('PUT', `/api/students/${student.id}/profile`, { listening: { sensitivity: 'quiet' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.listening.sensitivity, 'quiet');
    assert.equal(broadcasts.at(-1).type, 'listening_settings', 'the overlay hears about it at once');

    const bad = await call('PUT', `/api/students/${student.id}/profile`, { aliases: [{ say: 'x' }] });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.length);

    const readout = await call('GET', `/api/students/${student.id}/recognition?days=7`);
    assert.equal(readout.status, 200);
    assert.equal(readout.body.days, 7);
    assert.ok(Array.isArray(readout.body.recentlyFiltered));
  });
});

test('a profile exported on one computer restores on another', async () => {
  const student = addStudent({ name: 'Nuru' });
  saveProfile(student.id, { vocabulary: ['Nuru'], aliases: [{ say: 'my notes', means: 'open onenote' }] });
  await withApi(async (call) => {
    const exported = await call('GET', `/api/students/${student.id}/profile/export`);
    assert.match(exported.headers['content-disposition'], /ablespeak-Nuru\.json/);
    assert.equal(exported.body.kind, 'ablespeak-student-profile');

    // "Another computer": the student is not there yet.
    deleteStudent(student.id);
    const imported = await call('POST', '/api/students/profile/import', exported.body);
    assert.equal(imported.status, 201);
    assert.equal(imported.body.created, true);
    const restored = getStudents().find(s => s.name === 'Nuru');
    assert.deepEqual(getProfile(restored.id).aliases, [{ say: 'my notes', means: 'open onenote' }]);

    // Importing again updates the same student.
    const again = await call('POST', '/api/students/profile/import', exported.body);
    assert.equal(again.status, 200);
    assert.equal(getStudents().filter(s => s.name === 'Nuru').length, 1);

    const junk = await call('POST', '/api/students/profile/import', { hello: 'world' });
    assert.equal(junk.status, 400);
  });
});

test('retries per task are compared either side of a settings change', () => {
  const student = addStudent({ name: 'Pendo' });
  const add = (id, when, outcome, prompts) => getDb().run(
    `INSERT INTO commands (id, type, student_id, outcome, prompt_count, created_at) VALUES (?, 'voice', ?, ?, ?, ?)`,
    [id, student.id, outcome, prompts, when]);
  add('p1', '2026-09-01 10:00:00', 'repaired', 2);
  add('p2', '2026-09-02 10:00:00', 'repaired', 1);
  add('p3', '2026-09-03 10:00:00', 'error', 0);        // not completed: left out
  add('p4', '2026-09-11 10:00:00', 'success', 0);
  add('p5', '2026-09-12 10:00:00', 'repaired', 1);
  add('p6', '2026-08-01 10:00:00', 'repaired', 5);     // outside the window
  const around = getRetriesAround(student.id, { at: '2026-09-10 09:00:00' });
  assert.deepEqual(around.before, { tasks: 2, retries: 3, retriesPerTask: 1.5 });
  assert.deepEqual(around.after, { tasks: 2, retries: 1, retriesPerTask: 0.5 });
});

test('removing a student removes their profile', () => {
  const student = addStudent({ name: 'Otieno' });
  saveProfile(student.id, { vocabulary: ['Otieno'] });
  deleteStudent(student.id);
  assert.deepEqual(getProfile(student.id).vocabulary, []);
  insertCommand({ id: 'noop', type: 'chat' }); // the database is still usable
});
