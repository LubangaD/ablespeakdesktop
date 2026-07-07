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

  // T0: student identity + speech profiles + progress monitoring schema
  db.run(`CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, external_ref TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS speech_profiles (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, custom_vocabulary TEXT DEFAULT '[]', min_audio_b64 INTEGER DEFAULT 4000, min_confidence REAL DEFAULT 0.45, fuzzy_threshold REAL DEFAULT 0.34, silence_threshold REAL DEFAULT 15, silence_duration_ms INTEGER DEFAULT 2000, repair_enabled INTEGER DEFAULT 1, updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  try { db.run(`ALTER TABLE sessions ADD COLUMN student_id TEXT`); } catch {}
  try { db.run(`ALTER TABLE commands ADD COLUMN student_id TEXT`); } catch {}
  try { db.run(`ALTER TABLE commands ADD COLUMN outcome TEXT`); } catch {}
  try { db.run(`ALTER TABLE commands ADD COLUMN prompt_count INTEGER`); } catch {}
  db.run(`CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, measure TEXT NOT NULL, baseline_value REAL NOT NULL, baseline_date TEXT NOT NULL, target_value REAL NOT NULL, target_date TEXT NOT NULL, decision_rule TEXT NOT NULL DEFAULT '4_below_aim', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS progress_points (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, student_id TEXT NOT NULL, measured_at TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL DEFAULT 'auto', sample_size INTEGER, UNIQUE(goal_id, measured_at))`);
  db.run(`CREATE TABLE IF NOT EXISTS phase_changes (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, changed_at TEXT NOT NULL, label TEXT NOT NULL, note TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS decision_flags (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, rule TEXT NOT NULL, fired_at TEXT NOT NULL, detail TEXT, acknowledged_at TEXT)`);

  // T4: sync schema additions (additive ALTER TABLE — try/catch for idempotency)
  try { db.run(`ALTER TABLE students ADD COLUMN sync_opt_in INTEGER DEFAULT 1`); } catch {}
  try { db.run(`ALTER TABLE commands ADD COLUMN origin_device TEXT`); } catch {}
  try { db.run(`ALTER TABLE sessions ADD COLUMN origin_device TEXT`); } catch {}
  db.run(`CREATE TABLE IF NOT EXISTS sync_state (table_name TEXT PRIMARY KEY, last_cursor TEXT, updated_at TEXT)`);

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

export function insertCommand({ id, type, direction, payload, result, latency_ms, session_id, student_id, outcome, prompt_count }) {
  run(`INSERT OR IGNORE INTO commands (id,type,direction,payload,result,latency_ms,session_id,student_id,outcome,prompt_count) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, type, direction || 'voqal_to_ext',
     typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
     typeof result === 'string' ? result : JSON.stringify(result || {}),
     latency_ms || null, session_id || null,
     student_id || null, outcome || null, prompt_count ?? null]);
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

export function insertSession({ id, started_at, student_id }) { run('INSERT INTO sessions (id,started_at,student_id) VALUES (?,?,?)', [id, started_at, student_id || null]); }
export function endSession(id) { run(`UPDATE sessions SET ended_at=datetime('now','localtime') WHERE id=?`, [id]); }
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

// ── Students ──

export function upsertStudent({ id, display_name, external_ref }) {
  run(`INSERT INTO students (id,display_name,external_ref) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, external_ref=excluded.external_ref`,
    [id, display_name, external_ref || null]);
}

export function updateStudent({ id, display_name, external_ref, active, sync_opt_in }) {
  const parts = [];
  const params = [];
  if (display_name !== undefined) { parts.push('display_name=?'); params.push(display_name); }
  if (external_ref !== undefined) { parts.push('external_ref=?'); params.push(external_ref); }
  if (active !== undefined) { parts.push('active=?'); params.push(active ? 1 : 0); }
  if (sync_opt_in !== undefined) { parts.push('sync_opt_in=?'); params.push(sync_opt_in ? 1 : 0); }
  if (parts.length === 0) return;
  params.push(id);
  run(`UPDATE students SET ${parts.join(',')} WHERE id=?`, params);
}

