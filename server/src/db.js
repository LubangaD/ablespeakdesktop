import initSqlJs from 'sql.js';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';

/**
 * AbleSpeak SQLite Database Layer (using sql.js — pure JS, no native deps)
 */

let db = null;
let dbPath = null;
let saveTimer = null;

export async function initDatabase(path) {
  dbPath = path;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();

  if (existsSync(path)) {
    const buffer = readFileSync(path);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  migrate();
  scheduleSave();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

/**
 * Atomic save: write to .tmp then rename to prevent corruption on crash (Fix #6).
 */
function saveToFile() {
  if (!db || !dbPath) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const tmpPath = dbPath + '.tmp';
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, dbPath);
  } catch (err) {
    console.error('[DB] Save error:', err.message);
  }
}

function scheduleSave() {
  if (saveTimer) clearInterval(saveTimer);
  saveTimer = setInterval(saveToFile, 2000); // auto-save every 2s (reduced from 5s)
}

/** Stop the auto-save timer and release the handle (test/dev-reload cleanup). */
export function closeDatabase() {
  if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
  saveToFile();
  db = null;
}

function migrate() {
  db.run(`
    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'voqal_to_ext',
      payload TEXT,
      result TEXT,
      latency_ms INTEGER,
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, command_count INTEGER DEFAULT 0, prompt_switches INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS log_events (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, logger TEXT, message TEXT NOT NULL, raw_line TEXT, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS health_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', message TEXT, checked_at TEXT DEFAULT (datetime('now','localtime')))`);
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_commands_type ON commands(type)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_log_level ON log_events(level)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_health_comp ON health_checks(component)`); } catch {}

  // ── Teacher Dashboard: Students table ──
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    session_prefix TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_commands_session ON commands(session_id)`); } catch {}

  // ── Progress monitoring (Tier 2 KPI engine) ──
  // Recovered from the `eric` branch (df5ea9d/920bc23/681a72e), which never got
  // merged into main. Adapted to reference THIS file's existing INTEGER
  // students.id / session_prefix attribution model instead of eric's separate
  // TEXT-id student system — see insertCommand() below for how student_id gets
  // resolved from session_id automatically, with no ws-proxy.js changes needed.
  try { db.run(`ALTER TABLE commands ADD COLUMN student_id INTEGER`); } catch {}
  try { db.run(`ALTER TABLE commands ADD COLUMN outcome TEXT`); } catch {}
  try { db.run(`ALTER TABLE commands ADD COLUMN prompt_count INTEGER`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_commands_student ON commands(student_id)`); } catch {}
  db.run(`CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, student_id INTEGER NOT NULL, measure TEXT NOT NULL, baseline_value REAL NOT NULL, baseline_date TEXT NOT NULL, target_value REAL NOT NULL, target_date TEXT NOT NULL, decision_rule TEXT NOT NULL DEFAULT '4_below_aim', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS progress_points (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, student_id INTEGER NOT NULL, measured_at TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL DEFAULT 'auto', sample_size INTEGER, UNIQUE(goal_id, measured_at))`);
  db.run(`CREATE TABLE IF NOT EXISTS phase_changes (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, changed_at TEXT NOT NULL, label TEXT NOT NULL, note TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS decision_flags (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, rule TEXT NOT NULL, fired_at TEXT NOT NULL, detail TEXT, acknowledged_at TEXT)`);
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_goals_student ON goals(student_id)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_progress_points_goal ON progress_points(goal_id)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_decision_flags_goal ON decision_flags(goal_id)`); } catch {}

  // ── Student identity (AT-50) ──
  // Which student is using this computer is saved here, so it survives a
  // restart, and every session and voice command records that student
  // directly instead of being matched later by a text prefix.
  db.run(`CREATE TABLE IF NOT EXISTS device_state (key TEXT PRIMARY KEY, value TEXT)`);
  try { db.run(`ALTER TABLE sessions ADD COLUMN student_id INTEGER`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id)`); } catch {}
  // ── Student speech profiles (Stage 1 / Stage 4) — JSON, see student-profile.js ──
  db.run(`CREATE TABLE IF NOT EXISTS student_profiles (
    student_id INTEGER PRIMARY KEY,
    profile TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── Every voice turn, for the recognition readout (Stage 1) ──
  // outcome: 'no_speech' (nothing usable heard), 'filtered' (heard, but
  // treated as noise, music or echo), 'command', 'dictation', 'control'
  // (sleep, stop, …) or 'error' (the recogniser failed).
  db.run(`CREATE TABLE IF NOT EXISTS voice_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    student_id INTEGER,
    session_id TEXT,
    outcome TEXT NOT NULL,
    transcript TEXT,
    command_id TEXT,
    audio_kb INTEGER,
    ms INTEGER
  )`);
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_voice_turns_student ON voice_turns(student_id, created_at)`); } catch {}

  // ── "No, I meant …" pairs, from which shortcuts are learned (Stage 4) ──
  db.run(`CREATE TABLE IF NOT EXISTS correction_pairs (
    student_id INTEGER NOT NULL,
    heard TEXT NOT NULL,
    meant TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    last_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (student_id, heard, meant)
  )`);

  // ── How desktop targets were found (Stage 2 UIA resolution rate) ──
  // method: 'uia' (found in the accessibility tree), 'coordinates' (a screen
  // position, e.g. from the screenshot), 'not_found'.
  db.run(`CREATE TABLE IF NOT EXISTS resolution_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    app TEXT NOT NULL,
    method TEXT NOT NULL,
    action TEXT,
    found INTEGER NOT NULL,
    ok INTEGER,
    ms INTEGER,
    student_id INTEGER
  )`);
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_resolution_app ON resolution_log(app)`); } catch {}

  if (!getDeviceState('prefix_attribution_migrated')) {
    // Once: commands saved under the old prefix scheme get their student.
    db.run(`UPDATE commands SET student_id = (
        SELECT s.id FROM students s
        WHERE s.session_prefix IS NOT NULL AND s.session_prefix != ''
          AND commands.session_id LIKE (s.session_prefix || '%')
        ORDER BY s.id LIMIT 1)
      WHERE student_id IS NULL AND session_id IS NOT NULL AND type LIKE 'voice%'`);
    setDeviceState('prefix_attribution_migrated', '1');
  }

  saveToFile();
}

