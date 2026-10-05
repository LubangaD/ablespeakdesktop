/**
 * Admin account: a Windows account that opens every page without a PIN.
 * Run with:  node --test src/admin-account.test.mjs
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDatabase, closeDatabase, setDeviceState } from './db.js';
import { setSharedComputer } from './shared-computer.js';
import { adminAccountStatus, isAdminAccount, setAdminAccount } from './admin-account.js';

let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-admin-account-'));
  await initDatabase(join(dir, 'ablespeak.db'));
});

after(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setSharedComputer(false);
  setDeviceState('admin_windows_user:derrick', null);
  setDeviceState('admin_windows_user:amina.k', null);
});

test('an account is not an admin account until it is turned on', () => {
  assert.equal(isAdminAccount('derrick'), false);
  const status = setAdminAccount(true, 'derrick');
  assert.equal(status.on, true);
  assert.equal(isAdminAccount('derrick'), true);
  assert.equal(isAdminAccount('Derrick'), true, 'Windows account names ignore case');
  assert.equal(isAdminAccount('amina.k'), false, 'other accounts are not affected');
});

test('it can be turned off again', () => {
  setAdminAccount(true, 'derrick');
  assert.equal(setAdminAccount(false, 'derrick').on, false);
  assert.equal(isAdminAccount('derrick'), false);
});

test('a shared computer never opens admin pages from the Windows account', () => {
  setAdminAccount(true, 'derrick');
  setSharedComputer(true);
  const status = adminAccountStatus('derrick');
  assert.equal(status.on, false);
  assert.equal(status.blocked, 'shared');
  assert.throws(() => setAdminAccount(true, 'amina.k'), /shared/);
  setSharedComputer(false);
  assert.equal(isAdminAccount('derrick'), true, 'the choice comes back when the computer is personal again');
});

test('a guest-type account can never be an admin account', () => {
  assert.throws(() => setAdminAccount(true, 'Guest'), /guest/);
  assert.equal(adminAccountStatus('Guest').blocked, 'guest');
});

test('with no Windows account there is nothing to mark', () => {
  const status = adminAccountStatus(null);
  assert.equal(status.on, false);
  assert.equal(status.blocked, 'no_account');
});
