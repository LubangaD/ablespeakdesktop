/**
 * A student's speech on the Speech profile page (Stage 1, Stage 4):
 * how well AbleSpeak is hearing them, and the settings that help —
 * listening sensitivity, pause length, their words, their own shortcuts
 * and routines. Profiles can be saved to a file and loaded on another
 * computer. Laid out in the dashboard's everyday style (src/lib/ui.js).
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  SECTION, LABEL, MUTED, BODY, NUMBER, CARD, WELL, PRIMARY, QUIET, SMALL_QUIET, FIELD, DOT, INK,
} from '../lib/ui';

const SENSITIVITY_CHOICES = [
  { value: 'standard', label: 'Standard', hint: 'Most users, in a normal room.' },
  { value: 'quiet', label: 'Quiet voice', hint: 'For a soft or weak voice. Picks up more sound.' },
  { value: 'noisy', label: 'Noisy room', hint: 'Ignores more background talk, so speak up a little.' },
];

// The limits the server checks (server/src/student-profile.js)
const PAUSE = { min: 0.8, max: 4 };
const MAX_LENGTH = { word: 40, say: 60, means: 200, name: 60 };

// A group's name inside the settings card
const GROUP_LABEL = 'block text-[14px] leading-5 font-medium text-[#dae3f4]';
const INPUT = `${FIELD} min-w-0 focus:ring-0`;
const TEXTAREA = 'block w-full min-h-[96px] rounded-lg bg-[#0f1724] border border-white/[0.10] px-3 py-2.5 text-[14px] leading-5 text-[#dae3f4] placeholder-[#8b95a7] focus:outline-none focus:ring-0 focus:border-[#f5a623]';
const SMALL_DANGER = 'inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg text-[13px] font-medium text-[#ffb4ab] hover:bg-[#ffb4ab]/10 transition-colors';

/** A Material Symbols icon, hidden from screen readers. */
function Icon({ name, className = '' }) {
  return <span className={`material-symbols-outlined ${className}`} aria-hidden="true">{name}</span>;
}

