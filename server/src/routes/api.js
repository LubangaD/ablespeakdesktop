import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { getCommands, getCommandStats, getSessions, getLogEvents, getLatestHealthChecks, getHealthAlerts } from '../db.js';

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
