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
const TITLE = 'font-heading text-[26px] leading-8 font-semibold tracking-[-0.01em] text-[#dae3f4]';
const SECTION = 'font-heading text-[16px] leading-6 font-semibold text-[#dae3f4]';
const LABEL = 'text-[13px] leading-5 text-[#c9b8a5]';
const MUTED = 'text-[13px] leading-5 text-[#c9b8a5]';
const NUMBER = 'font-heading text-[28px] leading-9 font-semibold tracking-[-0.01em] text-[#dae3f4] tabular-nums';

const CARD = 'bg-[#141c28] rounded-xl border border-white/[0.06]';
const BUTTON = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-lg text-[14px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const PRIMARY = `${BUTTON} bg-[#f5a623] hover:bg-[#ffb955] text-[#3d2600] font-semibold`;
const QUIET = `${BUTTON} bg-[#18202d] hover:bg-[#222a37] text-[#dae3f4] border border-white/[0.08]`;
const SMALL_QUIET = 'inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg text-[13px] font-medium bg-[#18202d] hover:bg-[#222a37] text-[#dae3f4] border border-white/[0.08] transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
// A small text action at the end of a list row
const ROW_ACTION = 'inline-flex items-center gap-1 min-h-[36px] px-2.5 rounded-md text-[13px] font-medium text-[#dae3f4] hover:bg-[#222a37] transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed';

const DOT = { ok: 'bg-[#68d9c3]', warn: 'bg-[#ffc880]', bad: 'bg-[#ffb4ab]', idle: 'bg-[#4a5466]' };
const INK = { ok: 'text-[#68d9c3]', warn: 'text-[#ffc880]', bad: 'text-[#ffb4ab]', idle: 'text-[#c9b8a5]' };
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
          Log<Icon name="lock" className="text-[14px] text-[#c9b8a5]" />
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
    <div className="min-h-full w-full bg-[#0D1627] text-[#dae3f4] px-8 pt-7 pb-6">
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
                Tools<Icon name="lock" className="text-[14px] text-[#c9b8a5]" />
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
              pending={pending}
              lastHeard={feed.find(i => i.heard)?.heard || null}
              student={student}
              profile={profile}
              connected={connected}
              say={say}
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
        <h2 id="can-do-heading" className="font-heading text-[18px] leading-7 font-semibold text-[#dae3f4]">What can I do?</h2>
        <p className="text-[13px] leading-5 text-[#c9b8a5]">Say it, or click to try.</p>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
        {CAPABILITIES.map(c => (
          <li key={c.key}>
            <button
              type="button"
              onClick={() => say(c.says[0])}
              disabled={!connected}
              title={connected ? `Does the same as saying “${c.says[0]}”. Also: ${c.says.slice(1).map(s => `“${s}”`).join(', ')}` : 'AbleSpeak isn’t connected'}
              className="group w-full min-h-[64px] px-3.5 py-3 rounded-xl bg-[#141c28] hover:bg-[#18202d] border border-white/[0.06] hover:border-white/[0.12] flex items-center gap-3 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <span className={`w-10 h-10 rounded-[10px] bg-gradient-to-br ${c.tile} flex items-center justify-center shrink-0`} aria-hidden="true">
                {c.letter
                  ? <span className="font-heading text-[18px] font-bold text-white leading-none">{c.letter}</span>
                  : <span className="material-symbols-outlined text-[20px] text-white">{c.icon}</span>}
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[15px] leading-5 font-semibold text-[#dae3f4]">{c.title}</span>
                <span className="text-[13px] leading-5 text-[#c9b8a5] truncate">“{c.says[0]}”</span>
              </span>
              <span className="material-symbols-outlined text-[20px] text-[#8b95a7] group-hover:text-[#dae3f4] shrink-0" aria-hidden="true">chevron_right</span>
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
        ? <p className="font-heading text-[16px] leading-9 text-[#8b95a7]">No data yet</p>
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
      <p className="font-heading text-[18px] leading-9 font-semibold text-[#dae3f4] truncate" title={valueTitle}>
        {value ?? <span className="font-normal text-[16px] text-[#8b95a7]">Checking…</span>}
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
              className={`rounded-lg bg-[#18202d] px-3 py-2 text-[13px] leading-5 text-[#dae3f4] border-l-2 ${a.status === 'error' ? 'border-[#ffb4ab]' : 'border-[#ffc880]'}`}>
              <span className="font-medium">{a.component}</span>: <span className="text-[#c9b8a5]">{a.message}</span>
            </li>
          ))}
        </ul>
      )}

      <ul className="flex flex-col divide-y divide-white/[0.06]">
        {rows.map(row => (
          <li key={row.key} className="flex items-center gap-3 py-2.5">
            <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[row.tone]}`} aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-[14px] leading-5 font-medium text-[#dae3f4]">
                {row.name}<span className="sr-only">: {TONE_WORD[row.tone]}</span>
              </p>
              <p className={`${MUTED} truncate`} title={row.detailTitle}>{row.detail}</p>
            </div>
            {row.action}
          </li>
        ))}
      </ul>
      <p id="clear-history-result" aria-live="polite" className={clearHistory.isError ? 'text-[13px] text-[#ffb4ab]' : 'sr-only'}>
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
          <div className="mx-5 mb-3 rounded-lg bg-[#18202d] border-l-2 border-[#ffc880] px-4 py-3 flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-[13px] text-[#ffc880]">
                <Icon name="progress_activity" className="text-[16px] animate-spin" />Working on it
              </span>
              <span className={MUTED}>{pending.progress || `Heard ${asClock(pending.at)}${pending.asrMs ? ` in ${asLatency(pending.asrMs)}` : ''}`}</span>
            </div>
            <p className="text-[14px] leading-5 text-[#dae3f4] break-words">“{pending.text}”</p>
            {pending.step && <p className={MUTED}>{pending.step}</p>}
          </div>
        ) : !connected ? (
          <p className={`${MUTED} px-5 pb-3`}>Not connected to AbleSpeak. New commands appear here once it reconnects.</p>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-[12px] leading-4 text-[#c9b8a5] border-y border-white/[0.06]">
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
          <button type="button" onClick={() => setExpanded(e => !e)} aria-expanded={expanded} className={`${ROW_ACTION} !text-[#ffc880]`}>
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
    <tr className="align-top hover:bg-[#18202d]/60 transition-colors">
      <td className="px-5 py-3 text-[13px] leading-5 text-[#c9b8a5] tabular-nums whitespace-nowrap" title={asClock(item.at)}>{asShortClock(item.at)}</td>
      <td className="px-3 py-3 min-w-0">
        <p className="text-[14px] leading-5 text-[#dae3f4] break-words" title={!failed && item.note ? item.note : undefined}>
          {item.heard ? `“${item.heard}”` : <span className="text-[#c9b8a5]">Typed or follow-up command</span>}
        </p>
        {item.tools.length > 0 && (
          <p className="mt-0.5 font-mono text-[12px] leading-4 text-[#8b95a7] break-words">
            {item.tools.map((t, i) => (
              <span key={i} className={t.failed ? 'text-[#ffb4ab]' : undefined}>
                {i > 0 ? ' → ' : ''}{t.name}{t.failed && <span className="sr-only"> (failed)</span>}
              </span>
            ))}
          </p>
        )}
        {failed && item.note && <p className="mt-1 text-[13px] leading-5 text-[#ffb4ab] line-clamp-2 break-words">{item.note}</p>}
      </td>
      <td className="px-3 py-3">
        <span className={`flex items-center gap-1.5 text-[13px] leading-5 whitespace-nowrap ${INK[look.tone]}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${DOT[look.tone]}`} aria-hidden="true" />{look.label}
        </span>
      </td>
      <td className="px-5 py-3 text-[13px] leading-5 text-[#c9b8a5] text-right tabular-nums whitespace-nowrap">
        {asLatency(item.latency) || ''}
      </td>
    </tr>
  );
}

// ── A picture of the student's screen with the voice bar on it ──
const ACTING = new Set(['invoke', 'toggle', 'select', 'set_value', 'expand', 'collapse']);

/** The window's controls, drawn where they sit, from the screen model (not a screenshot). */
function ScreenOutline({ model }) {
  const [wx, wy, W, H] = Array.isArray(model?.rect) ? model.rect : [];
  if (!W || !H) return null;
  const boxes = (model.elements || [])
    .filter(e => Array.isArray(e.rect) && e.rect[2] > 2 && e.rect[3] > 2 && !(e.rect[2] >= W * 0.95 && e.rect[3] >= H * 0.9))
    .slice(0, 200);
  return (
    <svg className="absolute inset-0 w-full h-full opacity-30" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect x="0" y="0" width={W} height={H} fill="#18202d" />
      {boxes.map((e, i) => {
        const acts = Array.isArray(e.actions) && e.actions.some(a => ACTING.has(a));
        return (
          <rect
            key={`${e.ref}-${i}`}
            x={e.rect[0] - wx} y={e.rect[1] - wy} width={e.rect[2]} height={e.rect[3]} rx="4"
            fill={acts ? '#68d9c3' : 'none'} fillOpacity={acts ? 0.3 : 0}
            stroke={acts ? '#68d9c3' : '#dae3f4'} strokeOpacity={acts ? 1 : 0.6}
            strokeWidth="1" vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

function OverlayPreview({ screenQuery, voice, statusLoaded, pending, lastHeard, student, profile, connected, say }) {
  const model = screenQuery.data;
  const read = model?.status === 'success';
  const privacy = !!voice.privacyMode;

  const note = privacy
    ? <span className="px-2 py-0.5 rounded-md bg-[#f5a623]/15 text-[#ffc880] text-[12px] font-medium">Privacy mode</span>
    : <span className={MUTED}>{read ? `Updated every ${SCREEN_POLL_MS / 1000} s` : screenQuery.isPending && statusLoaded ? 'Reading…' : 'Not read'}</span>;

  const windowText = privacy ? 'Privacy mode: the screen isn’t read'
    : read ? model.window || model.app || 'Untitled window'
      : !statusLoaded || screenQuery.isPending ? 'Reading the screen…'
        : model?.code === 'MINIMIZED' ? 'The front window is minimized'
          : model?.message || screenQuery.error?.message || 'No window to read';

  const barState = voice.dismissed ? { text: 'Hidden', cls: 'text-[#c9b8a5]' }
    : pending ? { text: 'Working', cls: 'text-[#ffc880]' }
      : voice.sleeping ? { text: 'Asleep', cls: 'text-[#ffc880]' }
        : voice.dictationMode ? { text: 'Dictating', cls: 'text-[#68d9c3]' }
          : { text: 'Ready', cls: 'text-[#68d9c3]' };
  const barText = pending ? `“${pending.text}”` : lastHeard ? `“${lastHeard}”` : 'Say a command';
  const pauseSeconds = student ? profile?.listening?.pauseSeconds : 1.5;
  // While asleep or hidden, AbleSpeak only answers its wake phrases
  const blocked = !!voice.sleeping || !!voice.dismissed;
  const blockedWhy = voice.dismissed ? 'The voice bar is hidden. Show it first.' : voice.sleeping ? 'AbleSpeak is asleep. Resume voice first.' : undefined;

  return (
    <section aria-labelledby="preview-heading" className={`${CARD} p-5 flex flex-col gap-4`}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="preview-heading" className={SECTION}>User’s screen</h2>
        {note}
      </div>

      <div className="relative w-full rounded-lg overflow-hidden bg-[#060e1b] p-3 flex flex-col justify-between h-56 border border-white/[0.04]">
        {read && !privacy && <ScreenOutline model={model} />}

        <div className="relative flex items-center justify-between gap-3 text-[12px] leading-4 text-[#c9b8a5] bg-[#222a37]/80 backdrop-blur-md px-3 py-1.5 rounded-md">
          <span className="flex items-center gap-1.5 min-w-0">
            <Icon name={privacy ? 'visibility_off' : 'tab'} className="text-[15px]" />
            <span className="truncate" data-private>{windowText}</span>
          </span>
          {read && !privacy && Array.isArray(model.rect) && <span className="shrink-0 tabular-nums">{model.rect[2]} × {model.rect[3]}</span>}
        </div>

        {/* The voice bar as the student sees it */}
        <div className={`relative self-center w-72 max-w-full rounded-xl bg-[#222a37]/95 backdrop-blur-xl px-3 py-2.5 shadow-xl flex flex-col gap-2 border border-white/10 ${voice.dismissed ? 'opacity-40' : ''}`}>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[#dae3f4]">
              <span className={`w-2 h-2 rounded-full bg-[#ffc880] ${voice.dismissed || voice.sleeping ? '' : 'animate-pulse'}`} />AbleSpeak
            </span>
            <span className={`text-[12px] ${barState.cls}`}>{barState.text}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 bg-[#060e1b]/80 rounded-md px-2 py-1.5 text-[13px] text-[#dae3f4] truncate">{barText}</div>
            <span className="w-8 h-8 rounded-full bg-[#f5a623] text-[#3d2600] flex items-center justify-center shrink-0" aria-hidden="true">
              <Icon name="mic" className="text-[18px]" />
            </span>
          </div>
        </div>

        <div className={`relative flex items-center justify-between gap-3 ${MUTED}`}>
          <span title="The pause that ends a command">{pauseSeconds != null ? `${Number(pauseSeconds).toFixed(1)} s pause ends a command` : ''}</span>
          <span>{voice.dismissed ? 'Hidden' : 'Bottom centre'}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Link to="/developer/context" className={SMALL_QUIET} aria-label="Screen details (admin PIN needed)">
          Screen details<Icon name="lock" className="text-[14px] text-[#c9b8a5]" />
        </Link>
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
                        ? 'bg-[#222a37] text-[#ffc880] font-semibold shadow-sm'
                        : 'text-[#c9b8a5] hover:text-[#dae3f4] hover:bg-[#18202d] disabled:opacity-50'}`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            <p className={MUTED}>{chosen ? chosen.hint : 'Loading their settings…'}</p>
            <div aria-live="polite">
              {setSensitivity.isError && <p role="alert" className="text-[13px] text-[#ffb4ab]">{setSensitivity.error.message}</p>}
              {setSensitivity.isSuccess && <p className="text-[13px] text-[#68d9c3]">Saved. AbleSpeak listens this way now.</p>}
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
                  <li key={c.key} className="px-2 py-0.5 rounded-md bg-[#18202d] border border-white/[0.06] text-[12px] leading-5 text-[#dae3f4] max-w-full truncate">{c.text}</li>
                ))}
                {chips.length > 4 && <li className="px-2 py-0.5 text-[12px] leading-5 text-[#c9b8a5]">and {chips.length - 4} more</li>}
              </ul>
            ) : (
              <p className={MUTED}>None yet. Names and places AbleSpeak keeps mishearing go here.</p>
            )}
            <Link to={`/speech?student=${student.id}`} className={`${ROW_ACTION} self-start !px-0 !text-[#ffc880] hover:!bg-transparent hover:underline`}>
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
            className={`${BUTTON} w-full bg-[#ffb4ab]/10 hover:bg-[#ffb4ab]/15 text-[#ffb4ab] border border-[#ffb4ab]/30`}>
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
