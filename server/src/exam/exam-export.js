/**
 * What the teacher downloads after a sitting: the candidate's script as a
 * Word document — each question with the answer exactly as written — with a
 * cover saying how it was produced, and the audit trail as a CSV file.
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle,
} from 'docx';
import { answerItems, findItem } from './paper-parse.js';

const ENDINGS = {
  finished: 'Finished by the candidate',
  time_up: 'Ended when the time ran out',
  stopped: 'Ended by the invigilator',
  in_progress: 'Not finished',
};

const when = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};

const para = (text, opts = {}) => {
  const { run, ...rest } = opts;
  return new Paragraph({ spacing: { after: 120 }, ...rest, children: [new TextRun({ text, ...(run || {}) })] });
};

function factsTable(rows) {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const borders = { top: none, bottom: none, left: none, right: none };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([k, v]) => new TableRow({
      children: [
        new TableCell({ borders, width: { size: 30, type: WidthType.PERCENTAGE }, children: [para(k, { run: { bold: true } })] }),
        new TableCell({ borders, width: { size: 70, type: WidthType.PERCENTAGE }, children: [para(v)] }),
      ],
    })),
  });
}

/** Lines of an answer as paragraphs, keeping the candidate's own line breaks. */
const answerParagraphs = text => String(text).split(/\n/).map(line => para(line || ' ', { indent: { left: 360 } }));

/**
 * The script: cover, then every question and its answer.
 * exam: { title, paper, settings }   attempt: { student_name, started_at, finished_at, status, state }
 * audit: { ok, events }
 */
export async function scriptDocx({ exam, attempt, audit }) {
  const paper = exam.paper;
  const answers = attempt.state?.answers || {};
  const items = answerItems(paper);
  const answered = items.filter(i => answers[i.key]?.choice || answers[i.key]?.text?.trim()).length;
  const settings = exam.settings || {};

  const cover = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(paper.title || exam.title)] }),
    factsTable([
      ['Candidate', attempt.student_name || '—'],
      ['Exam', exam.title],
      ['Started', when(attempt.started_at)],
      ['Ended', when(attempt.finished_at)],
      ['How it ended', ENDINGS[attempt.status] || attempt.status],
      ['Time allowed', settings.timeLimitMin ? `${settings.timeLimitMin} minutes${attempt.state?.pausedMs ? ` (paused for ${Math.round(attempt.state.pausedMs / 60000)} min)` : ''}` : 'No time limit'],
      ['Questions answered', `${answered} of ${items.length}`],
    ]),
    para(''),
    para('How this script was produced', { heading: HeadingLevel.HEADING_2 }),
    para('The questions were read aloud to the candidate by AbleSpeak exam mode. The candidate gave every answer by voice, and AbleSpeak wrote down the words exactly as they were transcribed. Spoken punctuation ("full stop", "comma") became punctuation marks, and in maths mode spoken maths ("x squared") became symbols. Nothing was reworded, corrected or completed.'),
    para('During the exam AbleSpeak\'s AI assistant, web access and every other tool were switched off: the candidate could only move between questions, hear them, and give answers. Speech was transcribed by Google Gemini over the internet.'),
    para(`Audit trail: ${audit.events} recorded events — ${audit.ok ? 'the integrity check passed (no event has been changed or removed).' : 'the integrity check FAILED: the audit trail has been changed since it was written.'}`, { run: { bold: !audit.ok } }),
    para(''),
    para('Invigilator name: ______________________   Signature: ______________________   Date: ____________'),
  ];

  const body = [];
  let lastSection = null;
  let lastNumber = null;
  for (const item of items) {
    const { question, part, intro } = findItem(paper, item.key);
    if (question.section && question.section !== lastSection) {
      lastSection = question.section;
      body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: body.length === 0, children: [new TextRun(`Section ${question.section}`)] }));
    }
    if (question.number !== lastNumber) {
      lastNumber = question.number;
      const marks = !part && question.marks ? ` (${question.marks} ${question.marks === 1 ? 'mark' : 'marks'})` : '';
      body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: body.length === 0, children: [new TextRun(`Question ${question.number}${marks}`)] }));
      if (part && question.text) body.push(para(question.text));
    }
    const unit = part || question;
    if (part) {
      if (intro?.text) body.push(para(intro.text));
      body.push(new Paragraph({ spacing: { after: 120 }, children: [
        new TextRun({ text: `(${part.label.replace(/^\(|\)$/g, '')}) `, bold: true }),
        new TextRun(unit.text || ''),
        ...(unit.marks ? [new TextRun({ text: ` (${unit.marks} ${unit.marks === 1 ? 'mark' : 'marks'})`, italics: true })] : []),
      ] }));
    } else if (unit.text) {
      body.push(para(unit.text));
    }
    for (const o of unit.options || []) body.push(para(`${o.letter}. ${o.text}`, { indent: { left: 360 } }));

    const a = answers[item.key];
    body.push(para('Answer:', { run: { bold: true }, spacing: { before: 120, after: 60 } }));
    if (a?.choice) {
      const option = unit.options?.find(o => o.letter === a.choice);
      body.push(para(`${a.choice}${option ? ` — ${option.text}` : ''}`, { indent: { left: 360 } }));
    } else if (a?.text?.trim()) {
      body.push(...answerParagraphs(a.text.trim()));
    } else {
      body.push(para('No answer given.', { indent: { left: 360 }, run: { italics: true } }));
    }
    body.push(para(''));
  }

  const doc = new Document({
    creator: 'AbleSpeak',
    title: `${exam.title} — ${attempt.student_name || 'candidate'}`,
    styles: { default: { document: { run: { font: 'Arial', size: 24 } } } },
    sections: [{ children: [...cover, ...body] }],
  });
  return Packer.toBuffer(doc);
}

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The audit trail, one event per row: time, what happened, on which question, heard / written / said. */
export function auditCsv(events) {
  const head = ['time', 'event', 'question', 'heard', 'written', 'said', 'detail', 'hash'];
  const rows = events.map(e => [e.at, e.kind, e.item, e.heard, e.written, e.said, e.detail, e.hash]);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** A file name a teacher can recognise: "Biology Paper 1 - Jane Wanjiru - 2026-10-13.docx". */
export function scriptFileName(exam, attempt, ext) {
  const safe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const day = String(attempt.started_at || '').slice(0, 10);
  return `${[safe(exam.title), safe(attempt.student_name), day].filter(Boolean).join(' - ')}.${ext}`;
}
