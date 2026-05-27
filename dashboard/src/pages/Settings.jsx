import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { Brain, Cpu, Globe, Zap, Check, AlertCircle, RefreshCw } from 'lucide-react';

export default function Settings() {
  const queryClient = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 60000 });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 3000 });
  const { data: aiStatus } = useQuery({ queryKey: ['aiStatus'], queryFn: () => fetch('/api/ai/status').then(r => r.json()), refetchInterval: 5000 });
  const { data: providers } = useQuery({ queryKey: ['aiProviders'], queryFn: () => fetch('/api/ai/providers').then(r => r.json()) });
  const { wsRef } = useWebSocket();
  const [switchError, setSwitchError] = useState('');
  const [switchSuccess, setSwitchSuccess] = useState('');

  const switchProvider = async (provider, model) => {
    setSwitchError('');
    setSwitchSuccess('');
    try {
      const res = await fetch('/api/ai/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSwitchError(data.error || 'Failed to switch provider');
      } else {
        setSwitchSuccess(`Switched to ${data.name} / ${data.model}`);
        queryClient.invalidateQueries(['aiStatus']);
        queryClient.invalidateQueries(['aiProviders']);
        setTimeout(() => setSwitchSuccess(''), 3000);
      }
    } catch (err) {
      setSwitchError(err.message);
    }
  };

  return (
    <div>
      <header className="page-header">
        <h2>Settings</h2>
        <p>AbleSpeak AI Agent configuration</p>
      </header>

      {/* LLM Provider Selector */}
      <section aria-label="AI Provider" style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: '1rem', color: 'var(--text-muted)', marginBottom: 16, fontWeight: 600 }}>
          LANGUAGE MODEL
        </h3>

        {/* Current provider status */}
        {aiStatus && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <Brain size={20} style={{ color: 'var(--accent)' }} />
              <h4 style={{ fontWeight: 600, fontSize: '1rem' }}>Current Provider</h4>
              <span className={`badge ${aiStatus.configured ? 'badge-success' : 'badge-error'}`}>
                {aiStatus.configured ? '● Active' : '○ No API Key'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <InfoRow label="Provider" value={aiStatus.providerName} />
              <InfoRow label="Model" value={aiStatus.model} />
              <InfoRow label="Temperature" value={String(aiStatus.temperature)} />
              <InfoRow label="Conversation History" value={`${aiStatus.historyLength} messages`} />
            </div>
          </div>
        )}

        {/* Success/Error messages */}
        {switchSuccess && (
          <div className="health-alert" style={{ background: 'rgba(6,214,160,0.08)', border: '1px solid rgba(6,214,160,0.3)', marginBottom: 16 }}>
            <Check size={18} style={{ color: 'var(--success)' }} />
            <span style={{ color: 'var(--success)' }}>{switchSuccess}</span>
          </div>
        )}
        {switchError && (
          <div className="health-alert error" style={{ marginBottom: 16 }}>
            <AlertCircle size={18} style={{ color: 'var(--error)' }} />
            <span style={{ color: 'var(--error)' }}>{switchError}</span>
          </div>
        )}

        {/* Provider cards */}
        <div className="grid grid-2">
          {providers && Object.entries(providers).map(([key, provider]) => (
            <ProviderCard
              key={key}
              id={key}
              provider={provider}
              isActive={provider.active}
              onSwitch={switchProvider}
            />
          ))}
        </div>
      </section>

      {/* Gateway Info */}
      <section aria-label="Gateway information">
        <h3 style={{ fontSize: '1rem', color: 'var(--text-muted)', marginBottom: 16, fontWeight: 600 }}>ABLESPEAK GATEWAY</h3>
        <div className="card">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <InfoRow label="Agent Version" value="2.0.0 (Standalone)" />
            <InfoRow label="Mode" value="Standalone AI Agent" />
            <InfoRow label="Active Prompt" value={status?.activePrompt || 'ablespeak'} />
            <InfoRow label="Extension Clients" value={String(status?.extensionClients || 0)} />
            <InfoRow label="Dashboard Clients" value={String(status?.dashboardClients || 0)} />
          </div>
        </div>
      </section>
    </div>
  );
}

function ProviderCard({ id, provider, isActive, onSwitch }) {
  const [selectedModel, setSelectedModel] = useState(provider.defaultModel);

  return (
    <div className="card" style={{
      borderColor: isActive ? 'var(--accent)' : provider.configured ? 'var(--border)' : 'rgba(239,71,111,0.3)',
      position: 'relative',
    }}>
      {isActive && (
        <div style={{
          position: 'absolute', top: 12, right: 12,
          background: 'var(--accent)', color: '#fff',
          padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
        }}>
          ACTIVE
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Globe size={18} style={{ color: provider.configured ? 'var(--success)' : 'var(--error)' }} />
        <h4 style={{ fontWeight: 600, fontSize: 15 }}>{provider.name}</h4>
      </div>

      <div style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {provider.configured ? '✓ API Key configured' : `✗ Set ${provider.envKey} in .env`}
        </span>
      </div>

      {/* Model selector */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 13, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Model</label>
        <select
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
          style={{
            width: '100%', padding: '8px 12px',
            background: 'var(--bg-primary)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
            fontSize: 14, fontFamily: 'inherit',
          }}
        >
          {provider.models.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <button
        onClick={() => onSwitch(id, selectedModel)}
        disabled={!provider.configured || isActive}
        style={{
          width: '100%', padding: '10px 16px',
          borderRadius: 'var(--radius-sm)',
          border: 'none',
          background: isActive ? 'var(--bg-tertiary)' : provider.configured ? 'var(--accent)' : 'var(--bg-tertiary)',
          color: isActive ? 'var(--text-muted)' : provider.configured ? '#fff' : 'var(--text-muted)',
          fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
          cursor: provider.configured && !isActive ? 'pointer' : 'not-allowed',
          opacity: isActive ? 0.6 : 1,
        }}
      >
        {isActive ? 'Currently Active' : provider.configured ? 'Switch to This' : 'Not Configured'}
      </button>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 36, gap: 16 }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: 15 }}>{label}</span>
      <span style={{ fontWeight: 500, fontSize: 15, color: 'var(--text-primary)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}
