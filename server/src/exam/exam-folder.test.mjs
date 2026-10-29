/**
 * The exam folder: a paper saved into it becomes an exam to check, once.
 * Run with:  node --test src/exam/exam-folder.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import express from 'express';
import { Document, Packer, Paragraph } from 'docx';
import * as db from '../db.js';
import { ExamFolder, isPaperFile } from './exam-folder.js';
import { ExamSession } from './exam-session.js';
import { createExamRouter } from './exam-routes.js';

const dbPath = join(tmpdir(), `ablespeak-exam-folder-${process.pid}-${Date.now()}.sqlite`);
const dir = mkdtempSync(join(tmpdir(), 'ablespeak-exams-'));
const changes = [];
let folder;

const paper = lines => Packer.toBuffer(new Document({ sections: [{ children: lines.map(l => new Paragraph(l)) }] }));

before(async () => {
  await db.initDatabase(dbPath);
  folder = new ExamFolder({ dir, onChange: c => changes.push(c), settleMs: 200 });
});

after(async () => {
  await folder.stop();
  db.closeDatabase();
  for (const p of [dbPath, `${dbPath}.tmp`]) try { rmSync(p, { force: true }); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('only papers count: not Word\'s lock file, notes or pictures', () => {
  assert.equal(isPaperFile('C:/x/Biology.docx'), true);
  assert.equal(isPaperFile('C:/x/Biology.PDF'), true);
  assert.equal(isPaperFile('C:/x/~$Biology.docx'), false);
  assert.equal(isPaperFile('C:/x/notes.txt'), false);
});

test('a paper saved into the folder becomes an exam, waiting to be checked', async () => {
  const file = join(dir, 'Biology.docx');
  writeFileSync(file, await paper(['Biology Test', '1. Define osmosis. (2 marks)', '2. Name a mammal.', '4. What is a cell?']));
  const exam = await folder.importFile(file);
  assert.equal(exam.title, 'Biology Test');
  assert.equal(exam.paper.questions.length, 3);
  assert.equal(exam.source_path, file);
  assert.match(exam.warnings.join(' '), /jumps from 2 to 4/, 'what to check is kept with the exam');
  assert.deepEqual(changes[changes.length - 1], { type: 'imported', fileName: 'Biology.docx', examId: exam.id });
});

test('the same file is not read twice', async () => {
  assert.equal(await folder.importFile(join(dir, 'Biology.docx')), null);
  assert.equal(db.getExams().length, 1);
});

test('saving the file again replaces the exam, while nobody has changed or sat it', async () => {
  const file = join(dir, 'Biology.docx');
  writeFileSync(file, await paper(['Biology Test', '1. Define osmosis. (2 marks)', '2. Name a mammal.', '3. What is a cell?']));
  const exam = await folder.importFile(file);
  assert.equal(db.getExams().length, 1, 'still one exam');
  assert.deepEqual(exam.paper.questions.map(q => q.number), ['1', '2', '3']);
  assert.deepEqual(exam.warnings, []);
});

test('once a teacher has changed the exam, a new version of the file comes in beside it', async () => {
  const file = join(dir, 'Biology.docx');
  const first = db.getExamBySourcePath(file);
  db.updateExam(first.id, { title: 'Biology Test (checked)' });
  writeFileSync(file, await paper(['Biology Test', '1. A different question?']));
  const second = await folder.importFile(file);
  assert.notEqual(second.id, first.id);
  assert.equal(db.getExam(first.id).title, 'Biology Test (checked)', 'the teacher\'s work is not overwritten');
});

test('a deleted exam does not come back while its file stays the same', async () => {
  const file = join(dir, 'Biology.docx');
  db.deleteExam(db.getExamBySourcePath(file).id);
  assert.equal(await folder.importFile(file), null);
});

test('a file that cannot be read is listed with what to do', async () => {
  const file = join(dir, 'Old.doc');
  writeFileSync(file, 'not a real document');
  assert.equal(await folder.importFile(file), null);
  const { problems, path } = folder.status();
  assert.equal(path, dir);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].fileName, 'Old.doc');
  assert.match(problems[0].error, /Save As/);
});

test('the folder is watched: a paper dropped in is read by itself', async () => {
  folder.start();
  const seen = changes.length;
  writeFileSync(join(dir, 'Chemistry.docx'), await paper(['Chemistry Quiz', '1. What is H2O?']));
  for (let i = 0; i < 80 && !changes.slice(seen).some(c => c.type === 'imported' && c.fileName === 'Chemistry.docx'); i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(db.getExams().some(e => e.title === 'Chemistry Quiz'), 'the dropped paper is on the list');
});

test('the Exams page is told where the folder is, and which papers still need checking', async () => {
  const opened = [];
  const app = express();
  app.use(express.json());
  app.use('/api/exams', createExamRouter({
    examSession: new ExamSession({ broadcast: () => {} }), examFolder: folder,
    requireHelper: (req, res, next) => next(), openFolder: d => opened.push(d),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/exams`;
  try {
    const status = await (await fetch(`${base}/folder`)).json();
    assert.equal(status.path, dir);
    assert.equal(status.problems[0].fileName, 'Old.doc');
    const list = await (await fetch(base)).json();
    const chemistry = list.find(e => e.title === 'Chemistry Quiz');
    assert.equal(chemistry.fromFolder, true);
    assert.equal(chemistry.checked, false);
    assert.equal((await fetch(`${base}/folder/open`, { method: 'POST' })).status, 200);
    assert.deepEqual(opened, [dir]);

    // Nobody has looked at it yet: it cannot be started until a teacher checks and saves it
    const start = () => fetch(`${base}/${chemistry.id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const refused = await start();
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /Check the questions/);
    await fetch(`${base}/${chemistry.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Chemistry Quiz' }) });
    assert.equal((await start()).status, 200);
  } finally {
    server.close();
  }
});