export function getStudents({ activeOnly = true } = {}) {
  if (activeOnly) return query(`SELECT * FROM students WHERE active=1 ORDER BY display_name`);
  return query(`SELECT * FROM students ORDER BY display_name`);
}

// ── Speech Profiles ──

const SPEECH_PROFILE_DEFAULTS = {
  custom_vocabulary: '[]', min_audio_b64: 4000, min_confidence: 0.45,
  fuzzy_threshold: 0.34, silence_threshold: 15, silence_duration_ms: 2000, repair_enabled: 1,
};

export function getSpeechProfile(studentId) {
  const row = queryOne(`SELECT * FROM speech_profiles WHERE student_id=?`, [studentId]);
  if (row) return row;
  return { ...SPEECH_PROFILE_DEFAULTS, student_id: studentId, id: null, updated_at: null };
}

export function saveSpeechProfile(profile) {
  const { id, student_id, custom_vocabulary, min_audio_b64, min_confidence, fuzzy_threshold, silence_threshold, silence_duration_ms, repair_enabled } = profile;
  run(`INSERT INTO speech_profiles (id,student_id,custom_vocabulary,min_audio_b64,min_confidence,fuzzy_threshold,silence_threshold,silence_duration_ms,repair_enabled,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now','localtime')) ON CONFLICT(id) DO UPDATE SET student_id=excluded.student_id, custom_vocabulary=COALESCE(excluded.custom_vocabulary,custom_vocabulary), min_audio_b64=COALESCE(excluded.min_audio_b64,min_audio_b64), min_confidence=COALESCE(excluded.min_confidence,min_confidence), fuzzy_threshold=COALESCE(excluded.fuzzy_threshold,fuzzy_threshold), silence_threshold=COALESCE(excluded.silence_threshold,silence_threshold), silence_duration_ms=COALESCE(excluded.silence_duration_ms,silence_duration_ms), repair_enabled=COALESCE(excluded.repair_enabled,repair_enabled), updated_at=datetime('now','localtime')`,
    [id || null, student_id, custom_vocabulary ?? null, min_audio_b64 ?? null, min_confidence ?? null, fuzzy_threshold ?? null, silence_threshold ?? null, silence_duration_ms ?? null, repair_enabled ?? null]);
}

// ── T4 Sync Helpers ──

/**
 * Cursor strategy: INTEGER rowid (device-local, monotonically increasing per table).
 * nextCursor = max rowid seen (as string). '0' = start from the beginning.
 * Rows with student_id NULL are excluded when optInStudentIdsOnly is true.
 */
export function getRowsSince(table, cursor, { optInStudentIdsOnly = false } = {}) {
  const rowid = parseInt(cursor) || 0;
  const BATCH = 500;
  const OPT_IN = `(SELECT id FROM students WHERE sync_opt_in=1)`;

  let sql, params;

  if (table === 'students') {
    const f = optInStudentIdsOnly ? `AND sync_opt_in=1` : '';
    sql = `SELECT *, rowid AS _sync_cursor FROM students WHERE rowid>? ${f} ORDER BY rowid LIMIT ?`;
    params = [rowid, BATCH];
  } else if (['commands', 'sessions', 'speech_profiles', 'goals', 'progress_points'].includes(table)) {
    const f = optInStudentIdsOnly
      ? `AND student_id IS NOT NULL AND student_id IN ${OPT_IN}`
      : '';
    sql = `SELECT *, rowid AS _sync_cursor FROM ${table} WHERE rowid>? ${f} ORDER BY rowid LIMIT ?`;
    params = [rowid, BATCH];
  } else if (['phase_changes', 'decision_flags'].includes(table)) {
    const f = optInStudentIdsOnly
      ? `AND t.goal_id IN (SELECT id FROM goals WHERE student_id IS NOT NULL AND student_id IN ${OPT_IN})`
      : '';
    sql = `SELECT t.*, t.rowid AS _sync_cursor FROM ${table} t WHERE t.rowid>? ${f} ORDER BY t.rowid LIMIT ?`;
    params = [rowid, BATCH];
  } else {
    throw new Error(`getRowsSince: unsupported table "${table}"`);
  }

  const rows = query(sql, params);
  const nextCursor = rows.length > 0 ? String(rows[rows.length - 1]._sync_cursor) : String(rowid);

  // Strip internal cursor alias before returning
  return {
    rows: rows.map(({ _sync_cursor, ...r }) => r),
    nextCursor,
  };
}

