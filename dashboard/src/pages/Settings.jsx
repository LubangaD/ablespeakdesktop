import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState, useEffect } from 'react';
import { Brain, Globe, RefreshCw, KeyRound, Mic, ExternalLink, Settings as SettingsIcon, CircleCheck, CircleX, Server } from 'lucide-react';
import { Button, Field, Notice, Panel, StatusPill, TextField } from '../components/ui';

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
        <h2><SettingsIcon size={28} aria-hidden="true" /> Settings</h2>
        <p>Keys and the language model AbleSpeak uses on this computer.</p>
      </header>

      <ApiKeysSection onChanged={refreshAi} />

      {/* LLM Provider Selector */}
      <section aria-labelledby="llm-heading" className="section">
        <h3 id="llm-heading" className="section-title"><Brain size={22} aria-hidden="true" /> Language model</h3>

        {/* Current provider status */}
        {aiStatus && (
          <Panel title="Current provider" titleId="current-provider-heading" className="section-gap"
            aside={aiStatus.configured
              ? <StatusPill tone="success" label="Active" />
              : <StatusPill tone="error" label="No API key" />}>
            <dl className="info-list">
              <InfoRow label="Provider" value={aiStatus.providerName} />
              <InfoRow label="Model" value={aiStatus.model} />
              <InfoRow label="Temperature" value={String(aiStatus.temperature)} />
              <InfoRow label="Conversation history" value={`${aiStatus.historyLength} messages`} />
            </dl>
          </Panel>
        )}

        {notice && (
          <Notice tone={notice.tone} className="section-gap">{notice.text}</Notice>
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
      <section aria-labelledby="gateway-heading" className="section">
        <h3 id="gateway-heading" className="section-title"><Server size={22} aria-hidden="true" /> AbleSpeak gateway</h3>
        <Panel as="div">
          <dl className="info-list">
            <InfoRow label="Agent version" value="2.0.0 (Standalone)" />
            <InfoRow label="Mode" value="Standalone AI agent" />
            <InfoRow label="Active prompt" value={status?.activePrompt || 'ablespeak'} />
            <InfoRow label="Extension clients" value={String(status?.extensionClients || 0)} />
            <InfoRow label="Dashboard clients" value={String(status?.dashboardClients || 0)} />
          </dl>
        </Panel>
      </section>
    </div>
  );
}

