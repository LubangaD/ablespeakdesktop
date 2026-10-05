import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  TITLE, SECTION, LABEL, MUTED, BODY, PAGE, CARD, PRIMARY, QUIET, DANGER, ROW_ACTION, FIELD, DOT, INK,
} from '../lib/ui';

// Settings: the API keys saved on this computer, the language model AbleSpeak
// uses, and the gateway it talks to. Every value on the page comes from the
// gateway. Laid out in the dashboard's everyday style (src/lib/ui.js).

const INPUT = `${FIELD} focus:ring-0 [&::-ms-reveal]:hidden`;

// Example key shapes, shown as placeholders in empty key fields
const KEY_HINT = { openai: 'sk-...', anthropic: 'sk-ant-...', gemini: 'AIza...' };

// Saved / removed / error lines, as a short coloured line
const RESULT_TONE = { success: 'ok', warn: 'warn', error: 'bad' };

// Notices: a quiet strip with a coloured left edge
const NOTICE_EDGE = { warning: 'border-[#ffc880]', success: 'border-[#68d9c3]', error: 'border-[#ffb4ab]' };

/** A Material Symbols icon, hidden from screen readers. */
function Icon({ name, className = '', filled = false }) {
  return (
    <span
      className={`material-symbols-outlined ${className}`}
      style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

/** A quiet strip with a coloured left edge, for things worth knowing. */
function NoticeBox({ tone = 'warning', role, children }) {
  return (
    <div role={role} className={`rounded-lg bg-[#18202d] border-l-2 ${NOTICE_EDGE[tone]} px-4 py-3 text-[14px] leading-5 text-[#dae3f4]`}>
      {children}
    </div>
  );
}

/** A status: a small dot and a word. */
function Status({ tone, dot, children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] leading-5 whitespace-nowrap ${INK[tone]}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot || DOT[tone]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

function SectionHeading({ id, children, note }) {
  return (
    <div>
      <h2 id={id} className={SECTION}>{children}</h2>
      {note}
    </div>
  );
}

/** One row of a description list. */
function Row({ label, children, valueClass = '' }) {
  return (
    <div className="min-h-[44px] py-2 flex items-center justify-between gap-4">
      <dt className={MUTED}>{label}</dt>
      <dd className={`${BODY} ${valueClass} text-right min-w-0 break-all`}>{children}</dd>
    </div>
  );
}

/** A saved/removed/error message, read out when it changes. */
function ResultLine({ result }) {
  const tone = result ? RESULT_TONE[result.tone] || 'ok' : null;
  return (
    <p role="status" aria-live="polite" className={result ? `pt-3 text-[13px] leading-5 ${INK[tone]}` : ''}>
      {result && result.text}
    </p>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const { data: status, isError: statusFailed, error: statusError } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 3000 });
  const { data: aiStatus } = useQuery({ queryKey: ['aiStatus'], queryFn: api.getAiStatus, refetchInterval: 5000 });
  const { data: providers, isLoading: providersLoading, isError: providersFailed, error: providersError } = useQuery({ queryKey: ['aiProviders'], queryFn: api.getAiProviders });
  const [notice, setNotice] = useState(null); // { tone: 'success' | 'error', text }
  const [switching, setSwitching] = useState(null); // provider id being switched to
  const [focusProvider, setFocusProvider] = useState(null); // card to focus once it shows as in use

  const refreshAi = () => {
    queryClient.invalidateQueries({ queryKey: ['aiStatus'] });
    queryClient.invalidateQueries({ queryKey: ['aiProviders'] });
    queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
  };

  const switchProvider = async (provider, model) => {
    setNotice(null);
    setSwitching(provider);
    try {
      const result = await api.useProvider(provider, model);
      setNotice({ tone: result.saved ? 'success' : 'error', text: result.message });
      setFocusProvider(provider);
      refreshAi();
    } catch (err) {
      setNotice({ tone: 'error', text: err.message });
    } finally {
      setSwitching(null);
    }
  };

  // In use first, then the ones ready to switch to, then the ones missing a key
  const rank = p => (p.active ? 0 : p.configured ? 1 : 2);
  const providerList = providers
    ? Object.entries(providers).map(([id, p]) => ({ id, ...p })).sort((a, b) => rank(a) - rank(b))
    : [];

  return (
    <div className={PAGE}>
      <div className="max-w-[1100px] flex flex-col gap-8">
        {/* Page header */}
        <header>
          <h1 className={TITLE}>Settings</h1>
          <p className={`${MUTED} text-[14px] mt-1`}>Keys and the language model AbleSpeak uses on this computer.</p>
        </header>

        <SharedComputerSection />

        <HelperPinSection />

        <AdminAccountSection />

        <ApiKeysSection onChanged={refreshAi} />

        {/* Language model */}
        <section aria-labelledby="language-model-heading" className="flex flex-col gap-4">
          <SectionHeading id="language-model-heading">Language model</SectionHeading>

          {aiStatus && <CurrentProvider aiStatus={aiStatus} />}

          <div className="flex flex-col gap-4">
            <div role="status" aria-live="polite">
              {notice && (
                <p className={`text-[13px] leading-5 ${notice.tone === 'success' ? INK.ok : INK.bad}`}>{notice.text}</p>
              )}
            </div>

            {providersLoading && <p className={MUTED}>Loading providers…</p>}
            {providersFailed && (
              <p role="alert" className={`text-[13px] leading-5 ${INK.bad}`}>
                Couldn't load the language model providers: {providersError.message}
              </p>
            )}

            {providerList.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {providerList.map((provider, index) => (
                  <ProviderCard
                    key={provider.id}
                    id={provider.id}
                    provider={provider}
                    currentModel={provider.active ? aiStatus?.model : null}
                    onSwitch={switchProvider}
                    switching={switching}
                    shouldFocus={focusProvider === provider.id}
                    onFocused={() => setFocusProvider(null)}
                    wide={providerList.length % 2 === 1 && index === providerList.length - 1}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* AbleSpeak gateway */}
        <section aria-labelledby="gateway-heading" className="flex flex-col gap-4">
          <SectionHeading id="gateway-heading">AbleSpeak gateway</SectionHeading>
          <div className={`${CARD} px-5 py-2`}>
            {status ? (
              <dl className="divide-y divide-white/[0.06]">
                <Row label="Agent version" valueClass="font-mono !text-[13px]">{status.version || 'Not reported'}</Row>
                <Row label="Mode">Standalone AI agent</Row>
                <Row label="Active prompt">
                  {status.activePrompt
                    ? <span className="font-mono text-[13px]">{status.activePrompt}</span>
                    : <span className={MUTED}>None</span>}
                </Row>
                <Row label="Extension clients"><Clients count={status.extensionClients} /></Row>
                <Row label="Dashboard clients"><Clients count={status.dashboardClients} /></Row>
              </dl>
            ) : statusFailed ? (
              <p className={`py-3 text-[13px] leading-5 ${INK.bad}`} role="alert">
                Couldn't reach the gateway: {statusError.message}
              </p>
            ) : (
              <p className={`${MUTED} py-3`}>Loading gateway details…</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** How many clients are connected: a dot (green when any) and the count. */
// Whether several learners use this computer. When on, nobody's profile
// opens from the Windows account and the last learner never carries over.
function SharedComputerSection() {
  const queryClient = useQueryClient();
  const { data, isError, error } = useQuery({ queryKey: ['sharedComputer'], queryFn: api.getSharedComputer });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const shared = !!data?.shared;

  const toggle = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api.setSharedComputer(!shared);
      await queryClient.invalidateQueries({ queryKey: ['sharedComputer'] });
      setResult({ tone: 'success', text: !shared
        ? 'Marked as shared. From the next start, nobody’s profile opens until a teacher signs a learner in.'
        : 'Marked as personal. The Windows account’s own profile opens again from the next start.' });
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="this-computer-heading" className="flex flex-col gap-4">
      <SectionHeading id="this-computer-heading">This computer</SectionHeading>
      <div className={`${CARD} p-5`}>
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p id="shared-computer-label" className={`${BODY} font-medium`}>Shared computer</p>
            <p id="shared-computer-help" className={`${MUTED} mt-0.5 max-w-[640px]`}>
              Turn on for lab or classroom computers that several learners use. Nobody’s profile opens by itself:
              a teacher signs each learner in, and the next person never sees the last one’s profile.
            </p>
            {data?.guestAccount && (
              <p className={`${MUTED} mt-2`}>This Windows account looks like a guest account, so AbleSpeak already treats it as shared.</p>
            )}
          </div>
          <button
            type="button" role="switch" aria-checked={shared}
            aria-labelledby="shared-computer-label" aria-describedby="shared-computer-help"
            onClick={toggle} disabled={busy || !data}
            className="shrink-0 min-h-[44px] inline-flex items-center gap-2 px-2 rounded-lg hover:bg-[#18202d] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className={`w-11 h-6 rounded-full p-0.5 flex items-center transition-colors ${shared ? 'bg-[#f5a623] justify-end' : 'bg-[#2d3543] justify-start'}`} aria-hidden="true">
              <span className={`w-5 h-5 rounded-full ${shared ? 'bg-[#3d2600]' : 'bg-[#c9b8a5]'}`} />
            </span>
            <span className={BODY}>{shared ? 'On' : 'Off'}</span>
          </button>
        </div>
        {isError && <p role="alert" className={`pt-3 text-[13px] leading-5 ${INK.bad}`}>Couldn’t read this setting: {error.message}</p>}
        <ResultLine result={result} />
      </div>
    </section>
  );
}

// On the admin's own computer: this Windows account opens every page without
// a PIN. Refused on shared computers and guest accounts (server/src/admin-account.js).
function AdminAccountSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['adminStatus'], queryFn: api.getAdminStatus });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const account = data?.adminAccount;
  const on = !!account?.on;

  const toggle = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api.setAdminAccount(!on);
      await queryClient.invalidateQueries({ queryKey: ['adminStatus'] });
      setResult({ tone: 'success', text: !on
        ? `Every page now opens without a PIN while “${account.account}” is signed in to Windows.`
        : 'The admin pages need the PIN again.' });
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (!account) return null;
  return (
    <section aria-labelledby="admin-account-heading" className="flex flex-col gap-4">
      <SectionHeading id="admin-account-heading">Admin account</SectionHeading>
      <div className={`${CARD} p-5`}>
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p id="admin-account-label" className={`${BODY} font-medium`}>
              Open every page without a PIN for “{account.account}”
            </p>
            <p id="admin-account-help" className={`${MUTED} mt-0.5 max-w-[640px]`}>
              For your own computer only. While this Windows account is signed in, the Helper and Admin pages are open
              and never ask for the PIN. Other websites in the browser still can’t reach them.
            </p>
            {account.blocked && <p className={`${MUTED} mt-2`}>{account.reason}</p>}
          </div>
          <button
            type="button" role="switch" aria-checked={on}
            aria-labelledby="admin-account-label" aria-describedby="admin-account-help"
            onClick={toggle} disabled={busy || !!account.blocked}
            className="shrink-0 min-h-[44px] inline-flex items-center gap-2 px-2 rounded-lg hover:bg-[#18202d] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className={`w-11 h-6 rounded-full p-0.5 flex items-center transition-colors ${on ? 'bg-[#f5a623] justify-end' : 'bg-[#2d3543] justify-start'}`} aria-hidden="true">
              <span className={`w-5 h-5 rounded-full ${on ? 'bg-[#3d2600]' : 'bg-[#c9b8a5]'}`} />
            </span>
            <span className={BODY}>{on ? 'On' : 'Off'}</span>
          </button>
        </div>
        <ResultLine result={result} />
      </div>
    </section>
  );
}

// The lower PIN for a teacher or helper who only needs the Users page
// (people, goals, progress), not keys, logs or the Developer Hub.
function HelperPinSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['adminStatus'], queryFn: api.getAdminStatus });
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const isSet = !!data?.helperPinSet;

  const save = async (value) => {
    setBusy(true);
    setResult(null);
    try {
      await api.setHelperPin(value);
      setPin('');
      await queryClient.invalidateQueries({ queryKey: ['adminStatus'] });
      setResult({ tone: 'success', text: value ? 'Helper PIN saved. It opens only the Users page.' : 'Helper PIN removed.' });
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) return setResult({ tone: 'error', text: 'The PIN must be 4 to 8 digits.' });
    save(pin);
  };

  return (
    <section aria-labelledby="helper-pin-heading" className="flex flex-col gap-4">
      <SectionHeading id="helper-pin-heading">Helper PIN</SectionHeading>
      <div className={`${CARD} p-5 flex flex-col gap-4`}>
        <div className="flex items-start justify-between gap-6">
          <p id="helper-pin-help" className={`${MUTED} max-w-[640px]`}>
            A second PIN for a teacher or helper. It opens the Users page (people, goals and progress) and nothing
            else: not the keys, the logs, the Developer Hub or these settings.
          </p>
          {isSet ? <Status tone="ok">Set</Status> : <Status tone="idle">Not set</Status>}
        </div>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label className={`${LABEL} flex flex-col gap-1.5`}>
            {isSet ? 'New helper PIN' : 'Helper PIN'}
            <input
              type="password" inputMode="numeric" autoComplete="new-password" maxLength={8}
              aria-describedby="helper-pin-help"
              value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              className={`${INPUT} w-[180px]`}
            />
          </label>
          <button type="submit" disabled={busy || !pin} className={PRIMARY}>{isSet ? 'Change' : 'Save'}</button>
          {isSet && (
            <button type="button" disabled={busy} onClick={() => save(null)} className={DANGER}>Remove</button>
          )}
        </form>
        <ResultLine result={result} />
      </div>
    </section>
  );
}

function Clients({ count = 0 }) {
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      <span className={`w-1.5 h-1.5 rounded-full ${count > 0 ? DOT.ok : DOT.idle}`} aria-hidden="true" />
      <span>{count}</span>
    </span>
  );
}

function CurrentProvider({ aiStatus }) {
  const historyLength = aiStatus.historyLength ?? 0;
  return (
    <div className={`${CARD} p-5 flex flex-col gap-2`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className={SECTION}>Current provider</h3>
          <p className={MUTED}>{aiStatus.configured ? 'Language model ready' : 'Needs an API key'}</p>
        </div>
        {aiStatus.configured
          ? <Status tone="ok">Active</Status>
          : <Status tone="bad">No API key</Status>}
      </div>
      <dl className="divide-y divide-white/[0.06]">
        <Row label="Provider">{aiStatus.providerName}</Row>
        <Row label="Model"><span className="font-mono text-[13px]">{aiStatus.model}</span></Row>
        <Row label="Temperature"><span className="font-mono text-[13px]">{String(aiStatus.temperature)}</span></Row>
        <Row label="Conversation history" valueClass="tabular-nums">
          {historyLength} {historyLength === 1 ? 'message' : 'messages'}
        </Row>
      </dl>
    </div>
  );
}

function ApiKeysSection({ onChanged }) {
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['apiKeys'], queryFn: api.getApiKeys });
  const count = data?.providers?.length ?? 0;
  const voiceName = data?.providers?.find(p => p.usedForVoice)?.name || 'Google Gemini';

  return (
    <section aria-labelledby="api-keys-heading" className="flex flex-col gap-4">
      <SectionHeading
        id="api-keys-heading"
        note={(
          <p className={`${MUTED} mt-0.5`}>
            Keys stay on this computer and work as soon as they are saved — no restart needed.
            {data?.envPath && (
              <span className="block mt-0.5">
                They are saved in{' '}
                <code className="font-mono text-[12px] text-[#dae3f4] [overflow-wrap:anywhere]" data-private>{data.envPath}</code>.
              </span>
            )}
          </p>
        )}
      >
        API keys
      </SectionHeading>

      {isLoading && <p className={MUTED}>Loading keys…</p>}
      {isError && (
        <p role="alert" className={`text-[13px] leading-5 ${INK.bad}`}>Couldn't load the API keys: {error.message}</p>
      )}
      {data && (
        <NoticeBox tone={data.voiceReady ? 'success' : 'warning'} role="status">
          <span className="font-medium">Voice engine requirement:</span>{' '}
          Voice needs a {voiceName} key. Until one is saved, AbleSpeak can't hear anything.
          <span className={`${MUTED} block mt-0.5`}>
            {data.voiceReady
              ? `A ${voiceName} key is saved on this computer, so AbleSpeak can hear.`
              : `No ${voiceName} key is saved yet. Add one below to turn voice on.`}
          </span>
        </NoticeBox>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {data.providers.map((provider, index) => (
            <ApiKeyCard
              key={provider.id}
              provider={provider}
              onChanged={onChanged}
              wide={count % 2 === 1 && index === count - 1}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function KeyBadge({ provider }) {
  if (provider.configured) return <Status tone="ok">Saved</Status>;
  if (provider.usedForVoice) return <Status tone="warn">Needed</Status>;
  return <Status tone="idle">Not set</Status>;
}

function ApiKeyCard({ provider, onChanged, wide }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(null); // 'save' | 'remove' | null
  const [result, setResult] = useState(null); // { tone: 'success' | 'warn' | 'error', text }
  const [confirmRemove, setConfirmRemove] = useState(false);
  const keyRef = useRef(null);
  const removeRef = useRef(null);
  const keepRef = useRef(null);
  const focusAfter = useRef(null);
  const fieldId = `api-key-${provider.id}`;
  const titleId = `${fieldId}-title`;
  const maskedTail = (provider.masked || '').replace(/^•+/, '');
  // A saved key has nothing to save until a new one is typed; an empty card's
  // Save key stays ready and says what's missing when pressed.
  const saveOff = Boolean(busy) || (provider.configured && !key.trim());

  // Asking "remove?" puts focus on the safe answer; "Keep it" puts it back on Remove.
  useEffect(() => {
    if (confirmRemove) keepRef.current?.focus();
    else if (focusAfter.current) {
      focusAfter.current.current?.focus();
      focusAfter.current = null;
    }
  }, [confirmRemove]);

  const apply = (data) => {
    queryClient.setQueryData(['apiKeys'], data);
    onChanged();
  };

  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!key.trim()) {
      setResult({ tone: 'error', text: `Paste your ${provider.name} key first.` });
      keyRef.current?.focus();
      return;
    }
    setBusy('save');
    setResult(null);
    setConfirmRemove(false);
    try {
      const body = { key: key.trim() };
      const data = await api.saveApiKey(provider.id, body);
      setKey('');
      setResult({ tone: data.verified === null ? 'warn' : 'success', text: data.message });
      apply(data);
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    setResult(null);
    try {
      const data = await api.removeApiKey(provider.id);
      setConfirmRemove(false);
      setResult({ tone: 'warn', text: data.message });
      apply(data);
      keyRef.current?.focus();
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const keep = () => {
    focusAfter.current = removeRef;
    setConfirmRemove(false);
  };

  const clearKey = () => {
    setKey('');
    keyRef.current?.focus();
  };

  const keyInput = (
    <div className="relative">
      <input
        ref={keyRef}
        id={fieldId}
        type="password"
        value={key}
        onChange={e => setKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder={provider.configured ? `Enter new ${provider.name} key to replace...` : KEY_HINT[provider.id] || `Enter your ${provider.name} key...`}
        className={`${INPUT} pr-12`}
      />
      {key && (
        <button
          type="button"
          onClick={clearKey}
          aria-label={`Clear the ${provider.name} key field`}
          className="absolute right-1 top-1/2 -translate-y-1/2 size-9 flex items-center justify-center text-[#c9b8a5] hover:text-[#dae3f4] rounded-md hover:bg-[#222a37] transition-colors"
        >
          <Icon name="close" className="text-[18px]" />
        </button>
      )}
    </div>
  );
  const keyLabel = provider.configured ? 'Replace the key' : 'API key';
  // The amber button only once there is something to save
  const saveClass = key.trim() ? PRIMARY : QUIET;

  return (
    <form
      onSubmit={save}
      aria-labelledby={titleId}
      noValidate
      className={`${CARD} p-5 flex flex-col justify-between gap-4${wide ? ' lg:col-span-2' : ''}`}
    >
      <div className="flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <h3 id={titleId} className={SECTION}>{provider.name}</h3>
          <KeyBadge provider={provider} />
        </div>

        {/* What this key is for */}
        <div className="flex flex-col gap-1">
          {provider.configured && maskedTail && (
            <p className={MUTED}>
              Saved key ends{' '}
              <span className="font-mono text-[13px] text-[#dae3f4]">
                <span aria-hidden="true">····</span><span data-private>{maskedTail}</span>
              </span>
            </p>
          )}
          {provider.usedForVoice ? (
            <p className={`${MUTED} flex items-center gap-1.5`}>
              <Icon name="mic" className="text-[16px]" />
              <span>Used for voice, whichever language model you choose</span>
            </p>
          ) : (
            <p className={MUTED}>Optional. AbleSpeak can use {provider.name} as its language model.</p>
          )}
        </div>

        {/* Key field */}
        <div className={`flex flex-col gap-1.5${wide ? ' max-w-xl' : ''}`}>
          <label className={LABEL} htmlFor={fieldId}>{keyLabel}</label>
          {keyInput}
        </div>
      </div>

      {/* Actions: Save key, Remove (saved keys only), Get a key */}
      <div>
        <div className="pt-4 border-t border-white/[0.06] flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="submit" className={saveClass} disabled={saveOff}>
              <span>{busy === 'save' ? 'Checking…' : 'Save key'}</span>
            </button>
            {provider.configured && !confirmRemove && (
              <button
                ref={removeRef}
                type="button"
                onClick={() => setConfirmRemove(true)}
                disabled={Boolean(busy)}
                className={QUIET}
              >
                <span>Remove</span>
              </button>
            )}
            {provider.configured && confirmRemove && (
              <>
                <button type="button" onClick={remove} disabled={Boolean(busy)} className={DANGER}>
                  <span>{busy === 'remove' ? 'Removing…' : `Remove ${provider.name} key`}</span>
                </button>
                <button ref={keepRef} type="button" onClick={keep} disabled={Boolean(busy)} className={QUIET}>
                  <span>Keep it</span>
                </button>
              </>
            )}
          </div>
          {provider.keyPage && (
            <a
              href={provider.keyPage}
              target="_blank"
              rel="noreferrer"
              className={`${ROW_ACTION} !text-[#ffc880] hover:underline`}
            >
              <span>Get a key</span>
              <Icon name="open_in_new" className="text-[16px]" />
              <span className="sr-only">(opens in your browser)</span>
            </a>
          )}
        </div>
        <ResultLine result={result} />
      </div>
    </form>
  );
}

function ProviderCard({ id, provider, currentModel, onSwitch, switching, shouldFocus, onFocused, wide }) {
  const queryClient = useQueryClient();
  const isActive = Boolean(provider.active);
  const ready = Boolean(provider.configured);
  const [selectedModel, setSelectedModel] = useState(isActive && currentModel ? currentModel : provider.defaultModel);
  const [refreshing, setRefreshing] = useState(false);
  const cardRef = useRef(null);
  const titleId = `provider-${id}-title`;
  const selectId = `model-${id}`;

  // LIVE model list from the provider's API (falls back to the static list)
  const { data: liveModels, isFetching: modelsLoading } = useQuery({
    queryKey: ['models', id],
    queryFn: () => fetch(`/api/ai/models?provider=${id}`).then(r => r.json()),
    enabled: ready,
    staleTime: 5 * 60 * 1000,
  });
  const liveList = liveModels?.models?.length ? liveModels.models : null;
  const models = liveList || provider.models || [];
  // The model in use is always offered, even if the list doesn't name it
  const options = isActive && currentModel && !models.includes(currentModel) ? [currentModel, ...models] : models;
  const optionsKey = options.join('\n');

  // The in-use card starts on the model AbleSpeak is using now
  useEffect(() => {
    if (isActive && currentModel) setSelectedModel(currentModel);
  }, [isActive, currentModel]);

  // Keep the selection valid when the live list arrives
  useEffect(() => {
    if (options.length) setSelectedModel(m => (options.includes(m) ? m : options[0]));
  }, [optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a switch, move focus to the card now in use (its Switch button is gone)
  useEffect(() => {
    if (shouldFocus && isActive) {
      cardRef.current?.focus();
      onFocused();
    }
  }, [shouldFocus, isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshModels = async () => {
    setRefreshing(true);
    try {
      await fetch(`/api/ai/models?provider=${id}&refresh=1`);
    } catch { /* the list below stays as it was */ }
    await queryClient.invalidateQueries({ queryKey: ['models', id] });
    setRefreshing(false);
  };

  const modelChanged = Boolean(isActive && currentModel && selectedModel !== currentModel);

  let badge;
  if (isActive) badge = <Status tone="warn" dot="bg-[#f5a623]">In use</Status>;
  else if (!ready) badge = <Status tone="idle">Unconfigured</Status>;
  else badge = <Status tone="ok">Ready</Status>;

  return (
    <article
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={`bg-[#141c28] rounded-xl border p-5 flex flex-col justify-between gap-4 focus:outline-none ${
        isActive ? 'border-[#f5a623]/60' : 'border-white/[0.06]'
      }${wide ? ' lg:col-span-2' : ''}`}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 id={titleId} className={SECTION}>{provider.name}</h3>
          {badge}
        </div>

        {/* Key status line */}
        {ready ? (
          <p className={MUTED}>API key saved</p>
        ) : (
          <p className={`text-[13px] leading-5 ${INK.bad}`}>Add a key under API keys above</p>
        )}

        {/* Model select + refresh */}
        <div className={`flex flex-col gap-1.5${wide ? ' max-w-xl' : ''}`}>
          <label className={`${LABEL}${ready ? '' : ' opacity-60'}`} htmlFor={selectId}>
            Model
          </label>
          <div className="flex items-center gap-2">
            <select
              id={selectId}
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              disabled={!ready}
              className={`${FIELD} focus:ring-0 flex-1 min-w-0 pr-10 ${ready ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
            >
              {options.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={refreshModels}
              disabled={!ready || refreshing}
              aria-label={`Refresh the ${provider.name} model list`}
              title="Refresh model list"
              className={`${QUIET} !px-0 w-11 shrink-0`}
            >
              <Icon name="refresh" className={`text-[20px]${refreshing || modelsLoading ? ' animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Bottom: in use, switch, or what's missing */}
      <div className="pt-4 border-t border-white/[0.06] flex flex-col gap-3">
        {isActive ? (
          <>
            <p className={`text-[13px] leading-5 ${INK.warn}`}>AbleSpeak is using this provider now.</p>
            {modelChanged && (
              <button type="button" onClick={() => onSwitch(id, selectedModel)} disabled={Boolean(switching)} className={`${PRIMARY} w-full`}>
                <span>{switching === id ? 'Switching…' : `Switch to ${selectedModel}`}</span>
              </button>
            )}
          </>
        ) : ready ? (
          <button type="button" onClick={() => onSwitch(id, selectedModel)} disabled={Boolean(switching)} className={`${QUIET} w-full`}>
            <span>{switching === id ? 'Switching…' : `Switch to ${provider.name}`}</span>
          </button>
        ) : (
          <p className={MUTED}>Save a key above to use this provider.</p>
        )}
      </div>
    </article>
  );
}
