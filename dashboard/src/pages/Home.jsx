/**
 * Home — live health for staff, laid out like the Stitch
 * "AbleSpeak Dashboard — Home & Live Health" screen: session hero,
 * live system diagnostics, key numbers, then the intent pipeline
 * beside the speech controls.
 * Everything shown comes from the server; nothing here is a placeholder.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UserRound, Users, AudioLines, Server, Brain, Globe, Mic, Moon, Eye, EyeOff,
  CircleCheck, CircleHelp, TriangleAlert, Wrench, Timer, ArrowRight, MessageSquareText,
  Pause, Play, Gauge, ScrollText, Settings, Download, PlusCircle, Sparkles, MessageSquarePlus,
} from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import { Button, Chip, Notice, StatusPill } from '../components/ui';

const SENSITIVITY = [
  { value: 'standard', label: 'Standard', hint: 'Most students, in a normal room.' },
  { value: 'quiet', label: 'Quiet voice', hint: 'For a soft or tired voice. Picks up more sound.' },
  { value: 'noisy', label: 'Noisy room', hint: 'Ignores more background talk. The student needs to speak up.' },
];

const parseLocal = s => (s ? new Date(s.replace(' ', 'T')) : null);

function minutesSince(date, now) {
  if (!date) return null;
  return Math.max(0, Math.floor((now - date.getTime()) / 60000));
}

const asDuration = mins => (mins == null ? '—' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`);

export default function Home() {
  const queryClient = useQueryClient();
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.getHealth });
  const { data: stats } = useQuery({ queryKey: ['commandStats'], queryFn: api.getCommandStats });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 5000 });
  const { data: aiStatus } = useQuery({ queryKey: ['aiStatus'], queryFn: api.getAiStatus, staleTime: 10000 });
  const { data: analytics } = useQuery({ queryKey: ['teacherAnalytics'], queryFn: api.getTeacherAnalytics, refetchInterval: 30000 });
  const { data: active } = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });
  const student = active?.student || null;
  const { data: recognition } = useQuery({
    queryKey: ['recognition', student?.id],
    queryFn: () => api.getRecognition(student.id, 7),
    enabled: !!student,
    refetchInterval: 30000,
  });
  const { on, wsRef, connected } = useWebSocket();

  // A clock for the session length
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const endSession = useMutation({
    mutationFn: () => api.setActiveStudent(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['activeStudent'] }),
  });

  // Send a phrase exactly as if it had been said (used for pause / resume / privacy)
  const say = (text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat_command', text }));
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['status'] }), 400);
    }
  };

  const alerts = (health?.alertDetails || []).filter(a => !a.component?.startsWith('provider_') && a.component !== 'llm');
  const voice = status?.voice || {};
  const extensionCount = status?.extensionClients || 0;
  const aiReady = !!aiStatus?.configured;
  const summary = analytics?.summary;
  const startedAt = parseLocal(active?.startedAt);
  const sessionMinutes = minutesSince(startedAt, now);
  const topCommand = stats?.byType?.[0]?.type;

  const notReady = [connected, aiReady, extensionCount > 0, !voice.sleeping && !voice.dismissed, !voice.privacyMode]
    .filter(ok => !ok).length + alerts.length;

  return (
    <div className="home">
      <h2 className="sr-only">Home</h2>

      {/* ── Who is at this computer ── */}
      <section className="session-hero" aria-label="Student session">
        <div className="session-hero-main">
          <span className="avatar" aria-hidden="true">
            {student ? student.name.slice(0, 1).toUpperCase() : <UserRound size={28} />}
            <span className={`avatar-dot ${student ? 'on' : 'off'}`} />
          </span>
          <div className="session-hero-text">
            <div className="session-hero-titles">
              <p className="session-hero-name">{student ? student.name : 'No student chosen'}</p>
              {student
                ? <StatusPill tone="success" label="In session" />
                : <StatusPill tone="neutral" label="No session" />}
              {student && voice.dictationMode && <StatusPill tone="warning" icon={Mic} label="Dictating" />}
            </div>
            <div className="session-hero-meta">
              {student ? (
                <>
                  <span className="meta-strong">
                    <Timer size={18} aria-hidden="true" />
                    <span className="tabular">{asDuration(sessionMinutes)}</span> in session
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Started <span className="tabular">{active.startedAt.slice(11, 16)}</span></span>
                  <span aria-hidden="true">·</span>
                  <span>Their voice commands count toward their progress</span>
                </>
              ) : (
                <span>Voice commands are not added to anyone's progress until a student is chosen.</span>
              )}
            </div>
          </div>
        </div>
        <div className="session-hero-actions">
          {student ? (
            <>
              <Link className="btn btn-secondary" to="/students"><Users size={20} aria-hidden="true" />Switch student</Link>
              <Button variant="danger" onClick={() => endSession.mutate()} disabled={endSession.isPending}>
                {endSession.isPending ? 'Ending…' : 'End session'}
              </Button>
              <Link className="btn btn-primary" to="/test">
                <MessageSquarePlus size={20} aria-hidden="true" />Send a command
              </Link>
            </>
          ) : (
            <Link className="btn btn-primary" to="/students"><Users size={20} aria-hidden="true" />Choose a student</Link>
          )}
        </div>
      </section>

      {/* ── Live system diagnostics ── */}
      <section className="diag-section" aria-labelledby="diag-heading">
        <div className="section-head">
          <div className="section-head-main">
            <span className={`live-dot${connected ? ' on' : ''}`} aria-hidden="true" />
            <h3 id="diag-heading" className="section-title">Live system health</h3>
            <span className="muted-note">Checked every 5 seconds</span>
          </div>
          {notReady
            ? <StatusPill tone="warning" label={`${notReady} to check`} />
            : <StatusPill tone="success" label="Everything ready" />}
        </div>

        {alerts.length > 0 && (
          <div className="stack section-gap" aria-live="polite">
            {alerts.map((a, i) => (
              <Notice key={i} tone={a.status === 'error' ? 'error' : 'warning'} title={a.component}>{a.message}</Notice>
            ))}
          </div>
        )}

        <div className="diag-grid">
          <DiagCard
            icon={Server} label="Gateway server" value={window.location.host}
            ok={connected} okLabel="Connected" badLabel="Offline"
            facts={[['Dashboards open', status?.dashboardClients ?? '—'], ['Commands waiting', status?.pendingCommands ?? '—']]}
            action={<Link className="btn btn-ghost btn-block" to="/developer/logs"><ScrollText size={20} aria-hidden="true" />Open logs</Link>}
          />
          <DiagCard
            icon={Brain} label="Speech brain" value={aiStatus?.providerName || '—'}
            ok={aiReady} okLabel="Ready" badLabel="No key"
            facts={[['Model', aiStatus?.model || '—'], ['Messages kept', aiStatus?.historyLength ?? '—']]}
            action={<Link className="btn btn-ghost btn-block" to="/settings"><Settings size={20} aria-hidden="true" />Change model</Link>}
          />
          <DiagCard
            icon={Globe} label="Chrome helper"
            value={extensionCount > 0 ? `${extensionCount} browser${extensionCount === 1 ? '' : 's'}` : 'No browser'}
            ok={extensionCount > 0} okLabel="Connected" badLabel="Not connected"
            facts={[
              ['Web commands', extensionCount > 0 ? 'Available' : 'Unavailable'],
              ['Helper', extensionCount > 0 ? 'Talking to AbleSpeak' : 'Not installed'],
            ]}
            action={<Link className="btn btn-ghost btn-block" to="/developer/tools"><Wrench size={20} aria-hidden="true" />See web tools</Link>}
          />
          <DiagCard
            icon={voice.sleeping ? Moon : Mic} label="Voice control"
            value={voice.sleeping ? 'Asleep' : voice.dismissed ? 'Hidden' : voice.dictationMode ? 'Dictating' : 'Acting on commands'}
            ok={!voice.sleeping && !voice.dismissed}
            okLabel="Listening" badLabel={voice.sleeping ? 'Asleep' : 'Hidden'}
            facts={[
              ['Wake word', voice.sleeping ? '“wake up”' : voice.dismissed ? '“come back”' : 'Not needed'],
              ['Dictation', voice.dictationMode ? 'On' : 'Off'],
            ]}
            action={voice.sleeping
              ? <Button variant="ghost" block icon={Play} onClick={() => say('wake up')} disabled={!connected}>Resume voice</Button>
              : <Button variant="ghost" block icon={Pause} onClick={() => say('go to sleep')} disabled={!connected}>Pause voice</Button>}
          />
          <DiagCard
            icon={voice.privacyMode ? EyeOff : Eye} label="Screen reading"
            value={voice.privacyMode ? 'Not looking' : 'Reads the screen'}
            ok={!voice.privacyMode} okLabel="On" badLabel="Privacy mode"
            facts={[
              ['Screenshots', voice.privacyMode ? 'Paused' : 'Sent with commands'],
              ['Listening', voice.sleeping ? 'Paused too' : 'Carries on'],
            ]}
            action={voice.privacyMode
              ? <Button variant="ghost" block icon={Eye} onClick={() => say('vision on')} disabled={!connected}>Let it look</Button>
              : <Button variant="ghost" block icon={EyeOff} onClick={() => say('privacy mode')} disabled={!connected}>Stop looking</Button>}
          />
        </div>
      </section>

      {/* ── Numbers ── */}
      <section className="kpi-grid" aria-label="Today's numbers">
        <Kpi
          icon={MessageSquareText} label="Commands today" value={stats?.today ?? '—'}
          facts={[['All time', stats?.total ?? '—'], ['Most used', topCommand || '—']]}
        />
        <Kpi
          icon={CircleCheck} label="Success rate, all students"
          value={summary?.totalCommands ? `${summary.successRate}%` : '—'}
          bar={summary?.totalCommands ? summary.successRate : null}
          detail={summary?.totalCommands ? `${summary.totalCommands} commands counted` : 'No commands yet'}
        />
        <Kpi
          icon={Gauge} label="Average latency today"
          value={stats?.avgLatency ? `${stats.avgLatency} ms` : '—'}
          facts={[['From', 'Speech'], ['To', 'Action done']]}
        />
        {student ? (
          <Kpi
            icon={AudioLines} label={`${student.name}: worked first time`}
            value={recognition?.firstTimeRate != null ? `${Math.round(recognition.firstTimeRate * 100)}%` : '—'}
            bar={recognition?.firstTimeRate != null ? recognition.firstTimeRate * 100 : null}
            detail={recognition?.tasks ? `${recognition.firstTime} of ${recognition.tasks} commands, last 7 days` : 'Nothing heard in the last 7 days'}
          />
        ) : (
          <Kpi
            icon={Users} label="Students" value={summary?.totalStudents ?? '—'}
            detail="Added by staff on this computer. Nobody is in session."
          />
        )}
      </section>

      {/* ── What is happening, and what you can change about it ── */}
      <div className="home-columns">
        <IntentPipeline on={on} />
        <div className="stack">
          <SpeechControls student={student} />
          <div className="pause-block">
            {voice.sleeping ? (
              <Button variant="primary" block icon={Play} className="pause-button" onClick={() => say('wake up')} disabled={!connected}>
                RESUME VOICE
              </Button>
            ) : (
              <Button variant="stop" block icon={Pause} className="pause-button" onClick={() => say('go to sleep')} disabled={!connected}>
                PAUSE VOICE
              </Button>
            )}
            <p className="muted-note pause-note">
              {voice.sleeping
                ? 'AbleSpeak is asleep. It ignores everything except “wake up”.'
                : 'Stops AbleSpeak acting on speech until someone says “wake up” or you resume it here.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// One service: what it is, what it is doing, and one thing you can do about it
function DiagCard({ icon: Icon, label, value, ok, okLabel, badLabel, facts, action }) {
  return (
    <div className={`diag-card ${ok ? 'ok' : 'bad'}`}>
      <div className="diag-top">
        <span className="diag-icon" aria-hidden="true"><Icon size={20} /></span>
        {ok ? <StatusPill tone="success" label={okLabel} /> : <StatusPill tone="warning" label={badLabel} />}
      </div>
      <p className="diag-label">{label}</p>
      <p className="diag-value">{value}</p>
      <dl className="diag-facts">
        {facts.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <div className="diag-action">{action}</div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, detail, facts, bar }) {
  return (
    <div className="kpi">
      <div className="kpi-top">
        <span className="kpi-icon" aria-hidden="true"><Icon size={20} /></span>
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value tabular">{value}</div>
      {bar != null && (
        <div className="kpi-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} /></div>
      )}
      {detail && <p className="kpi-detail">{detail}</p>}
      {facts && (
        <dl className="kpi-facts">
          {facts.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd className="tabular">{v}</dd></div>
          ))}
        </dl>
      )}
    </div>
  );
}

