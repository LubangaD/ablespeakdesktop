import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { hostname } from 'os';
import { v4 as uuidv4 } from 'uuid';
import {
  getCommands, getCommandStats, getSessions, getLogEvents, getLatestHealthChecks, getHealthAlerts,
  getTeacherAnalytics, getStudents, addStudent, deleteStudent,
  insertGoal, getGoals, updateGoalStatus, upsertProgressPoint, getProgressPoints,
  insertPhaseChange, getPhaseChanges, insertDecisionFlag, getDecisionFlags, acknowledgeFlag,
  getCommandsForStudentDate, getRecognitionStats, getStudentProgress, getFilteredTurns, getResolutionStats,
  getStudentProfileRow, getRetriesAround, renameStudent,
} from '../db.js';
import { computeProbeValue, computeProbesForDate, evaluateAndFlag } from '../probe-computer.js';
import { MEASURE_REGISTRY } from '../progress-rules.js';
import { buildToolCatalog } from '../tool-catalog.js';
import { getActiveStudent, setActiveStudent } from '../student-session.js';
import { localOnly, isFromThisComputer } from './settings.js';
import { localDate, addDays, localDateTime } from '../local-time.js';
import { getProfile, saveProfile, normaliseProfile } from '../student-profile.js';

const AGENT_VERSION = '2.0.0';

