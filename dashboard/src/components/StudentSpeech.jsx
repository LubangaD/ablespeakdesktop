/**
 * The student's speech on the Teacher page (Stage 1, Stage 4):
 * how well AbleSpeak is hearing them, and the settings that help —
 * listening sensitivity, pause length, their words, their own shortcuts
 * and routines. Profiles can be saved to a file and loaded on another
 * computer.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

const SENSITIVITY_CHOICES = [
  { value: 'standard', label: 'Standard', hint: 'Most students, in a normal room.' },
  { value: 'quiet', label: 'Quiet voice', hint: 'For a soft or weak voice. Picks up more sound.' },
  { value: 'noisy', label: 'Noisy room', hint: 'Ignores more background talk. The student needs to speak up.' },
];

const percent = value => (value == null ? '—' : `${Math.round(value * 100)}%`);

function Stat({ label, value, detail }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
      {detail && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{detail}</div>}
    </div>
  );
}

// Did the last change to their speech settings help? (Stage 4 acceptance)
function RetriesComparison({ around }) {
  const { before, after, days, at } = around;
  const per = v => (v == null ? '—' : v.toFixed(1));
  const changed = at.slice(0, 10);
  let verdict = 'Not enough commands yet on both sides to compare.';
  if (before.tasks && after.tasks) {
    if (after.retriesPerTask < before.retriesPerTask) verdict = 'Fewer retries since the change.';
    else if (after.retriesPerTask > before.retriesPerTask) verdict = 'More retries since the change — review the settings.';
    else verdict = 'No difference yet.';
  }
  return (
    <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
      <strong style={{ color: 'var(--text-primary)' }}>Retries per finished command</strong>, {days} days either side of the
      settings change on {changed}: {per(before.retriesPerTask)} before ({before.tasks} commands) → {per(after.retriesPerTask)} after
      ({after.tasks} commands). {verdict}
    </p>
  );
}

export function RecognitionReadout({ studentId }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['recognition', studentId],
    queryFn: () => api.getRecognition(studentId, 7),
    refetchInterval: 30000,
  });

  return (
    <section aria-labelledby="recognition-heading" style={{ marginBottom: 24 }}>
      <h3 id="recognition-heading" style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>
        HOW WELL ABLESPEAK HEARS THEM — LAST 7 DAYS
      </h3>
      {isLoading && <p className="settings-lead">Loading…</p>}
      {error && <p className="settings-result error">Couldn't load this: {error.message}</p>}
      {data && (
        data.turns === 0 ? (
          <p className="settings-lead">Nothing heard from this student in the last 7 days.</p>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 12 }}>
              <Stat label="Understood" value={percent(data.heardRate)} detail={`${data.heard} of ${data.turns} times they spoke`} />
              <Stat label="Worked first time" value={percent(data.firstTimeRate)} detail={`${data.firstTime} of ${data.tasks} commands`} />
              <Stat label="Tried again" value={data.retries} detail={`${data.repaired} then worked`} />
              <Stat label="Set aside as noise" value={data.filtered + data.noSpeech} detail={`${data.filtered} with words`} />
            </div>
            {data.sinceSettingsChanged && (
              <RetriesComparison around={data.sinceSettingsChanged} />
            )}
            {data.recentlyFiltered.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
                  Words set aside as background talk ({data.recentlyFiltered.length}). If these were the student, try "Quiet voice" below.
                </summary>
                <ul style={{ margin: '4px 0 0 18px', color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7 }}>
                  {data.recentlyFiltered.map((turn, i) => (
                    <li key={i}><span style={{ color: 'var(--text-muted)' }}>{turn.created_at.slice(5, 16)}</span> — “{turn.transcript}”</li>
                  ))}
                </ul>
              </details>
            )}
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              Everyday readout from this computer. The speech study measures command match rate separately.
            </p>
          </>
        )
      )}
    </section>
  );
}

const linesOf = text => text.split('\n').map(line => line.trim()).filter(Boolean);

function blankShortcut() {
  return { say: '', means: '' };
}

function blankRoutine() {
  return { name: '', steps: '' };
}

export function SpeechSettings({ studentId, studentName }) {
  const queryClient = useQueryClient();
  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['profile', studentId],
    queryFn: () => api.getProfile(studentId),
  });

  const [sensitivity, setSensitivity] = useState('standard');
  const [pause, setPause] = useState(1.5);
  const [vocabulary, setVocabulary] = useState('');
  const [shortcuts, setShortcuts] = useState([]);
  const [routines, setRoutines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const fileInput = useRef(null);
  const loadedFor = useRef(null);

  // Fill the form from the saved profile when a student is first shown (or
  // after loading a file) — not on every refetch, which would wipe edits.
  useEffect(() => {
    if (!profile || loadedFor.current === studentId) return;
    loadedFor.current = studentId;
    setSensitivity(profile.listening.sensitivity);
    setPause(profile.listening.pauseSeconds);
    setVocabulary(profile.vocabulary.join('\n'));
    setShortcuts(profile.aliases.length ? profile.aliases.map(a => ({ ...a })) : []);
    setRoutines(profile.macros.map(m => ({ name: m.name, steps: m.steps.join('\n') })));
    setResult(null);
  }, [profile, studentId]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      await api.saveProfile(studentId, {
        listening: { sensitivity, pauseSeconds: Number(pause) },
        vocabulary: linesOf(vocabulary),
        aliases: shortcuts.filter(s => s.say.trim() || s.means.trim()),
        macros: routines
          .map(r => ({ name: r.name, steps: linesOf(r.steps) }))
          .filter(r => r.name.trim() || r.steps.length),
      });
      queryClient.invalidateQueries({ queryKey: ['profile', studentId] });
      setResult({ tone: 'success', text: `Saved. AbleSpeak uses these for ${studentName} straight away.` });
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async () => {
    setResult(null);
    try {
      const file = await api.exportProfile(studentId);
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `ablespeak-${studentName.replace(/[^A-Za-z0-9_-]+/g, '-')}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      setResult({ tone: 'success', text: 'Saved to a file. Load it on another computer with "Load from a file".' });
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    }
  };

  const importFile = async (e) => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    setResult(null);
    try {
      const file = JSON.parse(await chosen.text());
      const answer = await api.importProfile(file);
      if (answer.student?.id === Number(studentId)) loadedFor.current = null; // show what was loaded
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['students'] });
      setResult({
        tone: 'success',
        text: answer.created
          ? `Added ${answer.student.name} with their settings. Choose them above to use this computer.`
          : `Loaded the settings for ${answer.student.name}.`,
      });
    } catch (err) {
      setResult({ tone: 'error', text: err instanceof SyntaxError ? 'That file is not an AbleSpeak profile.' : err.message });
    }
  };

  const updateShortcut = (i, field, value) =>
    setShortcuts(list => list.map((s, j) => (j === i ? { ...s, [field]: value } : s)));
  const updateRoutine = (i, field, value) =>
    setRoutines(list => list.map((r, j) => (j === i ? { ...r, [field]: value } : r)));

  if (isLoading) return <p className="settings-lead">Loading speech settings…</p>;
  if (error) return <p className="settings-result error">Couldn't load speech settings: {error.message}</p>;

  return (
    <section aria-labelledby="speech-heading" className="card" style={{ marginBottom: 24 }}>
      <h3 id="speech-heading" className="settings-heading">Speech settings for {studentName}</h3>
      <p className="settings-lead">These follow {studentName} whenever their session is running on this computer.</p>

      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="settings-label">How sensitive the microphone is</legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {SENSITIVITY_CHOICES.map(choice => (
              <label key={choice.value} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, cursor: 'pointer' }}>
                <input type="radio" name="sensitivity" value={choice.value}
                  checked={sensitivity === choice.value}
                  onChange={() => setSensitivity(choice.value)}
                  style={{ width: 20, height: 20 }} />
                <span>
                  <strong style={{ color: 'var(--text-primary)' }}>{choice.label}</strong>
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}> — {choice.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="speech-pause" className="settings-label">
            Pause that ends a command: <strong>{Number(pause).toFixed(1)} seconds</strong>
          </label>
          <input id="speech-pause" type="range" min="0.8" max="4" step="0.1" value={pause}
            onChange={e => setPause(e.target.value)}
            style={{ width: '100%', minHeight: 44 }}
            aria-describedby="speech-pause-hint" />
          <p id="speech-pause-hint" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Longer suits a student who pauses in the middle of a command.
          </p>
        </div>

        <div>
          <label htmlFor="speech-words" className="settings-label">Their words — names, subjects, places (one per line)</label>
          <textarea id="speech-words" className="settings-input" rows={4} value={vocabulary}
            onChange={e => setVocabulary(e.target.value)}
            placeholder={'Wanjiku\nKiswahili\nKisumu'}
            style={{ height: 'auto', paddingTop: 10, paddingBottom: 10, resize: 'vertical' }} />
        </div>

        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="settings-label">Their own shortcuts</legend>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            When {studentName} says the phrase on the left, AbleSpeak does the command on the right.
            Shortcuts marked "learned" were added after {studentName} corrected the same thing twice.
          </p>
          {shortcuts.map((shortcut, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              <input className="settings-input" style={{ flex: '1 1 160px' }} value={shortcut.say}
                aria-label={`Shortcut ${i + 1}: what ${studentName} says`} placeholder="my music"
                onChange={e => updateShortcut(i, 'say', e.target.value)} />
              <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>→</span>
              <input className="settings-input" style={{ flex: '2 1 220px' }} value={shortcut.means}
                aria-label={`Shortcut ${i + 1}: what it does`} placeholder="open spotify"
                onChange={e => updateShortcut(i, 'means', e.target.value)} />
              {shortcut.learned && (
                <span className="badge badge-success" title={`Learned when ${studentName} corrected AbleSpeak twice`}>learned</span>
              )}
              <button type="button" className="settings-btn quiet"
                aria-label={`Remove shortcut ${i + 1}`}
                onClick={() => setShortcuts(list => list.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="settings-btn quiet" onClick={() => setShortcuts(list => [...list, blankShortcut()])}>
            Add a shortcut
          </button>
        </fieldset>

        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend className="settings-label">Routines</legend>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            A name {studentName} can say, and the commands it runs in order — one per line.
            For example "start my homework": open Word, then open Chrome.
          </p>
          {routines.map((routine, i) => (
            <div key={i} className="card" style={{ padding: 12, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input className="settings-input" value={routine.name}
                aria-label={`Routine ${i + 1}: its name`} placeholder="start my homework"
                onChange={e => updateRoutine(i, 'name', e.target.value)} />
              <textarea className="settings-input" rows={3} value={routine.steps}
                aria-label={`Routine ${i + 1}: its commands, one per line`} placeholder={'open word\nopen chrome'}
                onChange={e => updateRoutine(i, 'steps', e.target.value)}
                style={{ height: 'auto', paddingTop: 10, paddingBottom: 10, resize: 'vertical' }} />
              <button type="button" className="settings-btn quiet" style={{ alignSelf: 'flex-start' }}
                aria-label={`Remove routine ${i + 1}`}
                onClick={() => setRoutines(list => list.filter((_, j) => j !== i))}>Remove routine</button>
            </div>
          ))}
          <button type="button" className="settings-btn quiet" onClick={() => setRoutines(list => [...list, blankRoutine()])}>
            Add a routine
          </button>
        </fieldset>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button type="submit" className="settings-btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save speech settings'}</button>
          <button type="button" className="settings-btn quiet" onClick={exportFile}>Save to a file</button>
          <button type="button" className="settings-btn quiet" onClick={() => fileInput.current?.click()}>Load from a file</button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importFile} />
        </div>
      </form>

      <p className={`settings-result ${result?.tone || ''}`} role="status" aria-live="polite">{result?.text || ''}</p>
    </section>
  );
}
