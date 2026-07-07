/**
 * TDD tests for progress-rules.js
 * Critical boundary checks:
 *   - aimValueAt at baseline / midpoint / target / outside range
 *   - Theil-Sen outlier robustness vs ordinary least-squares
 *   - Exactly-4 vs only-3 consecutive points for 4_below_aim
 *   - Direction-awareness: prompts_to_complete NUMERICALLY ABOVE aim = '4_below_aim'
 *   - trend_divergence fires / skips correctly
 *   - insufficient_data: goal too young → no fire; 2 pts → fire; 3 pts → no fire
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEASURE_REGISTRY,
  aimValueAt,
  theilSenSlope,
  trendLine,
  isBelowAim,
  evaluateRules,
} from './progress-rules.js';

// ── Helpers ──

function makeGoal(overrides = {}) {
  return {
    measure: 'independence_rate',
    baseline_date: '2025-01-01',
    baseline_value: 0.2,
    target_date: '2025-03-01',
    target_value: 0.8,
    decision_rule: '4_below_aim',
    ...overrides,
  };
}

function pt(measured_at, value) {
  return { measured_at, value };
}

// ── MEASURE_REGISTRY ──

test('MEASURE_REGISTRY: has the three required measures', () => {
  assert.ok('independence_rate' in MEASURE_REGISTRY);
  assert.ok('task_completion' in MEASURE_REGISTRY);
  assert.ok('prompts_to_complete' in MEASURE_REGISTRY);
});

test('MEASURE_REGISTRY: prompts_to_complete is lowerIsBetter', () => {
  assert.equal(MEASURE_REGISTRY.prompts_to_complete.lowerIsBetter, true);
});

test('MEASURE_REGISTRY: independence_rate and task_completion are higher-better', () => {
  assert.equal(MEASURE_REGISTRY.independence_rate.lowerIsBetter, false);
  assert.equal(MEASURE_REGISTRY.task_completion.lowerIsBetter, false);
});

// ── aimValueAt ──

test('aimValueAt: before baseline_date returns baseline_value', () => {
  const goal = makeGoal();
  assert.equal(aimValueAt(goal, '2024-12-31'), 0.2);
});

test('aimValueAt: exactly at baseline_date returns baseline_value', () => {
  const goal = makeGoal();
  assert.equal(aimValueAt(goal, '2025-01-01'), 0.2);
});

test('aimValueAt: exactly at target_date returns target_value', () => {
  const goal = makeGoal();
  assert.equal(aimValueAt(goal, '2025-03-01'), 0.8);
});

test('aimValueAt: after target_date returns target_value', () => {
  const goal = makeGoal();
  assert.equal(aimValueAt(goal, '2025-04-01'), 0.8);
});

test('aimValueAt: midpoint returns linear interpolation', () => {
  // baseline 0.2, target 0.8 → range 0.6
  // t = 0.5 → expected = 0.2 + 0.5 * 0.6 = 0.5
  const goal = makeGoal();
  const baseMs = new Date('2025-01-01').getTime();
  const targetMs = new Date('2025-03-01').getTime();
  const midDate = new Date(baseMs + (targetMs - baseMs) / 2).toISOString().slice(0, 10);
  const mid = aimValueAt(goal, midDate);
  // Truncating the midpoint ms to a date string shifts it by up to 0.5 day → tolerance 0.01
  assert.ok(Math.abs(mid - 0.5) < 0.01, `Expected ≈0.5, got ${mid}`);
});

test('aimValueAt: works for prompts_to_complete (downward aim)', () => {
  const goal = makeGoal({
    measure: 'prompts_to_complete',
    baseline_value: 5,
    target_value: 1,
  });
  // At baseline → 5; at target → 1
  assert.equal(aimValueAt(goal, '2025-01-01'), 5);
  assert.equal(aimValueAt(goal, '2025-03-01'), 1);
  // Midpoint → ≈3
  const baseMs = new Date('2025-01-01').getTime();
  const targetMs = new Date('2025-03-01').getTime();
  const midDate = new Date(baseMs + (targetMs - baseMs) / 2).toISOString().slice(0, 10);
  const mid = aimValueAt(goal, midDate);
  assert.ok(Math.abs(mid - 3) < 0.1, `Expected ≈3, got ${mid}`);
});

// ── theilSenSlope ──

test('theilSenSlope: null for empty array', () => {
  assert.equal(theilSenSlope([]), null);
});

test('theilSenSlope: null for single point', () => {
  assert.equal(theilSenSlope([pt('2025-01-01', 0.3)]), null);
});

test('theilSenSlope: null when all points share the same date', () => {
  assert.equal(theilSenSlope([
    pt('2025-01-01', 0.2),
    pt('2025-01-01', 0.5),
  ]), null);
});

test('theilSenSlope: two-point case gives exact slope', () => {
  // 0.0 → 1.0 over 10 days = 0.1/day
  const slope = theilSenSlope([
    pt('2025-01-01', 0.0),
    pt('2025-01-11', 1.0),
  ]);
  assert.ok(Math.abs(slope - 0.1) < 1e-9, `Expected 0.1, got ${slope}`);
});

test('theilSenSlope: handles unsorted input', () => {
  const slope = theilSenSlope([
    pt('2025-01-11', 1.0),
    pt('2025-01-01', 0.0),
  ]);
  assert.ok(Math.abs(slope - 0.1) < 1e-9);
});

test('theilSenSlope: outlier robustness — one wild point does NOT flip the slope', () => {
  /**
   * 5 points going up by 0.1/day, with one massive outlier at day 2 (value 100).
   *
   * Pairwise slopes (10 total):
   *   (d0,d1)=0.1  (d0,d2)=50  (d0,d3)=0.1  (d0,d4)=0.1
   *   (d1,d2)=99.9 (d1,d3)=0.1 (d1,d4)=0.1
   *   (d2,d3)=-99.7 (d2,d4)=-49.8
   *   (d3,d4)=0.1
   *
   * Sorted: [-99.7, -49.8, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 50, 99.9]
   * Median (indices 4,5): (0.1+0.1)/2 = 0.1  ← outlier has zero effect
   *
   * Ordinary least-squares would give a slope far from 0.1 due to the outlier.
   */
  const pts = [
    pt('2025-01-01', 0.0),
    pt('2025-01-02', 0.1),
    pt('2025-01-03', 100.0), // wild outlier
    pt('2025-01-04', 0.3),
    pt('2025-01-05', 0.4),
  ];
  const slope = theilSenSlope(pts);
  assert.ok(Math.abs(slope - 0.1) < 0.001, `Expected 0.1 (robust), got ${slope}`);
});

