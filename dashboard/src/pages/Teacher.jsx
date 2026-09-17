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
 * WCAG AA+: aria-labels, ≥44px targets, focus rings, 7:1 contrast for text, reduced-motion.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { RecognitionReadout, SpeechSettings } from '../components/StudentSpeech';
import { AlertTriangle, CheckCircle2, Flag, TrendingUp, Target, PlusCircle, ChevronDown, ChevronUp } from 'lucide-react';

// Today in this computer's time zone — the server counts days the same way.
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Inline math (mirrors server/src/progress-rules.js — no shared import) ──

const MEASURE_REGISTRY = {
  independence_rate: { label: 'Independence Rate', description: 'Tasks completed without any prompts', lowerIsBetter: false },
  task_completion: { label: 'Task Completion', description: 'Tasks completed (success or repaired)', lowerIsBetter: false },
  prompts_to_complete: { label: 'Prompts to Complete', description: 'Average prompts needed — lower is better', lowerIsBetter: true },
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

// ── SVG chart dimensions ──
const W = 760, H = 360;
const ML = 64, MR = 24, MT = 20, MB = 56;
const CW = W - ML - MR, CH = H - MT - MB;

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
  let trendLineEl = null;
  if (trend && sorted.length >= 2) {
    const D0 = dateToDay(sorted[0].measured_at);
    const trendAt = d => trend.slope * (d - D0) + trend.intercept;
    trendLineEl = (
      <line
        x1={dayX(0)} y1={valY(trendAt(0))}
        x2={dayX(totalDays)} y2={valY(trendAt(totalDays))}
        stroke="#ef4444" strokeWidth={2} strokeDasharray="none"
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
    <div style={{ overflowX: 'auto' }}>
      <svg
        role="img"
        aria-label={ariaLabel}
        width={W} height={H}
        style={{ display: 'block', background: 'var(--surface-1)', borderRadius: 'var(--radius)', maxWidth: '100%' }}
      >
        {/* Y grid lines */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={ML} y1={valY(v)} x2={ML + CW} y2={valY(v)} stroke="#1a2a40" strokeWidth={1} />
            <text x={ML - 8} y={valY(v) + 4} textAnchor="end" fontSize={11} fill="#5a6a7a">
              {MEASURE_REGISTRY[goal.measure]?.lowerIsBetter ? v.toFixed(1) : (yRange <= 1.1 ? (v * 100).toFixed(0) + '%' : v.toFixed(1))}
            </text>
          </g>
        ))}

        {/* X axis ticks */}
        {xTickDays.map((d, i) => (
          <g key={i}>
            <line x1={dayX(d)} y1={MT} x2={dayX(d)} y2={MT + CH} stroke="#111d30" strokeWidth={1} />
            <text x={dayX(d)} y={MT + CH + 16} textAnchor="middle" fontSize={10} fill="#5a6a7a">
              {dayToIso(d).slice(5)} {/* MM-DD */}
            </text>
          </g>
        ))}

        {/* Chart border */}
        <rect x={ML} y={MT} width={CW} height={CH} fill="none" stroke="#1a2a40" strokeWidth={1} />

        {/* Phase change vertical lines */}
        {phases.map(phase => {
          const d = dateToDay(phase.changed_at);
          if (d < 0 || d > totalDays) return null;
          const x = dayX(d);
          return (
            <g key={phase.id}>
              <line x1={x} y1={MT} x2={x} y2={MT + CH} stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="6 3" />
              <text x={x + 3} y={MT + 14} fontSize={10} fill="#8b5cf6" style={{ fontWeight: 600 }}>
                {phase.label.slice(0, 12)}
              </text>
            </g>
          );
        })}

        {/* Aim line (dashed, orange) */}
        <line x1={aimX1} y1={aimY1} x2={aimX2} y2={aimY2} stroke="#F5A623" strokeWidth={2} strokeDasharray="8 4" />

        {/* Trend line (solid, red) */}
        <clipPath id={`chart-clip-${goal.id}`}>
          <rect x={ML} y={MT} width={CW} height={CH} />
        </clipPath>
        <g clipPath={`url(#chart-clip-${goal.id})`}>
          {trendLineEl}
        </g>

        {/* Today marker */}
        {todayInRange && (
          <g>
            <line x1={dayX(todayDay)} y1={MT} x2={dayX(todayDay)} y2={MT + CH} stroke="#5a6a7a" strokeWidth={1} strokeDasharray="4 3" />
            <text x={dayX(todayDay) + 3} y={MT + CH - 4} fontSize={10} fill="#5a6a7a">today</text>
          </g>
        )}

        {/* Data points — auto=circles, manual=squares */}
        {sorted.map(p => {
          const d = dateToDay(p.measured_at);
          const x = dayX(d);
          const y = valY(Number(p.value));
          const isManual = p.source === 'manual';
          return isManual ? (
            <rect key={p.id || p.measured_at}
              x={x - 5} y={y - 5} width={10} height={10}
              fill="#10b981" stroke="#065f46" strokeWidth={1.5}
              aria-hidden="true"
            />
          ) : (
            <circle key={p.id || p.measured_at}
              cx={x} cy={y} r={5}
              fill="#3b82f6" stroke="#1e3a5f" strokeWidth={1.5}
              aria-hidden="true"
            />
          );
        })}

        {/* Axes labels */}
        <text x={ML + CW / 2} y={H - 4} textAnchor="middle" fontSize={12} fill="#8a9aaa">Date</text>
        <text x={14} y={MT + CH / 2} textAnchor="middle" fontSize={12} fill="#8a9aaa"
          transform={`rotate(-90, 14, ${MT + CH / 2})`}>
          {MEASURE_REGISTRY[goal.measure]?.label}
        </text>

        {/* Legend */}
        <g transform={`translate(${ML + 8}, ${MT + 8})`}>
          <circle cx={6} cy={6} r={5} fill="#3b82f6" />
          <text x={15} y={10} fontSize={10} fill="#8a9aaa">Auto probe</text>
          <rect x={1} y={16} width={10} height={10} fill="#10b981" />
          <text x={15} y={25} fontSize={10} fill="#8a9aaa">Manual probe</text>
          <line x1={0} y1={36} x2={20} y2={36} stroke="#F5A623" strokeWidth={2} strokeDasharray="6 3" />
          <text x={25} y={40} fontSize={10} fill="#8a9aaa">Aim line</text>
          {trend && sorted.length >= 2 && (
            <>
              <line x1={0} y1={48} x2={20} y2={48} stroke="#ef4444" strokeWidth={2} />
              <text x={25} y={52} fontSize={10} fill="#8a9aaa">Trend</text>
            </>
          )}
        </g>
      </svg>

      {/* Visually-hidden data table for screen readers */}
      <table
        aria-label="Progress data table"
        style={{
          position: 'absolute', width: 1, height: 1,
          overflow: 'hidden', clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap', border: 0,
        }}
      >
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
    <div role="alert" aria-live="assertive" style={{
      background: 'rgba(251, 113, 133,0.08)',
      border: '1px solid rgba(251, 113, 133,0.4)',
      borderRadius: 'var(--radius-sm)',
      padding: '12px 16px',
      marginBottom: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <AlertTriangle size={18} style={{ color: 'var(--error)', flexShrink: 0 }} aria-hidden="true" />
        <strong style={{ color: 'var(--error)', fontSize: 15 }}>
          {flags.length} Decision Flag{flags.length !== 1 ? 's' : ''}
        </strong>
      </div>
      {flags.map(f => (
        <div key={f.id} style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 12, padding: '8px 0', borderTop: '1px solid rgba(251, 113, 133,0.2)',
        }}>
          <p style={{ fontSize: 14, color: 'var(--text-primary)', margin: 0, flex: 1 }}>
            <strong style={{ color: 'var(--error)' }}>{f.rule}</strong>
            {' — '}
            {RULE_GUIDANCE[f.rule] || 'Review this goal.'}
            <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 8 }}>
              {f.fired_at}
            </span>
          </p>
          <button
            onClick={() => onAck(f.id)}
            aria-label={`Acknowledge ${f.rule} flag from ${f.fired_at}`}
            style={{
              padding: '6px 14px', minHeight: 44, minWidth: 100,
              borderRadius: 'var(--radius-sm)', border: '1px solid rgba(251, 113, 133,0.4)',
              background: 'transparent', color: 'var(--error)', fontSize: 13,
              fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0,
            }}
          >
            Acknowledge
          </button>
        </div>
      ))}
    </div>
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

  const inp = { width: '100%', padding: '10px 12px', minHeight: 44, background: 'var(--canvas)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit' };
  const lbl = { display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 };

  return (
    <section aria-label="Goal management" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-secondary)' }}>GOALS</h3>
        <button
          onClick={() => setShowForm(f => !f)}
          aria-expanded={showForm}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'none', color: 'var(--accent)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
        >
          <PlusCircle size={16} aria-hidden="true" />
          New Goal {showForm ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Existing goals list */}
      {goals && goals.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {goals.map(g => (
            <button
              key={g.id}
              onClick={() => onGoalSelect(g.id)}
              aria-pressed={selectedGoalId === g.id}
              style={{
                padding: '10px 14px', minHeight: 44, textAlign: 'left',
                background: selectedGoalId === g.id ? 'var(--surface-3)' : 'var(--surface-2)',
                border: `1px solid ${selectedGoalId === g.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 12,
              }}
            >
              <Target size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} aria-hidden="true" />
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 14 }}>
                  {MEASURE_REGISTRY[g.measure]?.label}
                </span>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 8 }}>
                  {g.baseline_date} → {g.target_date}
                </span>
              </span>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: g.status === 'active' ? 'rgba(29,158,138,0.15)' : 'var(--surface-3)', color: g.status === 'active' ? 'var(--success)' : 'var(--text-secondary)' }}>
                {g.status}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Goal creation form */}
      {showForm && (
        <div className="card">
          <h4 style={{ fontWeight: 600, fontSize: '1rem', marginBottom: 16 }}>Create Goal</h4>
          <form onSubmit={createGoal} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label htmlFor="goal-measure" style={lbl}>Measure</label>
              <select id="goal-measure" value={measure} onChange={e => setMeasure(e.target.value)} style={inp}>
                {Object.entries(MEASURE_REGISTRY).map(([k, v]) => (
                  <option key={k} value={k}>{v.label} — {v.description}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label htmlFor="goal-baseline-val" style={lbl}>Baseline Value</label>
                <input id="goal-baseline-val" type="number" step="any" value={baselineValue}
                  onChange={e => setBaselineValue(e.target.value)} required
                  placeholder="e.g. 0.20"
                  style={inp}
                />
              </div>
              <button type="button" onClick={suggest} disabled={suggestionLoading}
                aria-label="Suggest baseline from last 14 days of data"
                style={{ padding: '10px 14px', minHeight: 44, flexShrink: 0, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
                {suggestionLoading ? '...' : 'Suggest'}
              </button>
            </div>

            <div>
              <label htmlFor="goal-baseline-date" style={lbl}>Baseline Date</label>
              <input id="goal-baseline-date" type="date" value={baselineDate}
                onChange={e => setBaselineDate(e.target.value)} required style={inp} />
            </div>

            <div>
              <label htmlFor="goal-target-val" style={lbl}>Target Value</label>
              <input id="goal-target-val" type="number" step="any" value={targetValue}
                onChange={e => setTargetValue(e.target.value)} required
                placeholder="e.g. 0.80"
                style={inp}
              />
            </div>

            <div>
              <label htmlFor="goal-target-date" style={lbl}>Target Date</label>
              <input id="goal-target-date" type="date" value={targetDate}
                onChange={e => setTargetDate(e.target.value)} required style={inp} />
            </div>

            {formError && (
              <p style={{ color: 'var(--error)', fontSize: 13, margin: 0 }} role="alert">{formError}</p>
            )}

            <button type="submit" disabled={createLoading}
              style={{ padding: '10px 16px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
              {createLoading ? 'Creating…' : 'Create Goal'}
            </button>
          </form>
        </div>
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

  const inp = { width: '100%', padding: '10px 12px', minHeight: 44, background: 'var(--canvas)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit' };
  const lbl = { display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 };

  return (
    <section aria-label="Add phase change" style={{ marginBottom: 24 }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12 }}>PHASE CHANGE</h3>
      <div className="card">
        <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label htmlFor="phase-label" style={lbl}>What changed?</label>
            <input id="phase-label" type="text" value={label} onChange={e => setLabel(e.target.value)} required
              placeholder="e.g. Switched to visual cues" style={inp} />
          </div>
          <div>
            <label htmlFor="phase-date" style={lbl}>Date of change</label>
            <input id="phase-date" type="date" value={changedAt} onChange={e => setChangedAt(e.target.value)} required style={inp} />
          </div>
          <div>
            <label htmlFor="phase-note" style={lbl}>Note (optional)</label>
            <input id="phase-note" type="text" value={note} onChange={e => setNote(e.target.value)}
              placeholder="Additional context" style={inp} />
          </div>
          {err && <p style={{ color: 'var(--error)', fontSize: 13, margin: 0 }} role="alert">{err}</p>}
          <button type="submit"
            style={{ alignSelf: 'flex-start', padding: '10px 16px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
            Mark Phase Change
          </button>
        </form>
      </div>
    </section>
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
    <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
      <button onClick={() => updateStatus('met')} disabled={!!loading}
        aria-label="Mark goal as met"
        style={{ padding: '8px 16px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: '1px solid var(--success)', background: 'transparent', color: 'var(--success)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
        <CheckCircle2 size={16} style={{ verticalAlign: -2, marginRight: 6 }} aria-hidden="true" />
        {loading === 'met' ? 'Saving…' : 'Mark Met'}
      </button>
      <button onClick={() => updateStatus('discontinued')} disabled={!!loading}
        aria-label="Mark goal as discontinued"
        style={{ padding: '8px 16px', minHeight: 44, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
        {loading === 'discontinued' ? 'Saving…' : 'Discontinue'}
      </button>
    </div>
  );
}

// ── Class Analytics Summary: success rate, commands, latency ──
// Uses the existing, already-working GET /api/teacher/analytics endpoint
// (server/src/db.js getTeacherAnalytics()) — this data has always been
// computed correctly, it just was never rendered anywhere in the dashboard.
const thStyle = { textAlign: 'left', padding: '10px 14px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', fontWeight: 600 };
const tdStyle = { padding: '10px 14px', color: 'var(--text-primary)' };

function SummaryCard({ label, value, accent }) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent ? 'var(--accent)' : 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function AnalyticsSummary() {
  const { data: analytics, isLoading, error } = useQuery({
    queryKey: ['teacherAnalytics'],
    queryFn: api.getTeacherAnalytics,
    staleTime: 15000,
    refetchInterval: 30000,
  });

  if (isLoading) {
    return <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading class analytics…</p>;
  }
  if (error) {
    return <p style={{ fontSize: 13, color: 'var(--error)' }}>Could not load class analytics: {error.message}</p>;
  }

  const { summary, students } = analytics;

  return (
    <section aria-label="Class success rate summary" style={{ marginBottom: 32 }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12 }}>
        SUCCESS RATE — ALL STUDENTS
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
        <SummaryCard label="Success Rate" value={`${summary.successRate}%`} accent />
        <SummaryCard label="Total Commands" value={summary.totalCommands} />
        <SummaryCard label="Today" value={summary.todayCommands} />
        <SummaryCard label="Avg Latency" value={`${summary.avgLatency}ms`} />
        <SummaryCard label="Students" value={summary.totalStudents} />
      </div>

      {students.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          No students added yet — add one above to start tracking success rate.
        </p>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <caption className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
              Per-student success rate, command count, average latency, sessions in the last 7 days, most-used command, and last active time
            </caption>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={thStyle} scope="col">Student</th>
                <th style={thStyle} scope="col">Success Rate</th>
                <th style={thStyle} scope="col">Commands</th>
                <th style={thStyle} scope="col">Avg Latency</th>
                <th style={thStyle} scope="col">Sessions (7 days)</th>
                <th style={thStyle} scope="col">Top Command</th>
                <th style={thStyle} scope="col">Last Active</th>
              </tr>
            </thead>
            <tbody>
              {students.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={tdStyle}>{s.name}</td>
                  <td style={tdStyle}>
                    <span style={{
                      fontWeight: 600,
                      color: s.commands === 0 ? 'var(--text-secondary)'
                        : s.successRate >= 80 ? 'var(--success)'
                        : s.successRate >= 50 ? 'var(--warning)'
                        : 'var(--error)',
                    }}>
                      {s.commands === 0 ? '—' : `${s.successRate}%`}
                    </span>
                  </td>
                  <td style={tdStyle}>{s.commands}</td>
                  <td style={tdStyle}>{s.avgLatency ? `${s.avgLatency}ms` : '—'}</td>
                  <td style={tdStyle}>{s.sessionsThisWeek ?? 0}</td>
                  <td style={tdStyle}>{s.topCommand}</td>
                  <td style={tdStyle}>{s.lastActive}</td>
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
    <section aria-labelledby="who-heading" className="card" style={{ marginBottom: 32 }}>
      <h3 id="who-heading" className="settings-heading">Who is using this computer</h3>
      <p className="settings-lead" aria-live="polite">
        {current
          ? <>Recording for <strong>{current.name}</strong>{since ? ` since ${since}` : ''}. Their voice commands count toward their progress.</>
          : 'No student chosen. Voice commands are not added to anyone\'s progress until you choose one.'}
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="who-select" className="settings-label">Student at this computer</label>
          <select id="who-select" className="settings-input" value={choice} onChange={e => setChoice(e.target.value)}>
            <option value="">— choose a student —</option>
            {students.map(s => (
              <option key={s.id} value={s.id}>{s.name}{current?.id === s.id ? ' (now)' : ''}</option>
            ))}
          </select>
        </div>
        <button type="button" className="settings-btn primary"
          disabled={!selected || choose.isPending}
          onClick={() => choose.mutate(Number(selected))}>
          {choose.isPending ? 'Starting…' : 'Start their session'}
        </button>
        {current && (
          <button type="button" className="settings-btn quiet"
            disabled={choose.isPending}
            onClick={() => choose.mutate(null)}>
            End session
          </button>
        )}
      </div>

      <form
        onSubmit={e => { e.preventDefault(); if (newName.trim()) add.mutate(newName.trim()); }}
        style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="who-new" className="settings-label">Add a student</label>
          <input id="who-new" className="settings-input" value={newName} maxLength={80}
            onChange={e => setNewName(e.target.value)} placeholder="First name, or initials" autoComplete="off" />
        </div>
        <button type="submit" className="settings-btn quiet" disabled={!newName.trim() || add.isPending}>
          {add.isPending ? 'Adding…' : 'Add student'}
        </button>
      </form>

      {students.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
            Remove a student ({students.length})
          </summary>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {students.map(s => (
              <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, color: 'var(--text-primary)' }}>{s.name}</span>
                {confirmRemove === s.id ? (
                  <>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Their goals stay; their name goes.</span>
                    <button type="button" className="settings-btn danger" disabled={remove.isPending}
                      onClick={() => remove.mutate(s.id)}>Remove {s.name}</button>
                    <button type="button" className="settings-btn quiet" onClick={() => setConfirmRemove(null)}>Keep</button>
                  </>
                ) : (
                  <button type="button" className="settings-btn quiet" onClick={() => setConfirmRemove(s.id)}
                    aria-label={`Remove ${s.name}`}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className={`settings-result ${result?.tone || ''}`} role="status" aria-live="polite">
        {result?.text || ''}
      </p>
    </section>
  );
}

// ── Usage Context Strip (secondary) ──
function UsageStrip({ studentId }) {
  const { data: stats } = useQuery({
    queryKey: ['commandStats'],
    queryFn: api.getCommandStats,
    staleTime: 30000,
  });
  return (
    <section aria-label="Usage context" style={{
      borderTop: '1px solid var(--border)',
      paddingTop: 12,
      marginTop: 24,
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
    }}>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
        <strong style={{ color: 'var(--text-secondary)' }}>Usage (context only):</strong>
        {' '}{stats?.today ?? '—'} commands today
        {stats?.avgLatency ? ` · ${stats.avgLatency}ms avg` : ''}
        {' '}&mdash; progress data above is the primary clinical measure.
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
    <div>
      <header className="page-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={24} aria-hidden="true" style={{ color: 'var(--accent)' }} />
          Progress Monitoring
        </h2>
        <p>Tier 2 — goal-referenced progress monitoring for individual students</p>
      </header>

      <WhoIsHerePanel students={students} />

      <AnalyticsSummary />

      {/* Student selector */}
      <section aria-label="Student selection" style={{ marginBottom: 24 }}>
        <label htmlFor="teacher-student-select" style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
          View a student's progress
        </label>
        <select
          id="teacher-student-select"
          value={studentId || ''}
          onChange={handleStudentChange}
          aria-label="Select a student to view progress"
          style={{ width: '100%', maxWidth: 360, padding: '10px 12px', minHeight: 44, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit' }}
        >
          <option value="">— select a student —</option>
          {students.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {studentsLoading && <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>Loading students…</p>}
      </section>

      {studentId && (
        <>
          {/* 1. Flag banner */}
          {goalId && (
            <FlagBanner flags={flags} onAck={handleAck} />
          )}

          {/* 2. Progress chart (when goal is selected and has valid dates) */}
          {selectedGoal && (
            <section aria-label="Progress chart" style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  PROGRESS — {MEASURE_REGISTRY[selectedGoal.measure]?.label?.toUpperCase()}
                </h3>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {points.length} point{points.length !== 1 ? 's' : ''} · {phases.length} phase{phases.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <ProgressChart goal={selectedGoal} points={points} phases={phases} />
              </div>

              {/* Goal actions */}
              <div style={{ marginTop: 12 }}>
                <GoalActions
                  goalId={goalId}
                  status={selectedGoal.status}
                  queryClient={queryClient}
                  onDeselect={() => { setGoalId(null); queryClient.invalidateQueries({ queryKey: ['goals', studentId, 'all'] }); }}
                />
              </div>

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
          <UsageStrip studentId={studentId} />
        </>
      )}
    </div>
  );
}
