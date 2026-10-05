/**
 * Admin account: a Windows account whose user gets every page without a PIN.
 *
 * The admin PIN (admin-pin.js) is for computers where the admin is a visitor.
 * On the admin's own computer, typing it every 15 minutes is in the way, so
 * the Windows account AbleSpeak runs under can be marked as an admin account,
 * from the tray or from Settings. Never on a shared computer or a guest-type
 * account, where several people use the same Windows sign-in.
 *
 * Stored in device_state as admin_windows_user:<account, lower-case> = '1'.
 */
import { getDeviceState, setDeviceState } from './db.js';
import { isSharedComputer, isGuestAccountName, currentWindowsAccountName } from './shared-computer.js';

const keyFor = account => `admin_windows_user:${String(account).toLowerCase()}`;

const BLOCKED_REASON = {
  no_account: "AbleSpeak can't tell which Windows account is signed in.",
  shared: 'This computer is marked as shared, so no Windows account can open the admin pages without a PIN.',
  guest: 'This looks like a guest account that several people use, so it can’t open the admin pages without a PIN.',
};

/**
 * → { account, on, blocked, reason }. `on` is what applies now: a saved choice
 * is ignored while the computer is shared or the account is a guest one.
 */
export function adminAccountStatus(account = currentWindowsAccountName()) {
  const blocked = !account ? 'no_account'
    : isSharedComputer() ? 'shared'
    : isGuestAccountName(account) ? 'guest'
    : null;
  const saved = !!account && getDeviceState(keyFor(account)) === '1';
  return { account: account || null, on: saved && !blocked, blocked, reason: blocked ? BLOCKED_REASON[blocked] : null };
}

/** Is AbleSpeak running under an admin account right now? */
export function isAdminAccount(account = currentWindowsAccountName()) {
  return adminAccountStatus(account).on;
}

/** Turn the admin account on or off for this Windows account. */
export function setAdminAccount(on, account = currentWindowsAccountName()) {
  const status = adminAccountStatus(account);
  if (on && status.blocked) throw new Error(status.reason);
  if (!status.account) return status;
  setDeviceState(keyFor(status.account), on ? '1' : '0');
  return adminAccountStatus(account);
}