// ── What was said, and what AbleSpeak did about it, as it happens ──
function IntentPipeline({ on }) {
  const [pending, setPending] = useState(null); // { text, at, step }
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('all');
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    let heard = null;
    const offs = [
      on('voice_transcription', msg => {
        heard = { text: msg.text, at: msg.timestamp || new Date().toISOString() };
        setPending({ ...heard, step: null });
      }),
      on('agent_progress', msg => {
        if (msg.phase === 'plan') setPending(p => p && { ...p, step: `Planned ${(msg.steps || []).length} steps` });
        if (msg.phase === 'step') setPending(p => p && { ...p, step: `Step ${msg.index + 1} of ${msg.total}: ${msg.step?.do || ''}` });
      }),
      on('chat_assistant_message', msg => {
        const calls = msg.toolCalls || [];
        const failed = !!msg.error || calls.some(c => c.result?.status === 'error');
        setItems(list => [{
          id: msg.id || `${Date.now()}`,
          heard: heard?.text || null,
          at: msg.timestamp || new Date().toISOString(),
          reply: msg.text,
          tools: calls.map(c => ({ name: c.tool || c.name, failed: c.result?.status === 'error' })),
          latency: msg.latency,
          failed,
        }, ...list].slice(0, 20));
        heard = null;
        setPending(null);
      }),
      ...['voice_no_speech', 'voice_error', 'voice_cancelled'].map(type => on(type, () => { heard = null; setPending(null); })),
    ];
    return () => offs.forEach(off => off());
  }, [on]);

  const shown = filter === 'failed' ? items.filter(i => i.failed) : items;

  // The feed lives in this page only, so staff can keep a copy of a test run
  const exportLog = () => {
    const blob = new Blob([JSON.stringify(itemsRef.current, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `ablespeak-commands-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <section className="pipeline-panel" aria-labelledby="pipeline-heading">
      <div className="pipeline-head-row">
        <h3 id="pipeline-heading" className="pipeline-title">
          <span className={`live-dot${pending ? ' working' : ' on'}`} aria-hidden="true" />
          Live intent pipeline
        </h3>
        <div className="pipeline-tools-row">
          <div className="chip-row" role="group" aria-label="Show">
            <Chip selected={filter === 'all'} onClick={() => setFilter('all')}>All</Chip>
            <Chip selected={filter === 'failed'} onClick={() => setFilter('failed')}>Didn't work</Chip>
          </div>
          <Button icon={Download} onClick={exportLog} disabled={!items.length}>Export log</Button>
        </div>
      </div>

      {/* What is being worked on right now */}
      <div className={`pipeline-live${pending ? ' working' : ''}`} aria-live="polite">
        {pending ? (
          <>
            <div className="pipeline-live-top">
              <StatusPill tone="info" icon={Sparkles} label="Working" />
              <span className="muted-note">{pending.step || 'Sending it to AbleSpeak…'}</span>
            </div>
            <p className="pipeline-heard">“{pending.text}”</p>
          </>
        ) : (
          <p className="muted-note">Nothing being worked on. What a student says appears here as it happens.</p>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="muted-note pipeline-empty">
          {filter === 'failed' ? 'Nothing has failed since this page opened.' : 'No commands since this page opened.'}
        </p>
      ) : (
        <ol className="pipeline-list">
          {shown.map(item => (
            <li key={item.id} className={`pipeline-item${item.failed ? ' failed' : ''}`}>
              <div className="pipeline-item-top">
                <span className="pipeline-icon" aria-hidden="true">
                  {item.failed ? <TriangleAlert size={20} /> : item.heard ? <CircleCheck size={20} /> : <CircleHelp size={20} />}
                </span>
                <div className="pipeline-said-block">
                  <p className="pipeline-said">{item.heard ? `“${item.heard}”` : 'Typed or follow-up command'}</p>
                  <p className="muted-note tabular">
                    {new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </p>
                </div>
                {item.failed ? <StatusPill tone="error" label="Didn't work" /> : <StatusPill tone="success" label="Done" />}
              </div>

              {(item.tools.length > 0 || item.latency) && (
                <div className="pipeline-tools">
                  {item.tools.map((t, i) => (
                    <span key={i} className={`as-tool-tag${t.failed ? ' failed' : ''}`}><Wrench size={14} aria-hidden="true" />{t.name}</span>
                  ))}
                  {item.latency ? <span className="pipeline-latency tabular"><Timer size={14} aria-hidden="true" />{item.latency} ms total</span> : null}
                </div>
              )}
              {item.reply && <p className="pipeline-reply">{item.reply}</p>}
            </li>
          ))}
        </ol>
      )}

      <div className="pipeline-foot">
        <span className="muted-note">
          {items.length
            ? <>Showing <span className="tabular">{shown.length}</span> of <span className="tabular">{items.length}</span> since this page opened</>
            : 'Kept while this page is open'}
        </span>
        <Link className="btn btn-ghost" to="/developer/logs">
          Full engine log <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}

// ── The student's listening settings, one click away ──
function SpeechControls({ student }) {
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({
    queryKey: ['profile', student?.id],
    queryFn: () => api.getProfile(student.id),
    enabled: !!student,
  });
  const setSensitivity = useMutation({
    mutationFn: (sensitivity) => api.saveProfile(student.id, { listening: { sensitivity } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profile', student.id] }),
  });
  const words = useMemo(() => profile?.vocabulary || [], [profile]);

  if (!student) {
    return (
      <section className="controls-panel" aria-labelledby="speech-controls-heading">
        <h3 id="speech-controls-heading" className="controls-title">
          <AudioLines size={22} aria-hidden="true" />Speech engine controls
        </h3>
        <p className="panel-lead">Choose a student to change how AbleSpeak listens for them.</p>
        <Link className="btn btn-secondary btn-block" to="/students"><Users size={20} aria-hidden="true" />Choose a student</Link>
      </section>
    );
  }

  const current = profile?.listening?.sensitivity;
  const chosen = SENSITIVITY.find(s => s.value === current);

  return (
    <section className="controls-panel" aria-labelledby="speech-controls-heading">
      <h3 id="speech-controls-heading" className="controls-title">
        <AudioLines size={22} aria-hidden="true" />Speech engine controls
      </h3>

      {/* How sensitive the microphone is, for the student in session */}
      <div className="control-card">
        <div className="control-card-top">
          <span className="control-label" id="sensitivity-label">How AbleSpeak listens for {student.name}</span>
          {chosen && <StatusPill tone="info" label={`${chosen.label} on`} />}
        </div>
        <p className="control-text">{chosen ? chosen.hint : 'Loading their settings…'}</p>
        <div className="chip-row" role="group" aria-labelledby="sensitivity-label">
          {SENSITIVITY.map(s => (
            <Chip key={s.value} selected={current === s.value}
              disabled={!profile || setSensitivity.isPending}
              onClick={() => current !== s.value && setSensitivity.mutate(s.value)}>
              {s.label}
            </Chip>
          ))}
        </div>
        {setSensitivity.isError && <p className="form-result error">{setSensitivity.error.message}</p>}
        {setSensitivity.isSuccess && <p className="form-result success">Saved. AbleSpeak listens this way now.</p>}
      </div>

      {/* Their own words */}
      <div className="control-card">
        <div className="control-card-top">
          <span className="control-label">{student.name}'s words</span>
          <span className="muted-note"><span className="tabular">{words.length}</span> saved</span>
        </div>
        {words.length ? (
          <ul className="word-chips">
            {words.slice(0, 8).map(w => <li key={w}>{w}</li>)}
            {words.length > 8 && <li className="more">+{words.length - 8} more</li>}
          </ul>
        ) : (
          <p className="control-text">No words added yet. Names and places AbleSpeak keeps mishearing go here.</p>
        )}
        <Link className="btn btn-secondary btn-block" to={`/speech?student=${student.id}`}>
          <PlusCircle size={20} aria-hidden="true" />Edit speech profile
        </Link>
      </div>
    </section>
  );
}
