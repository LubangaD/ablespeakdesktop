/**
 * AbleSpeak App Settings — persistent preferences stored in server/data/app-settings.json.
 *
 * Atomic write (tmp+rename) mirrors db.js saveToFile pattern.
 * _setSettingsPath() is exposed for test isolation only.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  autoStart: false,
  wakeWordEnabled: true,
  wakeWordPhrases: ['hey able', 'able speak'],
  setupComplete: false,
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
 */
export function saveAppSettings(patch) {
  const current = getAppSettings();
  const next = { ...current, ...patch };
  const p = getPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, p);
}
