import { useQuery } from '@tanstack/react-query';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';
import { Mic, Brain, AlertTriangle, XCircle, Activity, Monitor, Cpu, Keyboard, WifiOff, Wifi, Command, Sparkles } from 'lucide-react';

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

  return (
    <div className="ds-home">
      {/* ── Warm Greeting ── */}
      <section className="ds-hero">
        <div className="ds-hero-text">
          <div className="ds-hero-eyebrow">
            <Sparkles size={14} aria-hidden="true" />
            <span>{greeting()}</span>
          </div>
          <h2 className="ds-greeting">Ready when you are.</h2>
          <p className="ds-greeting-sub">
            Press <kbd className="ds-kbd">Ctrl</kbd> <kbd className="ds-kbd">Shift</kbd> <kbd className="ds-kbd">A</kbd> anywhere, then just say what you want to do.
          </p>
        </div>
        <div className="ds-hero-stats">
          <div className="ds-stat-pill">
            <span className="ds-stat-value">{commandsToday}</span>
            <span className="ds-stat-label">commands today</span>
          </div>
          <div className="ds-stat-pill">
            <span className="ds-stat-value">{avgLatency ? `${avgLatency}ms` : '—'}</span>
            <span className="ds-stat-label">avg latency</span>
          </div>
        </div>
      </section>

      {/* ── Getting Started — 3 simple steps for the student ── */}
      <section className="ds-steps" aria-label="How to use AbleSpeak">
        <div className="ds-step">
          <div className="ds-step-num"><Keyboard size={20} /></div>
          <div className="ds-step-body">
            <div className="ds-step-title">1 · Wake it up</div>
            <div className="ds-step-text">Press <kbd className="ds-kbd-sm">Ctrl Shift A</kbd> from any screen.</div>
          </div>
        </div>
        <div className="ds-step-arrow" aria-hidden="true">→</div>
        <div className="ds-step">
          <div className="ds-step-num"><Mic size={20} /></div>
          <div className="ds-step-body">
            <div className="ds-step-title">2 · Say it</div>
            <div className="ds-step-text">“Open my email”, “scroll down”, “click submit”.</div>
          </div>
        </div>
        <div className="ds-step-arrow" aria-hidden="true">→</div>
        <div className="ds-step">
          <div className="ds-step-num"><Command size={20} /></div>
          <div className="ds-step-body">
            <div className="ds-step-title">3 · It happens</div>
            <div className="ds-step-text">AbleSpeak does it for you, hands-free.</div>
          </div>
        </div>
      </section>

      {/* ── Status Cards — plain language ── */}
      <section className="ds-status-grid" aria-label="What's working">
        <StatusCard
          icon={<Mic size={20} />}
          label="Microphone"
          value="Ready to hear you"
          ok={true}
          detail="Press Ctrl + Shift + A"
        />
        <StatusCard
          icon={<Brain size={20} />}
          label="Voice Brain"
          value={aiOk ? 'Awake & ready' : 'Waking up…'}
          ok={aiOk}
          detail={aiOk ? 'Understands what you say' : 'Connecting…'}
        />
        <StatusCard
          icon={extOk ? <Wifi size={20} /> : <WifiOff size={20} />}
          label="Web Browser"
          value={extOk ? 'Connected' : 'Not connected'}
          ok={extOk}
          detail={extOk ? 'Voice works on websites too' : 'Add the Chrome helper'}
        />
        <StatusCard
          icon={<Keyboard size={20} />}
          label="Voice Overlay"
          value="Always on"
          ok={true}
          detail="Ready on every screen"
        />
      </section>

      {/* ── Alerts (only actionable) ── */}
      {alerts.length > 0 && (
        <section className="ds-alerts" aria-label="Things to check" aria-live="polite">
          {alerts.map((a, i) => (
            <div key={i} className={`ds-alert ${a.status}`}>
              {a.status === 'error' ? <XCircle size={16} /> : <AlertTriangle size={16} />}
              <span className="ds-alert-component">{a.component}</span>
              <span className="ds-alert-message">{a.message}</span>
            </div>
          ))}
        </section>
      )}

      {/* ── Two-column: Open Apps + Recent Activity ── */}
      <div className="ds-columns">
        {/* Open Applications */}
        <section className="ds-panel" aria-label="Apps AbleSpeak can see">
          <div className="ds-panel-header">
            <Monitor size={16} aria-hidden="true" />
            <h3>Apps AbleSpeak Can See</h3>
            <span className="ds-panel-count">{systemInfo?.visibleApplications?.length || 0}</span>
          </div>
          <div className="ds-app-list">
            {(systemInfo?.visibleApplications || []).slice(0, 12).map(app => (
              <div key={app.id} className={`ds-app-item ${app.foreground ? 'foreground' : ''}`}>
                <div className="ds-app-dot" />
                <div className="ds-app-info">
                  <div className="ds-app-name">{app.title || app.processName}</div>
                  <div className="ds-app-process">{app.processName}</div>
                </div>
                {app.foreground && <span className="ds-app-badge">In front</span>}
              </div>
            ))}
            {(!systemInfo?.visibleApplications || systemInfo.visibleApplications.length === 0) && (
              <div className="ds-empty">Looking at what's open…</div>
            )}
          </div>
        </section>

        {/* Recent Activity */}
        <section className="ds-panel" aria-label="What you just did">
          <div className="ds-panel-header">
            <Activity size={16} aria-hidden="true" />
            <h3>What You Just Did</h3>
          </div>
          <div className="ds-activity-list">
            {activity.length === 0 && (
              <div className="ds-empty">
                <Mic size={28} style={{ opacity: 0.35, marginBottom: 10 }} />
                <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Nothing yet — your voice goes here</div>
                <div style={{ fontSize: 12, marginTop: 4, opacity: 0.6 }}>Press Ctrl + Shift + A and say something</div>
              </div>
            )}
            {activity.map((item) => (
              <div key={item.id} className="ds-activity-item">
                <div className="ds-activity-dot" data-type={item.type} />
                <div className="ds-activity-body">
                  <div className="ds-activity-text">{formatActivity(item)}</div>
                  <div className="ds-activity-time">
                    {item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── System Info (quiet footer) ── */}
      {systemInfo?.computerInfo && (
        <section className="ds-sysinfo" aria-label="Computer information">
          <Cpu size={14} style={{ opacity: 0.4 }} />
          <span>{systemInfo.computerInfo.osName}</span>
          <span className="ds-sysinfo-sep">·</span>
          <span>{systemInfo.computerInfo.hostname}</span>
          <span className="ds-sysinfo-sep">·</span>
          <span>On for {systemInfo.computerInfo.uptime}</span>
        </section>
      )}
    </div>
  );
}

// ── Status Card Component ──
function StatusCard({ icon, label, value, ok, detail }) {
  return (
    <div className={`ds-status-card ${ok ? 'ok' : 'offline'}`}>
      <div className="ds-status-icon">{icon}</div>
      <div className="ds-status-body">
        <div className="ds-status-label">{label}</div>
        <div className="ds-status-value">{value}</div>
        <div className="ds-status-detail">{detail}</div>
      </div>
      <div className={`ds-status-indicator ${ok ? 'ok' : 'offline'}`} />
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

function formatActivity(item) {
  if (item.type === 'voice_transcription') return `You said: “${item.text}”`;
  if (item.type === 'chat_assistant_message') return `AbleSpeak: ${(item.text || '').slice(0, 80)}${(item.text || '').length > 80 ? '…' : ''}`;
  if (item.type === 'command_complete') return `Done ✓ (took ${item.latency_ms}ms)`;
  if (item.type === 'prompt_switch') return `Switched mode → ${item.prompt}`;
  if (item.type === 'log_event' && item.event) return `${item.event.message?.slice(0, 60)}`;
  return item.type;
}
