import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState, Fragment } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { Brain, Globe, Check, AlertCircle, Users, Upload, UserPlus, ToggleLeft, ToggleRight, Mic, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';

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

      {/* Students Roster */}
      <StudentsSection />

      {/* Classroom Sync */}
      <SyncSection />

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

function StudentsSection() {
  const queryClient = useQueryClient();
  const { data: students = [], isLoading } = useQuery({ queryKey: ['students'], queryFn: () => api.getStudents({ all: 1 }), staleTime: 5000 });
  const [newName, setNewName] = useState('');
  const [newRef, setNewRef] = useState('');
  const [addError, setAddError] = useState('');
  const [csvText, setCsvText] = useState('');
  const [csvResult, setCsvResult] = useState(null);
  const [csvError, setCsvError] = useState('');
  const [speechExpandedId, setSpeechExpandedId] = useState(null); // per-student Speech expander

  const addStudent = async (e) => {
    e.preventDefault();
    setAddError('');
    if (!newName.trim()) { setAddError('Name is required'); return; }
    try {
      await api.addStudent({ display_name: newName.trim(), external_ref: newRef.trim() || undefined });
      setNewName(''); setNewRef('');
      queryClient.invalidateQueries(['students']);
    } catch (err) { setAddError(err.message); }
  };

  const toggleActive = async (student) => {
    try {
      await api.updateStudent(student.id, { active: !student.active });
      queryClient.invalidateQueries(['students']);
    } catch {}
  };

  const toggleSyncOptIn = async (student) => {
    try {
      await api.updateStudent(student.id, { sync_opt_in: !student.sync_opt_in });
      queryClient.invalidateQueries(['students']);
    } catch {}
  };

  const importCsv = async () => {
    setCsvError(''); setCsvResult(null);
    try {
      const result = await api.importRosterCsv(csvText);
      setCsvResult(result);
      if (result.imported > 0) queryClient.invalidateQueries(['students']);
    } catch (err) { setCsvError(err.message); }
  };

  return (
    <section aria-label="Student roster" style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: '1rem', color: 'var(--text-muted)', marginBottom: 16, fontWeight: 600 }}>
        STUDENTS
      </h3>

      {/* Roster table */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Users size={20} style={{ color: 'var(--accent)' }} />
          <h4 style={{ fontWeight: 600, fontSize: '1rem' }}>Roster</h4>
        </div>
        {isLoading ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading...</p>
        ) : students.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No students yet. Add one below or import a CSV.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr>
                  {['Name', 'External Ref', 'Active', 'Sync', 'Speech'].map(h => (
                    <th key={h} scope="col" style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {students.map(s => (
                  <Fragment key={s.id}>
                    <tr>
                      <td style={{ padding: '8px 10px', color: 'var(--text-primary)' }}>{s.display_name}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{s.external_ref || '—'}</td>
                      <td style={{ padding: '8px 10px' }}>
                        <button
                          onClick={() => toggleActive(s)}
                          aria-label={s.active ? `Deactivate ${s.display_name}` : `Activate ${s.display_name}`}
                          title={s.active ? 'Active — click to deactivate' : 'Inactive — click to activate'}
                          style={{ minWidth: 44, minHeight: 44, background: 'none', border: 'none', cursor: 'pointer', color: s.active ? 'var(--success)' : 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                        >
                          {s.active ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                        </button>
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <button
                          onClick={() => toggleSyncOptIn(s)}
                          role="switch"
                          aria-checked={!!s.sync_opt_in}
                          aria-label={s.sync_opt_in ? `Stop syncing ${s.display_name}'s data to the teacher device` : `Sync ${s.display_name}'s data to the teacher device`}
                          title={s.sync_opt_in ? 'Syncing — click to keep this student\'s data on this device only' : 'Not syncing — this student\'s data stays on this device'}
                          style={{ minWidth: 44, minHeight: 44, background: 'none', border: 'none', cursor: 'pointer', color: s.sync_opt_in ? 'var(--success)' : 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                        >
                          {s.sync_opt_in ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                        </button>
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <button
                          onClick={() => setSpeechExpandedId(speechExpandedId === s.id ? null : s.id)}
                          aria-expanded={speechExpandedId === s.id}
                          aria-label={`${speechExpandedId === s.id ? 'Hide' : 'Show'} speech settings for ${s.display_name}`}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 44, minHeight: 44, padding: '0 10px', background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: speechExpandedId === s.id ? 'var(--accent)' : 'var(--text-muted)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}
                        >
                          <Mic size={16} /> Speech {speechExpandedId === s.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      </td>
                    </tr>
                    {speechExpandedId === s.id && (
                      <tr>
                        <td colSpan={5} style={{ padding: '4px 10px 14px' }}>
                          <SpeechProfileEditor student={s} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add student form */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <UserPlus size={18} style={{ color: 'var(--accent)' }} />
          <h4 style={{ fontWeight: 600, fontSize: '1rem' }}>Add Student</h4>
        </div>
        <form onSubmit={addStudent} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label htmlFor="student-name" style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
              Name <span aria-hidden="true">*</span>
            </label>
            <input
              id="student-name"
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="First Last"
              required
              style={{ width: '100%', padding: '10px 12px', minHeight: 44, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit' }}
            />
          </div>
          <div>
            <label htmlFor="student-ref" style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
              External Ref (optional)
            </label>
            <input
              id="student-ref"
              type="text"
              value={newRef}
              onChange={e => setNewRef(e.target.value)}
              placeholder="e.g. student ID"
              style={{ width: '100%', padding: '10px 12px', minHeight: 44, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit' }}
            />
          </div>
          {addError && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--error)', fontSize: 13 }}>
              <AlertCircle size={14} /> {addError}
            </div>
          )}
          <button
            type="submit"
            style={{ padding: '10px 16px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
          >
            Add Student
          </button>
        </form>
      </div>

      {/* CSV import */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Upload size={18} style={{ color: 'var(--accent)' }} />
          <h4 style={{ fontWeight: 600, fontSize: '1rem' }}>Import CSV Roster</h4>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label htmlFor="csv-input" style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
            CSV (header optional: display_name,external_ref)
          </label>
          <textarea
            id="csv-input"
            value={csvText}
            onChange={e => setCsvText(e.target.value)}
            rows={5}
            placeholder={"display_name,external_ref\nAlice Brown,EXT-001\nBob Smith,EXT-002"}
            style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </div>
        <button
          onClick={importCsv}
          disabled={!csvText.trim()}
          style={{ padding: '10px 16px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: 'none', background: csvText.trim() ? 'var(--accent)' : 'var(--bg-tertiary)', color: csvText.trim() ? '#fff' : 'var(--text-muted)', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: csvText.trim() ? 'pointer' : 'not-allowed' }}
        >
          Import
        </button>
        {csvError && (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--error)', fontSize: 13 }}>
            <AlertCircle size={14} /> {csvError}
          </div>
        )}
        {csvResult && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--success)', fontSize: 13, marginBottom: csvResult.errors.length ? 6 : 0 }}>
              <Check size={14} /> {csvResult.imported} student{csvResult.imported !== 1 ? 's' : ''} imported
            </div>
            {csvResult.errors.map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--error)', fontSize: 13 }}>
                <AlertCircle size={14} /> Line {e.line}: {e.reason}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Classroom sync (T4): teacher-hosted, local-first, opt-in ──
// SECURITY: the classroom key is write-only. GET /api/sync/status returns only
// `configured: true/false` — the key input below is never prefilled.

function SyncSection() {
  const { data: syncStatus, isLoading } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: api.getSyncStatus,
    refetchInterval: 5000,
  });

  return (
    <section aria-label="Classroom sync" style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: '1rem', color: 'var(--text-muted)', marginBottom: 16, fontWeight: 600 }}>
        CLASSROOM SYNC
      </h3>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <RefreshCw size={20} style={{ color: 'var(--accent)' }} />
          <h4 style={{ fontWeight: 600, fontSize: '1rem' }}>Share Progress With Teacher Device</h4>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Off by default. When sending, only students with the roster “Sync” toggle on are shared —
          everyone else's data never leaves this computer. Everything keeps working offline.
        </p>
        {isLoading || !syncStatus ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading sync status…</p>
        ) : (
          <SyncForm key={`${syncStatus.role}-${syncStatus.enabled}-${syncStatus.targetUrl}-${syncStatus.intervalMs}`} status={syncStatus} />
        )}
      </div>
    </section>
  );
}

function SyncForm({ status }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState(status.enabled ? status.role : 'off');
  const [targetUrl, setTargetUrl] = useState(status.targetUrl || '');
  const [classroomKey, setClassroomKey] = useState(''); // NEVER prefilled from the server
  const [intervalSec, setIntervalSec] = useState(Math.round((status.intervalMs || 30000) / 1000));
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');

  const save = async (e) => {
    e.preventDefault();
    setSaveMsg(''); setSaveErr('');
    if (role === 'sender' && !targetUrl.trim()) { setSaveErr('Teacher address is required to send'); return; }
    if (role !== 'off' && !status.configured && !classroomKey.trim()) { setSaveErr('Classroom key is required'); return; }
    try {
      const sync = {
        enabled: role !== 'off',
        role: role === 'off' ? (status.role || 'sender') : role,
        targetUrl: targetUrl.trim(),
        intervalMs: Math.max(5, Number(intervalSec) || 30) * 1000,
      };
      // Only send the key when the adult typed a new one — an empty field keeps the stored key
      if (classroomKey.trim()) sync.classroomKey = classroomKey.trim();
      await api.saveSyncSettings(sync);
      setClassroomKey(''); // clear the field after save — key is never displayed
      setSaveMsg('Sync settings saved');
      queryClient.invalidateQueries(['syncStatus']);
      setTimeout(() => setSaveMsg(''), 4000);
    } catch (err) {
      setSaveErr('Could not save sync settings');
    }
  };

  const inputStyle = { width: '100%', padding: '10px 12px', minHeight: 44, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit' };
  const labelStyle = { display: 'block', fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 };

  return (
    <form onSubmit={save} aria-label="Sync settings" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label htmlFor="sync-role" style={labelStyle}>Sync mode</label>
        <select id="sync-role" value={role} onChange={e => setRole(e.target.value)} style={inputStyle}>
          <option value="off">Off — keep all data on this computer</option>
          <option value="sender">Send to teacher — push this device's data</option>
          <option value="receiver">Receive as teacher — collect from student devices</option>
        </select>
      </div>

      {role === 'sender' && (
        <div>
          <label htmlFor="sync-target" style={labelStyle}>Teacher device address</label>
          <input
            id="sync-target" type="url" value={targetUrl}
            onChange={e => setTargetUrl(e.target.value)}
            placeholder="http://192.168.1.20:3001"
            style={inputStyle}
          />
        </div>
      )}

      {role !== 'off' && (
        <>
          <div>
            <label htmlFor="sync-key" style={labelStyle}>
              Classroom key {status.configured ? '(already set — leave blank to keep it)' : ''}
            </label>
            <input
              id="sync-key" type="password" value={classroomKey}
              onChange={e => setClassroomKey(e.target.value)}
              autoComplete="new-password"
              placeholder={status.configured ? '••••••••' : 'Shared phrase, same on every device'}
              style={inputStyle}
            />
          </div>
          {role === 'sender' && (
            <div>
              <label htmlFor="sync-interval" style={labelStyle}>Send every (seconds)</label>
              <input
                id="sync-interval" type="number" min={5} max={3600} value={intervalSec}
                onChange={e => setIntervalSec(e.target.value)}
                style={{ ...inputStyle, width: 140 }}
              />
            </div>
          )}
        </>
      )}

      {/* Live status line */}
      <p aria-live="polite" style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
        {!status.enabled && 'Sync is off — nothing leaves this computer.'}
        {status.enabled && status.role === 'sender' && (
          status.lastSyncAt
            ? `Last sent to teacher: ${new Date(status.lastSyncAt).toLocaleTimeString()}`
            : (status.lastSyncError ? 'Waiting to reach the teacher device — data is safe and will send when connected.' : 'Sending is on — waiting for the first sync.')
        )}
        {status.enabled && status.role === 'receiver' && (
          status.lastIngestAt
            ? `Last received: ${new Date(status.lastIngestAt).toLocaleTimeString()} — ${status.devicesSeen.length} device${status.devicesSeen.length !== 1 ? 's' : ''} connected`
            : 'Receiving is on — no student devices have sent data yet.'
        )}
      </p>

      {saveErr && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--error)', fontSize: 13 }}>
          <AlertCircle size={14} /> {saveErr}
        </div>
      )}
      {saveMsg && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--success)', fontSize: 13 }}>
          <Check size={14} /> {saveMsg}
        </div>
      )}

      <button
        type="submit"
        style={{ alignSelf: 'flex-start', padding: '10px 16px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
      >
        Save Sync Settings
      </button>
    </form>
  );
}

// ── Per-student speech tuning (thresholds + vocabulary) ──

function SpeechProfileEditor({ student }) {
  const queryClient = useQueryClient();
  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['speechProfile', student.id],
    queryFn: () => api.getSpeechProfile(student.id),
    staleTime: 5000,
  });

  if (isLoading) return <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading speech profile…</p>;
  if (error) return <p style={{ color: 'var(--error)', fontSize: 14 }}>Failed to load speech profile: {error.message}</p>;

  return (
    <SpeechProfileForm
      key={`${student.id}-${profile.updated_at || 'new'}`}
      student={student}
      profile={profile}
      onSaved={() => queryClient.invalidateQueries(['speechProfile', student.id])}
    />
  );
}

function SpeechProfileForm({ student, profile, onSaved }) {
  const [minAudio, setMinAudio] = useState(profile.min_audio_b64);
  const [minConf, setMinConf] = useState(profile.min_confidence);
  const [fuzzy, setFuzzy] = useState(profile.fuzzy_threshold);
  const [repairEnabled, setRepairEnabled] = useState(!!profile.repair_enabled);
  const [vocab, setVocab] = useState((profile.custom_vocabulary || []).join('\n'));
  const [saveMsg, setSaveMsg] = useState('');
  const [saveErr, setSaveErr] = useState('');

  const save = async (e) => {
    e.preventDefault();
    setSaveMsg(''); setSaveErr('');
    try {
      await api.saveSpeechProfile(student.id, {
        min_audio_b64: Number(minAudio),
        min_confidence: Number(minConf),
        fuzzy_threshold: Number(fuzzy),
        repair_enabled: repairEnabled,
        custom_vocabulary: vocab.split('\n').map(v => v.trim()).filter(Boolean),
      });
      setSaveMsg('Saved — applies to the next voice command');
      onSaved();
      setTimeout(() => setSaveMsg(''), 4000);
    } catch (err) {
      setSaveErr(err.message);
    }
  };

  const idFor = (name) => `speech-${name}-${student.id}`;

  return (
    <form
      onSubmit={save}
      aria-label={`Speech settings for ${student.display_name}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14 }}
    >
      <SliderRow
        id={idFor('min-audio')}
        label="Minimum audio size"
        hint="Lower this for quiet speakers so short/soft recordings are not discarded"
        min={500} max={20000} step={100}
        value={minAudio} onChange={setMinAudio}
      />
      <SliderRow
        id={idFor('min-confidence')}
        label="Minimum confidence"
        hint="Lower this for atypical speech so the recognizer's low scores are still accepted"
        min={0} max={1} step={0.01}
        value={minConf} onChange={setMinConf}
      />
      <SliderRow
        id={idFor('fuzzy')}
        label="Repair match distance"
        hint="Raise this to let more near-miss phrases trigger a “Did you mean…?” prompt"
        min={0} max={1} step={0.01}
        value={fuzzy} onChange={setFuzzy}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={() => setRepairEnabled(!repairEnabled)}
          role="switch"
          aria-checked={repairEnabled}
          aria-label={`Repair prompts ${repairEnabled ? 'enabled' : 'disabled'} — click to ${repairEnabled ? 'disable' : 'enable'}`}
          style={{ minWidth: 44, minHeight: 44, background: 'none', border: 'none', cursor: 'pointer', color: repairEnabled ? 'var(--success)' : 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
        >
          {repairEnabled ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
        </button>
        <span style={{ fontSize: 14, color: 'var(--text-primary)' }}>Ask “Did you mean…?” for near-miss commands</span>
      </div>

      <div>
        <label htmlFor={idFor('vocab')} style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
          Custom vocabulary (one phrase per line) — transcription prefers these words
        </label>
        <textarea
          id={idFor('vocab')}
          value={vocab}
          onChange={e => setVocab(e.target.value)}
          rows={4}
          placeholder={'open seesaw\nstarfall\nepic books'}
          style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-secondary, var(--bg-primary))', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }}
        />
      </div>

      {saveErr && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--error)', fontSize: 13 }}>
          <AlertCircle size={14} /> {saveErr}
        </div>
      )}
      {saveMsg && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--success)', fontSize: 13 }}>
          <Check size={14} /> {saveMsg}
        </div>
      )}

      <button
        type="submit"
        style={{ alignSelf: 'flex-start', padding: '10px 16px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
      >
        Save Speech Settings
      </button>
    </form>
  );
}

function SliderRow({ id, label, hint, min, max, step, value, onChange }) {
  return (
    <div>
      <label htmlFor={id} style={{ display: 'block', fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
        {label}: <strong style={{ color: 'var(--text-primary)' }}>{value}</strong>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <input
          id={id}
          type="range"
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ flex: 1, minHeight: 44, cursor: 'pointer' }}
        />
        <input
          type="number"
          aria-label={`${label} (exact value)`}
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(e.target.value === '' ? min : Number(e.target.value))}
          style={{ width: 90, padding: '8px 10px', minHeight: 44, background: 'var(--bg-secondary, var(--bg-primary))', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit' }}
        />
      </div>
      {hint && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</p>}
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
