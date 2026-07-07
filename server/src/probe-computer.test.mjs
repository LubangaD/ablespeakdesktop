/**
 * TDD tests for probe-computer.js (and new db.js CRUD functions).
 * Covers:
 *   - computeProbeValue: all three measures + edge cases
 *   - T4 sync-invisibility trap: insertGoal must set updated_at
 *   - getRowsSince('goals') returns freshly inserted goal
 *   - auto-revision rule (db/API seam): second active goal for same measure
 *   - upsertProgressPoint: manual wins over auto, auto won't overwrite manual
 *   - computeProbesForDate: end-to-end with DB
 *   - evaluateAndFlag: inserts flag, deduplicates unacknowledged
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import {
  initDatabase, closeDatabase, getDb,
  upsertStudent,
  insertGoal, getGoals, updateGoalStatus,
  upsertProgressPoint, getProgressPoints,
  insertPhaseChange, getPhaseChanges,
  insertDecisionFlag, getDecisionFlags, acknowledgeFlag,
  getCommandsForStudentDate,
  getRowsSince,
} from './db.js';
import {
  computeProbeValue,
  computeProbesForDate,
  evaluateAndFlag,
  shouldRunProbeScheduler,
} from './probe-computer.js';

function tmpFile(name) {
  return join(tmpdir(), `ablespeak-probe-test-${name}-${Date.now()}.db`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
    try { if (existsSync(p + '.tmp')) unlinkSync(p + '.tmp'); } catch {}
  }
}

// ── shouldRunProbeScheduler (pure) ──

test('shouldRunProbeScheduler: false for receiver role', () => {
  assert.equal(shouldRunProbeScheduler({ sync: { role: 'receiver' } }), false,
    'receiver must not run scheduler — flags arrive via sync ingest');
});

test('shouldRunProbeScheduler: true for sender role', () => {
  assert.equal(shouldRunProbeScheduler({ sync: { role: 'sender' } }), true);
});

test('shouldRunProbeScheduler: true when sync not configured (default)', () => {
  assert.equal(shouldRunProbeScheduler({}), true, 'default (no sync key): should run');
  assert.equal(shouldRunProbeScheduler({ sync: {} }), true, 'empty sync block: should run');
  assert.equal(shouldRunProbeScheduler(undefined), true, 'undefined settings: should run');
  assert.equal(shouldRunProbeScheduler(null), true, 'null settings: should run');
});

// ── computeProbeValue (pure, no DB) ──

test('computeProbeValue: null for unknown measure', () => {
  assert.equal(computeProbeValue('bogus_measure', []), null);
});

test('computeProbeValue: null when fewer than 3 attempted commands', () => {
  const rows = [
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'failed', prompt_count: 1 },
  ];
  assert.equal(computeProbeValue('independence_rate', rows), null);
});

test('computeProbeValue: null when all outcomes are null (no attempted)', () => {
  const rows = [
    { outcome: null, prompt_count: null },
    { outcome: null, prompt_count: null },
    { outcome: null, prompt_count: null },
    { outcome: null, prompt_count: null },
  ];
  assert.equal(computeProbeValue('task_completion', rows), null);
});

test('computeProbeValue: independence_rate — correct fraction', () => {
  // 2 independent successes, 1 prompted success, 1 failed, 1 abandoned = 5 attempted
  const rows = [
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'success', prompt_count: 2 },
    { outcome: 'failed', prompt_count: 1 },
    { outcome: 'abandoned', prompt_count: 0 },
  ];
  const result = computeProbeValue('independence_rate', rows);
  assert.ok(result !== null);
  assert.equal(result.value, 2 / 5);
  assert.equal(result.sampleSize, 5);
});

test('computeProbeValue: independence_rate — 0% when all prompted or failed', () => {
  const rows = [
    { outcome: 'success', prompt_count: 1 }, // prompted → not independent
    { outcome: 'failed', prompt_count: 2 },
    { outcome: 'abandoned', prompt_count: 0 },
  ];
  const result = computeProbeValue('independence_rate', rows);
  assert.ok(result !== null);
  assert.equal(result.value, 0);
  assert.equal(result.sampleSize, 3);
});

test('computeProbeValue: task_completion — correct fraction', () => {
  // 3 completed (success or repaired), 2 not = 5 attempted
  const rows = [
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'repaired', prompt_count: 1 },
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'failed', prompt_count: 3 },
    { outcome: 'abandoned', prompt_count: 0 },
  ];
  const result = computeProbeValue('task_completion', rows);
  assert.ok(result !== null);
  assert.equal(result.value, 3 / 5);
  assert.equal(result.sampleSize, 5);
});

test('computeProbeValue: prompts_to_complete — correct average', () => {
  // 3 completed with 0, 2, 4 prompts → avg = 2
  const rows = [
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'repaired', prompt_count: 2 },
    { outcome: 'success', prompt_count: 4 },
    { outcome: 'failed', prompt_count: 3 }, // excluded from avg
  ];
  const result = computeProbeValue('prompts_to_complete', rows);
  assert.ok(result !== null);
  assert.equal(result.value, 2); // (0+2+4)/3
  assert.equal(result.sampleSize, 3);
});

test('computeProbeValue: prompts_to_complete — null when no completed rows', () => {
  // 3+ attempted but none completed
  const rows = [
    { outcome: 'failed', prompt_count: 2 },
    { outcome: 'abandoned', prompt_count: 1 },
    { outcome: 'failed', prompt_count: 3 },
  ];
  assert.equal(computeProbeValue('prompts_to_complete', rows), null);
});

test('computeProbeValue: ignores rows with null outcome (non-voice rows)', () => {
  // Mix of voice rows (outcome set) and non-voice (outcome null)
  const rows = [
    { outcome: 'success', prompt_count: 0 },
    { outcome: null, prompt_count: null }, // non-voice, not counted
    { outcome: 'success', prompt_count: 0 },
    { outcome: 'failed', prompt_count: 1 },
    { outcome: null, prompt_count: null },
  ];
  const result = computeProbeValue('independence_rate', rows);
  // Only 3 attempted (non-null outcome)
  assert.ok(result !== null);
  assert.equal(result.sampleSize, 3);
  assert.ok(Math.abs(result.value - 2 / 3) < 1e-9);
});

// ── T4 trap: insertGoal must set updated_at for sync visibility ──

test('T4 trap: insertGoal sets updated_at — goal visible in getRowsSince goals cursor', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('t4-trap');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-t4', display_name: 'T4 Student' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId,
      student_id: 's-t4',
      measure: 'independence_rate',
      baseline_value: 0.2,
      baseline_date: '2025-01-01',
      target_value: 0.8,
      target_date: '2025-06-01',
    });
    const { rows } = getRowsSince('goals', '0');
    assert.equal(rows.length, 1, 'Goal must appear in getRowsSince with cursor "0"');
    assert.ok(rows[0].updated_at, 'updated_at must be non-null (T4 trap)');
    assert.equal(rows[0].id, goalId);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── auto-revision: second active goal for same (student, measure) ──

test('auto-revision: updateGoalStatus sets prior goal to revised, new goal is active', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('auto-revision');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-rev', display_name: 'Revision Student' });

    const g1 = uuidv4();
    insertGoal({
      id: g1, student_id: 's-rev', measure: 'independence_rate',
      baseline_value: 0.2, baseline_date: '2025-01-01',
      target_value: 0.8, target_date: '2025-06-01',
    });

    // API would: find active goal for same measure → set to revised, then insert new
    const existingActive = getGoals({ studentId: 's-rev', status: 'active' })
      .filter(g => g.measure === 'independence_rate');
    for (const eg of existingActive) {
      updateGoalStatus(eg.id, 'revised');
    }

    const g2 = uuidv4();
    insertGoal({
      id: g2, student_id: 's-rev', measure: 'independence_rate',
      baseline_value: 0.3, baseline_date: '2025-04-01',
      target_value: 0.9, target_date: '2025-09-01',
    });

    const allGoals = getGoals({ studentId: 's-rev' });
    const first = allGoals.find(g => g.id === g1);
    const second = allGoals.find(g => g.id === g2);
    assert.equal(first.status, 'revised', 'Prior goal must be revised');
    assert.equal(second.status, 'active', 'New goal must be active');

    // updated_at on revised goal must be visible to sync
    const { rows } = getRowsSince('goals', '0');
    assert.equal(rows.length, 2, 'Both goals visible to sync cursor');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── upsertProgressPoint: manual/auto protection ──

test('upsertProgressPoint: auto point created and readable', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('pp-auto');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-pp', display_name: 'PP Student' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-pp', measure: 'task_completion',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 1.0, target_date: '2025-06-01',
    });
    upsertProgressPoint({
      id: uuidv4(), goal_id: goalId, student_id: 's-pp',
      measured_at: '2025-01-10', value: 0.6, source: 'auto', sample_size: 5,
    });
    const pts = getProgressPoints(goalId);
    assert.equal(pts.length, 1);
    assert.equal(pts[0].value, 0.6);
    assert.equal(pts[0].source, 'auto');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('upsertProgressPoint: auto overwrites auto', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('pp-auto-overwrite');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-ao', display_name: 'Auto Overwrite' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-ao', measure: 'task_completion',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 1.0, target_date: '2025-06-01',
    });
    upsertProgressPoint({
      id: uuidv4(), goal_id: goalId, student_id: 's-ao',
      measured_at: '2025-01-10', value: 0.6, source: 'auto', sample_size: 5,
    });
    // Recompute: auto overwrites auto
    upsertProgressPoint({
      id: uuidv4(), goal_id: goalId, student_id: 's-ao',
      measured_at: '2025-01-10', value: 0.75, source: 'auto', sample_size: 6,
    });
    const pts = getProgressPoints(goalId);
    assert.equal(pts.length, 1, 'Still only one row after auto overwrite');
    assert.equal(pts[0].value, 0.75);
    assert.equal(pts[0].sample_size, 6);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('upsertProgressPoint: manual wins over auto — auto never overwrites manual', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('pp-manual-wins');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-mw', display_name: 'Manual Wins' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-mw', measure: 'task_completion',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 1.0, target_date: '2025-06-01',
    });

    // Insert auto point
    upsertProgressPoint({
      id: uuidv4(), goal_id: goalId, student_id: 's-mw',
      measured_at: '2025-01-10', value: 0.6, source: 'auto', sample_size: 5,
    });

    // Teacher inserts manual override
    upsertProgressPoint({
      id: uuidv4(), goal_id: goalId, student_id: 's-mw',
      measured_at: '2025-01-10', value: 0.85, source: 'manual', sample_size: 4,
    });

    let pts = getProgressPoints(goalId);
    assert.equal(pts.length, 1);
    assert.equal(pts[0].source, 'manual');
    assert.equal(pts[0].value, 0.85);

    // Now auto recompute MUST NOT overwrite the manual point
    upsertProgressPoint({
      id: uuidv4(), goal_id: goalId, student_id: 's-mw',
      measured_at: '2025-01-10', value: 0.55, source: 'auto', sample_size: 8,
    });

    pts = getProgressPoints(goalId);
    assert.equal(pts.length, 1, 'Still one row');
    assert.equal(pts[0].source, 'manual', 'Manual source preserved');
    assert.equal(pts[0].value, 0.85, 'Manual value preserved — auto cannot overwrite');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── getCommandsForStudentDate ──

test('getCommandsForStudentDate: returns commands for the given student and date', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('cmd-date');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-cd', display_name: 'Cmd Date' });

    // Insert commands directly with explicit created_at to control the date
    const db = getDb();
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('cd-1','voice','user_to_ai','s-cd','success',0,'2025-02-10 09:00:00')`);
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('cd-2','voice','user_to_ai','s-cd','failed',2,'2025-02-10 10:00:00')`);
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('cd-3','voice','user_to_ai','s-cd','success',1,'2025-02-11 09:00:00')`); // different date

    const cmds = getCommandsForStudentDate('s-cd', '2025-02-10');
    assert.equal(cmds.length, 2);
    assert.ok(cmds.some(c => c.id === 'cd-1'));
    assert.ok(cmds.some(c => c.id === 'cd-2'));
    assert.ok(!cmds.some(c => c.id === 'cd-3'), 'Different date must not appear');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── computeProbesForDate: end-to-end ──

test('computeProbesForDate: creates auto progress_point for active goal', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('probes-e2e');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-pe', display_name: 'Probe E2E' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-pe', measure: 'task_completion',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 1.0, target_date: '2025-06-01',
    });

    // Insert 4 commands on 2025-02-15: 3 completed, 1 failed → task_completion = 0.75
    const db = getDb();
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('pe-1','voice','user_to_ai','s-pe','success',0,'2025-02-15 09:00:00')`);
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('pe-2','voice','user_to_ai','s-pe','repaired',2,'2025-02-15 10:00:00')`);
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('pe-3','voice','user_to_ai','s-pe','success',0,'2025-02-15 11:00:00')`);
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('pe-4','voice','user_to_ai','s-pe','failed',3,'2025-02-15 12:00:00')`);

    await computeProbesForDate('2025-02-15');

    const pts = getProgressPoints(goalId);
    assert.equal(pts.length, 1, 'One auto point should be created');
    assert.ok(Math.abs(pts[0].value - 0.75) < 1e-9, `Expected 0.75, got ${pts[0].value}`);
    assert.equal(pts[0].source, 'auto');
    assert.equal(pts[0].measured_at, '2025-02-15');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('computeProbesForDate: skips dates with fewer than 3 attempted commands', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('probes-skip');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-ps', display_name: 'Skip Student' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-ps', measure: 'task_completion',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 1.0, target_date: '2025-06-01',
    });

    // Only 2 commands — below minimum sample
    const db = getDb();
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('ps-1','voice','user_to_ai','s-ps','success',0,'2025-02-15 09:00:00')`);
    db.run(`INSERT INTO commands (id,type,direction,student_id,outcome,prompt_count,created_at) VALUES ('ps-2','voice','user_to_ai','s-ps','failed',1,'2025-02-15 10:00:00')`);

    await computeProbesForDate('2025-02-15');

    const pts = getProgressPoints(goalId);
    assert.equal(pts.length, 0, 'No point should be created for < 3 attempted');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── evaluateAndFlag ──

test('evaluateAndFlag: inserts a decision_flag when rule fires', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('eval-flag');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-ef', display_name: 'Eval Flag' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-ef', measure: 'independence_rate',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 0.9, target_date: '2025-06-01',
    });

    // Insert 4 below-aim points (aim at jan 01 = 0.5; values 0.1)
    const dates = ['2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05'];
    for (const d of dates) {
      upsertProgressPoint({
        id: uuidv4(), goal_id: goalId, student_id: 's-ef',
        measured_at: d, value: 0.1, source: 'auto', sample_size: 5,
      });
    }

    await evaluateAndFlag(goalId, '2025-01-05');

    const flags = getDecisionFlags({ goalId });
    assert.ok(flags.length > 0, 'At least one flag should be created');
    assert.ok(flags.some(f => f.rule === '4_below_aim'), '4_below_aim flag expected');
    assert.equal(flags[0].acknowledged_at, null, 'Flag starts unacknowledged');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('evaluateAndFlag: does NOT create duplicate unacknowledged flags for the same rule', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('eval-dedup');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-dd', display_name: 'Dedup' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-dd', measure: 'independence_rate',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 0.9, target_date: '2025-06-01',
    });

    const dates = ['2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05'];
    for (const d of dates) {
      upsertProgressPoint({
        id: uuidv4(), goal_id: goalId, student_id: 's-dd',
        measured_at: d, value: 0.1, source: 'auto', sample_size: 5,
      });
    }

    // Run twice — should still be only one flag for the same rule
    await evaluateAndFlag(goalId, '2025-01-05');
    await evaluateAndFlag(goalId, '2025-01-05');

    const flags = getDecisionFlags({ goalId, unacknowledgedOnly: true });
    const ruleCount = flags.filter(f => f.rule === '4_below_aim').length;
    assert.equal(ruleCount, 1, 'Only one unacknowledged flag per rule');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('evaluateAndFlag: inserts new flag after prior one is acknowledged', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('eval-refire');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-rf', display_name: 'Refire' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-rf', measure: 'independence_rate',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 0.9, target_date: '2025-06-01',
    });

    const dates = ['2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05'];
    for (const d of dates) {
      upsertProgressPoint({
        id: uuidv4(), goal_id: goalId, student_id: 's-rf',
        measured_at: d, value: 0.1, source: 'auto', sample_size: 5,
      });
    }

    await evaluateAndFlag(goalId, '2025-01-05');

    // Acknowledge existing flag
    const flags1 = getDecisionFlags({ goalId });
    for (const f of flags1) acknowledgeFlag(f.id);

    // Re-evaluate — should create a new flag now that prior is acknowledged
    await evaluateAndFlag(goalId, '2025-01-06');

    const allFlags = getDecisionFlags({ goalId });
    const unacked = getDecisionFlags({ goalId, unacknowledgedOnly: true });
    assert.ok(allFlags.length >= 2, 'A new flag should exist after acknowledge + re-evaluate');
    assert.ok(unacked.some(f => f.rule === '4_below_aim'), 'New unacknowledged flag expected');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── acknowledgeFlag ──

test('acknowledgeFlag: sets acknowledged_at', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('ack-flag');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-ack', display_name: 'Ack' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-ack', measure: 'independence_rate',
      baseline_value: 0.5, baseline_date: '2025-01-01',
      target_value: 0.9, target_date: '2025-06-01',
    });
    const flagId = uuidv4();
    insertDecisionFlag({ id: flagId, goal_id: goalId, rule: '4_below_aim', fired_at: '2025-01-05' });

    let flags = getDecisionFlags({ goalId, unacknowledgedOnly: true });
    assert.equal(flags.length, 1);

    acknowledgeFlag(flagId);

    flags = getDecisionFlags({ goalId, unacknowledgedOnly: true });
    assert.equal(flags.length, 0, 'Acknowledged flag must not appear in unacknowledgedOnly');

    const all = getDecisionFlags({ goalId });
    assert.ok(all[0].acknowledged_at, 'acknowledged_at must be set');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── phase changes ──

test('insertPhaseChange and getPhaseChanges roundtrip', async () => {
  const { v4: uuidv4 } = await import('uuid');
  const path = tmpFile('phase-change');
  try {
    await initDatabase(path);
    upsertStudent({ id: 's-pc', display_name: 'Phase Change' });
    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: 's-pc', measure: 'independence_rate',
      baseline_value: 0.2, baseline_date: '2025-01-01',
      target_value: 0.8, target_date: '2025-06-01',
    });
    insertPhaseChange({ id: uuidv4(), goal_id: goalId, changed_at: '2025-02-01', label: 'Added visual cues', note: 'Switched to icons' });
    insertPhaseChange({ id: uuidv4(), goal_id: goalId, changed_at: '2025-03-01', label: 'Reduced prompts' });

    const phases = getPhaseChanges(goalId);
    assert.equal(phases.length, 2);
    assert.equal(phases[0].label, 'Added visual cues');
    assert.equal(phases[1].label, 'Reduced prompts');
    assert.equal(phases[1].note, null);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});