function ApiKeysSection({ onChanged }) {
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['apiKeys'], queryFn: api.getApiKeys });

  return (
    <section aria-labelledby="api-keys-heading" className="section">
      <h3 id="api-keys-heading" className="section-title">
        <KeyRound size={22} aria-hidden="true" /> API keys
      </h3>
      <p className="panel-lead">
        Keys stay on this computer and work as soon as they are saved — no restart needed.
        {data?.envPath && <> They are saved in <code className="code-inline">{data.envPath}</code>.</>}
      </p>

      {isLoading && <p className="muted-note section-gap">Loading keys…</p>}
      {isError && (
        <Notice tone="error" className="section-gap">Couldn't load the API keys: {error.message}</Notice>
      )}
      {data && !data.voiceReady && (
        <Notice tone="warning" icon={Mic} className="section-gap">
          Voice needs a Google Gemini key. Until one is saved, AbleSpeak can't hear anything.
        </Notice>
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

function keyPill(provider) {
  if (provider.configured) return <StatusPill tone="success" label="Saved" />;
  if (provider.usedForVoice) return <StatusPill tone="warning" label="Needed" />;
  return <StatusPill tone="neutral" label="Not set" />;
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

  return (
    <Panel as="form" onSubmit={save} title={provider.name} titleId={`${fieldId}-title`} icon={KeyRound}
      aside={keyPill(provider)} className="key-card">
      <div className="form-stack">
        {(provider.configured || provider.usedForVoice) && (
          <div className="key-facts">
            {provider.configured && (
              <p className="muted-note">Saved key ends <span className="tabular key-mask">{provider.masked}</span></p>
            )}
            {provider.usedForVoice && (
              <p className="key-note"><Mic size={16} aria-hidden="true" /> Used for voice, whichever language model you choose.</p>
            )}
          </div>
        )}

        <TextField
          id={fieldId}
          type="password"
          label={provider.configured ? 'Replace the key' : 'API key'}
          value={key}
          onChange={e => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={provider.configured ? 'Paste a new key to replace it' : `Paste your ${provider.name} key`}
        />

        {isAzure && (
          <>
            <TextField
              id={`${fieldId}-endpoint`}
              type="url"
              label="Endpoint"
              value={endpoint}
              onChange={e => setEndpoint(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://your-resource.openai.azure.com"
            />
            <TextField
              id={`${fieldId}-deployment`}
              label="Deployment name (optional)"
              value={deployment}
              onChange={e => setDeployment(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="gpt-4o-mini"
            />
          </>
        )}

        <div className="button-row">
          <Button type="submit" variant="primary" disabled={busy || !key.trim()}>
            {busy ? 'Checking…' : 'Save key'}
          </Button>
          {provider.configured && !confirmRemove && (
            <Button onClick={() => setConfirmRemove(true)} disabled={busy}>
              Remove
            </Button>
          )}
          {provider.configured && confirmRemove && (
            <>
              <Button variant="danger" onClick={remove} disabled={busy}>
                Remove {provider.name} key
              </Button>
              <Button onClick={() => setConfirmRemove(false)} disabled={busy}>
                Keep it
              </Button>
            </>
          )}
          {provider.keyPage && (
            <a className="text-link push-right" href={provider.keyPage} target="_blank" rel="noreferrer">
              Get a key <ExternalLink size={16} aria-hidden="true" />
              <span className="sr-only">(opens in your browser)</span>
            </a>
          )}
        </div>

        <p className={`form-result ${result?.tone || ''}`} role="status" aria-live="polite">
          {result?.text || ''}
        </p>
      </div>
    </Panel>
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

  const keyText = !provider.envKey ? 'No key needed' : provider.configured ? 'API key saved' : 'Add a key under API keys above';
  const keyReady = !provider.envKey || provider.configured;

  return (
    <Panel title={provider.name} titleId={`provider-${id}-title`} icon={Globe}
      className={`provider-card${isActive ? ' active' : ''}`}
      aside={isActive ? <StatusPill tone="info" label="In use" /> : null}>
      <div className="form-stack">
        <p className={`key-status ${keyReady ? 'ready' : 'missing'}`}>
          {keyReady ? <CircleCheck size={18} aria-hidden="true" /> : <CircleX size={18} aria-hidden="true" />}
          {keyText}
        </p>

        {/* Model selector (live list from provider API) */}
        <Field id={`model-${id}`}
          label={liveModels?.models?.length ? `Model (${liveModels.models.length} available)` : 'Model (default list)'}>
          <div className="select-with-action">
            <select
              id={`model-${id}`}
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              className="field-input"
            >
              {models.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {provider.configured && (
              <Button
                variant="ghost"
                iconOnly
                onClick={refreshModels}
                aria-label={`Refresh ${provider.name} model list`}
                title="Refresh model list"
              >
                <RefreshCw size={20} aria-hidden="true" className={modelsLoading ? 'spinning' : undefined} />
              </Button>
            )}
          </div>
        </Field>

        {isActive ? (
          <p className="key-status ready">
            <CircleCheck size={18} aria-hidden="true" /> AbleSpeak is using this provider now.
          </p>
        ) : provider.configured ? (
          <Button variant="primary" block onClick={() => onSwitch(id, selectedModel)}>
            Switch to {provider.name}
          </Button>
        ) : (
          <p className="muted-note">Save a key above to use this provider.</p>
        )}
      </div>
    </Panel>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
