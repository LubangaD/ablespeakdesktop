/**
 * Home — live health for staff (Stitch "Home & Live Health").
 * Everything shown comes from the server; nothing here is a placeholder.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UserRound, Users, AudioLines, Server, Brain, Globe, Mic, Moon, EyeOff, Activity,
  CircleCheck, TriangleAlert, Wrench, Timer, ArrowRight, MessageSquareText, Pause, Play, Gauge, ScrollText, Settings,
} from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import { Button, Chip, Notice, Panel, StatusPill } from '../components/ui';

const SENSITIVITY = [
  { value: 'standard', label: 'Standard' },
  { value: 'quiet', label: 'Quiet voice' },
  { value: 'noisy', label: 'Noisy room' },
];

const parseLocal = s => (s ? new Date(s.replace(' ', 'T')) : null);

function minutesSince(date, now) {
  if (!date) return null;
  return Math.max(0, Math.floor((now - date.getTime()) / 60000));
}

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

  // Send a phrase exactly as if it had been said (used for pause / resume)
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
  const needAttention = [!connected, !aiReady, extensionCount === 0, !!voice.sleeping].filter(Boolean).length + alerts.length;
  const summary = analytics?.summary;
  const startedAt = parseLocal(active?.startedAt);
  const sessionMinutes = minutesSince(startedAt, now);

  return (
    <div className="home">
      <h2 className="sr-only">Home</h2>

      {/* ── Who is at this computer ── */}
      <section className="session-hero" aria-label="Student session">
        <div className="session-hero-main">
          <span className="avatar" aria-hidden="true">
            {student ? student.name.slice(0, 1).toUpperCase() : <UserRound size={28} />}
          </span>
          <div className="session-hero-text">
            {student ? (
              <>
                <p className="session-hero-name">{student.name}</p>
                <div className="session-hero-meta">
                  <StatusPill tone="success" label="In session" />
                  {startedAt && (
                    <span className="tabular">
                      Since {active.startedAt.slice(11, 16)} · {sessionMinutes < 60 ? `${sessionMinutes} min` : `${Math.floor(sessionMinutes / 60)} h ${sessionMinutes % 60} min`}
                    </span>
                  )}
                  <span>Their voice commands count toward their progress.</span>
                </div>
              </>
            ) : (
              <>
                <p className="session-hero-name">No student chosen</p>
                <div className="session-hero-meta">
                  <StatusPill tone="neutral" label="No session" />
                  <span>Voice commands are not added to anyone's progress.</span>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="session-hero-actions">
          {student ? (
            <>
              <Link className="btn btn-secondary" to="/students"><Users size={20} aria-hidden="true" />Switch student</Link>
              <Button variant="danger" onClick={() => endSession.mutate()} disabled={endSession.isPending}>
                {endSession.isPending ? 'Ending…' : 'End session'}
              </Button>
              <Link className="btn btn-primary" to={`/speech?student=${student.id}`}><AudioLines size={20} aria-hidden="true" />Speech profile</Link>
            </>
          ) : (
            <Link className="btn btn-primary" to="/students"><Users size={20} aria-hidden="true" />Choose a student</Link>
          )}
        </div>
      </section>

      {/* ── Live system health ── */}
      <section aria-labelledby="diag-heading">
        <div className="section-head">
          <h3 id="diag-heading" className="section-title"><Activity size={22} aria-hidden="true" /> Live system health</h3>
          {needAttention
            ? <StatusPill tone="warning" label={`${needAttention} to check`} />
            : <StatusPill tone="success" label="All ready" />}
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
            icon={Server}
            title="Gateway server"
            ok={connected}
            okLabel="Connected" badLabel="Offline"
            value={window.location.host}
            facts={[['Dashboards open', status?.dashboardClients ?? '—']]}
            action={<Link className="btn btn-ghost" to="/developer/logs"><ScrollText size={20} aria-hidden="true" />Open logs</Link>}
          />
          <DiagCard
            icon={Brain}
            title="Speech brain"
            ok={aiReady}
            okLabel="Ready" badLabel="No key"
            value={aiStatus ? `${aiStatus.providerName}` : '—'}
            facts={[['Model', aiStatus?.model || '—'], ['Conversation', aiStatus ? `${aiStatus.historyLength} messages` : '—']]}
            action={<Link className="btn btn-ghost" to="/settings"><Settings size={20} aria-hidden="true" />Change model</Link>}
          />
          <DiagCard
            icon={Globe}
            title="Chrome helper"
            ok={extensionCount > 0}
            okLabel="Connected" badLabel="Not connected"
            value={extensionCount > 0 ? `${extensionCount} browser${extensionCount === 1 ? '' : 's'}` : 'No browser'}
            facts={[['Web commands', extensionCount > 0 ? 'Available' : 'Add the Chrome helper']]}
            action={<Link className="btn btn-ghost" to="/developer/tools"><Wrench size={20} aria-hidden="true" />See web tools</Link>}
          />
          <DiagCard
            icon={voice.sleeping ? Moon : Mic}
            title="Voice control"
            ok={!voice.sleeping && !voice.dismissed}
            okLabel="Listening" badLabel={voice.sleeping ? 'Asleep' : 'Hidden'}
            value={voice.sleeping ? 'Waiting for “wake up”' : voice.dismissed ? 'Waiting for “come back”' : voice.dictationMode ? 'Dictating' : 'Acting on commands'}
            facts={[['Screen reading', voice.privacyMode ? 'Off (privacy mode)' : 'On']]}
            action={voice.sleeping
              ? <Button variant="ghost" icon={Play} onClick={() => say('wake up')} disabled={!connected}>Resume voice</Button>
              : <Button variant="ghost" icon={Pause} onClick={() => say('go to sleep')} disabled={!connected}>Pause voice</Button>}
          />
        </div>
      </section>

      {/* ── Numbers ── */}
      <section className="kpi-grid" aria-label="Today's numbers">
        <Kpi icon={MessageSquareText} label="Commands today" value={stats?.today ?? '—'} detail={summary ? `${summary.totalCommands} in total` : null} />
        <Kpi icon={CircleCheck} label="Success rate, all students" value={summary?.totalCommands ? `${summary.successRate}%` : '—'} bar={summary?.totalCommands ? summary.successRate : null} detail={summary && !summary.totalCommands ? 'No commands yet' : null} />
        <Kpi icon={Gauge} label="Average latency" value={stats?.avgLatency ? `${stats.avgLatency} ms` : '—'} detail="From speech to action" />
        {student
          ? <Kpi icon={AudioLines} label={`${student.name}: worked first time`} value={recognition?.firstTimeRate != null ? `${Math.round(recognition.firstTimeRate * 100)}%` : '—'} bar={recognition?.firstTimeRate != null ? recognition.firstTimeRate * 100 : null} detail="Last 7 days" />
          : <Kpi icon={Users} label="Students" value={summary?.totalStudents ?? '—'} detail="On this computer" />}
      </section>

      <div className="home-columns">
        <IntentPipeline on={on} />
        <div className="stack">
          <SpeechControls student={student} />
          <Panel title="Pause voice" titleId="pause-heading" icon={voice.sleeping ? Moon : Pause} className="pause-panel">
            <p className="panel-lead">
              {voice.sleeping
                ? 'AbleSpeak is asleep. It ignores everything except “wake up”.'
                : 'Stops AbleSpeak acting on speech until someone says “wake up” or you resume it here.'}
            </p>
            {voice.sleeping
              ? <Button variant="primary" block icon={Play} onClick={() => say('wake up')} disabled={!connected}>Resume voice</Button>
              : <Button variant="stop" block icon={Pause} onClick={() => say('go to sleep')} disabled={!connected}>PAUSE VOICE</Button>}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function DiagCard({ icon: Icon, title, ok, okLabel, badLabel, value, facts, action }) {
  return (
    <div className={`diag-card ${ok ? 'ok' : 'bad'}`}>
      <div className="diag-top">
        <span className="diag-title"><Icon size={20} aria-hidden="true" />{title}</span>
        {ok ? <StatusPill tone="success" label={okLabel} /> : <StatusPill tone="warning" label={badLabel} />}
      </div>
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

function Kpi({ icon: Icon, label, value, detail, bar }) {
  return (
    <div className="kpi">
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <span className="kpi-icon" aria-hidden="true"><Icon size={20} /></span>
      </div>
      <div className="kpi-value tabular">{value}</div>
      {bar != null && (
        <div className="kpi-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} /></div>
      )}
      {detail && <div className="kpi-detail">{detail}</div>}
    </div>
  );
}

// ── What was said, and what AbleSpeak did about it, as it happens ──
function IntentPipeline({ on }) {
  const [pending, setPending] = useState(null); // { text, at, step }
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let heard = null;
    const offs = [
      on('voice_transcription', msg => {
        heard = { text: msg.text, at: msg.timestamp || new Date().toISOString() };
        setPending({ ...heard, step: null });
      }),
      on('agent_progress', msg => {
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

  return (
    <Panel title="Live intent pipeline" titleId="pipeline-heading" icon={Activity} className="pipeline"
      aside={<span><span className="tabular">{items.length}</span> this visit</span>}>
      <div className="chip-row section-gap" role="group" aria-label="Show">
        <Chip selected={filter === 'all'} onClick={() => setFilter('all')}>All</Chip>
        <Chip selected={filter === 'failed'} onClick={() => setFilter('failed')}>Didn't work</Chip>
      </div>

      <div className={`pipeline-live${pending ? ' working' : ''}`} aria-live="polite">
        {pending ? (
          <>
            <StatusPill tone="info" label="Working" />
            <p className="pipeline-heard">“{pending.text}”</p>
            {pending.step && <p className="muted-note">{pending.step}</p>}
          </>
        ) : (
          <p className="muted-note">Waiting for the next command. What a student says appears here as it happens.</p>
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
              <span className="pipeline-icon" aria-hidden="true">
                {item.failed ? <TriangleAlert size={20} /> : <CircleCheck size={20} />}
              </span>
              <div className="pipeline-body">
                <div className="pipeline-head">
                  <p className="pipeline-said">{item.heard ? `“${item.heard}”` : 'Typed or follow-up command'}</p>
                  {item.failed ? <StatusPill tone="error" label="Didn't work" /> : <StatusPill tone="success" label="Done" />}
                </div>
                <p className="muted-note tabular">{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
                {item.tools.length > 0 && (
                  <div className="pipeline-tools">
                    {item.tools.map((t, i) => (
                      <span key={i} className={`as-tool-tag${t.failed ? ' failed' : ''}`}><Wrench size={14} aria-hidden="true" />{t.name}</span>
                    ))}
                    {item.latency ? <span className="pipeline-latency tabular"><Timer size={14} aria-hidden="true" />{item.latency} ms</span> : null}
                  </div>
                )}
                {item.reply && <p className="pipeline-reply">{item.reply}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}

      <Link className="text-link pipeline-more" to="/developer/logs">
        Full engine log <ArrowRight size={18} aria-hidden="true" />
      </Link>
    </Panel>
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
      <Panel title="Speech controls" titleId="speech-controls-heading" icon={AudioLines}>
        <p className="panel-lead">Choose a student to change how AbleSpeak listens for them.</p>
        <Link className="btn btn-secondary" to="/students"><Users size={20} aria-hidden="true" />Choose a student</Link>
      </Panel>
    );
  }

  const current = profile?.listening?.sensitivity;
  return (
    <Panel title="Speech controls" titleId="speech-controls-heading" icon={AudioLines}
      aside={<span>for {student.name}</span>}>
      <div className="section-gap">
        <p className="field-label" id="sensitivity-label">How sensitive the microphone is</p>
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

      <p className="field-label">Their words</p>
      {words.length ? (
        <ul className="word-chips">
          {words.slice(0, 8).map(w => <li key={w}>{w}</li>)}
          {words.length > 8 && <li className="more">+{words.length - 8} more</li>}
        </ul>
      ) : (
        <p className="muted-note section-gap">No words added yet.</p>
      )}

      <Link className="btn btn-secondary btn-block" to={`/speech?student=${student.id}`}>
        <AudioLines size={20} aria-hidden="true" />Edit speech profile
      </Link>
    </Panel>
  );
}