// Tables with origin_device column (stamped on ingest to identify the sending device)
const ORIGIN_DEVICE_TABLES = new Set(['commands', 'sessions']);
// Evidence tables: INSERT OR IGNORE by PK — immutable once written
const EVIDENCE_TABLES = new Set(['commands', 'sessions', 'progress_points', 'phase_changes', 'decision_flags']);
// Mutable tables: last-write-wins by comparing timestamp columns
const MUTABLE_TABLES = new Set(['students', 'speech_profiles', 'goals']);
// Timestamp column used for last-write-wins per mutable table
const MUTABLE_TS = { students: 'created_at', speech_profiles: 'updated_at', goals: 'created_at' };

/**
 * Ingest rows from another device into the local database.
 * Evidence tables: INSERT OR IGNORE by primary key; stamps origin_device where column exists.
 * Mutable tables: upsert only if incoming timestamp is newer (last-write-wins).
 * Returns { inserted, skipped }.
 */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function ingestRows(table, rows, originDevice) {
  if (!rows || rows.length === 0) return { inserted: 0, skipped: 0 };
  if (!EVIDENCE_TABLES.has(table) && !MUTABLE_TABLES.has(table)) {
    throw new Error(`ingestRows: unsupported table "${table}"`);
  }

  let inserted = 0, skipped = 0;

  for (const rawRow of rows) {
    // Build clean row: strip sync-internal fields and any non-identifier keys —
    // column names are interpolated into SQL, so only plain identifiers pass.
    const row = {};
    for (const [k, v] of Object.entries(rawRow)) {
      if (k !== '_sync_cursor' && SAFE_IDENT.test(k)) row[k] = v;
    }
    if (Object.keys(row).length === 0) { skipped++; continue; }

    if (EVIDENCE_TABLES.has(table)) {
      // Stamp origin_device for tables that have the column
      if (ORIGIN_DEVICE_TABLES.has(table)) {
        row.origin_device = originDevice;
      }
      const cols = Object.keys(row);
      run(
        `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map(c => row[c])
      );
      if (db.getRowsModified() > 0) inserted++;
      else skipped++;

    } else {
      // Mutable: last-write-wins
      const tsCol = MUTABLE_TS[table];
      const cols = Object.keys(row);
      const setClauses = cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(',');
      run(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${setClauses} WHERE excluded.${tsCol} > ${table}.${tsCol}`,
        cols.map(c => row[c])
      );
      if (db.getRowsModified() > 0) inserted++;
      else skipped++;
    }
  }

  return { inserted, skipped };
}

/** Read the persisted sync cursor for a table (returns '0' if none set). */
export function getSyncCursor(table) {
  const row = queryOne(`SELECT last_cursor FROM sync_state WHERE table_name=?`, [table]);
  return row ? row.last_cursor : '0';
}

/** Persist the sync cursor for a table. */
export function setSyncCursor(table, cursor) {
  run(
    `INSERT INTO sync_state (table_name,last_cursor,updated_at) VALUES (?,?,datetime('now','localtime')) ON CONFLICT(table_name) DO UPDATE SET last_cursor=excluded.last_cursor, updated_at=excluded.updated_at`,
    [table, cursor]
  );
}
