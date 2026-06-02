import { useQuery } from '@tanstack/react-query';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';
import { Mic, Brain, MessageSquare, Volume2, Globe, AlertTriangle, XCircle, Activity, Zap, Monitor, Cpu, Keyboard, CheckCircle2, WifiOff, Wifi, ChevronRight } from 'lucide-react';

export default function Dashboard() {
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.getHealth });
  const { data: stats } = useQuery({ queryKey: ['commandStats'], queryFn: api.getCommandStats });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus });
  const { data: aiStatus } = useQuery({ queryKey: ['aiStatus'], queryFn: api.getAiStatus, staleTime: 10000 });
  const { data: systemInfo } = useQuery({ queryKey: ['system'], queryFn: api.getSystem, refetchInterval: 15000 });
  const { connected: wsConnected, lastMessage } = useWebSocket();
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
  const commandsToday = stats?.today || 0;
  const avgLatency = stats?.avgLatency || 0;

  return (
    <div className="ds-home">
      {/* ── Hero Greeting ── */}
      <section className="ds-hero">
        <div className="ds-hero-text">
          <h2 className="ds-greeting">AbleSpeak</h2>
          <p className="ds-greeting-sub">
            Voice-powered computer navigation. Press <kbd className="ds-kbd">Ctrl + Shift + A</kbd> from anywhere to start.
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

      {/* ── Status Cards ── */}
      <section className="ds-status-grid" aria-label="System status">
        <StatusCard
          icon={<Mic size={20} />}
          label="Microphone"
          value="Ready"
          ok={true}
          detail="Ctrl+Shift+A to activate"
        />
        <StatusCard
          icon={<Brain size={20} />}
          label="AI Engine"
          value={aiStatus?.model || 'Loading...'}
          ok={!!aiStatus?.provider}
          detail={aiStatus?.provider ? `Provider: ${aiStatus.provider}` : 'Connecting...'}
        />
        <StatusCard
          icon={extOk ? <Wifi size={20} /> : <WifiOff size={20} />}
          label="Browser"
          value={extOk ? 'Connected' : 'Disconnected'}
          ok={extOk}
          detail={extOk ? `${status?.extensionClients || 1} extension${(status?.extensionClients || 1) > 1 ? 's' : ''}` : 'Install Chrome extension'}
        />
        <StatusCard
          icon={<Keyboard size={20} />}
          label="Overlay"
          value="Active"
          ok={true}
          detail="Ctrl+Shift+A"
        />
      </section>

      {/* ── Alerts (only actionable, no provider spam) ── */}
      {alerts.length > 0 && (
        <section className="ds-alerts" aria-label="Alerts" aria-live="polite">
          {alerts.map((a, i) => (
            <div key={i} className={`ds-alert ${a.status}`}>
              {a.status === 'error' ? <XCircle size={16} /> : <AlertTriangle size={16} />}
              <span className="ds-alert-component">{a.component}</span>
              <span className="ds-alert-message">{a.message}</span>
            </div>
          ))}
        </section>
      )}

      {/* ── Two-column: Visible Apps + Recent Activity ── */}
      <div className="ds-columns">
        {/* Visible Applications */}
        <section className="ds-panel" aria-label="Visible Applications">
          <div className="ds-panel-header">
            <Monitor size={16} aria-hidden="true" />
            <h3>Visible Applications</h3>
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
                {app.foreground && <span className="ds-app-badge">Active</span>}
              </div>
            ))}
            {(!systemInfo?.visibleApplications || systemInfo.visibleApplications.length === 0) && (
              <div className="ds-empty">Scanning applications...</div>
            )}
          </div>
        </section>

        {/* Recent Activity */}
        <section className="ds-panel" aria-label="Recent Activity">
          <div className="ds-panel-header">
            <Activity size={16} aria-hidden="true" />
            <h3>Recent Activity</h3>
          </div>
          <div className="ds-activity-list">
            {activity.length === 0 && (
              <div className="ds-empty">
                <Mic size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
                <div>Waiting for voice commands...</div>
                <div style={{ fontSize: 12, marginTop: 4, opacity: 0.5 }}>Press Ctrl+Shift+A to speak</div>
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

      {/* ── System Info (compact) ── */}
      {systemInfo?.computerInfo && (
        <section className="ds-sysinfo" aria-label="System Information">
          <Cpu size={14} style={{ opacity: 0.4 }} />
          <span>{systemInfo.computerInfo.osName}</span>
          <span className="ds-sysinfo-sep">·</span>
          <span>{systemInfo.computerInfo.hostname}</span>
          <span className="ds-sysinfo-sep">·</span>
          <span>{systemInfo.computerInfo.osArch}</span>
          <span className="ds-sysinfo-sep">·</span>
          <span>Uptime: {systemInfo.computerInfo.uptime}</span>
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

function formatActivity(item) {
  if (item.type === 'voice_transcription') return `🎤 "${item.text}"`;
  if (item.type === 'chat_assistant_message') return `🤖 ${(item.text || '').slice(0, 80)}${(item.text || '').length > 80 ? '...' : ''}`;
  if (item.type === 'command_complete') return `✅ Command completed (${item.latency_ms}ms)`;
  if (item.type === 'prompt_switch') return `📝 Prompt → ${item.prompt}`;
  if (item.type === 'log_event' && item.event) return `📋 ${item.event.message?.slice(0, 60)}`;
  return item.type;
}