const percent = value => (value == null ? null : `${Math.round(value * 100)}%`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One number from the last 7 days: a quiet label, the number, one line of context. */
function Tile({ label, value, note }) {
  const empty = value == null || value === '';
  return (
    <div className={`${CARD} px-5 py-4 flex flex-col gap-1 min-w-0`}>
      <span className={`${LABEL} truncate`}>{label}</span>
      {empty
        ? <span className="font-heading text-[16px] leading-9 text-[#8b95a7]">No data yet</span>
        : <span className={NUMBER}>{value}</span>}
      <p className={`${MUTED} truncate`}>{note}</p>
    </div>
  );
}

// Did the last change to their speech settings help? (Stage 4 acceptance)
function RetriesComparison({ around }) {
  const { before, after, days, at } = around;
  const per = v => (v == null ? 'none' : v.toFixed(1));
  const changed = at.slice(0, 10);
  let verdict = 'Not enough commands yet on both sides to compare.';
  let trend = null;
  if (before.tasks && after.tasks) {
    if (after.retriesPerTask < before.retriesPerTask) { verdict = 'Fewer retries since the change.'; trend = 'fewer'; }
    else if (after.retriesPerTask > before.retriesPerTask) { verdict = 'More retries since the change — review the settings.'; trend = 'more'; }
    else verdict = 'No difference yet.';
  }
  const icon = trend === 'fewer' ? 'trending_down' : trend === 'more' ? 'trending_up' : 'trending_flat';
  const tone = trend === 'fewer' ? INK.ok : trend === 'more' ? INK.warn : 'text-[#dae3f4]';
  return (
    <div className={`${CARD} px-5 py-4 flex items-start gap-3`}>
      <Icon name={icon} className="text-[20px] text-[#c9b8a5] shrink-0" />
      <p className={`${BODY} text-[#c9b8a5]`}>
        Retries per finished command, {days} days either side of the settings change on{' '}
        <span className="font-mono text-[13px] text-[#dae3f4]">{changed}</span>:{' '}
        <span className="tabular-nums font-medium text-[#dae3f4]">{per(before.retriesPerTask)}</span> before ({plural(before.tasks, 'command')}) →{' '}
        <span className={`tabular-nums font-medium ${tone}`}>{per(after.retriesPerTask)}</span> after ({plural(after.tasks, 'command')}).{' '}
        <span className={trend ? tone : 'text-[#dae3f4]'}>{verdict}</span>
      </p>
    </div>
  );
}

export function RecognitionReadout({ studentId, studentName }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['recognition', studentId],
    queryFn: () => api.getRecognition(studentId, 7),
    refetchInterval: 30000,
  });
  const who = studentName || 'this user';

  return (
    <section aria-labelledby="analytics-heading" className="flex flex-col gap-3">
      <div>
        <h2 className={SECTION} id="analytics-heading">
          How well AbleSpeak hears {studentName === 'you' ? 'you' : 'them'}, last 7 days
        </h2>
        {data && data.turns > 0 && (
          <p className={MUTED}>
            Everyday readout from this computer, separate from the speech study.
          </p>
        )}
      </div>
      {isLoading && <p className={MUTED}>Loading…</p>}
      {error && <p className={`text-[13px] leading-5 ${INK.bad}`} role="alert">Couldn't load this: {error.message}</p>}
      {data && (
        data.turns === 0 ? (
          <div className={`${CARD} p-5`}>
            <p className={MUTED}>Nothing heard from {who} in the last 7 days.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Tile label="Understood" value={percent(data.heardRate)}
                note={`${data.heard} of ${data.turns} times they spoke`} />
              <Tile label="Worked first time" value={percent(data.firstTimeRate)}
                note={data.tasks ? `${data.firstTime} of ${plural(data.tasks, 'command')}` : 'No commands yet'} />
              <Tile label="Tried again" value={data.retries}
                note={`${data.repaired} then worked`} />
              <Tile label="Set aside as noise" value={data.filtered + data.noSpeech}
                note={`${data.filtered} with words`} />
            </div>

            {data.sinceSettingsChanged && <RetriesComparison around={data.sinceSettingsChanged} />}

            {data.recentlyFiltered.length > 0 && (
              <details className={`group ${CARD}`}>
                <summary className="flex items-center justify-between gap-3 min-h-[44px] px-5 py-2.5 rounded-xl group-open:rounded-b-none cursor-pointer hover:bg-[#18202d]/60 transition-colors select-none list-none [&::-webkit-details-marker]:hidden">
                  <span className={BODY}>
                    Words set aside as background talk ({Math.max(data.filtered, data.recentlyFiltered.length)})
                  </span>
                  <Icon name="expand_more" className="text-[20px] text-[#c9b8a5] transition-transform duration-200 group-open:rotate-180" />
                </summary>
                <div className="px-5 pb-4 pt-3 border-t border-white/[0.06] flex flex-col gap-3">
                  <ul className="flex flex-col divide-y divide-white/[0.06]">
                    {data.recentlyFiltered.map((turn, i) => (
                      <li key={i} className="flex items-baseline gap-3 py-2">
                        <span className="font-mono text-[12px] text-[#8b95a7] tabular-nums shrink-0">{turn.created_at.slice(5, 16)}</span>
                        <span className={`${BODY} break-words min-w-0`}>"{turn.transcript}"</span>
                      </li>
                    ))}
                  </ul>
                  <p className={MUTED}>
                    {data.filtered > data.recentlyFiltered.length ? `The latest ${data.recentlyFiltered.length}. ` : ''}
                    If these were {who}, try "Quiet voice" below.
                  </p>
                </div>
              </details>
            )}
          </>
        )
      )}
    </section>
  );
}

const linesOf = text => text.split('\n').map(line => line.trim()).filter(Boolean);

// Rows get a stable key so editing or removing one doesn't disturb the others
let lastUid = 0;
const withUid = item => ({ ...item, uid: ++lastUid });

