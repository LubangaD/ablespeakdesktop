/**
 * Home — the teacher's live view, in the Stitch "Home & Live Health" colours
 * (docs/design/stitch/home.html) but laid out like an everyday app: one page
 * title, four numbers, the recent commands as a table, a picture of the
 * student's screen with the voice bar on it, one list of how each part of
 * AbleSpeak is doing, and the student's listening settings.
 * Everything shown comes from the server; nothing here is a placeholder.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../lib/api';

// How often the health cards ask the server again
const POLL_MS = 5000;
// How often the screen preview reads the student's window
const SCREEN_POLL_MS = 10000;
// Commands loaded for the feed, and how many show until "show more"
const FEED_SIZE = 20;
const FEED_SHORT = 6;
// The speed the design holds commands to ("Sub-1.5s")
const LATENCY_GOAL_MS = 1500;

const SENSITIVITY = [
  { value: 'standard', label: 'Standard', hint: 'Most users, in a normal room.', level: 2 },
  { value: 'quiet', label: 'Quiet voice', hint: 'For a soft or tired voice. Picks up more sound.', level: 3 },
  { value: 'noisy', label: 'Noisy room', hint: 'Ignores more background talk, so speak up a little.', level: 1 },
];

// ── Type and surfaces ──
// One page title, small quiet labels, and numbers as the only large text.
// Status is a coloured dot and a word in sentence case, never a shouting badge.
const TITLE = 'font-heading text-[26px] leading-8 font-semibold tracking-[-0.01em] text-[#dbe4f2]';
const SECTION = 'font-heading text-[16px] leading-6 font-semibold text-[#dbe4f2]';
const LABEL = 'text-[13px] leading-5 text-[#c6b9a9]';
const MUTED = 'text-[13px] leading-5 text-[#c6b9a9]';
const NUMBER = 'font-heading text-[28px] leading-9 font-semibold tracking-[-0.01em] text-[#dbe4f2] tabular-nums';

const CARD = 'bg-[#151f2e] rounded-xl border border-white/[0.06]';
const BUTTON = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-lg text-[14px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const PRIMARY = `${BUTTON} bg-[#f5a623] hover:bg-[#ffb955] text-[#3d2600] font-semibold`;
const QUIET = `${BUTTON} bg-[#0a1220] hover:bg-[#1d2736] text-[#dbe4f2] border border-white/[0.08]`;
const SMALL_QUIET = 'inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg text-[13px] font-medium bg-[#0a1220] hover:bg-[#1d2736] text-[#dbe4f2] border border-white/[0.08] transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
// A small text action at the end of a list row
const ROW_ACTION = 'inline-flex items-center gap-1 min-h-[36px] px-2.5 rounded-md text-[13px] font-medium text-[#dbe4f2] hover:bg-[#1d2736] transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed';

const DOT = { ok: 'bg-[#6fdcc6]', warn: 'bg-[#ffc880]', bad: 'bg-[#ffb3aa]', idle: 'bg-[#4a5466]' };
const INK = { ok: 'text-[#6fdcc6]', warn: 'text-[var(--accent-soft)]', bad: 'text-[#ffb3aa]', idle: 'text-[#c6b9a9]' };
const TONE_WORD = { ok: 'working', warn: 'needs attention', bad: 'not working', idle: 'checking' };

// What happened to a command, as the server records it (commands.outcome)
const OUTCOME = {
  success: { label: 'Done', tone: 'ok' },
  repaired: { label: 'Worked on retry', tone: 'warn' },
  superseded: { label: 'Tried again', tone: 'warn' },
  error: { label: 'Didn’t work', tone: 'bad' },
};
const failedOutcome = o => o === 'error' || o === 'superseded';

// The screen model answers 404 with a reason ("minimized", "no window"),
// which the preview shows, so this reads the body whatever the status.
async function readScreen() {
  const res = await fetch('/api/screen');
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`Couldn’t read the screen (${res.status})`);
  return body;
}

// ── Formatting ──
const pad = n => String(n).padStart(2, '0');
const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseLocal = s => (s ? new Date(String(s).replace(' ', 'T')) : null);
const toDate = at => (at instanceof Date ? at : /^\d{4}-\d{2}-\d{2} \d/.test(String(at)) ? parseLocal(at) : new Date(at));

function minutesSince(date, now) {
  if (!date) return null;
  return Math.max(0, Math.floor((now - date.getTime()) / 60000));
}

function asMinutes(mins) {
  if (mins == null) return '—';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'}`;
  const m = mins % 60;
  return `${Math.floor(mins / 60)} h ${m} min${m === 1 ? '' : 's'}`;
}

const asLatency = ms => (!ms ? null : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);

// Written out, so dates read "21 Sep" like the top bar whatever the system locale ("21 Sept")
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function asClock(at) {
  const d = toDate(at);
  if (!d || Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return localDay(d) === localDay(new Date()) ? time : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

/** "14:05" today, "21 Sep, 14:05" before: a table's time column */
function asShortClock(at) {
  const d = toDate(at);
  if (!d || Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return localDay(d) === localDay(new Date()) ? time : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

/** "Amina K." → "AK" */
function initials(name) {
  return String(name).split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')[0] || '').join('').slice(0, 2).toUpperCase();
}

/** "gemini-2.5-flash" → "Gemini 2.5 Flash", "claude-3-5-sonnet-20241022" → "Claude 3.5 Sonnet" */
function modelName(id) {
  if (!id) return null;
  const parts = String(id).split('/').pop().split(/[-_]/).filter(p => p && !/^\d{8}$/.test(p));
  const merged = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && /^\d+(\.\d+)*$/.test(merged[merged.length - 1] || '')) merged[merged.length - 1] += `.${p}`;
    else merged.push(p);
  }
  return merged.map(p => (/^gpt$/i.test(p) ? 'GPT' : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
}

const safeJson = s => {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
};

/** The browser tab the Chrome helper last said was in front, from GET /api/context. */
function activeTabTitle(ctx) {
  if (!ctx || typeof ctx !== 'object' || ctx.message) return null;
  const chrome = ctx.result ?? ctx.chrome ?? ctx.integration?.chrome ?? ctx;
  const tab = chrome?.activeTab;
  if (tab && typeof tab === 'object') return tab.title || tab.url || null;
  const tabs = Array.isArray(chrome?.tabs) ? chrome.tabs : [];
  const found = tabs.find(t => t && (t.active || (tab != null && t.id === tab)));
  return found ? found.title || found.url || null : null;
}

/** A saved command (GET /api/commands) in the feed's shape. */
function fromStored(row, names) {
  const payload = safeJson(row.payload) || {};
  const result = safeJson(row.result) || {};
  const outcome = row.outcome || (result.error || result.status === 'error' ? 'error' : 'success');
  const tools = [];
  if (payload.fastTool) tools.push({ name: payload.fastTool, failed: outcome === 'error' });
  for (const c of Array.isArray(result.toolCalls) ? result.toolCalls : []) {
    tools.push({ name: c.tool || c.name, failed: c.result?.status === 'error' });
  }
  const note = typeof result.error === 'string' ? `That didn’t work: ${result.error}`
    : typeof result.text === 'string' && result.text ? result.text
      : typeof result.message === 'string' && result.message ? result.message : null;
  return {
    id: row.id,
    heard: payload.text || null,
    at: parseLocal(row.created_at),
    by: row.student_id != null ? names.get(row.student_id) || null : null,
    tools: tools.filter(t => t.name),
    latency: row.latency_ms,
    outcome,
    note,
  };
}

/**
 * What is being worked on right now, and each command answered since this
 * page opened, from the dashboard WebSocket.
 */
function useLiveFeed(on, studentName, onAnswered) {
  const [pending, setPending] = useState(null); // { text, at, asrMs, step, progress }
  const [live, setLive] = useState([]);
  const studentRef = useRef(studentName);
  studentRef.current = studentName;
  const answeredRef = useRef(onAnswered);
  answeredRef.current = onAnswered;

  useEffect(() => {
    let heard = null;
    const clear = () => { heard = null; setPending(null); };
    const offs = [
      on('voice_transcription', msg => {
        heard = { text: msg.text, at: msg.timestamp || new Date().toISOString(), asrMs: msg.latency || null };
        setPending({ ...heard, step: null, progress: null });
      }),
      on('agent_progress', msg => {
        if (msg.phase === 'plan') setPending(p => p && { ...p, step: `Planned ${(msg.steps || []).length} steps`, progress: null });
        if (msg.phase === 'step') setPending(p => p && { ...p, step: msg.step?.do || 'Working on the next step', progress: `Step ${msg.index + 1} of ${msg.total}` });
      }),
      on('chat_assistant_message', msg => {
        const calls = msg.toolCalls || [];
        const failed = !!msg.error || calls.some(c => c.result?.status === 'error');
        const id = msg.id || `${Date.now()}`;
        setLive(list => (list.some(i => i.id === id) ? list : [{
          id,
          heard: heard?.text || null,
          at: new Date(msg.timestamp || Date.now()),
          by: studentRef.current,
          tools: calls.map(c => ({ name: c.tool || c.name, failed: c.result?.status === 'error' })).filter(t => t.name),
          latency: msg.latency,
          outcome: failed ? 'error' : 'success',
          note: msg.text || null,
          live: true,
        }, ...list].slice(0, FEED_SIZE)));
        clear();
        answeredRef.current?.();
      }),
      ...['voice_no_speech', 'voice_error', 'voice_cancelled', 'voice_sleeping', 'voice_awake', 'voice_dismissed', 'voice_restored', 'privacy_mode']
        .map(type => on(type, clear)),
    ];
    return () => offs.forEach(off => off());
  }, [on]);

  return { pending, live };
}

/** A Material Symbols icon, as the Stitch screen draws them. */
function Icon({ name, className = '', filled }) {
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

export default function Home() {
  const queryClient = useQueryClient();
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.getHealth, refetchInterval: POLL_MS });
  const { data: stats } = useQuery({ queryKey: ['commandStats'], queryFn: api.getCommandStats, refetchInterval: 30000 });
  const statusQuery = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: POLL_MS });
  const aiQuery = useQuery({ queryKey: ['aiStatus'], queryFn: api.getAiStatus, staleTime: 10000, refetchInterval: POLL_MS });
  const { data: analytics } = useQuery({ queryKey: ['teacherAnalytics'], queryFn: api.getTeacherAnalytics, refetchInterval: 30000 });
  const activeQuery = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });
  const active = activeQuery.data;
  const student = active?.student || null;
  const { data: recognition } = useQuery({
    queryKey: ['recognition', student?.id],
    queryFn: () => api.getRecognition(student.id, 7),
    enabled: !!student,
    refetchInterval: 30000,
  });
  const { data: profile } = useQuery({
    queryKey: ['profile', student?.id],
    queryFn: () => api.getProfile(student.id),
    enabled: !!student,
  });
  const { data: storedRows } = useQuery({
    queryKey: ['homeCommands'],
    queryFn: () => api.getRecentCommands(FEED_SIZE),
    refetchInterval: 15000,
  });
  const { on, wsRef, connected } = useWebSocket();

  const status = statusQuery.data;
  const voice = status?.voice || {};
  const extensionCount = status?.extensionClients || 0;

  // How fast the gateway answers (the same measure as the sidebar's)
  const { data: roundTrip } = useQuery({
    queryKey: ['gatewayPing'],
    queryFn: async () => {
      const started = performance.now();
      await api.getHealth();
      return Math.round(performance.now() - started);
    },
    refetchInterval: 10000,
    enabled: connected,
  });
  // The tab the Chrome helper reports, while one is connected
  const { data: browserContext } = useQuery({
    queryKey: ['homeContext'],
    queryFn: api.getContext,
    refetchInterval: 15000,
    enabled: extensionCount > 0,
  });
  // The window the student is using, read from Windows (not while privacy mode is on)
  const screenQuery = useQuery({
    queryKey: ['homeScreen'],
    queryFn: readScreen,
    refetchInterval: SCREEN_POLL_MS,
    retry: false,
    enabled: !!status && !voice.privacyMode,
  });

  const { pending, live } = useLiveFeed(on, student?.name || null, () => {
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['homeCommands'] });
      queryClient.invalidateQueries({ queryKey: ['commandStats'] });
    }, 400);
  });

  // The speech brain forgot its conversation, or the student's settings changed
  useEffect(() => {
    const offs = [
      on('history_cleared', () => queryClient.invalidateQueries({ queryKey: ['aiStatus'] })),
      on('listening_settings', () => queryClient.invalidateQueries({ queryKey: ['profile'] })),
      on('extension_status', () => queryClient.invalidateQueries({ queryKey: ['homeContext'] })),
    ];
    return () => offs.forEach(off => off());
  }, [on, queryClient]);

  // A clock for the session length
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const clearHistory = useMutation({
    mutationFn: api.clearAiHistory,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['aiStatus'] }),
  });
  useEffect(() => {
    if (!clearHistory.isSuccess && !clearHistory.isError) return undefined;
    const id = setTimeout(() => clearHistory.reset(), 4000);
    return () => clearTimeout(id);
  }, [clearHistory.isSuccess, clearHistory.isError]); // eslint-disable-line react-hooks/exhaustive-deps

  // Send a phrase exactly as if it had been said (pause / resume / privacy / hide / show)
  const say = (text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat_command', text }));
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['status'] }), 400);
    }
  };

  // Recent saved commands, with the ones heard since this page opened on top
  const names = useMemo(() => new Map((analytics?.students || []).map(s => [s.id, s.name])), [analytics]);
  const feed = useMemo(() => {
    const byId = new Map();
    for (const row of Array.isArray(storedRows) ? storedRows : []) {
      const item = fromStored(row, names);
      byId.set(item.id, item);
    }
    for (const item of live) {
      const saved = byId.get(item.id);
      byId.set(item.id, saved ? {
        ...saved,
        ...item,
        heard: item.heard || saved.heard,
        by: saved.by,
        tools: item.tools.length ? item.tools : saved.tools,
        outcome: saved.outcome,
        at: saved.at || item.at,
      } : item);
    }
    return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, FEED_SIZE);
  }, [storedRows, live, names]);

  const aiStatus = aiQuery.data;
  const aiReady = !!aiStatus?.configured;
  const alerts = (health?.alertDetails || []).filter(a => !a.component?.startsWith('provider_') && a.component !== 'llm');
  const providerAlert = (health?.alertDetails || []).find(a => (a.component?.startsWith('provider_') || a.component === 'llm') && a.status === 'error');
  const summary = analytics?.summary;
  const studentRow = student ? (analytics?.students || []).find(s => s.id === student.id) : null;
  const sessionMinutes = minutesSince(parseLocal(active?.startedAt), now);
  const statusLoading = statusQuery.isPending;
  const checking = statusLoading || aiQuery.isPending;
  const sensitivity = SENSITIVITY.find(s => s.value === (student ? profile?.listening?.sensitivity : 'standard'));

  const notReady = [connected, aiReady, extensionCount > 0, !voice.sleeping && !voice.dismissed, !voice.privacyMode]
    .filter(ok => !ok).length + alerts.length;

  // Today against the six days before it (days with no commands count as none)
  const today = localDay(new Date(now));
  const weekStart = localDay(new Date(new Date(now).setDate(new Date(now).getDate() - 6)));
  const priorDays = (analytics?.dailyTrend || []).filter(d => d.day < today && d.day >= weekStart);
  const dailyAvg = priorDays.reduce((sum, d) => sum + d.count, 0) / 6;
  const vsAvg = stats && dailyAvg > 0 ? Math.round(((stats.today - dailyAvg) / dailyAvg) * 100) : null;
  const quickToday = (stats?.byType || []).find(t => t.type === 'voice_fast')?.count || 0;
  const aiToday = (stats?.byType || []).find(t => t.type === 'voice')?.count || 0;

  const tabTitle = extensionCount > 0 ? activeTabTitle(browserContext) : null;
  const systemRows = [
    {
      key: 'server',
      name: 'Server',
      tone: !connected && statusLoading ? 'idle' : connected ? 'ok' : 'bad',
      detail: connected
        ? ['Connected', roundTrip != null && `${roundTrip} ms`, status?.port && `port ${status.port}`].filter(Boolean).join(' · ')
        : statusLoading ? 'Checking…' : 'Not connected',
      action: (
        <Link to="/developer/logs" className={ROW_ACTION} aria-label="Server log (admin PIN needed)">
          Log<Icon name="lock" className="text-[14px] text-[#c6b9a9]" />
        </Link>
      ),
    },
    {
      key: 'mic',
      name: 'Microphone',
      tone: statusLoading ? 'idle' : voice.sleeping ? 'warn' : 'ok',
      detail: statusLoading ? 'Checking…'
        : [voice.sleeping ? 'Asleep' : voice.dictationMode ? 'Dictating' : 'Listening',
          sensitivity && `${sensitivity.label.toLowerCase()} sensitivity${student ? '' : ' (default)'}`].filter(Boolean).join(' · '),
      action: <Link to="/test" className={ROW_ACTION}>Test</Link>,
    },
    {
      key: 'bar',
      name: 'Voice bar',
      tone: statusLoading ? 'idle' : voice.dismissed ? 'warn' : 'ok',
      detail: statusLoading ? 'Checking…'
        : voice.dismissed ? 'Hidden'
          : `Shown at the bottom of the screen${voice.privacyMode ? ' · not reading the screen' : ''}`,
      action: voice.dismissed
        ? <button type="button" className={ROW_ACTION} onClick={() => say('come back')} disabled={!connected}>Show</button>
        : <button type="button" className={ROW_ACTION} onClick={() => say('hide')} disabled={!connected || statusLoading || voice.sleeping}
            title={voice.sleeping ? 'AbleSpeak is asleep. Resume voice first.' : undefined}>Hide</button>,
    },
  ];

  return (
    <div className="min-h-full w-full bg-[#0D1627] text-[#dbe4f2] px-8 pt-7 pb-6">
      <div className="flex flex-col w-full gap-6 pb-10">
        <PageHeader
          loading={activeQuery.isPending}
          failed={activeQuery.isError}
          student={student}
          sessionMinutes={sessionMinutes}
          profile={profile}
          dictating={!!voice.dictationMode}
        />

        <WhatCanIDo say={say} connected={connected} />

        {/* ── Key numbers ── */}
        <section aria-labelledby="numbers-heading" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4">
          <h2 id="numbers-heading" className="sr-only">Key numbers</h2>
          <Stat
            label="Commands today"
            value={stats ? stats.today : null}
            note={vsAvg != null && stats?.today ? `${vsAvg > 0 ? '+' : ''}${vsAvg}% vs. 6-day average` : stats ? `${stats.total} all time` : null}
            title={stats?.today ? `${quickToday} matched instantly, ${aiToday} used the AI model` : undefined}
          />
          <Stat
            label="Success rate"
            value={summary?.totalCommands ? `${summary.successRate}%` : null}
            note="All time"
          />
          <Stat
            label="Average response today"
            value={asLatency(stats?.avgLatency)}
            note={stats?.avgLatency
              ? (stats.avgLatency < LATENCY_GOAL_MS ? 'Within the 1.5 s goal' : 'Slower than the 1.5 s goal')
              : `All time: ${asLatency(summary?.avgLatency) || 'no data yet'}`}
            noteTone={stats?.avgLatency && stats.avgLatency >= LATENCY_GOAL_MS ? 'warn' : 'idle'}
          />
          {student ? (
            <Stat
              label="Worked first time"
              value={recognition?.firstTimeRate != null ? `${Math.round(recognition.firstTimeRate * 100)}%` : null}
              note={recognition ? (recognition.tasks ? `${recognition.firstTime} of ${recognition.tasks} in the last 7 days` : 'Nothing heard yet') : null}
            />
          ) : (
            <Stat label="Worked first time" value={null} note="Shows once you’re signed in" />
          )}
          <ConnectionCard
            label="AI model"
            value={aiQuery.isPending ? null : modelName(aiStatus?.model) || 'No model chosen'}
            valueTitle={aiStatus?.model}
            tone={aiQuery.isPending ? 'idle' : !aiReady ? 'warn' : providerAlert ? 'bad' : 'ok'}
            status={aiQuery.isPending ? 'Checking…'
              : !aiReady ? `No API key${aiStatus?.providerName ? ` for ${aiStatus.providerName}` : ''}`
                : providerAlert ? `${aiStatus?.providerName || 'The provider'} isn’t answering`
                  : `Connected to ${aiStatus?.providerName || 'the provider'}`}
            statusTitle={providerAlert?.message}
            action={(
              <button type="button" onClick={() => clearHistory.mutate()} disabled={clearHistory.isPending}
                className={ROW_ACTION} aria-describedby="clear-history-result" title="Make AbleSpeak forget the conversation so far">
                {clearHistory.isPending ? 'Clearing…' : clearHistory.isSuccess ? 'Cleared' : 'Clear history'}
              </button>
            )}
          />
          <ConnectionCard
            label="Chrome extension"
            value={statusLoading ? null : extensionCount > 0
              ? (extensionCount === 1 ? 'Chrome' : `${extensionCount} browsers`)
              : 'Not connected'}
            tone={statusLoading ? 'idle' : extensionCount > 0 ? 'ok' : 'warn'}
            status={statusLoading ? 'Checking…'
              : extensionCount > 0 ? (tabTitle ? `Connected · ${tabTitle}` : 'Connected')
                : 'Waiting for Chrome'}
            statusTitle={tabTitle || undefined}
            action={(
              <Link to="/developer/tools" className={ROW_ACTION} aria-label="Web tools (admin PIN needed)">
                Tools<Icon name="lock" className="text-[14px] text-[#c6b9a9]" />
              </Link>
            )}
          />
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-8 flex flex-col gap-6 min-w-0">
            <RecentCommands feed={feed} pending={pending} connected={connected} total={stats?.total} />
            <OverlayPreview
              screenQuery={screenQuery}
              voice={voice}
              statusLoaded={!!status}
              connected={connected}
              say={say}
              on={on}
              extensionConnected={extensionCount > 0}
            />
          </div>
          <div className="lg:col-span-4 flex flex-col gap-6 min-w-0">
            <SystemStatus rows={systemRows} alerts={alerts} checking={checking} notReady={notReady} clearHistory={clearHistory} />
            <SpeechControls student={student} profile={profile} voice={voice} connected={connected} say={say} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The page title, who is in session, and what you can do about it ──
// ── What can I do? (UI/UX spec §7.3, §8) ──
// Things AbleSpeak does, as app-style tiles with what to say. "Try it" sends
// the first phrase exactly as if it had been said.
const CAPABILITIES = [
  {
    key: 'word', title: 'Open Word', tile: 'from-[#2b7cd3] to-[#185abd]', letter: 'W',
    says: ['Open Word', 'Open Excel'],
  },
  {
    key: 'dictate', title: 'Dictate in Word', tile: 'from-[#1fb5a0] to-[#0e7c6b]', icon: 'mic',
    says: ['Start dictation', 'Stop dictation'],
  },
  {
    key: 'web', title: 'Browse the web', tile: 'from-[#4f8ef7] to-[#2f5fd0]', icon: 'travel_explore',
    says: ['Open YouTube', 'Open the first link'],
  },
  {
    key: 'read', title: 'Read a page', tile: 'from-[#f5a623] to-[#c77d0a]', icon: 'record_voice_over',
    says: ['Read this page', 'Read the next paragraph'],
  },
  {
    key: 'control', title: 'Control the computer', tile: 'from-[#9b7bf0] to-[#6a48d6]', icon: 'mouse',
    says: ['Scroll down', 'Switch to Chrome', 'Minimise this window'],
  },
];

function WhatCanIDo({ say, connected }) {
  return (
    <section aria-labelledby="can-do-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="can-do-heading" className="font-heading text-[18px] leading-7 font-semibold text-[#dbe4f2]">What can I do?</h2>
        <p className="text-[13px] leading-5 text-[#c6b9a9]">Say it, or click to try.</p>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
        {CAPABILITIES.map(c => (
          <li key={c.key}>
            <button
              type="button"
              onClick={() => say(c.says[0])}
              disabled={!connected}
              title={connected ? `Does the same as saying “${c.says[0]}”. Also: ${c.says.slice(1).map(s => `“${s}”`).join(', ')}` : 'AbleSpeak isn’t connected'}
              className="group w-full min-h-[64px] px-3.5 py-3 rounded-xl bg-[#151f2e] hover:bg-[#0a1220] border border-white/[0.06] hover:border-white/[0.12] flex items-center gap-3 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <span className={`w-10 h-10 rounded-[10px] bg-gradient-to-br ${c.tile} flex items-center justify-center shrink-0`} aria-hidden="true">
                {c.letter
                  ? <span className="font-heading text-[18px] font-bold text-white leading-none">{c.letter}</span>
                  : <span className="material-symbols-outlined text-[20px] text-white">{c.icon}</span>}
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[15px] leading-5 font-semibold text-[#dbe4f2]">{c.title}</span>
                <span className="text-[13px] leading-5 text-[#c6b9a9] truncate">“{c.says[0]}”</span>
              </span>
              <span className="material-symbols-outlined text-[20px] text-[#a6b2c6] group-hover:text-[#dbe4f2] shrink-0" aria-hidden="true">chevron_right</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PageHeader({ loading, failed, student, sessionMinutes, profile, dictating }) {
  const chosen = SENSITIVITY.find(s => s.value === profile?.listening?.sensitivity);
  const pauseSeconds = profile?.listening?.pauseSeconds;

  let line;
  if (loading) line = 'Checking who is signed in…';
  else if (failed) line = 'Couldn’t check who is signed in.';
  else if (student) {
    line = [
      `Using AbleSpeak for ${asMinutes(sessionMinutes)}`,
      chosen && `${chosen.label.toLowerCase()} listening`,
      pauseSeconds != null && `${Number(pauseSeconds).toFixed(1)} s pause`,
      dictating && 'dictating now',
    ].filter(Boolean).join(' · ');
  } else line = 'Nobody is signed in, so your commands aren’t saved to a profile yet.';

  return (
    <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className={TITLE}>{student ? `Hi, ${student.name.split(' ')[0]}` : 'Home'}</h1>
        <p className={`${MUTED} text-[14px] mt-1`}>{line}</p>
      </div>
      {!loading && (
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {student && (
            <Link to="/progress" className={QUIET}><Icon name="insights" className="text-[18px]" />My progress</Link>
          )}
        </div>
      )}
    </header>
  );
}

// A number with a quiet label above and one line of context below
function Stat({ label, value, note, noteTone = 'idle', title }) {
  const empty = value == null || value === '';
  return (
    <div className={`${CARD} px-5 py-4 flex flex-col gap-1 min-w-0`}>
      <h3 className={`${LABEL} truncate`}>{label}</h3>
      {empty
        ? <p className="font-heading text-[16px] leading-9 text-[#a6b2c6]">No data yet</p>
        : <p className={NUMBER}>{value}</p>}
      {note && <p className={`text-[13px] leading-5 ${INK[noteTone]} truncate`} title={title}>{note}</p>}
    </div>
  );
}

// A connection: its name, what it is, and whether it is working
function ConnectionCard({ label, value, valueTitle, tone, status, statusTitle, action }) {
  return (
    <div className={`${CARD} px-5 py-4 flex flex-col gap-1 min-w-0`}>
      <div className="flex items-center justify-between gap-2 -mt-1.5 -mr-2.5">
        <h3 className={`${LABEL} truncate`}>{label}</h3>
        {action}
      </div>
      <p className="font-heading text-[18px] leading-9 font-semibold text-[#dbe4f2] truncate" title={valueTitle}>
        {value ?? <span className="font-normal text-[16px] text-[#a6b2c6]">Checking…</span>}
      </p>
      <p className={`flex items-center gap-1.5 text-[13px] leading-5 min-w-0 ${INK[tone]}`} title={statusTitle}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tone]}`} aria-hidden="true" />
        <span className="truncate">{status}</span>
      </p>
    </div>
  );
}

// ── Each part of AbleSpeak, one row each ──
function SystemStatus({ rows, alerts, checking, notReady, clearHistory }) {
  return (
    <section aria-labelledby="system-heading" className={`${CARD} p-5 flex flex-col gap-3`}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="system-heading" className={SECTION}>System status</h2>
        <span role="status" className={`text-[13px] ${checking ? INK.idle : notReady ? INK.warn : INK.ok}`}>
          {checking ? 'Checking…' : notReady ? `${notReady} need${notReady === 1 ? 's' : ''} attention` : 'All working'}
        </span>
      </div>

      {alerts.length > 0 && (
        <ul aria-live="polite" className="flex flex-col gap-2">
          {alerts.map((a, i) => (
            <li key={i} role={a.status === 'error' ? 'alert' : 'status'}
              className={`rounded-lg bg-[#0a1220] px-3 py-2 text-[13px] leading-5 text-[#dbe4f2] border-l-2 ${a.status === 'error' ? 'border-[#ffb3aa]' : 'border-[#ffc880]'}`}>
              <span className="font-medium">{a.component}</span>: <span className="text-[#c6b9a9]">{a.message}</span>
            </li>
          ))}
        </ul>
      )}

      <ul className="flex flex-col divide-y divide-white/[0.06]">
        {rows.map(row => (
          <li key={row.key} className="flex items-center gap-3 py-2.5">
            <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[row.tone]}`} aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-[14px] leading-5 font-medium text-[#dbe4f2]">
                {row.name}<span className="sr-only">: {TONE_WORD[row.tone]}</span>
              </p>
              <p className={`${MUTED} truncate`} title={row.detailTitle}>{row.detail}</p>
            </div>
            {row.action}
          </li>
        ))}
      </ul>
      <p id="clear-history-result" aria-live="polite" className={clearHistory.isError ? 'text-[13px] text-[#ffb3aa]' : 'sr-only'}>
        {clearHistory.isError ? clearHistory.error.message
          : clearHistory.isSuccess ? 'AbleSpeak has forgotten the conversation so far.' : ''}
      </p>
    </section>
  );
}

// ── What was said, and what AbleSpeak did about it ──
function RecentCommands({ feed, pending, connected, total }) {
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(false);

  const failedCount = feed.filter(i => failedOutcome(i.outcome)).length;
  const matching = filter === 'failed' ? feed.filter(i => failedOutcome(i.outcome)) : feed;
  const shown = matching.slice(0, expanded ? FEED_SIZE : FEED_SHORT);

  // Staff can keep a copy of what the list holds
  const exportLog = () => {
    const blob = new Blob([JSON.stringify(feed, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `ablespeak-commands-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <section aria-labelledby="commands-heading" className={`${CARD} flex flex-col min-w-0`}>
      <div className="flex items-center justify-between flex-wrap gap-3 px-5 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <h2 id="commands-heading" className={SECTION}>Recent commands</h2>
          <span className={`inline-flex items-center gap-1.5 text-[12px] ${connected ? INK.ok : INK.idle}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? DOT.ok : DOT.idle}`} aria-hidden="true" />
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="commands-filter" className="sr-only">Show</label>
          <select id="commands-filter" value={filter} onChange={e => setFilter(e.target.value)} className={`${SMALL_QUIET} pr-8 cursor-pointer`}>
            <option value="all">All commands</option>
            <option value="failed">Didn’t work ({failedCount})</option>
          </select>
          <button type="button" onClick={exportLog} disabled={!feed.length} className={SMALL_QUIET}>
            <Icon name="download" className="text-[16px]" />Export
          </button>
        </div>
      </div>

      {/* What is being worked on right now */}
      <div aria-live="polite">
        {pending ? (
          <div className="mx-5 mb-3 rounded-lg bg-[#0a1220] border-l-2 border-[#ffc880] px-4 py-3 flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--accent-soft)]">
                <Icon name="progress_activity" className="text-[16px] animate-spin" />Working on it
              </span>
              <span className={MUTED}>{pending.progress || `Heard ${asClock(pending.at)}${pending.asrMs ? ` in ${asLatency(pending.asrMs)}` : ''}`}</span>
            </div>
            <p className="text-[14px] leading-5 text-[#dbe4f2] break-words">“{pending.text}”</p>
            {pending.step && <p className={MUTED}>{pending.step}</p>}
          </div>
        ) : !connected ? (
          <p className={`${MUTED} px-5 pb-3`}>Not connected to AbleSpeak. New commands appear here once it reconnects.</p>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-[12px] leading-4 text-[#c6b9a9] border-y border-white/[0.06]">
              <th scope="col" className="font-medium px-5 py-2.5 w-[96px]">Time</th>
              <th scope="col" className="font-medium px-3 py-2.5">What was said</th>
              <th scope="col" className="font-medium px-3 py-2.5 w-[132px]">Result</th>
              <th scope="col" className="font-medium px-5 py-2.5 w-[84px] text-right">Took</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {shown.length === 0 ? (
              <tr>
                <td colSpan={4} className={`${MUTED} px-5 py-8 text-center`}>
                  {filter === 'failed' ? 'None of the recent commands failed.' : 'No commands yet. What a user says will appear here.'}
                </td>
              </tr>
            ) : shown.map(item => <CommandRow key={item.id} item={item} />)}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 px-5 py-3 border-t border-white/[0.06]">
        <span className={MUTED}>
          {filter === 'failed'
            ? `${shown.length} that didn’t work, of the last ${feed.length}`
            : feed.length ? `Showing ${shown.length} of ${total ?? feed.length}` : 'Commands appear here as they are said'}
        </span>
        {matching.length > FEED_SHORT && (
          <button type="button" onClick={() => setExpanded(e => !e)} aria-expanded={expanded} className={`${ROW_ACTION} !text-[var(--accent-soft)]`}>
            {expanded ? 'Show fewer' : `Show last ${Math.min(FEED_SIZE, matching.length)}`}
            <Icon name={expanded ? 'expand_less' : 'expand_more'} className="text-[18px]" />
          </button>
        )}
      </div>
    </section>
  );
}

function CommandRow({ item }) {
  const look = OUTCOME[item.outcome] || OUTCOME.success;
  const failed = failedOutcome(item.outcome);
  return (
    <tr className="align-top hover:bg-white/[0.022] transition-colors">
      <td className="px-5 py-3 text-[13px] leading-5 text-[#c6b9a9] tabular-nums whitespace-nowrap" title={asClock(item.at)}>{asShortClock(item.at)}</td>
      <td className="px-3 py-3 min-w-0">
        <p className="text-[14px] leading-5 text-[#dbe4f2] break-words" title={!failed && item.note ? item.note : undefined}>
          {item.heard ? `“${item.heard}”` : <span className="text-[#c6b9a9]">Typed or follow-up command</span>}
        </p>
        {item.tools.length > 0 && (
          <p className="mt-0.5 font-mono text-[12px] leading-4 text-[#a6b2c6] break-words">
            {item.tools.map((t, i) => (
              <span key={i} className={t.failed ? 'text-[#ffb3aa]' : undefined}>
                {i > 0 ? ' → ' : ''}{t.name}{t.failed && <span className="sr-only"> (failed)</span>}
              </span>
            ))}
          </p>
        )}
        {failed && item.note && <p className="mt-1 text-[13px] leading-5 text-[#ffb3aa] line-clamp-2 break-words">{item.note}</p>}
      </td>
      <td className="px-3 py-3">
        <span className={`flex items-center gap-1.5 text-[13px] leading-5 whitespace-nowrap ${INK[look.tone]}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${DOT[look.tone]}`} aria-hidden="true" />{look.label}
        </span>
      </td>
      <td className="px-5 py-3 text-[13px] leading-5 text-[#c6b9a9] text-right tabular-nums whitespace-nowrap">
        {asLatency(item.latency) || ''}
      </td>
    </tr>
  );
}

// ── The user's screen, drawn as a screen ──
// Not a screenshot: the window in front comes from Windows (/api/screen), the
// voice bar from the voice bar itself (overlay_state: what it shows, where it
// sits, the screen it is on and the mic level). So it shows what AbleSpeak
// sees, and a helper using this same computer doesn't just see this dashboard.
const ACTING = new Set(['invoke', 'toggle', 'select', 'set_value', 'expand', 'collapse']);

// Apps by their Windows process name: what to call them, and their icon colour
const APPS = {
  chrome: ['Chrome', '#1a73e8'], msedge: ['Edge', '#0c7cd5'], brave: ['Brave', '#fb542b'], firefox: ['Firefox', '#ff7139'],
  winword: ['Word', '#2b579a'], excel: ['Excel', '#217346'], powerpnt: ['PowerPoint', '#c43e1c'],
  spotify: ['Spotify', '#1db954'], notepad: ['Notepad', '#3a7bd5'], explorer: ['File Explorer', '#e0a030'],
  code: ['VS Code', '#007acc'], whatsapp: ['WhatsApp', '#25d366'], teams: ['Teams', '#5b5fc7'],
};
const BROWSERS = new Set(['chrome', 'msedge', 'brave', 'firefox']);
const OFFICE = new Set(['winword', 'excel', 'powerpnt']);

function appLook(app) {
  const key = String(app || '').toLowerCase().replace(/\.exe$/, '');
  const [name, color] = APPS[key] || [key ? key.charAt(0).toUpperCase() + key.slice(1) : 'App', '#5b6b82'];
  return { key, name, color };
}

/** "Sign up | Grammarly - Google Chrome" → "Sign up | Grammarly": the app is already named beside it. */
function windowName(title, look) {
  const t = String(title || '').trim();
  const cut = t.replace(/\s+[-–—]\s+(Google Chrome|Microsoft\s*Edge|Brave|Mozilla Firefox|Word|Excel|PowerPoint|Notepad|Visual Studio Code|Spotify)$/i, '');
  return cut || t || `${look.name} window`;
}

function AppGlyph({ look, className }) {
  return (
    <span className={`rounded-[22%] flex items-center justify-center font-bold text-white shrink-0 ${className}`} style={{ background: look.color }} aria-hidden="true">
      {look.name.charAt(0)}
    </span>
  );
}

// The voice bar's modes (overlay-messages.js MODES), as a dot colour
const MODE_DOT = {
  listening: 'bg-[#6fdcc6]', ready: 'bg-[#6fdcc6]', dictating: 'bg-[#6fdcc6]', done: 'bg-[#6fdcc6]',
  processing: 'bg-[#ffc880]', confirmation: 'bg-[#ffc880]', speaking: 'bg-[#8ab4ff]',
  error: 'bg-[#ffb3aa]', offline: 'bg-[#ffb3aa]', sleeping: 'bg-[#8a94a6]', off: 'bg-[#8a94a6]', exam: 'bg-[#8ab4ff]',
};
const OUTCOME_INK = { done: 'text-[#6fdcc6]', failed: 'text-[#ffb3aa]', waiting: 'text-[var(--accent-soft)]', working: 'text-[var(--accent-soft)]' };

const WALLPAPER = 'radial-gradient(120% 90% at 12% 115%, rgba(47,94,166,0.6), transparent 60%), '
  + 'radial-gradient(80% 70% at 92% -10%, rgba(32,150,170,0.35), transparent 55%), #0b1322';

const pct = (v, of) => `${(v / of) * 100}%`;

/** Re-render every `ms`, for "live" and the taskbar clock. */
function useTicker(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "Bottom left of the screen": where a box sits, in words. */
function placeOnScreen(b, W, H) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const v = cy < H / 3 ? 'Top' : cy > (2 * H) / 3 ? 'Bottom' : 'Middle';
  const h = cx < W / 3 ? 'left' : cx > (2 * W) / 3 ? 'right' : 'centre';
  return v === 'Middle' && h === 'centre' ? 'Centre of the screen' : `${v} ${h} of the screen`;
}

/** The window in front, drawn at its size and place, with its controls outlined. */
function FrontWindow({ model, look, W, H, workH, dpr }) {
  let r = model.rect;
  // Windows may report device pixels: bring them to the screen's own units
  if (r[0] + r[2] > W * 1.05 || r[1] + r[3] > H * 1.05) r = r.map(v => v / dpr);
  const scale = r === model.rect ? 1 : 1 / dpr;
  // A maximised window hangs a few pixels over each edge
  const x = Math.max(0, r[0]), y = Math.max(0, r[1]);
  const w = Math.min(W, r[0] + r[2]) - x, h = Math.min(workH, r[1] + r[3]) - y;
  if (w <= 0 || h <= 0) return null;
  const boxes = (model.elements || [])
    .filter(e => Array.isArray(e.rect) && e.rect[2] > 2 && e.rect[3] > 2)
    .map(e => ({ ...e, r: e.rect.map(v => v * scale) }))
    .filter(e => !(e.r[2] >= w * 0.95 && e.r[3] >= h * 0.9))
    .slice(0, 200);
  return (
    <div
      className="absolute rounded-[3px] overflow-hidden border border-white/15 bg-[#1a202b] shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
      style={{ left: pct(x, W), top: pct(y, H), width: pct(w, W), height: pct(h, H) }}
    >
      <svg className="absolute inset-0 w-full h-full" viewBox={`${x} ${y} ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        {boxes.map((e, i) => {
          const acts = Array.isArray(e.actions) && e.actions.some(a => ACTING.has(a));
          return (
            <rect
              key={`${e.ref}-${i}`} x={e.r[0]} y={e.r[1]} width={e.r[2]} height={e.r[3]} rx="3"
              fill={acts ? '#6fdcc6' : '#dbe4f2'} fillOpacity={acts ? 0.08 : 0.02}
              stroke={acts ? '#6fdcc6' : '#dbe4f2'} strokeOpacity={acts ? 0.45 : 0.12}
              strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {/* Title bar: the app, the window's name, and minimise / maximise / close */}
      <div className="relative h-[15px] bg-[#262e3b] flex items-center gap-1 px-1.5 border-b border-black/30">
        <AppGlyph look={look} className="w-[9px] h-[9px] text-[6px]" />
        <span className="flex-1 min-w-0 truncate text-[8px] leading-none text-[#dbe4f2]/90" data-private>{windowName(model.window, look)}</span>
        <span className="flex items-center gap-[7px] text-[8px] leading-none text-[#dbe4f2]/70 pr-0.5" aria-hidden="true">
          <span>&#8211;</span><span>&#9633;</span><span>&#10005;</span>
        </span>
      </div>
    </div>
  );
}

/** The voice bar where it really is, showing what it really shows. */
function VoiceBarOnScreen({ bar, W, H, hidden }) {
  const b = bar.bar;
  if (!b || !b.w || !b.h) return null;
  const x = Math.min(Math.max(0, b.x), W - b.w), y = Math.min(Math.max(0, b.y), H - b.h);
  const box = { left: pct(x, W), top: pct(y, H), width: pct(b.w, W), height: pct(b.h, H) };
  const dot = MODE_DOT[bar.mode] || 'bg-[#6fdcc6]';
  if (bar.mini) {
    return (
      <div className={`absolute flex items-center justify-center ${hidden ? 'opacity-30' : ''}`} style={box} title="The voice bar">
        <span className="h-[70%] aspect-square rounded-full bg-[#f5a623] shadow-[0_0_10px_rgba(245,166,35,0.6)] flex items-center justify-center">
          <Icon name="mic" className="text-[9px] text-[#3d2600]" />
        </span>
      </div>
    );
  }
  return (
    <div className={`absolute rounded-[5px] bg-[#1d2736]/95 border border-white/15 shadow-[0_4px_14px_rgba(0,0,0,0.5)] px-1.5 py-1 flex flex-col gap-[2px] overflow-hidden ${hidden ? 'opacity-30' : ''}`} style={box} title="The voice bar">
      <span className="flex items-center gap-1 text-[7px] leading-none font-semibold text-[#dbe4f2]">
        <span className={`w-1 h-1 rounded-full ${dot}`} />{bar.label}
      </span>
      {bar.heard && <span className="text-[7px] leading-tight text-[#c6b9a9] truncate">{bar.heard}</span>}
      {bar.outcome && <span className={`text-[7px] leading-tight truncate ${OUTCOME_INK[bar.outcome.kind] || 'text-[#dbe4f2]'}`}>{bar.outcome.text}</span>}
    </div>
  );
}

/** How loud the mic is now, against the level that counts as speech. */
function MicMeter({ bar, recent, now }) {
  // A recording restarts every few seconds, with a moment between: the last
  // second of levels carries the meter over it
  const levels = recent.filter(r => now - r.at < 1200).map(r => r.level);
  const listening = !!bar && (typeof bar.level === 'number' || levels.length > 0);
  const level = listening ? Math.max(bar.level ?? 0, ...levels) : null;
  const speech = bar?.speechLevel, quiet = bar?.quietLevel;
  const scale = 100;
  const fill = level == null ? '' : level >= speech ? 'bg-[#6fdcc6]' : level >= quiet ? 'bg-[#ffc880]' : 'bg-[#5b6b82]';
  const said = !bar ? 'The voice bar isn’t connected'
    : !listening ? 'Not listening right now'
      : level >= speech ? 'Heard as speech'
        : level >= quiet ? 'Too soft to count'
          : 'Quiet';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-[13px] leading-5 text-[#c6b9a9]">
        <span className="flex items-center gap-1.5"><Icon name="mic" className="text-[16px]" />Mic</span>
        <span className="text-[12px] leading-4 tabular-nums text-right">
          {said}{typeof speech === 'number' && listening ? ` · ${Math.round(level)} / ${speech}` : ''}
        </span>
      </div>
      <div className="relative h-3" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={scale} aria-valuenow={level ?? 0}>
        <div className="absolute inset-0 rounded-full bg-[#0a1220] border border-white/[0.06] overflow-hidden">
          {level != null && <div className={`h-full ${fill} transition-[width] duration-150`} style={{ width: `${Math.min(100, (level / scale) * 100)}%` }} />}
        </div>
        {typeof speech === 'number' && (
          <span className="absolute -top-1 -bottom-1 w-[2px] rounded bg-[#dbe4f2]" style={{ left: `${(speech / scale) * 100}%` }} title={`Speech level ${speech}`} />
        )}
      </div>
    </div>
  );
}

function OverlayPreview({ screenQuery, voice, statusLoaded, connected, say, on, extensionConnected }) {
  const model = screenQuery.data;
  const read = model?.status === 'success' && Array.isArray(model.rect);
  const minimized = model?.code === 'MINIMIZED';
  const privacy = !!voice.privacyMode;
  const look = appLook(model?.app);

  // The voice bar's own reports, and the last second of mic levels for a steady meter
  const [bar, setBar] = useState(null);
  const recent = useRef([]);
  useEffect(() => on('overlay_state', msg => {
    const at = Date.now();
    recent.current = recent.current.filter(r => at - r.at < 1500);
    if (typeof msg.level === 'number') recent.current.push({ at, level: msg.level });
    setBar({ ...msg, at });
  }), [on]);
  const now = useTicker(1000);
  const live = !!bar && now - bar.at < 6000;

  const s = live ? bar.screen : null;
  const W = s?.w || 1920, H = s?.h || 1080, dpr = s?.dpr || 1;
  const workH = s?.availH && s.availH < H ? s.availH : Math.round(H * 0.955);
  const taskbarH = H - workH;
  const clock = new Date(now);
  const showApp = !privacy && (read || minimized) && !!model?.app;
  // While asleep or hidden, AbleSpeak only answers its wake phrases
  const blocked = !!voice.sleeping || !!voice.dismissed;
  const blockedWhy = voice.dismissed ? 'The voice bar is hidden. Show it first.' : voice.sleeping ? 'AbleSpeak is asleep. Resume voice first.' : undefined;

  // What AbleSpeak can do in the window in front
  const can = privacy ? 'Privacy mode: AbleSpeak isn’t reading the screen.'
    : minimized ? `It’s minimised. Say “bring ${look.name} to the front”.`
      : !read ? (statusLoaded && !screenQuery.isPending ? (model?.message || screenQuery.error?.message || 'No window to read') : 'Reading the screen…')
        : BROWSERS.has(look.key) ? (extensionConnected ? 'Can use: the web page’s links, buttons and forms' : 'Connect the Chrome extension to use web pages')
          : OFFICE.has(look.key) || model.office ? `Can use: the ${look.name} document, formatting and the ribbon`
            : `Can use: ${model.actionable ?? 0} buttons and fields`;

  return (
    <section aria-labelledby="preview-heading" className={`${CARD} p-5 flex flex-col gap-4`}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="preview-heading" className={SECTION}>User’s screen</h2>
        {privacy
          ? <span className="px-2 py-0.5 rounded-md bg-[#f5a623]/15 text-[var(--accent-soft)] text-[12px] font-medium">Privacy mode</span>
          : live
            ? <span className="flex items-center gap-1.5 text-[12px] font-medium text-[#6fdcc6]"><span className="w-1.5 h-1.5 rounded-full bg-[#6fdcc6] animate-pulse" />Live</span>
            : <span className={MUTED}>Voice bar not connected</span>}
      </div>

      <div className="grid gap-5 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)] items-center">
      {/* The monitor */}
      <div className="w-full max-w-[360px] mx-auto md:mx-0" aria-hidden="true">
        <div className="rounded-[14px] bg-gradient-to-b from-[#2b3341] to-[#171d27] p-[7px] pb-[10px] border border-white/[0.07] shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
          <div className="relative w-full overflow-hidden rounded-[5px]" style={{ aspectRatio: `${W} / ${H}`, background: WALLPAPER }}>
            {read && !privacy && <FrontWindow model={model} look={look} W={W} H={H} workH={workH} dpr={dpr} />}

            {/* A minimised window waits on the taskbar */}
            {minimized && !privacy && (
              <span
                className="absolute left-1/2 -translate-x-1/2 px-1.5 py-[3px] rounded bg-[#262e3b] border border-white/15 text-[8px] leading-none text-[#dbe4f2] whitespace-nowrap shadow"
                style={{ bottom: `calc(${pct(taskbarH, H)} + 5px)` }}
              >
                {look.name} · minimised
              </span>
            )}

            {live && <VoiceBarOnScreen bar={bar} W={W} H={H} hidden={!!voice.dismissed} />}

            {/* Taskbar: Start, search, the app in front, AbleSpeak, the clock */}
            <div className="absolute left-0 right-0 bottom-0 bg-[#1b2130]/90 backdrop-blur border-t border-white/10 flex items-center justify-center gap-[2.2%]" style={{ height: pct(taskbarH, H) }}>
              <span className="grid grid-cols-2 gap-[1.5px] h-[45%] aspect-square">
                {[0, 1, 2, 3].map(i => <span key={i} className="bg-[#4cc2ff] rounded-[1px]" />)}
              </span>
              <span className="h-[50%] w-[11%] rounded-full bg-white/10" />
              {showApp && (
                <span className="relative h-[55%] aspect-square flex items-center justify-center">
                  <AppGlyph look={look} className="w-full h-full text-[7px]" />
                  <span className={`absolute -bottom-[3px] left-1/2 -translate-x-1/2 h-[2px] rounded-full ${minimized ? 'w-1 bg-white/60' : 'w-2.5 bg-[#6fb6ff]'}`} />
                </span>
              )}
              <span className="h-[55%] aspect-square rounded-full bg-[#f5a623] flex items-center justify-center">
                <Icon name="mic" className="text-[8px] text-[#3d2600]" />
              </span>
              <span className="absolute right-[2%] text-[7px] leading-none text-[#dbe4f2]/85 tabular-nums">
                {pad(clock.getHours())}:{pad(clock.getMinutes())}
              </span>
            </div>

            {privacy && (
              <div className="absolute inset-0 backdrop-blur-md bg-[#0b1322]/70 flex flex-col items-center justify-center gap-1 text-[#dbe4f2]">
                <Icon name="visibility_off" className="text-[22px]" />
                <span className="text-[11px]">AbleSpeak isn’t looking at the screen</span>
              </div>
            )}
          </div>
        </div>
        {/* Stand */}
        <div className="mx-auto w-[16%] h-3 bg-gradient-to-b from-[#171d27] to-[#2b3341]" style={{ clipPath: 'polygon(14% 0, 86% 0, 100% 100%, 0 100%)' }} />
        <div className="mx-auto w-[32%] h-1.5 rounded-full bg-[#2b3341]" />
      </div>

      {/* The same, in words */}
      <div className="flex flex-col gap-4 min-w-0">
        <div className="flex items-start gap-2.5 min-w-0">
          {showApp ? <AppGlyph look={look} className="w-5 h-5 text-[11px] mt-0.5" /> : <Icon name={privacy ? 'visibility_off' : 'tab'} className="text-[20px] text-[#c6b9a9] mt-0.5" />}
          <div className="min-w-0">
            <p className="text-[14px] leading-5 text-[#dbe4f2] truncate" data-private>
              {privacy ? 'Privacy mode' : showApp ? `${look.name} · ${windowName(model.window, look)}` : 'The window in front'}
            </p>
            <p className={`text-[13px] leading-5 ${minimized ? 'text-[var(--accent-soft)]' : 'text-[#c6b9a9]'}`}>{can}</p>
          </div>
        </div>

        <div className="flex items-start gap-2.5 min-w-0 text-[13px] leading-5">
          <span className={`w-2 h-2 mt-1.5 mx-1.5 rounded-full shrink-0 ${live ? MODE_DOT[bar.mode] || 'bg-[#6fdcc6]' : 'bg-[#8a94a6]'}`} aria-hidden="true" />
          <div className="min-w-0">
            <p className="flex items-center gap-2 min-w-0">
              <span className="text-[#dbe4f2] font-medium shrink-0">{voice.dismissed ? 'Voice bar hidden' : live ? bar.label || 'Ready' : 'Voice bar'}</span>
              {live && bar.outcome && <span className={`truncate ${OUTCOME_INK[bar.outcome.kind] || 'text-[#dbe4f2]'}`}>{bar.outcome.text}</span>}
            </p>
            {live && bar.heard && <p className="text-[#c6b9a9] truncate">{bar.heard}</p>}
            {live && bar.bar && <p className="text-[#c6b9a9]">{placeOnScreen(bar.bar, W, H)}</p>}
          </div>
        </div>

        <MicMeter bar={live ? bar : null} recent={recent.current} now={now} />
      </div>
      </div>

      {/* The raw screen read is in Developer Hub → Context, for technical staff */}
      <div className="flex items-center gap-2 flex-wrap">
        {privacy ? (
          <button type="button" onClick={() => say('vision on')} disabled={!connected || blocked} title={blockedWhy} className={SMALL_QUIET}>
            <Icon name="visibility" className="text-[16px]" />Let it look
          </button>
        ) : (
          <button type="button" onClick={() => say('privacy mode')} disabled={!connected || !statusLoaded || blocked} title={blockedWhy} className={SMALL_QUIET}>
            <Icon name="visibility_off" className="text-[16px]" />Stop looking
          </button>
        )}
      </div>
    </section>
  );
}

// ── The student's listening settings, and the pause button ──
function SpeechControls({ student, profile, voice, connected, say }) {
  const queryClient = useQueryClient();
  const setSensitivity = useMutation({
    mutationFn: (sensitivity) => api.saveProfile(student.id, { listening: { sensitivity } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profile', student.id] }),
  });

  const current = profile?.listening?.sensitivity;
  const chosen = SENSITIVITY.find(s => s.value === current);
  const words = profile?.vocabulary || [];
  const shortcuts = profile?.aliases || [];
  const chips = [
    ...shortcuts.map(a => ({ key: `s:${a.say}`, text: `“${a.say}” → ${a.means}` })),
    ...words.map(w => ({ key: `w:${w}`, text: w })),
  ];

  return (
    <section aria-labelledby="speech-controls-heading" className={`${CARD} p-5 flex flex-col gap-4`}>
      <div>
        <h2 id="speech-controls-heading" className={SECTION}>Listening settings</h2>
        <p className={MUTED}>{student ? 'How AbleSpeak listens to you' : 'Sign in to Windows to keep your own settings.'}</p>
      </div>

      {!student ? null : (
        <>
          {/* How sensitive the microphone is, for the student in session */}
          <div className="flex flex-col gap-2">
            <span id="sensitivity-label" className={LABEL}>Sensitivity</span>
            <div className="flex gap-1 p-1 rounded-lg bg-[#0f1724] border border-white/[0.06]" role="group" aria-labelledby="sensitivity-label">
              {SENSITIVITY.map(s => {
                const on = current === s.value;
                return (
                  <button
                    key={s.value} type="button" aria-pressed={on}
                    disabled={!profile || setSensitivity.isPending}
                    onClick={() => !on && setSensitivity.mutate(s.value)}
                    className={`flex-1 min-h-[40px] px-1 rounded-md text-[13px] transition-colors disabled:cursor-not-allowed ${
                      on
                        ? 'bg-[#1d2736] text-[var(--accent-soft)] font-semibold shadow-sm'
                        : 'text-[#c6b9a9] hover:text-[#dbe4f2] hover:bg-[#0a1220] disabled:opacity-50'}`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            <p className={MUTED}>{chosen ? chosen.hint : 'Loading their settings…'}</p>
            <div aria-live="polite">
              {setSensitivity.isError && <p role="alert" className="text-[13px] text-[#ffb3aa]">{setSensitivity.error.message}</p>}
              {setSensitivity.isSuccess && <p className="text-[13px] text-[#6fdcc6]">Saved. AbleSpeak listens this way now.</p>}
            </div>
          </div>

          {/* Their own words and shortcuts */}
          <div className="flex flex-col gap-2 pt-1 border-t border-white/[0.06]">
            <div className="flex items-center justify-between gap-2 pt-3">
              <span className={LABEL}>Words and shortcuts</span>
              <span className={MUTED}>
                {profile ? `${words.length} word${words.length === 1 ? '' : 's'}, ${shortcuts.length} shortcut${shortcuts.length === 1 ? '' : 's'}` : ''}
              </span>
            </div>
            {!profile ? (
              <p className={MUTED}>Loading their settings…</p>
            ) : chips.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {chips.slice(0, 4).map(c => (
                  <li key={c.key} className="px-2 py-0.5 rounded-md bg-[#0a1220] border border-white/[0.06] text-[12px] leading-5 text-[#dbe4f2] max-w-full truncate">{c.text}</li>
                ))}
                {chips.length > 4 && <li className="px-2 py-0.5 text-[12px] leading-5 text-[#c6b9a9]">and {chips.length - 4} more</li>}
              </ul>
            ) : (
              <p className={MUTED}>None yet. Names and places AbleSpeak keeps mishearing go here.</p>
            )}
            <Link to={`/speech?student=${student.id}`} className={`${ROW_ACTION} self-start !px-0 !text-[var(--accent-soft)] hover:!bg-transparent hover:underline`}>
              Add a shortcut phrase
            </Link>
          </div>
        </>
      )}

      {/* Stop acting on speech, for everyone at this computer */}
      <div className="flex flex-col gap-2 pt-4 border-t border-white/[0.06]">
        {voice.sleeping ? (
          <button type="button" onClick={() => say('wake up')} disabled={!connected} className={`${PRIMARY} w-full`}>
            <Icon name="play_circle" className="text-[20px]" />Resume voice control
          </button>
        ) : (
          <button type="button" onClick={() => say('go to sleep')} disabled={!connected || !!voice.dismissed}
            className={`${BUTTON} w-full bg-[#ffb3aa]/10 hover:bg-[#ffb3aa]/15 text-[#ffb3aa] border border-[#ffb3aa]/30`}>
            <Icon name="pause_circle" className="text-[20px]" />Pause voice control
          </button>
        )}
        <p className={`${MUTED} text-center`}>
          {!connected
            ? 'Not connected to AbleSpeak, so this can’t be sent right now.'
            : voice.dismissed
              ? 'The voice bar is hidden, so AbleSpeak only listens for “come back”.'
              : voice.sleeping
                ? 'AbleSpeak is asleep. It ignores everything except “wake up”.'
                : 'Stops AbleSpeak acting on speech until someone says “wake up” or you resume it here.'}
        </p>
      </div>
    </section>
  );
}
