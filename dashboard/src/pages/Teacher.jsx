/**
 * Teacher.jsx — Tier 2 Progress Monitoring page.
 *
 * Layout (per-student):
 *   1. Flag banner (role="alert") — unacknowledged decision flags + Acknowledge button
 *   2. Progress chart (hand-rolled SVG) — points, aim line, trend line, phase markers
 *   3. Goal setup / edit panel — create goal, suggest baseline, add phase changes
 *   4. Usage context strip — sessions this week, command count (secondary, visually muted)
 *
 * No new npm dependencies. SVG is hand-rolled.
 * WCAG AA+: aria-labels, ≥48px targets, focus rings, 7:1 contrast for text, reduced-motion.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { RecognitionReadout, SpeechSettings } from '../components/StudentSpeech';
import { Button, Field, Notice, Panel, StatTile, StatusPill, TextField } from '../components/ui';
import { CheckCircle2, TrendingUp, Target, PlusCircle, ChevronDown, ChevronUp, Users, Flag, LineChart } from 'lucide-react';

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

// ── Rule guidance text ──
const RULE_GUIDANCE = {
  '4_below_aim': '4 consecutive points below the aim line — consider changing the intervention.',
  '4_above_aim': '4 consecutive points above the aim line — student is exceeding expectations!',
  trend_divergence: 'The trend is heading away from the goal — review the intervention strategy.',
  insufficient_data: 'Fewer than 3 data points in the last 14 days — increase probe frequency.',
};

// ── Chart colours ──
// Point and aim colours were checked together on the chart background with
// the dataviz palette validator (colour-blind separation and 3:1 contrast).
// Auto and manual points also differ in shape; the trend line is neutral ink.
const CHART = {
  surface: '#0a1628',
  grid: 'rgba(255, 255, 255, 0.08)',
  axis: 'rgba(255, 255, 255, 0.16)',
  ink: '#94a3b8',
  trend: '#cbd5e1',
  auto: '#1d9e8a',
  manual: '#9a7be0',
  aim: '#c98500',
  font: "'Inter Variable', 'Inter', system-ui, sans-serif",
};

// ── SVG chart dimensions ──
const W = 760, H = 360;
const ML = 72, MR = 24, MT = 24, MB = 60;
const CW = W - ML - MR, CH = H - MT - MB;

function formatValue(goal, v, yRange) {
  if (MEASURE_REGISTRY[goal.measure]?.lowerIsBetter) return v.toFixed(1);
  return yRange <= 1.1 ? `${(v * 100).toFixed(0)}%` : v.toFixed(1);
}

function ChartLegend({ showTrend }) {
  return (
    <ul className="chart-legend" aria-hidden="true">
      <li><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill={CHART.auto} /></svg>Auto probe</li>
      <li><svg width="14" height="14"><rect x="2" y="2" width="10" height="10" fill={CHART.manual} /></svg>Manual probe</li>
      <li><svg width="24" height="14"><line x1="0" y1="7" x2="24" y2="7" stroke={CHART.aim} strokeWidth="2" strokeDasharray="6 3" /></svg>Aim line</li>
      {showTrend && (
        <li><svg width="24" height="14"><line x1="0" y1="7" x2="24" y2="7" stroke={CHART.trend} strokeWidth="2" /></svg>Trend</li>
      )}
      <li><svg width="24" height="14"><line x1="12" y1="0" x2="12" y2="14" stroke={CHART.ink} strokeWidth="1.5" strokeDasharray="4 3" /></svg>Phase change</li>
    </ul>
  );
}

// ── Progress Chart ──
function ProgressChart({ goal, points, phases }) {
  const sorted = useMemo(() => [...points].sort((a, b) => a.measured_at.localeCompare(b.measured_at)), [points]);
  const today = localToday();

  const baseMs = useMemo(() => new Date(goal.baseline_date).getTime(), [goal]);
  const targetMs = useMemo(() => new Date(goal.target_date).getTime(), [goal]);
  const totalDays = (targetMs - baseMs) / 86400000;

  // Y range: include 0, all data values, baseline, target; pad 10% above
  const allValues = useMemo(() => [
    Number(goal.baseline_value),
    Number(goal.target_value),
    ...sorted.map(p => Number(p.value)),
  ], [goal, sorted]);
  const yMin = Math.min(0, ...allValues);
  const yMaxRaw = Math.max(...allValues);
  const yPad = (yMaxRaw - yMin) * 0.1 || 0.1;
  const yMax = yMaxRaw + yPad;
  const yRange = yMax - yMin;

  const dayX = d => ML + (d / totalDays) * CW;
  const valY = v => MT + CH - ((v - yMin) / yRange) * CH;
  const dateToDay = iso => (new Date(iso).getTime() - baseMs) / 86400000;

  // Aim line: from baseline to target
  const aimX1 = dayX(0), aimY1 = valY(Number(goal.baseline_value));
  const aimX2 = dayX(totalDays), aimY2 = valY(Number(goal.target_value));

  // Trend line
  const trend = useMemo(() => trendLine(sorted), [sorted]);
  const showTrend = !!trend && sorted.length >= 2;
  let trendLineEl = null;
  if (showTrend) {
    const D0 = dateToDay(sorted[0].measured_at);
    const trendAt = d => trend.slope * (d - D0) + trend.intercept;
    trendLineEl = (
      <line
        x1={dayX(0)} y1={valY(trendAt(0))}
        x2={dayX(totalDays)} y2={valY(trendAt(totalDays))}
        stroke={CHART.trend} strokeWidth={2}
      />
    );
  }

  // Today marker
  const todayDay = dateToDay(today);
  const todayInRange = todayDay >= 0 && todayDay <= totalDays;

  // Aim slope for aria-label
  const aimSlope = totalDays > 0 ? (Number(goal.target_value) - Number(goal.baseline_value)) / totalDays : 0;
  const trendDesc = trend
    ? (trend.slope > 0 ? `rising ${trend.slope.toFixed(3)}/day` : trend.slope < 0 ? `falling ${Math.abs(trend.slope).toFixed(3)}/day` : 'flat')
    : 'no trend (< 2 points)';
  const ariaLabel = `Progress chart: ${sorted.length} point${sorted.length !== 1 ? 's' : ''}, trend ${trendDesc}, aim requires ${Math.abs(aimSlope).toFixed(3)}/day`;

  // Y axis ticks
  const yTicks = useMemo(() => {
    const count = 5;
    return Array.from({ length: count + 1 }, (_, i) => yMin + (yRange / count) * i);
  }, [yMin, yRange]);

  // X axis ticks (roughly 5 evenly spaced dates)
  const xTickDays = useMemo(() => {
    const count = Math.min(5, Math.floor(totalDays / 7));
    if (count < 1) return [0, totalDays];
    return Array.from({ length: count + 1 }, (_, i) => (totalDays / count) * i);
  }, [totalDays]);

  const dayToIso = d => new Date(baseMs + d * 86400000).toISOString().slice(0, 10);

  return (
    <div className="chart">
      <ChartLegend showTrend={showTrend} />
      <div className="chart-scroll">
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${W} ${H}`}
          width={W} height={H}
          className="chart-svg"
          fontFamily={CHART.font}
        >
          {/* Y grid lines */}
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={ML} y1={valY(v)} x2={ML + CW} y2={valY(v)} stroke={CHART.grid} strokeWidth={1} />
              <text x={ML - 10} y={valY(v) + 5} textAnchor="end" fontSize={14} fill={CHART.ink}>
                {formatValue(goal, v, yRange)}
              </text>
            </g>
          ))}

          {/* X axis ticks */}
          {xTickDays.map((d, i) => (
            <g key={i}>
              <line x1={dayX(d)} y1={MT + CH} x2={dayX(d)} y2={MT + CH + 6} stroke={CHART.axis} strokeWidth={1} />
              <text x={dayX(d)} y={MT + CH + 24} textAnchor="middle" fontSize={14} fill={CHART.ink}>
                {dayToIso(d).slice(5)} {/* MM-DD */}
              </text>
            </g>
          ))}

          {/* Baseline */}
          <line x1={ML} y1={MT + CH} x2={ML + CW} y2={MT + CH} stroke={CHART.axis} strokeWidth={1} />

          {/* Phase change vertical lines */}
          {phases.map(phase => {
            const d = dateToDay(phase.changed_at);
            if (d < 0 || d > totalDays) return null;
            const x = dayX(d);
            return (
              <g key={phase.id}>
                <line x1={x} y1={MT} x2={x} y2={MT + CH} stroke={CHART.ink} strokeWidth={1.5} strokeDasharray="4 3" />
                <text x={x + 6} y={MT + 16} fontSize={14} fontWeight={600} fill={CHART.trend}>
                  {phase.label.slice(0, 14)}
                </text>
                <title>{`Phase change on ${phase.changed_at}: ${phase.label}`}</title>
              </g>
            );
          })}

          {/* Aim line (dashed) */}
          <line x1={aimX1} y1={aimY1} x2={aimX2} y2={aimY2} stroke={CHART.aim} strokeWidth={2} strokeDasharray="8 4" />

          {/* Trend line (solid) */}
          <clipPath id={`chart-clip-${goal.id}`}>
            <rect x={ML} y={MT} width={CW} height={CH} />
          </clipPath>
          <g clipPath={`url(#chart-clip-${goal.id})`}>
            {trendLineEl}
          </g>

          {/* Today marker */}
          {todayInRange && (
            <g>
              <line x1={dayX(todayDay)} y1={MT} x2={dayX(todayDay)} y2={MT + CH} stroke={CHART.ink} strokeWidth={1} strokeDasharray="2 4" />
              <text x={dayX(todayDay) + 6} y={MT + CH - 8} fontSize={14} fill={CHART.ink}>today</text>
            </g>
          )}

          {/* Data points — auto=circles, manual=squares. A larger invisible
              circle carries the hover label so the target is easy to hit. */}
          {sorted.map(p => {
            const d = dateToDay(p.measured_at);
            const x = dayX(d);
            const y = valY(Number(p.value));
            const isManual = p.source === 'manual';
            return (
              <g key={p.id || p.measured_at} className="chart-point">
                {isManual ? (
                  <rect x={x - 5} y={y - 5} width={10} height={10} fill={CHART.manual} stroke={CHART.surface} strokeWidth={2} />
                ) : (
                  <circle cx={x} cy={y} r={5.5} fill={CHART.auto} stroke={CHART.surface} strokeWidth={2} />
                )}
                <circle cx={x} cy={y} r={14} fill="transparent">
                  <title>{`${p.measured_at}: ${formatValue(goal, Number(p.value), yRange)} (${isManual ? 'manual' : 'auto'} probe), aim ${formatValue(goal, aimValueAt(goal, p.measured_at), yRange)}`}</title>
                </circle>
              </g>
            );
          })}

          {/* Axes labels */}
          <text x={ML + CW / 2} y={H - 6} textAnchor="middle" fontSize={14} fill={CHART.ink}>Date</text>
          <text x={16} y={MT + CH / 2} textAnchor="middle" fontSize={14} fill={CHART.ink}
            transform={`rotate(-90, 16, ${MT + CH / 2})`}>
            {MEASURE_REGISTRY[goal.measure]?.label}
          </text>
        </svg>
      </div>

      {/* Visually-hidden data table for screen readers */}
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