// ── trendLine ──

test('trendLine: null for empty array', () => {
  assert.equal(trendLine([]), null);
});

test('trendLine: null for single point', () => {
  assert.equal(trendLine([pt('2025-01-01', 0.3)]), null);
});

test('trendLine: returns slope and intercept for two points', () => {
  const pts = [
    pt('2025-01-01', 0.0),
    pt('2025-01-11', 1.0),
  ];
  const line = trendLine(pts);
  assert.ok(line !== null, 'should return object');
  assert.ok(Math.abs(line.slope - 0.1) < 1e-9, `slope expected 0.1, got ${line.slope}`);
  // intercept at dayIndex=0 (first point date): value = 0.0
  assert.ok(Math.abs(line.intercept - 0.0) < 1e-9, `intercept expected 0, got ${line.intercept}`);
});

// ── isBelowAim ──

test('isBelowAim: higher-better — value below aim → true', () => {
  const goal = makeGoal({ measure: 'independence_rate' }); // aim at baseline = 0.2
  assert.equal(isBelowAim(goal, pt('2025-01-01', 0.1)), true);
});

test('isBelowAim: higher-better — value above aim → false', () => {
  const goal = makeGoal({ measure: 'independence_rate' });
  assert.equal(isBelowAim(goal, pt('2025-01-01', 0.3)), false);
});

test('isBelowAim: higher-better — value exactly at aim → false (not below)', () => {
  const goal = makeGoal({ measure: 'independence_rate' });
  assert.equal(isBelowAim(goal, pt('2025-01-01', 0.2)), false);
});

test('isBelowAim: prompts_to_complete — value ABOVE aim → true (more prompts = bad)', () => {
  // aim at baseline = 5; value 6 > 5 → bad → below aim
  const goal = makeGoal({
    measure: 'prompts_to_complete',
    baseline_value: 5, target_value: 1,
  });
  assert.equal(isBelowAim(goal, pt('2025-01-01', 6)), true);
});

test('isBelowAim: prompts_to_complete — value BELOW aim → false (fewer prompts = good)', () => {
  const goal = makeGoal({
    measure: 'prompts_to_complete',
    baseline_value: 5, target_value: 1,
  });
  assert.equal(isBelowAim(goal, pt('2025-01-01', 3)), false);
});

