/**
 * Admin PIN — keeps the developer pages (API keys, provider, prompt, tools,
 * raw logs) away from students. The dashboard opens in teacher mode; these
 * pages need the PIN, and the server checks it, so hiding the menu entries is
 * not the only protection.
 *
 *   GET  /api/admin/status   { pinSet, unlocked, lockedForSeconds }
 *   POST /api/admin/pin      set the first PIN { pin }, or change it { currentPin, pin }
 *   POST /api/admin/unlock   { pin } → { token, expiresInSeconds }
 *   POST /api/admin/lock     forget this token
 *   POST /api/admin/helper-pin  (admin only) set { pin } or remove { pin: null }
 *                            the helper PIN
 *
 * Two tiers. The admin PIN opens everything. The optional helper PIN is for a
 * teacher or helper who only needs the Users page (people, goals, progress):
 * it unlocks with role "helper", which requireAdmin refuses and requireHelper
 * accepts. /status reports the role so the dashboard shows the right pages.
 *
 * Admin account (admin-account.js): on the admin's own computer, the Windows
 * account can be marked as an admin account; then the dashboard is admin with
 * no PIN. Only for requests from the dashboard itself: the gateway allows any
 * origin (cors()), so a website open in Chrome must never get admin this way.
 *   POST /api/admin/account  (admin only) { on } — this Windows account
 *
 * The PIN is saved to this device's .env as ADMIN_PIN_HASH (scrypt, salted),
 * never in plain text. Unlocking hands back a random token the dashboard sends
 * as the X-AbleSpeak-Admin header; tokens live in memory and expire after
 * 15 minutes. After 5 wrong PINs in a row, unlocking is refused for 5 minutes.
 *
 * Forgotten PIN: delete the ADMIN_PIN_HASH line from .env and restart.
 */

import { Router } from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { readEnvFile, removeEnvValue, setEnvValue, writeEnvFile } from './env-file.js';
import { defaultEnvPath, localOnly } from './routes/settings.js';

export const PIN_ENV = 'ADMIN_PIN_HASH';
export const HELPER_PIN_ENV = 'HELPER_PIN_HASH';
export const ADMIN_HEADER = 'x-ablespeak-admin';
const PIN_RE = /^\d{4,8}$/;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

