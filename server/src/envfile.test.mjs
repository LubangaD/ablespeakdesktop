import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvFile, serializeEnvFile, upsertEnvVar } from './envfile.js';

// ── parseEnvFile ──

test('parseEnvFile: parses simple key=value pairs', () => {
  const m = parseEnvFile('FOO=bar\nBAZ=qux\n');
  assert.equal(m.get('FOO'), 'bar');
  assert.equal(m.get('BAZ'), 'qux');
});

test('parseEnvFile: ignores comment lines', () => {
  const m = parseEnvFile('# This is a comment\nKEY=value\n');
  assert.equal(m.size, 1);
  assert.equal(m.get('KEY'), 'value');
});

test('parseEnvFile: ignores blank lines', () => {
  const m = parseEnvFile('\n\nKEY=value\n\n');
  assert.equal(m.size, 1);
});

test('parseEnvFile: empty string → empty map', () => {
  assert.equal(parseEnvFile('').size, 0);
});

test('parseEnvFile: value with = sign is preserved', () => {
  const m = parseEnvFile('URL=https://example.com?foo=bar');
  assert.equal(m.get('URL'), 'https://example.com?foo=bar');
});

test('parseEnvFile: value can be empty string', () => {
  const m = parseEnvFile('EMPTY=');
  assert.equal(m.get('EMPTY'), '');
});

// ── serializeEnvFile ──

test('serializeEnvFile: produces KEY=VALUE lines', () => {
  const m = new Map([['A', '1'], ['B', '2']]);
  const text = serializeEnvFile(m);
  assert.ok(text.includes('A=1'));
  assert.ok(text.includes('B=2'));
});

test('serializeEnvFile: round-trips through parseEnvFile', () => {
  const m = new Map([['FOO', 'bar'], ['BAZ', 'qux']]);
  const text = serializeEnvFile(m);
  const m2 = parseEnvFile(text);
  assert.equal(m2.get('FOO'), 'bar');
  assert.equal(m2.get('BAZ'), 'qux');
});

// ── upsertEnvVar ──

test('upsertEnvVar: updates an existing key', () => {
  const text = 'OPENAI_API_KEY=old-key\nOTHER=value\n';
  const out = upsertEnvVar(text, 'OPENAI_API_KEY', 'new-key');
  assert.ok(out.includes('OPENAI_API_KEY=new-key'), 'new value should appear');
  assert.ok(!out.includes('old-key'), 'old value should be gone');
  assert.ok(out.includes('OTHER=value'), 'unrelated line preserved');
});

test('upsertEnvVar: appends new key when not present', () => {
  const text = 'EXISTING=yes\n';
  const out = upsertEnvVar(text, 'NEW_KEY', 'abc');
  assert.ok(out.includes('NEW_KEY=abc'));
  assert.ok(out.includes('EXISTING=yes'));
});

test('upsertEnvVar: preserves comment lines', () => {
  const text = '# My API key\nGEMINI_API_KEY=old\n';
  const out = upsertEnvVar(text, 'GEMINI_API_KEY', 'new');
  assert.ok(out.includes('# My API key'), 'comment preserved');
  assert.ok(out.includes('GEMINI_API_KEY=new'));
});

test('upsertEnvVar: preserves unrelated lines on empty initial text', () => {
  const out = upsertEnvVar('', 'KEY', 'val');
  assert.ok(out.includes('KEY=val'));
});

test('upsertEnvVar: all occurrences updated if duplicated key', () => {
  const text = 'KEY=first\nKEY=second\n';
  const out = upsertEnvVar(text, 'KEY', 'new');
  // All occurrences are updated
  const m = parseEnvFile(out);
  assert.equal(m.get('KEY'), 'new');
});

test('upsertEnvVar: value with = in it is preserved', () => {
  const text = 'A=1\n';
  const out = upsertEnvVar(text, 'URL', 'https://x.com?a=1');
  assert.ok(out.includes('URL=https://x.com?a=1'));
});

test('upsertEnvVar: CRLF line endings preserved uniformly', () => {
  const text = 'KEY=old\r\nOTHER=val\r\n';
  const out = upsertEnvVar(text, 'KEY', 'new');
  // Output should preserve CRLF uniformly
  assert.ok(out.includes('OTHER=val'), 'OTHER=val should be preserved');
  assert.ok(out.includes('KEY=new'), 'KEY should be updated to new');
  // All lines should end with \r\n
  const lines = out.split('\r\n').filter(l => l.length > 0);
  assert.equal(lines.length, 2, 'should have exactly 2 content lines');
  // Parse should correctly extract both values
  const m = parseEnvFile(out);
  assert.equal(m.get('KEY'), 'new');
  assert.equal(m.get('OTHER'), 'val');
});
