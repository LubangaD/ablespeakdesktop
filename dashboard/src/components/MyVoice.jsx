/**
 * "My voice" on the Voice & words page ("only my voice", Phases 1–2;
 * server/src/voice-profile.js). A person reads about twenty short phrases,
 * and AbleSpeak makes a voiceprint from them, kept only on this computer.
 * For now it only measures: each voice command gets a score of how much it
 * sounded like them, and nothing is ignored because of it.
 *
 * Hands-free once started: AbleSpeak reads each phrase aloud, listens, and
 * moves on by itself; voice commands are paused meanwhile, so the phrases
 * never act ("Close this window").
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { openVoiceMic, sayAloud } from '../lib/voice-recorder';
import {
  SECTION, LABEL, MUTED, BODY, CARD, WELL, PRIMARY, QUIET, DANGER, SMALL_QUIET, ROW_ACTION, FIELD, FIELD_LABEL, DOT, INK,
} from '../lib/ui';

function Icon({ name, className = '' }) {
  return <span className={`material-symbols-outlined ${className}`} aria-hidden="true">{name}</span>;
}

// What to ask for when a phrase can't be used (voice-profile.js clipQuality, addClip)
const PROBLEMS = {
  not_heard: "I didn't hear that.",
  quiet: 'That was a little quiet. A bit louder, please.',
  loud: 'That was too loud and crackled. A little softer, or further from the microphone.',
  noisy: "It's noisy here. A bit louder, please.",
  different: "That didn't sound like the other phrases. Was someone else talking?",
  long: 'That was very long. Just the phrase, please.',
  failed: "That one couldn't be checked.",
};
const TRIES = 3; // then the phrase is skipped, and tried again at the end
const ROOM_SECONDS = 30;
const ROOM_DELAY_MS = 5000;
const READER_PAUSE_MS = 1800; // reading aloud off: time for a screen reader to say the phrase first

const dateOf = iso => (iso ? new Date(iso).toLocaleDateString() : '');
const wait = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); });
});

function micMessage(err) {
  return err?.name === 'NotAllowedError'
    ? 'AbleSpeak may not use the microphone. Allow it in Windows Settings › Privacy › Microphone.'
    : `The microphone didn't open: ${err?.message || err}`;
}

/** The person's own commands, measured against their voiceprint. */
function Measured({ measured, threshold, you }) {
  if (!measured?.checked) {
    return <p className={MUTED}>{you ? 'Your' : 'Their'} next voice commands will be measured here.</p>;
  }
  return (
    <div className={`${WELL} px-4 py-3 flex flex-col gap-1`}>
      <p className={BODY}>
        Of {you ? 'your' : 'their'} last {measured.checked} voice commands, <span className="text-[var(--ink)]">{measured.matched}</span> sounded like {you ? 'you' : 'them'}.
      </p>
      <p className={LABEL}>
        Typical score {measured.median?.toFixed(2)}, lowest {measured.lowest?.toFixed(2)} · it counts as a match from {threshold}
      </p>
    </div>
  );
}

