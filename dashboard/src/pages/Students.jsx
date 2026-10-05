/**
 * Students — who is using this computer, and how each student is progressing
 * toward their Tier 2 goals. Built class for class from the Stitch "Students"
 * screen (docs/design/stitch/students.html, its <main>):
 *   1. Who is using this computer: start or end a student's session, add or remove students
 *   2. Success rate, all students: five class-wide numbers
 *   3. Usage by user: a table of every student; a row picks whose progress is shown
 *   4. Progress for that student: decision flags, the chart (aim line,
 *      Theil–Sen trend, phase changes, today), mark met / discontinue
 *   5. Their goals (with the new-goal form) beside "Mark a phase change"
 *
 * Everything shown comes from the server. Where the design showed something
 * the app has no data for, the nearest real value is shown instead.
 * How well a student is heard, and their speech settings, are on the Speech
 * profile page (SpeechProfile.jsx).
 */
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  TITLE, SECTION, LABEL, MUTED, BODY, NUMBER, PAGE, CARD, WELL, DIVIDER,
  PRIMARY, QUIET, DANGER, SMALL_QUIET, ROW_ACTION, FIELD, DOT, INK, TH, TD,
} from '../lib/ui';

// Today in this computer's time zone — the server counts days the same way.
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Inline math (mirrors server/src/progress-rules.js — no shared import) ──

const MEASURE_REGISTRY = {
  independence_rate: { label: 'Independence rate', description: 'Tasks completed without any prompts', lowerIsBetter: false },
  task_completion: { label: 'Task completion', description: 'Tasks completed (success or repaired)', lowerIsBetter: false },
  prompts_to_complete: { label: 'Prompts to complete', description: 'Average prompts needed — lower is better', lowerIsBetter: true },
};

function aimValueAt(goal, isoDate) {
  const { baseline_date, baseline_value, target_date, target_value } = goal;
  if (isoDate <= baseline_date) return Number(baseline_value);
  if (isoDate >= target_date) return Number(target_value);
  const baseMs = new Date(baseline_date).getTime();
  const targetMs = new Date(target_date).getTime();
  const dateMs = new Date(isoDate).getTime();
  const t = (dateMs - baseMs) / (targetMs - baseMs);
  return Number(baseline_value) + t * (Number(target_value) - Number(baseline_value));
}

