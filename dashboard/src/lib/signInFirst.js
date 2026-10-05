import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * Sign in comes first: until an account is signed in, every launch of
 * AbleSpeak opens on the sign-in page, and other pages lead back to it.
 * "Not now" skips it until the app is next started (sessionStorage is cleared
 * when the window closes). Sign-in needs the internet, so it must never be
 * the only way into someone's own computer.
 */
export const SIGN_IN_SKIP_KEY = 'ablespeak_sign_in_skipped';

export function skipSignInForNow() {
  try { sessionStorage.setItem(SIGN_IN_SKIP_KEY, '1'); } catch { /* storage blocked: Home still opens */ }
  // The server hears it too, so the voice bar starts (electron-main.cjs waits for this or a sign-in)
  api.skipSignIn().catch(() => {});
}

function skippedSignIn() {
  try { return sessionStorage.getItem(SIGN_IN_SKIP_KEY) === '1'; } catch { return false; }
}

export function useSignInFirst() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: account } = useQuery({ queryKey: ['account'], queryFn: api.getAccountStatus, retry: false });
  useEffect(() => {
    if (!account?.configured || account.signedIn || pathname === '/sign-in') return;
    if (!skippedSignIn()) navigate('/sign-in', { replace: true });
  }, [account, pathname, navigate]);
}