// ── Flag Banner ──
function FlagBanner({ flags, onAck }) {
  if (!flags || flags.length === 0) return null;
  return (
    <Notice
      tone="error"
      icon={Flag}
      title={`${flags.length} decision flag${flags.length !== 1 ? 's' : ''}`}
      className="section"
      aria-live="assertive"
    >
      {flags.map(f => (
        <div key={f.id} className="flag-row">
          <p>
            <strong>{f.rule}</strong>
            {' — '}
            {RULE_GUIDANCE[f.rule] || 'Review this goal.'}
            <span className="flag-time tabular">{f.fired_at}</span>
          </p>
          <Button onClick={() => onAck(f.id)} aria-label={`Acknowledge ${f.rule} flag from ${f.fired_at}`}>
            Acknowledge
          </Button>
        </div>
      ))}
    </Notice>
  );
}

// ── Goal Setup Panel ──
function GoalSetupPanel({ studentId, goals, selectedGoalId, onGoalSelect, onGoalCreated, queryClient }) {
  const [showForm, setShowForm] = useState(false);
  const [measure, setMeasure] = useState('independence_rate');
  const [baselineValue, setBaselineValue] = useState('');
  const [baselineDate, setBaselineDate] = useState(localToday());
  const [targetValue, setTargetValue] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  const suggest = async () => {
    setSuggestionLoading(true);
    setFormError('');
    try {
      const result = await api.getBaselineSuggestion(studentId, measure);
      if (result.value !== null) {
        setBaselineValue(result.value.toFixed(3));
        setBaselineDate(localToday());
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
      await api.createGoal(studentId, {
        measure,
        baseline_value: Number(baselineValue),
        baseline_date: baselineDate,
        target_value: Number(targetValue),
        target_date: targetDate,
      });
      queryClient.invalidateQueries({ queryKey: ['goals', studentId] });
      setShowForm(false);
      setBaselineValue(''); setTargetValue(''); setTargetDate('');
      if (onGoalCreated) onGoalCreated();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setCreateLoading(false);
    }
  };

  return (
    <section aria-labelledby="goals-heading" className="section">
      <div className="section-head">
        <h3 id="goals-heading" className="section-title">Goals</h3>
        <Button
          icon={PlusCircle}
          onClick={() => setShowForm(f => !f)}
          aria-expanded={showForm}
        >
          New goal {showForm ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
        </Button>
      </div>

      {/* Existing goals list */}
      {goals && goals.length > 0 && (
        <div className="goal-list">
          {goals.map(g => (
            <button
              key={g.id}
              type="button"
              className={`goal-option${selectedGoalId === g.id ? ' selected' : ''}`}
              onClick={() => onGoalSelect(g.id)}
              aria-pressed={selectedGoalId === g.id}
            >
              <Target size={20} aria-hidden="true" className="goal-option-icon" />
              <span className="goal-option-text">
                <span className="goal-option-name">{MEASURE_REGISTRY[g.measure]?.label}</span>
                <span className="goal-option-dates tabular">{g.baseline_date} → {g.target_date}</span>
              </span>
              <StatusPill tone={g.status === 'active' ? 'success' : 'neutral'} label={g.status} />
            </button>
          ))}
        </div>
      )}

      {/* Goal creation form */}
      {showForm && (
        <Panel title="Create a goal" titleId="create-goal-heading" icon={Target}>
          <form onSubmit={createGoal} className="form-stack">
            <Field id="goal-measure" label="Measure">
              <select id="goal-measure" className="field-input" value={measure} onChange={e => setMeasure(e.target.value)}>
                {Object.entries(MEASURE_REGISTRY).map(([k, v]) => (
                  <option key={k} value={k}>{v.label} — {v.description}</option>
                ))}
              </select>
            </Field>

            <div className="form-row">
              <Field id="goal-baseline-val" label="Baseline value" className="grow">
                <input id="goal-baseline-val" type="number" step="any" className="field-input"
                  value={baselineValue} onChange={e => setBaselineValue(e.target.value)} required
                  placeholder="e.g. 0.20" />
              </Field>
              <Button onClick={suggest} disabled={suggestionLoading}
                aria-label="Suggest baseline from last 14 days of data">
                {suggestionLoading ? 'Suggesting…' : 'Suggest'}
              </Button>
            </div>

            <Field id="goal-baseline-date" label="Baseline date">
              <input id="goal-baseline-date" type="date" className="field-input"
                value={baselineDate} onChange={e => setBaselineDate(e.target.value)} required />
            </Field>

            <Field id="goal-target-val" label="Target value">
              <input id="goal-target-val" type="number" step="any" className="field-input"
                value={targetValue} onChange={e => setTargetValue(e.target.value)} required
                placeholder="e.g. 0.80" />
            </Field>

            <Field id="goal-target-date" label="Target date">
              <input id="goal-target-date" type="date" className="field-input"
                value={targetDate} onChange={e => setTargetDate(e.target.value)} required />
            </Field>

            {formError && <p className="form-result error" role="alert">{formError}</p>}

            <div>
              <Button type="submit" variant="primary" disabled={createLoading}>
                {createLoading ? 'Creating…' : 'Create goal'}
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </section>
  );
}

// ── Phase Change Quick-Add ──
function PhasePanel({ goalId, queryClient }) {
  const [label, setLabel] = useState('');
  const [changedAt, setChangedAt] = useState(localToday());
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const add = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await api.addPhase(goalId, { changed_at: changedAt, label: label.trim(), note: note.trim() || undefined });
      queryClient.invalidateQueries({ queryKey: ['phases', goalId] });
      setLabel(''); setNote('');
    } catch (ex) {
      setErr(ex.message);
    }
  };

  return (
    <Panel title="Mark a phase change" titleId="phase-heading" icon={Flag} className="section">
      <form onSubmit={add} className="form-stack">
        <TextField id="phase-label" label="What changed?" value={label}
          onChange={e => setLabel(e.target.value)} required
          placeholder="e.g. Switched to visual cues" />
        <Field id="phase-date" label="Date of change">
          <input id="phase-date" type="date" className="field-input"
            value={changedAt} onChange={e => setChangedAt(e.target.value)} required />
        </Field>
        <TextField id="phase-note" label="Note (optional)" value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Additional context" />
        {err && <p className="form-result error" role="alert">{err}</p>}
        <div>
          <Button type="submit" variant="primary">Mark phase change</Button>
        </div>
      </form>
    </Panel>
  );
}

// ── Goal Actions (mark met / discontinued) ──
function GoalActions({ goalId, status, queryClient, onDeselect }) {
  const [loading, setLoading] = useState('');
  const updateStatus = async (newStatus) => {
    setLoading(newStatus);
    try {
      await api.patchGoal(goalId, { status: newStatus });
      queryClient.invalidateQueries({ queryKey: ['goals'] });
      if (onDeselect) onDeselect();
    } catch {}
    setLoading('');
  };
  if (status !== 'active') return null;
  return (
    <div className="button-row">
      <Button icon={CheckCircle2} onClick={() => updateStatus('met')} disabled={!!loading}
        aria-label="Mark goal as met">
        {loading === 'met' ? 'Saving…' : 'Mark met'}
      </Button>
      <Button variant="ghost" onClick={() => updateStatus('discontinued')} disabled={!!loading}
        aria-label="Mark goal as discontinued">
        {loading === 'discontinued' ? 'Saving…' : 'Discontinue'}
      </Button>
    </div>
  );
}

// ── Class Analytics Summary: success rate, commands, latency ──
// Uses the existing, already-working GET /api/teacher/analytics endpoint
// (server/src/db.js getTeacherAnalytics()) — this data has always been
// computed correctly, it just was never rendered anywhere in the dashboard.
function rateTone(s) {
  if (s.commands === 0) return '';
  if (s.successRate >= 80) return 'good';
  if (s.successRate >= 50) return 'fair';
  return 'low';
}

function AnalyticsSummary() {
  const { data: analytics, isLoading, error } = useQuery({
    queryKey: ['teacherAnalytics'],
    queryFn: api.getTeacherAnalytics,
    staleTime: 15000,
    refetchInterval: 30000,
  });

  if (isLoading) {
    return <p className="muted-note section">Loading class analytics…</p>;
  }
  if (error) {
    return <Notice tone="error" className="section">Could not load class analytics: {error.message}</Notice>;
  }

  const { summary, students } = analytics;

  return (
    <section aria-labelledby="class-summary-heading" className="section">
      <h3 id="class-summary-heading" className="section-title">Success rate, all students</h3>

      <div className="stat-grid">
        <StatTile label="Success rate" value={`${summary.successRate}%`} tone="accent" />
        <StatTile label="Total commands" value={summary.totalCommands} />
        <StatTile label="Today" value={summary.todayCommands} />
        <StatTile label="Average latency" value={`${summary.avgLatency} ms`} />
        <StatTile label="Students" value={summary.totalStudents} />
      </div>

      {students.length === 0 ? (
        <p className="muted-note">
          No students added yet — add one above to start tracking success rate.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">
              Per-student success rate, command count, average latency, sessions in the last 7 days, most-used command, and last active time
            </caption>
            <thead>
              <tr>
                <th scope="col">Student</th>
                <th scope="col">Success rate</th>
                <th scope="col" className="num">Commands</th>
                <th scope="col" className="num">Average latency</th>
                <th scope="col" className="num">Sessions (7 days)</th>
                <th scope="col">Top command</th>
                <th scope="col">Last active</th>
              </tr>
            </thead>
            <tbody>
              {students.map(s => (
                <tr key={s.id}>
                  <th scope="row">{s.name}</th>
                  <td>
                    <span className={`rate ${rateTone(s)}`}>
                      {s.commands === 0 ? '—' : `${s.successRate}%`}
                    </span>
                  </td>
                  <td className="num">{s.commands}</td>
                  <td className="num">{s.avgLatency ? `${s.avgLatency} ms` : '—'}</td>
                  <td className="num">{s.sessionsThisWeek ?? 0}</td>
                  <td>{s.topCommand}</td>
                  <td className="tabular">{s.lastActive}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Who is using this computer (AT-50) ──
// Every voice command is saved against the student chosen here, and the
// choice stays after the app restarts. Picking again starts a new session.
function WhoIsHerePanel({ students }) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState('');
  const [newName, setNewName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [result, setResult] = useState(null);

  const { data: active } = useQuery({
    queryKey: ['activeStudent'],
    queryFn: api.getActiveStudent,
    refetchInterval: 15000,
  });
  const current = active?.student || null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['activeStudent'] });
    queryClient.invalidateQueries({ queryKey: ['students'] });
    queryClient.invalidateQueries({ queryKey: ['teacherAnalytics'] });
  };
  const report = (tone, text) => setResult({ tone, text });

  const choose = useMutation({
    mutationFn: (studentId) => api.setActiveStudent(studentId),
    onSuccess: (data) => {
      refresh();
      setChoice('');
      report('success', data.student
        ? `Recording for ${data.student.name} from now on.`
        : 'No student chosen. Commands are not added to anyone\'s progress.');
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
    onSuccess: () => { refresh(); setConfirmRemove(null); report('success', 'Student removed.'); },
    onError: (err) => report('error', err.message),
  });

  const since = active?.startedAt ? active.startedAt.slice(11, 16) : null;
  const selected = choice === '' ? null : choice;

  return (
    <Panel title="Who is using this computer" titleId="who-heading" icon={Users} className="section"
      aside={current
        ? <StatusPill tone="success" label="Recording" />
        : <StatusPill tone="neutral" label="No student" />}>
      <p className="panel-lead" aria-live="polite">
        {current
          ? <>Recording for <strong>{current.name}</strong>{since ? ` since ${since}` : ''}. Their voice commands count toward their progress.</>
          : 'No student chosen. Voice commands are not added to anyone\'s progress until you choose one.'}
      </p>

      <div className="form-row">
        <Field id="who-select" label="Student at this computer" className="grow">
          <select id="who-select" className="field-input" value={choice} onChange={e => setChoice(e.target.value)}>
            <option value="">Choose a student</option>
            {students.map(s => (
              <option key={s.id} value={s.id}>{s.name}{current?.id === s.id ? ' (now)' : ''}</option>
            ))}
          </select>
        </Field>
        <Button variant="primary"
          disabled={!selected || choose.isPending}
          onClick={() => choose.mutate(Number(selected))}>
          {choose.isPending ? 'Starting…' : 'Start their session'}
        </Button>
        {current && (
          <Button disabled={choose.isPending} onClick={() => choose.mutate(null)}>
            End session
          </Button>
        )}
      </div>

      <form
        onSubmit={e => { e.preventDefault(); if (newName.trim()) add.mutate(newName.trim()); }}
        className="form-row"
      >
        <TextField id="who-new" label="Add a student" className="grow" value={newName} maxLength={80}
          onChange={e => setNewName(e.target.value)} placeholder="First name, or initials" autoComplete="off" />
        <Button type="submit" icon={PlusCircle} disabled={!newName.trim() || add.isPending}>
          {add.isPending ? 'Adding…' : 'Add student'}
        </Button>
      </form>

      {students.length > 0 && (
        <details className="disclosure">
          <summary>Remove a student ({students.length})</summary>
          <ul className="remove-list">
            {students.map(s => (
              <li key={s.id}>
                <span className="remove-list-name">{s.name}</span>
                {confirmRemove === s.id ? (
                  <>
                    <span className="muted-note">Their goals stay; their name goes.</span>
                    <Button variant="danger" disabled={remove.isPending}
                      onClick={() => remove.mutate(s.id)}>Remove {s.name}</Button>
                    <Button onClick={() => setConfirmRemove(null)}>Keep</Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirmRemove(s.id)}
                    aria-label={`Remove ${s.name}`}>Remove</Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className={`form-result ${result?.tone || ''}`} role="status" aria-live="polite">
        {result?.text || ''}
      </p>
    </Panel>
  );
}

// ── Usage Context Strip (secondary) ──
function UsageStrip() {
  const { data: stats } = useQuery({
    queryKey: ['commandStats'],
    queryFn: api.getCommandStats,
    staleTime: 30000,
  });
  return (
    <section aria-label="Usage context" className="usage-strip">
      <p>
        <strong>Usage (context only):</strong>
        {' '}<span className="tabular">{stats?.today ?? '—'}</span> commands today
        {stats?.avgLatency ? <>, <span className="tabular">{stats.avgLatency}</span> ms average</> : ''}.
        {' '}The progress data above is the main measure.
      </p>
    </section>
  );
}

// ── Teacher Page ──
export default function Teacher() {
  const queryClient = useQueryClient();
  const [studentId, setStudentId] = useState(null);
  const [goalId, setGoalId] = useState(null);

  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ['students'],
    queryFn: () => api.getStudents({ all: 1 }),
    staleTime: 30000,
  });

  const { data: goals = [] } = useQuery({
    queryKey: ['goals', studentId, 'all'],
    queryFn: () => api.getGoals(studentId, 'all'),
    enabled: !!studentId,
    staleTime: 10000,
  });

  const selectedGoal = goals.find(g => g.id === goalId) || null;

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

  const handleAck = async (flagId) => {
    await api.acknowledgeFlag(flagId);
    queryClient.invalidateQueries({ queryKey: ['flags', goalId] });
  };

  const handleStudentChange = (e) => {
    setStudentId(e.target.value || null);
    setGoalId(null);
  };

  return (
    <div className="teacher-page">
      <header className="page-header">
        <h2><TrendingUp size={28} aria-hidden="true" /> Progress monitoring</h2>
        <p>Tier 2 goal-based progress monitoring for individual students.</p>
      </header>

      <WhoIsHerePanel students={students} />

      <AnalyticsSummary />

      {/* Student selector */}
      <section aria-label="Student selection" className="section">
        <Field id="teacher-student-select" label="View a student's progress" className="narrow"
          hint={studentsLoading ? 'Loading students…' : undefined}>
          <select
            id="teacher-student-select"
            className="field-input"
            value={studentId || ''}
            onChange={handleStudentChange}
          >
            <option value="">Select a student</option>
            {students.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
      </section>

      {studentId && (
        <>
          {/* 1. Flag banner */}
          {goalId && (
            <FlagBanner flags={flags} onAck={handleAck} />
          )}

          {/* 2. Progress chart (when goal is selected and has valid dates) */}
          {selectedGoal && (
            <section aria-labelledby="progress-heading" className="section">
              <div className="section-head">
                <h3 id="progress-heading" className="section-title">
                  <LineChart size={22} aria-hidden="true" /> Progress: {MEASURE_REGISTRY[selectedGoal.measure]?.label?.toLowerCase()}
                </h3>
                <span className="muted-note tabular">
                  {points.length} point{points.length !== 1 ? 's' : ''} · {phases.length} phase{phases.length !== 1 ? 's' : ''}
                </span>
              </div>
              <Panel as="div" level={1}>
                <ProgressChart goal={selectedGoal} points={points} phases={phases} />
              </Panel>

              <GoalActions
                goalId={goalId}
                status={selectedGoal.status}
                queryClient={queryClient}
                onDeselect={() => { setGoalId(null); queryClient.invalidateQueries({ queryKey: ['goals', studentId, 'all'] }); }}
              />

              {/* Phase quick-add */}
              <PhasePanel goalId={goalId} queryClient={queryClient} />
            </section>
          )}

          {/* 3. Goal panel */}
          <GoalSetupPanel
            studentId={studentId}
            goals={goals}
            selectedGoalId={goalId}
            onGoalSelect={setGoalId}
            onGoalCreated={() => queryClient.invalidateQueries({ queryKey: ['goals', studentId, 'all'] })}
            queryClient={queryClient}
          />

          {/* 4. How well they are heard, and the settings that help */}
          <RecognitionReadout studentId={studentId} />
          <SpeechSettings
            studentId={studentId}
            studentName={students.find(s => String(s.id) === String(studentId))?.name || 'this student'}
          />

          {/* 5. Secondary usage strip */}
          <UsageStrip />
        </>
      )}
    </div>
  );
}
