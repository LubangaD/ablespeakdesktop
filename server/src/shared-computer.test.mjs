/**
 * Tests for shared-computer safety (Phase 2 Step 1): the "shared computer"
 * flag, the guest-name check, and startDeviceSession()'s guest mode.
 * Run with: node --test src/shared-computer.test.mjs
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDatabase, closeDatabase, getStudents, addStudent, setDeviceState, getDeviceState } from './db.js';
import { isSharedComputer, setSharedComputer, isGuestAccountName } from './shared-computer.js';
import { startDeviceSession, endDeviceSession, setActiveStudent, getActiveStudent } from './student-session.js';

let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-shared-pc-'));
  await initDatabase(join(dir, 'ablespeak.db'));
});

after(() => {
  endDeviceSession();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setSharedComputer(false);
  setDeviceState('active_student_id', null);
  endDeviceSession();
});

// ── isGuestAccountName ──

test('generic Windows names are recognised as guest accounts, case-insensitively', () => {
  for (const name of ['guest', 'Guest', 'GUEST', 'Visitor', 'visitor', 'DefaultUser0', 'defaultuser100000', 'WDAGUtilityAccount', 'Kiosk', 'KioskUser']) {
    assert.equal(isGuestAccountName(name), true, name);
  }
});

test('real account names, even generic-sounding ones, are never treated as guests', () => {
  for (const name of ['User', 'Student', 'Admin', 'Owner', 'Derrick', 'amina.k', 'studentAdam', 'amina.guest', '']) {
    assert.equal(isGuestAccountName(name), false, name);
  }
});

test('blank or missing names are not guest accounts (they just sign nobody in anyway)', () => {
  assert.equal(isGuestAccountName(null), false);
  assert.equal(isGuestAccountName(undefined), false);
  assert.equal(isGuestAccountName('   '), false);
});

// ── isSharedComputer / setSharedComputer ──

test('the shared-computer flag defaults to off and round-trips through device_state', () => {
  assert.equal(isSharedComputer(), false);
  setSharedComputer(true);
  assert.equal(isSharedComputer(), true);
  assert.equal(getDeviceState('shared_computer'), '1');
  setSharedComputer(false);
  assert.equal(isSharedComputer(), false);
  assert.equal(getDeviceState('shared_computer'), '0');
});

// ── Guest mode in startDeviceSession ──

test('on a shared computer, a normal-looking Windows name does NOT get a profile', () => {
  setSharedComputer(true);
  const result = startDeviceSession({ windowsAccount: 'amina.k' });
  assert.equal(result.student, null, 'nobody is signed in on a shared PC');
  assert.equal(getStudents().filter(s => s.name === 'Amina K').length, 0, 'no profile was created from the Windows name');
});

test('on a non-shared computer, a guest-looking Windows name does NOT get a profile', () => {
  const result = startDeviceSession({ windowsAccount: 'Guest' });
  assert.equal(result.student, null);
  assert.equal(getStudents().filter(s => s.name === 'Guest').length, 0);
});

test('a shared computer clears an earlier saved choice at the next start, so the next learner never opens the previous one\'s profile', () => {
  setSharedComputer(true);
  startDeviceSession(); // this run begins with nobody signed in
  const amina = addStudent({ name: 'Shared PC Amina' });
  setActiveStudent(amina.id); // an admin chooses Amina partway through this run
  assert.equal(getActiveStudent().student?.id, amina.id, 'still signed in for the rest of this run');
  endDeviceSession();

  // Next start (the next learner sits down) — Amina's choice must not carry over.
  const next = startDeviceSession({ windowsAccount: 'brian' });
  assert.equal(next.student, null, 'nobody is signed in until the next learner is chosen or signs in');
  assert.equal(getDeviceState('active_student_id'), null);
});

test('on a shared computer an admin can still choose someone for this run', () => {
  setSharedComputer(true);
  startDeviceSession({ windowsAccount: 'guest' }); // nobody signed in
  const brian = addStudent({ name: 'Shared PC Brian' });
  const chosen = setActiveStudent(brian.id);
  assert.equal(chosen.student?.id, brian.id, 'an admin\'s explicit choice this run still works');
});

test('a non-shared computer with a normal name is unaffected (existing behaviour)', () => {
  const result = startDeviceSession({ windowsAccount: 'amina.k' });
  assert.equal(result.student?.name, 'Amina K');
  endDeviceSession();
  // An earlier saved choice still carries over when the computer is NOT shared.
  const again = startDeviceSession();
  assert.equal(again.student?.name, 'Amina K', 'a saved choice still wins on a non-shared computer');
});