/** Consent, the phrases, the room, done. `target` is { id, name, you }. */
function VoiceSetup({ target, info, onClose }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState('consent');
  const [adult, setAdult] = useState(null);
  const [guardian, setGuardian] = useState(false);
  const [agree, setAgree] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const [index, setIndex] = useState(0);
  const [kept, setKept] = useState(0);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState(null);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [roomSeconds, setRoomSeconds] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef(null);
  const run = useRef({ abort: null, control: null, mic: null, live: false, started: false, finished: false });
  const aloud = useRef(readAloud);
  aloud.current = readAloud;

  const you = target.you;
  const phrases = info.phrases;
  const say = text => (aloud.current ? sayAloud(text) : Promise.resolve());

  // Each step's heading takes the focus, so a screen reader says where they are
  useEffect(() => { headingRef.current?.focus(); }, [step]);

  // Leaving the page part-way: stop, and nothing is kept
  useEffect(() => () => {
    const r = run.current;
    r.live = false;
    r.abort?.abort();
    window.speechSynthesis?.cancel();
    r.mic?.close();
    if (r.started && !r.finished) api.cancelVoiceSetup(target.id).catch(() => {});
  }, [target.id]);

  // A button pressed while a phrase is read or heard: stop that, and do this instead
  const control = what => {
    run.current.control = what;
    window.speechSynthesis?.cancel();
    run.current.abort?.abort();
  };
  const takeControl = () => { const what = run.current.control; run.current.control = null; return what; };
  const abortable = () => { const abort = new AbortController(); run.current.abort = abort; return abort.signal; };

  async function onePhrase(i) {
    const text = phrases[i];
    let asked = null;
    for (let attempt = 0; attempt < TRIES; attempt++) {
      if (!run.current.live) return 'stop';
      // The phrase is said first (aloud, or by the screen reader), then heard:
      // nothing new is announced while the person speaks
      if (aloud.current) {
        setStatus('');
        await say(asked ? `${asked} Say: ${text}` : `Say: ${text}`);
      } else {
        setStatus(`Say: ${text}`);
        await wait(READER_PAUSE_MS, abortable());
      }
      const pending = takeControl();
      if (pending) return pending;
      setListening(true);
      const heard = await run.current.mic.recordPhrase({ signal: abortable() });
      setListening(false);
      if (!heard) return takeControl() || 'stop';
      let answer = { ok: false, problem: 'not_heard' };
      if (heard.heard) {
        try {
          answer = await api.sendVoicePhrase(target.id, i, heard.wav);
        } catch (err) {
          if (err.status === 409) throw err; // the setup was left too long
          answer = { ok: false, problem: 'failed' };
        }
      }
      if (answer.ok) {
        setProblem(null);
        setStatus('Got it.');
        return 'kept';
      }
      asked = PROBLEMS[answer.problem] || PROBLEMS.failed;
      setProblem(asked);
    }
    setProblem(null);
    return 'skipped';
  }

  async function roomStep() {
    setStep('room');
    setStatus(`Starting in ${ROOM_DELAY_MS / 1000} seconds.`);
    await say(`Last, ${ROOM_SECONDS} seconds of your room. Stay quiet, and let the room make its usual sound. Starting in ${ROOM_DELAY_MS / 1000} seconds.`);
    if (takeControl()) return;
    await wait(ROOM_DELAY_MS, abortable());
    if (takeControl() || !run.current.live) return;
    setStatus('Recording the room. Stay quiet.');
    setListening(true);
    const wav = await run.current.mic.recordRoom(ROOM_SECONDS, { onProgress: setRoomSeconds, signal: abortable() });
    setListening(false);
    if (!wav) { takeControl(); return; }
    const answer = await api.sendVoiceRoom(target.id, wav).catch(() => null);
    if (answer?.quiet) setStatus('Your room is quiet: the voiceprint is made from the phrases alone.');
  }

  async function runSetup() {
    const r = run.current;
    r.live = true;
    try {
      r.mic = await openVoiceMic({ autoGain: info.capture?.autoGain !== false, onLevel: setLevel });
    } catch (err) {
      setError(micMessage(err));
      await api.cancelVoiceSetup(target.id).catch(() => {});
      r.finished = true;
      return;
    }
    const keepAlive = setInterval(() => { api.keepVoiceSetup(target.id).catch(() => {}); }, 15000);
    try {
      let count = 0;
      let todo = phrases.map((_, i) => i);
      for (let pass = 0; pass < 2 && todo.length; pass++) {
        const skipped = [];
        for (const i of todo) {
          setIndex(i);
          const outcome = await onePhrase(i);
          if (outcome === 'stop') return;
          if (outcome === 'finish') break;
          if (outcome === 'kept') { count += 1; setKept(count); } else skipped.push(i);
        }
        // A second go at the skipped ones only if there are too few
        todo = count >= info.minClips ? [] : skipped;
      }
      if (count < info.minClips) {
        setError(`Only ${count} phrases could be used, and ${info.minClips} are needed. Try again in a quieter moment, close to the microphone.`);
        await say('Not enough phrases could be used. Nothing was kept.');
        await api.cancelVoiceSetup(target.id).catch(() => {});
        r.finished = true;
        return;
      }
      await roomStep();
      if (!r.live) return;
      setStep('finishing');
      setStatus('Making the voiceprint…');
      await api.finishVoiceSetup(target.id);
      r.finished = true;
      setStep('done');
      setStatus('');
      await say(`All done. ${you ? 'Your' : 'The'} voice is set up.`);
      queryClient.invalidateQueries({ queryKey: ['voiceProfile'] });
    } catch (err) {
      setError(err.status === 409 ? 'The setup stopped because it was left too long. Start again.' : err.message);
      r.finished = true;
    } finally {
      clearInterval(keepAlive);
      r.mic?.close();
      r.mic = null;
    }
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.startVoiceSetup(target.id, { agree, adult: adult === true, guardian: adult === false && guardian });
      run.current.started = true;
      setStep('phrases');
      runSetup();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    run.current.live = false;
    control('stop');
    run.current.mic?.close();
    if (!run.current.finished) await api.cancelVoiceSetup(target.id).catch(() => {});
    run.current.finished = true;
    onClose();
  };

  const whose = you ? 'your' : `${target.name}’s`;
  const heading = text => <h3 ref={headingRef} tabIndex={-1} className={`${SECTION} outline-none`}>{text}</h3>;

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        {heading('The voice was not set up')}
        <p className={`text-[14px] leading-[22px] ${INK.bad}`} role="alert">{error}</p>
        <div><button type="button" className={QUIET} onClick={onClose}>Back</button></div>
      </div>
    );
  }

  if (step === 'consent') {
    const ready = agree && adult !== null && (adult || guardian);
    return (
      <div className="flex flex-col gap-4">
        {heading(you ? 'Before you start' : `Before setting up ${target.name}’s voice`)}
        <p className={`${BODY} max-w-[720px]`}>
          {you ? 'You read' : 'They read'} {phrases.length} short phrases aloud, three or four minutes. AbleSpeak makes a
          voiceprint from them: numbers that describe how {you ? 'you sound' : 'they sound'}, not a recording.
        </p>
        <ul className={`${BODY} list-disc pl-5 flex flex-col gap-1 max-w-[720px]`}>
          <li>It is kept only on this computer, locked with Windows’ own protection, and never uploaded.</li>
          <li>The recordings are deleted as soon as the voiceprint is made.</li>
          <li>For now AbleSpeak only measures: every voice still works. Listening only to {you ? 'you' : 'them'} is a choice for later.</li>
          <li>It can be deleted here at any time.</li>
        </ul>
        <p className={LABEL}>Kenya’s Data Protection Act counts a voiceprint as biometric data, so AbleSpeak asks first.</p>
        <fieldset className="flex flex-col gap-1">
          <legend className={FIELD_LABEL}>{you ? 'How old are you?' : `How old is ${target.name}?`}</legend>
          <label className={`${BODY} flex items-center gap-3 min-h-[44px]`}>
            <input type="radio" name="voice-age" checked={adult === true} onChange={() => setAdult(true)} className="w-5 h-5 accent-[var(--accent)]" />
            18 or older
          </label>
          <label className={`${BODY} flex items-center gap-3 min-h-[44px]`}>
            <input type="radio" name="voice-age" checked={adult === false} onChange={() => setAdult(false)} className="w-5 h-5 accent-[var(--accent)]" />
            Under 18
          </label>
        </fieldset>
        {adult === false && (
          <label className={`${BODY} flex items-center gap-3 min-h-[44px]`}>
            <input type="checkbox" checked={guardian} onChange={e => setGuardian(e.target.checked)} className="w-5 h-5 accent-[var(--accent)]" />
            I am {you ? 'this student’s' : `${target.name}’s`} parent or guardian, and I agree.
          </label>
        )}
        <label className={`${BODY} flex items-center gap-3 min-h-[44px]`}>
          <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} className="w-5 h-5 accent-[var(--accent)]" />
          I agree to AbleSpeak making and keeping {whose} voiceprint on this computer.
        </label>
        <label className={`${BODY} flex items-center gap-3 min-h-[44px]`}>
          <input type="checkbox" checked={readAloud} onChange={e => setReadAloud(e.target.checked)} className="w-5 h-5 accent-[var(--accent)]" />
          Read each phrase aloud <span className={MUTED}>(turn off if a screen reader already reads it)</span>
        </label>
        <p className={MUTED}>While this runs, voice commands are paused, so the phrases don’t act.</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={PRIMARY} disabled={!ready || busy} onClick={start}>Start</button>
          <button type="button" className={QUIET} disabled={busy} onClick={onClose}>Not now</button>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="flex flex-col gap-3">
        {heading(you ? 'Your voice is set up' : `${target.name}’s voice is set up`)}
        <p className={`${BODY} max-w-[720px]`}>
          For now AbleSpeak only measures. Each voice command shows whether it sounded like {you ? 'you' : 'them'}, and
          every voice still works.
        </p>
        <div><button type="button" className={PRIMARY} onClick={onClose}>Done</button></div>
      </div>
    );
  }

  const meter = Math.min(100, Math.round((level / 0.12) * 100));
  return (
    <div className="flex flex-col gap-4">
      {step === 'phrases' && heading(`Phrase ${index + 1} of ${phrases.length}`)}
      {step === 'room' && heading(`Your room, ${ROOM_SECONDS} seconds`)}
      {step === 'finishing' && heading('Making the voiceprint')}
      {!you && <p className={LABEL}>Setting up {target.name}’s voice</p>}

      {step === 'phrases' && (
        <p className="font-heading text-[26px] leading-9 font-[580] text-[var(--ink)] max-w-[760px]">{phrases[index]}</p>
      )}
      {step === 'room' && (
        <p className={`${BODY} max-w-[720px]`}>
          Stay quiet, and let the room make its usual sound: other people talking and a fan are fine. It helps AbleSpeak
          know {whose} voice in that noise.
        </p>
      )}

      <div className="flex items-center gap-3">
        <Icon name={listening ? 'mic' : 'mic_none'} className={`text-[22px] ${listening ? 'text-[var(--accent)]' : 'text-[var(--ink-quiet)]'}`} />
        <div className="h-2 w-48 rounded-full bg-[var(--sunken)] overflow-hidden" aria-hidden="true">
          <div className="h-full bg-[var(--ok)] transition-[width] duration-75" style={{ width: `${listening ? meter : 0}%` }} />
        </div>
        {/* Seen, not announced: a screen reader speaking now would be recorded */}
        <span aria-hidden="true" className={`${LABEL} tabular-nums`}>
          {listening ? (step === 'room' ? `${Math.round(roomSeconds)} of ${ROOM_SECONDS} s` : 'Listening…') : ''}
        </span>
      </div>
      <p role="status" aria-live="polite" className={BODY}>
        {problem && <span className={INK.warn}>{problem} </span>}
        {status}
      </p>
      {step === 'phrases' && <p className={LABEL}>{kept} kept · {info.minClips} needed</p>}

      <div className="flex flex-wrap gap-3">
        {step === 'phrases' && <button type="button" className={QUIET} onClick={() => control('skip')}>Skip this one</button>}
        {step === 'phrases' && kept >= info.minClips && (
          <button type="button" className={QUIET} onClick={() => control('finish')}>Finish now</button>
        )}
        {step === 'room' && <button type="button" className={QUIET} onClick={() => control('skip')}>Leave the room out</button>}
        {step !== 'finishing' && <button type="button" className={DANGER} onClick={stop}>Stop, keep nothing</button>}
      </div>
    </div>
  );
}

