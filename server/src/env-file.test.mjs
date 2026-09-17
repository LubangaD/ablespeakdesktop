/**
 * Tests for the .env reader/writer behind the Settings page.
 * Run with:  node --test src/env-file.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { maskSecret, readEnvFile, removeEnvValue, setEnvValue, writeEnvFile } from './env-file.js';

const TEMPLATE = [
  '# AbleSpeak keys',
  'GEMINI_API_KEY=',
  '',
  'LLM_PROVIDER=gemini',
  '# OPENAI_API_KEY=',
  '',
].join('\n');

test('an existing line is replaced in place', () => {
  const out = setEnvValue(TEMPLATE, 'GEMINI_API_KEY', 'AIzaNEW');
  assert.equal(out.split('\n')[1], 'GEMINI_API_KEY=AIzaNEW');
  assert.equal(out.match(/GEMINI_API_KEY/g).length, 1);
});

test('a commented-out template line becomes the active line', () => {
  const out = setEnvValue(TEMPLATE, 'OPENAI_API_KEY', 'sk-test');
  assert.ok(out.includes('\nOPENAI_API_KEY=sk-test\n'));
  assert.ok(!out.includes('# OPENAI_API_KEY='));
});

test('a new setting is appended and comments survive', () => {
  const out = setEnvValue(TEMPLATE, 'GROQ_API_KEY', 'gsk_abc');
  assert.ok(out.startsWith('# AbleSpeak keys\n'));
  assert.ok(out.endsWith('GROQ_API_KEY=gsk_abc\n'));
});

test('a later duplicate is dropped so the saved value is the one that loads', () => {
  const out = setEnvValue('A_KEY=1\nOTHER=x\nA_KEY=2\n', 'A_KEY', '3');
  assert.equal(out, 'A_KEY=3\nOTHER=x\n');
});

test('Windows line endings are kept', () => {
  const out = setEnvValue('FIRST=1\r\nSECOND=2\r\n', 'SECOND', 'two');
  assert.equal(out, 'FIRST=1\r\nSECOND=two\r\n');
});

test('an empty file gets a single line', () => {
  assert.equal(setEnvValue('', 'GEMINI_API_KEY', 'k'), 'GEMINI_API_KEY=k\n');
});

test('removing a setting leaves commented lines and other settings alone', () => {
  const out = removeEnvValue('# GEMINI_API_KEY=\nGEMINI_API_KEY=old\nLLM_PROVIDER=gemini\n', 'GEMINI_API_KEY');
  assert.equal(out, '# GEMINI_API_KEY=\nLLM_PROVIDER=gemini\n');
});

test('a value containing a line break is refused (no injected settings)', () => {
  assert.throws(() => setEnvValue('', 'GEMINI_API_KEY', 'abc\nLLM_PROVIDER=evil'), /line break/);
});

test('only UPPER_CASE setting names are accepted', () => {
  assert.throws(() => setEnvValue('', 'bad name', 'x'), /Invalid setting name/);
  assert.throws(() => removeEnvValue('', 'A.*', 'x'), /Invalid setting name/);
});

test('secrets are masked to their last four characters', () => {
  assert.equal(maskSecret('sk-abcdefghijklmnop1234'), '••••1234');
  assert.equal(maskSecret('short'), '••••');
  assert.equal(maskSecret(''), '');
});

test('the file is created, written and read back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ablespeak-env-'));
  try {
    const path = join(dir, 'nested', '.env');
    assert.equal(readEnvFile(path), '');
    writeEnvFile(path, 'GEMINI_API_KEY=k\n');
    assert.equal(readFileSync(path, 'utf8'), 'GEMINI_API_KEY=k\n');
    assert.equal(readEnvFile(path), 'GEMINI_API_KEY=k\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
