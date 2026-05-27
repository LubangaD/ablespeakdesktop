import { useQuery } from '@tanstack/react-query';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';
import { Mic, Brain, MessageSquare, Volume2, Globe, AlertTriangle, XCircle, Activity, Zap, DollarSign, Monitor, Cpu } from 'lucide-react';

export default function Dashboard() {
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.getHealth });
  const { data: stats } = useQuery({ queryKey: ['commandStats'], queryFn: api.getCommandStats });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus });
  const { data: library } = useQuery({ queryKey: ['library'], queryFn: api.getLibrary, staleTime: 30000 });
  const { data: systemInfo } = useQuery({ queryKey: ['system'], queryFn: api.getSystem, refetchInterval: 5000 });
  const { connected: wsConnected, lastMessage } = useWebSocket();
  const [activity, setActivity] = useState([]);

  useEffect(() => {
    if (!lastMessage) return;
    if (['command_dispatch', 'command_complete', 'prompt_switch', 'log_event'].includes(lastMessage.type)) {
      setActivity(prev => [{ ...lastMessage, id: Date.now() }, ...prev].slice(0, 50));
    }
  }, [lastMessage]);

  const alerts = health?.alertDetails || [];
  const voqalOk = status?.voqalConnected;
  const extOk = (status?.extensionClients || 0) > 0;

  // Build integrations list from status
  const integrations = [
    { name: 'Chrome', available: extOk },
    { name: 'Chromium Embedded', available: voqalOk },
    { name: 'Gmail API', available: false },
    { name: 'Visual Studio Code', available: false },
  ];

  // Build prompts list from library categories
  const promptNames = (library?.categories || [])
    .filter(c => c.prompts && c.prompts.length > 0)
    .map(c => ({
      name: c.name,
      active: status?.activePrompt === c.name,
      ready: true
    }));

  // Build tools list from library
  const allTools = [];
  (library?.categories || []).forEach(cat => {
    cat.tools.forEach(tool => {
      allTools.push({
        name: tool.name,
        category: cat.name,
        available: isToolAvailable(cat.name, voqalOk, extOk)
      });
    });
  });

  return (
    <div>
      {/* Top Stats Bar — Mirrors Voqal's latency/cost header */}
      <section aria-label="Pipeline metrics" style={{ marginBottom: 24 }}>
        <div className="grid grid-3">
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px' }}>
            <Mic size={20} style={{ color: voqalOk ? 'var(--success)' : 'var(--error)' }} aria-hidden="true" />
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>Microphone</div>
              <div style={{ fontSize: 13, color: voqalOk ? 'var(--success)' : 'var(--text-muted)' }}>
                {voqalOk ? 'Active' : 'Disabled'}
              </div>
            </div>
          </div>
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px' }}>
            <Activity size={20} style={{ color: 'var(--accent)' }} aria-hidden="true" />
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>Latency</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                STT: {stats?.avgLatency || 'n/a'} · TTS: n/a · LLM: n/a
              </div>
            </div>
          </div>
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px' }}>
            <DollarSign size={20} style={{ color: 'var(--warning)' }} aria-hidden="true" />
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>Cost</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>STT: 0.00¢ · TTS: 0.00¢ · LLM: 0.00¢</div>
            </div>
          </div>
        </div>
      </section>

      {/* Integrations + Prompts — Mirrors Voqal home */}
      <div className="grid grid-2" style={{ marginBottom: 24 }}>
        {/* Voqal Integrations */}
        <section aria-label="AbleSpeak Integrations" className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Globe size={18} aria-hidden="true" />
            AbleSpeak Integrations
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {integrations.map(intg => (
              <div
                key={intg.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '14px 16px', minHeight: 'var(--touch-min)',
                  background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${intg.available ? 'var(--success)' : 'var(--border)'}`,
                }}
                role="status"
                aria-label={`${intg.name}: ${intg.available ? 'Available' : 'Unavailable'}`}
              >
                <div className={`pipeline-dot ${intg.available ? 'ok' : 'error'}`} aria-hidden="true" />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{intg.name}</div>
                  <div style={{ fontSize: 12, color: intg.available ? 'var(--success)' : 'var(--error)' }}>
                    {intg.available ? 'Available' : 'Unavailable'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Voqal Prompts */}
        <section aria-label="AbleSpeak Prompts" className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageSquare size={18} aria-hidden="true" />
            AbleSpeak Prompts
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {promptNames.length === 0 && (
              <div style={{ color: 'var(--text-muted)', padding: 12 }}>Loading prompts...</div>
            )}
            {promptNames.map(p => (
              <div
                key={p.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 16px', minHeight: 48,
                  background: p.active ? 'rgba(67,97,238,0.1)' : 'var(--bg-tertiary)',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${p.active ? 'var(--accent)' : 'var(--border)'}`,
                }}
                role="status"
                aria-label={`${p.name} prompt: ${p.active ? 'Active' : 'Ready'}`}
              >
                <div className={`pipeline-dot ${p.active ? 'ok' : ''}`}
                  style={!p.active ? { background: 'var(--text-muted)', boxShadow: 'none' } : {}}
                  aria-hidden="true"
                />
                <span style={{ fontWeight: 500, textTransform: 'capitalize', flex: 1 }}>{p.name}</span>
                <span className={`badge ${p.active ? 'badge-success' : 'badge-info'}`}>
                  {p.active ? 'Active' : 'Ready'}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Computer Info + Visible Applications */}
      <div className="grid grid-2" style={{ marginBottom: 24 }}>
        {/* Computer Info */}
        <section aria-label="Computer Info" className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Cpu size={18} aria-hidden="true" />
            Computer Info
          </h3>
          {systemInfo?.computerInfo ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                ['Current Time', systemInfo.computerInfo.currentTime],
                ['OS', systemInfo.computerInfo.osName],
                ['Version', systemInfo.computerInfo.osVersion],
                ['Architecture', systemInfo.computerInfo.osArch],
                ['Hostname', systemInfo.computerInfo.hostname],
                ['Uptime', systemInfo.computerInfo.uptime],
              ].map(([label, value]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', fontSize: 14 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                  <span style={{ fontWeight: 500 }}>{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', padding: 12 }}>Loading system info...</div>
          )}
        </section>

        {/* Visible Applications */}
        <section aria-label="Visible Applications" className="card" style={{ maxHeight: 400, overflow: 'auto' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Monitor size={18} aria-hidden="true" />
            Visible Applications ({systemInfo?.visibleApplications?.length || 0})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(systemInfo?.visibleApplications || []).map(app => (
              <div
                key={app.id}
                style={{
                  padding: '10px 14px',
                  background: app.foreground ? 'rgba(67,97,238,0.1)' : 'var(--bg-tertiary)',
                  border: app.foreground ? '1px solid var(--accent)' : '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2, lineHeight: 1.3 }}>
                  {app.foreground && <span style={{ color: 'var(--accent)', marginRight: 6 }}>▶</span>}
                  {app.title}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 16 }}>
                  <span>ID: {app.id}</span>
                  <span>Process: {app.processName}</span>
                  {app.foreground && <span style={{ color: 'var(--accent)' }}>Foreground</span>}
                </div>
              </div>
            ))}
            {(!systemInfo?.visibleApplications || systemInfo.visibleApplications.length === 0) && (
              <div style={{ color: 'var(--text-muted)', padding: 12 }}>Scanning applications...</div>
            )}
          </div>
        </section>
      </div>

      {/* Health Alerts */}
      {alerts.length > 0 && (
        <section aria-label="Health alerts" aria-live="polite" style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: '1rem', color: 'var(--warning)', marginBottom: 12, fontWeight: 600 }}>
            <AlertTriangle size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            HEALTH ALERTS ({alerts.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {alerts.map((a, i) => (
              <div key={i} className={`health-alert ${a.status}`}>
                {a.status === 'error' ? <XCircle size={20} /> : <AlertTriangle size={20} />}
                <div>
                  <div style={{ fontWeight: 600 }}>{a.component}</div>
                  <div style={{ color: 'var(--text-secondary)' }}>{a.message}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Voqal Tools Grid — Mirrors Voqal home screen */}
      <section aria-label="AbleSpeak Tools" style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={18} aria-hidden="true" />
          AbleSpeak Tools
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
          The functionality AbleSpeak can use to perform tasks.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {allTools.map(tool => (
            <div
              key={`${tool.category}-${tool.name}`}
              style={{
                padding: '14px 16px',
                background: 'var(--bg-secondary)',
                border: `1px solid ${tool.available ? 'var(--border)' : 'rgba(239,71,111,0.2)'}`,
                borderRadius: 'var(--radius-sm)',
                minHeight: 60,
              }}
              role="status"
              aria-label={`${tool.name}: ${tool.available ? 'Available' : 'Unavailable'}`}
            >
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                {tool.name.replace(/_/g, ' ')}
              </div>
              <div style={{ fontSize: 12, color: tool.available ? 'var(--success)' : 'var(--error)' }}>
                {tool.available ? 'Available' : 'Unavailable'}
              </div>
            </div>
          ))}
          {allTools.length === 0 && (
            <div style={{ gridColumn: '1 / -1', color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>
              Loading tools from AbleSpeak library...
            </div>
          )}
        </div>
      </section>

      {/* Recent Activity */}
      <section aria-label="Recent activity" className="card">
        <h3 style={{ marginBottom: 16, fontSize: '1rem', fontWeight: 600 }}>RECENT ACTIVITY</h3>
        <div className="activity-feed" aria-live="polite">
          {activity.length === 0 && <div style={{ color: 'var(--text-muted)', padding: 16 }}>Waiting for voice commands...</div>}
          {activity.map((item) => (
            <div key={item.id} className="activity-item">
              <span className="activity-time">{new Date(item.timestamp).toLocaleTimeString()}</span>
              <span className={`badge badge-${item.type === 'command_complete' ? 'success' : 'info'}`}>
                {item.commandType || item.type}
              </span>
              <span className="activity-text">{formatActivity(item)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function isToolAvailable(category, voqalOk, extOk) {
  // Mirror Voqal's selector-based availability
  const alwaysAvailable = ['voqal', 'computer'];
  const needsChrome = ['chrome', 'gmail', 'youtube', 'amazon'];
  const needsVscode = ['vscode'];
  const needsNotepad = ['notepad'];

  if (alwaysAvailable.includes(category)) return voqalOk;
  if (needsChrome.includes(category)) return extOk;
  if (needsVscode.includes(category)) return false; // VS Code integration not connected
  if (needsNotepad.includes(category)) return false;
  return false;
}

function formatActivity(item) {
  if (item.type === 'command_complete') return `✅ ${item.latency_ms}ms`;
  if (item.type === 'prompt_switch') return `→ ${item.prompt}`;
  if (item.type === 'log_event' && item.event) return item.event.message?.slice(0, 60);
  return '';
}