/** The owner's (or an admin's) list of the voices on this computer, and adding someone. */
function VoicesHere({ info, onSetUp }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const add = async e => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { student } = await api.addVoicePerson(name.trim());
      setName('');
      onSetUp({ id: student.id, name: student.name, you: false });
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async person => {
    setBusy(true);
    try {
      await api.deleteVoice(person.id);
      setConfirm(null);
      queryClient.invalidateQueries({ queryKey: ['voiceProfile'] });
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--line-soft)] pt-4">
      <h3 className={SECTION}>Voices on this computer</h3>
      {info.people?.length ? (
        <ul className="flex flex-col">
          {info.people.map(p => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 min-h-[44px]">
              <span className={BODY}>
                <span className="text-[var(--ink)]">{p.name}</span>
                <span className={MUTED}> · set up {dateOf(p.enrolledAt)}{info.owner?.id === p.id ? ' · looks after the voices' : ''}</span>
              </span>
              {confirm === p.id ? (
                <span className="flex gap-2">
                  <button type="button" className={SMALL_QUIET} disabled={busy} onClick={() => remove(p)}>Delete {p.name}’s voice</button>
                  <button type="button" className={ROW_ACTION} onClick={() => setConfirm(null)}>Keep it</button>
                </span>
              ) : (
                <button type="button" className={ROW_ACTION} onClick={() => setConfirm(p.id)}>Delete</button>
              )}
            </li>
          ))}
        </ul>
      ) : <p className={MUTED}>No voices yet.</p>}
      <form onSubmit={add} className="flex flex-wrap items-end gap-3">
        <div className="w-72 max-w-full">
          <label htmlFor="voice-person" className={FIELD_LABEL}>Add another person’s voice</label>
          <input id="voice-person" className={FIELD} value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="Their name" autoComplete="off" />
        </div>
        <button type="submit" className={QUIET} disabled={busy || !name.trim() || !!info.enrolling}>Set up their voice</button>
      </form>
      {message && <p className={`text-[13px] ${INK.bad}`} role="alert">{message}</p>}
    </div>
  );
}

