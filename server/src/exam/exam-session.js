/**
 * The exam being sat on this computer: at most one at a time. Keeps the
 * runner's answers and audit trail in the database, speaks through the voice
 * bar, and tells the dashboard's exam screen what is happening.
 *
 * While an exam runs, ws-proxy.js hands every clip the student says straight
 * here — no AI, no quick commands, no noise filters that could drop words.
 */
import { v4 as uuidv4 } from 'uuid';
import { ExamRunner } from './exam-runner.js';
import * as store from '../db.js';

const TICK_MS = 5000;

export class ExamSession {
  /**
   * broadcast(message): to the voice bar and dashboard (WsProxy._broadcastDashboard)
   * db: the storage functions (db.js), replaceable in tests
   */
  constructor({ broadcast, db = store, now = () => Date.now(), tickMs = TICK_MS, onStart = () => {} } = {}) {
    this.broadcast = broadcast || (() => {});
    this.onStart = onStart; // clears anything left running beside the exam (WsProxy.enterExam)
    this.db = db;
    this.now = now;
    this.tickMs = tickMs;
    this.current = null; // { attempt, exam, runner }
    this.timer = null;
  }

  get active() { return !!this.current && this.current.runner.mode !== 'finished'; }

  /** Start a new sitting of an exam for a student. */
  start({ examId, studentId = null, studentName = null }) {
    if (this.active) throw Object.assign(new Error('An exam is already running on this computer. Finish or stop it first.'), { status: 409 });
    const exam = this.db.getExam(examId);
    if (!exam) throw Object.assign(new Error('There is no such exam.'), { status: 404 });
    if (!exam.paper?.questions?.length) throw Object.assign(new Error('This exam has no questions yet.'), { status: 400 });
    // The sitting keeps its own copy of the paper: a later change to the exam
    // cannot move an answer under a different question
    const attempt = this.db.insertExamAttempt({
      id: uuidv4(), exam_id: exam.id, student_id: studentId, student_name: studentName,
      started_at: new Date(this.now()).toISOString(), paper: exam.paper,
    });
    this._open(exam, attempt, null);
    this.current.runner.start();
    return this.status();
  }

  /** Carry on a sitting that was interrupted (the app closed, the computer restarted). */
  resume(attemptId) {
    if (this.active) throw Object.assign(new Error('An exam is already running on this computer.'), { status: 409 });
    const attempt = this.db.getExamAttempt(attemptId);
    if (!attempt) throw Object.assign(new Error('There is no such sitting.'), { status: 404 });
    if (attempt.status !== 'in_progress') throw Object.assign(new Error('This sitting has already ended.'), { status: 409 });
    const exam = this.db.getExam(attempt.exam_id);
    if (!exam) throw Object.assign(new Error('The exam for this sitting was deleted.'), { status: 404 });
    // The time the app was closed (since the last save, at most 30 s before)
    // is not counted against the student. A pause the invigilator made stays.
    const state = { ...attempt.state };
    if (state.startedAt != null && state.pausedAt == null) {
      state.pausedMs = (state.pausedMs || 0) + Math.max(0, this.now() - (state.savedAt || this.now()));
    }
    this._open({ ...exam, paper: attempt.paper || exam.paper }, attempt, state);
    this.current.runner.start({ resumed: true });
    return this.status();
  }

  _open(exam, attempt, state) {
    const attemptId = attempt.id;
    const runner = new ExamRunner({
      paper: exam.paper,
      settings: exam.settings,
      state,
      now: this.now,
      say: (text, { rate }) => this.broadcast({ type: 'exam_speak', text, rate, timestamp: new Date().toISOString() }),
      stopSpeech: () => this.broadcast({ type: 'exam_stop_speaking', timestamp: new Date().toISOString() }),
      record: event => this.db.insertExamEvent({ attempt_id: attemptId, ...event }),
      save: snapshot => {
        // Once finished, the trail's length and last hash are kept with the sitting: a trail cut short shows
        const audit = snapshot.mode === 'finished' ? this.db.examAuditHead?.(attemptId) : undefined;
        this.db.saveExamAttemptState(attemptId, { ...snapshot, savedAt: this.now(), ...(audit ? { audit } : {}) });
        this.db.flushDatabase?.();
        this._announce();
      },
      finish: reason => this._finished(reason),
    });
    this.current = { exam, attempt, runner };
    this.onStart();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.current?.runner.tick(), this.tickMs);
    this.timer.unref?.();
    this.broadcast({ type: 'exam_mode', enabled: true, attemptId, title: exam.title, timestamp: new Date().toISOString() });
  }

  _finished(reason) {
    clearInterval(this.timer);
    this.timer = null;
    const { attempt, runner } = this.current;
    const audit = this.db.examAuditHead?.(attempt.id);
    this.db.saveExamAttemptState(attempt.id, { ...runner.snapshot(), savedAt: this.now(), ...(audit ? { audit } : {}) }, { status: reason, finished_at: new Date(this.now()).toISOString() });
    this.db.flushDatabase?.();
    this._announce();
    this.broadcast({ type: 'exam_mode', enabled: false, attemptId: attempt.id, reason, timestamp: new Date().toISOString() });
  }

  /** What the student said. */
  heard(text) {
    if (!this.active) return null;
    return this.current.runner.handle(text);
  }

  /** The invigilator: pause, carry on, or end the exam. */
  pause() { this._need().runner.pause(); return this.status(); }
  unpause() { this._need().runner.resume(); return this.status(); }
  stop() {
    const { runner } = this._need();
    runner.say('Your invigilator has ended the exam. Your answers are saved.');
    runner.end('stopped');
    return this.status();
  }

  _need() {
    if (!this.active) throw Object.assign(new Error('No exam is running.'), { status: 409 });
    return this.current;
  }

  /** For the exam screen and the invigilator. */
  status() {
    if (!this.current) return { active: false };
    const { exam, attempt, runner } = this.current;
    const snap = runner.snapshot();
    const item = runner.item;
    return {
      ...snap,
      active: this.active,
      attemptId: attempt.id,
      examId: exam.id,
      title: exam.title,
      studentName: attempt.student_name,
      item: item ? { key: item.key, label: item.label, speech: runner.itemSpeech(runner.index), multipleChoice: runner.isMultipleChoice() } : null,
      answer: item ? runner.answers[item.key] || { text: '', choice: null } : null,
      paused: !!snap.pausedAt,
    };
  }

  _announce() {
    this.broadcast({ type: 'exam_state', state: this.status(), timestamp: new Date().toISOString() });
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
