/**
 * AbleSpeak account sign-in (Phase 2): email and a 6-digit code, through
 * Supabase Auth. No passwords: the person (or their helper) gives an email
 * address, Supabase emails a code, and saying or typing the code signs them in.
 *
 *   GET  /api/account/status        { configured, signedIn, user: { email } }
 *   POST /api/account/sign-in/email { email }        → a code is emailed
 *   POST /api/account/sign-in/code  { email, code }  → signed in
 *   POST /api/account/sign-in/google                 → Google opens in the browser
 *   GET  /auth/callback?code=…                       → the browser comes back; signed in
 *   POST /api/account/sign-out
 *
 * The session (tokens) stays in this process and in one file next to the
 * database, encrypted with Windows' own protection (Electron safeStorage).
 * Tokens are never sent to the dashboard, written to .env or logged.
 * Every route is for AbleSpeak's own pages only: the gateway allows any
 * origin, and a website must not be able to send codes or read who is signed in.
 *
 * Config: SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (the publishable key is
 * meant to ship inside apps; the secret key never comes near this code).
 */
import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { localOnly } from './routes/settings.js';
import { fromOwnPages } from './admin-pin.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6,10}$/;

/** A plain-language error the dashboard can show as it is. */
class AccountError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Where the session is kept: encrypted with Electron's safeStorage (Windows
 * DPAPI) when AbleSpeak runs in Electron; in memory only otherwise (tests,
 * `npm start`), so nothing readable is ever written to disk.
 */
export function createSecureStore(filePath, { loadSafeStorage = defaultSafeStorage } = {}) {
  let memory = null;
  let warned = false;

  async function safe() {
    const storage = await loadSafeStorage();
    if (storage?.isEncryptionAvailable?.()) return storage;
    if (!warned) { warned = true; console.warn('[Account] Secure storage unavailable — the sign-in lasts until AbleSpeak closes'); }
    return null;
  }

  return {
    async load() {
      const storage = await safe();
      if (!storage) return memory;
      if (!existsSync(filePath)) return null;
      try { return JSON.parse(storage.decryptString(readFileSync(filePath))); } catch { return null; }
    },
    async save(session) {
      const storage = await safe();
      if (!storage) { memory = session; return; }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, storage.encryptString(JSON.stringify(session)));
    },
    async clear() {
      memory = null;
      rmSync(filePath, { force: true });
    },
  };
}

async function defaultSafeStorage() {
  try {
    const electron = await import('electron');
    return electron.safeStorage || electron.default?.safeStorage || null;
  } catch { return null; }
}

/**
 * The AbleSpeak role on a Supabase user: app_metadata.ablespeak_role, which
 * only the project owner can set (SQL editor or the secret key), never the
 * user themselves. 'admin' opens every page; 'helper' opens the Users page.
 */
export const ROLE_FIELD = 'ablespeak_role';
const roleOf = user => {
  const role = user?.app_metadata?.[ROLE_FIELD];
  return role === 'admin' || role === 'helper' ? role : null;
};

const base64url = buf =>Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const GOOGLE_WAIT_MS = 10 * 60 * 1000;

/**
 * Supabase Auth's email-code sign-in, and Google through the browser, without
 * the client library. Google uses PKCE: a one-time secret made here and kept
 * here, so a code that reaches the callback by any other route is useless.
 */