// Helper to run SELECT and return array of objects
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
}

// ── Device state ──

export function getDeviceState(key) {
  return queryOne('SELECT value FROM device_state WHERE key = ?', [key])?.value ?? null;
}

/** Save a value for this device; null removes it. */
export function setDeviceState(key, value) {
  if (value == null) run('DELETE FROM device_state WHERE key = ?', [key]);
  else run('INSERT INTO device_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

// ── Commands ──

/**
 * Resolve which student (if any) a session_id belongs to, via the same
 * session_prefix LIKE match getTeacherAnalytics() already uses — i.e. does
 * session_id start with that student's session_prefix.
 */
function resolveStudentIdForSession(sessionId) {
  if (!sessionId) return null;
  const row = queryOne(
    `SELECT id FROM students WHERE session_prefix IS NOT NULL AND session_prefix != '' AND ? LIKE (session_prefix || '%') LIMIT 1`,
    [sessionId]
  );
  return row?.id ?? null;
}

/**
 * Very small outcome heuristic derived from the same signal
 * getTeacherAnalytics() already uses (`result NOT LIKE '%error%'`).
 *
 * KNOWN LIMITATION: this cannot yet distinguish "succeeded first try" from
 * "succeeded after a retry/correction" — that needs real retry/repair
 * tracking in the voice pipeline (the `outcome stamping` work on the eric
 * branch, c8b4753, which is NOT included here). Until that lands,
 * independence_rate and task_completion will read identically, and
 * prompt_count is always 0. Both measures are still real and meaningful —
 * they're computed from actual command outcomes, not placeholder data —
 * they just don't yet differentiate "no prompts needed" from "needed one".
 */
function deriveOutcome(resultStr) {
  if (!resultStr) return null;
  return /error/i.test(resultStr) ? 'error' : 'success';
}

export function insertCommand({ id, type, direction, payload, result, latency_ms, session_id, student_id, outcome, prompt_count }) {
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result || {});

  // Only voice-originated commands feed the KPI engine — dev/chat test
  // traffic from the dashboard's Chat page must not pollute a student's data.
  const isVoice = typeof type === 'string' && type.startsWith('voice');
  const resolvedStudentId = isVoice ? (student_id ?? resolveStudentIdForSession(session_id)) : null;
  const resolvedOutcome = outcome ?? (isVoice ? deriveOutcome(resultStr) : null);
  const resolvedPromptCount = prompt_count ?? (isVoice ? 0 : null);

  run(`INSERT OR IGNORE INTO commands (id,type,direction,payload,result,latency_ms,session_id,student_id,outcome,prompt_count) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, type, direction || 'voqal_to_ext',
     typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
     resultStr,
     latency_ms || null, session_id || null,
     resolvedStudentId, resolvedOutcome, resolvedPromptCount]);
  if (session_id) run('UPDATE sessions SET command_count = command_count + 1 WHERE id = ?', [session_id]);
}

/**
 * Change a saved command's outcome: 'error' when the student undid it,
 * 'superseded' when a later try at the same task replaced it.
 */
export function updateCommandOutcome(id, outcome) {
  run('UPDATE commands SET outcome = ? WHERE id = ?', [outcome, id]);
}

export function getCommands({ limit = 50, offset = 0, type = null, direction = null } = {}) {
  let sql = 'SELECT * FROM commands WHERE 1=1';
  const params = [];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (direction) { sql += ' AND direction = ?'; params.push(direction); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return query(sql, params);
}

export function getCommandStats() {
  const total = queryOne('SELECT COUNT(*) as count FROM commands');
  const today = queryOne(`SELECT COUNT(*) as count FROM commands WHERE date(created_at)=date('now','localtime')`);
  const avgLatency = queryOne(`SELECT ROUND(AVG(latency_ms),0) as avg_ms FROM commands WHERE latency_ms IS NOT NULL AND date(created_at)=date('now','localtime')`);
  const byType = query(`SELECT type, COUNT(*) as count FROM commands WHERE date(created_at)=date('now','localtime') GROUP BY type ORDER BY count DESC LIMIT 10`);
  const hourly = query(`SELECT strftime('%H',created_at) as hour, COUNT(*) as count FROM commands WHERE date(created_at)=date('now','localtime') GROUP BY hour ORDER BY hour`);
  return { total: total?.count || 0, today: today?.count || 0, successRate: 0, avgLatency: avgLatency?.avg_ms || 0, byType, hourly };
}

// ── Sessions ──

export function insertSession({ id, started_at, student_id = null }) {
  run('INSERT INTO sessions (id,started_at,student_id) VALUES (?,?,?)', [id, started_at, student_id]);
}
export function endSession(id, ended_at) {
  run('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [ended_at, id]);
}

/** Sessions left open by a crash or forced quit end at their last command. */
export function closeAbandonedSessions() {
  run(`UPDATE sessions SET ended_at = COALESCE(
      (SELECT MAX(created_at) FROM commands WHERE commands.session_id = sessions.id), started_at)
    WHERE ended_at IS NULL`);
}
export function getSessions({ limit = 20, studentId = null } = {}) {
  if (studentId != null) {
    return query('SELECT * FROM sessions WHERE student_id = ? ORDER BY started_at DESC LIMIT ?', [studentId, limit]);
  }
  return query('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?', [limit]);
}

// ── Log Events ──

export function insertLogEvent({ level, logger, message, raw_line }) {
  run('INSERT INTO log_events (level,logger,message,raw_line) VALUES (?,?,?,?)', [level, logger, message, raw_line]);
}

export function getLogEvents({ limit = 100, offset = 0, level = null, search = null } = {}) {
  let sql = 'SELECT * FROM log_events WHERE 1=1';
  const params = [];
  if (level) { sql += ' AND level=?'; params.push(level); }
  if (search) { sql += ' AND message LIKE ?'; params.push(`%${search}%`); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return query(sql, params);
}

// ── Health Checks ──

export function upsertHealthCheck({ component, status, message }) {
  run('INSERT INTO health_checks (component,status,message) VALUES (?,?,?)', [component, status, message]);
}

export function getLatestHealthChecks() {
  return query(`SELECT h.* FROM health_checks h INNER JOIN (SELECT component, MAX(id) as max_id FROM health_checks GROUP BY component) latest ON h.id=latest.max_id ORDER BY h.component`);
}

export function getHealthAlerts() {
  return query(`SELECT h.* FROM health_checks h INNER JOIN (SELECT component, MAX(id) as max_id FROM health_checks GROUP BY component) latest ON h.id=latest.max_id WHERE h.status IN ('warn','error') ORDER BY h.checked_at DESC`);
}

// ── Teacher Dashboard: Students ──

export function getStudents() {
  return query('SELECT * FROM students ORDER BY name ASC');
}

export function getStudent(id) {
  return queryOne('SELECT * FROM students WHERE id = ?', [id]);
}

export function addStudent({ name, session_prefix }) {
  run('INSERT INTO students (name, session_prefix) VALUES (?, ?)', [name, session_prefix || null]);
  return queryOne('SELECT * FROM students WHERE id = last_insert_rowid()');
}

export function deleteStudent(id) {
  run('DELETE FROM students WHERE id = ?', [id]);
  run('DELETE FROM student_profiles WHERE student_id = ?', [id]);
  run('DELETE FROM correction_pairs WHERE student_id = ?', [id]);
}

export function getTeacherAnalytics() {
  const students = getStudents();

  // Per-student stats, from the student recorded on each command
  const perStudent = students.map(s => {
    const stats = queryOne(
      `SELECT SUM(CASE WHEN outcome IS NULL OR outcome != 'superseded' THEN 1 ELSE 0 END) AS total,
              SUM(CASE WHEN outcome IN ('success','repaired') THEN 1 ELSE 0 END) AS succeeded,
              ROUND(AVG(latency_ms), 0) AS avg_ms,
              MAX(created_at) AS last_active
       FROM commands WHERE student_id = ?`,
      [s.id]
    );
    const topCmd = queryOne(
      `SELECT type, COUNT(*) as count FROM commands WHERE student_id = ? GROUP BY type ORDER BY count DESC LIMIT 1`,
      [s.id]
    );
    const sessionsThisWeek = queryOne(
      `SELECT COUNT(*) AS count FROM sessions WHERE student_id = ? AND started_at >= datetime('now', '-7 days', 'localtime')`,
      [s.id]
    );

    const totalCount = stats?.total || 0;
    const succCount = stats?.succeeded || 0;

    return {
      id: s.id,
      name: s.name,
      session_prefix: s.session_prefix,
      commands: totalCount,
      successRate: totalCount > 0 ? Math.round((succCount / totalCount) * 100) : 0,
      avgLatency: stats?.avg_ms || 0,
      topCommand: topCmd?.type || '—',
      lastActive: stats?.last_active || '—',
      sessionsThisWeek: sessionsThisWeek?.count || 0,
    };
  });

  // Class-wide summary
  const totalCommands = queryOne('SELECT COUNT(*) as count FROM commands');
  const todayCommands = queryOne(`SELECT COUNT(*) as count FROM commands WHERE date(created_at)=date('now','localtime')`);
  const classAvgLatency = queryOne(`SELECT ROUND(AVG(latency_ms), 0) as avg_ms FROM commands WHERE latency_ms IS NOT NULL`);
  const classSuccessTotal = queryOne(`SELECT COUNT(*) as count FROM commands`);
  const classSuccessOk = queryOne(`SELECT COUNT(*) as count FROM commands WHERE result NOT LIKE '%error%' AND result NOT LIKE '%Error%'`);

  // Daily trend (last 7 days)
  const dailyTrend = query(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM commands
    WHERE created_at >= datetime('now', '-7 days', 'localtime')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `);

  // Command type breakdown (all time)
  const commandBreakdown = query(`
    SELECT type, COUNT(*) as count
    FROM commands
    GROUP BY type
    ORDER BY count DESC
    LIMIT 10
  `);

  const totalCount = classSuccessTotal?.count || 0;
  const okCount = classSuccessOk?.count || 0;

  return {
    summary: {
      totalStudents: students.length,
      totalCommands: totalCommands?.count || 0,
      todayCommands: todayCommands?.count || 0,
      avgLatency: classAvgLatency?.avg_ms || 0,
      successRate: totalCount > 0 ? Math.round((okCount / totalCount) * 100) : 0,
    },
    students: perStudent,
    dailyTrend,
    commandBreakdown,
  };
}

// ── Progress Monitoring: Goals (Tier 2 KPI engine) ──

export function insertGoal({ id, student_id, measure, baseline_value, baseline_date, target_value, target_date, decision_rule = '4_below_aim' }) {
  run(
    `INSERT INTO goals (id,student_id,measure,baseline_value,baseline_date,target_value,target_date,decision_rule,status,updated_at) VALUES (?,?,?,?,?,?,?,?,'active',datetime('now','localtime'))`,
    [id, student_id, measure, baseline_value, baseline_date, target_value, target_date, decision_rule]
  );
}

export function getGoals({ studentId = null, status = null } = {}) {
  let sql = 'SELECT * FROM goals WHERE 1=1';
  const params = [];
  if (studentId != null) { sql += ' AND student_id=?'; params.push(studentId); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  return query(sql, params);
}

export function updateGoalStatus(goalId, status) {
  run(`UPDATE goals SET status=?, updated_at=datetime('now','localtime') WHERE id=?`, [status, goalId]);
}

// ── Progress Points ──

/**
 * Upsert a progress point. Manual points always win over auto (overwrite
 * either); auto points only overwrite an existing auto point, never manual.
 */
export function upsertProgressPoint({ id, goal_id, student_id, measured_at, value, source = 'auto', sample_size = null }) {
  if (source === 'manual') {
    run(
      `INSERT INTO progress_points (id,goal_id,student_id,measured_at,value,source,sample_size) VALUES (?,?,?,?,?,?,?) ON CONFLICT(goal_id,measured_at) DO UPDATE SET id=excluded.id, student_id=excluded.student_id, value=excluded.value, source=excluded.source, sample_size=excluded.sample_size`,
      [id, goal_id, student_id, measured_at, value, source, sample_size]
    );
  } else {
    run(
      `INSERT INTO progress_points (id,goal_id,student_id,measured_at,value,source,sample_size) VALUES (?,?,?,?,?,?,?) ON CONFLICT(goal_id,measured_at) DO UPDATE SET id=excluded.id, student_id=excluded.student_id, value=excluded.value, source=excluded.source, sample_size=excluded.sample_size WHERE progress_points.source='auto'`,
      [id, goal_id, student_id, measured_at, value, source, sample_size]
    );
  }
}

export function getProgressPoints(goalId) {
  return query(`SELECT * FROM progress_points WHERE goal_id=? ORDER BY measured_at ASC`, [goalId]);
}

// ── Phase Changes ──

export function insertPhaseChange({ id, goal_id, changed_at, label, note = null }) {
  run(`INSERT INTO phase_changes (id,goal_id,changed_at,label,note) VALUES (?,?,?,?,?)`, [id, goal_id, changed_at, label, note]);
}

export function getPhaseChanges(goalId) {
  return query(`SELECT * FROM phase_changes WHERE goal_id=? ORDER BY changed_at ASC`, [goalId]);
}

// ── Decision Flags ──

export function insertDecisionFlag({ id, goal_id, rule, fired_at, detail = null }) {
  run(`INSERT INTO decision_flags (id,goal_id,rule,fired_at,detail) VALUES (?,?,?,?,?)`, [id, goal_id, rule, fired_at, detail]);
}

export function getDecisionFlags({ goalId, unacknowledgedOnly = false } = {}) {
  let sql = 'SELECT * FROM decision_flags WHERE goal_id=?';
  const params = [goalId];
  if (unacknowledgedOnly) sql += ' AND acknowledged_at IS NULL';
  sql += ' ORDER BY fired_at DESC';
  return query(sql, params);
}

export function acknowledgeFlag(id) {
  run(`UPDATE decision_flags SET acknowledged_at=datetime('now','localtime') WHERE id=?`, [id]);
}

// ── Student speech profiles ──

export function getStudentProfileRow(studentId) {
  return queryOne('SELECT * FROM student_profiles WHERE student_id = ?', [studentId]);
}

export function saveStudentProfileRow(studentId, profileJson) {
  run(`INSERT INTO student_profiles (student_id, profile, updated_at) VALUES (?, ?, datetime('now','localtime'))
       ON CONFLICT(student_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`,
    [studentId, profileJson]);
}

// ── Corrections (Stage 4) ──

/** Count one "no, I meant" pair; returns how many times it has happened. */
export function recordCorrection({ student_id, heard, meant }) {
  run(`INSERT INTO correction_pairs (student_id, heard, meant, count, last_at) VALUES (?, ?, ?, 1, datetime('now','localtime'))
       ON CONFLICT(student_id, heard, meant) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
    [student_id, heard, meant]);
  return queryOne('SELECT count FROM correction_pairs WHERE student_id = ? AND heard = ? AND meant = ?', [student_id, heard, meant])?.count ?? 0;
}

// ── Voice turns (Stage 1 recognition readout) ──

export function logVoiceTurn({ student_id = null, session_id = null, outcome, transcript = null, command_id = null, audio_kb = null, ms = null }) {
  run(
    'INSERT INTO voice_turns (student_id, session_id, outcome, transcript, command_id, audio_kb, ms) VALUES (?,?,?,?,?,?,?)',
    [student_id, session_id, outcome, transcript == null ? null : String(transcript).slice(0, 500), command_id, audio_kb, ms]
  );
}

/**
 * How well a student is being heard since `since` (local datetime):
 * - heardRate: turns with usable words over all turns
 * - firstTimeRate: commands that worked without a retry or correction
 * - retries: commands that were another go at a failed one
 */
export function getRecognitionStats(studentId, { since }) {
  const turns = queryOne(
    `SELECT COUNT(*) AS turns,
            SUM(CASE WHEN outcome IN ('command','dictation','control') THEN 1 ELSE 0 END) AS heard,
            SUM(CASE WHEN outcome = 'no_speech' THEN 1 ELSE 0 END) AS no_speech,
            SUM(CASE WHEN outcome = 'filtered' THEN 1 ELSE 0 END) AS filtered,
            SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN outcome = 'dictation' THEN 1 ELSE 0 END) AS dictated,
            ROUND(AVG(ms), 0) AS avg_ms
     FROM voice_turns WHERE student_id = ? AND created_at >= ?`,
    [studentId, since]
  );
  const commands = queryOne(
    `SELECT SUM(CASE WHEN outcome != 'superseded' THEN 1 ELSE 0 END) AS tasks,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS first_time,
            SUM(CASE WHEN outcome = 'repaired' THEN 1 ELSE 0 END) AS repaired,
            SUM(CASE WHEN outcome = 'superseded' THEN 1 ELSE 0 END) AS retries,
            SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS failed
     FROM commands WHERE student_id = ? AND created_at >= ? AND outcome IS NOT NULL`,
    [studentId, since]
  );
  const t = turns || {};
  const c = commands || {};
  return {
    since,
    turns: t.turns || 0,
    heard: t.heard || 0,
    noSpeech: t.no_speech || 0,
    filtered: t.filtered || 0,
    errors: t.errors || 0,
    dictated: t.dictated || 0,
    avgMs: t.avg_ms || null,
    heardRate: t.turns ? (t.heard || 0) / t.turns : null,
    tasks: c.tasks || 0,
    firstTime: c.first_time || 0,
    repaired: c.repaired || 0,
    retries: c.retries || 0,
    failed: c.failed || 0,
    firstTimeRate: c.tasks ? (c.first_time || 0) / c.tasks : null,
  };
}

/**
 * Retries per completed task in the `days` before and after a moment — the
 * last change to the student's speech settings (Stage 4 acceptance).
 * A completed task's prompt_count is how many tries it needed before working.
 */
export function getRetriesAround(studentId, { at, days = 14 }) {
  const window = (from, to) => {
    const row = queryOne(
      `SELECT COUNT(*) AS tasks, SUM(prompt_count) AS retries
       FROM commands
       WHERE student_id = ? AND outcome IN ('success','repaired')
         AND created_at >= datetime(?, ?) AND created_at < datetime(?, ?)`,
      [studentId, at, from, at, to]
    );
    const tasks = row?.tasks || 0;
    return { tasks, retries: row?.retries || 0, retriesPerTask: tasks ? (row.retries || 0) / tasks : null };
  };
  return { at, days, before: window(`-${days} days`, '+0 days'), after: window('+0 days', `+${days} days`) };
}

/** The most recent turns that were heard but set aside as noise, for review. */
export function getFilteredTurns(studentId, { limit = 20 } = {}) {
  return query(
    `SELECT created_at, transcript FROM voice_turns WHERE student_id = ? AND outcome = 'filtered' ORDER BY id DESC LIMIT ?`,
    [studentId, limit]
  );
}

// ── Desktop target resolution (Stage 2) ──

export function logResolution({ app, method, action = null, found, ok = null, ms = null, student_id = null }) {
  run(
    'INSERT INTO resolution_log (app, method, action, found, ok, ms, student_id) VALUES (?,?,?,?,?,?,?)',
    [app, method, action, found ? 1 : 0, ok == null ? null : (ok ? 1 : 0), ms, student_id]
  );
}

/**
 * Per app since `since` (local datetime): how many targets were found in the
 * accessibility tree, by screen position, or not at all, and the resolution
 * rate — tree hits over all attempts.
 */
export function getResolutionStats({ since = null } = {}) {
  const rows = query(
    `SELECT app,
            SUM(CASE WHEN method = 'uia' THEN 1 ELSE 0 END) AS uia,
            SUM(CASE WHEN method = 'coordinates' THEN 1 ELSE 0 END) AS coordinates,
            SUM(CASE WHEN method = 'not_found' THEN 1 ELSE 0 END) AS not_found,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed_actions,
            COUNT(*) AS attempts,
            ROUND(AVG(ms), 0) AS avg_ms,
            MIN(created_at) AS first_at,
            MAX(created_at) AS last_at
     FROM resolution_log
     ${since ? 'WHERE created_at >= ?' : ''}
     GROUP BY app ORDER BY attempts DESC`,
    since ? [since] : []
  );
  return rows.map(r => ({ ...r, resolutionRate: r.attempts ? r.uia / r.attempts : null }));
}

// ── Commands for Probing ──

/** Fetch all commands for a student on a specific date (YYYY-MM-DD). */
export function getCommandsForStudentDate(studentId, isoDate) {
  return query(`SELECT * FROM commands WHERE student_id=? AND date(created_at)=?`, [studentId, isoDate]);
}
