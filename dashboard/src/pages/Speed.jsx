/**
 * Developer hub › Speed — how long each voice command takes, stage by stage,
 * and what AbleSpeak costs to run today (GET /api/speed, server/src/speed-meter.js).
 * The idea is Voqal's: its app shows the speech-to-text, AI and voice timings
 * and cost of every request. Costs are estimates from list prices; nothing
 * here is made up: a stage that wasn't measured shows a dash.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { SECTION, LABEL, MUTED, BODY, NUMBER, CARD, WELL, TH, TD, DOT, INK } from '../lib/ui';

function Icon({ name, className = '' }) {
  return <span className={`material-symbols-outlined ${className}`} aria-hidden="true">{name}</span>;
}

// Each stage, in the order it happens; the colours only tell the bars apart, the words say it
const STAGES = [
  { key: 'pause', label: 'Pause', what: 'waiting for you to stop talking', color: '#6b7689' },
  { key: 'hear', label: 'Hearing', what: 'speech to words', color: '#6fdcc6' },
  { key: 'look', label: 'Looking', what: 'reading the screen for the AI', color: '#8fb4ff' },
  { key: 'think', label: 'Thinking', what: 'the AI model', color: '#f5a623' },
  { key: 'act', label: 'Doing', what: 'the actions, pages loading', color: '#c9a7ff' },
];
const SPEAK = { key: 'speak', label: 'Speaking', what: 'reply to its first sound', color: '#f0a8d0' };

const ENGINES = { remote: 'Speech service', local: 'This computer', gemini: 'Gemini' };
const VOICES = { edge: 'Edge voice', windows: 'Windows voice' };
const PATHS = { quick: 'Quick', ai: 'AI', dictation: 'Dictation', filtered: 'Set aside', control: 'Control', command: 'Command', exam: 'Exam' };
const SERVICE = { ready: ['ok', 'Awake'], connecting: ['warn', 'Waking up'], reconnecting: ['warn', 'Reconnecting'], asleep: ['idle', 'Asleep'], off: ['idle', 'Off'], failed: ['bad', 'Refused'], unconfigured: ['idle', 'Not set up'] };

const ms = value => (value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`);
const usd = value => (value == null ? '—' : value === 0 ? '$0' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);
const count = n => Number(n || 0).toLocaleString();
const mix = (tally, names) => Object.entries(tally || {}).sort((a, b) => b[1] - a[1]).map(([key, n]) => `${names[key] || key} ${n}`).join(' · ');
const timeOf = at => String(at || '').slice(11, 19);

function StageCard({ icon, title, stat, children }) {
  return (
    <section className={`${CARD} p-6 flex flex-col gap-2 min-w-0`} aria-label={title}>
      <h2 className={`${SECTION} flex items-center gap-2`}><Icon name={icon} className="text-[20px] text-[var(--ink-quiet)]" />{title}</h2>
      <p className={NUMBER}>{ms(stat?.median)}</p>
      <p className={LABEL}>
        {stat?.count ? <>typical, of the last {stat.count} · 9 in 10 within {ms(stat.p90)}</> : 'Nothing measured yet'}
      </p>
      <div className={`${BODY} flex flex-col gap-1 mt-1`}>{children}</div>
    </section>
  );
}

/** One command's stages as one bar; `scale` is the longest bar's milliseconds. */
function StageBar({ turn, scale }) {
  const parts = STAGES.map(s => ({ ...s, value: turn[`${s.key}Ms`] })).filter(p => p.value > 0);
  const sum = parts.reduce((n, p) => n + p.value, 0);
  if (!sum) return <span className={MUTED}>—</span>;
  return (
    <div className="flex h-2.5 rounded-full overflow-hidden bg-[var(--sunken)]" style={{ width: `${Math.max(8, (sum / scale) * 100)}%` }}
      role="img" aria-label={parts.map(p => `${p.label} ${ms(p.value)}`).join(', ')}>
      {parts.map(p => <span key={p.key} style={{ width: `${(p.value / sum) * 100}%`, background: p.color }} title={`${p.label}: ${ms(p.value)}`} />)}
    </div>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {[...STAGES, SPEAK].map(s => (
        <li key={s.key} className={`${LABEL} flex items-center gap-1.5`}>
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
          {s.label} <span className="text-[var(--ink-faint)]">({s.what})</span>
        </li>
      ))}
    </ul>
  );
}

