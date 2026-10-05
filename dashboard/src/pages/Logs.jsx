/**
 * Developer hub › Logs — what the AbleSpeak engine is doing, as it happens.
 * The last lines come from GET /api/logs/recent, then new ones arrive over
 * the dashboard WebSocket (log_event). Built from the "Logs tab preview" in
 * the Stitch "Developer hub" screen (docs/design/stitch/developer-hub.html);
 * the Tools tab shows the same panel, cut to the newest lines.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { SECTION, MUTED, CARD, QUIET, DOT, INK } from '../lib/ui';

// The server keeps the latest 200 lines (log-tailer.js, maxRecent) and
// checks the log file every second; this page keeps the same 200.
const BUFFER = 200;
const PREVIEW_LINES = 5;
const LEVELS = ['INFO', 'WARN', 'ERROR'];

// Each level as a dot and a word, in the dashboard's status colours
const LEVEL_TONE = { INFO: 'ok', WARN: 'warn', ERROR: 'bad', DEBUG: 'idle' };
const LEVEL_WORD = { INFO: 'Info', WARN: 'Warning', ERROR: 'Error', DEBUG: 'Debug' };
const levelWord = l => LEVEL_WORD[l] || (l ? String(l).charAt(0) + String(l).slice(1).toLowerCase() : 'Debug');
const ROW = { WARN: 'bg-[#ffc880]/[0.04]', ERROR: 'bg-[#ffb4ab]/[0.05]' };
const MESSAGE = { INFO: 'text-[#dae3f4]', WARN: 'text-[#dae3f4]', ERROR: 'text-[#dae3f4]', DEBUG: 'text-[#c9b8a5]' };

function Icon({ name, className = '', style }) {
  return <span className={`material-symbols-outlined ${className}`} style={style} aria-hidden="true">{name}</span>;
}

function todayLocal() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-09-21 10:48:11" → "10:48:11" today, "09-20 10:48:11" on other days. */
function when(timestamp, today) {
  if (!timestamp) return '';
  const [date, time] = String(timestamp).split(' ');
  if (!time) return timestamp;
  return date === today ? time : `${date.slice(5)} ${time}`;
}

/** A log message with the names of the AI's tools picked out, as the design shows them. */
function MessageText({ text, toolNames }) {
  if (!toolNames.size) return text;
  return String(text).split(/(\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b)/g).map((part, i) => (
    i % 2 && toolNames.has(part)
      ? <code key={i} className="text-[#ffc880]">{part}</code>
      : part
  ));
}

const SEG = 'min-h-[36px] px-3 rounded-md text-[13px] flex items-center gap-1.5 transition-colors';
const SEG_ON = `${SEG} bg-[#222a37] text-[#ffc880] font-semibold`;
const SEG_OFF = `${SEG} text-[#c9b8a5] hover:text-[#dae3f4] hover:bg-[#18202d]`;

/**
 * The log card. `preview` shows only the newest lines, for the Tools tab,
 * with a way to the full Logs tab.
 */
