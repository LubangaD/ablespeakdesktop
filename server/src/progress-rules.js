/**
 * Progress monitoring rules — pure, no DB, no side effects.
 * All functions exported for testing and reuse.
 */

/**
 * Registry of valid measures.
 * lowerIsBetter drives direction-aware comparisons throughout this module.
 */
export const MEASURE_REGISTRY = {
  independence_rate: {
    label: 'Independence Rate',
    description: 'Percentage of tasks completed without any prompts (success AND prompt_count=0)',
    lowerIsBetter: false,
  },
  task_completion: {
    label: 'Task Completion',
    description: 'Percentage of tasks completed with or without repair (success or repaired)',
    lowerIsBetter: false,
  },
  prompts_to_complete: {
    label: 'Prompts to Complete',
    description: 'Average number of prompts needed to complete a task — lower is better',
    lowerIsBetter: true,
  },
};

/**
 * Linear interpolation of the aim value at a given ISO date string (YYYY-MM-DD).
 * Before baseline_date → baseline_value; after target_date → target_value.
 * @param {object} goal
 * @param {string} isoDate
 * @returns {number}
 */
export function aimValueAt(goal, isoDate) {
  const { baseline_date, baseline_value, target_date, target_value } = goal;

  if (isoDate <= baseline_date) return Number(baseline_value);
  if (isoDate >= target_date) return Number(target_value);

  const baseMs = new Date(baseline_date).getTime();
  const targetMs = new Date(target_date).getTime();
  const dateMs = new Date(isoDate).getTime();

  const t = (dateMs - baseMs) / (targetMs - baseMs);
  return Number(baseline_value) + t * (Number(target_value) - Number(baseline_value));
}

/**
 * Median of all pairwise slopes (value per calendar day).
 * Returns null when there are fewer than 2 distinct dates.
 * @param {Array<{measured_at: string, value: number}>} points
 * @returns {number|null}
 */
export function theilSenSlope(points) {
  if (!points || points.length < 2) return null;

  const sorted = [...points].sort((a, b) => a.measured_at.localeCompare(b.measured_at));

  const distinctDates = new Set(sorted.map(p => p.measured_at));
  if (distinctDates.size < 2) return null;

  const slopes = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const dayDiff = (new Date(sorted[j].measured_at) - new Date(sorted[i].measured_at)) / 86400000;
      if (dayDiff !== 0) {
        slopes.push((Number(sorted[j].value) - Number(sorted[i].value)) / dayDiff);
      }
    }
  }

  if (slopes.length === 0) return null;

  slopes.sort((a, b) => a - b);
  const mid = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 0
    ? (slopes[mid - 1] + slopes[mid]) / 2
    : slopes[mid];
}

/**
 * Theil-Sen trend line.
 * slope = theilSenSlope(points) [value per calendar day]
 * intercept = median of (value - slope * dayIndex) where dayIndex is calendar days
 *             from the earliest point in the set.
 * Returns null when < 2 points.
 * @param {Array<{measured_at: string, value: number}>} points
 * @returns {{slope: number, intercept: number}|null}
 */
export function trendLine(points) {
  if (!points || points.length < 2) return null;

  const slope = theilSenSlope(points);
  if (slope === null) return null;

  const sorted = [...points].sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  const originMs = new Date(sorted[0].measured_at).getTime();

  const intercepts = sorted.map(p => {
    const dayIndex = (new Date(p.measured_at).getTime() - originMs) / 86400000;
    return Number(p.value) - slope * dayIndex;
  });

  intercepts.sort((a, b) => a - b);
  const mid = Math.floor(intercepts.length / 2);
  const intercept = intercepts.length % 2 === 0
    ? (intercepts[mid - 1] + intercepts[mid]) / 2
    : intercepts[mid];

  return { slope, intercept };
}

/**
 * Direction-aware "below aim" check.
 * Higher-better measures: value < aimValueAt → below aim (bad performance).
 * prompts_to_complete (lower-better): value > aimValueAt → below aim (bad: too many prompts).
 * @param {object} goal
 * @param {{measured_at: string, value: number}} point
 * @returns {boolean}
 */
export function isBelowAim(goal, point) {
  const aimVal = aimValueAt(goal, point.measured_at);
  const meta = MEASURE_REGISTRY[goal.measure];
  if (meta && meta.lowerIsBetter) {
    // Lower-better: "below aim" means numerically ABOVE the aim line (worse performance)
    return Number(point.value) > aimVal;
  }
  return Number(point.value) < aimVal;
}

