/**
 * My progress — how the person signed in uses AbleSpeak: their own numbers,
 * their commands day by day, what they say most and their recent commands.
 * Only ever this person's own data, never anyone else's.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

const TITLE = 'font-heading text-[26px] leading-8 font-semibold tracking-[-0.01em] text-[#dae3f4]';
const SECTION = 'font-heading text-[16px] leading-6 font-semibold text-[#dae3f4]';
const LABEL = 'text-[13px] leading-5 text-[#c9b8a5]';
const MUTED = 'text-[13px] leading-5 text-[#c9b8a5]';
const NUMBER = 'font-heading text-[28px] leading-9 font-semibold tracking-[-0.01em] text-[#dae3f4] tabular-nums';
const CARD = 'bg-[#141c28] rounded-xl border border-white/[0.06]';

// Worked / didn't work: validated for colour-blind readers on the #141c28 card
const WORKED = '#3b9ae1';
const MISSED = '#d4782f';

const RANGES = [7, 30, 90];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLabel = iso => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const asLatency = ms => (!ms ? null : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);

/** Every day in the range, oldest first, with none for days without commands. */
function fillDays(rows, days) {
  const byDay = new Map((rows || []).map(r => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = isoDay(d);
    const r = byDay.get(day);
    out.push({ day, total: r?.total || 0, succeeded: r?.succeeded || 0 });
  }
  return out;
}

export default function MyProgress() {
  const [days, setDays] = useState(30);
  const activeQuery = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });
  const me = activeQuery.data?.student || null;

  const progressQuery = useQuery({
    queryKey: ['progress', me?.id, days],
    queryFn: () => api.getProgress(me.id, days),
    enabled: !!me,
    refetchInterval: 30000,
  });
  const { data: recognition } = useQuery({
    queryKey: ['recognition', me?.id, Math.min(days, 90)],
    queryFn: () => api.getRecognition(me.id, Math.min(days, 90)),
    enabled: !!me,
    refetchInterval: 30000,
  });
  const { data: recentRows } = useQuery({
    queryKey: ['myCommands'],
    queryFn: () => api.getRecentCommands(100),
    enabled: !!me,
    refetchInterval: 30000,
  });

  const progress = progressQuery.data;
  const series = useMemo(() => fillDays(progress?.days, days), [progress, days]);
  const mine = (Array.isArray(recentRows) ? recentRows : []).filter(r => me && r.student_id === me.id).slice(0, 8);

  if (activeQuery.isPending) return <Page><p className={MUTED}>Loading…</p></Page>;
  if (!me) {
    return (
      <Page>
        <h1 className={TITLE}>My progress</h1>
        <p className={`${MUTED} mt-1`}>Nobody is signed in on this computer, so there is no progress to show yet.</p>
      </Page>
    );
  }

  const period = progress?.period;
  const since = progress?.allTime?.since;

  return (
    <Page>
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className={TITLE}>My progress</h1>
          <p className={`${MUTED} text-[14px] mt-1`}>
            How you’ve been using AbleSpeak, {me.name}.
            {since && progress.allTime.total ? ` ${progress.allTime.total} commands since ${dayLabel(since.slice(0, 10))}.` : ''}
          </p>
        </div>
        <div className="flex gap-1 p-1 rounded-lg bg-[#0f1724] border border-white/[0.06] self-start" role="group" aria-label="Time range">
          {RANGES.map(n => (
            <button key={n} type="button" aria-pressed={days === n} onClick={() => setDays(n)}
              className={`min-h-[36px] px-3 rounded-md text-[13px] transition-colors ${days === n
                ? 'bg-[#222a37] text-[#ffc880] font-semibold' : 'text-[#c9b8a5] hover:text-[#dae3f4] hover:bg-[#18202d]'}`}>
              {n} days
            </button>
          ))}
        </div>
      </header>

      {progressQuery.isError && (
        <p role="alert" className="text-[13px] text-[#ffb4ab]">Couldn’t load your progress: {progressQuery.error.message}</p>
      )}

      <section aria-label="Your numbers" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label="Commands" value={period ? period.total : null} note={`In the last ${days} days`} />
        <Stat label="Worked" value={period?.total ? `${percent(period.succeeded, period.total)}%` : null}
          note={period?.total ? `${period.succeeded} of ${period.total} commands` : 'Shows once you’ve used a command'} />
        <Stat label="Worked first time" value={recognition?.firstTimeRate != null ? `${Math.round(recognition.firstTimeRate * 100)}%` : null}
          note={recognition?.tasks ? `${recognition.firstTime} of ${recognition.tasks} tasks, no retry needed` : 'Shows once you’ve used a command'} />
        <Stat label="Average response" value={asLatency(period?.avgLatency)} note="From speaking to done" />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section aria-labelledby="per-day-heading" className={`lg:col-span-8 ${CARD} p-5 flex flex-col gap-4 min-w-0`}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 id="per-day-heading" className={SECTION}>Commands per day</h2>
            <div className="flex items-center gap-4 text-[13px] text-[#c9b8a5]" aria-hidden="true">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: WORKED }} />Worked</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: MISSED }} />Didn’t work</span>
            </div>
          </div>
          <DailyChart series={series} />
          <details className="text-[13px] text-[#c9b8a5]">
            <summary className="cursor-pointer w-fit hover:text-[#dae3f4]">Show as a table</summary>
            <table className="mt-2 w-full text-left">
              <thead><tr className="text-[12px]"><th className="font-medium py-1">Day</th><th className="font-medium py-1">Worked</th><th className="font-medium py-1">Didn’t work</th></tr></thead>
              <tbody>
                {series.filter(d => d.total).map(d => (
                  <tr key={d.day} className="border-t border-white/[0.06] text-[#dae3f4]">
                    <td className="py-1">{dayLabel(d.day)}</td><td className="py-1 tabular-nums">{d.succeeded}</td><td className="py-1 tabular-nums">{d.total - d.succeeded}</td>
                  </tr>
                ))}
                {!series.some(d => d.total) && <tr><td colSpan={3} className="py-1">No commands in this time.</td></tr>}
              </tbody>
            </table>
          </details>
        </section>

        <section aria-labelledby="top-heading" className={`lg:col-span-4 ${CARD} p-5 flex flex-col gap-3 min-w-0`}>
          <h2 id="top-heading" className={SECTION}>What you say most</h2>
          {progress?.topCommands?.length ? (
            <ol className="flex flex-col divide-y divide-white/[0.06]">
              {progress.topCommands.map(c => (
                <li key={c.text} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="text-[14px] text-[#dae3f4] truncate">“{c.text}”</span>
                  <span className={`${MUTED} tabular-nums shrink-0`}>{c.count}×</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={MUTED}>{progressQuery.isPending ? 'Loading…' : 'Your most-used commands appear here.'}</p>
          )}
        </section>
      </div>

      <section aria-labelledby="mine-heading" className={`${CARD} flex flex-col min-w-0`}>
        <h2 id="mine-heading" className={`${SECTION} px-5 pt-4 pb-3`}>Your recent commands</h2>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-[12px] leading-4 text-[#c9b8a5] border-y border-white/[0.06]">
              <th scope="col" className="font-medium px-5 py-2.5 w-[140px]">When</th>
              <th scope="col" className="font-medium px-3 py-2.5">What you said</th>
              <th scope="col" className="font-medium px-5 py-2.5 w-[140px]">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {mine.length ? mine.map(row => <MyCommand key={row.id} row={row} />) : (
              <tr><td colSpan={3} className={`${MUTED} px-5 py-8 text-center`}>Nothing yet. What you say to AbleSpeak will appear here.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </Page>
  );
}

function Page({ children }) {
  return (
    <div className="min-h-full w-full bg-[#0D1627] text-[#dae3f4] px-8 pt-7 pb-10">
      <div className="flex flex-col w-full gap-6">{children}</div>
    </div>
  );
}

function Stat({ label, value, note }) {
  return (
    <div className={`${CARD} px-5 py-4 flex flex-col gap-1 min-w-0`}>
      <h3 className={`${LABEL} truncate`}>{label}</h3>
      {value == null || value === ''
        ? <p className="font-heading text-[16px] leading-9 text-[#8b95a7]">No data yet</p>
        : <p className={NUMBER}>{value}</p>}
      {note && <p className={`${MUTED} truncate`}>{note}</p>}
    </div>
  );
}

// Stacked bars, one per day: worked below, didn't work above, a 2px gap between.
const CHART_W = 760, CHART_H = 220, AXIS_L = 32, AXIS_B = 24, TOP = 8;
function DailyChart({ series }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(4, ...series.map(d => d.total));
  const step = Math.max(1, Math.ceil(max / 4));
  const ticks = [0, step, step * 2, step * 3, step * 4];
  const top = step * 4;
  const plotW = CHART_W - AXIS_L, plotH = CHART_H - AXIS_B - TOP;
  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(22, slot * 0.62));
  const y = v => TOP + plotH - (v / top) * plotH;
  const labelEvery = series.length <= 7 ? 1 : series.length <= 31 ? 7 : 14;
  const total = series.reduce((s, d) => s + d.total, 0);
  const worked = series.reduce((s, d) => s + d.succeeded, 0);

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full h-auto" role="img"
        aria-label={`${total} commands over ${series.length} days, ${worked} worked. The table below lists each day.`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={AXIS_L} x2={CHART_W} y1={y(t)} y2={y(t)} stroke="#ffffff" strokeOpacity={t === 0 ? 0.16 : 0.06} />
            <text x={AXIS_L - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#8b95a7">{t}</text>
          </g>
        ))}
        {series.map((d, i) => {
          const x = AXIS_L + i * slot + (slot - barW) / 2;
          const missed = d.total - d.succeeded;
          const okTop = y(d.succeeded);
          const missTop = y(d.total);
          return (
            <g key={d.day}>
              {d.succeeded > 0 && <rect x={x} y={okTop} width={barW} height={Math.max(1, y(0) - okTop)} rx={Math.min(4, barW / 2)} fill={WORKED} />}
              {missed > 0 && <rect x={x} y={missTop} width={barW} height={Math.max(1, okTop - missTop - (d.succeeded ? 2 : 0))} rx={Math.min(4, barW / 2)} fill={MISSED} />}
              {i % labelEvery === (series.length - 1) % labelEvery && (
                <text x={x + barW / 2} y={CHART_H - 6} textAnchor="middle" fontSize="11" fill="#8b95a7">{dayLabel(d.day)}</text>
              )}
              {/* A hit area taller and wider than the bar */}
              <rect x={AXIS_L + i * slot} y={TOP} width={slot} height={plotH} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(h => (h === i ? null : h))} />
            </g>
          );
        })}
        {hover != null && (
          <line x1={AXIS_L + hover * slot + slot / 2} x2={AXIS_L + hover * slot + slot / 2} y1={TOP} y2={y(0)} stroke="#ffffff" strokeOpacity="0.12" pointerEvents="none" />
        )}
      </svg>
      {hover != null && (() => {
        const d = series[hover];
        const left = ((AXIS_L + hover * slot + slot / 2) / CHART_W) * 100;
        return (
          <div className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-lg bg-[#222a37] border border-white/10 px-3 py-2 text-[12px] leading-5 shadow-lg whitespace-nowrap"
            style={{ left: `${Math.min(88, Math.max(12, left))}%` }}>
            <p className="font-semibold text-[#dae3f4]">{dayLabel(d.day)}</p>
            <p className="text-[#c9b8a5]"><span className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: WORKED }} />Worked <span className="text-[#dae3f4] tabular-nums">{d.succeeded}</span></p>
            <p className="text-[#c9b8a5]"><span className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: MISSED }} />Didn’t work <span className="text-[#dae3f4] tabular-nums">{d.total - d.succeeded}</span></p>
          </div>
        );
      })()}
    </div>
  );
}