/** The typical command: each stage's median, side by side. */
function WhereTheTimeGoes({ stages, paths }) {
  const parts = STAGES.map(s => ({ ...s, value: stages?.[s.key]?.median })).filter(p => p.value > 0);
  const sum = parts.reduce((n, p) => n + p.value, 0);
  return (
    <section className={`${CARD} p-6 flex flex-col gap-4`} aria-label="Where the time goes">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={SECTION}>Where the time goes</h2>
        <p className={LABEL}>
          Quick commands {ms(paths?.quick?.median)} · with the AI {ms(paths?.ai?.median)}
          <span className="text-[var(--ink-faint)]"> — from the clip arriving to done</span>
        </p>
      </div>
      {sum ? (
        <>
          <div className="flex h-4 rounded-full overflow-hidden bg-[var(--sunken)]">
            {parts.map(p => <span key={p.key} style={{ width: `${(p.value / sum) * 100}%`, background: p.color }} title={`${p.label}: ${ms(p.value)}`} />)}
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[...STAGES, SPEAK].map(s => (
              <div key={s.key} className={`${WELL} px-3 py-2`}>
                <dt className={`${LABEL} flex items-center gap-1.5`}><span className="w-2 h-2 rounded-sm" style={{ background: s.color }} aria-hidden="true" />{s.label}</dt>
                <dd className="text-[var(--ink)] text-[15px] tabular-nums">{ms(stages?.[s.key]?.median)}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : <p className={MUTED}>No voice commands timed yet. Say something to AbleSpeak and it appears here.</p>}
      <Legend />
    </section>
  );
}

function CostToday({ today, service, prices }) {
  const [tone, word] = SERVICE[service?.state] || ['idle', service?.state || 'Off'];
  return (
    <section className={`${CARD} p-6 flex flex-col gap-3`} aria-label="Cost today">
      <h2 className={`${SECTION} flex items-center gap-2`}><Icon name="payments" className="text-[20px] text-[var(--ink-quiet)]" />Cost today</h2>
      <p className={NUMBER}>{usd(today?.total)}</p>
      <ul className={`${BODY} flex flex-col gap-2`}>
        <li>
          <span className="text-[var(--ink)]">AI:</span> {usd(today?.aiCost)} for {count(today?.ai)} of {count(today?.commands)} commands
          {today?.perAiCommand != null && <span className={MUTED}> · {usd(today.perAiCommand * 100)} per 100 AI commands</span>}
          {today?.unpriced && <span className={INK.warn}> · some by a model with no listed price, not counted</span>}
        </li>
        <li>
          <span className="text-[var(--ink)]">Speech service:</span> {usd(today?.speechService?.cost)} for {Math.round(today?.speechService?.awakeMinutes || 0)} min awake
          <span className={MUTED}> · {service?.gpu ? `${service.gpu} GPU` : 'GPU'} at {usd(service?.hourly)} an hour</span>
          <span className="inline-flex items-center gap-1.5 ml-2">
            <span className={`w-2 h-2 rounded-full ${DOT[tone]}`} aria-hidden="true" /><span className={INK[tone]}>{word}</span>
          </span>
        </li>
        <li>
          <span className="text-[var(--ink)]">Google searches for web answers:</span> {count(today?.searches?.count)} today
          <span className={MUTED}> · free up to {count(today?.searches?.free ?? 1500)} a day, then {usd((today?.searches?.each ?? 0.035) * 100)} per 100</span>
          {today?.searches?.cost > 0 && <> · {usd(today.searches.cost)}</>}
        </li>
        <li><span className="text-[var(--ink)]">Gemini hearing and dictation autocorrect:</span> {usd(today?.otherCost)}</li>
        <li><span className="text-[var(--ink)]">Quick commands and the voice:</span> no charge</li>
      </ul>
      <p className={`${LABEL} text-[var(--ink-faint)]`}>
        Estimates at list prices checked {prices?.checked || '—'}: Gemini’s paid tier (a free-tier key costs nothing, with
        lower limits), and Modal’s GPU price in the “eu” region ({prices?.regionFactor ?? 1.15}×). The speech service is
        paid for every minute it is awake, including {Math.round((prices?.scaledownSeconds ?? 300) / 60)} minutes after it was last used.
      </p>
    </section>
  );
}

function details(turn) {
  return [
    turn.hearMs != null && `heard in ${ms(turn.hearMs)}${turn.hearEngine ? ` (${ENGINES[turn.hearEngine] || turn.hearEngine})` : ''}`,
    turn.ai && `AI ${ms(turn.thinkMs)}, ${turn.ai.calls} ${turn.ai.calls === 1 ? 'call' : 'calls'}, ${count(turn.ai.input)} tokens in${turn.ai.cached ? ` (${count(turn.ai.cached)} cached)` : ''}${turn.ai.searches ? `, searched Google` : ''}`,
    turn.cleanMs != null && `autocorrect ${ms(turn.cleanMs)}`,
    turn.tool && `did ${turn.tool}`,
    turn.speakMs != null ? `spoke after ${ms(turn.speakMs)}${turn.voice ? ` (${VOICES[turn.voice] || turn.voice})` : ''}` : turn.replied ? 'reply not timed' : null,
    turn.speaker && `voice ${turn.speaker.match ? 'matched' : 'unknown'} (${turn.speaker.score.toFixed(2)}${Number.isFinite(turn.speaker.snrDb) ? `, ${Math.round(turn.speaker.snrDb)} dB above the room` : ''})`,
  ].filter(Boolean).join(' · ');
}

/** "Only my voice", measuring: how the commands scored against the voices set up (server/src/voice-profile.js). */
function VoiceCheck({ speaker }) {
  return (
    <section className={`${CARD} p-6 flex flex-col gap-2`} aria-label="Voice check">
      <h2 className={`${SECTION} flex items-center gap-2`}><Icon name="graphic_eq" className="text-[20px] text-[var(--ink-quiet)]" />Voice check</h2>
      {speaker?.checked ? (
        <>
          <p className={BODY}>
            <span className="text-[var(--ink)]">{count(speaker.matched)}</span> of the last {count(speaker.checked)} checked commands sounded
            like a voice set up on this computer · typical score {speaker.medianScore?.toFixed(2)}, lowest {speaker.lowestScore?.toFixed(2)} ·
            each check {ms(speaker.medianMs)} on this computer
          </p>
          <p className={LABEL}>Measuring only: nothing is ignored because of it. Each person’s own scores will set where their line goes.</p>
        </>
      ) : (
        <p className={MUTED}>No voice is set up yet, or no command has been checked. Voices are set up on Voice &amp; words › My voice.</p>
      )}
    </section>
  );
}

function RecentCommands({ recent }) {
  if (!recent?.length) return null;
  const scale = Math.max(1, ...recent.map(t => STAGES.reduce((n, s) => n + (t[`${s.key}Ms`] || 0), 0)));
  return (
    <section className={`${CARD} p-6 flex flex-col gap-3`} aria-label="Latest commands">
      <h2 className={SECTION}>Latest commands</h2>
      <div className="overflow-x-auto -mx-3">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr>
              <th scope="col" className={TH}>Time</th>
              <th scope="col" className={TH}>What was said</th>
              <th scope="col" className={TH}>Way</th>
              <th scope="col" className={`${TH} w-[28%]`}>Stages</th>
              <th scope="col" className={`${TH} text-right`}>Done in</th>
              <th scope="col" className={`${TH} text-right`}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {recent.map(turn => (
              <tr key={turn.id ?? `${turn.at}-${turn.said}`} className="border-t border-[var(--line-soft)]">
                <td className={`${TD} tabular-nums text-[var(--ink-quiet)] whitespace-nowrap`}>{timeOf(turn.at)}</td>
                <td className={TD}>
                  <div className="text-[var(--ink)] break-words">“{turn.said}”</div>
                  <div className={`${LABEL} mt-0.5`}>{details(turn)}</div>
                </td>
                <td className={`${TD} whitespace-nowrap`}>{PATHS[turn.path] || turn.path}</td>
                <td className={`${TD} align-middle`}><StageBar turn={turn} scale={scale} /></td>
                <td className={`${TD} text-right tabular-nums whitespace-nowrap`}>{ms(turn.totalMs)}</td>
                <td className={`${TD} text-right tabular-nums whitespace-nowrap`}>{usd(turn.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Speed() {
  const { data, isError, error } = useQuery({ queryKey: ['speed'], queryFn: api.getSpeed, refetchInterval: 3000 });
  if (isError) return <p className={`${INK.bad} text-[14px]`} role="alert">Couldn’t load the timings: {error?.message}</p>;
  if (!data) return <p className={MUTED}>Loading the timings…</p>;
  const { stages, paths, engines, today, speechService, prices, speaker, recent } = data;
  return (
    <div className="flex flex-col gap-6">
      <p className={`${MUTED} text-[14px]`}>
        How long each voice command takes, stage by stage, and what running AbleSpeak costs today. Updated every few seconds.
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <StageCard icon="hearing" title="Speech to text" stat={stages?.hear}>
          <span>{mix(engines?.hear, ENGINES) || 'No engine yet'}</span>
          <span className={MUTED}>Waiting for the pause: {ms(stages?.pause?.median)} typical</span>
        </StageCard>
        <StageCard icon="psychology" title="AI" stat={stages?.think}>
          <span>{engines?.model || 'No AI command yet'}</span>
          <span className={MUTED}>{count(today?.ai)} of {count(today?.commands)} commands today needed it · {usd(today?.perAiCommand)} each</span>
        </StageCard>
        <StageCard icon="record_voice_over" title="Voice" stat={stages?.speak}>
          <span>{mix(engines?.voice, VOICES) || 'No reply timed yet'}</span>
          <span className={MUTED}>No charge: Windows’ voice runs on this computer, Edge’s is a free online voice</span>
        </StageCard>
      </div>
      <WhereTheTimeGoes stages={stages} paths={paths} />
      <CostToday today={today} service={speechService} prices={prices} />
      <VoiceCheck speaker={speaker} />
      <RecentCommands recent={recent} />
    </div>
  );
}
