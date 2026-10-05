import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { skipSignInForNow } from '../lib/signInFirst';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { MUTED, BODY, QUIET, PRIMARY, FIELD, LABEL, INK } from '../lib/ui';

/**
 * Sign in to an AbleSpeak account (Phase 2, docs/AbleSpeak-Tier2-Phase2-Accounts-Plan.md).
 *
 * Email and a code, no password: the person (or their helper) gives an email
 * address, a 6-digit code arrives by email, and saying or typing it signs them
 * in. The session stays with AbleSpeak on this computer (server/src/account.js);
 * this page never sees it. Nobody has to sign in: "Not now" keeps everything
 * on this computer, as before.
 *
 * Steps: email → code → signed in.
 */
export default function SignIn() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [googleWaiting, setGoogleWaiting] = useState(false);
  // While Google is open in the browser, check every 2 seconds whether it has finished
  const { data: account, isLoading } = useQuery({
    queryKey: ['account'], queryFn: api.getAccountStatus, retry: false,
    refetchInterval: googleWaiting ? 2000 : false,
  });
  const [step, setStep] = useState('email'); // email | code
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { tone, text }
  const [resendIn, setResendIn] = useState(0);
  const fieldRef = useRef(null);

  // Put the cursor where the next thing goes
  useEffect(() => { fieldRef.current?.focus(); }, [step, account?.signedIn]);

  // "Send a new code" waits a minute, as Supabase does
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = setTimeout(() => setResendIn(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function sendCode(e) {
    e?.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.sendSignInCode(email);
      setEmail(result.email);
      setStep('code');
      setCode('');
      setResendIn(60);
      setMessage({ tone: 'ok', text: `We sent a code to ${result.email}. It can take a minute to arrive.` });
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function checkCode(e) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.verifySignInCode(email, code);
      await queryClient.invalidateQueries({ queryKey: ['account'] });
      setStep('email');
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  // Skip sign-in until AbleSpeak is next started
  function notNow() {
    skipSignInForNow();
    navigate('/');
  }

  // Google signed in through the browser: stop waiting
  useEffect(() => {
    if (account?.signedIn) setGoogleWaiting(false);
    // An account can carry the admin or helper role: refresh what the menu opens
    queryClient.invalidateQueries({ queryKey: ['adminStatus'] });
  }, [account?.signedIn, queryClient]);

  async function signInWithGoogle() {
    setBusy(true);
    setMessage(null);
    try {
      await api.startGoogleSignIn();
      setGoogleWaiting(true);
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await api.signOut();
      await queryClient.invalidateQueries({ queryKey: ['account'] });
      setMessage({ tone: 'ok', text: 'You’re signed out. Your settings are still on this computer.' });
    } catch (err) {
      setMessage({ tone: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const field = `${FIELD} min-h-[52px] text-[18px] focus:ring-0`;

  return (
    <div className="min-h-full w-full bg-[#0D1627] text-[#dae3f4] flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-[920px] grid grid-cols-1 lg:grid-cols-[1fr_440px] gap-10 lg:gap-16 items-center">

        {/* Why sign in */}
        <section aria-labelledby="why-heading" className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <img src="/ablespeak-logo.png" alt="" className="w-12 h-12 rounded-full" draggable="false" />
            <span className="font-heading text-[22px] leading-7 font-semibold tracking-tight">AbleSpeak</span>
          </div>
          <h2 id="why-heading" className="font-heading text-[32px] leading-10 font-semibold tracking-[-0.01em] max-w-[420px]">
            Your computer, by voice — on any computer.
          </h2>
          <ul className="flex flex-col gap-4 max-w-[440px]">
            <Benefit icon="record_voice_over" title="Your words and shortcuts go with you">
              Names, places and phrases you taught AbleSpeak work on every computer you sign in to.
            </Benefit>
            <Benefit icon="insights" title="Your progress is kept safe">
              See what you’ve done and what you’re getting better at, even after a computer is reset.
            </Benefit>
            <Benefit icon="wifi_off" title="Still works without internet">
              Once you’ve signed in, your settings stay on this computer too.
            </Benefit>
          </ul>
        </section>

        {/* Sign in */}
        <section aria-labelledby="sign-in-heading" className="bg-[#141c28] rounded-2xl border border-white/[0.06] p-8 flex flex-col gap-6 shadow-[0_8px_32px_rgba(0,0,0,0.25)]">
          {isLoading ? null : account?.signedIn ? (
            <SignedIn email={account.user?.email} onSignOut={signOut} busy={busy} buttonRef={fieldRef} />
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <h1 id="sign-in-heading" className="font-heading text-[26px] leading-8 font-semibold tracking-[-0.01em]">
                  {step === 'code' ? 'Enter your code' : 'Sign in'}
                </h1>
                <p className={`${BODY} text-[#c9b8a5]`}>
                  {step === 'code'
                    ? 'Look for an email from AbleSpeak, then say or type the number in it.'
                    : 'No password. We email you a short code, and you say or type it here.'}
                </p>
              </div>

              {account && !account.configured && (
                <p className={`text-[14px] leading-5 ${INK.warn}`}>Sign-in isn’t set up on this computer yet. You can keep using AbleSpeak here.</p>
              )}

              {googleWaiting ? (
                <Waiting onCancel={() => setGoogleWaiting(false)} />
              ) : step === 'email' ? (
                <>
                <form onSubmit={sendCode} className="flex flex-col gap-4">
                  <label className={`${LABEL} text-[14px] flex flex-col gap-2`}>
                    Your email
                    <input
                      ref={fieldRef}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      spellCheck="false"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      className={field}
                      required
                    />
                  </label>
                  <button type="submit" disabled={busy || !email.trim() || account?.configured === false} className={`${PRIMARY} w-full min-h-[52px] text-[16px]`}>
                    {busy ? 'Sending…' : 'Email me a code'}
                  </button>
                </form>

                <div className="flex items-center gap-3" aria-hidden="true">
                  <span className="flex-1 h-px bg-white/[0.08]" />
                  <span className={MUTED}>or</span>
                  <span className="flex-1 h-px bg-white/[0.08]" />
                </div>

                <button
                  type="button"
                  onClick={signInWithGoogle}
                  disabled={busy || account?.configured === false}
                  className="w-full min-h-[52px] rounded-xl bg-white hover:bg-[#f2f2f2] text-[#1f1f1f] border border-[#747775] inline-flex items-center justify-center gap-3 px-5 text-[16px] font-medium transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-[#f5a623]/60 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <GoogleMark />
                  <span>Sign in with Google</span>
                </button>
                </>
              ) : (
                <form onSubmit={checkCode} className="flex flex-col gap-4">
                  <label className={`${LABEL} text-[14px] flex flex-col gap-2`}>
                    Code from the email
                    <input
                      ref={fieldRef}
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={12}
                      value={code}
                      onChange={e => setCode(e.target.value.replace(/[^\d ]/g, ''))}
                      placeholder="123456"
                      className={`${field} tracking-[0.3em] font-semibold`}
                      required
                    />
                  </label>
                  <button type="submit" disabled={busy || code.replace(/\s/g, '').length < 6} className={`${PRIMARY} w-full min-h-[52px] text-[16px]`}>
                    {busy ? 'Checking…' : 'Sign in'}
                  </button>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button type="button" onClick={sendCode} disabled={busy || resendIn > 0} className="min-h-[44px] px-2 rounded-lg text-[14px] font-medium text-[#ffc880] hover:bg-[#18202d] disabled:text-[#8b95a7] disabled:cursor-not-allowed">
                      {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
                    </button>
                    <button type="button" onClick={() => { setStep('email'); setMessage(null); }} className="min-h-[44px] px-2 rounded-lg text-[14px] font-medium text-[#dae3f4] hover:bg-[#18202d]">
                      Use a different email
                    </button>
                  </div>
                </form>
              )}

              <div className="rounded-xl bg-[#18202d] border border-white/[0.06] p-4 flex gap-3">
                <span className="material-symbols-outlined text-[22px] text-[#ffc880] shrink-0" aria-hidden="true">diversity_3</span>
                <p className={`${MUTED} text-[14px]`}>
                  <span className="text-[#dae3f4] font-medium">Setting this up for someone?</span>{' '}
                  Use their own email, and stay with them while the code arrives.
                </p>
              </div>
            </>
          )}

          <div role="status" aria-live="polite">
            {message && <p className={`text-[14px] leading-5 ${INK[message.tone]}`}>{message.text}</p>}
          </div>

          <div className="flex flex-col gap-3 pt-1 border-t border-white/[0.06]">
            {account?.signedIn ? (
              <Link to="/" className={`${PRIMARY} w-full mt-4`}>Continue to AbleSpeak</Link>
            ) : (
              <button type="button" onClick={notNow} className={`${QUIET} w-full mt-4`}>
                Not now — keep using this computer only
              </button>
            )}
            <p className={`${MUTED} text-center`}>
              Your account keeps your settings, words, shortcuts and daily progress, stored in the EU.
              Never your recordings, what you said, or pictures of your screen.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function SignedIn({ email, onSignOut, busy, buttonRef }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="w-12 h-12 rounded-full bg-[#68d9c3]/15 flex items-center justify-center" aria-hidden="true">
          <span className="material-symbols-outlined text-[26px] text-[#68d9c3]">check</span>
        </span>
        <h1 id="sign-in-heading" className="font-heading text-[26px] leading-8 font-semibold tracking-[-0.01em]">You’re signed in</h1>
        <p className={`${BODY} text-[#c9b8a5] break-all`}>{email}</p>
      </div>
      <p className={`${MUTED} text-[14px]`}>
        AbleSpeak stays signed in on this computer. Your settings will start to follow you once syncing is switched on.
      </p>
      <button ref={buttonRef} type="button" onClick={onSignOut} disabled={busy} className={`${QUIET} w-full`}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}

/** Google is open in the browser; AbleSpeak notices by itself when it has finished. */
function Waiting({ onCancel }) {
  return (
    <div className="rounded-xl bg-[#18202d] border border-white/[0.08] p-5 flex flex-col items-center gap-4 text-center">
      <span className="w-8 h-8 rounded-full border-[3px] border-[#f5a623]/30 border-t-[#f5a623] animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="text-[16px] leading-6 font-semibold">Finish signing in in your browser</p>
        <p className={`${MUTED} text-[14px]`}>Google opened in your browser. When it says you’re signed in, come back here.</p>
      </div>
      <button type="button" onClick={onCancel} className={QUIET}>Cancel</button>
    </div>
  );
}

/** Google's "G" mark, as Google's sign-in button guidelines require. */
function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function Benefit({ icon, title, children }) {
  return (
    <li className="flex gap-4">
      <span className="w-10 h-10 rounded-xl bg-[#18202d] border border-white/[0.06] flex items-center justify-center shrink-0" aria-hidden="true">
        <span className="material-symbols-outlined text-[22px] text-[#ffc880]">{icon}</span>
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[16px] leading-6 font-semibold text-[#dae3f4]">{title}</span>
        <span className={`${MUTED} text-[14px]`}>{children}</span>
      </span>
    </li>
  );
}