// `own`: the person signed in looking at their own settings. A file they load
// goes into their profile, whatever name it was saved under.
export function SpeechSettings({ studentId, studentName, own = false }) {
  const queryClient = useQueryClient();
  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['profile', studentId],
    queryFn: () => api.getProfile(studentId),
  });

  const [sensitivity, setSensitivity] = useState('standard');
  const [pause, setPause] = useState(1.5);
  const [needsName, setNeedsName] = useState(false); // "Say AbleSpeak first" (noisy places)
  const [words, setWords] = useState([]);
  const [newWord, setNewWord] = useState('');
  const [wordNote, setWordNote] = useState('');
  const [shortcuts, setShortcuts] = useState([]);
  const [routines, setRoutines] = useState([]);
  const [focusUid, setFocusUid] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const fileInput = useRef(null);
  const wordInput = useRef(null);
  const addShortcutButton = useRef(null);
  const addRoutineButton = useRef(null);
  const loadedFor = useRef(null);

  const fill = (saved) => {
    setSensitivity(saved.listening.sensitivity);
    setPause(saved.listening.pauseSeconds);
    setNeedsName(!!saved.listening.needsName);
    setWords([...saved.vocabulary]);
    setShortcuts(saved.aliases.map(a => withUid({ ...a })));
    setRoutines(saved.macros.map(m => withUid({ name: m.name, steps: m.steps.join('\n'), open: false })));
  };

  // Fill the form from the saved profile when a student is first shown —
  // not on every refetch, which would wipe edits.
  useEffect(() => {
    if (!profile || loadedFor.current === studentId) return;
    loadedFor.current = studentId;
    fill(profile);
  }, [profile, studentId]);

  // "Saved" stops being true once something changes after the save
  const edited = () => setResult(r => (r?.tone === 'success' ? null : r));

  const hasWord = (list, word) => list.some(w => w.toLowerCase() === word.toLowerCase());

  const addWord = () => {
    const word = newWord.replace(/\s+/g, ' ').trim();
    if (!word) return;
    if (hasWord(words, word)) {
      setWordNote(`"${word}" is already in ${own ? 'your' : 'their'} words.`);
    } else {
      setWords(list => [...list, word]);
      setWordNote('');
      edited();
    }
    setNewWord('');
  };

  const removeWord = (index) => {
    setWords(list => list.filter((_, j) => j !== index));
    setWordNote('');
    edited();
    wordInput.current?.focus();
  };

  const save = async (e) => {
    e.preventDefault();
    // A word typed but not yet added is kept, not lost
    const pending = newWord.replace(/\s+/g, ' ').trim();
    const vocabulary = pending && !hasWord(words, pending) ? [...words, pending] : words;
    if (pending) { setWords(vocabulary); setNewWord(''); setWordNote(''); }
    setBusy(true);
    setResult(null);
    try {
      await api.saveProfile(studentId, {
        listening: { sensitivity, pauseSeconds: Number(pause), needsName },
        vocabulary: vocabulary.map(w => w.trim()).filter(Boolean),
        aliases: shortcuts
          .map(({ uid, ...shortcut }) => shortcut)
          .filter(s => s.say.trim() || s.means.trim()),
        macros: routines
          .map(r => ({ name: r.name, steps: linesOf(r.steps) }))
          .filter(r => r.name.trim() || r.steps.length),
      });
      queryClient.invalidateQueries({ queryKey: ['profile', studentId] });
      // The before/after retries comparison counts from this save
      queryClient.invalidateQueries({ queryKey: ['recognition', studentId] });
      setResult({ tone: 'success', text: own ? 'Saved. AbleSpeak uses these straight away.' : `Saved. AbleSpeak uses these for ${studentName} straight away.` });
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
      const answer = await api.importProfile(file, own ? studentId : null);
      if (answer.student?.id === Number(studentId)) {
        // Show what was loaded
        if (answer.profile) fill(answer.profile);
        else loadedFor.current = null;
        setNewWord('');
        setWordNote('');
      }
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['recognition'] });
      queryClient.invalidateQueries({ queryKey: ['students'] });
      queryClient.invalidateQueries({ queryKey: ['activeStudent'] });
      setResult({
        tone: 'success',
        text: own
          ? `Loaded your settings from the file${answer.student?.name ? `, as ${answer.student.name}` : ''}.`
          : answer.created
          ? `Added ${answer.student.name} with their settings. Choose them above to use this computer.`
          : `Loaded the settings for ${answer.student.name}.`,
      });
    } catch (err) {
      setResult({ tone: 'error', text: err instanceof SyntaxError ? 'That file is not an AbleSpeak profile.' : err.message });
    }
  };

  const updateShortcut = (i, field, value) => {
    setShortcuts(list => list.map((s, j) => (j === i ? { ...s, [field]: value } : s)));
    edited();
  };
  const addShortcut = () => {
    const blank = withUid({ say: '', means: '' });
    setShortcuts(list => [...list, blank]);
    setFocusUid(blank.uid);
    edited();
  };
  const removeShortcut = (i) => {
    setShortcuts(list => list.filter((_, j) => j !== i));
    edited();
    addShortcutButton.current?.focus();
  };

  const updateRoutine = (i, field, value) => {
    setRoutines(list => list.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
    if (field !== 'open') edited();
  };
  const addRoutine = () => {
    const blank = withUid({ name: '', steps: '', open: true });
    setRoutines(list => [...list, blank]);
    setFocusUid(blank.uid);
    edited();
  };
  const removeRoutine = (i) => {
    setRoutines(list => list.filter((_, j) => j !== i));
    edited();
    addRoutineButton.current?.focus();
  };

  if (isLoading) return <p className={MUTED}>Loading speech settings…</p>;
  if (error) return <p className={`text-[13px] leading-5 ${INK.bad}`} role="alert">Couldn't load speech settings: {error.message}</p>;

  const anyLearned = shortcuts.some(s => s.learned);
  const pauseText = `${Number(pause).toFixed(1)} s`;

  return (
    <section aria-labelledby="settings-heading" className={`${CARD} p-5 flex flex-col gap-5`}>
      <div>
        <h2 className={SECTION} id="settings-heading">
          {own ? 'Your speech settings' : `Speech settings for ${studentName}`}
        </h2>
        <p className={MUTED}>
          {own
            ? 'They’re yours: AbleSpeak uses them whenever you’re signed in. Save them to a file to take them to another computer.'
            : `These follow ${studentName} whenever their session is running on this computer.`}
        </p>
      </div>

      <form onSubmit={save} className="flex flex-col gap-5">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-6">
          {/* LEFT COLUMN: how the microphone listens */}
          <div className="flex flex-col gap-6">
            <div>
              <p id="sensitivity-label" className={`${GROUP_LABEL} mb-2`}>How sensitive the microphone is</p>
              <div role="radiogroup" aria-labelledby="sensitivity-label" className="flex flex-col gap-2">
                {SENSITIVITY_CHOICES.map(choice => {
                  const on = sensitivity === choice.value;
                  return (
                    <label key={choice.value}
                      className={`flex items-start gap-3 rounded-lg border bg-[#18202d] px-4 py-3 min-h-[56px] cursor-pointer transition-colors focus-within:border-[#f5a623] ${on
                        ? 'border-[#f5a623]/60'
                        : 'border-white/[0.06] hover:border-white/[0.14]'}`}>
                      <input type="radio" name="sensitivity" value={choice.value} checked={on}
                        onChange={() => { setSensitivity(choice.value); edited(); }}
                        aria-label={choice.label}
                        aria-describedby={`sensitivity-${choice.value}-hint`}
                        className={`form-radio mt-0.5 h-4 w-4 shrink-0 bg-transparent text-[#f5a623] focus:ring-0 focus:ring-offset-0 ${on ? 'border-[#f5a623]' : 'border-white/30'}`} />
                      <div className="flex-1 min-w-0">
                        <span className={`block text-[14px] leading-5 font-medium ${on ? 'text-[#dae3f4]' : 'text-[#dae3f4]/90'}`}>{choice.label}</span>
                        <span id={`sensitivity-${choice.value}-hint`} className={`block ${MUTED}`}>
                          {choice.hint}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Noisy places: only act on phrases that start with AbleSpeak's name */}
            <div className="flex items-start justify-between gap-4 rounded-lg border border-white/[0.06] bg-[#18202d] px-4 py-3">
              <div className="min-w-0">
                <p id="needs-name-label" className="text-[14px] leading-5 font-medium text-[#dae3f4]">Say “AbleSpeak” first</p>
                <p id="needs-name-hint" className={MUTED}>
                  For noisy places. AbleSpeak only acts when {own ? 'you start' : 'they start'} with its name —
                  “AbleSpeak, open Word” — and ignores other people, TV and music. Saying just “AbleSpeak” makes it listen for the next phrase.
                </p>
              </div>
              <button
                type="button" role="switch" aria-checked={needsName}
                aria-labelledby="needs-name-label" aria-describedby="needs-name-hint"
                onClick={() => { setNeedsName(v => !v); edited(); }}
                className="shrink-0 min-h-[44px] inline-flex items-center gap-2 px-2 rounded-lg hover:bg-[#222a37]"
              >
                <span className={`w-11 h-6 rounded-full p-0.5 flex items-center transition-colors ${needsName ? 'bg-[#f5a623] justify-end' : 'bg-[#2d3543] justify-start'}`} aria-hidden="true">
                  <span className={`w-5 h-5 rounded-full ${needsName ? 'bg-[#3d2600]' : 'bg-[#c9b8a5]'}`} />
                </span>
                <span className="text-[14px] leading-5 text-[#dae3f4]">{needsName ? 'On' : 'Off'}</span>
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <label className={GROUP_LABEL} htmlFor="pause-slider">
                  Pause that ends a command
                </label>
                <span className="font-mono text-[13px] tabular-nums text-[#dae3f4]" aria-hidden="true">
                  {pauseText}
                </span>
              </div>
              <input id="pause-slider" type="range" min={PAUSE.min} max={PAUSE.max} step="0.1" value={pause}
                className="w-full h-6 m-0 cursor-pointer accent-[#f5a623]"
                onChange={e => { setPause(e.target.value); edited(); }}
                aria-valuetext={`${Number(pause).toFixed(1)} seconds`}
                aria-describedby="pause-hint" />
              <div className="flex justify-between gap-3 text-[12px] leading-4 text-[#8b95a7]" aria-hidden="true">
                <span><span className="font-mono">{PAUSE.min.toFixed(1)} s</span> fast speech</span>
                <span><span className="font-mono">{PAUSE.max.toFixed(1)} s</span> deliberate pauses</span>
              </div>
              <p id="pause-hint" className={MUTED}>
                Longer suits a user who pauses in the middle of a command.
              </p>
            </div>
          </div>

          {/* RIGHT COLUMN: their words, shortcuts and routines */}
          <div className="flex flex-col gap-6 min-w-0">
            <div role="group" aria-labelledby="words-label" aria-describedby="words-hint">
              <p id="words-label" className={`${GROUP_LABEL} mb-2`}>{own ? 'Your words' : 'Their words'}</p>
              <p id="words-hint" className="sr-only">Names, subjects and places AbleSpeak should expect to hear.</p>
              {words.length > 0 ? (
                <ul aria-labelledby="words-label" className="flex flex-wrap gap-1.5 mb-3">
                  {words.map((word, i) => (
                    <li key={`${i}-${word}`} className="inline-flex items-center min-h-[36px] pl-3 rounded-lg bg-[#18202d] border border-white/[0.06] text-[13px] leading-5 text-[#dae3f4]">
                      {word}
                      <button type="button" aria-label={`Remove ${word}`} onClick={() => removeWord(i)}
                        className="w-9 h-9 rounded-md flex items-center justify-center text-[#c9b8a5] hover:text-[#dae3f4] hover:bg-[#222a37] transition-colors">
                        <Icon name="close" className="text-[16px]" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={`${MUTED} mb-3`}>No words yet.</p>
              )}
              <div className="flex gap-2">
                <label htmlFor="speech-add-word" className="sr-only">{own ? 'Add a word' : `Add a word for ${studentName}`}</label>
                <input id="speech-add-word" ref={wordInput} type="text" value={newWord} maxLength={MAX_LENGTH.word}
                  placeholder="Add word..." className={`${INPUT} flex-1`}
                  onChange={e => { setNewWord(e.target.value); setWordNote(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addWord(); } }} />
                <button type="button" onClick={addWord} className={`${QUIET} shrink-0`}>
                  Add
                </button>
              </div>
              <p role="status" aria-live="polite" className={wordNote ? `mt-2 ${MUTED}` : ''}>{wordNote}</p>
            </div>

            <div role="group" aria-labelledby="shortcuts-label" aria-describedby="shortcuts-hint">
              <p id="shortcuts-label" className={`${GROUP_LABEL} mb-2`}>{own ? 'Your shortcuts' : 'Their own shortcuts'}</p>
              <p id="shortcuts-hint" className="sr-only">
                {own
                  ? 'When you say the phrase on the left, AbleSpeak does the command on the right. Shortcuts marked "learned" were added after you corrected the same thing twice.'
                  : `When ${studentName} says the phrase on the left, AbleSpeak does the command on the right. Shortcuts marked "learned" were added after ${studentName} corrected the same thing twice.`}
              </p>
              <div className="flex flex-col gap-2">
                {shortcuts.length === 0 && <p className={MUTED}>No shortcuts yet.</p>}
                {shortcuts.map((shortcut, i) => (
                  <div key={shortcut.uid} className="flex items-center gap-2">
                    <input type="text" value={shortcut.say} maxLength={MAX_LENGTH.say}
                      aria-label={own ? `Shortcut ${i + 1}: what you say` : `Shortcut ${i + 1}: what ${studentName} says`} placeholder="my music"
                      autoFocus={shortcut.uid === focusUid}
                      className={`${INPUT} flex-1`}
                      onChange={e => updateShortcut(i, 'say', e.target.value)} />
                    <span className="text-[#8b95a7]" aria-hidden="true">→</span>
                    <input type="text" value={shortcut.means} maxLength={MAX_LENGTH.means}
                      aria-label={`Shortcut ${i + 1}: what it does`} placeholder="open spotify"
                      className={`${INPUT} flex-1`}
                      onChange={e => updateShortcut(i, 'means', e.target.value)} />
                    {shortcut.learned ? (
                      <span title={own ? 'Learned when you corrected AbleSpeak twice' : `Learned when ${studentName} corrected AbleSpeak twice`}
                        className={`w-[76px] shrink-0 inline-flex items-center gap-1.5 text-[13px] leading-5 ${INK.ok}`}>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT.ok}`} aria-hidden="true" />
                        Learned
                      </span>
                    ) : anyLearned && <div className="w-[76px] shrink-0" aria-hidden="true" />}
                    <button type="button" onClick={() => removeShortcut(i)}
                      aria-label={`Delete shortcut ${i + 1}${shortcut.say.trim() ? `, "${shortcut.say.trim()}"` : ''}`}
                      className="w-11 h-11 shrink-0 rounded-lg flex items-center justify-center text-[#c9b8a5] hover:text-[#ffb4ab] hover:bg-[#ffb4ab]/10 transition-colors">
                      <Icon name="delete" className="text-[20px]" />
                    </button>
                  </div>
                ))}
                <button type="button" ref={addShortcutButton} className={`${SMALL_QUIET} self-start`} onClick={addShortcut}>
                  <Icon name="add" className="text-[18px]" />
                  Add a shortcut
                </button>
              </div>
            </div>

            <div role="group" aria-labelledby="routines-label" aria-describedby="routines-hint">
              <p id="routines-label" className={`${GROUP_LABEL} mb-2`}>Routines</p>
              <p id="routines-hint" className="sr-only">
                A name {studentName} can say, and the commands it runs in order.
                For example "start my homework": open Word, then open Chrome.
              </p>
              <div className="flex flex-col gap-2">
                {routines.length === 0 && <p className={MUTED}>No routines yet.</p>}
                {routines.map((routine, i) => {
                  const steps = linesOf(routine.steps);
                  const name = routine.name.trim();
                  const editorId = `routine-editor-${routine.uid}`;
                  return (
                    <div key={routine.uid} className={`${WELL} px-4 py-3`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[14px] leading-5">
                            {name
                              ? <span className="font-medium text-[#dae3f4]">"{name}"</span>
                              : <span className="text-[#c9b8a5]">No name yet</span>}
                            <span className="text-[#c9b8a5]"> · {plural(steps.length, 'step')}</span>
                          </p>
                          <p className={`${MUTED} break-words`}>
                            {steps.length ? steps.map((step, j) => `${j + 1}. ${step}`).join('  →  ') : 'No steps yet'}
                          </p>
                        </div>
                        <button type="button"
                          aria-expanded={routine.open}
                          aria-controls={routine.open ? editorId : undefined}
                          aria-label={routine.open
                            ? `Close the editor for routine ${i + 1}`
                            : `Edit routine ${i + 1}${name ? `, "${name}"` : ''}`}
                          onClick={() => updateRoutine(i, 'open', !routine.open)}
                          className={`w-10 h-10 shrink-0 rounded-lg flex items-center justify-center hover:text-[#dae3f4] hover:bg-[#222a37] transition-colors ${routine.open ? 'text-[#ffc880]' : 'text-[#c9b8a5]'}`}>
                          <Icon name={routine.open ? 'expand_less' : 'edit'} className="text-[20px]" />
                        </button>
                      </div>

                      {routine.open && (
                        <div id={editorId} className="mt-3 pt-3 border-t border-white/[0.06] flex flex-col gap-3">
                          <div className="flex flex-col gap-1.5">
                            <label htmlFor={`routine-name-${routine.uid}`} className={LABEL}>
                              What {studentName} says
                            </label>
                            <input id={`routine-name-${routine.uid}`} type="text" value={routine.name}
                              maxLength={MAX_LENGTH.name} placeholder="start my homework"
                              autoFocus={routine.uid === focusUid}
                              className={INPUT}
                              onChange={e => updateRoutine(i, 'name', e.target.value)} />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <label htmlFor={`routine-steps-${routine.uid}`} className={LABEL}>
                              The commands it runs, one per line
                            </label>
                            <textarea id={`routine-steps-${routine.uid}`} rows={3} value={routine.steps}
                              placeholder={'open word\nopen chrome'}
                              className={TEXTAREA}
                              onChange={e => updateRoutine(i, 'steps', e.target.value)} />
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className={SMALL_QUIET} onClick={() => updateRoutine(i, 'open', false)}>
                              <Icon name="check" className="text-[18px]" />
                              Done
                            </button>
                            <button type="button" onClick={() => removeRoutine(i)} className={SMALL_DANGER}>
                              <Icon name="delete" className="text-[18px]" />
                              Remove routine
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" ref={addRoutineButton} className={`${SMALL_QUIET} self-start`} onClick={addRoutine}>
                  <Icon name="add" className="text-[18px]" />
                  Add a routine
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Action row: save, and save to / load from a file */}
        <div className="pt-4 border-t border-white/[0.06] flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={busy} className={PRIMARY}>
              {busy ? 'Saving…' : 'Save speech settings'}
            </button>
            <button type="button" className={QUIET} onClick={exportFile}>
              <Icon name="download" className="text-[18px]" />
              Save to a file
            </button>
            <button type="button" className={QUIET} onClick={() => fileInput.current?.click()}>
              <Icon name="upload" className="text-[18px]" />
              Load from a file
            </button>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importFile} />
          </div>

          <div role="status" aria-live="polite" className="max-w-full">
            {result && (
              <p className={`text-[13px] leading-5 ${result.tone === 'error' ? INK.bad : INK.ok}`}>{result.text}</p>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