export function LogPanel({ preview = false, headingId = 'logs-heading' }) {
  const [level, setLevel] = useState(null);
  const [logs, setLogs] = useState([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const containerRef = useRef(null);
  const { on, connected } = useWebSocket();

  // Everything the server holds; the level filter is applied here, so the
  // counts on the level chips are always for the same lines.
  const { data: initialLogs, isError, refetch } = useQuery({
    queryKey: ['recentLogs', 'all', BUFFER],
    queryFn: () => api.getRecentLogs({ limit: BUFFER }),
    staleTime: 10000,
  });
  // Tool names in a line are picked out
  const { data: catalog } = useQuery({ queryKey: ['tools'], queryFn: api.getTools, staleTime: 30000 });
  const toolNames = useMemo(
    () => new Set((catalog?.categories || []).flatMap(cat => cat.tools.map(t => t.name))),
    [catalog],
  );

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    if (Array.isArray(initialLogs) && !pausedRef.current) setLogs(initialLogs.slice(-BUFFER));
  }, [initialLogs]);

  // Live lines. While paused the list stays still; resuming reloads what the
  // server kept, so nothing that arrived in the meantime is lost.
  useEffect(() => on('log_event', msg => {
    if (pausedRef.current || !msg.event) return;
    setLogs(prev => [...prev, msg.event].slice(-BUFFER));
  }), [on]);

  const togglePause = async () => {
    if (!paused) {
      setPaused(true);
      return;
    }
    setPaused(false);
    const { data } = await refetch();
    if (Array.isArray(data)) setLogs(data.slice(-BUFFER));
  };

  const counts = useMemo(() => {
    const c = { INFO: 0, WARN: 0, ERROR: 0 };
    logs.forEach(l => { if (l.level in c) c[l.level] += 1; });
    return c;
  }, [logs]);
  const filtered = level ? logs.filter(l => l.level === level) : logs;
  const shown = preview ? filtered.slice(-PREVIEW_LINES) : filtered;
  const today = todayLocal();

  // Keep the newest line in view unless paused
  useEffect(() => {
    if (!preview && !paused && containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [logs, paused, level, preview]);

  const state = paused ? 'Paused' : connected ? 'Live stream' : 'Offline';
  const stateTone = paused ? 'warn' : connected ? 'ok' : 'bad';
  const Heading = preview ? 'h3' : 'h2';

  return (
    <div className={`${CARD} p-5 flex flex-col gap-4`}>
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex flex-col gap-0.5">
          <Heading id={headingId} className={`${SECTION} flex items-center gap-3 flex-wrap`}>
            <span>{preview ? 'Logs tab preview' : 'Logs'}</span>
            <span role="status" className={`flex items-center gap-1.5 text-[13px] leading-5 font-sans font-normal ${INK[stateTone]}`}>
              <span className={`w-2 h-2 rounded-full ${DOT[stateTone]}`} aria-hidden="true" />
              {state}
            </span>
          </Heading>
          <p className={MUTED}>
            {preview
              ? 'The newest lines from the AbleSpeak engine, live. The Logs tab has them all.'
              : 'What the AbleSpeak engine is doing, as it happens.'}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={togglePause} aria-pressed={paused} className={QUIET}>
            <Icon name={paused ? 'play_arrow' : 'pause'} className="text-[18px] text-[#c9b8a5]" />
            <span>{paused ? 'Resume scrolling' : 'Pause scrolling'}</span>
          </button>
          {preview && (
            <Link to="/developer/logs" className={QUIET}>
              <span>Open Logs tab</span>
              <Icon name="arrow_forward" className="text-[18px] text-[#c9b8a5]" />
            </Link>
          )}
        </div>
      </div>

      {/* Level filter */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div role="group" aria-label="Filter by log level" className="flex gap-1 p-1 rounded-lg bg-[#0f1724] border border-white/[0.06] flex-wrap">
          <button type="button" aria-pressed={!level} onClick={() => setLevel(null)} className={!level ? SEG_ON : SEG_OFF}>
            <span>All</span>
            <span className="text-[12px] font-normal text-[#8b95a7] tabular-nums">{logs.length}</span>
          </button>
          {LEVELS.map(l => {
            const selected = level === l;
            return (
              <button key={l} type="button" aria-pressed={selected} onClick={() => setLevel(l)} className={selected ? SEG_ON : SEG_OFF}>
                <span className={`w-2 h-2 rounded-full ${DOT[LEVEL_TONE[l]]}`} aria-hidden="true" />
                <span>{levelWord(l)}</span>
                <span className="text-[12px] font-normal text-[#8b95a7] tabular-nums">{counts[l]}</span>
              </button>
            );
          })}
        </div>
        <span className="text-[12px] leading-5 text-[#8b95a7]">Log file checked every 1s · Keeps the latest {BUFFER} lines</span>
      </div>

      {/* The lines */}
      <div
        ref={containerRef}
        role="log"
        aria-label={preview ? 'Newest AbleSpeak log lines' : 'AbleSpeak log output'}
        aria-live={preview || paused ? 'off' : 'polite'}
        tabIndex={0}
        className={`bg-[#0f1724] border border-white/[0.06] rounded-lg p-2 font-mono text-[12px] leading-5 flex flex-col gap-0.5 ${
          preview ? 'overflow-x-auto' : 'h-[480px] overflow-y-auto'
        }`}
      >
        {shown.length === 0 && (
          <p className="font-sans text-[13px] leading-5 text-[#8b95a7] px-2 py-1.5">
            {isError ? "Couldn't load the logs. Check the AbleSpeak server is running, then reload."
              : logs.length === 0 ? 'Waiting for log events…'
              : `No ${levelWord(level).toLowerCase()} lines in the latest ${logs.length}.`}
          </p>
        )}
        {shown.map((log, i) => {
          const tone = LEVEL_TONE[log.level] || 'idle';
          return (
            <div key={`${log.timestamp}-${logs.length - shown.length + i}`} className={`flex items-start gap-3 py-1.5 px-2 rounded hover:bg-white/[0.03] transition-colors ${ROW[log.level] || ''}`}>
              <span className="text-[#8b95a7] select-none shrink-0 whitespace-nowrap tabular-nums">{when(log.timestamp, today)}</span>
              <span className={`w-[72px] shrink-0 flex items-center gap-1.5 font-sans ${INK[tone]}`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[tone]}`} aria-hidden="true" />
                {levelWord(log.level)}
              </span>
              <span className={`min-w-0 [overflow-wrap:anywhere] ${MESSAGE[log.level] || MESSAGE.DEBUG}`}>
                <MessageText text={log.message} toolNames={toolNames} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Logs() {
  return (
    <section aria-labelledby="logs-heading">
      <LogPanel />
    </section>
  );
}
