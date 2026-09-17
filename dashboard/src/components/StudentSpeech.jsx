/**
 * The student's speech on the Teacher page (Stage 1, Stage 4):
 * how well AbleSpeak is hearing them, and the settings that help —
 * listening sensitivity, pause length, their words, their own shortcuts
 * and routines. Profiles can be saved to a file and loaded on another
 * computer.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal, Ear, PlusCircle, Download, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Field, Panel, Radio, StatTile, StatusPill, TextField } from './ui';

const SENSITIVITY_CHOICES = [
  { value: 'standard', label: 'Standard', hint: 'Most students, in a normal room.' },
  { value: 'quiet', label: 'Quiet voice', hint: 'For a soft or weak voice. Picks up more sound.' },
  { value: 'noisy', label: 'Noisy room', hint: 'Ignores more background talk. The student needs to speak up.' },
];

const percent = value => (value == null ? '—' : `${Math.round(value * 100)}%`);

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
    <p className="panel-lead">
      <strong>Retries per finished command</strong>, {days} days either side of the
      settings change on {changed}: <span className="tabular">{per(before.retriesPerTask)}</span> before ({before.tasks} commands)
      → <span className="tabular">{per(after.retriesPerTask)}</span> after ({after.tasks} commands). {verdict}
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
    <section aria-labelledby="recognition-heading" className="section">
      <h3 id="recognition-heading" className="section-title">
        <Ear size={22} aria-hidden="true" /> How well AbleSpeak hears them, last 7 days
      </h3>
      {isLoading && <p className="muted-note">Loading…</p>}
      {error && <p className="form-result error">Couldn't load this: {error.message}</p>}
      {data && (
        data.turns === 0 ? (
          <p className="muted-note">Nothing heard from this student in the last 7 days.</p>
        ) : (
          <>
            <div className="stat-grid">
              <StatTile label="Understood" value={percent(data.heardRate)} detail={`${data.heard} of ${data.turns} times they spoke`} />
              <StatTile label="Worked first time" value={percent(data.firstTimeRate)} detail={`${data.firstTime} of ${data.tasks} commands`} />
              <StatTile label="Tried again" value={data.retries} detail={`${data.repaired} then worked`} />
              <StatTile label="Set aside as noise" value={data.filtered + data.noSpeech} detail={`${data.filtered} with words`} />
            </div>
            {data.sinceSettingsChanged && (
              <RetriesComparison around={data.sinceSettingsChanged} />
            )}
            {data.recentlyFiltered.length > 0 && (
              <details className="disclosure">
                <summary>
                  Words set aside as background talk ({data.recentlyFiltered.length}). If these were the student, try "Quiet voice" below.
                </summary>
                <ul className="filtered-list">
                  {data.recentlyFiltered.map((turn, i) => (
                    <li key={i}><span className="tabular filtered-time">{turn.created_at.slice(5, 16)}</span> “{turn.transcript}”</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="muted-note">
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

  if (isLoading) return <p className="muted-note section">Loading speech settings…</p>;
  if (error) return <p className="form-result error section">Couldn't load speech settings: {error.message}</p>;

  return (
    <Panel title={`Speech settings for ${studentName}`} titleId="speech-heading" icon={SlidersHorizontal} className="section">
      <p className="panel-lead">These follow {studentName} whenever their session is running on this computer.</p>

      <form onSubmit={save} className="form-stack">
        <fieldset className="fieldset">
          <legend className="field-label">How sensitive the microphone is</legend>
          {SENSITIVITY_CHOICES.map(choice => (
            <Radio key={choice.value} name="sensitivity" value={choice.value}
              checked={sensitivity === choice.value}
              onChange={() => setSensitivity(choice.value)}
              label={choice.label} hint={choice.hint} />
          ))}
        </fieldset>

        <Field id="speech-pause" label={<>Pause that ends a command: <span className="tabular">{Number(pause).toFixed(1)}</span> seconds</>}
          hint="Longer suits a student who pauses in the middle of a command.">
          <input id="speech-pause" type="range" min="0.8" max="4" step="0.1" value={pause}
            className="range-input"
            onChange={e => setPause(e.target.value)}
            aria-describedby="speech-pause-hint" />
        </Field>

        <Field id="speech-words" label="Their words: names, subjects, places (one per line)">
          <textarea id="speech-words" className="field-input" rows={4} value={vocabulary}
            onChange={e => setVocabulary(e.target.value)}
            placeholder={'Wanjiku\nKiswahili\nKisumu'} />
        </Field>

        <fieldset className="fieldset">
          <legend className="field-label">Their own shortcuts</legend>
          <p className="field-hint">
            When {studentName} says the phrase on the left, AbleSpeak does the command on the right.
            Shortcuts marked "learned" were added after {studentName} corrected the same thing twice.
          </p>
          {shortcuts.map((shortcut, i) => (
            <div key={i} className="shortcut-row">
              <TextField id={`shortcut-say-${i}`} className="grow" value={shortcut.say}
                aria-label={`Shortcut ${i + 1}: what ${studentName} says`} placeholder="my music"
                onChange={e => updateShortcut(i, 'say', e.target.value)}
                onClear={() => updateShortcut(i, 'say', '')} />
              <span aria-hidden="true" className="shortcut-arrow">→</span>
              <TextField id={`shortcut-means-${i}`} className="grow-2" value={shortcut.means}
                aria-label={`Shortcut ${i + 1}: what it does`} placeholder="open spotify"
                onChange={e => updateShortcut(i, 'means', e.target.value)}
                onClear={() => updateShortcut(i, 'means', '')} />
              {shortcut.learned && (
                <StatusPill tone="success" label="Learned" title={`Learned when ${studentName} corrected AbleSpeak twice`} />
              )}
              <Button variant="ghost"
                aria-label={`Remove shortcut ${i + 1}`}
                onClick={() => setShortcuts(list => list.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <div>
            <Button icon={PlusCircle} onClick={() => setShortcuts(list => [...list, blankShortcut()])}>
              Add a shortcut
            </Button>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="field-label">Routines</legend>
          <p className="field-hint">
            A name {studentName} can say, and the commands it runs in order — one per line.
            For example "start my homework": open Word, then open Chrome.
          </p>
          {routines.map((routine, i) => (
            <div key={i} className="routine-card">
              <TextField id={`routine-name-${i}`} value={routine.name}
                aria-label={`Routine ${i + 1}: its name`} placeholder="start my homework"
                onChange={e => updateRoutine(i, 'name', e.target.value)}
                onClear={() => updateRoutine(i, 'name', '')} />
              <textarea className="field-input" rows={3} value={routine.steps}
                aria-label={`Routine ${i + 1}: its commands, one per line`} placeholder={'open word\nopen chrome'}
                onChange={e => updateRoutine(i, 'steps', e.target.value)} />
              <div>
                <Button variant="ghost"
                  aria-label={`Remove routine ${i + 1}`}
                  onClick={() => setRoutines(list => list.filter((_, j) => j !== i))}>Remove routine</Button>
              </div>
            </div>
          ))}
          <div>
            <Button icon={PlusCircle} onClick={() => setRoutines(list => [...list, blankRoutine()])}>
              Add a routine
            </Button>
          </div>
        </fieldset>

        <div className="button-row">
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save speech settings'}</Button>
          <Button icon={Download} onClick={exportFile}>Save to a file</Button>
          <Button icon={Upload} onClick={() => fileInput.current?.click()}>Load from a file</Button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importFile} />
        </div>
      </form>

      <p className={`form-result ${result?.tone || ''}`} role="status" aria-live="polite">{result?.text || ''}</p>
    </Panel>
  );
}
