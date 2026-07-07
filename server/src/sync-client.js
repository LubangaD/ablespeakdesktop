/**
 * AbleSpeak T4 Sync Client (sender side) — pure core + thin I/O shell.
 *
 * buildSyncBatch is pure: given tables, an injected getRows(table, cursor), and a
 * cursor map, it returns the batches to send. Opt-out and null-student filtering
 * happens in the injected getRows (db.getRowsSince with optInStudentIdsOnly=true),
 * i.e. AT PAYLOAD BUILD TIME on the sender — excluded rows never enter the payload.
 *
 * SyncClient pushes encrypted batches to the teacher's gateway:
 *   - cursors advance ONLY after a confirmed HTTP 200 (no data loss on failure)
 *   - failures never throw out of the timer loop; rows are re-sent next cycle
 *   - retry backoff reuses reconnect.js nextRetryDelay (T2)
 *   - settings are re-read every cycle, so changes apply without restart
 *
 * SECURITY: classroomKey is read from settings, used only for encryption, and is
 * never logged or included in any message.
 */

import { encryptPayload } from './sync-crypto.js';
import { nextRetryDelay } from './reconnect.js';
import * as realDb from './db.js';

/** Tables synced device → teacher, in dependency-friendly order (students first). */
export const SYNC_TABLES = [
  'students', 'speech_profiles', 'goals',
  'commands', 'sessions', 'progress_points', 'phase_changes', 'decision_flags',
];

/**
 * Pure batching core.
 * @param {string[]} tables
 * @param {(table: string, cursor: string) => { rows: object[], nextCursor: string }} getRows
 * @param {Record<string, string>} cursors — per-table cursor ('0' = from start)
 * @returns {{ batches: Array<{table: string, rows: object[], nextCursor: string}>, empty: boolean }}
 */
export function buildSyncBatch(tables, getRows, cursors) {
  const batches = [];
  for (const table of tables) {
    const cursor = cursors[table] ?? '0';
    const { rows, nextCursor } = getRows(table, cursor);
    if (rows.length > 0) {
      batches.push({ table, rows, nextCursor });
    }
  }
  return { batches, empty: batches.length === 0 };
}

export class SyncClient {
  /**
   * @param {object} opts
   * @param {object|Function} opts.settings — settings object, or a function returning
   *   fresh settings each cycle (recommended: getAppSettings so saves apply live)
   * @param {Function} [opts.fetchImpl] — injected fetch (tests); defaults to global fetch
   * @param {object} [opts.dbApi] — injected db functions (tests); defaults to db.js
   */
  constructor({ settings, fetchImpl, dbApi } = {}) {
    this._settings = typeof settings === 'function' ? settings : () => settings;
    this._fetch = fetchImpl || globalThis.fetch;
    this._db = dbApi || realDb;
    this._timer = null;
    this._failCount = 0;
    this._syncing = false;
    this.lastSuccessAt = null;
    this.lastError = null; // sanitized message only — never contains key material
  }

  isRunning() { return this._timer !== null; }

  /** Delay before the next cycle: normal interval, or backoff after failures. */
  nextDelayMs() {
    const s = this._settings() || {};
    const intervalMs = s.sync?.intervalMs || 30000;
    if (this._failCount === 0) return intervalMs;
    return Math.min(intervalMs, nextRetryDelay(this._failCount - 1, { baseMs: 1000, capMs: intervalMs }));
  }

  /**
   * One sync cycle. Never throws.
   * Returns { skipped } | { ok, empty } | { ok, counts } | { ok: false }.
   */
  async syncOnce() {
    if (this._syncing) return { skipped: true, reason: 'in_progress' };
    this._syncing = true;
    try {
      const s = this._settings() || {};
      const sync = s.sync || {};
      if (!sync.enabled || sync.role !== 'sender' || !sync.targetUrl || !sync.classroomKey) {
        return { skipped: true };
      }

      const cursors = {};
      for (const t of SYNC_TABLES) cursors[t] = this._db.getSyncCursor(t);

      // Opt-out + null-student filtering happens HERE, at payload build time
      const getRows = (table, cursor) =>
        this._db.getRowsSince(table, cursor, { optInStudentIdsOnly: true });
      const { batches, empty } = buildSyncBatch(SYNC_TABLES, getRows, cursors);

      if (empty) {
        this._failCount = 0;
        return { ok: true, empty: true };
      }

      const pkg = encryptPayload({ batches }, sync.classroomKey);
      const url = sync.targetUrl.replace(/\/+$/, '') + '/api/sync/ingest';

      let res;
      try {
        res = await this._fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: s.deviceId || '', package: pkg }),
        });
      } catch (err) {
        // Network failure — cursors untouched, rows re-sent next cycle
        this._failCount++;
        this.lastError = 'network_error';
        return { ok: false, reason: 'network_error' };
      }

      if (!res.ok) {
        this._failCount++;
        this.lastError = `http_${res.status}`;
        return { ok: false, reason: `http_${res.status}` };
      }

      // Confirmed 200 — NOW advance cursors
      for (const b of batches) this._db.setSyncCursor(b.table, b.nextCursor);
      this._failCount = 0;
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
      return { ok: true, counts: batches.map(b => ({ table: b.table, rows: b.rows.length })) };
    } catch (err) {
      // Belt-and-braces: nothing escapes the timer loop
      this._failCount++;
      this.lastError = 'sync_error';
      return { ok: false, reason: 'sync_error' };
    } finally {
      this._syncing = false;
    }
  }

  /** Start the periodic loop (self-rescheduling timeout so backoff can vary). */
  start() {
    if (this._timer) return;
    const loop = async () => {
      await this.syncOnce();
      if (this._timer === null) return; // stopped during the cycle
      this._timer = setTimeout(loop, this.nextDelayMs());
      if (this._timer.unref) this._timer.unref();
    };
    this._timer = setTimeout(loop, this.nextDelayMs());
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}
