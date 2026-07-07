import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getCommands, getCommandStats, getSessions, getLogEvents, getLatestHealthChecks, getHealthAlerts, getStudents, upsertStudent, updateStudent } from '../db.js';
import { parseRosterCsv } from '../identity.js';

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

  // ── Students ──

  router.get('/students/active', (req, res) => {
    const active = wsProxy._activeSession || null;
    if (!active) return res.json({ student: null, sessionId: null });
    const students = getStudents({ activeOnly: false });
    const student = students.find(s => s.id === active.studentId) || null;
    res.json({ student, sessionId: active.sessionId });
  });

  router.get('/students', (req, res) => {
    const activeOnly = req.query.all !== '1';
    const students = getStudents({ activeOnly });
    res.json(students);
  });

  router.post('/students', (req, res) => {
    const { display_name, external_ref } = req.body || {};
    if (!display_name || !String(display_name).trim()) {
      return res.status(400).json({ error: 'display_name is required' });
    }
    const id = uuidv4();
    upsertStudent({ id, display_name: String(display_name).trim(), external_ref: external_ref ? String(external_ref).trim() : null });
    const students = getStudents({ activeOnly: false });
    const created = students.find(s => s.id === id);
    res.status(201).json(created);
  });

  router.patch('/students/:id', (req, res) => {
    const { id } = req.params;
    const { display_name, external_ref, active } = req.body || {};
    const students = getStudents({ activeOnly: false });
    const existing = students.find(s => s.id === id);
    if (!existing) return res.status(404).json({ error: 'Student not found' });
    updateStudent({ id, display_name, external_ref, active });
    const updated = getStudents({ activeOnly: false }).find(s => s.id === id);
    res.json(updated);
  });

  router.post('/students/roster-csv', (req, res) => {
    let csv = '';
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('text/plain')) {
      csv = req.body || '';
    } else {
      csv = req.body?.csv || '';
    }
    const { students, errors } = parseRosterCsv(csv);
    let imported = 0;
    for (const s of students) {
      try {
        upsertStudent({ id: uuidv4(), display_name: s.display_name, external_ref: s.external_ref });
        imported++;
      } catch (err) {
        errors.push({ line: null, reason: err.message });
      }
    }
    res.json({ imported, errors });
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