export function createAccount({
  url, key, store,
  fetchImpl = (...args) => fetch(...args),
  callbackUrl = 'http://127.0.0.1:3001/auth/callback',
  openUrl = async () => { throw new Error('No browser to open'); },
  now = () => Date.now(),
}) {
  const base = String(url || '').replace(/\/+$/, '');
  const configured = () => !!base && !!key;
  let pendingGoogle = null; // { verifier, expires }
  let current = null; // the session as last loaded or saved, so the role can be read at once
  let skipped = false; // "Not now" on the sign-in page, until AbleSpeak next starts

  async function keep(data, fallbackEmail = null) {
    current = {
      refresh_token: data.refresh_token,
      access_token: data.access_token,
      expires_at: now() + (Number(data.expires_in) || 3600) * 1000,
      user: { id: data.user?.id || null, email: data.user?.email || fallbackEmail, role: roleOf(data.user) },
    };
    await store.save(current);
  }

  async function auth(path, body, headers = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}/auth/v1/${path}`, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AccountError('AbleSpeak couldn’t reach the sign-in service. Check the internet and try again.', 503);
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function requireConfigured() {
    if (!configured()) throw new AccountError('Sign-in isn’t set up on this computer yet.', 503);
  }

  return {
    configured,

    /** Who is signed in, and their AbleSpeak role; never includes tokens. */
    async status() {
      const session = configured() ? await store.load() : null;
      current = session;
      return {
        configured: configured(),
        signedIn: !!session,
        skipped,
        user: session ? { email: session.user?.email || null, role: session.user?.role || null } : null,
      };
    },

    /** "Not now": carry on without an account until AbleSpeak next starts. */
    skip() {
      skipped = true;
      return { skipped };
    },

    /** The signed-in account's role ('admin' | 'helper' | null), without waiting. */
    role() {
      return configured() ? current?.user?.role || null : null;
    },

    /**
     * On start: renew the session with Supabase, which also brings any role
     * change. A refused renewal (signed out elsewhere, account removed) signs
     * out here too; no internet keeps the saved session until next time.
     */
    async refresh() {
      const session = configured() ? await store.load() : null;
      current = session;
      if (!session?.refresh_token) return;
      try {
        const { ok, status, data } = await auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
        if (ok && data?.refresh_token) {
          await keep(data, session.user?.email);
          console.log(`[Account] Session renewed${current.user.role ? ` (${current.user.role})` : ''}`);
        } else if (status === 400 || status === 401) {
          current = null;
          await store.clear();
          console.log('[Account] The saved sign-in is no longer valid — signed out');
        }
      } catch {
        // No internet: keep the saved session and its role until next time
      }
    },

    /** Email a sign-in code (creating the account the first time). */
    async sendCode(email) {
      requireConfigured();
      const address = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(address)) throw new AccountError('That doesn’t look like an email address. Check it and try again.');
      const { ok, status, data } = await auth('otp', { email: address, create_user: true });
      if (ok) return { sent: true, email: address };
      if (status === 429) throw new AccountError('Too many codes were asked for. Wait a minute, then try again.', 429);
      console.warn(`[Account] Sending a code failed (${status}): ${data?.msg || data?.error_description || data?.error || 'no detail'}`);
      throw new AccountError('AbleSpeak couldn’t send the code. Try again in a minute.', 502);
    },

    /** Check the emailed code; on success keep the session. */
    async verifyCode(email, code) {
      requireConfigured();
      const address = String(email || '').trim().toLowerCase();
      const token = String(code || '').replace(/\s+/g, '');
      if (!EMAIL_RE.test(address)) throw new AccountError('That doesn’t look like an email address.');
      if (!CODE_RE.test(token)) throw new AccountError('The code is the number in the email, usually 6 digits.');
      const { ok, status, data } = await auth('verify', { type: 'email', email: address, token });
      if (!ok || !data?.refresh_token) {
        if (status === 429) throw new AccountError('Too many tries. Wait a minute, then try again.', 429);
        throw new AccountError('That code didn’t work, or it has expired. Check it, or ask for a new one.', 401);
      }
      await keep(data, address);
      console.log('[Account] Signed in');
      return { signedIn: true, user: { email: data.user?.email || address } };
    },

    /** Open Google sign-in in the person's own browser; finishGoogle completes it. */
    async startGoogle() {
      requireConfigured();
      const verifier = base64url(randomBytes(32));
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      pendingGoogle = { verifier, expires: now() + GOOGLE_WAIT_MS };
      const params = new URLSearchParams({
        provider: 'google',
        redirect_to: callbackUrl,
        code_challenge: challenge,
        code_challenge_method: 's256',
      });
      try {
        await openUrl(`${base}/auth/v1/authorize?${params}`);
      } catch {
        pendingGoogle = null;
        throw new AccountError('AbleSpeak couldn’t open the browser. Try again, or use email instead.', 500);
      }
      return { opened: true };
    },

    /** The browser came back with a code: swap it, with our secret, for a session. */
    async finishGoogle(code) {
      const pending = pendingGoogle;
      if (!pending || pending.expires <= now()) {
        pendingGoogle = null;
        throw new AccountError('This sign-in has expired or wasn’t started from AbleSpeak. Start again from AbleSpeak.', 400);
      }
      if (!code) throw new AccountError('Google didn’t finish the sign-in. Start again from AbleSpeak.', 400);
      pendingGoogle = null; // one use only
      const { ok, data } = await auth('token?grant_type=pkce', { auth_code: String(code), code_verifier: pending.verifier });
      if (!ok || !data?.refresh_token) {
        console.warn(`[Account] Google sign-in failed: ${data?.msg || data?.error_description || data?.error || 'no detail'}`);
        throw new AccountError('Google sign-in didn’t work. Start again from AbleSpeak, or use email instead.', 401);
      }
      await keep(data);
      console.log('[Account] Signed in with Google');
      return { signedIn: true, user: { email: data.user?.email || null } };
    },

    /** Forget the session here, and end it at Supabase when possible. */
    async signOut() {
      const session = await store.load();
      if (session?.access_token && configured()) {
        await auth('logout', {}, { Authorization: `Bearer ${session.access_token}` }).catch(() => {});
      }
      current = null;
      skipped = false; // back to the sign-in page first
      await store.clear();
      console.log('[Account] Signed out');
      return { signedIn: false };
    },
  };
}

/** Local routes for the dashboard; the tokens never cross them. */
export function createAccountRouter(account) {
  const router = Router();
  router.use(localOnly);
  router.use((req, res, next) => (fromOwnPages(req)
    ? next()
    : res.status(403).json({ error: 'Only AbleSpeak’s own pages can use sign-in.' })));

  const handle = fn => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(err instanceof AccountError ? err.status : 500)
        .json({ error: err instanceof AccountError ? err.message : 'Something went wrong. Try again.' });
      if (!(err instanceof AccountError)) console.error('[Account]', err.message);
    }
  };

  router.get('/status', handle(() => account.status()));
  router.post('/sign-in/email', handle(req => account.sendCode(req.body?.email)));
  router.post('/sign-in/code', handle(req => account.verifyCode(req.body?.email, req.body?.code)));
  router.post('/sign-in/google', handle(() => account.startGoogle()));
  router.post('/sign-out', handle(() => account.signOut()));
  router.post('/not-now', handle(() => account.skip()));
  return router;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CHECK_ICON = '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ALERT_ICON = '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>';

/**
 * The page the browser shows when Google sends it back here: in AbleSpeak's
 * own look (dashboard/src/lib/ui.js colours), saying what happened, who is
 * signed in, and what to do next. AbleSpeak itself comes to the front.
 */
function callbackPage(ok, { title, text, email = null, steps = [] }) {
  const accent = ok ? '#68d9c3' : '#ffb4ab';
  const list = steps.length
    ? `<ol class="steps">${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)} — AbleSpeak</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: radial-gradient(1200px 600px at 50% -10%, #17233a 0%, #0D1627 60%); color: #dae3f4;
    font: 16px/1.5 'Segoe UI', system-ui, -apple-system, sans-serif; }
  main { width: 100%; max-width: 460px; padding: 36px 36px 28px; border-radius: 20px; background: #141c28;
    border: 1px solid rgba(255,255,255,.07); box-shadow: 0 20px 60px rgba(0,0,0,.35); text-align: center; }
  .brand { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 28px; font-weight: 600; font-size: 18px; color: #dae3f4; }
  .brand img { width: 36px; height: 36px; border-radius: 50%; }
  .badge { width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    color: ${accent}; background: ${ok ? 'rgba(104,217,195,.12)' : 'rgba(255,180,171,.12)'}; box-shadow: 0 0 0 8px ${ok ? 'rgba(104,217,195,.05)' : 'rgba(255,180,171,.05)'}; }
  h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.25; font-weight: 600; letter-spacing: -.01em; }
  p { margin: 0; color: #c9b8a5; }
  .who { display: inline-block; margin: 16px 0 4px; padding: 6px 14px; border-radius: 999px; background: #18202d;
    border: 1px solid rgba(255,255,255,.06); color: #dae3f4; font-size: 14px; word-break: break-all; }
  .steps { margin: 24px 0 0; padding: 16px 20px 16px 40px; text-align: left; border-radius: 14px; background: #18202d;
    border: 1px solid rgba(255,255,255,.06); color: #dae3f4; font-size: 15px; }
  .steps li + li { margin-top: 6px; }
  .foot { margin-top: 24px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.06); font-size: 13px; color: #8b95a7; }
  @media (max-width: 480px) { main { padding: 28px 22px 22px; } h1 { font-size: 22px; } }
</style></head>
<body><main>
  <div class="brand"><img src="/ablespeak-logo.png" alt="">AbleSpeak</div>
  <div class="badge">${ok ? CHECK_ICON : ALERT_ICON}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(text)}</p>
  ${email ? `<div class="who">${escapeHtml(email)}</div>` : ''}
  ${list}
  <div class="foot">${ok ? 'You can close this tab — AbleSpeak keeps you signed in on this computer.' : 'Nothing was changed on this computer.'}</div>
</main></body></html>`;
}

const SIGNED_IN_PAGE = email => callbackPage(true, {
  title: 'You’re signed in',
  text: 'AbleSpeak is ready for you. We’ve brought it back to the front.',
  email,
});

const FAILED_PAGE = text => callbackPage(false, {
  title: 'Sign-in didn’t finish',
  text,
  steps: ['Go back to AbleSpeak.', 'Choose “Sign in with Google” again, or use your email instead.'],
});

/**
 * GET /auth/callback — where Google (through Supabase) sends the browser.
 * A normal page visit, so it can't require AbleSpeak's own origin; PKCE is the
 * protection: without the secret made by startGoogle, the code is useless.
 */
export function createAuthCallbackRouter(account, { onSignedIn = () => {} } = {}) {
  const router = Router();
  router.get('/auth/callback', localOnly, async (req, res) => {
    if (req.query.error) {
      console.warn(`[Account] Google sign-in returned an error: ${String(req.query.error).slice(0, 80)}`);
      return res.status(400).type('html').send(FAILED_PAGE('Google sign-in was cancelled, so nobody was signed in.'));
    }
    try {
      const result = await account.finishGoogle(req.query.code);
      res.type('html').send(SIGNED_IN_PAGE(result.user?.email));
      try { await onSignedIn(); } catch { /* bringing AbleSpeak forward is a nicety */ }
    } catch (err) {
      res.status(err instanceof AccountError ? err.status : 500).type('html')
        .send(FAILED_PAGE(err instanceof AccountError ? err.message : 'Something went wrong on the way back from Google.'));
    }
  });
  return router;
}