// ── evaluateRules: 4_below_aim boundary (exactly-4 vs only-3) ──

test('evaluateRules: 4_below_aim does NOT fire with only 3 points below aim', () => {
  const goal = makeGoal();
  // aim at 2025-01-01 = 0.2; all values below
  const pts = [
    pt('2025-01-01', 0.1),
    pt('2025-01-02', 0.1),
    pt('2025-01-03', 0.1),
  ];
  const rules = evaluateRules(goal, pts, '2025-01-03');
  assert.ok(!rules.map(r => r.rule).includes('4_below_aim'),
    '3 points is not enough — rule must not fire');
});

test('evaluateRules: 4_below_aim FIRES with exactly 4 consecutive points below aim', () => {
  const goal = makeGoal();
  const pts = [
    pt('2025-01-01', 0.1),
    pt('2025-01-02', 0.1),
    pt('2025-01-03', 0.1),
    pt('2025-01-04', 0.1),
  ];
  const rules = evaluateRules(goal, pts, '2025-01-04');
  assert.ok(rules.map(r => r.rule).includes('4_below_aim'),
    'Exactly 4 below-aim points must fire the rule');
});

test('evaluateRules: 4_below_aim does NOT fire when 4th-most-recent is above aim', () => {
  const goal = makeGoal();
  const pts = [
    pt('2025-01-01', 0.1), // below
    pt('2025-01-02', 0.1), // below
    pt('2025-01-03', 0.9), // ABOVE aim
    pt('2025-01-04', 0.1), // below
    pt('2025-01-05', 0.1), // below
  ];
  // Most recent 4: 01-02, 01-03, 01-04, 01-05 → 01-03 is above → no fire
  const rules = evaluateRules(goal, pts, '2025-01-05');
  assert.ok(!rules.map(r => r.rule).includes('4_below_aim'));
});

test('evaluateRules: 4_below_aim fires when 5th point (not among recent 4) is above aim', () => {
  const goal = makeGoal();
  const pts = [
    pt('2025-01-01', 0.9), // ABOVE aim — oldest, not in recent 4
    pt('2025-01-02', 0.1), // below
    pt('2025-01-03', 0.1), // below
    pt('2025-01-04', 0.1), // below
    pt('2025-01-05', 0.1), // below
  ];
  // Most recent 4: 01-02, 01-03, 01-04, 01-05 → all below → fires
  const rules = evaluateRules(goal, pts, '2025-01-05');
  assert.ok(rules.map(r => r.rule).includes('4_below_aim'),
    '5 points, only most-recent 4 matter — oldest above-aim does not block firing');
});

// ── evaluateRules: direction-awareness for prompts_to_complete ──

test('evaluateRules: prompts_to_complete — 4 NUMERICALLY ABOVE aim fires 4_below_aim', () => {
  /**
   * For lower-better measures, "below aim" means numerically ABOVE the aim line.
   * baseline=5 (many prompts), target=1 (few prompts) → aim goes DOWN.
   * Student needing 6 prompts when aim is 5 → performing BELOW aim.
   */
  const goal = makeGoal({
    measure: 'prompts_to_complete',
    baseline_value: 5, target_value: 1,
  });
  const pts = [
    pt('2025-01-01', 6), // aim=5, 6>5 → below aim (bad)
    pt('2025-01-02', 6),
    pt('2025-01-03', 6),
    pt('2025-01-04', 6),
  ];
  const rules = evaluateRules(goal, pts, '2025-01-04');
  assert.ok(rules.map(r => r.rule).includes('4_below_aim'),
    'Numerically-above points on a downward-aim measure must count as 4_below_aim');
});

test('evaluateRules: prompts_to_complete — 4 NUMERICALLY BELOW aim fires 4_above_aim', () => {
  /**
   * Student using fewer prompts than the aim requires → ABOVE aim (exceeding goal).
   */
  const goal = makeGoal({
    measure: 'prompts_to_complete',
    baseline_value: 5, target_value: 1,
  });
  const pts = [
    pt('2025-01-01', 2), // aim=5, 2<5 → above aim (great!)
    pt('2025-01-02', 2),
    pt('2025-01-03', 2),
    pt('2025-01-04', 2),
  ];
  const rules = evaluateRules(goal, pts, '2025-01-04');
  assert.ok(rules.map(r => r.rule).includes('4_above_aim'),
    'Numerically-below points on a downward-aim measure must count as 4_above_aim');
});

