import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadFile } from '../lib/api';
import {
  TITLE, SECTION, LABEL, MUTED, BODY, PAGE, CARD, WELL, PRIMARY, QUIET, SMALL_QUIET, ROW_ACTION, FIELD, DOT, INK, TH, TD,
} from '../lib/ui';

/**
 * Exams (helpers and admins): upload a paper (Word or PDF), check the
 * questions AbleSpeak found and fix any, start it for a student, and
 * download each finished script and its audit trail.
 */

const STATUS = {
  in_progress: ['warn', 'Not finished'],
  finished: ['ok', 'Finished'],
  time_up: ['ok', 'Time ran out'],
  stopped: ['idle', 'Ended by invigilator'],
};

const when = iso => {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

// ── Upload ──

function UploadCard({ onImported }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [minutes, setMinutes] = useState('');
  const [readBack, setReadBack] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(e) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const data = await readAsBase64(file);
      const result = await api.importExam(file.name, data, { timeLimitMin: minutes ? Number(minutes) : null, readBack });
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      onImported(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${CARD} p-5`} aria-labelledby="upload-heading">
      <h2 id="upload-heading" className={SECTION}>Or upload a paper here</h2>
      <p className={`${MUTED} mt-1`}>
        Upload the paper as a Word document (.docx) or a PDF saved from Word. AbleSpeak finds the numbered questions,
        their parts and options, and you check them before any student sits it.
      </p>
      <form onSubmit={upload} className="mt-4 grid gap-4 sm:grid-cols-[1fr_180px] items-end">
        <label className="block">
          <span className={LABEL}>Exam paper</span>
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={e => setFile(e.target.files?.[0] || null)}
            className={`${FIELD} mt-1 py-2 file:mr-3 file:rounded-md file:border-0 file:bg-[var(--raised)] file:px-3 file:py-1.5 file:text-[var(--ink)]`}
          />
        </label>
        <label className="block">
          <span className={LABEL}>Time allowed (minutes)</span>
          <input type="number" min="1" max="600" inputMode="numeric" placeholder="No limit" value={minutes}
            onChange={e => setMinutes(e.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="flex items-center gap-2 sm:col-span-2">
          <input type="checkbox" checked={readBack} onChange={e => setReadBack(e.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />
          <span className={BODY}>Read each answer back to the student as it is written (recommended for blind students)</span>
        </label>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <button type="submit" className={PRIMARY} disabled={!file || busy}>{busy ? 'Reading the paper…' : 'Upload and check'}</button>
          {error && <p role="alert" className={`${INK.bad} text-[14px]`}>{error}</p>}
        </div>
      </form>
    </section>
  );
}

// ── The exam folder ──

function FolderCard() {
  const folder = useQuery({ queryKey: ['examFolder'], queryFn: api.getExamFolder, refetchInterval: 15_000 });
  const [error, setError] = useState('');
  if (!folder.data?.path) return null;
  async function open() {
    setError('');
    try { await api.openExamFolder(); } catch (err) { setError(err.message); }
  }
  return (
    <section className={`${CARD} p-5`} aria-labelledby="folder-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="folder-heading" className={SECTION}>Exam folder</h2>
        <span className="flex-1" />
        <button type="button" className={QUIET} onClick={open}>Open the folder</button>
      </div>
      <p className={`${MUTED} mt-1`}>
        Save a paper (Word or PDF) into this folder and it appears under Exam papers by itself, ready for you to check. Nothing starts until you start it.
      </p>
      <p className={`${WELL} mt-3 px-3 py-2 ${BODY} break-all`}>{folder.data.path}</p>
      {error && <p role="alert" className={`${INK.bad} mt-2 text-[14px]`}>{error}</p>}
      {folder.data.problems.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Files that could not be read">
          {folder.data.problems.map(p => (
            <li key={p.fileName} className={`flex gap-2 ${BODY}`}>
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT.bad}`} />
              <span><strong>{p.fileName}</strong> was not read. {p.error}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Check and fix the questions ──

const blankQuestion = n => ({ number: String(n), section: null, text: '', marks: null, options: [], parts: [], picture: false });
const toMarks = v => (v === '' ? null : Number(v));

function OptionsEditor({ options, onChange }) {
  const set = (i, text) => onChange(options.map((o, j) => (j === i ? { ...o, text } : o)));
  const add = () => onChange([...options, { letter: String.fromCharCode(65 + options.length), text: '' }]);
  const remove = i => onChange(options.filter((_, j) => j !== i).map((o, j) => ({ ...o, letter: String.fromCharCode(65 + j) })));
  return (
    <div className="mt-2 space-y-2">
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className={`${BODY} w-6 text-center font-semibold`} aria-hidden="true">{o.letter}</span>
          <input className={FIELD} value={o.text} aria-label={`Option ${o.letter}`} onChange={e => set(i, e.target.value)} />
          <button type="button" className={ROW_ACTION} onClick={() => remove(i)} aria-label={`Remove option ${o.letter}`}>Remove</button>
        </div>
      ))}
      {options.length < 8 && <button type="button" className={SMALL_QUIET} onClick={add}>{options.length ? 'Add option' : 'Make it multiple choice'}</button>}
    </div>
  );
}

