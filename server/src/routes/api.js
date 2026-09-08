import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
  getCommands, getCommandStats, getSessions, getLogEvents, getLatestHealthChecks, getHealthAlerts,
  getTeacherAnalytics, getStudents, addStudent, deleteStudent,
  insertGoal, getGoals, updateGoalStatus, upsertProgressPoint, getProgressPoints,
  insertPhaseChange, getPhaseChanges, insertDecisionFlag, getDecisionFlags, acknowledgeFlag,
  getCommandsForStudentDate,
} from '../db.js';
import { computeProbeValue, computeProbesForDate, evaluateAndFlag } from '../probe-computer.js';
import { MEASURE_REGISTRY } from '../progress-rules.js';

export function createApiRouter({ wsProxy, logTailer, libraryScanner, voqalHomePath }) {
  const router = Router();

  // ── Health ──
  router.get('/health', (req, res) => {
    const checks = getLatestHealthChecks();
    const alerts = getHealthAlerts();
    const status = wsProxy.getStatus();
    res.json({
      ok: status.voqalConnected && status.extensionClients > 0 && alerts.length === 0,
      voqalConnected: status.voqalConnected,
      extensionClients: status.extensionClients,
      alerts: alerts.length,
      checks,
      alertDetails: alerts
    });
  });

  // ── Status ──
  router.get('/status', (req, res) => {
    const status = wsProxy.getStatus();
    res.json(status);
  });

  // ── Commands ──
  router.get('/commands', (req, res) => {
    const { limit = 50, offset = 0, type, direction } = req.query;
    const commands = getCommands({ limit: parseInt(limit), offset: parseInt(offset), type, direction });
    res.json(commands);
  });

  router.get('/commands/stats', (req, res) => {
    const stats = getCommandStats();
    res.json(stats);
  });

  // ── Sessions ──
  router.get('/sessions', (req, res) => {
    const { limit = 20 } = req.query;
    const sessions = getSessions({ limit: parseInt(limit) });
    res.json(sessions);
  });

  // ── Library ──
  router.get('/library', (req, res) => {
    const library = libraryScanner.scan();
    res.json(library);
  });

  router.get('/library/:category/:tool', (req, res) => {
    const { category, tool } = req.params;
    const detail = libraryScanner.getToolDetail(category, tool);
    if (!detail) return res.status(404).json({ error: 'Tool not found' });
    res.json(detail);
  });

  // ── Context ──
  router.get('/context', (req, res) => {
    const ctx = wsProxy.getLastContext();
    res.json(ctx || { message: 'No context updates received yet' });
  });

  // ── Logs ──
  router.get('/logs', (req, res) => {
    const { limit = 100, offset = 0, level, search } = req.query;
    const logs = getLogEvents({ limit: parseInt(limit), offset: parseInt(offset), level, search });
    res.json(logs);
  });

  router.get('/logs/recent', (req, res) => {
    const { limit = 100, level } = req.query;
    const events = logTailer.getRecentEvents(parseInt(limit), level || null);
    res.json(events);
  });

  router.get('/logs/health', (req, res) => {
    const alerts = getHealthAlerts();
    res.json(alerts);
  });

  // ── Config (read-only, sanitized) ──
  router.get('/config', (req, res) => {
    const configPath = `${voqalHomePath}/config.json`;
    if (!existsSync(configPath)) return res.status(404).json({ error: 'Config not found' });
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      // Redact all keys/tokens
      const sanitized = sanitizeConfig(config);
      res.json(sanitized);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read config' });
    }
  });

  // ── Manual Command ──
  router.post('/command', (req, res) => {
    const { target = 'extension', data } = req.body;
    if (!data) return res.status(400).json({ error: 'Missing data' });
    let result;
    if (target === 'voqal') result = wsProxy.sendCommandToVoqal(data);
    else result = wsProxy.sendCommandToExtension(data);
    res.json({ sent: !!result, target });
  });

  // ── Teacher Dashboard ──
  router.get('/teacher/analytics', (req, res) => {
    const analytics = getTeacherAnalytics();
    res.json(analytics);
  });

  router.get('/teacher/students', (req, res) => {
    const students = getStudents();
    res.json(students);
  });

  router.post('/teacher/students', (req, res) => {
    const { name, session_prefix } = req.body;
    if (!name) return res.status(400).json({ error: 'Student name is required' });
    const student = addStudent({ name, session_prefix });
    res.status(201).json(student);
  });

  router.delete('/teacher/students/:id', (req, res) => {
    deleteStudent(req.params.id);
    res.json({ deleted: true });
  });

  // ════════════════════════════════════════════════
  // ── Progress Monitoring REST Endpoints (Tier 2 KPI engine) ──
  // Recovered from origin/eric (681a72e, fixed by 81ae187), adapted to this
  // file's existing INTEGER students.id instead of eric's TEXT student ids.
  // ════════════════════════════════════════════════

  function findStudent(idParam) {
    const id = Number(idParam);
    if (!Number.isInteger(id)) return null;
    return getStudents().find(s => s.id === id) || null;
  }

  // GET /api/students/:id/baseline-suggestion?measure=X
  // Returns { value, sampleDays, sampleSize } computed from last 14 days of commands.
  router.get('/students/:id/baseline-suggestion', (req, res) => {
    const student = findStudent(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const { measure } = req.query;
    if (!measure || !(measure in MEASURE_REGISTRY)) {
      return res.status(400).json({ error: `measure must be one of: ${Object.keys(MEASURE_REGISTRY).join(', ')}` });
    }

    // Single-pass: query each qualifying day (>= 3 attempted) exactly once.
    const today = new Date().toISOString().slice(0, 10);
    const cutoffMs = new Date(today).getTime() - 14 * 86400000;
    const qualifyingDays = new Map(); // isoDate → dayCmds[]

    for (let d = 0; d <= 14; d++) {
      const dateMs = cutoffMs + d * 86400000;
      const isoDate = new Date(dateMs).toISOString().slice(0, 10);
      if (isoDate > today) break;
      const dayCmds = getCommandsForStudentDate(student.id, isoDate);
      const dayAttempted = dayCmds.filter(c => c.outcome != null);
      if (dayAttempted.length >= 3) qualifyingDays.set(isoDate, dayCmds);
    }

    if (qualifyingDays.size === 0) {
      return res.json({ value: null, sampleDays: 0, sampleSize: 0 });
    }

    let totalValue = 0, validDays = 0, totalSample = 0;
    for (const [, dayCmds] of qualifyingDays) {
      const result = computeProbeValue(measure, dayCmds);
      if (result !== null) {
        totalValue += result.value;
        validDays++;
        totalSample += result.sampleSize;
      }
    }

    if (validDays === 0) return res.json({ value: null, sampleDays: 0, sampleSize: totalSample });
    res.json({ value: totalValue / validDays, sampleDays: validDays, sampleSize: totalSample });
  });

  // POST /api/students/:id/goals
  // Body: { measure, baseline_value, baseline_date, target_value, target_date, decision_rule? }
  router.post('/students/:id/goals', (req, res) => {
    const student = findStudent(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const { measure, baseline_value, baseline_date, target_value, target_date, decision_rule } = req.body || {};
    const errors = [];
    if (!measure || !(measure in MEASURE_REGISTRY)) errors.push(`measure must be one of: ${Object.keys(MEASURE_REGISTRY).join(', ')}`);
    if (typeof baseline_value !== 'number' || isNaN(baseline_value)) errors.push('baseline_value must be a number');
    if (typeof target_value !== 'number' || isNaN(target_value)) errors.push('target_value must be a number');
    if (!baseline_date || !/^\d{4}-\d{2}-\d{2}$/.test(baseline_date)) errors.push('baseline_date must be YYYY-MM-DD');
    if (!target_date || !/^\d{4}-\d{2}-\d{2}$/.test(target_date)) errors.push('target_date must be YYYY-MM-DD');
    if (baseline_date && target_date && target_date <= baseline_date) errors.push('target_date must be after baseline_date');
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    // Auto-revise any prior active goal for this (student, measure)
    const existingActive = getGoals({ studentId: student.id, status: 'active' }).filter(g => g.measure === measure);
    for (const eg of existingActive) updateGoalStatus(eg.id, 'revised');

    const goalId = uuidv4();
    insertGoal({
      id: goalId, student_id: student.id, measure, baseline_value, baseline_date,
      target_value, target_date, decision_rule: decision_rule || '4_below_aim',
    });

    const goals = getGoals({ studentId: student.id });
    res.status(201).json(goals.find(g => g.id === goalId));
  });

  // GET /api/students/:id/goals?status=active|all
  router.get('/students/:id/goals', (req, res) => {
    const student = findStudent(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const statusFilter = req.query.status === 'all' ? null : (req.query.status || 'active');
    res.json(getGoals({ studentId: student.id, status: statusFilter }));
  });

  // PATCH /api/goals/:id — status transitions only: active→met|revised|discontinued
  router.patch('/goals/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    const allowed = ['met', 'revised', 'discontinued'];
    if (!status || !allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    const goal = getGoals().find(g => g.id === id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    updateGoalStatus(id, status);
    res.json(getGoals().find(g => g.id === id));
  });

  // GET /api/goals/:id/points
  router.get('/goals/:id/points', (req, res) => {
    const { id } = req.params;
    if (!getGoals().find(g => g.id === id)) return res.status(404).json({ error: 'Goal not found' });
    res.json(getProgressPoints(id));
  });

  // POST /api/goals/:id/points — manual probe. Body: { measured_at, value }
  router.post('/goals/:id/points', (req, res) => {
    const { id } = req.params;
    const goal = getGoals().find(g => g.id === id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const { measured_at, value } = req.body || {};
    if (!measured_at || !/^\d{4}-\d{2}-\d{2}$/.test(measured_at)) return res.status(400).json({ error: 'measured_at must be YYYY-MM-DD' });
    if (typeof value !== 'number' || isNaN(value)) return res.status(400).json({ error: 'value must be a number' });
    upsertProgressPoint({ id: uuidv4(), goal_id: id, student_id: goal.student_id, measured_at, value, source: 'manual', sample_size: null });
    res.status(201).json(getProgressPoints(id).find(p => p.measured_at === measured_at));
  });

  // POST /api/goals/:id/phases — add phase change. Body: { changed_at, label, note? }
  router.post('/goals/:id/phases', (req, res) => {
    const { id } = req.params;
    if (!getGoals().find(g => g.id === id)) return res.status(404).json({ error: 'Goal not found' });
    const { changed_at, label, note } = req.body || {};
    if (!changed_at || !/^\d{4}-\d{2}-\d{2}$/.test(changed_at)) return res.status(400).json({ error: 'changed_at must be YYYY-MM-DD' });
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label is required' });
    const phaseId = uuidv4();
    insertPhaseChange({ id: phaseId, goal_id: id, changed_at, label: String(label).trim(), note: note ? String(note).trim() : null });
    res.status(201).json(getPhaseChanges(id).find(p => p.id === phaseId));
  });

  // GET /api/goals/:id/phases
  router.get('/goals/:id/phases', (req, res) => {
    const { id } = req.params;
    if (!getGoals().find(g => g.id === id)) return res.status(404).json({ error: 'Goal not found' });
    res.json(getPhaseChanges(id));
  });

  // GET /api/goals/:id/flags?unacknowledged=1
  router.get('/goals/:id/flags', (req, res) => {
    const { id } = req.params;
    if (!getGoals().find(g => g.id === id)) return res.status(404).json({ error: 'Goal not found' });
    res.json(getDecisionFlags({ goalId: id, unacknowledgedOnly: req.query.unacknowledged === '1' }));
  });

  // POST /api/flags/:id/ack — acknowledge a decision flag
  router.post('/flags/:id/ack', (req, res) => {
    acknowledgeFlag(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/progress/recompute — trigger probe computation for today
  router.post('/progress/recompute', async (req, res) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      await computeProbesForDate(today);
      const activeGoals = getGoals({ status: 'active' });
      for (const g of activeGoals) await evaluateAndFlag(g.id, today);
      res.json({ ok: true, date: today, goals: activeGoals.length });
    } catch (err) {
      console.error('[Recompute] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function sanitizeConfig(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeConfig);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (/key|token|secret|password|credential/i.test(key) && typeof value === 'string') {
      result[key] = value.slice(0, 8) + '••••••••';
    } else if (typeof value === 'object') {
      result[key] = sanitizeConfig(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