test('evaluateRules: prompts_to_complete — 3-vs-4 boundary: only 3 numerically-above → no fire', () => {
  const goal = makeGoal({
    measure: 'prompts_to_complete',
    baseline_value: 5, target_value: 1,
  });
  const pts = [
    pt('2025-01-01', 6),
    pt('2025-01-02', 6),
    pt('2025-01-03', 6),
  ];
  const rules = evaluateRules(goal, pts, '2025-01-03');
  assert.ok(!rules.map(r => r.rule).includes('4_below_aim'));
});

// ── evaluateRules: trend_divergence ──

test('evaluateRules: trend_divergence fires — ≥6 points heading wrong direction', () => {
  /**
   * Higher-better goal: aim goes UP.
   * Data trend goes DOWN → wrong direction + > 25% divergence → fire.
   */
  const goal = makeGoal({
    baseline_value: 0.2, target_value: 0.8,
    baseline_date: '2025-01-01', target_date: '2025-07-01',
  });
  const pts = [
    pt('2025-01-01', 0.8),
    pt('2025-01-08', 0.7),
    pt('2025-01-15', 0.6),
    pt('2025-01-22', 0.5),
    pt('2025-01-29', 0.4),
    pt('2025-02-05', 0.3),
  ];
  const rules = evaluateRules(goal, pts, '2025-02-05');
  assert.ok(rules.map(r => r.rule).includes('trend_divergence'),
    'trend heading opposite to aim with ≥6 points must fire');
});

test('evaluateRules: trend_divergence does NOT fire with fewer than 6 points', () => {
  const goal = makeGoal({
    baseline_value: 0.2, target_value: 0.8,
    baseline_date: '2025-01-01', target_date: '2025-07-01',
  });
  const pts = [
    pt('2025-01-01', 0.8),
    pt('2025-01-08', 0.7),
    pt('2025-01-15', 0.6),
    pt('2025-01-22', 0.5),
    pt('2025-01-29', 0.4),
  ]; // only 5 points
  const rules = evaluateRules(goal, pts, '2025-01-29');
  assert.ok(!rules.map(r => r.rule).includes('trend_divergence'));
});

test('evaluateRules: trend_divergence skips when aim slope is 0', () => {
  const goal = makeGoal({
    baseline_value: 0.5, target_value: 0.5, // flat aim → slope 0
  });
  const pts = [
    pt('2025-01-01', 0.8),
    pt('2025-01-08', 0.7),
    pt('2025-01-15', 0.6),
    pt('2025-01-22', 0.5),
    pt('2025-01-29', 0.4),
    pt('2025-02-05', 0.3),
  ];
  const rules = evaluateRules(goal, pts, '2025-02-05');
  assert.ok(!rules.map(r => r.rule).includes('trend_divergence'),
    'Zero aim slope → rule is skipped');
});

test('evaluateRules: trend_divergence does NOT fire when trend goes same direction as aim', () => {
  /**
   * Trend goes UP, aim goes UP (same direction) → not wrong direction.
   * Even if divergence > 25%, the direction check prevents firing.
   */
  const goal = makeGoal({
    baseline_value: 0.2, target_value: 0.8,
    baseline_date: '2025-01-01', target_date: '2025-07-01',
  });
  // Trend going UP steeply (much faster than aim, but same direction)
  const pts = [
    pt('2025-01-01', 0.0),
    pt('2025-01-08', 0.3),
    pt('2025-01-15', 0.5),
    pt('2025-01-22', 0.7),
    pt('2025-01-29', 0.85),
    pt('2025-02-05', 0.95),
  ];
  const rules = evaluateRules(goal, pts, '2025-02-05');
  assert.ok(!rules.map(r => r.rule).includes('trend_divergence'),
    'Trend going same direction as aim (even steeply) must NOT fire');
});

test('evaluateRules: trend_divergence direction-aware for prompts_to_complete', () => {
  /**
   * Lower-better: aim goes DOWN.
   * Trend going UP → wrong direction → fires.
   */
  const goal = makeGoal({
    measure: 'prompts_to_complete',
    baseline_value: 5, target_value: 1,
    baseline_date: '2025-01-01', target_date: '2025-07-01',
  });
  const pts = [
    pt('2025-01-01', 2),  // starts low (good)
    pt('2025-01-08', 2.5),
    pt('2025-01-15', 3),
    pt('2025-01-22', 3.5),
    pt('2025-01-29', 4),
    pt('2025-02-05', 4.5), // trend going UP while aim needs DOWN → divergence
  ];
  const rules = evaluateRules(goal, pts, '2025-02-05');
  assert.ok(rules.map(r => r.rule).includes('trend_divergence'),
    'Upward trend when aim needs downward → trend_divergence for prompts_to_complete');
});

