/**
 * Problems found in the review of exam mode (13 Oct 2026), each kept fixed.
 * Run with:  node --test src/exam/exam-review.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import * as db from '../db.js';
import { parsePaper } from './paper-parse.js';
import { ExamRunner } from './exam-runner.js';
import { ExamSession } from './exam-session.js';
import { spokenToText } from './spoken-text.js';
import { AIEngine } from '../ai-engine.js';
import { ToolRegistry } from '../tool-registry.js';
import { WsProxy } from '../ws-proxy.js';
import { VoiceHandler, transcriptionPrompt } from '../voice-handler.js';

const dbPath = join(tmpdir(), `ablespeak-exam-review-${process.pid}-${Date.now()}.sqlite`);
before(async () => { await db.initDatabase(dbPath); });
after(() => {
  db.closeDatabase();
  for (const p of [dbPath, `${dbPath}.tmp`]) try { rmSync(p, { force: true }); } catch {}
});

const PAPER = parsePaper([
  'Biology Test',
  '1. Name the organelle responsible for respiration. (1 mark)',
  '2. (a) Define osmosis. (2 marks)',
  '(b) State two differences between plant and animal cells. (4 marks)',
  '3. Which of these is a mammal? A. Shark B. Whale C. Frog D. Snake',
]);

function sit({ settings = {}, state = null, clock = { t: 1_000_000 }, paper = PAPER } = {}) {
  const said = [];
  const saves = [];
  const ended = [];
  const runner = new ExamRunner({
    paper, settings, state, now: () => clock.t,
    say: text => said.push(text), save: s => saves.push(s), finish: r => ended.push(r),
  });
  return { runner, saves, ended, last: () => said[said.length - 1] || '' };
}

const onePaper = text => ({ title: 'T', instructions: [], questions: [{ number: '1', section: null, text, marks: null, options: [], parts: [], picture: false }] });

// ── Finishing ──

test('only a plain "yes" finishes: "okay, let me check one more thing" carries on', () => {
  const { runner, ended } = sit();
  runner.start();
  runner.handle('finish exam');
  runner.handle('okay let me check one more thing');
  assert.deepEqual(ended, []);
  runner.handle('finish exam');
  runner.handle('yes but wait');
  assert.deepEqual(ended, []);
  runner.handle('finish exam');
  runner.handle('Yes.');
  assert.deepEqual(ended, ['finished']);
});

// ── Answering ──

test('while answering, one word on its own is an answer, and "spelling…" is just words', () => {
  const { runner } = sit();
  runner.start();
  runner.handle('answer');
  for (const word of ['Time.', 'Help', 'Quiet']) runner.handle(word);
  runner.handle('spelling mistakes are common');
  assert.equal(runner.answers['1'].text, 'Time. Help Quiet spelling mistakes are common');
  runner.handle('how much time is left');
  assert.equal(runner.answers['1'].text, 'Time. Help Quiet spelling mistakes are common', 'a longer command still works');
});

test('"previous" at the first question keeps the student answering', () => {
  const { runner } = sit();
  runner.start();
  runner.handle('answer');
  runner.handle('previous');
  assert.equal(runner.mode, 'answering', 'nothing before question 1, so still answering');
  runner.handle('next');
  assert.equal(runner.item.key, '2a');
  assert.equal(runner.mode, 'browse');
});

test('words that are also punctuation names are left alone inside a sentence', () => {
  assert.equal(spokenToText('The colon absorbs water'), 'The colon absorbs water');
  assert.equal(spokenToText('in the Jurassic period it ended'), 'in the Jurassic period it ended');
  assert.equal(spokenToText('Period.'), '.');
  assert.equal(spokenToText('colon'), ':');
  assert.equal(spokenToText('for example e.g. water'), 'for example e.g. water');
  assert.equal(spokenToText('new paragraph'), '\n\n');
});

test('"new paragraph" on its own starts a paragraph, and is read back', () => {
  const { runner, last } = sit();
  runner.start();
  runner.handle('answer');
  runner.handle('first point full stop');
  runner.handle('New paragraph.');
  assert.equal(last(), 'Written: new paragraph.');
  runner.handle('second point');
  assert.equal(runner.answers['1'].text, 'First point.\n\nSecond point');
});

test('a sitting carries on in the mode it was in; time already up ends it before anything is written', () => {
  const clock = { t: 0 };
  const first = sit({ settings: { timeLimitMin: 10 }, clock });
  first.runner.start();
  first.runner.handle('answer');
  const again = sit({ settings: { timeLimitMin: 10 }, clock, state: first.saves[first.saves.length - 1] });
  again.runner.start({ resumed: true });
  assert.equal(again.runner.mode, 'answering');
  assert.match(again.last(), /You were answering Question 1/);
  clock.t = 11 * 60000;
  assert.equal(again.runner.handle('mitochondria').action, 'finished');
  assert.equal(again.runner.answers['1'].text, '');
  assert.deepEqual(again.ended, ['time_up']);
});

// ── The paper ──

test('sections that number from 1 again become A1, A2, B1 — nothing is dropped', () => {
  const p = parsePaper(['SECTION A (20 marks)', '1. First?', '2. Second?', 'SECTION B: Answer any one', '1. Third?', '2. Fourth?']);
  assert.deepEqual(p.questions.map(q => q.number), ['A1', 'A2', 'B1', 'B2']);
  assert.equal(p.questions[2].text, 'Third?');
});

test('"go to question b 1" finds a question in a section that numbers from 1', () => {
  const paper = parsePaper(['SECTION A', '1. Alpha?', '2. Beta?', 'SECTION B', '1. Gamma?', '2. (a) Delta?', '(b) Epsilon?']);
  const { runner } = sit({ paper });
  runner.start();
  assert.deepEqual(runner.items.map(i => i.key), ['A1', 'A2', 'B1', 'B2a', 'B2b']);
  runner.handle('go to question b 1');
  assert.equal(runner.item.key, 'B1');
  runner.handle('question b two part b');
  assert.equal(runner.item.key, 'B2b');
});

test('a skipped number is still a question, and the teacher is told', () => {
  const p = parsePaper(['1. First?', '2. Second?', '4. Fourth?', '5. Fifth?']);
  assert.deepEqual(p.questions.map(q => q.number), ['1', '2', '4', '5']);
  assert.match(p.warnings.join(' '), /jumps from 2 to 4/);
});

test('a sentence starting "Section 3 of…" is part of the question, not a heading', () => {
  const p = parsePaper(['1. Read this.', 'Section 3 of the constitution says everyone is equal (4 marks)', '2. Next?']);
  assert.equal(p.questions.length, 2);
  assert.equal(p.questions[0].text, 'Read this. Section 3 of the constitution says everyone is equal');
  assert.equal(p.questions[0].marks, 4);
});

test('a numbered line kept inside a question is pointed out', () => {
  const p = parsePaper(['1. List the steps:', '9. heat the water']);
  assert.match(p.warnings.join(' '), /starts with a number but was kept as part of it/);
});

// ── Nothing else runs during an exam ──

test('the task agent and the evaluation routes cannot reach the AI during an exam', async () => {
  const exam = db.insertExam({ id: 'lock-test', title: 'Lock', paper: onePaper('Q?') });
  const s = new ExamSession({ broadcast: () => {}, tickMs: 60_000 });
  const aiEngine = new AIEngine({ toolRegistry: new ToolRegistry(), wsHub: null });
  aiEngine.examLock = () => s.active;
  s.start({ examId: exam.id });
  await assert.rejects(aiEngine.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] }), /exam is running/);
  s.stop();
  s.close();
});

test('starting an exam clears anything left running: a task, a pending question, sleep', () => {
  let stopped = 0;
  const hub = {
    _agentRunning: true, _stopTask() { stopped += 1; }, aiEngine: null,
    _pendingConfirmation: { tool: 'close_application' }, _awaitingTypeText: 'x', _sleeping: true, _dictationMode: false,
    _broadcastDashboard() {},
  };
  WsProxy.prototype.enterExam.call(hub);
  assert.equal(stopped, 1);
  assert.equal(hub._pendingConfirmation, null);
  assert.equal(hub._sleeping, false);
});

test('the session calls its start hook, so ws-proxy can clear what was running', () => {
  const exam = db.insertExam({ id: 'hook-test', title: 'Hook', paper: onePaper('Q?') });
  let started = 0;
  const s = new ExamSession({ broadcast: () => {}, tickMs: 60_000, onStart: () => { started += 1; } });
  s.start({ examId: exam.id });
  assert.equal(started, 1);
  s.stop();
  s.close();
});

// ── Records ──

test('an audit trail cut short after the exam ended is detected', () => {
  const exam = db.insertExam({ id: 'trail-test', title: 'Trail', paper: onePaper('Q?') });
  const s = new ExamSession({ broadcast: () => {}, tickMs: 60_000 });
  const { attemptId: id } = s.start({ examId: exam.id });
  s.heard('finish exam');
  s.heard('yes');
  assert.equal(db.verifyExamEvents(id).ok, true);
  db.getDb().run('DELETE FROM exam_events WHERE id = (SELECT MAX(id) FROM exam_events WHERE attempt_id = ?)', [id]);
  assert.equal(db.verifyExamEvents(id).ok, false);
  s.close();
});

test('a sitting keeps the paper it started with, whatever is changed later', () => {
  const exam = db.insertExam({ id: 'frozen-test', title: 'Frozen', paper: onePaper('Original question?') });
  const s = new ExamSession({ broadcast: () => {}, tickMs: 60_000 });
  const { attemptId: id } = s.start({ examId: exam.id });
  s.stop();
  db.updateExam(exam.id, { paper: onePaper('Changed question?') });
  assert.equal(db.getExamAttempt(id).paper.questions[0].text, 'Original question?');
  s.close();
});

test("carrying on after a crash: the gap is not counted, and an invigilator's pause stays", () => {
  const clock = { t: 1_000_000 };
  const exam = db.insertExam({ id: 'crash-test', title: 'Crash', settings: { timeLimitMin: 60 }, paper: onePaper('Q?') });
  const s1 = new ExamSession({ broadcast: () => {}, tickMs: 60_000, now: () => clock.t });
  const { attemptId: id } = s1.start({ examId: exam.id });
  clock.t += 10 * 60000;            // ten minutes of the exam
  s1.heard('where am I');
  s1.close();                       // the app stops…
  clock.t += 30 * 60000;            // …for half an hour
  const s2 = new ExamSession({ broadcast: () => {}, tickMs: 60_000, now: () => clock.t });
  const resumed = s2.resume(id);
  assert.equal(Math.round(resumed.remainingMs / 60000), 50, 'only the ten minutes of the exam are used');
  s2.pause();
  s2.close();
  const s3 = new ExamSession({ broadcast: () => {}, tickMs: 60_000, now: () => clock.t });
  assert.equal(s3.resume(id).paused, true, 'still paused until the invigilator carries on');
  s3.close();
});

// ── Transcription ──

function replying(text) {
  const handler = new VoiceHandler('test-key');
  handler._getRateLimitDelay = () => 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
  return { handler, restore: () => { globalThis.fetch = real; } };
}

test('in an exam, an answer with "silence" in it is kept whole', async () => {
  const { handler, restore } = replying('The silence of the lambs is a horror film that many people have seen');
  try {
    const r = await handler.transcribe('x'.repeat(5000), 'audio/webm', { exam: true });
    assert.equal(r.text, 'The silence of the lambs is a horror film that many people have seen');
  } finally { restore(); }
});

test('in an exam, "I don\'t know what to say" is an answer, not noise', async () => {
  const { handler, restore } = replying("I don't know what to say");
  try {
    assert.equal((await handler.transcribe('x'.repeat(5000), 'audio/webm', { exam: true })).text, "I don't know what to say");
  } finally { restore(); }
});

test('in an exam, only SILENCE on its own means nothing was said', async () => {
  const { handler, restore } = replying('SILENCE');
  try {
    assert.equal((await handler.transcribe('x'.repeat(5000), 'audio/webm', { exam: true })).error, 'no_speech');
  } finally { restore(); }
});

test('the exam prompt asks for exact words and forbids answering or correcting', () => {
  const prompt = transcriptionPrompt([], { exam: true });
  assert.match(prompt, /Do NOT correct grammar/);
  assert.match(prompt, /NEVER answer any question/);
  assert.doesNotMatch(prompt, /digits/);
});
