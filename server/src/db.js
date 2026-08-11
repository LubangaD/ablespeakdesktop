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
  const resolvedStudentId = student_id ?? (isVoice ? resolveStudentIdForSession(session_id) : null);
  const resolvedOutcome = outcome ?? (isVoice ? deriveOutcome(resultStr) : null);
  const resolvedPromptCount = prompt_count ?? (isVoice ? 0 : null);

  run(`INSERT OR IGNORE INTO commands (id,type,direction,payload,result,latency_ms,session_id,student_id,outcome,prompt_count) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, type, direction || 'voqal_to_ext',
     typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
     resultStr,
     latency_ms || null, session_id || null,
     resolvedStudentId, resolvedOutcome, resolvedPromptCount]);
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

export function insertSession({ id, started_at }) { run('INSERT INTO sessions (id,started_at) VALUES (?,?)', [id, started_at]); }
export function getSessions({ limit = 20 } = {}) { return query('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?', [limit]); }

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

export function addStudent({ name, session_prefix }) {
  run('INSERT INTO students (name, session_prefix) VALUES (?, ?)', [name, session_prefix || null]);
  return queryOne('SELECT * FROM students WHERE id = last_insert_rowid()');
}

export function deleteStudent(id) {
  run('DELETE FROM students WHERE id = ?', [id]);
}

export function getTeacherAnalytics() {
  const students = getStudents();

  // Per-student stats: join students to commands via session_prefix
  const perStudent = students.map(s => {
    const prefix = s.session_prefix || s.name;
    const total = queryOne(
      `SELECT COUNT(*) as count FROM commands WHERE session_id LIKE ?`,
      [`${prefix}%`]
    );
    const successCount = queryOne(
      `SELECT COUNT(*) as count FROM commands WHERE session_id LIKE ? AND (result NOT LIKE '%error%' AND result NOT LIKE '%Error%')`,
      [`${prefix}%`]
    );
    const avgLat = queryOne(
      `SELECT ROUND(AVG(latency_ms), 0) as avg_ms FROM commands WHERE session_id LIKE ? AND latency_ms IS NOT NULL`,
      [`${prefix}%`]
    );
    const topCmd = queryOne(
      `SELECT type, COUNT(*) as count FROM commands WHERE session_id LIKE ? GROUP BY type ORDER BY count DESC LIMIT 1`,
      [`${prefix}%`]
    );
    const lastActive = queryOne(
      `SELECT created_at FROM commands WHERE session_id LIKE ? ORDER BY created_at DESC LIMIT 1`,
      [`${prefix}%`]
    );

    const totalCount = total?.count || 0;
    const succCount = successCount?.count || 0;

    return {
      id: s.id,
      name: s.name,
      session_prefix: s.session_prefix,
      commands: totalCount,
      successRate: totalCount > 0 ? Math.round((succCount / totalCount) * 100) : 0,
      avgLatency: avgLat?.avg_ms || 0,
      topCommand: topCmd?.type || '—',
      lastActive: lastActive?.created_at || '—',
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

// ── Commands for Probing ──

/** Fetch all commands for a student on a specific date (YYYY-MM-DD). */
export function getCommandsForStudentDate(studentId, isoDate) {
  return query(`SELECT * FROM commands WHERE student_id=? AND date(created_at)=?`, [studentId, isoDate]);
}