function theilSenSlope(points) {
  if (!points || points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  if (new Set(sorted.map(p => p.measured_at)).size < 2) return null;
  const slopes = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const days = (new Date(sorted[j].measured_at) - new Date(sorted[i].measured_at)) / 86400000;
      if (days !== 0) slopes.push((Number(sorted[j].value) - Number(sorted[i].value)) / days);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const m = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 0 ? (slopes[m - 1] + slopes[m]) / 2 : slopes[m];
}

function trendLine(points) {
  if (!points || points.length < 2) return null;
  const slope = theilSenSlope(points);
  if (slope === null) return null;
  const sorted = [...points].sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  const originMs = new Date(sorted[0].measured_at).getTime();
  const ics = sorted.map(p => Number(p.value) - slope * ((new Date(p.measured_at).getTime() - originMs) / 86400000));
  ics.sort((a, b) => a - b);
  const m = Math.floor(ics.length / 2);
  const intercept = ics.length % 2 === 0 ? (ics[m - 1] + ics[m]) / 2 : ics[m];
  return { slope, intercept };
}

// ── Formatting ──

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function splitDate(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  return y && m && d ? { y, m, d } : null;
}

/** "2026-09-15…" → "15 Sep 2026" (or "15 Sep"). */
function fmtDate(iso, withYear = true) {
  if (!iso) return '';
  const p = splitDate(iso);
  if (!p) return String(iso);
  return withYear ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : `${p.d} ${MONTHS[p.m - 1]}`;
}

/** "2026-09-01" → "Sep 01, 2026", as the design writes a goal's dates. */
function fmtGoalDate(iso) {
  const p = splitDate(iso);
  if (!p) return String(iso || '');
  return `${MONTHS[p.m - 1]} ${String(p.d).padStart(2, '0')}, ${p.y}`;
}

const num = n => Number(n || 0).toLocaleString('en-US');
const firstName = name => String(name || '').trim().split(/\s+/)[0] || name;

/** Whole days between a "YYYY-MM-DD HH:MM:SS" stamp and today, or null. */
function daysAgo(stamp) {
  if (!stamp || stamp === '—') return null;
  const when = new Date(String(stamp).replace(' ', 'T'));
  if (Number.isNaN(when.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  when.setHours(0, 0, 0, 0);
  return Math.round((today - when) / 86400000);
}

/** When a student last gave a voice command: "Today 10:02", "Yesterday 14:10" or "14 Sep 2026". */
function lastActiveText(stamp) {
  const ago = daysAgo(stamp);
  if (ago === null) return stamp && stamp !== '—' ? String(stamp) : null;
  const time = String(stamp).slice(11, 16);
  if (ago === 0) return `Today ${time}`;
  if (ago === 1) return `Yesterday ${time}`;
  return fmtDate(stamp);
}

/** "Last active yesterday", "Last active 3 days ago". */
function lastActiveAgo(stamp) {
  const ago = daysAgo(stamp);
  if (ago === null) return 'No voice commands yet';
  if (ago <= 0) return 'Last active today';
  if (ago === 1) return 'Last active yesterday';
  return `Last active ${ago} days ago`;
}

/** Rates are stored from 0 to 1 and shown as percentages; prompt counts as numbers. */
function isRateGoal(goal, values = []) {
  if (MEASURE_REGISTRY[goal.measure]?.lowerIsBetter) return false;
  return [goal.baseline_value, goal.target_value, ...values].every(v => Number(v) <= 1);
}
function fmtMeasure(v, asRate) {
  return asRate ? `${Math.round(Number(v) * 100)}%` : Number(v).toFixed(1);
}

// The kinds of voice command the server records (server/src/ws-proxy.js).
// The analytics give the most used kind, not the words spoken, so the kind is shown.
const COMMAND_KIND = { voice_fast: 'Quick command', voice: 'AI command', voice_task: 'Multi-step task' };
function commandKind(type) {
  if (!type || type === '—') return '—';
  if (COMMAND_KIND[type]) return COMMAND_KIND[type];
  const words = String(type).replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Success-rate bands: 80% and over is good, 50% and over is fair, below that is low
function rateTone(s) {
  if (!s || s.commands === 0) return null;
  if (s.successRate >= 80) return 'good';
  if (s.successRate >= 50) return 'fair';
  return 'low';
}
// Each band as a status: a dot and a word
const RATE_STYLE = {
  good: { tone: 'ok', label: 'Good' },
  fair: { tone: 'warn', label: 'Fair' },
  low: { tone: 'bad', label: 'Low' },
};

// ── Page-only classes, built on the shared ones in lib/ui ──

const FIELD_LABEL = `block mb-1.5 ${LABEL}`;
const SELECT = `${FIELD} cursor-pointer`;
const INPUT = FIELD;
const TEXTAREA = `${FIELD} py-2.5 resize-none`;
const HELP = 'text-[13px] leading-5 text-[#c9b8a5]';
const ERROR_TEXT = 'text-[13px] leading-5 text-[#ffb4ab]';
const NO_DATA = 'text-[13px] text-[#8b95a7]';
const SMALL_DANGER = 'inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg text-[13px] font-medium bg-[#ffb4ab]/10 hover:bg-[#ffb4ab]/15 text-[#ffb4ab] border border-[#ffb4ab]/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** Status as a small dot and a word. */
function Status({ tone, children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] leading-5 whitespace-nowrap ${INK[tone]} ${className}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[tone]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

// ── Icons (they take the colour of the text around them) ──

const Svg = ({ className, strokeWidth = 2, children }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={strokeWidth} aria-hidden="true">{children}</svg>
);
const PlayIcon = ({ className = 'w-4 h-4' }) => <Svg className={className} strokeWidth={2.5}><polygon points="5 3 19 12 5 21 5 3" /></Svg>;
const StopIcon = () => <Svg className="w-4 h-4"><rect x="6" y="6" width="12" height="12" rx="2" /></Svg>;
const PlusIcon = ({ className = 'w-4 h-4' }) => (
  <Svg className={className} strokeWidth={2.5}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Svg>
);
const CloseIcon = () => (
  <Svg className="w-4 h-4" strokeWidth={2.5}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></Svg>
);
const CheckIcon = ({ className = 'w-4 h-4', strokeWidth = 2.5 }) => (
  <Svg className={className} strokeWidth={strokeWidth}><polyline points="20 6 9 17 4 12" /></Svg>
);
const MicIcon = () => (
  <Svg className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" />
  </Svg>
);

/** Nothing to show yet: one quiet sentence. */
function EmptyNote({ children }) {
  return <p className={`${MUTED} py-6`}>{children}</p>;
}

function ErrorNote({ children }) {
  return <p role="alert" className={ERROR_TEXT}>{children}</p>;
}

// ── Decision flags in plain words ──

function flagInfo(rule, goal) {
  const lower = !!MEASURE_REGISTRY[goal.measure]?.lowerIsBetter;
  switch (rule) {
    case '4_below_aim':
      return {
        good: false,
        name: 'Behind the aim line',
        text: lower
          ? '4 points in a row above the aim line (more prompts than planned), consider changing the support'
          : '4 consecutive points below the aim line, consider changing the support',
      };
    case '4_above_aim':
      return {
        good: true,
        name: 'Ahead of the aim line',
        text: lower
          ? '4 points in a row below the aim line (fewer prompts than planned), the user is doing better than planned'
          : '4 consecutive points above the aim line, the user is doing better than planned',
      };
    case 'trend_divergence':
      return { good: false, name: 'Trend going the wrong way', text: 'The trend is heading away from the goal, review the support' };
    case 'insufficient_data':
      return { good: false, name: 'Not enough recent data', text: 'Fewer than 3 data points in the last 14 days, collect data more often' };
    default:
      return { good: false, name: 'Review this goal', text: 'Something about this goal needs a look' };
  }
}

/** The dates of the points a "4 in a row" flag was raised on (stored with the flag). */
function flaggedDates(flags, rule) {
  const dates = new Set();
  for (const f of flags) {
    if (f.rule !== rule || !f.detail) continue;
    try {
      const detail = typeof f.detail === 'string' ? JSON.parse(f.detail) : f.detail;
      for (const p of detail?.points || []) dates.add(p.measured_at);
    } catch { /* the detail is optional */ }
  }
  return dates;
}

function FlagGroup({ flags, goal, good, onAck, ackingId }) {
  if (!flags.length) return null;
  const title = good ? 'Good news' : `${flags.length} decision flag${flags.length !== 1 ? 's' : ''}`;
  return (
    <div className={`${WELL} px-4 py-3`}>
      <p className={MUTED}>{title}</p>
      <ul className="divide-y divide-white/[0.06]">
        {flags.map(f => {
          const info = flagInfo(f.rule, goal);
          const tone = good ? 'ok' : f.rule === 'insufficient_data' ? 'warn' : 'bad';
          return (
            <li key={f.id} className="flex items-center justify-between gap-4 py-3 last:pb-1">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Status tone={tone}>{info.name}</Status>
                  <span className={`${MUTED} tabular-nums`}>Flagged {fmtDate(f.fired_at)}</span>
                </div>
                <p className={`${BODY} mt-1`}>{info.text}</p>
              </div>
              <button
                type="button"
                className={`${SMALL_QUIET} shrink-0`}
                disabled={ackingId === f.id}
                onClick={() => onAck(f.id)}
                aria-label={`Acknowledge flag: ${info.name}, ${fmtDate(f.fired_at)}`}
              >
                {ackingId === f.id ? 'Saving…' : 'Acknowledge'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Progress chart: an SVG (1000 × 320, stretched to the card) ──
// Auto and manual probes are blue and orange, a pair validated for
// colour-blind readers on the #141c28 card; they also differ in shape.

const CHART = {
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.16)',
  ink: '#8b95a7',
  faint: '#8b95a7',
  phase: 'rgba(201,184,165,0.55)',
  trend: '#dae3f4',
  auto: '#3b9ae1',
  manual: '#d4782f',
  aim: '#c9b8a5',
  today: '#68d9c3',
  concern: '#ffb4ab',
  good: '#68d9c3',
  labelBg: '#141c28',
  pointEdge: '#141c28',
  font: "'Roboto Flex Variable', Roboto, system-ui, sans-serif",
};
const VB_W = 1000, VB_H = 320;
const GRID_L = 60, GRID_R = 960;   // grid lines
const PLOT_TOP = 30, AXIS_Y = 280; // top value, x axis
const X_START = 120, X_END = 920;  // baseline date → target date

/** The y axis: 0–100% for rates, round steps for everything else. */
function yAxis(goal, values) {
  const asRate = isRateGoal(goal, values);
  if (asRate) return { asRate, yMax: 1, ticks: [0.2, 0.4, 0.6, 0.8, 1] };
  const top = Math.max(0, ...values.map(Number), Number(goal.baseline_value), Number(goal.target_value)) * 1.05 || 1;
  const raw = top / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw - 1e-12);
  const count = Math.ceil(top / step - 1e-9);
  return { asRate, yMax: count * step, ticks: Array.from({ length: count }, (_, i) => (i + 1) * step) };
}

/** Week labels under the chart (W1 … W12 (Target)), dropping any that would overlap. */
function weekLabels(totalDays, todayDay, dayX) {
  const weeks = Math.max(1, Math.round(totalDays / 7));
  const nowWeek = todayDay >= 0 && todayDay <= totalDays ? Math.floor(todayDay / 7) + 1 : null;
  const wanted = [{ key: 'target', x: dayX(totalDays), text: `W${weeks + 1} (target)`, fill: CHART.faint, bold: false }];
  if (nowWeek && nowWeek <= weeks) {
    wanted.push({ key: 'now', x: dayX((nowWeek - 1) * 7), text: `W${nowWeek} (now)`, fill: CHART.today, bold: true });
  }
  for (let k = 1; k <= weeks; k++) {
    if (k !== nowWeek) wanted.push({ key: `w${k}`, x: dayX((k - 1) * 7), text: `W${k}`, fill: CHART.ink, bold: false });
  }
  const placed = [];
  for (const l of wanted) {
    const half = (l.text.length * (l.bold ? 7 : 6.6)) / 2;
    const clash = placed.some(p => l.x - half < p.x + p.half + 12 && l.x + half > p.x - p.half - 12);
    if (!clash) placed.push({ ...l, half });
  }
  return placed;
}

function ProgressChart({ goal, points, phases, flags }) {
  const sorted = useMemo(() => [...points].sort((a, b) => a.measured_at.localeCompare(b.measured_at)), [points]);
  const today = localToday();

  const baseMs = new Date(goal.baseline_date).getTime();
  const targetMs = new Date(goal.target_date).getTime();
  const totalDays = Math.max(1, (targetMs - baseMs) / 86400000);

  const { asRate, yMax, ticks } = yAxis(goal, sorted.map(p => p.value));
  const fmt = v => fmtMeasure(v, asRate);
  const lower = !!MEASURE_REGISTRY[goal.measure]?.lowerIsBetter;

  const dayX = d => X_START + (d / totalDays) * (X_END - X_START);
  const valY = v => AXIS_Y - (Math.min(Math.max(Number(v), 0), yMax) / yMax) * (AXIS_Y - PLOT_TOP);
  const dateToDay = iso => (new Date(String(iso).slice(0, 10)).getTime() - baseMs) / 86400000;

  // Trend line (Theil–Sen), drawn across the days that have data
  const trend = useMemo(() => trendLine(sorted), [sorted]);
  const showTrend = !!trend && sorted.length >= 2;
  let trendSeg = null;
  if (showTrend) {
    const d0 = dateToDay(sorted[0].measured_at);
    const d1 = dateToDay(sorted[sorted.length - 1].measured_at);
    const at = d => trend.slope * (d - d0) + trend.intercept;
    const y = v => AXIS_Y - (v / yMax) * (AXIS_Y - PLOT_TOP);
    trendSeg = { x1: dayX(d0), y1: y(at(d0)), x2: dayX(d1), y2: y(at(d1)) };
  }

  // Today marker
  const todayDay = dateToDay(today);
  const todayInRange = todayDay >= 0 && todayDay <= totalDays;

  // Points behind an open "4 in a row" flag are drawn in the flag's colour
  const behind = flaggedDates(flags, '4_below_aim');
  const ahead = flaggedDates(flags, '4_above_aim');
  const bracket = (dates, concern) => {
    const marked = sorted.filter(p => dates.has(p.measured_at));
    if (!marked.length) return null;
    const xs = marked.map(p => dayX(dateToDay(p.measured_at)));
    const ys = marked.map(p => valY(p.value));
    const x1 = Math.min(...xs) - 10, x2 = Math.max(...xs) + 10;
    let y = Math.min(...ys) - 24;
    let above = true;
    if (y < PLOT_TOP + 14) { y = Math.min(Math.max(...ys) + 24, AXIS_Y - 4); above = false; }
    const tick = above ? 10 : -10;
    const colour = concern ? CHART.concern : CHART.good;
    const side = concern === lower ? 'Above' : 'Below';
    return (
      <g key={concern ? 'behind' : 'ahead'}>
        <path d={`M ${x1} ${y + tick} L ${x1} ${y} L ${x2} ${y} L ${x2} ${y + tick}`} fill="none" stroke={colour} strokeWidth={1} strokeDasharray="2 2" />
        <text x={(x1 + x2) / 2} y={above ? y - 6 : y + 16} textAnchor="middle" fontSize={11} fontWeight={500} fill={colour}>
          {`${marked.length} points ${side.toLowerCase()} aim`}
        </text>
      </g>
    );
  };

  // Aim slope for the chart's description
  const aimSlope = (Number(goal.target_value) - Number(goal.baseline_value)) / totalDays;
  const trendDesc = trend
    ? (trend.slope > 0 ? `rising ${trend.slope.toFixed(3)}/day` : trend.slope < 0 ? `falling ${Math.abs(trend.slope).toFixed(3)}/day` : 'flat')
    : 'no trend (< 2 points)';
  const ariaLabel = `Progress chart from ${fmtDate(goal.baseline_date)} to ${fmtDate(goal.target_date)}: ${sorted.length} point${sorted.length !== 1 ? 's' : ''}, trend ${trendDesc}, aim requires ${Math.abs(aimSlope).toFixed(3)}/day`;

  const labels = weekLabels(totalDays, todayDay, dayX);
  const clipId = `chart-clip-${goal.id}`;

  return (
    <div>
      {/* Legend above the chart */}
      <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pb-4 border-b ${DIVIDER} text-[12px] leading-4 text-[#c9b8a5]`}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-hidden="true">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#3b9ae1] inline-block" />
            <span>Auto probe</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-[2px] bg-[#d4782f] inline-block" />
            <span>Manual probe</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-6 h-0 border-t-2 border-dashed border-[#c9b8a5] inline-block" />
            <span>Aim line (target {fmt(goal.target_value)})</span>
          </div>
          {showTrend && (
            <div className="flex items-center gap-2">
              <span className="w-6 h-0.5 bg-[#dae3f4] inline-block" />
              <span>Trend line</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="h-3.5 w-0 border-l border-dashed border-[#c9b8a5] inline-block" />
            <span>Phase change</span>
          </div>
          {todayInRange && (
            <div className="flex items-center gap-2">
              <span className="h-3.5 w-0 border-l border-dotted border-[#68d9c3] inline-block" />
              <span>Today</span>
            </div>
          )}
        </div>
        <div>Baseline {fmt(goal.baseline_value)}, aim {fmt(goal.target_value)}</div>
      </div>

      <div className="mt-5 w-full h-[320px]">
        <svg
          role="img"
          aria-label={ariaLabel}
          className="w-full h-full"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          fontFamily={CHART.font}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={GRID_L} y={PLOT_TOP - 10} width={GRID_R - GRID_L} height={AXIS_Y - PLOT_TOP + 10} />
            </clipPath>
          </defs>

          {/* Horizontal grid and y labels */}
          {ticks.map(v => (
            <g key={v}>
              <line x1={GRID_L} y1={valY(v)} x2={GRID_R} y2={valY(v)} stroke={CHART.grid} strokeWidth={1} />
              <text x={GRID_L - 12} y={valY(v) + 4} fill={CHART.ink} fontSize={12} textAnchor="end">{fmt(v)}</text>
            </g>
          ))}

          {/* X axis */}
          <line x1={GRID_L} y1={AXIS_Y} x2={GRID_R} y2={AXIS_Y} stroke={CHART.axis} strokeWidth={1} />

          {/* Phase changes: dashed lines, labelled at the top */}
          {phases.map(phase => {
            const d = dateToDay(phase.changed_at);
            if (d < 0 || d > totalDays) return null;
            const x = dayX(d);
            const label = phase.label.length > 22 ? `${phase.label.slice(0, 21)}…` : phase.label;
            const boxW = Math.max(80, label.length * 6.4 + 16);
            const boxX = x - 10 - boxW >= 0 ? x - 10 - boxW : x + 10;
            return (
              <g key={phase.id}>
                <line x1={x} y1={20} x2={x} y2={AXIS_Y} stroke={CHART.phase} strokeWidth={1} strokeDasharray="4 4" />
                <rect x={boxX} y={12} width={boxW} height={20} rx={4} fill={CHART.labelBg} stroke="rgba(255,255,255,0.06)" />
                <text x={boxX + boxW / 2} y={26} fill="#c9b8a5" fontSize={11} textAnchor="middle">{label}</text>
                <title>{`Phase change on ${fmtDate(phase.changed_at)}: ${phase.label}${phase.note ? ` — ${phase.note}` : ''}`}</title>
              </g>
            );
          })}

          {/* Today */}
          {todayInRange && (
            <g>
              <line x1={dayX(todayDay)} y1={20} x2={dayX(todayDay)} y2={AXIS_Y} stroke={CHART.today} strokeWidth={1} strokeDasharray="2 3" />
              <text x={dayX(todayDay)} y={15} fill={CHART.today} fontSize={11} textAnchor="middle" fontWeight={500}>Today</text>
            </g>
          )}

          {/* Aim line, from baseline to target */}
          <line
            x1={dayX(0)} y1={valY(goal.baseline_value)}
            x2={dayX(totalDays)} y2={valY(goal.target_value)}
            stroke={CHART.aim} strokeWidth={1.75} strokeDasharray="6 4"
          />

          {/* Trend line, kept inside the plot */}
          {trendSeg && (
            <g clipPath={`url(#${clipId})`}>
              <line {...trendSeg} stroke={CHART.trend} strokeWidth={1.5} />
            </g>
          )}

          {/* Data points: auto = circles, manual = squares. A larger invisible
              circle carries the hover label so the target is easy to hit. */}
          {sorted.map(p => {
            const x = dayX(dateToDay(p.measured_at));
            const y = valY(p.value);
            const isManual = p.source === 'manual';
            const flagged = behind.has(p.measured_at);
            const fill = flagged ? CHART.concern : isManual ? CHART.manual : CHART.auto;
            return (
              <g key={p.id || p.measured_at}>
                {isManual ? (
                  <rect x={x - 5} y={y - 5} width={10} height={10} rx={2} fill={fill} stroke={CHART.pointEdge} strokeWidth={flagged ? 2 : 1.5} />
                ) : (
                  <circle cx={x} cy={y} r={flagged ? 5.5 : 5} fill={fill} stroke={CHART.pointEdge} strokeWidth={flagged ? 2 : 1.5} />
                )}
                <circle cx={x} cy={y} r={14} fill="transparent">
                  <title>{`${fmtDate(p.measured_at)}: ${fmt(p.value)} (${isManual ? 'manual' : 'auto'} probe), aim ${fmt(aimValueAt(goal, p.measured_at))}`}</title>
                </circle>
              </g>
            );
          })}

          {bracket(behind, true)}
          {bracket(ahead, false)}

          {/* Week labels: week 1 starts on the baseline date */}
          {labels.map(l => (
            <text key={l.key} x={l.x} y={302} fill={l.fill} fontSize={12} textAnchor="middle" fontWeight={l.bold ? 500 : 400}>{l.text}</text>
          ))}
        </svg>
      </div>

      {sorted.length === 0 && (
        <p className={`mt-4 ${NO_DATA}`}>No data points yet for this goal.</p>
      )}

      {/* The same data as a table, for screen readers */}
      <table className="sr-only" aria-label="Progress data table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Value</th>
            <th scope="col">Source</th>
            <th scope="col">Aim</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(p => (
            <tr key={p.id || p.measured_at}>
              <td>{p.measured_at}</td>
              <td>{Number(p.value).toFixed(4)}</td>
              <td>{p.source}</td>
              <td>{aimValueAt(goal, p.measured_at).toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Mark met / discontinue ──

const STATUS_WORD = { met: 'met', discontinued: 'discontinued', revised: 'revised (a newer goal for this measure replaced it)' };

function GoalActions({ goal, onDone }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const label = MEASURE_REGISTRY[goal.measure]?.label?.toLowerCase() || 'this';

  const updateStatus = async (status) => {
    setLoading(status);
    setError('');
    try {
      await api.patchGoal(goal.id, { status });
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      if (onDone) onDone();
    } catch (err) {
      setError(err.message);
    }
    setLoading('');
  };

  if (goal.status !== 'active') {
    return (
      <p className={MUTED}>
        This goal was {STATUS_WORD[goal.status] || goal.status}{goal.updated_at ? ` on ${fmtDate(goal.updated_at)}` : ''}.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className={`${QUIET} whitespace-nowrap`}
        disabled={!!loading}
        onClick={() => updateStatus('met')}
        aria-label={`Mark met: ${label} goal`}
      >
        <CheckIcon />
        <span>{loading === 'met' ? 'Saving…' : 'Mark met'}</span>
      </button>
      <button
        type="button"
        className={`${DANGER} whitespace-nowrap`}
        disabled={!!loading}
        onClick={() => updateStatus('discontinued')}
        aria-label={`Discontinue: ${label} goal`}
      >
        <span>{loading === 'discontinued' ? 'Saving…' : 'Discontinue'}</span>
      </button>
      {error && <p className={ERROR_TEXT} role="alert">Could not save: {error}</p>}
    </div>
  );
}

// ── Progress for the chosen student ──

function ProgressSection({ student, goal, goals, goalsLoading, points, phases, flags, onAck, ackingId, onGoalDone }) {
  const measure = goal ? MEASURE_REGISTRY[goal.measure] : null;
  const withInfo = goal ? flags.map(f => ({ f, good: flagInfo(f.rule, goal).good })) : [];
  const concerns = withInfo.filter(x => !x.good).map(x => x.f);
  const goodNews = withInfo.filter(x => x.good).map(x => x.f);
  const goalNumber = goal ? goals.findIndex(g => g.id === goal.id) + 1 : 0;

  let body;
  if (goalsLoading) {
    body = <div className={`${CARD} p-5`}><p className={MUTED}>Loading goals…</p></div>;
  } else if (!goal) {
    body = (
      <div className={`${CARD} p-5`}>
        <EmptyNote>
          {goals.length
            ? `${student.name} has no active goal. Choose a goal in the Goals list below to see its chart.`
            : `${student.name} has no goals yet. Use "New goal" in the Goals list below to set one.`}
        </EmptyNote>
      </div>
    );
  } else {
    body = (
      <>
        <div aria-live="assertive" className={flags.length ? 'space-y-4' : 'sr-only'}>
          <FlagGroup flags={concerns} goal={goal} good={false} onAck={onAck} ackingId={ackingId} />
          <FlagGroup flags={goodNews} goal={goal} good onAck={onAck} ackingId={ackingId} />
        </div>
        <div className={`${CARD} p-5`}>
          <ProgressChart goal={goal} points={points} phases={phases} flags={flags} />
          <div className={`mt-5 pt-4 border-t ${DIVIDER} flex flex-wrap items-center justify-between gap-4`}>
            <GoalActions goal={goal} onDone={onGoalDone} />
            <div className={`${MUTED} text-right`}>
              {concerns.some(f => f.rule === '4_below_aim' || f.rule === 'trend_divergence')
                ? 'Recommendation: change the support, then mark it as a phase change below.'
                : `${points.length} point${points.length !== 1 ? 's' : ''} · ${phases.length} phase change${phases.length !== 1 ? 's' : ''}`}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="progress-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="progress-heading" className={SECTION}>
          Progress{measure ? `: ${measure.label.toLowerCase()}` : ''}{' '}
          <span className="text-[#c9b8a5] font-normal">(for {student.name})</span>
        </h2>
        {measure && <span className={MUTED}>Goal {goalNumber}: {measure.description}</span>}
      </div>
      {body}
    </section>
  );
}

// ── Goals: the list, and the form for a new one ──

function GoalStatusPill({ status }) {
  const word = String(status || '');
  const tone = status === 'active' || status === 'met' ? 'ok' : 'idle';
  return (
    <Status tone={tone} className="shrink-0">
      {word.charAt(0).toUpperCase() + word.slice(1)}
    </Status>
  );
}

function NewGoalForm({ studentId, goals, onClose, onCreated }) {
  const queryClient = useQueryClient();
  const [measure, setMeasure] = useState('independence_rate');
  const [baselineValue, setBaselineValue] = useState('');
  const [baselineDate, setBaselineDate] = useState(localToday());
  const [targetValue, setTargetValue] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionNote, setSuggestionNote] = useState('');
  const [formError, setFormError] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  const meta = MEASURE_REGISTRY[measure];
  const replaces = goals.find(g => g.status === 'active' && g.measure === measure);
  const example = meta.lowerIsBetter ? 'e.g. 1.5' : 'e.g. 0.20';

  const suggest = async () => {
    setSuggestionLoading(true);
    setFormError('');
    setSuggestionNote('');
    try {
      const result = await api.getBaselineSuggestion(studentId, measure);
      if (result.value !== null) {
        setBaselineValue(result.value.toFixed(3));
        setBaselineDate(localToday());
        setSuggestionNote(`Suggested from ${result.sampleDays} day${result.sampleDays !== 1 ? 's' : ''} of use in the last 14 days.`);
      } else {
        setFormError('No data in the last 14 days for this measure.');
      }
    } catch (err) {
      setFormError('Could not fetch baseline suggestion: ' + err.message);
    } finally {
      setSuggestionLoading(false);
    }
  };

  const createGoal = async (e) => {
    e.preventDefault();
    setFormError('');
    setCreateLoading(true);
    try {
      const created = await api.createGoal(studentId, {
        measure,
        baseline_value: Number(baselineValue),
        baseline_date: baselineDate,
        target_value: Number(targetValue),
        target_date: targetDate,
      });
      queryClient.invalidateQueries({ queryKey: ['goals', studentId] });
      setBaselineValue(''); setTargetValue(''); setTargetDate('');
      if (onCreated) onCreated(created?.id ?? null);
      onClose();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setCreateLoading(false);
    }
  };

  return (
    <form onSubmit={createGoal} aria-labelledby="create-goal-heading" className={`${WELL} mt-4 p-4 space-y-4`}>
      <h4 id="create-goal-heading" className={SECTION}>Create a goal</h4>

      <div>
        <label htmlFor="goal-measure" className={FIELD_LABEL}>Measure</label>
        <select id="goal-measure" className={SELECT} value={measure} onChange={e => setMeasure(e.target.value)}>
          {Object.entries(MEASURE_REGISTRY).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <p className={`mt-1.5 ${HELP}`}>
          {meta.description}.{' '}
          {meta.lowerIsBetter ? 'Values are prompts per task, e.g. 1.5.' : 'Values run from 0 to 1, e.g. 0.80 for 80%.'}
          {replaces ? ` This replaces the active ${meta.label.toLowerCase()} goal, which will be marked revised.` : ''}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="goal-baseline-val" className={FIELD_LABEL}>Baseline value</label>
          <input id="goal-baseline-val" type="number" step="any" className={INPUT}
            value={baselineValue} onChange={e => setBaselineValue(e.target.value)} required placeholder={example} />
        </div>
        <div>
          <label htmlFor="goal-baseline-date" className={FIELD_LABEL}>Baseline date</label>
          <input id="goal-baseline-date" type="date" className={INPUT}
            value={baselineDate} onChange={e => setBaselineDate(e.target.value)} required />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={QUIET}
          onClick={suggest} disabled={suggestionLoading} aria-describedby="goal-suggest-note">
          <span>{suggestionLoading ? 'Suggesting…' : 'Suggest baseline'}</span>
        </button>
        <p id="goal-suggest-note" className={`${HELP} flex-1 min-w-[160px]`} aria-live="polite">
          {suggestionNote || "Uses this user's last 14 days of voice commands."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="goal-target-val" className={FIELD_LABEL}>Target value</label>
          <input id="goal-target-val" type="number" step="any" className={INPUT}
            value={targetValue} onChange={e => setTargetValue(e.target.value)} required
            placeholder={meta.lowerIsBetter ? 'e.g. 0.5' : 'e.g. 0.80'} />
        </div>
        <div>
          <label htmlFor="goal-target-date" className={FIELD_LABEL}>Target date</label>
          <input id="goal-target-date" type="date" className={INPUT}
            value={targetDate} onChange={e => setTargetDate(e.target.value)} required />
        </div>
      </div>

      {formError && <p className={ERROR_TEXT} role="alert">{formError}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={PRIMARY} disabled={createLoading}>
          {createLoading ? 'Creating…' : 'Create goal'}
        </button>
        <button type="button" className={QUIET} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function GoalsCard({ student, goals, goalsLoading, selectedGoalId, onSelect, onCreated }) {
  const [showForm, setShowForm] = useState(false);
  const activeCount = goals.filter(g => g.status === 'active').length;

  return (
    <section aria-labelledby="goals-heading" className={`${CARD} p-5 flex flex-col justify-between`}>
      <div>
        <div className={`flex items-center justify-between gap-4 pb-4 border-b ${DIVIDER}`}>
          <div>
            <h3 id="goals-heading" className={SECTION}>Goals</h3>
            <p className={MUTED}>Measurable goals for {firstName(student.name)}</p>
          </div>
          <button
            type="button"
            className={`${SMALL_QUIET} shrink-0`}
            onClick={() => setShowForm(f => !f)}
            aria-expanded={showForm}
          >
            <PlusIcon />
            <span>New goal</span>
          </button>
        </div>

        {showForm && (
          <NewGoalForm studentId={student.id} goals={goals} onClose={() => setShowForm(false)} onCreated={onCreated} />
        )}

        <div className="mt-3 flex flex-col gap-1">
          {goalsLoading ? (
            <p className={MUTED}>Loading goals…</p>
          ) : goals.length === 0 ? (
            !showForm && (
              <EmptyNote>
                No goals yet. Use "New goal" to set one.
              </EmptyNote>
            )
          ) : goals.map(g => {
            const selected = selectedGoalId === g.id;
            const asRate = isRateGoal(g);
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelect(g.id)}
                aria-pressed={selected}
                className={`w-full text-left px-3 py-2.5 rounded-lg cursor-pointer flex items-center justify-between gap-3 transition-colors min-h-[56px] border ${
                  selected ? 'bg-[#18202d] border-[#f5a623]/50' : 'border-transparent hover:bg-[#18202d]'
                }`}
              >
                <span className="min-w-0">
                  <span className={`block ${BODY}`}>{MEASURE_REGISTRY[g.measure]?.label || g.measure}</span>
                  <span className={`block ${MUTED} tabular-nums`}>
                    {fmtGoalDate(g.baseline_date)} – {fmtGoalDate(g.target_date)} · Target: {fmtMeasure(g.target_value, asRate)}
                  </span>
                </span>
                <GoalStatusPill status={g.status} />
              </button>
            );
          })}
        </div>
      </div>

      {goals.length > 0 && (
        <div className={`mt-4 pt-3 border-t ${DIVIDER} ${MUTED}`}>
          {goals.length} goal{goals.length !== 1 ? 's' : ''} in total, {activeCount} active.
        </div>
      )}
    </section>
  );
}

// ── Mark a phase change ──

// The usual kinds of change, short enough to label the chart; "Other" takes any words.
const PHASE_KINDS = ['Speech settings changed', 'Microphone changed', 'New words taught', 'Seating or equipment', 'Prompting changed'];
const OTHER = '__other__';

function PhaseCard({ goal }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState(PHASE_KINDS[0]);
  const [otherText, setOtherText] = useState('');
  const [changedAt, setChangedAt] = useState(localToday());
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [saving, setSaving] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    const label = kind === OTHER ? otherText.trim() : kind;
    setErr('');
    setDone('');
    if (!label) { setErr('Say what changed.'); return; }
    setSaving(true);
    try {
      await api.addPhase(goal.id, { changed_at: changedAt, label, note: note.trim() || undefined });
      queryClient.invalidateQueries({ queryKey: ['phases', goal.id] });
      setOtherText(''); setNote('');
      setDone('Phase change added to the chart.');
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="phase-heading" className={`${CARD} p-5`}>
      <div className={`pb-4 border-b ${DIVIDER}`}>
        <h3 id="phase-heading" className={SECTION}>Mark a phase change</h3>
        <p className={MUTED}>Adds a dashed line to the progress chart on that day</p>
      </div>

      {!goal ? (
        <EmptyNote>
          Choose or create a goal first. A phase change is marked on one goal's chart.
        </EmptyNote>
      ) : (
        <form onSubmit={add} className="mt-4 space-y-4">
          <div>
            <label htmlFor="phase-what" className={FIELD_LABEL}>What changed?</label>
            <select id="phase-what" className={SELECT} value={kind} onChange={e => setKind(e.target.value)}>
              {PHASE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
              <option value={OTHER}>Something else (type it)</option>
            </select>
          </div>
          {kind === OTHER && (
            <div>
              <label htmlFor="phase-other" className={FIELD_LABEL}>Describe the change</label>
              <input id="phase-other" type="text" className={INPUT} value={otherText} maxLength={80}
                onChange={e => setOtherText(e.target.value)} required placeholder="e.g. Switched to visual cues" />
            </div>
          )}
          <div>
            <label htmlFor="phase-date" className={FIELD_LABEL}>Date of change</label>
            <input id="phase-date" type="date" className={INPUT}
              value={changedAt} onChange={e => setChangedAt(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="phase-note" className={FIELD_LABEL}>Note (optional)</label>
            <textarea id="phase-note" rows={2} className={TEXTAREA} value={note}
              onChange={e => setNote(e.target.value)} placeholder="Why you made the change, or anything to remember" />
          </div>
          {err && <p className={ERROR_TEXT} role="alert">{err}</p>}
          <p className={done ? `text-[13px] leading-5 ${INK.ok}` : 'sr-only'} role="status" aria-live="polite">{done}</p>
          <div className="pt-1">
            <button type="submit" className={PRIMARY} disabled={saving}>
              <span>{saving ? 'Saving…' : 'Mark phase change'}</span>
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// ── Who is using this computer (AT-50) ──
// Every voice command is saved against the student chosen here, and the
// choice stays after the app restarts. Picking again starts a new session.

function SessionPill({ recording }) {
  return <Status tone={recording ? 'ok' : 'idle'}>{recording ? 'Recording' : 'Not recording'}</Status>;
}

function WhoIsHerePanel({ students, active, statsById, computer }) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState('');
  const [newName, setNewName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [result, setResult] = useState(null);
  const nameRef = useRef(null);
  const selectRef = useRef(null);

  const current = active?.student || null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['activeStudent'] });
    queryClient.invalidateQueries({ queryKey: ['students'] });
    queryClient.invalidateQueries({ queryKey: ['teacherAnalytics'] });
  };
  const report = (tone, text) => setResult({ tone, text });

  const choose = useMutation({
    mutationFn: (studentId) => api.setActiveStudent(studentId),
    onSuccess: (data, studentId) => {
      const again = studentId != null && studentId === current?.id;
      refresh();
      setChoice('');
      report('success', data.student
        ? (again ? `New session started for ${data.student.name}.` : `Recording for ${data.student.name} from now on.`)
        : 'Session ended. Commands are not added to anyone\'s progress until you choose a user.');
    },
    onError: (err) => report('error', err.message),
  });

  const add = useMutation({
    mutationFn: (name) => api.addStudent(name),
    onSuccess: (student) => {
      refresh();
      setNewName('');
      setChoice(String(student.id));
      report('success', `${student.name} added. Choose them above to start recording their progress.`);
    },
    onError: (err) => report('error', err.message),
  });

  const remove = useMutation({
    mutationFn: (id) => api.deleteStudent(id),
    onSuccess: () => { refresh(); setConfirmRemove(null); report('success', 'User removed.'); },
    onError: (err) => report('error', err.message),
  });

  const since = active?.startedAt ? active.startedAt.slice(11, 16) : null;
  // Shows the student in session until someone picks another.
  const shown = choice !== '' ? choice : (current ? String(current.id) : '');
  const selected = shown === '' ? null : shown;
  const ending = choose.isPending && choose.variables === null;

  const start = () => {
    if (!selected) {
      report('error', 'Choose a user first.');
      selectRef.current?.focus();
      return;
    }
    choose.mutate(Number(selected));
  };

  const submitName = (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      report('error', 'Type the user\'s first name or initials first.');
      nameRef.current?.focus();
      return;
    }
    add.mutate(name);
  };

  return (
    <section aria-labelledby="who-heading" className={`${CARD} p-5`}>
      {/* Top status row */}
      <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pb-4 border-b ${DIVIDER}`}>
        <div className="flex items-center gap-3">
          <h2 id="who-heading" className={SECTION}>Who is using this computer</h2>
          <SessionPill recording={!!current} />
        </div>
        {computer && <span className={MUTED} data-private>Assigned to: {computer}</span>}
      </div>

      {/* Sentence */}
      <p className={`mt-4 ${BODY}`} aria-live="polite">
        {current
          ? <>Recording for <strong className="font-medium">{firstName(current.name)}</strong>{since ? ` since ${since}` : ''}. Their voice commands count toward their progress.</>
          : 'No user chosen. Voice commands are not added to anyone\'s progress until you choose one.'}
      </p>

      {/* Student at this computer + Start their session + End session */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[320px]">
          <label htmlFor="student-select" className={FIELD_LABEL}>User at this computer</label>
          <select
            ref={selectRef}
            id="student-select"
            className={SELECT}
            value={shown}
            onChange={e => setChoice(e.target.value)}
          >
            <option value="">Choose a user</option>
            {students.map(s => (
              <option key={s.id} value={s.id}>{s.name}{current?.id === s.id ? ' (in session)' : ''}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" className={PRIMARY} disabled={choose.isPending} onClick={start}>
            <PlayIcon />
            <span>{choose.isPending && !ending ? 'Starting…' : 'Start their session'}</span>
          </button>
          <button
            type="button"
            className={QUIET}
            disabled={!current || choose.isPending}
            onClick={() => choose.mutate(null)}
          >
            <StopIcon />
            <span>{ending ? 'Ending…' : 'End session'}</span>
          </button>
        </div>
      </div>

      {/* Add a student */}
      <form onSubmit={submitName} className={`mt-5 pt-5 border-t ${DIVIDER} flex flex-wrap items-end gap-3`}>
        <div className="flex-1 min-w-[320px] relative">
          <label htmlFor="add-student-input" className={FIELD_LABEL}>Add a user</label>
          <div className="relative flex items-center">
            <input
              ref={nameRef}
              id="add-student-input"
              type="text"
              className={`${FIELD} pr-12`}
              value={newName}
              maxLength={80}
              onChange={e => setNewName(e.target.value)}
              placeholder="First name, or initials"
              autoComplete="off"
            />
            <button
              type="button"
              aria-label="Clear user name"
              onClick={() => { setNewName(''); nameRef.current?.focus(); }}
              className="absolute right-1 w-9 h-9 rounded-md flex items-center justify-center text-[#c9b8a5] hover:text-[#dae3f4] hover:bg-[#222a37] cursor-pointer transition-colors"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <button type="submit" className={QUIET} disabled={add.isPending}>
          <PlusIcon />
          <span>{add.isPending ? 'Adding…' : 'Add user'}</span>
        </button>
      </form>

      {/* Remove a student, with a confirm step */}
      {students.length > 0 && (
        <div className={`mt-5 pt-3 border-t ${DIVIDER}`}>
          <details className="group">
            <summary className="flex flex-wrap items-center justify-between gap-x-4 cursor-pointer min-h-[36px] text-[13px] leading-5 text-[#c9b8a5] hover:text-[#dae3f4] transition-colors list-none [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2">
                <Svg className="w-4 h-4 transition-transform group-open:rotate-90"><polyline points="9 18 15 12 9 6" /></Svg>
                <span>Remove a user ({students.length})</span>
              </span>
              <span className="text-[13px] text-[#8b95a7]">Requires facilitator confirmation</span>
            </summary>
            <div className={`${WELL} mt-2 px-4 divide-y divide-white/[0.06]`}>
              {students.map(s => {
                const inSession = current?.id === s.id;
                return (
                  <div key={s.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
                    <div className="min-w-0">
                      <span className={BODY}>{s.name}</span>{' '}
                      <span className={`${MUTED} ml-2`}>
                        {inSession ? 'Active now · End their session to remove them' : lastActiveAgo(statsById[s.id]?.lastActive)}
                      </span>
                    </div>
                    {inSession ? (
                      <button type="button" disabled aria-label={`Remove ${s.name}: end their session first`} className={ROW_ACTION}>
                        Remove
                      </button>
                    ) : confirmRemove === s.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={MUTED}>Their name and speech profile go; their goals stay.</span>
                        <button
                          type="button"
                          className={SMALL_DANGER}
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(s.id)}
                        >
                          {remove.isPending ? 'Removing…' : `Remove ${s.name}`}
                        </button>
                        <button type="button" className={SMALL_QUIET} onClick={() => setConfirmRemove(null)} autoFocus>
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(s.id)}
                        aria-label={`Remove ${s.name}`}
                        className={ROW_ACTION}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        </div>
      )}

      <p
        className={`text-[13px] leading-5 ${result ? 'mt-4' : ''} ${result?.tone === 'error' ? INK.bad : INK.ok}`}
        role="status"
        aria-live="polite"
      >
        {result?.text || ''}
      </p>
    </section>
  );
}

// ── Success rate, all students (GET /api/teacher/analytics) ──

function Stat({ label, value, note }) {
  const empty = value == null || value === '';
  return (
    <div className={`${CARD} px-5 py-4 flex flex-col gap-1 min-w-0`}>
      <h3 className={`${LABEL} truncate`}>{label}</h3>
      {empty
        ? <p className="font-heading text-[16px] leading-9 text-[#8b95a7]">No data yet</p>
        : <p className={NUMBER}>{value}</p>}
      {note && <p className={`${MUTED} truncate`}>{note}</p>}
    </div>
  );
}

function ClassSummary({ analytics, todayStats }) {
  const { data, isLoading, error } = analytics;
  let body;
  if (isLoading) {
    body = <p className={MUTED}>Loading class numbers…</p>;
  } else if (error) {
    body = <ErrorNote>Could not load class analytics: {error.message}</ErrorNote>;
  } else {
    const s = data.summary;
    body = (
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat
          label="Success rate"
          value={s.totalCommands ? `${s.successRate}%` : null}
          note={s.totalCommands ? 'Commands that worked' : 'No commands yet'}
        />
        <Stat label="Total commands" value={num(s.totalCommands)} note="All time, on this computer" />
        <Stat
          label="Today"
          value={num(s.todayCommands)}
          note={todayStats?.avgLatency ? `${num(todayStats.avgLatency)} ms average today` : 'Since midnight'}
        />
        <Stat
          label="Average latency"
          value={s.avgLatency ? `${num(s.avgLatency)} ms` : null}
          note="All commands, all time"
        />
        <Stat label="Users" value={num(s.totalStudents)} note="On this computer" />
      </div>
    );
  }
  return (
    <section aria-labelledby="class-summary-heading" className="flex flex-col gap-3">
      <h2 id="class-summary-heading" className={SECTION}>Success rate, all users</h2>
      {body}
    </section>
  );
}

// ── Usage by user: every student at a glance; a row picks whose progress is shown ──

function RosterTable({ students, statsById, analyticsLoading, selectedId, onSelect, current, since }) {
  const noData = <span className={NO_DATA}>No data yet</span>;
  return (
    <section aria-labelledby="roster-heading" className={`${CARD} overflow-hidden`}>
      <div className="px-5 pt-4 pb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="roster-heading" className={SECTION}>Usage by user</h3>
        <span className={MUTED}>
          {analyticsLoading ? 'Loading numbers…' : 'Click a row to see that user\'s progress below'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <caption className="sr-only">
            Per-user success rate, command count, average latency, sessions in the last 7 days, most-used kind of command, and last active time. Choose a user's name to see their progress below.
          </caption>
          <thead>
            <tr className={`border-y ${DIVIDER}`}>
              <th scope="col" className={`${TH} pl-5`}>User</th>
              <th scope="col" className={TH}>Success rate</th>
              <th scope="col" className={TH}>Commands</th>
              <th scope="col" className={TH}>Average latency</th>
              <th scope="col" className={TH}>Sessions (7 days)</th>
              <th scope="col" className={TH}>Top command</th>
              <th scope="col" className={`${TH} pr-5`}>Last active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {students.map(s => {
              const stats = statsById[s.id];
              const selected = s.id === selectedId;
              const inSession = current?.id === s.id;
              const tone = rateTone(stats);
              const kind = commandKind(stats?.topCommand);
              const last = lastActiveText(stats?.lastActive);
              return (
                <tr
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className={`cursor-pointer transition-colors border-l-2 ${selected ? 'bg-[#18202d] border-l-[#f5a623]' : 'hover:bg-[#18202d]/60 border-l-transparent'}`}
                >
                  <th scope="row" className={`${TD} pl-5 font-normal whitespace-nowrap`}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={e => { e.stopPropagation(); onSelect(s.id); }}
                      className="flex items-center gap-2.5 min-h-[36px] -my-2 text-left rounded cursor-pointer"
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${inSession ? DOT.ok : DOT.idle}`} aria-hidden="true" />
                      <span className={selected ? 'font-medium' : ''}>{s.name}</span>
                      {selected && (
                        <span className="text-[13px] text-[#c9b8a5]" aria-hidden="true">Selected</span>
                      )}
                    </button>
                  </th>
                  <td className={`${TD} whitespace-nowrap`}>
                    {tone ? (
                      <span className="inline-flex items-center gap-3">
                        <span className="tabular-nums">{stats.successRate}%</span>
                        <Status tone={RATE_STYLE[tone].tone}>{RATE_STYLE[tone].label}</Status>
                      </span>
                    ) : noData}
                  </td>
                  <td className={`${TD} tabular-nums`}>{stats ? num(stats.commands) : noData}</td>
                  <td className={`${TD} tabular-nums whitespace-nowrap`}>{stats?.avgLatency ? `${num(stats.avgLatency)} ms` : noData}</td>
                  <td className={`${TD} tabular-nums`}>{stats ? num(stats.sessionsThisWeek ?? 0) : noData}</td>
                  <td className={TD}>{kind === '—' ? noData : kind}</td>
                  <td className={`${TD} pr-5`}>
                    {inSession
                      ? <Status tone="ok">Active now{since ? ` (${since})` : ''}</Status>
                      : last ? <span className="text-[13px] text-[#c9b8a5] tabular-nums">{last}</span> : noData}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Students page ──

export default function Students() {
  const queryClient = useQueryClient();
  const [pickedStudentId, setPickedStudentId] = useState(null);
  const [pickedGoalId, setPickedGoalId] = useState(null);

  const { data: students = [], isLoading: studentsLoading, error: studentsError } = useQuery({
    queryKey: ['students'],
    queryFn: () => api.getStudents(),
    staleTime: 30000,
  });

  const { data: active } = useQuery({
    queryKey: ['activeStudent'],
    queryFn: api.getActiveStudent,
    refetchInterval: 15000,
  });
  const current = active?.student || null;
  const since = active?.startedAt ? active.startedAt.slice(11, 16) : null;

  // This computer's name (the top bar reads the same query)
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 5000 });

  const analytics = useQuery({
    queryKey: ['teacherAnalytics'],
    queryFn: api.getTeacherAnalytics,
    staleTime: 15000,
    refetchInterval: 30000,
  });
  const statsById = useMemo(
    () => Object.fromEntries((analytics.data?.students || []).map(s => [s.id, s])),
    [analytics.data],
  );

  const { data: todayStats } = useQuery({
    queryKey: ['commandStats'],
    queryFn: api.getCommandStats,
    staleTime: 30000,
  });

  // Whose progress is shown: the one chosen in the table; until then the
  // student in session, or else the first student.
  const known = id => students.some(s => s.id === id);
  const studentId = pickedStudentId != null && known(pickedStudentId) ? pickedStudentId
    : current && known(current.id) ? current.id
    : students[0]?.id ?? null;
  const student = students.find(s => s.id === studentId) || null;

  const { data: goals = [], isLoading: goalsLoading } = useQuery({
    queryKey: ['goals', studentId, 'all'],
    queryFn: () => api.getGoals(studentId, 'all'),
    enabled: studentId != null,
    staleTime: 10000,
  });

  // Which goal is charted: the one chosen in the list, or else their newest active goal
  const goal = goals.find(g => g.id === pickedGoalId) || goals.find(g => g.status === 'active') || null;
  const goalId = goal?.id ?? null;

  const { data: points = [] } = useQuery({
    queryKey: ['points', goalId],
    queryFn: () => api.getPoints(goalId),
    enabled: !!goalId,
    staleTime: 10000,
  });

  const { data: phases = [] } = useQuery({
    queryKey: ['phases', goalId],
    queryFn: () => api.getPhases(goalId),
    enabled: !!goalId,
    staleTime: 30000,
  });

  const { data: flags = [] } = useQuery({
    queryKey: ['flags', goalId],
    queryFn: () => api.getFlags(goalId, true),
    enabled: !!goalId,
    refetchInterval: 30000,
    staleTime: 10000,
  });

  const ack = useMutation({
    mutationFn: (flagId) => api.acknowledgeFlag(flagId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['flags', goalId] }),
  });

  const selectStudent = (id) => {
    if (id !== studentId) setPickedGoalId(null);
    setPickedStudentId(id);
  };

  let perStudent;
  if (studentsLoading) {
    perStudent = <p className={MUTED}>Loading users…</p>;
  } else if (studentsError) {
    perStudent = <ErrorNote>Could not load users: {studentsError.message}</ErrorNote>;
  } else if (!student) {
    perStudent = (
      <section className={`${CARD} p-5`} aria-label="User progress">
        <EmptyNote>
          No users yet. Add a user above, then start their session to begin tracking their progress.
        </EmptyNote>
      </section>
    );
  } else {
    perStudent = (
      <>
        <RosterTable
          students={students}
          statsById={statsById}
          analyticsLoading={analytics.isLoading}
          selectedId={studentId}
          onSelect={selectStudent}
          current={current}
          since={since}
        />

        <ProgressSection
          student={student}
          goal={goal}
          goals={goals}
          goalsLoading={goalsLoading}
          points={points}
          phases={phases}
          flags={flags}
          onAck={(id) => ack.mutate(id)}
          ackingId={ack.isPending ? ack.variables : null}
          onGoalDone={() => {
            setPickedGoalId(null);
            queryClient.invalidateQueries({ queryKey: ['goals', studentId, 'all'] });
          }}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <GoalsCard
            student={student}
            goals={goals}
            goalsLoading={goalsLoading}
            selectedGoalId={goalId}
            onSelect={setPickedGoalId}
            onCreated={(id) => {
              if (id) setPickedGoalId(id);
              queryClient.invalidateQueries({ queryKey: ['goals', studentId, 'all'] });
            }}
          />
          <PhaseCard goal={goal} />
        </div>

        {/* How well they are heard lives on the Speech profile page */}
        <Link
          to={`/speech?student=${student.id}`}
          className="inline-flex items-center gap-2 self-start min-h-[44px] rounded-lg text-[14px] text-[#ffc880] hover:underline"
        >
          <MicIcon />
          How well AbleSpeak hears {student.name}, and their speech settings
        </Link>
      </>
    );
  }

  return (
    <div className={PAGE}>
      <div className="flex flex-col w-full gap-6">
        {/* Page title and subtitle */}
        <header>
          <h1 className={TITLE}>Users</h1>
          <p className={`${MUTED} text-[14px] mt-1`}>Who is using this computer, and how each user is progressing.</p>
        </header>
        <WhoIsHerePanel students={students} active={active} statsById={statsById} computer={status?.computer} />
        <ClassSummary analytics={analytics} todayStats={todayStats} />
        {perStudent}
      </div>
    </div>
  );
}
