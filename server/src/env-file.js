/**
 * Read and update this device's .env file — where AbleSpeak keeps API keys
 * and the chosen AI provider.
 *
 * Edits are line-based so everything else in the file survives: comments,
 * other keys, blank lines, and the file's own line endings. A commented-out
 * template line (`# OPENAI_API_KEY=`) is replaced in place rather than
 * duplicated at the bottom. Writes go to a temp file first and are renamed
 * over the original, so a crash mid-save never leaves a half-written file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function assertName(name) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid setting name: ${name}`);
}

function activeLine(name) {
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
}

function commentedLine(name) {
  return new RegExp(`^\\s*#\\s*${name}\\s*=`);
}

function split(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol };
}

function join({ lines, eol }) {
  return lines.length ? lines.join(eol) + eol : '';
}

/** Set NAME=value, replacing an existing or commented-out line, else appending. */
export function setEnvValue(text, name, value) {
  assertName(name);
  if (/[\r\n]/.test(String(value))) throw new Error(`${name} cannot contain a line break`);
  const doc = split(text || '');
  const active = activeLine(name);
  let index = doc.lines.findIndex(line => active.test(line));
  if (index === -1) index = doc.lines.findIndex(line => commentedLine(name).test(line));

  const line = `${name}=${value}`;
  if (index === -1) {
    doc.lines.push(line);
  } else {
    doc.lines[index] = line;
    // A later duplicate would win when the file is loaded, so drop it.
    doc.lines = doc.lines.filter((l, i) => i <= index || !active.test(l));
  }
  return join(doc);
}

/** Remove every active NAME= line. Commented-out lines are left alone. */
export function removeEnvValue(text, name) {
  assertName(name);
  const doc = split(text || '');
  const active = activeLine(name);
  doc.lines = doc.lines.filter(line => !active.test(line));
  return join(doc);
}

export function readEnvFile(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function writeEnvFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Show only the last four characters of a secret, and nothing of a short one. */
export function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  return text.length >= 12 ? `••••${text.slice(-4)}` : '••••';
}
