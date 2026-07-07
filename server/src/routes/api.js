import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { getCommands, getCommandStats, getSessions, getLogEvents, getLatestHealthChecks, getHealthAlerts, getStudents, upsertStudent, updateStudent, getSpeechProfile, saveSpeechProfile, insertGoal, getGoals, updateGoalStatus, upsertProgressPoint, getProgressPoints, insertPhaseChange, getPhaseChanges, insertDecisionFlag, getDecisionFlags, acknowledgeFlag, getCommandsForStudentDate } from '../db.js';
import { computeProbeValue, computeProbesForDate, evaluateAndFlag } from '../probe-computer.js';
import { MEASURE_REGISTRY } from '../progress-rules.js';
import { parseRosterCsv, normalizeName } from '../identity.js';
import { parseEnvFile, upsertEnvVar } from '../envfile.js';
import { getAppSettings, saveAppSettings } from '../app-settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = join(__dirname, '..', '..', '.env');

// In-process flag: mic tested this server session (step 4 status)
let _micTestedThisSession = false;

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
    const active = wsProxy.getActiveSession();
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
    const { display_name, external_ref, active, sync_opt_in } = req.body || {};
    if (display_name !== undefined && !String(display_name).trim()) return res.status(400).json({ error: 'display_name cannot be blank' });
    const students = getStudents({ activeOnly: false });
    const existing = students.find(s => s.id === id);
    if (!existing) return res.status(404).json({ error: 'Student not found' });
    updateStudent({ id, display_name, external_ref, active, sync_opt_in });
    const updated = getStudents({ activeOnly: false }).find(s => s.id === id);
    res.json(updated);
  });

  // ── Speech Profiles (per-student thresholds + vocabulary) ──

  router.get('/students/:id/speech-profile', (req, res) => {
    const { id } = req.params;
    const students = getStudents({ activeOnly: false });
    if (!students.find(s => s.id === id)) return res.status(404).json({ error: 'Student not found' });
    const profile = getSpeechProfile(id);
    res.json({ ...profile, custom_vocabulary: parseVocabularyField(profile.custom_vocabulary) });
  });

  router.put('/students/:id/speech-profile', (req, res) => {
    const { id } = req.params;
    const students = getStudents({ activeOnly: false });
    if (!students.find(s => s.id === id)) return res.status(404).json({ error: 'Student not found' });

    const body = req.body || {};
    const errors = [];
    const numInRange = (name, min, max) => {
      const v = body[name];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || Number.isNaN(v) || v < min || v > max) {
        errors.push(`${name} must be a number between ${min} and ${max}`);
        return undefined;
      }
      return v;
    };

    const min_audio_b64 = numInRange('min_audio_b64', 500, 20000);
    const min_confidence = numInRange('min_confidence', 0, 1);
    const fuzzy_threshold = numInRange('fuzzy_threshold', 0, 1);
    const silence_threshold = numInRange('silence_threshold', 0, 255);
    const silence_duration_ms = numInRange('silence_duration_ms', 0, 60000);

    let repair_enabled;
    if (body.repair_enabled !== undefined) {
      if (typeof body.repair_enabled === 'boolean' || body.repair_enabled === 0 || body.repair_enabled === 1) {
        repair_enabled = body.repair_enabled ? 1 : 0;
      } else {
        errors.push('repair_enabled must be a boolean or 0/1');
      }
    }

    let custom_vocabulary;
    if (body.custom_vocabulary !== undefined) {
      if (Array.isArray(body.custom_vocabulary) && body.custom_vocabulary.every(v => typeof v === 'string')) {
        custom_vocabulary = JSON.stringify(body.custom_vocabulary.map(v => v.trim()).filter(Boolean));
      } else {
        errors.push('custom_vocabulary must be an array of strings');
      }
    }

    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    const existing = getSpeechProfile(id);
    saveSpeechProfile({
      id: existing.id || uuidv4(),
      student_id: id,
      custom_vocabulary, min_audio_b64, min_confidence, fuzzy_threshold,
      silence_threshold, silence_duration_ms, repair_enabled,
    });
    const updated = getSpeechProfile(id);
    res.json({ ...updated, custom_vocabulary: parseVocabularyField(updated.custom_vocabulary) });
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

    // Fix 4: dedup re-imports by normalized display_name to prevent duplicate rows.
    // Build a map of normalized name → existing active student id for O(1) lookup.
    const existingActive = getStudents({ activeOnly: true });
    const activeByNormName = new Map(
      existingActive.map(s => [normalizeName(s.display_name), s])
    );

    let imported = 0, updated = 0;
    for (const s of students) {
      try {
        const norm = normalizeName(s.display_name);
        const existing = activeByNormName.get(norm);
        if (existing) {
          // Student already exists — update external_ref only (preserve id, display_name, etc.)
          updateStudent({ id: existing.id, external_ref: s.external_ref });
          updated++;
        } else {
          upsertStudent({ id: uuidv4(), display_name: s.display_name, external_ref: s.external_ref });
          imported++;
        }
      } catch (err) {
        errors.push({ line: null, reason: err.message });
      }
    }
    res.json({ imported, updated, errors });
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

  // ── Voice Text (IPC/HTTP fallback — same gate pipeline as WS voice_text) ──
  // Used by the Electron IPC handler when the overlay's WebSocket is down.
  router.post('/voice/text', async (req, res) => {
    const { text, confidence } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const conf = typeof confidence === 'number' ? confidence : null;
    try {
      const events = await wsProxy.handleVoiceText(String(text).trim(), conf);
      res.json({ events });
    } catch (err) {
      console.error('[VoiceText] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════
  // ── Setup Wizard REST Endpoints ──
  // ════════════════════════════════════════════════

  // GET /api/setup/status — booleans only, NEVER echoes key values
  router.get('/setup/status', (req, res) => {
    const status = wsProxy.getStatus();
    const ai = aiEngine ? aiEngine.getStatus() : { configured: false };
    const students = getStudents({ activeOnly: false });
    const settings = getAppSettings();
    res.json({
      keyConfigured: !!ai.configured,
      extensionConnected: status.extensionClients > 0,
      studentCount: students.length,
      micTestedThisSession: _micTestedThisSession,
      autoStart: settings.autoStart,
      wakeWordEnabled: settings.wakeWordEnabled,
      wakeWordPhrases: settings.wakeWordPhrases,
      setupComplete: settings.setupComplete,
    });
  });

  // POST /api/setup/keys — write API key to .env (atomic) and hot-reload
  // SECURITY: never echo the key value in any response
  router.post('/setup/keys', async (req, res) => {
    const { provider, apiKey } = req.body || {};
    if (!provider || typeof provider !== 'string') {
      return res.status(400).json({ error: 'provider is required' });
    }
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }

    // Determine env var name from provider
    const PROVIDER_ENV_KEYS = {
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      groq: 'GROQ_API_KEY',
      azure: 'AZURE_OPENAI_API_KEY',
      ollama: null, // No key needed
    };

    const envKey = PROVIDER_ENV_KEYS[provider];
    if (envKey === undefined) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    try {
      // Atomic env file write: read → upsert → tmp → rename
      if (envKey) {
        const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
        const updated = upsertEnvVar(existing, envKey, apiKey.trim());
        const tmp = ENV_PATH + '.tmp';
        writeFileSync(tmp, updated, 'utf8');
        renameSync(tmp, ENV_PATH);
        // Hot-reload: update process.env so the change takes effect without restart
        process.env[envKey] = apiKey.trim();
      }

      // Switch the AI engine to the new provider
      let switchResult = { applied: false, reason: 'no_ai_engine' };
      if (aiEngine) {
        try {
          switchResult = aiEngine.setProvider(provider);
          if (switchResult && typeof switchResult === 'object') {
            switchResult.applied = true;
          } else {
            switchResult = { applied: true };
          }
        } catch (err) {
          switchResult = { applied: false, reason: err.message };
        }
      }

      // Broadcast provider change to dashboard clients
      wsProxy._broadcastDashboard({ type: 'provider_switched', provider, timestamp: new Date().toISOString() });

      // SECURITY: response contains no key value
      res.json({ ok: true, provider, envVar: envKey || 'none', switch: switchResult });
    } catch (err) {
      console.error('[Setup/keys] Error:', err.message);
      res.status(500).json({ error: 'Failed to save key' });
    }
  });

  // POST /api/setup/app-settings — persist auto-start + wake-word preferences + sync config
  // SECURITY: classroomKey is never echoed in the response
  router.post('/setup/app-settings', async (req, res) => {
    const { autoStart, wakeWordEnabled, wakeWordPhrases, setupComplete, sync } = req.body || {};
    const patch = {};
    if (typeof autoStart === 'boolean') patch.autoStart = autoStart;
    if (typeof wakeWordEnabled === 'boolean') patch.wakeWordEnabled = wakeWordEnabled;
    if (Array.isArray(wakeWordPhrases)) patch.wakeWordPhrases = wakeWordPhrases;
    if (typeof setupComplete === 'boolean') patch.setupComplete = setupComplete;
    // Accept sync sub-object (classroomKey included but never echoed back)
    if (sync && typeof sync === 'object') patch.sync = sync;

    try {
      saveAppSettings(patch);
      const settings = getAppSettings();

      // Notify index.js so the sync client can be started/stopped if needed
      if (typeof req._restartSync === 'function') req._restartSync();

      // Apply auto-start via Electron bridge if present
      let autoStartApplied = false;
      if ('autoStart' in patch && globalThis.__ablespeakElectron) {
        try {
          globalThis.__ablespeakElectron.setAutoStart(settings.autoStart);
          autoStartApplied = true;
        } catch {}
      }

      // Live-update overlay: broadcast settings_update so wake-word toggles instantly
      wsProxy._broadcastDashboard({
        type: 'settings_update',
        wakeWordEnabled: settings.wakeWordEnabled,
        wakeWordPhrases: settings.wakeWordPhrases,
        timestamp: new Date().toISOString(),
      });

      // SECURITY: strip classroomKey from response
      const { sync: { classroomKey: _omit, ...syncSafe } = {} } = settings;
      const safeSettings = { ...settings, sync: { ...syncSafe, configured: !!settings.sync?.classroomKey } };
      delete safeSettings.sync.classroomKey;

      res.json({
        ok: true,
        settings: safeSettings,
        autoStartApplied,
        autoStartReason: !autoStartApplied && 'autoStart' in patch
          ? (globalThis.__ablespeakElectron ? 'bridge_error' : 'not_running_in_electron')
          : undefined,
      });
    } catch (err) {
      console.error('[Setup/app-settings] Error:', err.message);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  // POST /api/setup/mic-tested — called by step 4 to mark mic tested this session
  router.post('/setup/mic-tested', (req, res) => {
    _micTestedThisSession = true;
    res.json({ ok: true });
  });

  // ════════════════════════════════════════════════
  // ── T5: Progress Monitoring REST Endpoints ──
  // ════════════════════════════════════════════════

  // GET /api/students/:id/baseline-suggestion?measure=X
  // Returns { value, sampleDays, sampleSize } computed from last 14 days of commands.
  router.get('/students/:id/baseline-suggestion', (req, res) => {
    const { id } = req.params;
    const { measure } = req.query;
    if (!measure || !(measure in MEASURE_REGISTRY)) {
      return res.status(400).json({ error: `measure must be one of: ${Object.keys(MEASURE_REGISTRY).join(', ')}` });
    }
    const students = getStudents({ activeOnly: false });
    if (!students.find(s => s.id === id)) return res.status(404).json({ error: 'Student not found' });

    // Collect qualifying days: those with ≥ 3 attempted commands in the last 14 days.
    // Query each day exactly once; keep the results for probe computation below.
    const today = new Date().toISOString().slice(0, 10);
    const cutoffMs = new Date(today).getTime() - 14 * 86400000;
    const qualifyingDays = new Map(); // isoDate → dayCmds[]

    for (let d = 0; d <= 14; d++) {
      const dateMs = cutoffMs + d * 86400000;
      const isoDate = new Date(dateMs).toISOString().slice(0, 10);
      if (isoDate > today) break;
      const dayCmds = getCommandsForStudentDate(id, isoDate);
      const dayAttempted = dayCmds.filter(c => c.outcome != null);
      if (dayAttempted.length >= 3) {
        qualifyingDays.set(isoDate, dayCmds);
      }
    }

    if (qualifyingDays.size === 0) {
      return res.json({ value: null, sampleDays: 0, sampleSize: 0 });
    }

    // Compute per-day probe values and average them
    let totalValue = 0;
    let validDays = 0;
    let totalSample = 0;
    for (const [isoDate, dayCmds] of qualifyingDays) {
      const result = computeProbeValue(measure, dayCmds);
      if (result !== null) {
        totalValue += result.value;
        validDays++;
        totalSample += result.sampleSize;
      }
    }

    if (validDays === 0) return res.json({ value: null, sampleDays: 0, sampleSize: totalSample });

    res.json({
      value: totalValue / validDays,
      sampleDays: validDays,
      sampleSize: totalSample,
    });

  });

  // POST /api/students/:id/goals
  // Body: { measure, baseline_value, baseline_date, target_value, target_date, decision_rule? }
  // Validates inputs; auto-revises any prior active goal for same (student, measure).
  router.post('/students/:id/goals', (req, res) => {
    const { id } = req.params;
    const students = getStudents({ activeOnly: false });
    if (!students.find(s => s.id === id)) return res.status(404).json({ error: 'Student not found' });

    const { measure, baseline_value, baseline_date, target_value, target_date, decision_rule } = req.body || {};
    const errors = [];

    if (!measure || !(measure in MEASURE_REGISTRY)) {
      errors.push(`measure must be one of: ${Object.keys(MEASURE_REGISTRY).join(', ')}`);
    }
    if (typeof baseline_value !== 'number' || isNaN(baseline_value)) errors.push('baseline_value must be a number');
    if (typeof target_value !== 'number' || isNaN(target_value)) errors.push('target_value must be a number');
    if (!baseline_date || !/^\d{4}-\d{2}-\d{2}$/.test(baseline_date)) errors.push('baseline_date must be YYYY-MM-DD');
    if (!target_date || !/^\d{4}-\d{2}-\d{2}$/.test(target_date)) errors.push('target_date must be YYYY-MM-DD');
    if (baseline_date && target_date && target_date <= baseline_date) {
      errors.push('target_date must be after baseline_date');
    }
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    // Auto-revise any prior active goal for this (student, measure)
    const existingActive = getGoals({ studentId: id, status: 'active' })
      .filter(g => g.measure === measure);
    for (const eg of existingActive) {
      updateGoalStatus(eg.id, 'revised');
    }

    const goalId = uuidv4();
    insertGoal({
      id: goalId,
      student_id: id,
      measure,
      baseline_value,
      baseline_date,
      target_value,
      target_date,
      decision_rule: decision_rule || '4_below_aim',
    });

    const goals = getGoals({ studentId: id });
    res.status(201).json(goals.find(g => g.id === goalId));
  });

  // GET /api/students/:id/goals?status=active|all
  router.get('/students/:id/goals', (req, res) => {
    const { id } = req.params;
    const students = getStudents({ activeOnly: false });
    if (!students.find(s => s.id === id)) return res.status(404).json({ error: 'Student not found' });

    const statusFilter = req.query.status === 'all' ? null : (req.query.status || 'active');
    const goals = getGoals({ studentId: id, status: statusFilter });
    res.json(goals);
  });

  // PATCH /api/goals/:id — status transitions only: active→met|revised|discontinued
  router.patch('/goals/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    const allowed = ['met', 'revised', 'discontinued'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const goals = getGoals();
    const goal = goals.find(g => g.id === id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    updateGoalStatus(id, status);
    const updated = getGoals().find(g => g.id === id);
    res.json(updated);
  });

  // GET /api/goals/:id/points
  router.get('/goals/:id/points', (req, res) => {
    const { id } = req.params;
    const goals = getGoals();
    if (!goals.find(g => g.id === id)) return res.status(404).json({ error: 'Goal not found' });
    res.json(getProgressPoints(id));
  });

  // POST /api/goals/:id/points — manual probe
  // Body: { measured_at, value }
  router.post('/goals/:id/points', (req, res) => {
    const { id } = req.params;
    const goals = getGoals();
    const goal = goals.find(g => g.id === id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    const { measured_at, value } = req.body || {};
    if (!measured_at || !/^\d{4}-\d{2}-\d{2}$/.test(measured_at)) {
      return res.status(400).json({ error: 'measured_at must be YYYY-MM-DD' });
    }
    if (typeof value !== 'number' || isNaN(value)) {
      return res.status(400).json({ error: 'value must be a number' });
    }

    const pointId = uuidv4();
    upsertProgressPoint({
      id: pointId,
      goal_id: id,
      student_id: goal.student_id,
      measured_at,
      value,
      source: 'manual',
      sample_size: null,
    });

    const pts = getProgressPoints(id);
    res.status(201).json(pts.find(p => p.measured_at === measured_at));
  });

  // POST /api/goals/:id/phases — add phase change
  // Body: { changed_at, label, note? }
  router.post('/goals/:id/phases', (req, res) => {
    const { id } = req.params;
    const goals = getGoals();
    if (!goals.find(g => g.id === id)) return res.status(404).json({ error: 'Goal not found' });

    const { changed_at, label, note } = req.body || {};
    if (!changed_at || !/^\d{4}-\d{2}-\d{2}$/.test(changed_at)) {
      return res.status(400).json({ error: 'changed_at must be YYYY-MM-DD' });
    }
    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: 'label is required' });
    }

    const phaseId = uuidv4();
    insertPhaseChange({ id: phaseId, goal_id: id, changed_at, label: String(label).trim(), note: note ? String(note).trim() : null });
    const phases = getPhaseChanges(id);
    res.status(201).json(phases.find(p => p.id === phaseId));
  });

  // GET /api/goals/:id/phases
  router.get('/goals/:id/phases', (req, res) => {
    const { id } = req.params;
    const goals = getGoals();
    if (!goals.find(g => g.id === id)) return res.status(404).json({ error: 'Goal not found' });
    res.json(getPhaseChanges(id));
  });

  // GET /api/goals/:id/flags?unacknowledged=1
  router.get('/goals/:id/flags', (req, res) => {
    const { id } = req.params;
    const goals = getGoals();
    if (!goals.find(g => g.id === id)) return res.status(404).json({ error: 'Goal not found' });
    const unacknowledgedOnly = req.query.unacknowledged === '1';
    res.json(getDecisionFlags({ goalId: id, unacknowledgedOnly }));
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
      for (const g of activeGoals) {
        await evaluateAndFlag(g.id, today);
      }
      res.json({ ok: true, date: today, goals: activeGoals.length });
    } catch (err) {
      console.error('[Recompute] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function parseVocabularyField(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
