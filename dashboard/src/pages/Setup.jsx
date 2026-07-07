import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, XCircle, AlertCircle, Mic, Globe, Users, Key, Settings2, ChevronDown, ChevronUp } from 'lucide-react';

// ── Fetch helpers ──
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
function post(url, body) {
  return fetchJson(url, { method: 'POST', body: JSON.stringify(body) });
}

// ── Status badge ──
function Badge({ ok, label }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
      background: ok ? 'rgba(6,214,160,0.12)' : 'rgba(248,113,113,0.12)',
      color: ok ? 'var(--success, #06d6a0)' : 'var(--error, #f87171)',
      border: `1px solid ${ok ? 'rgba(6,214,160,0.3)' : 'rgba(248,113,113,0.3)'}`,
    }}>
      {ok ? <CheckCircle size={12} aria-hidden="true" /> : <XCircle size={12} aria-hidden="true" />}
      {label}
    </span>
  );
}

// ── Step wrapper ──
function Step({ num, title, icon: Icon, children, open, onToggle }) {
  const headingId = `step-${num}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        marginBottom: 16,
        background: 'rgba(255,255,255,0.02)',
        overflow: 'hidden',
      }}
    >
      <button
        id={headingId}
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12,
          padding: '16px 20px', background: 'none', border: 'none',
          cursor: 'pointer', color: 'inherit', textAlign: 'left',
          minHeight: 56, /* ≥44px touch target */
        }}
      >
        <span style={{
          width: 28, height: 28, borderRadius: '50%', display: 'flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          background: 'rgba(167,139,250,0.15)', color: '#a78bfa', fontSize: 13, fontWeight: 700,
        }}>{num}</span>
        <Icon size={18} aria-hidden="true" style={{ flexShrink: 0, color: '#a78bfa' }} />
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, flex: 1 }}>{title}</h3>
        {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      </button>
      {open && (
        <div style={{ padding: '4px 20px 20px' }} role="region" aria-label={title}>
          {children}
        </div>
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════
// ── Step 1: AI Key ──
// ═══════════════════════════════════════════════
function StepAIKey({ status, onRefreshStatus }) {
  const [provider, setProvider] = useState('gemini');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  async function handleSave(e) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setSaving(true); setResult(null);
    try {
      await post('/api/setup/keys', { provider, apiKey });
      setResult({ ok: true, msg: 'Key saved and provider switched.' });
      setApiKey('');
      onRefreshStatus();
    } catch (err) {
      setResult({ ok: false, msg: err.message });
    } finally { setSaving(false); }
  }

  async function handleTest() {
    setTesting(true); setTestResult(null);
    try {
      const r = await post('/api/ai/chat', { text: 'say ok' });
      setTestResult({ ok: !r.error, msg: r.error ? (r.text || 'Failed') : (r.text || 'Pass') });
    } catch (err) {
      setTestResult({ ok: false, msg: err.message });
    } finally { setTesting(false); }
  }

  const providers = [
    { value: 'openai', label: 'OpenAI (GPT-4)' },
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'anthropic', label: 'Anthropic Claude' },
    { value: 'groq', label: 'Groq' },
    { value: 'azure', label: 'Azure OpenAI' },
    { value: 'ollama', label: 'Ollama (Local — no key)' },
  ];

  return (
    <div>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>
        Current status: <Badge ok={status?.keyConfigured} label={status?.keyConfigured ? 'Key configured' : 'No key'} />
      </p>
      <form onSubmit={handleSave} aria-label="AI provider key form" noValidate>
        <div style={{ marginBottom: 14 }}>
          <label htmlFor="ai-provider" style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
            AI Provider
          </label>
          <select
            id="ai-provider"
            value={provider}
            onChange={e => setProvider(e.target.value)}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, minHeight: 44, background: 'rgba(255,255,255,0.06)', color: 'inherit', border: '1px solid rgba(255,255,255,0.12)', fontSize: 14 }}
          >
            {providers.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label htmlFor="ai-key" style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
            API Key {provider === 'ollama' ? '(not required for Ollama)' : ''}
          </label>
          <input
            id="ai-key"
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={provider === 'ollama' ? 'No key needed' : 'Paste your API key here'}
            disabled={provider === 'ollama'}
            autoComplete="new-password"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, minHeight: 44, background: 'rgba(255,255,255,0.06)', color: 'inherit', border: '1px solid rgba(255,255,255,0.12)', fontSize: 14, boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="submit"
            disabled={saving || (!apiKey.trim() && provider !== 'ollama')}
            style={{ padding: '10px 22px', borderRadius: 8, minHeight: 44, background: '#a78bfa', color: '#0a0e1a', border: 'none', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
          >
            {saving ? 'Saving…' : 'Save Key'}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || !status?.keyConfigured}
            style={{ padding: '10px 22px', borderRadius: 8, minHeight: 44, background: 'rgba(255,255,255,0.08)', color: 'inherit', border: '1px solid rgba(255,255,255,0.12)', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}
          >
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
        {result && (
          <div role="alert" style={{ marginTop: 12, color: result.ok ? 'var(--success, #06d6a0)' : 'var(--error, #f87171)', fontSize: 13 }}>
            {result.ok ? '✓ ' : '✗ '}{result.msg}
          </div>
        )}
        {testResult && (
          <div role="status" style={{ marginTop: 8, color: testResult.ok ? 'var(--success, #06d6a0)' : 'var(--error, #f87171)', fontSize: 13 }}>
            Test: {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
          </div>
        )}
      </form>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── Step 2: Chrome Extension ──
// ═══════════════════════════════════════════════
function StepExtension({ status }) {
  const extensionFolder = typeof window !== 'undefined'
    ? window.location.origin.replace(':3001', '') + '/../chrome-integration-master'
    : 'C:\\…\\ablespeakdesktop\\chrome-integration-master';

  return (
    <div>
      <p style={{ marginBottom: 12, color: 'var(--text-muted)', fontSize: 14 }}>
        Status: <Badge ok={status?.extensionConnected} label={status?.extensionConnected ? 'Connected' : 'Not connected'} />
        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>(auto-updates every 3 s)</span>
      </p>
      <p style={{ fontSize: 14, marginBottom: 10 }}>To install the Chrome extension manually:</p>
      <ol style={{ paddingLeft: 20, fontSize: 14, lineHeight: 1.8, color: 'var(--text-muted)' }}>
        <li>Open Chrome/Brave and go to <code>chrome://extensions</code></li>
        <li>Enable <strong>Developer mode</strong> (top-right toggle)</li>
        <li>Click <strong>Load unpacked</strong></li>
        <li>Select the folder: <code style={{ fontSize: 12, background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 4 }}>chrome-integration-master</code></li>
        <li>Click the extension icon in the toolbar to connect</li>
      </ol>
      {status?.extensionConnected && (
        <div role="status" style={{ marginTop: 12, color: 'var(--success, #06d6a0)', fontSize: 14, fontWeight: 600 }}>
          ✓ Extension is live and receiving commands
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── Step 3: Students ──
// ═══════════════════════════════════════════════
function StepStudents({ status, onRefreshStatus }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState([]);
  const queryClient = useQueryClient();

  async function handleAdd(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true); setError('');
    try {
      const s = await post('/api/students', { display_name: name.trim() });
      setAdded(prev => [...prev, s.display_name]);
      setName('');
      onRefreshStatus();
      queryClient.invalidateQueries(['students']);
    } catch (err) {
      setError(err.message);
    } finally { setSaving(false); }
  }

  return (
    <div>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>
        Students in roster: <strong>{status?.studentCount ?? '…'}</strong>
        {' '}· <a href="/settings" style={{ color: '#a78bfa' }}>Manage full roster in Settings</a>
      </p>
      <form onSubmit={handleAdd} aria-label="Add student form" noValidate style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label htmlFor="student-name" style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600 }}>
            Student name
          </label>
          <input
            id="student-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Alex"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, minHeight: 44, background: 'rgba(255,255,255,0.06)', color: 'inherit', border: '1px solid rgba(255,255,255,0.12)', fontSize: 14, boxSizing: 'border-box' }}
          />
        </div>
        <button
          type="submit"
          disabled={saving || !name.trim()}
          style={{ alignSelf: 'flex-end', padding: '10px 22px', borderRadius: 8, minHeight: 44, background: '#a78bfa', color: '#0a0e1a', border: 'none', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
        >
          {saving ? 'Adding…' : 'Add Student'}
        </button>
      </form>
      {error && <div role="alert" style={{ marginTop: 8, color: 'var(--error, #f87171)', fontSize: 13 }}>{error}</div>}
      {added.length > 0 && (
        <div role="status" style={{ marginTop: 10, fontSize: 13, color: 'var(--success, #06d6a0)' }}>
          ✓ Added: {added.join(', ')}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── Step 4: Microphone Test ──
// ═══════════════════════════════════════════════
function StepMic({ status, onRefreshStatus }) {
  const [recording, setRecording] = useState(false);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState('');
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  async function handleRecord() {
    if (recording) return;
    setHeard(''); setError('');
    setRecording(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = reader.result.split(',')[1];
          try {
            const r = await post('/api/voice/transcribe', { audio: base64, mimeType: 'audio/webm' });
            setHeard(r.text || '(nothing heard)');
            if (r.text) {
              await fetch('/api/setup/mic-tested', { method: 'POST' });
              onRefreshStatus();
            }
          } catch (err) {
            setError('Transcription failed: ' + err.message);
          } finally { setRecording(false); }
        };
        reader.readAsDataURL(blob);
      };
      recRef.current = recorder;
      recorder.start();
      // Auto-stop after 2 seconds
      setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 2000);
    } catch (err) {
      setError('Mic error: ' + err.message);
      setRecording(false);
    }
  }

  return (
    <div>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>
        Press the button and speak for 2 seconds to verify your microphone works.
        {status?.micTestedThisSession && (
          <> &nbsp;<Badge ok label="Tested this session" /></>
        )}
      </p>
      <button
        type="button"
        onClick={handleRecord}
        disabled={recording}
        aria-label={recording ? 'Recording — please speak' : 'Start 2-second microphone test'}
        style={{
          padding: '12px 28px', borderRadius: 8, minHeight: 48,
          background: recording ? 'rgba(248,113,113,0.2)' : 'rgba(110,231,183,0.15)',
          color: recording ? '#f87171' : '#6ee7b7',
          border: `1px solid ${recording ? 'rgba(248,113,113,0.4)' : 'rgba(110,231,183,0.4)'}`,
          fontWeight: 700, cursor: recording ? 'not-allowed' : 'pointer', fontSize: 15,
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <Mic size={18} aria-hidden="true" />
        {recording ? 'Recording…' : 'Test Microphone (2 s)'}
      </button>
      {heard && (
        <div role="status" style={{ marginTop: 14, fontSize: 16, fontWeight: 600, color: '#ffffff' }}>
          Heard: &ldquo;{heard}&rdquo;
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: 10, color: 'var(--error, #f87171)', fontSize: 13 }}>{error}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── Step 5: Startup & Wake Word ──
// ═══════════════════════════════════════════════
function StepStartup({ status, onRefreshStatus }) {
  const [autoStart, setAutoStart] = useState(!!status?.autoStart);
  const [wakeWord, setWakeWord] = useState(status?.wakeWordEnabled !== false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  // Sync when status loads
  useEffect(() => {
    if (status) {
      setAutoStart(!!status.autoStart);
      setWakeWord(status.wakeWordEnabled !== false);
    }
  }, [status?.autoStart, status?.wakeWordEnabled]);

  async function handleSave() {
    setSaving(true); setResult(null);
    try {
      const r = await post('/api/setup/app-settings', { autoStart, wakeWordEnabled: wakeWord });
      setResult({ ok: true, msg: `Saved. Auto-start: ${autoStart ? 'ON' : 'OFF'}, Wake word: ${wakeWord ? 'ON' : 'OFF'}` + (!r.autoStartApplied ? ` (registry: ${r.autoStartReason || 'not in Electron'})` : '') });
      onRefreshStatus();
    } catch (err) {
      setResult({ ok: false, msg: err.message });
    } finally { setSaving(false); }
  }

  const toggleStyle = (on) => ({
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
    background: on ? 'rgba(110,231,183,0.08)' : 'rgba(255,255,255,0.04)',
    border: `1px solid ${on ? 'rgba(110,231,183,0.25)' : 'rgba(255,255,255,0.08)'}`,
    marginBottom: 12, minHeight: 60,
  });

  return (
    <div>
      <div
        role="switch"
        aria-checked={autoStart}
        tabIndex={0}
        onClick={() => setAutoStart(v => !v)}
        onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && setAutoStart(v => !v)}
        style={toggleStyle(autoStart)}
        aria-label={`Auto-start on login: ${autoStart ? 'on' : 'off'}`}
      >
        <span style={{ width: 40, height: 22, borderRadius: 11, background: autoStart ? '#6ee7b7' : 'rgba(255,255,255,0.15)', position: 'relative', flexShrink: 0, transition: 'background 0.2s' }}>
          <span style={{ position: 'absolute', top: 3, left: autoStart ? 20 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
        </span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Auto-start on login</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Launch AbleSpeak automatically when Windows starts</div>
        </div>
      </div>

      <div
        role="switch"
        aria-checked={wakeWord}
        tabIndex={0}
        onClick={() => setWakeWord(v => !v)}
        onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && setWakeWord(v => !v)}
        style={toggleStyle(wakeWord)}
        aria-label={`Wake word: ${wakeWord ? 'on' : 'off'}`}
      >
        <span style={{ width: 40, height: 22, borderRadius: 11, background: wakeWord ? '#6ee7b7' : 'rgba(255,255,255,0.15)', position: 'relative', flexShrink: 0, transition: 'background 0.2s' }}>
          <span style={{ position: 'absolute', top: 3, left: wakeWord ? 20 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
        </span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Wake word (<em>hey able</em>)</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            ⚠ Audio is processed continuously while this is enabled. Disable for privacy when not in use.
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        style={{ padding: '10px 24px', borderRadius: 8, minHeight: 44, background: '#a78bfa', color: '#0a0e1a', border: 'none', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}
      >
        {saving ? 'Saving…' : 'Save Preferences'}
      </button>
      {result && (
        <div role="status" style={{ marginTop: 10, fontSize: 13, color: result.ok ? 'var(--success, #06d6a0)' : 'var(--error, #f87171)' }}>
          {result.ok ? '✓ ' : '✗ '}{result.msg}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// ── Main Setup Page ──
// ═══════════════════════════════════════════════
export default function Setup() {
  const queryClient = useQueryClient();
  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ['setupStatus'],
    queryFn: () => fetchJson('/api/setup/status'),
    refetchInterval: 3000,
  });

  const [openStep, setOpenStep] = useState(1);
  const [finishing, setFinishing] = useState(false);
  const [finished, setFinished] = useState(false);

  function toggleStep(n) {
    setOpenStep(s => s === n ? null : n);
  }

  async function handleFinish() {
    setFinishing(true);
    try {
      await post('/api/setup/app-settings', { setupComplete: true });
      setFinished(true);
      refetchStatus();
    } catch {}
    setFinishing(false);
  }

  const steps = [
    { num: 1, title: 'AI Provider Key', icon: Key },
    { num: 2, title: 'Chrome Extension', icon: Globe },
    { num: 3, title: 'Students', icon: Users },
    { num: 4, title: 'Microphone Test', icon: Mic },
    { num: 5, title: 'Startup & Wake Word', icon: Settings2 },
  ];

  const allDone = status?.keyConfigured && status?.extensionConnected &&
    status?.studentCount > 0 && status?.micTestedThisSession;

  return (
    <div>
      <header className="page-header">
        <h2 id="setup-main-heading">Setup Wizard</h2>
        <p style={{ color: 'var(--text-muted)' }}>
          One-time configuration — complete each step, then click Finish.
          {status?.setupComplete && (
            <> &nbsp;<Badge ok label="Setup complete" /></>
          )}
        </p>
      </header>

      {finished && (
        <div role="status" style={{ background: 'rgba(6,214,160,0.08)', border: '1px solid rgba(6,214,160,0.3)', borderRadius: 10, padding: 16, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--success, #06d6a0)', fontWeight: 600 }}>
          <CheckCircle size={20} aria-hidden="true" /> Setup complete! The student can now use AbleSpeak by voice alone.
        </div>
      )}

      <div style={{ maxWidth: 680 }}>
        <Step num={1} title="AI Provider Key" icon={Key} open={openStep === 1} onToggle={() => toggleStep(1)}>
          <StepAIKey status={status} onRefreshStatus={refetchStatus} />
        </Step>
        <Step num={2} title="Chrome Extension" icon={Globe} open={openStep === 2} onToggle={() => toggleStep(2)}>
          <StepExtension status={status} />
        </Step>
        <Step num={3} title="Students" icon={Users} open={openStep === 3} onToggle={() => toggleStep(3)}>
          <StepStudents status={status} onRefreshStatus={refetchStatus} />
        </Step>
        <Step num={4} title="Microphone Test" icon={Mic} open={openStep === 4} onToggle={() => toggleStep(4)}>
          <StepMic status={status} onRefreshStatus={refetchStatus} />
        </Step>
        <Step num={5} title="Startup & Wake Word" icon={Settings2} open={openStep === 5} onToggle={() => toggleStep(5)}>
          <StepStartup status={status} onRefreshStatus={refetchStatus} />
        </Step>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            type="button"
            onClick={handleFinish}
            disabled={finishing}
            aria-label="Finish setup and mark as complete"
            style={{
              padding: '12px 32px', borderRadius: 10, minHeight: 48,
              background: '#a78bfa', color: '#0a0e1a',
              border: 'none', fontWeight: 700, cursor: 'pointer', fontSize: 16,
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <CheckCircle size={18} aria-hidden="true" />
            {finishing ? 'Saving…' : 'Finish Setup'}
          </button>
        </div>
      </div>
    </div>
  );
}
