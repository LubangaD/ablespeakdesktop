/**
 * /api/exams — teachers upload and check exam papers, start a sitting for a
 * student, watch it, and download the finished script and its audit trail.
 *
 * Everything is for helpers and admins (requireHelper), except the live
 * state, which the student's own exam screen reads.
 */
import { Router } from 'express';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { paperLines, PaperError } from './paper-import.js';
import { parsePaper, answerItems } from './paper-parse.js';
import { scriptDocx, auditCsv, scriptFileName } from './exam-export.js';
import { fromOwnPages } from '../admin-pin.js';
import { localOnly } from '../routes/settings.js';
import * as store from '../db.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const marks = v => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.max(0, Math.min(999, Math.round(Number(v)))) : null);

function cleanOptions(options) {
  return (Array.isArray(options) ? options : []).slice(0, 10)
    .map(o => ({ letter: str(o?.letter, 2).toUpperCase(), text: str(o?.text) }))
    .filter(o => /^[A-J]$/.test(o.letter));
}

/** A paper as the teacher edited it, kept to the fields the runner reads. */
export function cleanPaper(paper) {
  const questions = (Array.isArray(paper?.questions) ? paper.questions : []).slice(0, 300).map((q, i) => ({
    number: str(q?.number, 6) || String(i + 1),
    section: str(q?.section, 6) || null,
    text: str(q?.text),
    marks: marks(q?.marks),
    options: cleanOptions(q?.options),
    picture: !!q?.picture,
    parts: (Array.isArray(q?.parts) ? q.parts : []).slice(0, 30).map(p => ({
      label: str(p?.label, 12),
      text: str(p?.text),
      marks: marks(p?.marks),
      options: cleanOptions(p?.options),
      picture: !!p?.picture,
      ...(p?.introOnly ? { introOnly: true } : {}),
    })).filter(p => p.label && /^[a-z]?(\([ivx]+\))?$/.test(p.label)),
  }));
  // Two answers with the same key would share one answer
  const keys = new Set();
  for (const q of questions) {
    const own = q.parts.some(p => !p.introOnly) ? q.parts.filter(p => !p.introOnly).map(p => `${q.number}${p.label}`) : [q.number];
    for (const key of own) {
      if (keys.has(key)) throw Object.assign(new Error(`Two questions are numbered ${key}. Give each question its own number.`), { status: 400 });
      keys.add(key);
    }
  }
  return {
    title: str(paper?.title, 200) || 'Exam',
    instructions: (Array.isArray(paper?.instructions) ? paper.instructions : []).map(l => str(l, 1000)).filter(Boolean).slice(0, 50),
    questions,
  };
}

/** Settings a teacher can choose: time limit, read-back of each answer. */
export function cleanSettings(s = {}) {
  const t = Number(s?.timeLimitMin);
  return {
    timeLimitMin: Number.isFinite(t) && t > 0 ? Math.min(600, Math.round(t)) : null,
    readBack: s?.readBack !== false,
  };
}

const summary = exam => exam && ({
  id: exam.id,
  title: exam.title,
  fileName: exam.file_name,
  createdAt: exam.created_at,
  updatedAt: exam.updated_at,
  settings: exam.settings,
  questions: exam.paper?.questions?.length || 0,
  answerItems: answerItems(exam.paper || {}).length,
  attempts: exam.attempts ?? undefined,
  // From the exam folder, and whether a teacher has looked at it since
  fromFolder: !!exam.source_path,
  checked: !exam.source_path || !!exam.updated_at,
  warnings: exam.warnings || [],
});

const attemptSummary = a => a && ({
  id: a.id,
  examId: a.exam_id,
  examTitle: a.exam_title,
  studentId: a.student_id,
  studentName: a.student_name,
  status: a.status,
  startedAt: a.started_at,
  finishedAt: a.finished_at,
  answered: a.state?.answeredCount ?? 0,
  total: a.state?.total ?? null,
});

/** Show a folder in File Explorer. */
function openInExplorer(dir) {
  spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
}

const fail = (res, err) => res.status(err.status || (err instanceof PaperError ? 400 : 500)).json({ error: err.message });