export function createApiRouter({ wsProxy, logTailer, libraryScanner, voqalHomePath, aiEngine }) {
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
    // The dashboard's sidebar and top bar name this computer and the gateway;
    // the computer's name is only told to this computer.
    res.json({
      ...status,
      version: AGENT_VERSION,
      port: req.socket.localPort,
      computer: isFromThisComputer(req) ? hostname() : null,
    });
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

  // ── Tools ──
  // What the AI can actually call, read from the live registry and grouped
  // for the dashboard's Tools page.
  router.get('/tools', (req, res) => {
    res.json(buildToolCatalog(aiEngine.toolRegistry.listTools()));
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
  // Students' data never leaves this computer: the server listens on every
  // network interface, so these routes check the request is local.
  router.use(['/teacher', '/students', '/goals', '/flags', '/progress', '/screen', '/agent',
    '/commands', '/sessions', '/logs', '/context', '/config'], localOnly);

  // ── Screen model (Stage 2) ──
  // GET /api/screen — the controls in the window the student is using
  router.get('/screen', async (req, res) => {
    try {
      const { getScreenModel } = await import('../screen-model.js');
      const app = typeof req.query.app === 'string' && req.query.app.trim() ? req.query.app.trim() : undefined;
      const model = await getScreenModel({ app, fresh: req.query.fresh === '1', maxElements: 200 });
      res.status(model.status === 'success' ? 200 : 404).json(model);
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // GET /api/screen/text?app=notepad — the text of the window's document
  router.get('/screen/text', async (req, res) => {
    try {
      const { getScreenModel, actOnElement } = await import('../screen-model.js');
      const app = typeof req.query.app === 'string' && req.query.app.trim() ? req.query.app.trim() : undefined;
      const model = await getScreenModel({ app, fresh: true, maxElements: 400 });
      if (model.status !== 'success') return res.status(404).json(model);
      const doc = model.elements.find(e => ['Document', 'Edit'].includes(e.type) && e.actions.includes('read_text'));
      if (!doc) {
        const field = model.elements.find(e => ['Document', 'Edit'].includes(e.type) && e.value);
        return res.json({ window: model.window, text: field?.value || '' });
      }
      const read = await actOnElement({ app, ref: doc.ref, action: 'read_text', log: false });
      res.json({ window: model.window, text: read.text ?? doc.value ?? '' });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // ── Task agent evaluation (Stage 3) ──
  // POST /api/agent/plan { instruction } — the plan only; nothing happens
  router.post('/agent/plan', async (req, res) => {
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
    if (!instruction) return res.status(400).json({ error: 'instruction is required' });
    try {
      res.json(await wsProxy.planTask(instruction));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/agent/run { instruction, autoConfirm } — runs it on this computer
  router.post('/agent/run', async (req, res) => {
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
    if (!instruction) return res.status(400).json({ error: 'instruction is required' });
    try {
      res.json(await wsProxy.runTaskForEvaluation(instruction, { autoConfirm: req.body?.autoConfirm === true }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/screen/resolution?days=30 — per app: found through the
  // accessibility tree, by screen position, or not at all
  router.get('/screen/resolution', (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const since = `${addDays(localDate(), -(days - 1))} 00:00:00`;
    res.json({ days, since, apps: getResolutionStats({ since }) });
  });

  router.get('/teacher/analytics', (req, res) => {
    const analytics = getTeacherAnalytics();
    res.json(analytics);
  });

  router.get('/teacher/students', (req, res) => {
    const students = getStudents();
    res.json(students);
  });

  router.post('/teacher/students', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Student name is required' });
    if (name.length > 80) return res.status(400).json({ error: 'Keep the name under 80 characters' });
    const student = addStudent({ name, session_prefix: req.body.session_prefix });
    res.status(201).json(student);
  });

  router.delete('/teacher/students/:id', (req, res) => {
    const id = Number(req.params.id);
    if (getActiveStudent().student?.id === id) {
      setActiveStudent(null);
      broadcastActiveStudent();
    }
    deleteStudent(id);
    res.json({ deleted: true });
  });

  // ── Who is using this computer (AT-50) ──
  // The overlay also re-reads how to listen, since that follows the student.
  const broadcastActiveStudent = () => {
    wsProxy.broadcastToDashboard({ type: 'active_student', ...getActiveStudent(), timestamp: new Date().toISOString() });
    wsProxy.broadcastListeningSettings?.();
  };

  router.get('/students/active', (req, res) => {
    res.json(getActiveStudent());
  });

  // Body: { student_id } — a student's id, or null for nobody in particular
  router.put('/students/active', (req, res) => {
    const studentId = req.body?.student_id ?? null;
    if (studentId !== null && !Number.isInteger(studentId)) {
      return res.status(400).json({ error: 'student_id must be a student id or null' });
    }
    try {
      const active = setActiveStudent(studentId);
      broadcastActiveStudent();
      res.json(active);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── Speech profile (Stage 1; portable in Stage 4) ──
  router.get('/students/:id/profile', (req, res) => {
    const student = findStudent(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    res.json(getProfile(student.id));
  });

  // Body: any part of the profile; the rest is kept.
  router.put('/students/:id/profile', (req, res) => {
    const student = findStudent(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    try {
      const profile = saveProfile(student.id, req.body || {});
      if (getActiveStudent().student?.id === student.id) wsProxy.broadcastListeningSettings?.();
      res.json(profile);
    } catch (err) {
      res.status(400).json({ error: err.message, errors: err.errors || [err.message] });
    }
  });

  // A file a teacher can carry to another computer (Stage 4).
  router.get('/students/:id/profile/export', (req, res) => {
    const student = findStudent(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const file = {
      kind: 'ablespeak-student-profile',
      exportedAt: localDateTime(),
      student: { name: student.name },
      profile: getProfile(student.id),
    };
    const safeName = student.name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'student';
    res.setHeader('Content-Disposition', `attachment; filename="ablespeak-${safeName}.json"`);
    res.json(file);
  });

  // Body: an exported file. With ?into=<id> (a person loading their own
  // profile on this computer) it goes into that profile, which takes the
  // file's name: their profile from home, on a school's guest account, still
  // greets them by name. Without it (an admin), it restores into the user
  // with the same name, adding them if this computer does not have them yet.
  router.post('/students/profile/import', (req, res) => {
    const file = req.body || {};
    if (file.kind !== 'ablespeak-student-profile' || !file.profile) {
      return res.status(400).json({ error: 'That is not an AbleSpeak profile file.' });
    }
    const name = typeof file.student?.name === 'string' ? file.student.name.trim() : '';
    if (!name || name.length > 80) return res.status(400).json({ error: 'The file has no usable name.' });
    const { errors } = normaliseProfile(file.profile);
    if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });

    let student;
    let created = false;
    if (req.query.into != null) {
      student = findStudent(req.query.into);
      if (!student) return res.status(404).json({ error: 'User not found' });
      if (student.name !== name) {
        student = renameStudent(student.id, name);
        wsProxy.broadcastToDashboard?.({ type: 'active_student', ...getActiveStudent(), timestamp: new Date().toISOString() });
      }
    } else {
      student = getStudents().find(s => s.name.toLowerCase() === name.toLowerCase());
      created = !student;
      if (!student) student = addStudent({ name });
    }
    const profile = saveProfile(student.id, file.profile);
    if (getActiveStudent().student?.id === student.id) wsProxy.broadcastListeningSettings?.();
    res.status(created ? 201 : 200).json({ student, created, profile });
  });

  // ── How well the student is being heard (Stage 1) ──
  // GET /api/students/:id/recognition?days=7
  // GET /api/students/:id/progress?days=30 — one user's own progress (My progress)
  router.get('/students/:id/progress', (req, res) => {
    const student = findStudent(req.params.id);
    if (!student) return res.status(404).json({ error: 'User not found' });
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const since = `${addDays(localDate(), -(days - 1))} 00:00:00`;
    res.json({ days, ...getStudentProgress(student.id, { since }) });
  });

  router.get('/students/:id/recognition', (req, res) => {
    const student = findStudent(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const since = `${addDays(localDate(), -(days - 1))} 00:00:00`;
    const settingsChanged = getStudentProfileRow(student.id)?.updated_at || null;
    res.json({
      days,
      ...getRecognitionStats(student.id, { since }),
      // The same days as the counts above; `filtered` is how many there were in all.
      recentlyFiltered: getFilteredTurns(student.id, { limit: 10, since }),
      // Did the speech settings help? Retries per task, two weeks either side.
      sinceSettingsChanged: settingsChanged ? getRetriesAround(student.id, { at: settingsChanged }) : null,
    });
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
    const today = localDate();
    const qualifyingDays = new Map(); // isoDate → dayCmds[]

    for (let d = -14; d <= 0; d++) {
      const isoDate = addDays(today, d);
      const dayCmds = getCommandsForStudentDate(student.id, isoDate);
      const dayAttempted = dayCmds.filter(c => c.outcome != null && c.outcome !== 'superseded');
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
      const today = localDate();
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