function QuestionEditor({ q, onChange, onRemove }) {
  const set = changes => onChange({ ...q, ...changes });
  const setPart = (i, changes) => set({ parts: q.parts.map((p, j) => (j === i ? { ...p, ...changes } : p)) });
  const hasPicture = q.picture || q.parts.some(p => p.picture);
  return (
    <li className={`${WELL} p-4`}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className={SECTION}>Question {q.number}</h3>
        {q.section && <span className={MUTED}>Section {q.section}</span>}
        {hasPicture && (
          <span className={`flex items-center gap-1.5 ${INK.warn} text-[13px]`}>
            <span className={`h-2 w-2 rounded-full ${DOT.warn}`} />Has a picture AbleSpeak cannot read — describe it in the words
          </span>
        )}
        <span className="flex-1" />
        <button type="button" className={ROW_ACTION} onClick={onRemove} aria-label={`Remove question ${q.number}`}>Remove question</button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_110px]">
        <label className="block">
          <span className={LABEL}>{q.parts.length ? 'Question words (read before its parts)' : 'Question'}</span>
          <textarea className={`${FIELD} mt-1 py-2 min-h-[72px]`} value={q.text} onChange={e => set({ text: e.target.value })} />
        </label>
        {!q.parts.length && (
          <label className="block">
            <span className={LABEL}>Marks</span>
            <input type="number" min="0" className={`${FIELD} mt-1`} value={q.marks ?? ''} onChange={e => set({ marks: toMarks(e.target.value) })} />
          </label>
        )}
      </div>
      {!q.parts.length && <OptionsEditor options={q.options} onChange={options => set({ options })} />}
      {q.parts.length > 0 && (
        <ol className="mt-3 space-y-3">
          {q.parts.map((p, i) => (
            <li key={i} className="grid gap-3 sm:grid-cols-[70px_1fr_110px] items-start">
              <label className="block">
                <span className={LABEL}>Part</span>
                <input className={`${FIELD} mt-1`} value={p.label} onChange={e => setPart(i, { label: e.target.value.toLowerCase() })} />
              </label>
              <div>
                <label className="block">
                  <span className={LABEL}>{p.introOnly ? 'Introduces the parts below it' : 'Part question'}</span>
                  <textarea className={`${FIELD} mt-1 py-2 min-h-[56px]`} value={p.text} onChange={e => setPart(i, { text: e.target.value })} />
                </label>
                {!p.introOnly && <OptionsEditor options={p.options} onChange={options => setPart(i, { options })} />}
              </div>
              {!p.introOnly && (
                <label className="block">
                  <span className={LABEL}>Marks</span>
                  <input type="number" min="0" className={`${FIELD} mt-1`} value={p.marks ?? ''} onChange={e => setPart(i, { marks: toMarks(e.target.value) })} />
                </label>
              )}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function ExamEditor({ examId, warnings = [], onClose, onSaved }) {
  const { data: exam, error } = useQuery({ queryKey: ['exam', examId], queryFn: () => api.getExam(examId) });
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => { if (exam) setDraft(structuredClone(exam)); }, [exam]);
  if (error) return <p role="alert" className={INK.bad}>{error.message}</p>;
  if (!draft) return <p className={MUTED}>Loading the exam…</p>;

  const paper = draft.paper;
  const toCheck = warnings.length ? warnings : exam.warnings || [];
  const setPaper = changes => setDraft({ ...draft, paper: { ...paper, ...changes } });
  const setQuestion = (i, q) => setPaper({ questions: paper.questions.map((x, j) => (j === i ? q : x)) });

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      await api.saveExam(examId, {
        title: draft.title,
        paper: { ...paper, instructions: (paper.instructions || []).filter(l => l.trim()) },
        settings: draft.settings,
      });
      setMessage('Saved.');
      onSaved();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`${CARD} p-5`} aria-labelledby="check-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="check-heading" className={SECTION}>Check the questions</h2>
        <span className="flex-1" />
        <button type="button" className={QUIET} onClick={onClose}>Close</button>
        <button type="button" className={PRIMARY} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : exam.checked === false ? 'Checked — save' : 'Save changes'}
        </button>
      </div>
      <p className={`${MUTED} mt-1`}>
        This is exactly what AbleSpeak will read to the student. Fix any question it split wrongly, and describe any picture or diagram in words.
      </p>
      {message && <p role="status" className={`${BODY} mt-2`}>{message}</p>}
      {toCheck.length > 0 && (
        <ul className={`${WELL} mt-4 p-4 space-y-1`} aria-label="Things to check">
          {toCheck.map(w => <li key={w} className={`flex gap-2 ${BODY}`}><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT.warn}`} />{w}</li>)}
        </ul>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_180px_auto] items-end">
        <label className="block">
          <span className={LABEL}>Exam title (read to the student)</span>
          <input className={`${FIELD} mt-1`} value={draft.title}
            onChange={e => setDraft({ ...draft, title: e.target.value, paper: { ...paper, title: e.target.value } })} />
        </label>
        <label className="block">
          <span className={LABEL}>Time allowed (minutes)</span>
          <input type="number" min="1" className={`${FIELD} mt-1`} placeholder="No limit" value={draft.settings?.timeLimitMin ?? ''}
            onChange={e => setDraft({ ...draft, settings: { ...draft.settings, timeLimitMin: e.target.value ? Number(e.target.value) : null } })} />
        </label>
        <label className="flex items-center gap-2 min-h-[44px]">
          <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={draft.settings?.readBack !== false}
            onChange={e => setDraft({ ...draft, settings: { ...draft.settings, readBack: e.target.checked } })} />
          <span className={BODY}>Read answers back</span>
        </label>
      </div>
      <label className="block mt-4">
        <span className={LABEL}>Instructions (read when the student says "read the instructions")</span>
        <textarea className={`${FIELD} mt-1 py-2 min-h-[60px]`} value={(paper.instructions || []).join('\n')}
          onChange={e => setPaper({ instructions: e.target.value.split('\n') })} />
      </label>
      <ol className="mt-4 space-y-3">
        {paper.questions.map((q, i) => (
          <QuestionEditor key={i} q={q}
            onChange={next => setQuestion(i, next)}
            onRemove={() => setPaper({ questions: paper.questions.filter((_, j) => j !== i) })} />
        ))}
      </ol>
      <button type="button" className={`${SMALL_QUIET} mt-3`}
        onClick={() => setPaper({ questions: [...paper.questions, blankQuestion(paper.questions.length + 1)] })}>
        Add a question
      </button>
    </section>
  );
}

// ── Start a sitting ──

function StartExam({ exam, students, disabled, onStarted }) {
  const [studentId, setStudentId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    setError('');
    try {
      await api.startExam(exam.id, Number(studentId));
      onStarted();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`student-${exam.id}`}>Student for {exam.title}</label>
      <select id={`student-${exam.id}`} className={`${FIELD} w-auto min-w-[180px]`} value={studentId} onChange={e => setStudentId(e.target.value)}>
        <option value="">Choose the student…</option>
        {students.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button type="button" className={PRIMARY} onClick={start} disabled={!studentId || busy || disabled || !exam.answerItems}>Start exam</button>
      {error && <p role="alert" className={`${INK.bad} text-[13px] w-full`}>{error}</p>}
    </div>
  );
}

// ── The page ──

export default function Exams() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const exams = useQuery({ queryKey: ['exams'], queryFn: api.getExams });
  const attempts = useQuery({ queryKey: ['examAttempts'], queryFn: api.getExamAttempts, refetchInterval: 10_000 });
  const students = useQuery({ queryKey: ['students'], queryFn: api.getStudents });
  const live = useQuery({ queryKey: ['liveExam'], queryFn: api.getLiveExam, refetchInterval: 5_000 });
  const [editing, setEditing] = useState(null); // { id, warnings }
  const [notice, setNotice] = useState('');
  const running = !!live.data?.active;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['exams'] });
    queryClient.invalidateQueries({ queryKey: ['examAttempts'] });
    queryClient.invalidateQueries({ queryKey: ['liveExam'] });
  };

  async function remove(exam) {
    if (!window.confirm(`Delete "${exam.title}" and every sitting of it, with their scripts and audit trails? This cannot be undone.`)) return;
    try {
      await api.deleteExam(exam.id);
      if (editing?.id === exam.id) setEditing(null);
      refresh();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function download(path) {
    setNotice('');
    try { await downloadFile(path); } catch (err) { setNotice(err.message); }
  }

  async function resume(attempt) {
    try {
      await api.resumeExamAttempt(attempt.id);
      navigate('/exam');
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <div className={PAGE}>
      <h1 className={TITLE}>Exams</h1>
      <p className={`${MUTED} mt-1 max-w-[760px]`}>
        AbleSpeak reads each question aloud and writes down the student's spoken answers exactly as said. During an exam
        the AI assistant, the web and every other tool are switched off. Afterwards, download the script for marking.
      </p>

      {running && (
        <div className={`${CARD} mt-5 p-4 flex flex-wrap items-center gap-3`} role="status">
          <span className={`h-2.5 w-2.5 rounded-full ${DOT.ok}`} />
          <span className={BODY}>
            <strong>{live.data.studentName || 'A student'}</strong> is sitting {live.data.title} — {live.data.answeredCount} of {live.data.total} answered.
          </span>
          <span className="flex-1" />
          <button type="button" className={PRIMARY} onClick={() => navigate('/exam')}>Open the exam screen</button>
        </div>
      )}
      {notice && <p role="alert" className={`${INK.bad} mt-4`}>{notice}</p>}

      <div className="mt-6 space-y-6">
        <FolderCard />

        <UploadCard onImported={({ exam, warnings }) => { setEditing({ id: exam.id, warnings }); refresh(); }} />

        {editing && (
          <ExamEditor key={editing.id} examId={editing.id} warnings={editing.warnings}
            onClose={() => setEditing(null)} onSaved={refresh} />
        )}

        <section className={`${CARD} p-5`} aria-labelledby="exams-heading">
          <h2 id="exams-heading" className={SECTION}>Exam papers</h2>
          {exams.isLoading ? <p className={`${MUTED} mt-3`}>Loading…</p>
            : exams.error ? <p role="alert" className={`${INK.bad} mt-3`}>{exams.error.message}</p>
              : !exams.data?.length ? <p className={`${MUTED} mt-3`}>No exams yet. Upload a paper above.</p>
                : (
                  <ul className="mt-3 divide-y divide-white/[0.06]">
                    {exams.data.map(exam => (
                      <li key={exam.id} className="py-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                        <div className="min-w-[220px] flex-1">
                          <p className={`${BODY} font-semibold`}>{exam.title}</p>
                          {!exam.checked && (
                            <p className={`flex items-center gap-1.5 ${INK.warn} text-[13px]`}>
                              <span className={`h-2 w-2 rounded-full ${DOT.warn}`} />
                              New from the exam folder — check its questions before a student sits it
                              {exam.warnings.length ? ` (${exam.warnings.length} to look at)` : ''}
                            </p>
                          )}
                          <p className={MUTED}>
                            {exam.answerItems} {exam.answerItems === 1 ? 'answer' : 'answers'}
                            {' · '}{exam.settings?.timeLimitMin ? `${exam.settings.timeLimitMin} min` : 'no time limit'}
                            {' · '}added {when(exam.createdAt)}
                            {exam.attempts ? ` · sat ${exam.attempts} ${exam.attempts === 1 ? 'time' : 'times'}` : ''}
                          </p>
                        </div>
                        <button type="button" className={ROW_ACTION} onClick={() => setEditing({ id: exam.id, warnings: [] })}>Check questions</button>
                        <button type="button" className={ROW_ACTION} onClick={() => remove(exam)}>Delete</button>
                        <StartExam exam={exam} students={students.data || []} disabled={running || !exam.checked}
                          onStarted={() => { refresh(); navigate('/exam'); }} />
                      </li>
                    ))}
                  </ul>
                )}
          {students.data && !students.data.length && (
            <p className={`${MUTED} mt-2`}>Add the student on the Users page first, so their name is on the script.</p>
          )}
        </section>

        <section className={`${CARD} p-5`} aria-labelledby="sittings-heading">
          <h2 id="sittings-heading" className={SECTION}>Sittings and scripts</h2>
          {!attempts.data?.length ? <p className={`${MUTED} mt-3`}>No one has sat an exam yet.</p> : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className={TH}>Student</th><th className={TH}>Exam</th><th className={TH}>Started</th>
                    <th className={TH}>Answered</th><th className={TH}>Status</th><th className={TH}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.data.map(a => {
                    const now = running && live.data.attemptId === a.id;
                    const [tone, word] = now ? ['ok', 'Being sat now'] : STATUS[a.status] || ['idle', a.status];
                    return (
                      <tr key={a.id} className="border-b border-white/[0.04]">
                        <td className={TD}>{a.studentName || '—'}</td>
                        <td className={TD}>{a.examTitle || '—'}</td>
                        <td className={TD}>{when(a.startedAt)}</td>
                        <td className={TD}>{a.total ? `${a.answered} of ${a.total}` : '—'}</td>
                        <td className={TD}><span className={`inline-flex items-center gap-1.5 ${INK[tone]}`}><span className={`h-2 w-2 rounded-full ${DOT[tone]}`} />{word}</span></td>
                        <td className={`${TD} whitespace-nowrap text-right`}>
                          {a.status === 'in_progress' && !running && (
                            <button type="button" className={ROW_ACTION} onClick={() => resume(a)}>Carry on</button>
                          )}
                          <button type="button" className={ROW_ACTION} onClick={() => download(`/exams/attempts/${a.id}/script.docx`)}>Script (Word)</button>
                          <button type="button" className={ROW_ACTION} onClick={() => download(`/exams/attempts/${a.id}/audit.csv`)}>Audit trail</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={`${CARD} p-5`} aria-labelledby="say-heading">
          <h2 id="say-heading" className={SECTION}>What the student can say</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div className={`${WELL} p-4`}>
              <p className={`${BODY} font-semibold`}>Moving and hearing</p>
              <p className={`${MUTED} mt-1`}>"Read the question", "read the options", "next", "previous", "go to question 5", "go to question 2 b", "slower", "faster", "how much time is left", "where am I", "unanswered questions", "read the instructions", "help", "finish exam".</p>
            </div>
            <div className={`${WELL} p-4`}>
              <p className={`${BODY} font-semibold`}>Answering</p>
              <p className={`${MUTED} mt-1`}>"Answer B" for a choice. "Answer" to start writing: everything said is written until "done". "Full stop", "comma", "new paragraph"; "delete the last word", "delete the last sentence", "undo", "read my answer", "spell m i t o" to write a word letter by letter; "maths on" for symbols.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
