/**
 * Shared-computer safety (Phase 2 Step 1 of
 * docs/AbleSpeak-Tier2-Phase2-Accounts-Plan.md, section 2b and section 4).
 *
 * Today, a school guest account links to one local profile by its Windows
 * account name, so every learner who signs into Windows as "Guest" shares the
 * same AbleSpeak profile. This module adds the two pieces needed to stop
 * that, with no cloud and no accounts yet:
 *  - a device_state flag an admin sets once, "this is a shared computer",
 *  - a name check that spots the handful of Windows account names that are
 *    never a real person (Guest, Visitor, DefaultUser0…), so even an
 *    unmarked shared PC doesn't open a profile from them.
 *
 * student-session.js uses both to decide, on every app start, whether to
 * open/create a profile from the Windows account name or leave nobody signed
 * in ("Guest — nothing is saved" mode).
 */
import { getDeviceState, setDeviceState } from './db.js';
import { userInfo } from 'os';

const SHARED_COMPUTER_KEY = 'shared_computer';

/** Has an admin marked this device as shared (a lab PC, not one person's own)? */
export function isSharedComputer() {
  return getDeviceState(SHARED_COMPUTER_KEY) === '1';
}

/** Set from Settings, behind the admin PIN. */
export function setSharedComputer(on) {
  setDeviceState(SHARED_COMPUTER_KEY, on ? '1' : '0');
}

// Windows account names that mean "whoever is sitting here right now", never
// one real person's own account — matched case-insensitively, whole name
// only, so "amina.guest" or "studentAdam" still get their own profile.
// Covers: the built-in Guest account; "Visitor"; Windows' auto-created
// first-logon names (DefaultUser0, DefaultUser100000…); the Windows Defender
// Application Guard utility account; and the generic names a kiosk/assigned
// access or multi-app kiosk setup is commonly given.
// Deliberately NOT matched: "User", "Student", "Admin", "Owner" or any other
// name a real person could have chosen for their own account — the founder's
// own laptop account is literally "User" and must keep its profile.
const GUEST_NAME_RE = /^(guest|visitor|defaultuser\d*|wdagutilityaccount|kiosk|kioskuser|assignedaccess)$/i;

/** True only for clearly-generic Windows account names, never a real name. */
export function isGuestAccountName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  return GUEST_NAME_RE.test(trimmed);
}

/** The Windows account signed in, or null (tests set ABLESPEAK_NO_WINDOWS_USER). */
export function currentWindowsAccountName() {
  if (process.env.ABLESPEAK_NO_WINDOWS_USER === '1') return null;
  try { return process.env.USERNAME || userInfo().username || null; } catch { return null; }
}
