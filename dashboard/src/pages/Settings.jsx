import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';
import { Brain, Globe, Check, AlertCircle, RefreshCw, KeyRound, Mic, ExternalLink } from 'lucide-react';

export default function Settings() {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 3000 });
  const { data: aiStatus } = useQuery({ queryKey: ['aiStatus'], queryFn: api.getAiStatus, refetchInterval: 5000 });
  const { data: providers } = useQuery({ queryKey: ['aiProviders'], queryFn: api.getAiProviders });
  const [notice, setNotice] = useState(null); // { tone: 'success' | 'error', text }

  const refreshAi = () => {
    queryClient.invalidateQueries({ queryKey: ['aiStatus'] });
    queryClient.invalidateQueries({ queryKey: ['aiProviders'] });
    queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
  };

  const switchProvider = async (provider, model) => {
    setNotice(null);
    try {
      const result = await api.useProvider(provider, model);
      setNotice({ tone: result.saved ? 'success' : 'error', text: result.message });
      refreshAi();
    } catch (err) {
      setNotice({ tone: 'error', text: err.message });
    }
  };

  return (
    <div>
      <header className="page-header">
        <h2>Settings</h2>
        <p>AbleSpeak AI Agent configuration</p>
      </header>

      <ApiKeysSection onChanged={refreshAi} />

      {/* LLM Provider Selector */}
      <section aria-label="AI Provider" style={{ marginBottom: 32 }}>
        <h3 className="settings-heading">LANGUAGE MODEL</h3>

        {/* Current provider status */}
        {aiStatus && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <Brain size={20} style={{ color: 'var(--accent)' }} aria-hidden="true" />
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

        {notice && (
          <div
            className={`health-alert${notice.tone === 'error' ? ' error' : ''}`}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            style={notice.tone === 'error'
              ? { marginBottom: 16 }
              : { background: 'rgba(6,214,160,0.08)', border: '1px solid rgba(6,214,160,0.3)', marginBottom: 16 }}
          >
            {notice.tone === 'error'
              ? <AlertCircle size={18} style={{ color: 'var(--error)' }} aria-hidden="true" />
              : <Check size={18} style={{ color: 'var(--success)' }} aria-hidden="true" />}
            <span style={{ color: notice.tone === 'error' ? 'var(--error)' : 'var(--success)' }}>{notice.text}</span>
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
        <h3 className="settings-heading">ABLESPEAK GATEWAY</h3>
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

function ApiKeysSection({ onChanged }) {
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['apiKeys'], queryFn: api.getApiKeys });

  return (
    <section aria-labelledby="api-keys-heading" style={{ marginBottom: 32 }}>
      <h3 id="api-keys-heading" className="settings-heading">
        <KeyRound size={16} aria-hidden="true" /> API KEYS
      </h3>
      <p className="settings-lead">
        Keys stay on this computer and work as soon as they are saved — no restart needed.
        {data?.envPath && <> They are saved in <code className="settings-path">{data.envPath}</code>.</>}
      </p>

      {isLoading && <p className="settings-lead">Loading keys…</p>}
      {isError && (
        <div className="health-alert error" role="alert" style={{ marginBottom: 16 }}>
          <AlertCircle size={18} style={{ color: 'var(--error)' }} aria-hidden="true" />
          <span style={{ color: 'var(--error)' }}>Couldn't load the API keys: {error.message}</span>
        </div>
      )}
      {data && !data.voiceReady && (
        <div className="health-alert warn" role="status" style={{ marginBottom: 16 }}>
          <Mic size={18} style={{ color: 'var(--warning)' }} aria-hidden="true" />
          <span>Voice needs a Google Gemini key. Until one is saved, AbleSpeak can't hear anything.</span>
        </div>
      )}

      {data && (
        <div className="grid grid-2">
          {data.providers.map(provider => (
            <ApiKeyCard key={provider.id} provider={provider} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

function ApiKeyCard({ provider, onChanged }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState(provider.endpoint || '');
  const [deployment, setDeployment] = useState(provider.deployment || '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { tone: 'success' | 'warn' | 'error', text }
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isAzure = provider.id === 'azure';
  const fieldId = `api-key-${provider.id}`;

  const apply = (data) => {
    queryClient.setQueryData(['apiKeys'], data);
    onChanged();
  };

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    setConfirmRemove(false);
    try {
      const body = { key: key.trim() };
      if (isAzure) Object.assign(body, { endpoint: endpoint.trim(), deployment: deployment.trim() });
      const data = await api.saveApiKey(provider.id, body);
      setKey('');
      setResult({ tone: data.verified === null ? 'warn' : 'success', text: data.message });
      apply(data);
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setResult(null);
    try {
      const data = await api.removeApiKey(provider.id);
      setConfirmRemove(false);
      setResult({ tone: 'warn', text: data.message });
      apply(data);
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const badgeClass = provider.configured ? 'badge-success' : provider.usedForVoice ? 'badge-warning' : 'badge-error';

  return (
    <form className="card settings-key-card" onSubmit={save} aria-labelledby={`${fieldId}-title`}>
      <div className="settings-key-head">
        <h4 id={`${fieldId}-title`}>{provider.name}</h4>
        <span className={`badge ${badgeClass}`}>
          {provider.configured ? `Saved ${provider.masked}` : 'Not set'}
        </span>
      </div>
      {provider.usedForVoice && (
        <p className="settings-key-note">
          <Mic size={14} aria-hidden="true" /> Used for voice, whichever language model you choose.
        </p>
      )}

      <label htmlFor={fieldId} className="settings-label">
        {provider.configured ? 'Replace the key' : 'API key'}
      </label>
      <input
        id={fieldId}
        type="password"
        className="settings-input"
        value={key}
        onChange={e => setKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder={provider.configured ? 'Paste a new key to replace it' : `Paste your ${provider.name} key`}
      />

      {isAzure && (
        <>
          <label htmlFor={`${fieldId}-endpoint`} className="settings-label">Endpoint</label>
          <input
            id={`${fieldId}-endpoint`}
            type="url"
            className="settings-input"
            value={endpoint}
            onChange={e => setEndpoint(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://your-resource.openai.azure.com"
          />
          <label htmlFor={`${fieldId}-deployment`} className="settings-label">Deployment name (optional)</label>
          <input
            id={`${fieldId}-deployment`}
            type="text"
            className="settings-input"
            value={deployment}
            onChange={e => setDeployment(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="gpt-4o-mini"
          />
        </>
      )}

      <div className="settings-key-actions">
        <button type="submit" className="settings-btn primary" disabled={busy || !key.trim()}>
          {busy ? 'Checking…' : 'Save key'}
        </button>
        {provider.configured && !confirmRemove && (
          <button type="button" className="settings-btn quiet" onClick={() => setConfirmRemove(true)} disabled={busy}>
            Remove
          </button>
        )}
        {provider.configured && confirmRemove && (
          <>
            <button type="button" className="settings-btn danger" onClick={remove} disabled={busy}>
              Remove {provider.name} key
            </button>
            <button type="button" className="settings-btn quiet" onClick={() => setConfirmRemove(false)} disabled={busy}>
              Keep it
            </button>
          </>
        )}
        {provider.keyPage && (
          <a className="settings-link" href={provider.keyPage} target="_blank" rel="noreferrer">
            Get a key <ExternalLink size={13} aria-hidden="true" />
          </a>
        )}
      </div>

      <p className={`settings-result ${result?.tone || ''}`} role="status" aria-live="polite">
        {result?.text || ''}
      </p>
    </form>
  );
}

function ProviderCard({ id, provider, isActive, onSwitch }) {
  const [selectedModel, setSelectedModel] = useState(provider.defaultModel);
  const queryClient = useQueryClient();

  // LIVE model list from the provider's API (falls back to the static list)
  const { data: liveModels, isFetching: modelsLoading } = useQuery({
    queryKey: ['models', id],
    queryFn: () => fetch(`/api/ai/models?provider=${id}`).then(r => r.json()),
    enabled: !!provider.configured,
    staleTime: 5 * 60 * 1000,
  });
  const models = liveModels?.models?.length ? liveModels.models : provider.models;

  // Keep the selection valid when the live list arrives
  useEffect(() => {
    if (models.length && !models.includes(selectedModel)) {
      setSelectedModel(models[0]);
    }
  }, [models]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshModels = async () => {
    await fetch(`/api/ai/models?provider=${id}&refresh=1`);
    queryClient.invalidateQueries({ queryKey: ['models', id] });
  };

  return (
    <div className="card" style={{
      borderColor: isActive ? 'var(--accent)' : provider.configured ? 'var(--border)' : 'rgba(239,71,111,0.3)',
      position: 'relative',
    }}>
      {isActive && (
        <div style={{
          position: 'absolute', top: 12, right: 12,
          background: 'var(--accent)', color: 'var(--bg-primary)',
          padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700,
        }}>
          ACTIVE
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Globe size={18} style={{ color: provider.configured ? 'var(--success)' : 'var(--error)' }} aria-hidden="true" />
        <h4 style={{ fontWeight: 600, fontSize: 15 }}>{provider.name}</h4>
      </div>

      <div style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {!provider.envKey ? '✓ No key needed' : provider.configured ? '✓ API key saved' : '✗ Add a key under API keys above'}
        </span>
      </div>

      {/* Model selector (live list from provider API) */}
      <div style={{ marginBottom: 12 }}>
        <label htmlFor={`model-${id}`} style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <span>Model {liveModels?.models?.length ? `(${liveModels.models.length} available)` : '(default list)'}</span>
          {provider.configured && (
            <button
              type="button"
              onClick={refreshModels}
              aria-label={`Refresh ${provider.name} model list`}
              title="Refresh model list"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', padding: 4, display: 'flex', alignItems: 'center',
              }}
            >
              <RefreshCw size={14} style={modelsLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
            </button>
          )}
        </label>
        <select
          id={`model-${id}`}
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
          className="settings-input"
        >
          {models.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <button
        type="button"
        onClick={() => onSwitch(id, selectedModel)}
        disabled={!provider.configured || isActive}
        className={`settings-btn ${provider.configured && !isActive ? 'primary' : 'quiet'}`}
        style={{ width: '100%' }}
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