// ── evaluateRules: insufficient_data ──

test('evaluateRules: insufficient_data does NOT fire when goal is < 14 days old', () => {
  const goal = makeGoal({ baseline_date: '2025-01-01', target_date: '2025-06-01' });
  const pts = [pt('2025-01-01', 0.2)]; // only 1 point, but goal is only 9 days old
  const rules = evaluateRules(goal, pts, '2025-01-10');
  assert.ok(!rules.map(r => r.rule).includes('insufficient_data'),
    'Goal too young — must not fire');
});

test('evaluateRules: insufficient_data fires when 2 points in 14-day window (< 3 threshold)', () => {
  const goal = makeGoal({ baseline_date: '2025-01-01', target_date: '2025-06-01' });
  const pts = [
    pt('2025-01-10', 0.3),
    pt('2025-01-15', 0.4),
    // only 2 points in the window — threshold is 3
  ];
  const rules = evaluateRules(goal, pts, '2025-01-20');
  assert.ok(rules.map(r => r.rule).includes('insufficient_data'),
    '2 points < 3 threshold → fire');
});

test('evaluateRules: insufficient_data does NOT fire with exactly 3 points in window', () => {
  const goal = makeGoal({ baseline_date: '2025-01-01', target_date: '2025-06-01' });
  const pts = [
    pt('2025-01-08', 0.3),
    pt('2025-01-12', 0.4),
    pt('2025-01-16', 0.5),
  ];
  const rules = evaluateRules(goal, pts, '2025-01-20');
  assert.ok(!rules.map(r => r.rule).includes('insufficient_data'),
    '3 points meets threshold — must not fire');
});

test('evaluateRules: insufficient_data uses 14-day window — older points do not count', () => {
  const goal = makeGoal({ baseline_date: '2025-01-01', target_date: '2025-06-01' });
  const today = '2025-02-01';
  const pts = [
    // 3 points more than 14 days ago (before window)
    pt('2025-01-01', 0.2),
    pt('2025-01-05', 0.25),
    pt('2025-01-10', 0.3),
    // 1 point in window (today-14 = 2025-01-18)
    pt('2025-01-25', 0.35),
  ];
  const rules = evaluateRules(goal, pts, today);
  // Only 1 point in the 14-day window (Jan 18 – Feb 1) → fires
  assert.ok(rules.map(r => r.rule).includes('insufficient_data'),
    'Points outside 14-day window do not count toward threshold');
});

test('evaluateRules: insufficient_data exactly at 14-day boundary fires (day 14 = goal age ≥ 14)', () => {
  const goal = makeGoal({ baseline_date: '2025-01-01', target_date: '2025-06-01' });
  const pts = []; // no points in window
  // today is exactly 14 days after baseline
  const rules = evaluateRules(goal, pts, '2025-01-15');
  assert.ok(rules.map(r => r.rule).includes('insufficient_data'),
    'Goal exactly 14 days old with 0 points → fire');
});

// ── evaluateRules: multiple rules can fire simultaneously ──

test('evaluateRules: returns empty array when no rules fire', () => {
  const goal = makeGoal({ baseline_date: '2025-01-01', target_date: '2025-06-01' });
  // One point, above aim, goal only 5 days old → no rules fire
  const pts = [pt('2025-01-03', 0.5)];
  const rules = evaluateRules(goal, pts, '2025-01-06');
  assert.deepEqual(rules, []);
});

test('evaluateRules: detail object contains the triggering point data', () => {
  const goal = makeGoal();
  const pts = [
    pt('2025-01-01', 0.1),
    pt('2025-01-02', 0.1),
    pt('2025-01-03', 0.1),
    pt('2025-01-04', 0.1),
  ];
  const rules = evaluateRules(goal, pts, '2025-01-04');
  const rule = rules.find(r => r.rule === '4_below_aim');
  assert.ok(rule, 'rule must fire');
  assert.ok(Array.isArray(rule.detail.points), 'detail.points must be an array');
  assert.equal(rule.detail.points.length, 4, 'must include all 4 triggering points');
});
