/**
 * A whole sitting through the server: a teacher uploads a Word paper, starts
 * it for a student, the student answers by voice, the AI and tools stay off,
 * and the teacher downloads a script whose audit trail can be checked.
 * Run with:  node --test src/exam/exam-session.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import express from 'express';
import JSZip from 'jszip';
import { Document, Packer, Paragraph } from 'docx';
import * as db from '../db.js';
import { ExamSession } from './exam-session.js';
import { createExamRouter } from './exam-routes.js';
import { AIEngine } from '../ai-engine.js';
import { ToolRegistry } from '../tool-registry.js';
import { WsProxy } from '../ws-proxy.js';

const dbPath = join(tmpdir(), `ablespeak-exam-test-${process.pid}-${Date.now()}.sqlite`);
let server, base, session, studentId;
const messages = [];

before(async () => {
  await db.initDatabase(dbPath);
  studentId = db.addStudent({ name: 'Jane Wanjiru' }).id;
  session = new ExamSession({ broadcast: m => messages.push(m), tickMs: 60_000 });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/exams', createExamRouter({ examSession: { get active() { return session.active; }, status: () => session.status(), start: a => session.start(a), resume: id => session.resume(id), pause: () => session.pause(), unpause: () => session.unpause(), stop: () => session.stop() }, requireHelper: (req, res, next) => next() }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/exams`;
});

after(() => {
  session.close();
  server.close();
  db.closeDatabase();
  for (const p of [dbPath, `${dbPath}.tmp`]) try { rmSync(p, { force: true }); } catch {}
});

const call = async (path, opts = {}) => {
  const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

async function wordPaper() {
  return Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph('Science Quiz'),
    new Paragraph('1. Name the organelle responsible for respiration. (1 mark)'),
    new Paragraph('2. Which of these is a mammal? A. Shark B. Whale'),
  ] }] }));
}

let examId, attemptId;

test('a teacher uploads a Word paper and gets its questions back to check', async () => {
  const data = (await wordPaper()).toString('base64');
  const { status, body } = await call('/import', { method: 'POST', body: { fileName: 'science.docx', data, settings: { timeLimitMin: 30 } } });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.exam.title, 'Science Quiz');
  assert.equal(body.exam.questions, 2);
  assert.equal(body.exam.settings.timeLimitMin, 30);
  assert.equal(body.exam.paper.questions[1].options.length, 2);
  examId = body.exam.id;
});

test('a paper that cannot be read is refused with a reason', async () => {
  const { status, body } = await call('/import', { method: 'POST', body: { fileName: 'old.doc', data: Buffer.from('x').toString('base64') } });
  assert.equal(status, 400);
  assert.match(body.error, /Save As/);
});

test('the teacher corrects a question before the sitting', async () => {
  const { body: exam } = await call(`/${examId}`);
  exam.paper.questions[0].text = 'Name the organelle where respiration happens.';
  const { status, body } = await call(`/${examId}`, { method: 'PUT', body: { paper: exam.paper } });
  assert.equal(status, 200);
  assert.equal(body.paper.questions[0].text, 'Name the organelle where respiration happens.');
});

test('a sitting starts for a student: the exam is read to them, and only one runs at a time', async () => {
  const { status, body } = await call(`/${examId}/start`, { method: 'POST', body: { studentId } });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.active, true);
  assert.equal(body.studentName, 'Jane Wanjiru');
  attemptId = body.attemptId;
  assert.ok(messages.some(m => m.type === 'exam_mode' && m.enabled));
  assert.match(messages.find(m => m.type === 'exam_speak').text, /This is your exam: Science Quiz/);
  assert.equal((await call(`/${examId}/start`, { method: 'POST', body: { studentId } })).status, 409);
  assert.equal((await call(`/${examId}`, { method: 'DELETE' })).status, 409, 'an exam being sat cannot be deleted');
});

test('during the sitting the AI and every tool are switched off', async () => {
  const toolRegistry = new ToolRegistry();
  toolRegistry.examLock = () => session.active;
  const aiEngine = new AIEngine({ toolRegistry, wsHub: null });
  aiEngine.examLock = () => session.active;
  aiEngine._callLLM = async () => { throw new Error('the AI must not be called during an exam'); };
  const reply = await aiEngine.processChat('What is the answer to question 1?');
  assert.match(reply.text, /exam is running/i);
  const tool = await toolRegistry.executeTool('search_web', { query: 'organelle respiration' }, null);
  assert.equal(tool.status, 'error');
  assert.match(tool.error, /exam is running/i);
});

test('what the student says goes to the exam, word for word, through the voice path', async () => {
  const sent = [];
  const said = ['answer', 'mitochondria full stop', 'done', 'next', 'answer B'];
  const hub = {
    examSession: session,
    voiceHandler: { transcribe: async (_audio, _mime, opts) => { assert.equal(opts.exam, true, 'exam transcription'); return { text: said.shift() }; } },
    _profile: () => ({ vocabulary: [] }),
    _markTurn() {},
    _broadcastDashboard: m => sent.push(m),
  };
  for (let i = 0; i < 5; i++) await WsProxy.prototype._examVoice.call(hub, { send() {} }, { audio: 'x'.repeat(5000) }, Date.now());
  assert.deepEqual(sent.filter(m => m.type === 'exam_heard').map(m => m.action), ['start_answer', 'write', 'end_answer', 'move', 'choose']);
  const saved = db.getExamAttempt(attemptId).state.answers;
  assert.equal(saved['1'].text, 'Mitochondria.');
  assert.equal(saved['2'].choice, 'B');
});

test('a clip that could not be made out is said to be so — never dropped quietly', async () => {
  const sent = [];
  const hub = {
    examSession: session,
    voiceHandler: { transcribe: async () => ({ text: '', error: 'no_speech', filtered: true }) },
    _profile: () => ({ vocabulary: [] }), _markTurn() {}, _broadcastDashboard: m => sent.push(m),
  };
  const before = messages.length;
  await WsProxy.prototype._examVoice.call(hub, { send() {} }, { audio: 'x' }, Date.now());
  assert.equal(sent.find(m => m.type === 'exam_heard').action, 'not_heard');
  assert.match(messages.slice(before).find(m => m.type === 'exam_speak').text, /did not catch that clearly/);
});

test('the sitting carries on after the app restarts, with its answers', async () => {
  session.close();
  const restarted = new ExamSession({ broadcast: m => messages.push(m), tickMs: 60_000 });
  const state = restarted.resume(attemptId);
  assert.equal(state.active, true);
  assert.equal(state.answers['1'].text, 'Mitochondria.');
  session = restarted;
});

test('the student finishes; the script and audit trail can be downloaded', async () => {
  session.heard('finish exam');
  session.heard('yes');
  assert.equal(session.active, false);
  assert.ok(messages.some(m => m.type === 'exam_mode' && m.enabled === false && m.reason === 'finished'));

  const { body: attempt } = await call(`/attempts/${attemptId}`);
  assert.equal(attempt.status, 'finished');
  assert.equal(attempt.audit.ok, true);
  assert.ok(attempt.audit.events > 10);

  const docx = await call(`/attempts/${attemptId}/script.docx`);
  assert.equal(docx.status, 200);
  const xml = await (await JSZip.loadAsync(docx.body)).file('word/document.xml').async('string');
  const text = xml.replace(/<[^>]+>/g, '');
  assert.match(text, /Jane Wanjiru/);
  assert.match(text, /Name the organelle where respiration happens\./);
  assert.match(text, /Mitochondria\./);
  assert.match(text, /B — Whale/);
  assert.match(text, /integrity check passed/);

  const csv = (await call(`/attempts/${attemptId}/audit.csv`)).body.toString('utf8');
  assert.match(csv, /^﻿time,event,question,heard,written,said,detail,hash/);
  assert.match(csv, /heard,1,mitochondria full stop,,,,/);
  assert.match(csv, /result,1,,mitochondria\.,,write/);
});

test('a changed audit row is detected', () => {
  db.getDb().run(`UPDATE exam_events SET heard = 'cell wall' WHERE attempt_id = ? AND heard = 'mitochondria full stop'`, [attemptId]);
  const check = db.verifyExamEvents(attemptId);
  assert.equal(check.ok, false);
  assert.ok(check.brokenAt);
});

test('the live state is only for AbleSpeak\'s own pages', async () => {
  assert.equal((await call('/live', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/live')).status, 200);
});

test('deleting the student removes their sittings and audit trails', () => {
  db.deleteStudent(studentId);
  assert.equal(db.getExamAttempt(attemptId), null);
  assert.equal(db.getExamEvents(attemptId).length, 0);
});
