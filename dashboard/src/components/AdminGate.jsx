import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, setAdminToken, ADMIN_EVENT } from '../lib/api';
import { TITLE, MUTED, LABEL, CARD, PRIMARY, QUIET, SMALL_QUIET, FIELD, INK } from '../lib/ui';

/**
 * Stands in front of the developer pages (Developer Hub, Settings). They hold
 * API keys, the AI prompt and raw logs, which are not for students, so the
 * teacher unlocks them with the admin PIN. The server checks the PIN too
 * (server/src/admin-pin.js); this screen only asks for it.
 *
 * need="helper" lets the lower helper PIN in too (the Users page); every other
 * admin page needs the admin PIN itself.
 */
export default function AdminGate({ need = 'admin', children }) {
  const [state, setState] = useState({ loading: true, pinSet: false, setupOpen: false, unlocked: false, role: null, byAccount: false });

  async function refresh() {
    try {
      const s = await api.getAdminStatus();
      setState({ loading: false, pinSet: s.pinSet, setupOpen: s.setupOpen, unlocked: s.unlocked, role: s.unlocked ? s.role || 'admin' : null, byAccount: !!s.byAccount });
    } catch {
      setState({ loading: false, pinSet: true, setupOpen: false, unlocked: false, role: null, byAccount: false });
    }
  }

  useEffect(() => {
    refresh();
    window.addEventListener(ADMIN_EVENT, refresh);
    return () => window.removeEventListener(ADMIN_EVENT, refresh);
  }, []);

  if (state.loading) return null;
  // An admin account (or a PIN already given) goes straight in, even with no PIN set
  const allowed = state.unlocked && (need === 'helper' || state.role === 'admin');
  if (!allowed) {
    if (!state.pinSet && !state.setupOpen) return <SetupFromTray onRetry={refresh} />;
    if (!state.unlocked) return <PinForm firstTime={!state.pinSet} />;
    return <PinForm needsAdmin />;
  }

  const lock = async () => {
    await api.lockAdmin().catch(() => {});
    setAdminToken('');
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4 px-8 py-1.5 bg-[#141c28] border-b border-white/[0.06]">
        <span className={`${MUTED} flex items-center gap-2 min-w-0`}>
          <LockIcon className="text-[16px]" />
          <span>
            {state.byAccount
              ? 'Admin account — every page is open on this Windows account. Turn it off in Settings or from the tray.'
              : state.role === 'helper'
                ? 'Opened with the helper PIN. It locks after 15 minutes.'
                : 'Admin pages — for teachers and developers. They lock after 15 minutes.'}
          </span>
        </span>
        {!state.byAccount && (
          <button type="button" onClick={lock} className={`${SMALL_QUIET} shrink-0`}>
            Lock now
          </button>
        )}
      </div>
      {children}
    </>
  );
}

function LockIcon({ className = '' }) {
  return <span className={`material-symbols-outlined text-[#c9b8a5] ${className}`} aria-hidden="true">lock</span>;
}

/**
 * No PIN yet, and setup isn't open. The first PIN can only be set after a
 * teacher chooses "Set admin PIN…" on the tray icon, which a student working
 * the dashboard by voice can't do from here.
 */
function SetupFromTray({ onRetry }) {
  return (
    <div className="min-h-full w-full bg-[#0D1627] flex items-center justify-center p-8">
      <div className={`${CARD} w-full max-w-md p-6 flex flex-col gap-4`}>
        <LockIcon className="text-[24px]" />
        <div className="flex flex-col gap-1">
          <h1 className={TITLE}>These pages are for teachers</h1>
          <p className={`${MUTED} text-[14px]`}>
            Developer Hub and Settings need an admin PIN, and none is set yet. To set one, right-click the
            AbleSpeak icon near the clock (click the small arrow <span className="font-mono text-[13px] text-[#dae3f4]">^</span> if you
            can't see it) and choose <span className="text-[#dae3f4] font-medium">Set admin PIN…</span>
          </p>
        </div>
        <button type="button" onClick={onRetry} className={`${QUIET} self-start`}>
          I've done that
        </button>
      </div>
    </div>
  );
}

function PinForm({ firstTime = false, needsAdmin = false }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!/^\d{4,8}$/.test(pin)) return setError('The PIN must be 4 to 8 digits.');
    if (firstTime && pin !== confirm) return setError('The two PINs are different.');
    setBusy(true);
    try {
      const result = firstTime ? await api.setAdminPin(pin) : await api.unlockAdmin(pin);
      setAdminToken(result.token);
    } catch (err) {
      setError(err.message);
      setPin('');
      setConfirm('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const field = `${FIELD} focus:ring-0 text-[16px]`;

  return (
    <div className="min-h-full w-full bg-[#0D1627] flex items-center justify-center p-8">
      <form onSubmit={submit} className={`${CARD} w-full max-w-sm p-6 flex flex-col gap-5`}>
        <div className="flex flex-col gap-1">
          <LockIcon className="text-[24px] mb-2" />
          <h1 className={TITLE}>{firstTime ? 'Set an admin PIN' : needsAdmin ? 'This page needs the admin PIN' : 'Admin pages are locked'}</h1>
          <p className={`${MUTED} text-[14px]`}>
            {firstTime
              ? 'Developer Hub and Settings hold the AI keys and setup. Choose a PIN of 4 to 8 digits so only teachers can open them.'
              : needsAdmin
                ? <>The helper PIN opens only the <Link to="/students" className="underline text-[#dae3f4]">Users page</Link>. Enter the admin PIN to open this one.</>
                : 'Enter the admin PIN, or the helper PIN for the Users page.'}
          </p>
        </div>

        <label className={`${LABEL} flex flex-col gap-1.5`}>
          {firstTime ? 'New PIN' : 'PIN'}
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete={firstTime ? 'new-password' : 'current-password'}
            maxLength={8}
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
            className={field}
          />
        </label>

        {firstTime && (
          <label className={`${LABEL} flex flex-col gap-1.5`}>
            Type it again
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={8}
              value={confirm}
              onChange={e => setConfirm(e.target.value.replace(/\D/g, ''))}
              className={field}
            />
          </label>
        )}

        {error && <p role="alert" className={`text-[13px] leading-5 ${INK.bad}`}>{error}</p>}

        <button type="submit" disabled={busy} className={`${PRIMARY} w-full`}>
          {firstTime ? 'Save PIN and open' : 'Unlock'}
        </button>

        {firstTime && (
          <p className={MUTED}>
            Forgot it later? Remove the <span className="font-mono text-[12px] text-[#dae3f4]">ADMIN_PIN_HASH</span> line from AbleSpeak's .env file and restart AbleSpeak.
          </p>
        )}
      </form>
    </div>
  );
}
