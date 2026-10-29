import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { PAGE, CARD, MUTED, BODY, QUIET, DANGER, PRIMARY, DOT, INK } from '../lib/ui';

/**
 * The exam being sat, in large print: for a student with low vision, and for
 * the invigilator, who can pause or end it. Updated live from the server
 * (App.jsx passes on 'exam_state' as the 'ablespeak-exam' window event).
 */

export const EXAM_EVENT = 'ablespeak-exam';

const MODE = {
  browse: ['idle', 'Listening for a command'],
  answering: ['ok', 'Writing the answer — say "done" to finish'],
  confirm_finish: ['warn', 'Waiting for yes or no'],
  confirm_clear: ['warn', 'Waiting for yes or no'],
  finished: ['idle', 'Finished'],
};
const ENDED = { finished: 'The student finished the exam.', time_up: 'The time ran out.', stopped: 'The invigilator ended the exam.' };

function clock(ms) {
  if (ms == null) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

const savedSize = () => {
  try { return Number(localStorage.getItem('examTextSize')) || 28; } catch { return 28; }
};

export default function ExamScreen() {
  const [exam, setExam] = useState(null);
  const [error, setError] = useState('');
  const [size, setSize] = useState(savedSize);
  const [now, setNow] = useState(Date.now());
  const [stamp, setStamp] = useState(Date.now()); // when `exam` arrived, for the countdown

  useEffect(() => {
    let alive = true;
    api.getLiveExam().then(s => { if (alive) { setExam(s); setStamp(Date.now()); } }).catch(err => setError(err.message));
    const onEvent = e => { if (e.detail?.state) { setExam(e.detail.state); setStamp(Date.now()); } };
    window.addEventListener(EXAM_EVENT, onEvent);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; window.removeEventListener(EXAM_EVENT, onEvent); clearInterval(tick); };
  }, []);

  useEffect(() => { try { localStorage.setItem('examTextSize', String(size)); } catch { /* private window */ } }, [size]);

  async function act(fn, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setError('');
    try {
      setExam(await fn());
      setStamp(Date.now());
    } catch (err) {
      setError(err.adminRequired || err.status === 401 || err.status === 403
        ? 'Only a teacher (helper or admin) can do this. Unlock the Exams page first.' : err.message);
    }
  }

  if (!exam) {
    return <div className={PAGE}><p className={MUTED}>{error || 'Loading…'}</p></div>;
  }
  if (!exam.attemptId) {
    return (
      <div className={PAGE}>
        <p className={BODY} style={{ fontSize: size }}>No exam is running on this computer.</p>
        <Link to="/exams" className={`${QUIET} mt-6`}>Go to Exams</Link>
      </div>
    );
  }

  const remaining = exam.remainingMs != null && !exam.paused && exam.active ? exam.remainingMs - (now - stamp) : exam.remainingMs;
  const [tone, modeWord] = exam.paused ? ['warn', 'Paused — the clock has stopped'] : MODE[exam.mode] || ['idle', exam.mode];
  const answer = exam.answer || {};
  const small = { fontSize: Math.max(15, Math.round(size * 0.55)) };
  const big = { fontSize: size, lineHeight: 1.45 };
  // The question as it is read, without its number (shown above) or what was answered (shown below)
  const question = (exam.item?.speech || '')
    .replace(/^Question [^.]+\.\s*/, '')
    .replace(/\s*(You chose [A-F]\.|You have written an answer\..*)$/, '');

  return (
    <div className={`${PAGE} max-w-[1100px]`}>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <h1 className="font-heading font-semibold text-[var(--ink)]" style={{ fontSize: Math.round(size * 0.85) }}>{exam.title}</h1>
        <span className="flex-1" />
        {remaining != null && (
          <p className={`font-heading tabular-nums font-semibold ${remaining < 5 * 60000 ? 'text-[var(--bad)]' : 'text-[var(--ink)]'}`} style={{ fontSize: size }}
            aria-label={`Time left ${clock(remaining)}`}>
            {clock(remaining)}
          </p>
        )}
      </header>
      <p className={`${MUTED} mt-1`} style={small}>
        {exam.studentName || 'Student'} · {exam.answeredCount} of {exam.total} answered
      </p>

      {!exam.active ? (
        <section className={`${CARD} mt-6 p-6`} role="status">
          <p className={BODY} style={big}>The exam has ended. {ENDED[exam.finishedReason] || ''}</p>
          <p className={`${MUTED} mt-2`} style={small}>The answers are saved. The teacher can download the script from the Exams page.</p>
          <Link to="/exams" className={`${PRIMARY} mt-6`}>Go to Exams</Link>
        </section>
      ) : (
        <>
          <section className={`${CARD} mt-6 p-6`} aria-labelledby="question-label">
            <p id="question-label" className="font-semibold text-[var(--ink)]" style={{ fontSize: Math.round(size * 0.75) }}>
              {exam.item?.label} <span className="text-[var(--ink-quiet)] font-normal">— {exam.index + 1} of {exam.total}</span>
            </p>
            <p className="mt-3 text-[var(--ink)] whitespace-pre-wrap" style={big}>{question}</p>
          </section>

          <section className={`${CARD} mt-4 p-6`} aria-labelledby="answer-label">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="answer-label" className="font-semibold text-[var(--ink)]" style={{ fontSize: Math.round(size * 0.75) }}>Answer</h2>
              <span className={`inline-flex items-center gap-2 ${INK[tone]}`} style={small}>
                <span className={`h-3 w-3 rounded-full ${DOT[tone]}`} />{modeWord}
              </span>
              {exam.maths && <span className={MUTED} style={small}>· Maths on</span>}
            </div>
            <div className="mt-3 rounded-lg bg-[var(--sunken)] border border-white/[0.10] p-5 min-h-[120px]">
              {answer.choice ? (
                <p className="text-[var(--ink)] font-semibold" style={big}>{answer.choice}</p>
              ) : answer.text?.trim() ? (
                <p className="text-[var(--ink)] whitespace-pre-wrap" style={big}>{answer.text}</p>
              ) : (
                <p className="text-[var(--ink-faint)]" style={big}>No answer yet</p>
              )}
            </div>
            {exam.lastHeard && <p className={`${MUTED} mt-3`} style={small}>Heard: “{exam.lastHeard}”</p>}
          </section>
        </>
      )}

      <footer className="mt-8 flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-5">
        <span className={MUTED}>Text size</span>
        <button type="button" className={QUIET} onClick={() => setSize(s => Math.max(18, s - 4))} aria-label="Smaller text">A−</button>
        <button type="button" className={QUIET} onClick={() => setSize(s => Math.min(64, s + 4))} aria-label="Larger text">A+</button>
        <span className="flex-1" />
        {exam.active && (
          <>
            <span className={MUTED}>Invigilator:</span>
            {exam.paused
              ? <button type="button" className={PRIMARY} onClick={() => act(api.unpauseExam)}>Carry on</button>
              : <button type="button" className={QUIET} onClick={() => act(api.pauseExam)}>Pause</button>}
            <button type="button" className={DANGER}
              onClick={() => act(api.stopExam, 'End this exam now? The answers so far are kept, and the student cannot carry on.')}>
              End exam
            </button>
          </>
        )}
      </footer>
      {error && <p role="alert" className={`${INK.bad} mt-3`}>{error}</p>}
    </div>
  );
}
