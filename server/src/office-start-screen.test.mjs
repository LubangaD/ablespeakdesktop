import test from 'node:test';
import assert from 'node:assert/strict';
import { excelStartScreenScript, ensureExcelOpensBlankWorkbook, OFFICE_VERSIONS } from './office-start-screen.js';

const quiet = { log() {}, warn() {} };
const windows = (run) => ({ run, platform: 'win32', log: quiet });

test('the setting is written for the current user only, never machine-wide', () => {
  const script = excelStartScreenScript();
  assert.match(script, /HKCU:/);
  assert.doesNotMatch(script, /HKLM/, 'a student profile must never change machine-wide Office settings');
  assert.match(script, /DisableBootToOfficeStart/);
  assert.match(script, /DWord/);
});

test('only Office versions this user already has are touched', () => {
  const script = excelStartScreenScript();
  for (const v of OFFICE_VERSIONS) assert.ok(script.includes(`'${v}'`), `${v} missing`);
  // The Excel key is probed before anything is written, so AbleSpeak never
  // creates Office keys on a machine without Excel.
  assert.match(script, /if \(-not \(Test-Path \$excel\)\) \{ continue \}/);
});

test('a machine that already has it set is left alone', async () => {
  const res = await ensureExcelOpensBlankWorkbook(windows(async () => '16.0 already'));
  assert.equal(res.status, 'already');
});

test('an unset machine is set', async () => {
  let scriptSeen = '';
  const res = await ensureExcelOpensBlankWorkbook(windows(async (s) => { scriptSeen = s; return '16.0 set'; }));
  assert.equal(res.status, 'set');
  assert.match(scriptSeen, /DisableBootToOfficeStart/);
});

test('no Excel installed is reported, not treated as a failure', async () => {
  const res = await ensureExcelOpensBlankWorkbook(windows(async () => 'no-excel'));
  assert.equal(res.status, 'no-excel');
});

test('a locked-down machine that refuses the write does not fail the boot', async () => {
  let warned = '';
  const res = await ensureExcelOpensBlankWorkbook({
    run: async () => { throw new Error('Requested registry access is not allowed'); },
    platform: 'win32',
    log: { log() {}, warn(m) { warned = m; } },
  });
  assert.equal(res.status, 'failed');
  // The teacher is told what to tick by hand.
  assert.match(warned, /Options > General/);
});

test('nothing is run off Windows', async () => {
  let called = false;
  const res = await ensureExcelOpensBlankWorkbook({
    run: async () => { called = true; return ''; },
    platform: 'darwin',
    log: quiet,
  });
  assert.equal(res.status, 'skipped');
  assert.equal(called, false);
});
