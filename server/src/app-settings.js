/**
 * AbleSpeak App Settings — persistent preferences stored in server/data/app-settings.json.
 *
 * Atomic write (tmp+rename) mirrors db.js saveToFile pattern.
 * _setSettingsPath() is exposed for test isolation only.
 *
 * T4: added deviceId (auto-generated UUID, persisted on first write) and sync config.
 * classroomKey is stored but NEVER returned by any GET endpoint — the route layer
 * is responsible for omitting it from responses.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  autoStart: false,
  wakeWordEnabled: true,
  wakeWordPhrases: ['hey able', 'able speak'],
  setupComplete: false,
  // T4 sync settings — sync is OFF by default; classroomKey stored here, never echoed in GET responses
  deviceId: '',
  sync: { enabled: false, role: 'sender', targetUrl: '', classroomKey: '', intervalMs: 30000 },
};

let _overridePath = null;

/** Override the settings file path (test use only). */
export function _setSettingsPath(p) {
  _overridePath = p;
}

function getPath() {
  return _overridePath ?? join(__dirname, '..', 'data', 'app-settings.json');
}

/**
 * Read settings from disk, merged over defaults.
 * Returns defaults when the file is missing or unparseable.
 */
export function getAppSettings() {
  const p = getPath();
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Merge `patch` into current settings and persist atomically.
 * Unset keys retain their current (or default) values.
 * Generates deviceId on first write if not already set.
 * Sync sub-object is merged shallowly (patch.sync replaces individual keys).
 */
export function saveAppSettings(patch) {
  const current = getAppSettings();
  // Merge sync sub-object shallowly so callers can update individual sync fields
  const syncMerged = patch.sync
    ? { ...(current.sync || DEFAULTS.sync), ...patch.sync }
    : current.sync;
  const next = { ...current, ...patch, sync: syncMerged };
  // Auto-generate deviceId on first write
  if (!next.deviceId) next.deviceId = randomUUID();
  const p = getPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, p);
}
