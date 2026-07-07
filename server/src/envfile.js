/**
 * Pure env-file utilities — no file I/O, fully testable.
 *
 * Used by POST /api/setup/keys to merge API keys into server/.env
 * atomically (tmp+rename, caller's responsibility).
 *
 * SECURITY: these functions never log or return key values.
 */

/**
 * Parse KEY=VALUE lines from env file text.
 * Comments (# …) and blank lines are skipped.
 * Returns a Map so insertion order is preserved.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvFile(text) {
  const map = new Map();
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1); // preserve value verbatim (may contain '=')
    map.set(key, value);
  }
  return map;
}

/**
 * Serialize a Map<string, string> to env file text.
 * One KEY=VALUE per line, trailing newline.
 *
 * @param {Map<string, string>} map
 * @returns {string}
 */
export function serializeEnvFile(map) {
  const lines = [];
  for (const [key, value] of map) {
    lines.push(`${key}=${value}`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Pure: return updated env file text with `key=value` upserted.
 * Preserves comments, blank lines, and all unrelated keys.
 * If the key already exists (any occurrence), every occurrence is updated.
 * If missing, appends KEY=VALUE at the end.
 *
 * @param {string} text   - raw .env file contents
 * @param {string} key    - env var name (no spaces)
 * @param {string} value  - new value (may contain '=')
 * @returns {string}      - updated file contents
 */
export function upsertEnvVar(text, key, value) {
  const lines = String(text || '').split('\n');
  let found = false;

  const updated = lines.map(line => {
    const trimmed = line.trim();
    // Preserve comments and blank lines verbatim
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) return line;
    const lineKey = trimmed.slice(0, eqIdx).trim();
    if (lineKey === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    // Append — if trailing empty line exists, insert before it for clean formatting
    if (updated.length > 0 && updated[updated.length - 1].trim() === '') {
      updated.splice(updated.length - 1, 0, `${key}=${value}`);
    } else {
      updated.push(`${key}=${value}`);
    }
  }

  return updated.join('\n');
}