export function hashPin(pin, salt = randomBytes(16)) {
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function pinMatches(pin, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Setting the FIRST PIN needs a teacher's action outside the dashboard: the
// tray menu's "Set admin PIN…" (electron-main.cjs) calls openPinSetup(), which
// allows it for 10 minutes. Otherwise a student could open the dashboard's
// Admin link by voice, dictate digits into the form and make themselves admin.
// Without Electron (npm start), start the server with ABLESPEAK_PIN_SETUP=1.
const SETUP_WINDOW_MS = 10 * 60 * 1000;
const gates = new Set();

export function openPinSetup(ms = SETUP_WINDOW_MS) {
  for (const gate of gates) gate.openSetup(ms);
}

/**
 * Did this request come from AbleSpeak's own pages (or a program on this
 * computer), not from some other website open in the browser? Browsers mark
 * cross-site requests with Sec-Fetch-Site and Origin; other programs send neither.
 */
export function fromOwnPages(req) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.get('origin');
  if (origin && origin !== `http://${req.get('host')}`) return false;
  return true;
}

export function createAdminGate({ envPath = defaultEnvPath, now = () => Date.now(), adminAccount = null, accountRole = null } = {}) {
  const tokens = new Map(); // token → { expires (ms), role: 'admin' | 'helper' }
  let failures = 0;
  let lockedUntil = 0;
  let setupOpenUntil = process.env.ABLESPEAK_PIN_SETUP === '1' ? Infinity : 0;
  const setupOpen = () => setupOpenUntil > now();

  const resolvePath = () => (typeof envPath === 'function' ? envPath() : envPath);
  const storedHash = () => process.env[PIN_ENV] || '';
  const pinSet = () => !!storedHash();
  const helperHash = () => process.env[HELPER_PIN_ENV] || '';
  const helperPinSet = () => !!helperHash();
  const accountIsAdmin = () => { try { return !!adminAccount?.status().on; } catch { return false; } };

  // The signed-in AbleSpeak account's role, set in Supabase (account.js)
  const signedInRole = () => { try { return accountRole?.() || null; } catch { return null; } };

  /**
   * The role a request has, and whether it comes from an account (which can't
   * be locked) rather than a PIN. From AbleSpeak's own pages only: an admin
   * Windows account or signed-in admin first, then a PIN's token, then a
   * signed-in helper. Other websites never get a role from an account.
   */
  function resolveRole(req) {
    const own = fromOwnPages(req);
    const signedIn = own ? signedInRole() : null;
    if (own && (accountIsAdmin() || signedIn === 'admin')) return { role: 'admin', byAccount: true };
    const fromToken = tokenRole(req.get(ADMIN_HEADER));
    if (fromToken) return { role: fromToken, byAccount: false };
    if (signedIn === 'helper') return { role: 'helper', byAccount: true };
    return { role: null, byAccount: false };
  }

  const requestRole = req => resolveRole(req).role;

  /** The role a token unlocks ('admin' | 'helper'), or null. */
  function tokenRole(token) {
    if (!token) return null;
    const entry = tokens.get(token);
    if (!entry) return null;
    if (entry.expires <= now()) { tokens.delete(token); return null; }
    return entry.role;
  }

  function lockedForSeconds() {
    return Math.max(0, Math.ceil((lockedUntil - now()) / 1000));
  }

  /**
   * Check a PIN, counting wrong guesses. Returns 'admin' | 'helper' | 'wrong' |
   * 'locked'; the helper PIN only counts when `allowHelper` is set.
   */
  function tryPin(pin, { allowHelper = false } = {}) {
    if (lockedForSeconds() > 0) return 'locked';
    if (pinMatches(pin, storedHash())) { failures = 0; return 'admin'; }
    if (allowHelper && helperPinSet() && pinMatches(pin, helperHash())) { failures = 0; return 'helper'; }
    failures += 1;
    if (failures >= MAX_FAILURES) { failures = 0; lockedUntil = now() + LOCKOUT_MS; }
    return 'wrong';
  }

  function savePin(pin) {
    const value = hashPin(pin);
    const path = resolvePath();
    writeEnvFile(path, setEnvValue(readEnvFile(path), PIN_ENV, value));
    process.env[PIN_ENV] = value;
    tokens.clear(); // a new PIN signs everyone out
  }

  function issueToken(role = 'admin') {
    const token = randomBytes(24).toString('hex');
    tokens.set(token, { expires: now() + TOKEN_TTL_MS, role });
    return token;
  }

  function refuse(res, helperUnlocked) {
    res.status(403).json({
      error: helperUnlocked
        ? 'That needs the admin PIN. The helper PIN only opens the Users page.'
        : pinSet()
          ? "That's a setting for your teacher. Unlock it with the admin PIN."
          : "That's a setting for your teacher. Set an admin PIN first.",
      adminRequired: true,
      pinSet: pinSet(),
    });
  }

  /** Express middleware for the developer routes: admin PIN only. */
  function requireAdmin(req, res, next) {
    const role = requestRole(req);
    if (role === 'admin') return next();
    refuse(res, role === 'helper');
  }

  /** Express middleware for the Users-page routes: admin or helper PIN. */
  function requireHelper(req, res, next) {
    if (requestRole(req)) return next();
    refuse(res, false);
  }

  const router = Router();
  router.use(localOnly);

  router.get('/status', (req, res) => {
    const { role, byAccount } = resolveRole(req);
    let account = null;
    try { account = adminAccount ? adminAccount.status() : null; } catch {}
    res.json({
      pinSet: pinSet(),
      setupOpen: !pinSet() && setupOpen(),
      unlocked: !!role,
      role,
      helperPinSet: helperPinSet(),
      // The role comes from the Windows account or the signed-in account (it can't be locked)
      byAccount,
      signedInRole: fromOwnPages(req) ? signedInRole() : null,
      adminAccount: account,
      lockedForSeconds: lockedForSeconds(),
    });
  });

  // Mark (or unmark) the Windows account AbleSpeak runs under as an admin account.
  router.post('/account', requireAdmin, (req, res) => {
    if (!adminAccount) return res.status(501).json({ error: 'Admin accounts are not available here.' });
    if (typeof req.body?.on !== 'boolean') return res.status(400).json({ error: '"on" must be true or false.' });
    try {
      res.json(adminAccount.set(req.body.on));
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  router.post('/pin', (req, res) => {
    const { pin, currentPin } = req.body || {};
    if (!PIN_RE.test(String(pin || ''))) {
      return res.status(400).json({ error: 'The PIN must be 4 to 8 digits.' });
    }
    if (pinSet()) {
      const result = tryPin(String(currentPin || ''));
      if (result === 'locked') return res.status(429).json({ error: 'Too many wrong PINs. Try again later.', lockedForSeconds: lockedForSeconds() });
      if (result !== 'admin') return res.status(403).json({ error: 'The current PIN is wrong.' });
    } else if (!setupOpen()) {
      return res.status(403).json({
        error: 'To set the first admin PIN, right-click the AbleSpeak icon near the clock and choose "Set admin PIN…".',
        setupOpen: false,
      });
    }
    savePin(String(pin));
    setupOpenUntil = 0;
    res.json({ pinSet: true, token: issueToken(), expiresInSeconds: TOKEN_TTL_MS / 1000 });
  });

  router.post('/unlock', (req, res) => {
    if (!pinSet() && !helperPinSet()) return res.status(409).json({ error: 'No admin PIN is set yet.', pinSet: false });
    const result = tryPin(String(req.body?.pin || ''), { allowHelper: true });
    if (result === 'locked') return res.status(429).json({ error: 'Too many wrong PINs. Try again later.', lockedForSeconds: lockedForSeconds() });
    if (result === 'wrong') return res.status(403).json({ error: 'That PIN is wrong.' });
    res.json({ token: issueToken(result), role: result, expiresInSeconds: TOKEN_TTL_MS / 1000 });
  });

  // The helper PIN: set or removed by an admin, and never the same as the admin PIN.
  router.post('/helper-pin', requireAdmin, (req, res) => {
    const pin = req.body?.pin;
    const path = resolvePath();
    if (pin === null || pin === '') {
      writeEnvFile(path, removeEnvValue(readEnvFile(path), HELPER_PIN_ENV));
      delete process.env[HELPER_PIN_ENV];
    } else {
      if (!PIN_RE.test(String(pin))) return res.status(400).json({ error: 'The PIN must be 4 to 8 digits.' });
      if (pinMatches(String(pin), storedHash())) return res.status(400).json({ error: 'Choose a different PIN from the admin PIN.' });
      const value = hashPin(String(pin));
      writeEnvFile(path, setEnvValue(readEnvFile(path), HELPER_PIN_ENV, value));
      process.env[HELPER_PIN_ENV] = value;
    }
    for (const [token, entry] of tokens) if (entry.role === 'helper') tokens.delete(token);
    res.json({ helperPinSet: helperPinSet() });
  });

  router.post('/lock', (req, res) => {
    tokens.delete(req.get(ADMIN_HEADER));
    res.json({ unlocked: false });
  });

  const gate = {
    router, requireAdmin, requireHelper, pinSet,
    openSetup: ms => { setupOpenUntil = now() + ms; },
  };
  gates.add(gate);
  return gate;
}

/** Remove the saved PIN (used by tests and documented as the reset path). */
export function clearPin(envPath = defaultEnvPath()) {
  writeEnvFile(envPath, removeEnvValue(readEnvFile(envPath), PIN_ENV));
  delete process.env[PIN_ENV];
}
