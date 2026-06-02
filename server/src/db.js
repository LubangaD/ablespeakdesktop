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

export function insertCommand({ id, type, direction, payload, result, latency_ms, session_id }) {
  run(`INSERT OR IGNORE INTO commands (id,type,direction,payload,result,latency_ms,session_id) VALUES (?,?,?,?,?,?,?)`,
    [id, type, direction || 'voqal_to_ext',
     typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
     typeof result === 'string' ? result : JSON.stringify(result || {}),
     latency_ms || null, session_id || null]);
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