export function createExamRouter({ examSession, requireHelper, db = store, examFolder = null, openFolder = openInExplorer }) {
  const router = Router();
  router.use(localOnly);

  // The student's exam screen: what is happening now (own pages only — it holds answers)
  router.get('/live', (req, res) => {
    if (!fromOwnPages(req)) return res.status(403).json({ error: 'Forbidden' });
    res.json(examSession.status());
  });

  router.use(requireHelper);

  router.get('/', (req, res) => res.json(db.getExams().map(summary)));

  // Upload a paper: { fileName, data (base64) } → a new exam, as a draft to check
  router.post('/import', async (req, res) => {
    try {
      const fileName = str(req.body?.fileName, 255);
      const buffer = Buffer.from(str(req.body?.data, MAX_FILE_BYTES * 2), 'base64');
      if (!buffer.length) return res.status(400).json({ error: 'The file is empty.' });
      if (buffer.length > MAX_FILE_BYTES) return res.status(413).json({ error: 'The file is too big (more than 20 MB).' });
      const parsed = parsePaper(await paperLines(buffer, fileName));
      const paper = cleanPaper(parsed);
      const title = str(req.body?.title, 200) || paper.title || fileName.replace(/\.[^.]+$/, '');
      const exam = db.insertExam({ id: uuidv4(), title, file_name: fileName, paper, settings: cleanSettings(req.body?.settings), warnings: parsed.warnings });
      res.json({ exam: { ...summary(exam), paper: exam.paper }, warnings: parsed.warnings });
    } catch (err) {
      fail(res, err);
    }
  });

  // The exam folder: papers saved there are read by themselves (exam-folder.js)
  router.get('/folder', (req, res) => {
    res.json(examFolder ? examFolder.status() : { path: null, watching: false, problems: [] });
  });
  router.post('/folder/open', (req, res) => {
    if (!examFolder?.dir) return res.status(404).json({ error: 'There is no exam folder on this computer.' });
    try {
      openFolder(examFolder.dir);
      res.json({ ok: true, path: examFolder.dir });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/attempts', (req, res) => {
    res.json(db.getExamAttempts({ examId: str(req.query.examId, 64) || null }).map(attemptSummary));
  });

  router.get('/attempts/:id', (req, res) => {
    const attempt = db.getExamAttempt(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'There is no such sitting.' });
    res.json({ ...attemptSummary(attempt), answers: attempt.state?.answers || {}, audit: db.verifyExamEvents(attempt.id) });
  });

  router.get('/attempts/:id/script.docx', async (req, res) => {
    try {
      const attempt = db.getExamAttempt(req.params.id);
      const exam = attempt && db.getExam(attempt.exam_id);
      if (!exam) return res.status(404).json({ error: 'There is no such sitting.' });
      // The paper as it was when this sitting started, not as it may have been changed since
      const buffer = await scriptDocx({ exam: { ...exam, paper: attempt.paper || exam.paper }, attempt, audit: db.verifyExamEvents(attempt.id) });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(scriptFileName(exam, attempt, 'docx'))}`);
      res.send(buffer);
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/attempts/:id/audit.csv', (req, res) => {
    const attempt = db.getExamAttempt(req.params.id);
    const exam = attempt && db.getExam(attempt.exam_id);
    if (!exam) return res.status(404).json({ error: 'There is no such sitting.' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(scriptFileName(exam, attempt, 'audit.csv'))}`);
    res.send('﻿' + auditCsv(db.getExamEvents(attempt.id)));
  });

  router.post('/attempts/:id/resume', (req, res) => {
    try { res.json(examSession.resume(req.params.id)); } catch (err) { fail(res, err); }
  });

  // The invigilator, during a sitting
  router.post('/live/pause', (req, res) => { try { res.json(examSession.pause()); } catch (err) { fail(res, err); } });
  router.post('/live/unpause', (req, res) => { try { res.json(examSession.unpause()); } catch (err) { fail(res, err); } });
  router.post('/live/stop', (req, res) => { try { res.json(examSession.stop()); } catch (err) { fail(res, err); } });

  router.get('/:id', (req, res) => {
    const exam = db.getExam(req.params.id);
    if (!exam) return res.status(404).json({ error: 'There is no such exam.' });
    res.json({ ...summary(exam), paper: exam.paper });
  });

  // The teacher's corrections: { title, paper, settings }
  router.put('/:id', (req, res) => {
    if (!db.getExam(req.params.id)) return res.status(404).json({ error: 'There is no such exam.' });
    let paper;
    try { paper = req.body?.paper ? cleanPaper(req.body.paper) : undefined; } catch (err) { return fail(res, err); }
    if (examSession.active && examSession.status().examId === req.params.id) {
      return res.status(409).json({ error: 'This exam is being sat right now. Change it after the sitting.' });
    }
    const exam = db.updateExam(req.params.id, {
      title: str(req.body?.title, 200) || undefined,
      paper,
      settings: req.body?.settings ? cleanSettings(req.body.settings) : undefined,
    });
    res.json({ ...summary(exam), paper: exam.paper });
  });

  router.delete('/:id', (req, res) => {
    if (examSession.active && examSession.status().examId === req.params.id) {
      return res.status(409).json({ error: 'This exam is being sat right now.' });
    }
    db.deleteExam(req.params.id);
    res.json({ ok: true });
  });

  // Start a sitting: { studentId }
  router.post('/:id/start', (req, res) => {
    try {
      const studentId = req.body?.studentId != null && req.body.studentId !== '' ? Number(req.body.studentId) : null;
      const student = studentId != null ? db.getStudent(studentId) : null;
      if (studentId != null && !student) return res.status(404).json({ error: 'There is no such user.' });
      // A paper read from the exam folder has been seen by nobody yet
      const exam = db.getExam(req.params.id);
      if (exam?.source_path && !exam.updated_at) {
        return res.status(400).json({ error: 'Check the questions of this paper first: open "Check questions", read them through, and save.' });
      }
      res.json(examSession.start({ examId: req.params.id, studentId, studentName: student?.name || str(req.body?.studentName, 100) || null }));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
