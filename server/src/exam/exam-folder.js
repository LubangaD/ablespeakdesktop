/**
 * The exam folder: a teacher saves a paper (Word or PDF) into
 * Documents\AbleSpeak Exams, and it is read and listed on the Exams page,
 * ready to check — no upload step. Nothing is started from here: a teacher
 * still checks the questions and starts each sitting.
 *
 * A file is read once for each version of its contents. Saving it again
 * re-reads it; if no teacher has changed the exam and no student has sat it,
 * the same exam is replaced, otherwise it comes in as a new one. Deleting an
 * exam does not bring it back while the file stays the same.
 */
import { watch } from 'chokidar';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { paperLines, PaperError } from './paper-import.js';
import { parsePaper } from './paper-parse.js';
import { cleanPaper, cleanSettings } from './exam-routes.js';
import * as store from '../db.js';

export const EXAM_FOLDER_NAME = 'AbleSpeak Exams';

/** Documents\AbleSpeak Exams (Electron passes the real Documents folder, which OneDrive may have moved). */
export function defaultExamFolder() {
  if (process.env.ABLESPEAK_EXAM_FOLDER) return process.env.ABLESPEAK_EXAM_FOLDER;
  return join(process.env.ABLESPEAK_DOCUMENTS || join(homedir(), 'Documents'), EXAM_FOLDER_NAME);
}

/** A paper, not Word's lock file ("~$paper.docx") or anything else left in the folder. */
export const isPaperFile = path => {
  const name = basename(path);
  return !name.startsWith('~$') && !name.startsWith('.') && ['.docx', '.pdf', '.doc'].includes(extname(name).toLowerCase());
};

export class ExamFolder {
  /**
   * onChange({ type: 'imported' | 'problem' | 'cleared', fileName, examId? }): tell the dashboard
   * settleMs: how long a file must stop changing before it is read (a save in progress)
   */
  constructor({ dir = defaultExamFolder(), db = store, onChange = () => {}, settleMs = 1500 } = {}) {
    this.dir = dir;
    this.db = db;
    this.onChange = onChange;
    this.settleMs = settleMs;
    this.problems = new Map(); // path → { fileName, error, at }
    this.watcher = null;
    this.queue = Promise.resolve();
  }

  start() {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      console.warn(`[ExamFolder] Could not make ${this.dir}: ${err.message}`);
      return this;
    }
    this.watcher = watch(this.dir, {
      depth: 0,
      ignoreInitial: false, // papers saved while AbleSpeak was closed are picked up at start
      awaitWriteFinish: { stabilityThreshold: this.settleMs, pollInterval: 200 },
      ignored: (path, stats) => !!stats?.isFile() && !isPaperFile(path),
    });
    const read = path => { this.queue = this.queue.then(() => this.importFile(path)).catch(() => {}); };
    this.watcher.on('add', read).on('change', read).on('unlink', path => {
      if (this.problems.delete(path)) this.onChange({ type: 'cleared', fileName: basename(path) });
    });
    this.watcher.on('error', err => console.warn('[ExamFolder] Watch error:', err.message));
    console.log(`[ExamFolder] Watching ${this.dir}`);
    return this;
  }

  async stop() {
    await this.watcher?.close();
    this.watcher = null;
    await this.queue;
  }

  /** Read one paper from the folder. Returns the exam it became, or null. */
  async importFile(path) {
    if (!isPaperFile(path)) return null;
    const fileName = basename(path);
    try {
      const buffer = readFileSync(path);
      const hash = createHash('sha256').update(buffer).digest('hex');
      const seen = `exam_folder:${hash}`;
      if (this.db.getDeviceState(seen)) return null; // these contents were read before

      const parsed = parsePaper(await paperLines(buffer, fileName));
      const paper = cleanPaper(parsed);
      const title = paper.title && paper.title !== 'Exam' ? paper.title : fileName.replace(/\.[^.]+$/, '');
      const before = this.db.getExamBySourcePath(path);
      const untouched = before && !before.updated_at && this.db.getExamAttempts({ examId: before.id }).length === 0;
      const exam = untouched
        ? this.db.replaceExamFromFile(before.id, { title, paper, warnings: parsed.warnings, source_hash: hash })
        : this.db.insertExam({
          id: uuidv4(), title, file_name: fileName, paper, settings: cleanSettings({}),
          warnings: parsed.warnings, source_path: path, source_hash: hash,
        });
      this.db.setDeviceState(seen, exam.id);
      this.problems.delete(path);
      console.log(`[ExamFolder] ${untouched ? 'Re-read' : 'Read'} "${fileName}": ${paper.questions.length} questions`);
      this.onChange({ type: 'imported', fileName, examId: exam.id });
      return exam;
    } catch (err) {
      const error = err instanceof PaperError || err.status === 400 ? err.message
        : err.code === 'EBUSY' || err.code === 'EPERM' ? 'The file is open in another program. Close it there, and it will be read.'
          : 'This file could not be read.';
      if (!(err instanceof PaperError)) console.warn(`[ExamFolder] "${fileName}": ${err.message}`);
      this.problems.set(path, { fileName, error, at: new Date().toISOString() });
      this.onChange({ type: 'problem', fileName });
      return null;
    }
  }

  /** For the Exams page: where the folder is, and the files in it that could not be read. */
  status() {
    return { path: this.dir, watching: !!this.watcher, problems: [...this.problems.values()] };
  }
}