function MyCommand({ row }) {
  let text = '';
  try { text = JSON.parse(row.payload || '{}').text || ''; } catch { /* not JSON */ }
  const worked = row.outcome === 'success' || row.outcome === 'repaired';
  const when = row.created_at ? new Date(String(row.created_at).replace(' ', 'T')) : null;
  const whenText = when && !Number.isNaN(when.getTime())
    ? `${isoDay(when) === isoDay(new Date()) ? 'Today' : dayLabel(isoDay(when))}, ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';
  return (
    <tr className="hover:bg-[#18202d]/60">
      <td className="px-5 py-3 text-[13px] text-[#c9b8a5] whitespace-nowrap tabular-nums">{whenText}</td>
      <td className="px-3 py-3 text-[14px] text-[#dae3f4] break-words">{text ? `“${text}”` : <span className="text-[#c9b8a5]">Typed or follow-up command</span>}</td>
      <td className="px-5 py-3">
        <span className="flex items-center gap-1.5 text-[13px] whitespace-nowrap text-[#c9b8a5]">
          <span className="w-2 h-2 rounded-sm" style={{ background: worked ? WORKED : MISSED }} aria-hidden="true" />
          {row.outcome === 'repaired' ? 'Worked on retry' : worked ? 'Worked' : row.outcome === 'superseded' ? 'Tried again' : 'Didn’t work'}
        </span>
      </td>
    </tr>
  );
}
