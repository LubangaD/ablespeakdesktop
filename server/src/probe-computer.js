/**
 * Probe computer — computes per-day measure values from command history
 * and evaluates decision rules to produce flags.
 *
 * Two lifecycle exports allow the hourly scheduler to be started/stopped
 * explicitly so tests that import this module never start the interval.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  getGoals,
  getCommandsForStudentDate,
  upsertProgressPoint,
  getProgressPoints,
  insertDecisionFlag,
  getDecisionFlags,
} from './db.js';
import { evaluateRules, MEASURE_REGISTRY } from './progress-rules.js';

// ── Measure computation (pure layer, exported for testing) ──

/**
 * Compute the probe value for one measure from a set of command rows.
 *
 * Measure definitions (attempted = rows with outcome NOT NULL):
 *   independence_rate   — (outcome='success' AND prompt_count=0) / attempted
 *   task_completion     — (outcome IN ('success','repaired')) / attempted
 *   prompts_to_complete — AVG(prompt_count) over rows with outcome IN ('success','repaired')
 *
 * Returns null when:
 *   - attempted < 3 (too noisy — minimum probe-day sample)
 *   - measure = prompts_to_complete AND no completed rows (can't compute average)
 *   - measure is not in the registry
 *
 * @param {string} measure
 * @param {Array<object>} commandRows  rows from the commands table
 * @returns {{value: number, sampleSize: number}|null}
 */
export function computeProbeValue(measure, commandRows) {
  if (!(measure in MEASURE_REGISTRY)) return null;

  // Attempted = rows with a non-null outcome (voice-path rows set this via T1)
  const attempted = commandRows.filter(r => r.outcome != null);
  if (attempted.length < 3) return null;

  if (measure === 'independence_rate') {
    const independent = attempted.filter(
      r => r.outcome === 'success' && (r.prompt_count === 0 || r.prompt_count === '0')
    );
    return { value: independent.length / attempted.length, sampleSize: attempted.length };
  }

  if (measure === 'task_completion') {
    const completed = attempted.filter(
      r => r.outcome === 'success' || r.outcome === 'repaired'
    );
    return { value: completed.length / attempted.length, sampleSize: attempted.length };
  }

  if (measure === 'prompts_to_complete') {
    const completed = attempted.filter(
      r => r.outcome === 'success' || r.outcome === 'repaired'
    );
    if (completed.length === 0) return null;
    const total = completed.reduce((sum, r) => sum + (Number(r.prompt_count) || 0), 0);
    const avg = total / completed.length;
    return { value: avg, sampleSize: completed.length };
  }

  return null;
}

// ── DB-integrated probe computation ──

/**
 * For every active goal, pull that student's commands for isoDate,
 * compute the probe value, and upsert a progress_point with source='auto'.
 * Never overwrites a manual point.
 *
 * @param {string} isoDate  YYYY-MM-DD
 */
export async function computeProbesForDate(isoDate) {
  const goals = getGoals({ status: 'active' });
  for (const goal of goals) {
    const commands = getCommandsForStudentDate(goal.student_id, isoDate);
    const result = computeProbeValue(goal.measure, commands);
    if (result !== null) {
      upsertProgressPoint({
        id: uuidv4(),
        goal_id: goal.id,
        student_id: goal.student_id,
        measured_at: isoDate,
        value: result.value,
        source: 'auto',
        sample_size: result.sampleSize,
      });
    }
  }
}

/**
 * Run evaluateRules for a goal and insert a decision_flag for each rule
 * that fires — unless an unacknowledged flag with the same goal_id + rule
 * already exists (avoid duplicate alerts).
 *
 * @param {string} goalId
 * @param {string} todayIso  YYYY-MM-DD
 */
export async function evaluateAndFlag(goalId, todayIso) {
  const goals = getGoals({ status: 'active' });
  const goal = goals.find(g => g.id === goalId);
  if (!goal) return; // goal not found or not active

  const points = getProgressPoints(goalId);
  const firingRules = evaluateRules(goal, points, todayIso);

  const existingUnacked = getDecisionFlags({ goalId, unacknowledgedOnly: true });
  const unackedRuleSet = new Set(existingUnacked.map(f => f.rule));

  for (const { rule, detail } of firingRules) {
    if (!unackedRuleSet.has(rule)) {
      insertDecisionFlag({
        id: uuidv4(),
        goal_id: goalId,
        rule,
        fired_at: todayIso,
        detail: JSON.stringify(detail),
      });
    }
  }
}

// ── Scheduler (explicit start/stop — never auto-started on import) ──

let _probeInterval = null;

/**
 * Start the hourly probe scheduler.
 * On boot: computes yesterday + today for all active goals.
 * Hourly: recomputes today and runs evaluateAndFlag for all active goals.
 *
 * Must be called explicitly (e.g., in the server.listen callback).
 * Tests never call this, so the interval never starts during test runs.
 *
 * @param {() => string} todayFn  injectable for testability (defaults to ISO today)
 * @returns {NodeJS.Timeout}
 */
export function startProbeScheduler(todayFn = () => new Date().toISOString().slice(0, 10)) {
  if (_probeInterval) return _probeInterval; // idempotent

  const runDaily = async () => {
    const today = todayFn();
    const yesterdayMs = new Date(today).getTime() - 86400000;
    const yesterday = new Date(yesterdayMs).toISOString().slice(0, 10);
    try {
      await computeProbesForDate(yesterday);
      await computeProbesForDate(today);
      const goals = getGoals({ status: 'active' });
      for (const g of goals) {
        await evaluateAndFlag(g.id, today);
      }
    } catch (err) {
      console.error('[ProbeScheduler] Error:', err.message);
    }
  };

  // Boot: compute retroactively for yesterday + today
  runDaily().catch(err => console.error('[ProbeScheduler] Boot error:', err.message));

  // Hourly recompute
  _probeInterval = setInterval(async () => {
    const today = todayFn();
    try {
      await computeProbesForDate(today);
      const goals = getGoals({ status: 'active' });
      for (const g of goals) {
        await evaluateAndFlag(g.id, today);
      }
    } catch (err) {
      console.error('[ProbeScheduler] Hourly error:', err.message);
    }
  }, 60 * 60 * 1000);

  return _probeInterval;
}

/**
 * Stop the hourly probe scheduler (e.g., on server shutdown or in test teardown).
 */
export function stopProbeScheduler() {
  if (_probeInterval) {
    clearInterval(_probeInterval);
    _probeInterval = null;
  }
}

/**
 * Returns true when the probe scheduler should run on this device.
 *
 * A sync RECEIVER (teacher device) gets authoritative points/flags via ingest;
 * running the scheduler there would double-compute with different UUIDs,
 * bypassing the INSERT OR IGNORE dedup in ingestRows → duplicate flag banners
 * that cannot be jointly acknowledged.
 *
 * NOTE: changing sync.role requires a server restart for the bind-host change
 * to take effect; the same restart resets the scheduler via this guard.
 *
 * @param {object} settings  result of getAppSettings()
 * @returns {boolean}
 */
export function shouldRunProbeScheduler(settings) {
  const role = settings?.sync?.role;
  return role !== 'receiver';
}