export default function MyVoice({ studentId, own }) {
  const queryClient = useQueryClient();
  const { data: info, isPending, error } = useQuery({
    queryKey: ['voiceProfile', studentId],
    queryFn: () => api.getVoiceProfile(studentId),
    refetchInterval: 20000,
  });
  const [setupFor, setSetupFor] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const person = info?.person;
  const you = own && !!person?.you;
  const voice = person?.voice;
  const modelOk = info && info.model?.state !== 'missing' && info.model?.state !== 'failed';
  const otherSetup = info?.enrolling && info.enrolling.id !== person?.id;

  const close = () => {
    setSetupFor(null);
    queryClient.invalidateQueries({ queryKey: ['voiceProfile'] });
  };
  const remove = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.deleteVoice(person.id);
      setConfirmDelete(false);
      setMessage({ tone: 'ok', text: you ? 'Your voice is deleted.' : `${person.name}’s voice is deleted.` });
      queryClient.invalidateQueries({ queryKey: ['voiceProfile'] });
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const [tone, word] = voice ? ['ok', 'Set up · measuring'] : ['idle', 'Not set up'];
  return (
    <section aria-labelledby="my-voice-heading" className={`${CARD} p-5 flex flex-col gap-4`}>
      <div className="flex items-start justify-between gap-4">
        <h2 id="my-voice-heading" className={`${SECTION} flex items-center gap-2`}>
          <Icon name="graphic_eq" className="text-[20px] text-[var(--ink-quiet)]" />
          {you || !person ? 'My voice' : `${person.name}’s voice`}
        </h2>
        {info && person && (
          <span className={`inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap ${INK[tone]}`}>
            <span className={`w-2 h-2 rounded-full ${DOT[tone]}`} aria-hidden="true" />{word}
          </span>
        )}
      </div>

      {isPending && <p className={MUTED}>Loading…</p>}
      {error && <p className={`text-[13px] ${INK.bad}`} role="alert">Couldn’t load the voice settings: {error.message}</p>}

      {info && setupFor && <VoiceSetup target={setupFor} info={info} onClose={close} />}

      {info && !setupFor && (
        <>
          {!modelOk && (
            <p className={BODY}>
              {info.model?.state === 'missing'
                ? 'Voice profiles need the voice model, which isn’t on this computer yet.'
                : `The voice model isn’t working on this computer right now${info.model?.error ? `: ${info.model.error}` : ''}.`}
            </p>
          )}

          {voice ? (
            <>
              <p className={`${BODY} max-w-[720px]`}>
                Set up on {dateOf(voice.enrolledAt)} from {voice.clips} phrases{voice.noisy ? ', with the room’s sound' : ''}.
                For now AbleSpeak only measures how much each voice command sounds like {you ? 'you' : 'them'}; every voice still works.
              </p>
              <Measured measured={person.measured} threshold={info.threshold} you={you} />
            </>
          ) : modelOk && (
            <p className={`${BODY} max-w-[720px]`}>
              Teach AbleSpeak {you ? 'your' : 'this person’s'} voice by reading {info.phrases.length} short phrases, three or four
              minutes. Later, AbleSpeak can listen only to {you ? 'you' : 'them'}, even in a noisy room. The voiceprint stays on this computer.
            </p>
          )}

          {info.owner && (
            <p className={LABEL}>
              {info.owner.you ? 'You look after the voices on this computer.' : `${info.owner.name} looks after the voices on this computer.`}
            </p>
          )}
          {modelOk && !info.canEnroll && info.why && !voice && <p className={BODY}>{info.why}</p>}
          {otherSetup && <p className={MUTED}>Someone’s voice is being set up right now.</p>}

          {modelOk && person && (info.canEnroll || voice) && (
            <div className="flex flex-wrap items-center gap-3">
              {info.canEnroll && (
                <button type="button" className={QUIET} disabled={!!otherSetup}
                  onClick={() => { setMessage(null); setSetupFor({ id: person.id, name: person.name, you }); }}>
                  {voice ? (you ? 'Redo my voice' : 'Redo their voice') : (you ? 'Set up my voice' : 'Set up their voice')}
                </button>
              )}
              {voice && (confirmDelete ? (
                <>
                  <button type="button" className={DANGER} disabled={busy} onClick={remove}>
                    {you ? 'Delete my voice' : 'Delete their voice'}
                  </button>
                  <button type="button" className={QUIET} onClick={() => setConfirmDelete(false)}>Keep it</button>
                  <span className={MUTED}>AbleSpeak forgets the voiceprint.</span>
                </>
              ) : (
                <button type="button" className={QUIET} onClick={() => setConfirmDelete(true)}>Delete…</button>
              ))}
            </div>
          )}
          {message && <p className={`text-[13px] ${INK[message.tone]}`} role="status">{message.text}</p>}

          {modelOk && info.canManage && you && <VoicesHere info={info} onSetUp={target => setSetupFor(target)} />}
        </>
      )}
    </section>
  );
}