/**
 * Direction-aware "above aim" check (performance exceeds aim).
 * Higher-better: value > aimValue.
 * Lower-better (prompts_to_complete): value < aimValue (fewer prompts than aimed = better).
 */
function isAboveAim(goal, point) {
  const aimVal = aimValueAt(goal, point.measured_at);
  const meta = MEASURE_REGISTRY[goal.measure];
  if (meta && meta.lowerIsBetter) {
    return Number(point.value) < aimVal;
  }
  return Number(point.value) > aimVal;
}

/**
 * Evaluate all decision rules for a goal.
 *
 * Rules:
 *   '4_below_aim'      — 4 most-recent consecutive points all below aim (direction-aware)
 *   '4_above_aim'      — 4 most-recent consecutive points all above aim (direction-aware)
 *   'trend_divergence' — ≥6 points AND |trend slope − aim slope| > 25% of |aim slope|
 *                        AND trend heads the WRONG direction relative to the goal
 *                        (skipped when aim slope is 0)
 *   'insufficient_data'— < 3 points in the 14 days before todayIso (only when goal is
 *                        ≥ 14 days old from baseline_date)
 *
 * @param {object} goal
 * @param {Array<{measured_at: string, value: number}>} points
 * @param {string} todayIso  YYYY-MM-DD
 * @returns {Array<{rule: string, detail: object}>}
 */
export function evaluateRules(goal, points, todayIso) {
  const result = [];

  const sorted = [...points].sort((a, b) => a.measured_at.localeCompare(b.measured_at));

  // ── 4_below_aim / 4_above_aim ──
  // The 4 most-recent points are the last 4 in date order.
  // Need at least 4 points for either rule to fire.
  const recent4 = sorted.slice(-4);
  if (recent4.length >= 4) {
    if (recent4.every(p => isBelowAim(goal, p))) {
      result.push({
        rule: '4_below_aim',
        detail: { points: recent4.map(p => ({ measured_at: p.measured_at, value: p.value })) },
      });
    }
    if (recent4.every(p => isAboveAim(goal, p))) {
      result.push({
        rule: '4_above_aim',
        detail: { points: recent4.map(p => ({ measured_at: p.measured_at, value: p.value })) },
      });
    }
  }

  // ── trend_divergence ──
  if (sorted.length >= 6) {
    const trend = trendLine(sorted);
    if (trend !== null) {
      const baseMs = new Date(goal.baseline_date).getTime();
      const targetMs = new Date(goal.target_date).getTime();
      const daySpan = (targetMs - baseMs) / 86400000;
      const aimSlope = daySpan > 0
        ? (Number(goal.target_value) - Number(goal.baseline_value)) / daySpan
        : 0;

      if (aimSlope !== 0) {
        const slopeDiff = Math.abs(trend.slope - aimSlope);
        const threshold = 0.25 * Math.abs(aimSlope);
        // "Wrong direction" means trend is literally heading opposite to what the goal requires
        const isWrongDirection =
          (aimSlope > 0 && trend.slope < 0) ||
          (aimSlope < 0 && trend.slope > 0);

        if (slopeDiff > threshold && isWrongDirection) {
          result.push({
            rule: 'trend_divergence',
            detail: { trendSlope: trend.slope, aimSlope, divergence: slopeDiff },
          });
        }
      }
    }
  }

  // ── insufficient_data ──
  // Only fires when the goal is at least 14 days old (baseline_date + 14 ≤ today).
  const baselineMs = new Date(goal.baseline_date).getTime();
  const todayMs = new Date(todayIso).getTime();
  const goalAgeDays = (todayMs - baselineMs) / 86400000;

  if (goalAgeDays >= 14) {
    // Count points in the 14-day window [today-14days, today] (inclusive)
    const windowStartMs = todayMs - 14 * 86400000;
    const windowStart = new Date(windowStartMs).toISOString().slice(0, 10);
    const recentPoints = sorted.filter(
      p => p.measured_at >= windowStart && p.measured_at <= todayIso
    );
    if (recentPoints.length < 3) {
      result.push({
        rule: 'insufficient_data',
        detail: { count: recentPoints.length, window: 14, windowStart },
      });
    }
  }

  return result;
}
