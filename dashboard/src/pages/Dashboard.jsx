import { useQuery } from '@tanstack/react-query';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';
import {
  Mic, Brain, Activity, Monitor, Cpu, Keyboard, WifiOff, Wifi, Command, Sparkles,
  AudioLines, Bot, CircleCheck, ArrowLeftRight, ScrollText, Circle,
} from 'lucide-react';
import { Notice, Panel, StatTile, StatusPill } from '../components/ui';

export default function Dashboard() {
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.getHealth });
  const { data: stats } = useQuery({ queryKey: ['commandStats'], queryFn: api.getCommandStats });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus });
  const { data: aiStatus } = useQuery({ queryKey: ['aiStatus'], queryFn: api.getAiStatus, staleTime: 10000 });
  const { data: systemInfo } = useQuery({ queryKey: ['system'], queryFn: api.getSystem, refetchInterval: 15000 });
  const { lastMessage } = useWebSocket();
  const [activity, setActivity] = useState([]);

  useEffect(() => {
    if (!lastMessage) return;
    if (['command_dispatch', 'command_complete', 'prompt_switch', 'log_event', 'chat_assistant_message', 'voice_transcription'].includes(lastMessage.type)) {
      setActivity(prev => [{ ...lastMessage, id: Date.now() }, ...prev].slice(0, 30));
    }
  }, [lastMessage]);

  // Filter out provider alerts — only show actionable ones
  const rawAlerts = health?.alertDetails || [];
  const alerts = rawAlerts.filter(a =>
    !a.component?.startsWith('provider_') && a.component !== 'llm'
  );

  const extOk = (status?.extensionClients || 0) > 0;
  const aiOk = !!aiStatus?.provider;
  const commandsToday = stats?.today || 0;
  const avgLatency = stats?.avgLatency || 0;
  const apps = systemInfo?.visibleApplications || [];

  return (
    <div className="ds-home">
      {/* ── Warm Greeting ── */}
      <section className="ds-hero" aria-labelledby="greeting-heading">
        <div className="ds-hero-text">
          <p className="ds-hero-eyebrow">
            <Sparkles size={18} aria-hidden="true" />
            {greeting()}
          </p>
          <h2 id="greeting-heading" className="ds-greeting">Ready when you are.</h2>
          <p className="ds-greeting-sub">
            Press <kbd className="ds-kbd">Ctrl</kbd> <kbd className="ds-kbd">Shift</kbd> <kbd className="ds-kbd">A</kbd> anywhere, then just say what you want to do.
          </p>
        </div>
        <div className="ds-hero-stats">
          <StatTile label="Commands today" value={commandsToday} />
          <StatTile label="Average latency" value={avgLatency ? `${avgLatency} ms` : '—'} />
        </div>
      </section>

      {/* ── Getting Started — 3 simple steps for the student ── */}
      <section aria-label="How to use AbleSpeak">
        <ol className="ds-steps">
          <li className="ds-step">
            <span className="ds-step-icon" aria-hidden="true"><Keyboard size={24} /></span>
            <span className="ds-step-body">
              <span className="ds-step-title">1. Wake it up</span>
              <span className="ds-step-text">Press <kbd className="ds-kbd">Ctrl Shift A</kbd> from any screen.</span>
            </span>
          </li>
          <li className="ds-step">
            <span className="ds-step-icon" aria-hidden="true"><Mic size={24} /></span>
            <span className="ds-step-body">
              <span className="ds-step-title">2. Say it</span>
              <span className="ds-step-text">“Open my email”, “scroll down”, “click submit”.</span>
            </span>
          </li>
          <li className="ds-step">
            <span className="ds-step-icon" aria-hidden="true"><Command size={24} /></span>
            <span className="ds-step-body">
              <span className="ds-step-title">3. It happens</span>
              <span className="ds-step-text">AbleSpeak does it for you, hands-free.</span>
            </span>
          </li>
        </ol>
      </section>

      {/* ── Status Cards — plain language ── */}
      <section className="ds-status-grid" aria-label="What's working">
        <StatusCard
          icon={Mic}
          label="Microphone"
          value="Ready to hear you"
          ok={true}
          detail="Press Ctrl + Shift + A"
        />
        <StatusCard
          icon={Brain}
          label="Voice brain"
          value={aiOk ? 'Awake and ready' : 'Waking up…'}
          ok={aiOk}
          detail={aiOk ? 'Understands what you say' : 'Connecting…'}
        />
        <StatusCard
          icon={extOk ? Wifi : WifiOff}
          label="Web browser"
          value={extOk ? 'Connected' : 'Not connected'}
          ok={extOk}
          detail={extOk ? 'Voice works on websites too' : 'Add the Chrome helper'}
        />
        <StatusCard
          icon={Keyboard}
          label="Voice overlay"
          value="Always on"
          ok={true}
          detail="Ready on every screen"
        />
      </section>

      {/* ── Alerts (only actionable) ── */}
      {alerts.length > 0 && (
        <section className="ds-alerts" aria-label="Things to check" aria-live="polite">
          {alerts.map((a, i) => (
            <Notice key={i} tone={a.status === 'error' ? 'error' : 'warning'} title={a.component}>
              {a.message}
            </Notice>
          ))}
        </section>
      )}

      {/* ── Two-column: Open Apps + Recent Activity ── */}
      <div className="ds-columns">
        {/* Open Applications */}
        <Panel title="Apps AbleSpeak can see" titleId="apps-heading" icon={Monitor} flush
          aside={<span><span className="tabular">{apps.length}</span> open</span>}>
          <ul className="ds-list">
            {apps.slice(0, 12).map(app => (
              <li key={app.id} className={`ds-app-item${app.foreground ? ' foreground' : ''}`}>
                <span className="ds-app-info">
                  <span className="ds-app-name">{app.title || app.processName}</span>
                  <span className="ds-app-process">{app.processName}</span>
                </span>
                {app.foreground && <StatusPill tone="info" label="In front" />}
              </li>
            ))}
          </ul>
          {apps.length === 0 && (
            <p className="ds-empty">Looking at what's open…</p>
          )}
        </Panel>

        {/* Recent Activity */}
        <Panel title="What you just did" titleId="activity-heading" icon={Activity} flush>
          {activity.length === 0 ? (
            <div className="ds-empty">
              <Mic size={32} aria-hidden="true" className="ds-empty-icon" />
              <p className="ds-empty-title">Nothing yet. What you say will show here.</p>
              <p>Press Ctrl + Shift + A and say something.</p>
            </div>
          ) : (
            <ul className="ds-list">
              {activity.map((item) => {
                const { icon: Icon, tone } = activityLook(item.type);
                return (
                  <li key={item.id} className="ds-activity-item">
                    <Icon size={18} aria-hidden="true" className={`ds-activity-icon ${tone}`} />
                    <span className="ds-activity-body">
                      <span className="ds-activity-text">{formatActivity(item)}</span>
                      <span className="ds-activity-time tabular">
                        {item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* ── System Info (quiet footer) ── */}
      {systemInfo?.computerInfo && (
        <section className="ds-sysinfo" aria-label="Computer information">
          <Cpu size={18} aria-hidden="true" />
          <span>{systemInfo.computerInfo.osName}</span>
          <span aria-hidden="true">·</span>
          <span>{systemInfo.computerInfo.hostname}</span>
          <span aria-hidden="true">·</span>
          <span>On for {systemInfo.computerInfo.uptime}</span>
        </section>
      )}
    </div>
  );
}

// ── Status Card Component ──
function StatusCard({ icon: Icon, label, value, ok, detail }) {
  return (
    <div className={`ds-status-card ${ok ? 'ok' : 'offline'}`}>
      <div className="ds-status-top">
        <span className="ds-status-icon" aria-hidden="true"><Icon size={22} /></span>
        {ok
          ? <StatusPill tone="success" label="Ready" />
          : <StatusPill tone="warning" label="Not ready" />}
      </div>
      <div className="ds-status-label">{label}</div>
      <div className="ds-status-value">{value}</div>
      <div className="ds-status-detail">{detail}</div>
    </div>
  );
}

// Time-aware greeting
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// Each kind of activity has its own icon, so colour is never the only cue
function activityLook(type) {
  switch (type) {
    case 'voice_transcription': return { icon: AudioLines, tone: 'accent' };
    case 'chat_assistant_message': return { icon: Bot, tone: 'teal' };
    case 'command_complete': return { icon: CircleCheck, tone: 'success' };
    case 'prompt_switch': return { icon: ArrowLeftRight, tone: 'muted' };
    case 'log_event': return { icon: ScrollText, tone: 'muted' };
    default: return { icon: Circle, tone: 'muted' };
  }
}

function formatActivity(item) {
  if (item.type === 'voice_transcription') return `You said: “${item.text}”`;
  if (item.type === 'chat_assistant_message') return `AbleSpeak: ${(item.text || '').slice(0, 80)}${(item.text || '').length > 80 ? '…' : ''}`;
  if (item.type === 'command_complete') return `Done (took ${item.latency_ms} ms)`;
  if (item.type === 'prompt_switch') return `Switched mode to ${item.prompt}`;
  if (item.type === 'log_event' && item.event) return `${item.event.message?.slice(0, 60)}`;
  return item.type;
}
