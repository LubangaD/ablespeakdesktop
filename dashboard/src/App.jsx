import { BrowserRouter, Routes, Route, NavLink, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ADMIN_EVENT, setAdminToken } from './lib/api';
import AdminGate from './components/AdminGate';
import Avatar from './components/Avatar';
import { useSignInFirst } from './lib/signInFirst';

// Each section loads on its own, so the app opens on the page asked for.
// An update replaces those files: a window left open from before asks for one
// that is gone, and the whole window went blank ("Screen details", 17 Oct 2026).
// Then the app reloads once, which fetches the new files.
const RELOADED_FOR_UPDATE = 'ablespeak-reloaded-for-update';
function page(load) {
  return lazy(() => load().then(
    mod => {
      try { sessionStorage.removeItem(RELOADED_FOR_UPDATE); } catch {}
      return mod;
    },
    err => {
      let tried = false;
      try {
        tried = sessionStorage.getItem(RELOADED_FOR_UPDATE) === '1';
        sessionStorage.setItem(RELOADED_FOR_UPDATE, '1');
      } catch {}
      if (tried) throw err; // still missing after a reload: PageError says so
      window.location.reload();
      return new Promise(() => {});
    },
  ));
}
const Home = page(() => import('./pages/Home'));
const MyProgress = page(() => import('./pages/MyProgress'));
const Students = page(() => import('./pages/Students'));
const SpeechProfile = page(() => import('./pages/SpeechProfile'));
const TestConsole = page(() => import('./pages/TestConsole'));
const DeveloperHub = page(() => import('./pages/DeveloperHub'));
const SettingsPage = page(() => import('./pages/Settings'));
const SignIn = page(() => import('./pages/SignIn'));
const Exams = page(() => import('./pages/Exams'));
const ExamScreen = page(() => import('./pages/ExamScreen'));
const Profile = page(() => import('./pages/Profile'));

/** A page that breaks shows this, never a blank window. Going to another page clears it. */
class PageError extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error('[Dashboard] A page failed to show:', error);
  }
  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="max-w-xl mx-auto mt-24 p-6 rounded-xl bg-[#151f2e] border border-white/[0.08] text-[#dbe4f2]">
        <h1 className="text-[20px] leading-7 font-semibold">This page didn’t open</h1>
        <p className="mt-2 text-[14px] leading-5 text-[#c6b9a9]">AbleSpeak may have been updated while this window was open. Reloading usually fixes it.</p>
        <div className="mt-4 flex items-center gap-2">
          <button type="button" onClick={() => window.location.reload()} className="min-h-[40px] px-4 rounded-lg bg-[#f5a623] text-[#3d2600] font-semibold">Reload</button>
          <a href="/" className="min-h-[40px] px-4 rounded-lg inline-flex items-center border border-white/[0.12] hover:bg-[#1d2736]">Go to Home</a>
        </div>
      </div>
    );
  }
}

// The dashboard's sections, in menu order, with the tier that opens each
// (docs/AbleSpeak-Documentation.md, Part 5 "Who can open what"):
//   user   — Home, My progress, Voice & words: everyone
//   helper — Users, Exams: a helper or admin account, or the helper PIN
//   admin  — Test console, Developer Hub, Settings: an admin account,
//            an admin Windows account, or the admin PIN
// The menu icon for each path is HOME_NAV_ICONS, below.
const allSections = [
  { path: '/', label: 'Home' },
  { path: '/progress', label: 'My progress' },
  { path: '/speech', label: 'Voice & words' },
  { path: '/students', label: 'Users', admin: true, helper: true },
  { path: '/exams', label: 'Exams', admin: true, helper: true },
  { path: '/test', label: 'Test console', admin: true },
  { path: '/developer', label: 'Developer Hub', admin: true },
  { path: '/settings', label: 'Settings', admin: true },
];
const navItems = allSections.filter(s => !s.admin);
const adminItems = allSections.filter(s => s.admin);
// The three tiers, always shown so everyone can see how AbleSpeak is split up:
// helper pages open with the helper or admin PIN, admin pages with the admin PIN.
const helperItems = adminItems.filter(s => s.helper);
const adminOnlyItems = adminItems.filter(s => !s.helper);


// Server events that change what the top bar and Home show
const STATUS_EVENTS = ['voice_sleeping', 'voice_awake', 'voice_dismissed', 'voice_restored', 'privacy_mode', 'dictation_mode', 'extension_status'];

/**
 * Inner component that can use useNavigate() (must be inside BrowserRouter).
 * Listens for voice navigation, settings and state WebSocket messages.
 */
function AppRoutes({ onConnectionChange, wsRef }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Same token the useWebSocket hook reads (EXT-2) — this is a separate,
    // independent connection (voice navigation + settings sync), not routed
    // through that hook, so it needs its own copy of the same logic.
    const token = window.__ABLESPEAK_WS_TOKEN__ ||
      document.querySelector('meta[name="ablespeak-ws-token"]')?.content || '';
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${protocol}://${window.location.host}/ws/dashboard${qs}`;
    let closed = false;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => onConnectionChange(true);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // Voice navigation: "go to settings", "open the test console", etc.
          if (msg.type === 'dashboard_navigate' && msg.path) {
            navigate(msg.path);
            // Announce navigation to screen readers
            const announcer = document.getElementById('a11y-announcer');
            if (announcer) announcer.textContent = `Navigated to ${msg.page || msg.path} page`;
          }

          // Voice settings: "enable continuous listening", "set silence timeout"
          if (msg.type === 'dashboard_setting') {
            window.dispatchEvent(new CustomEvent('ablespeak-setting', {
              detail: { setting: msg.setting, value: msg.value },
            }));
          }

          // An exam: the exam screen follows it live, and opens when a sitting starts
          if (msg.type === 'exam_state' || msg.type === 'exam_mode') {
            window.dispatchEvent(new CustomEvent('ablespeak-exam', { detail: msg }));
            if (msg.type === 'exam_mode' && msg.enabled) navigate('/exam');
            if (msg.type === 'exam_mode') queryClient.invalidateQueries({ queryKey: ['liveExam'] });
          }

          // A paper was saved into the exam folder: the Exams page lists it
          if (msg.type === 'exam_folder') {
            queryClient.invalidateQueries({ queryKey: ['exams'] });
            queryClient.invalidateQueries({ queryKey: ['examFolder'] });
          }

          if (STATUS_EVENTS.includes(msg.type)) queryClient.invalidateQueries({ queryKey: ['status'] });
          if (msg.type === 'active_student') queryClient.invalidateQueries({ queryKey: ['activeStudent'] });
        } catch { /* ignore parse errors */ }
      };

      ws.onclose = () => {
        onConnectionChange(false);
        if (!closed) setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      closed = true;
      if (wsRef.current) wsRef.current.close();
    };
  }, [navigate, onConnectionChange, queryClient, wsRef]);

  return (
    <PageError resetKey={location.pathname}>
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/progress" element={<MyProgress />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/students" element={<AdminGate need="helper"><Students /></AdminGate>} />
        <Route path="/exams" element={<AdminGate need="helper"><Exams /></AdminGate>} />
        <Route path="/exam" element={<ExamScreen />} />
        <Route path="/speech" element={<SpeechProfile />} />
        <Route path="/test" element={<AdminGate><TestConsole /></AdminGate>} />
        <Route path="/developer" element={<Navigate to="/developer/tools" replace />} />
        <Route path="/developer/:tab" element={<AdminGate><DeveloperHub /></AdminGate>} />
        <Route path="/settings" element={<AdminGate><SettingsPage /></AdminGate>} />
        {/* Older addresses still work (voice commands and bookmarks) */}
        <Route path="/teacher" element={<Navigate to="/students" replace />} />
        <Route path="/chat" element={<Navigate to="/test" replace />} />
        <Route path="/prompt" element={<Navigate to="/developer/prompt" replace />} />
        <Route path="/tools" element={<Navigate to="/developer/tools" replace />} />
        <Route path="/context" element={<Navigate to="/developer/context" replace />} />
        <Route path="/logs" element={<Navigate to="/developer/logs" replace />} />
        {/* Unknown or retired addresses (such as the removed /commands page) go Home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
    </PageError>
  );
}

const pad = n => String(n).padStart(2, '0');

/** Voice states worth a word in the top bar; listening normally needs none. */
function voiceNotice(voice) {
  if (!voice) return null;
  if (voice.privacyMode) return 'Privacy mode';
  if (voice.sleeping) return 'Voice asleep';
  if (voice.dictationMode) return 'Dictating';
  if (voice.dismissed) return 'Overlay hidden';
  return null;
}

/** Two letters for the computer's round badge: LAPTOP-37SA6FKC → LA. */
/** "Amina Wanjiru" → "AW", "Derrick" → "DE" */
function initials(name) {
  const words = String(name).split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || '').slice(0, 2).toUpperCase();
}

// ── The frame ──
// One sidebar and top bar for every section, in the grey-blue palette of
// src/lib/ui.js. The screens are docs/design/ui/ (01-home.html … 10-settings.html).
// Every section in `allSections` needs an icon here, or its menu item draws blank.
const HOME_NAV_ICONS = {
  '/': 'grid_view',
  '/progress': 'insights',
  '/speech': 'tune',
  '/students': 'groups',
  '/exams': 'assignment',
  '/test': 'forum',
  '/developer': 'terminal',
  '/settings': 'settings',
};
const H_LABEL_SM = 'font-sans text-[12px] leading-4 tracking-[0.04em] font-bold';
const H_LABEL_MD = 'font-sans text-[14px] leading-[18px] tracking-[0.02em] font-semibold';
const SENSITIVITY_SHORT = { standard: 'Standard', quiet: 'Quiet Voice', noisy: 'Noisy Room' };

/**
 * Which PIN unlocked the dashboard in the last 15 minutes: 'admin' (every admin
 * page), 'helper' (the Users page only), or null.
 */
function useAdminRole() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['adminStatus'], queryFn: api.getAdminStatus, refetchInterval: 30000 });
  useEffect(() => {
    const refresh = () => queryClient.invalidateQueries({ queryKey: ['adminStatus'] });
    window.addEventListener(ADMIN_EVENT, refresh);
    return () => window.removeEventListener(ADMIN_EVENT, refresh);
  }, [queryClient]);
  return data?.unlocked ? data.role || 'admin' : null;
}

function MenuLink({ path, label, locked = false }) {
  return (
    <NavLink
      to={path}
      end={path === '/'}
      aria-label={locked ? `${label} (locked, PIN needed)` : undefined}
      className={({ isActive }) => `min-h-[44px] px-3 py-1.5 rounded-lg flex items-center gap-3 transition-colors text-[14px] leading-5 ${
        isActive
          ? 'bg-[var(--raised)] text-[var(--ink)] font-semibold shadow-[inset_3px_0_0_var(--accent)]'
          : 'text-[var(--ink-quiet)] font-medium hover:bg-[var(--sunken)] hover:text-[var(--ink)]'
      }`}
    >
      {({ isActive }) => (
        <>
          <span className={`material-symbols-outlined text-[20px] ${isActive ? 'text-[var(--accent-soft)]' : ''}`} aria-hidden="true">{HOME_NAV_ICONS[path]}</span>
          <span className="flex-1">{label}</span>
          {locked && <span className="material-symbols-outlined text-[16px] text-[var(--ink-faint)]" aria-hidden="true">lock</span>}
        </>
      )}
    </NavLink>
  );
}

/** A heading in the menu: the tier's name, and whether it is open or which PIN opens it. */
function NavGroup({ title, note }) {
  return (
    <p className="px-3 pt-4 pb-1 flex items-center justify-between text-[12px] leading-4 text-[var(--ink-faint)]">
      <span className="font-semibold uppercase tracking-[0.06em]">{title}</span>
      <span>{note}</span>
    </p>
  );
}

function HomeSidebar({ connected }) {
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 5000 });
  const { data: active } = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });
  const computer = status?.computer;
  const me = active?.student;
  const adminRole = useAdminRole();
  const { data: account } = useQuery({ queryKey: ['account'], queryFn: api.getAccountStatus, retry: false, refetchInterval: 60000 });
  const { data: adminStatus } = useQuery({ queryKey: ['adminStatus'], queryFn: api.getAdminStatus, refetchInterval: 30000 });
  const byAccount = !!adminStatus?.byAccount;
  const lock = async () => {
    await api.lockAdmin().catch(() => {});
    setAdminToken('');
  };

  return (
    <aside className="w-[250px] flex-shrink-0 h-full bg-[var(--sidebar)] z-20 flex flex-col justify-between p-4 shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
      <div className="flex flex-col gap-4 min-h-0">
        <div className="flex items-center gap-2.5 px-1.5 pt-1 pb-2">
          <img src="/ablespeak-logo.png" alt="" className="w-10 h-10 rounded-full shrink-0" draggable="false" />
          <span className="font-heading text-[18px] leading-7 font-semibold text-[var(--ink)] tracking-tight">AbleSpeak</span>
        </div>

        <nav className="flex flex-col gap-1 overflow-y-auto" aria-label="Main navigation">
          {navItems.map(({ path, label }) => <MenuLink key={path} path={path} label={label} />)}
          <NavGroup title="Helper" note={adminRole ? 'Open' : 'Helper PIN'} />
          {helperItems.map(({ path, label }) => <MenuLink key={path} path={path} label={label} locked={!adminRole} />)}
          <NavGroup title="Admin" note={adminRole === 'admin' ? 'Open' : 'Admin PIN'} />
          {adminOnlyItems.map(({ path, label }) => <MenuLink key={path} path={path} label={label} locked={adminRole !== 'admin'} />)}
        </nav>
      </div>

      <div className="flex flex-col gap-3 pt-3">
        <div className="min-h-[48px] px-3 py-1.5 rounded-lg bg-[var(--sunken)] flex items-center justify-between">
          <div className="flex items-center gap-1.5" role="status">
            {connected ? (
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#54ebaf] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#54ebaf]" />
              </span>
            ) : (
              <span className="inline-flex rounded-full h-2 w-2 bg-[var(--bad)]" aria-hidden="true" />
            )}
            <span className={`${H_LABEL_SM} text-[var(--ink)]`}>{connected ? 'Connected' : 'Offline'}</span>
          </div>
          {adminRole && !byAccount && (
            <button type="button" onClick={lock} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[var(--ink-quiet)] hover:text-[var(--ink)] hover:bg-[var(--raised)] ${H_LABEL_SM}`}>
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">lock</span>
              <span>Lock</span>
            </button>
          )}
        </div>
        {account?.signedIn ? (
          // The account: its photo and name, opening the Profile page
          <Link to="/profile" className="min-h-[44px] px-2.5 py-1.5 rounded-lg flex items-center gap-2.5 bg-[var(--sunken)] hover:bg-[var(--raised)] border border-white/[0.06] transition-colors" aria-label={`Your profile: ${account.user?.name || account.user?.email || 'your account'}`}>
            <Avatar photo={account.user?.photo} name={account.user?.name} email={account.user?.email} size={28} />
            <span className="flex flex-col min-w-0">
              <span className="truncate text-[13px] font-medium text-[var(--ink)]" data-private>{account.user?.name || 'Your profile'}</span>
              <span className="truncate text-[12px] leading-4 text-[var(--ink-quiet)]" data-private>{account.user?.email}</span>
            </span>
          </Link>
        ) : (
          <Link to="/sign-in" className="min-h-[40px] px-3 rounded-lg flex items-center gap-2 text-[13px] font-medium text-[var(--ink)] bg-[var(--sunken)] hover:bg-[var(--raised)] border border-white/[0.06] transition-colors">
            <span className="material-symbols-outlined text-[18px] text-[var(--ink-faint)]" aria-hidden="true">account_circle</span>
            <span className="truncate">Sign in to your account</span>
          </Link>
        )}
        {(me || computer) && (
          <div className="flex items-center gap-3 px-1.5 py-1.5">
            <div className="w-8 h-8 rounded-full bg-[var(--sunken)] border border-[var(--line-strong)] flex items-center justify-center shrink-0 text-[var(--ink-quiet)] text-[12px] font-[640]" aria-hidden="true">
              {me ? initials(me.name) : <span className="material-symbols-outlined text-[18px]">person</span>}
            </div>
            <div className="flex flex-col min-w-0">
              <span className={`${H_LABEL_MD} text-[var(--ink)] leading-tight truncate`} data-private>{me ? me.name : computer}</span>
              <span className="text-[12px] leading-4 text-[var(--ink-quiet)]">
                {me ? 'On this computer' : 'No user signed in'}
                {adminRole && <> · <span className="text-[var(--accent-soft)]">{byAccount ? 'Admin account' : adminRole === 'admin' ? 'Admin pages open' : 'Helper pages open'}</span></>}
              </span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// Who is in session, how AbleSpeak is listening for them, and the overlay switch
function HomeTopBar({ wsRef, connected }) {
  const queryClient = useQueryClient();
  const { data: active } = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 5000 });
  const student = active?.student;
  const { data: account } = useQuery({ queryKey: ['account'], queryFn: api.getAccountStatus, retry: false, refetchInterval: 60000 });
  const { data: profile } = useQuery({
    queryKey: ['profile', student?.id],
    queryFn: () => api.getProfile(student.id),
    enabled: !!student,
  });

  const voice = status?.voice;
  const shown = voice ? !voice.dismissed : null;
  const notice = voiceNotice(voice);
  const listening = student ? profile?.listening : null;
  // While voice is asleep the server ignores "hide"; "come back" always works.
  const blocked = !connected || shown == null || (shown && voice?.sleeping);

  // Sent exactly as if it had been said, the same way Home's overlay button does
  const toggleOverlay = () => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'chat_command', text: shown ? 'hide' : 'come back' }));
    setTimeout(() => queryClient.invalidateQueries({ queryKey: ['status'] }), 400);
  };

  return (
    <header className="h-16 shrink-0 bg-[var(--topbar)] z-10 shadow-[0_1px_8px_rgba(0,0,0,0.04)]" aria-label="Session">
      <div className="h-16 w-full px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Link to="/progress" className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-[var(--sunken)] hover:bg-[var(--raised)] transition-colors min-w-0">
            <span className="material-symbols-outlined text-[var(--ink-faint)] text-[20px]" aria-hidden="true">account_box</span>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`${H_LABEL_MD} text-[var(--ink)] truncate`}>{student ? student.name : 'No user signed in'}</span>
              <span className={`${H_LABEL_SM} text-[var(--ink-quiet)]`} aria-hidden="true">•</span>
              <span className={`text-[12px] leading-4 ${student ? 'text-[var(--ok)]' : 'text-[var(--ink-quiet)]'} whitespace-nowrap`}>{student ? 'Signed in' : 'Sign in to Windows to start'}</span>
            </div>
          </Link>
          {listening && (
            <div className={`hidden lg:flex items-center gap-1.5 px-3 py-1 rounded bg-[var(--raised)] text-[var(--ink-quiet)] whitespace-nowrap ${H_LABEL_SM}`}>
              <span className="material-symbols-outlined text-[var(--ok)] text-[16px]" aria-hidden="true">hearing</span>
              <span>{SENSITIVITY_SHORT[listening.sensitivity] || 'Standard'} · {Number(listening.pauseSeconds).toFixed(1)} s pause</span>
            </div>
          )}
          {notice && (
            <span role="status" className={`px-3 py-1 rounded bg-[var(--accent-dim)] text-[var(--accent-soft)] whitespace-nowrap ${H_LABEL_SM}`}>{notice}</span>
          )}
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={!!shown}
            aria-label="User overlay shown"
            onClick={toggleOverlay}
            disabled={blocked}
            title={shown && voice?.sleeping ? 'Voice is asleep. Say “wake up” first.' : undefined}
            className="flex items-center gap-1.5 min-h-[44px] px-3 rounded-lg bg-white/[0.035] hover:bg-white/[0.07] border border-[var(--line)] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className={`${H_LABEL_SM} text-[var(--ink-quiet)]`}>Overlay</span>
            <span className={`w-9 h-5 rounded-full p-0.5 flex items-center ${shown ? 'bg-[#1f9c89] justify-end' : 'bg-white/[0.13] justify-start'}`} aria-hidden="true">
              <span className={`w-4 h-4 rounded-full ${shown ? 'bg-[#04201c]' : 'bg-[#d8c7b3]'}`} />
            </span>
            <span className={`${H_LABEL_SM} text-[var(--ink)]`}>{shown == null ? '—' : shown ? 'Shown' : 'Hidden'}</span>
          </button>
          {account?.signedIn ? (
            <Link to="/profile" className="rounded-full focus-visible:outline-2" aria-label="Your profile" title="Your profile">
              <Avatar photo={account.user?.photo} name={account.user?.name} email={account.user?.email} size={36} />
            </Link>
          ) : (
            <Link to="/sign-in" className="w-9 h-9 rounded-full bg-[var(--sunken)] border border-[var(--line-strong)] flex items-center justify-center hover:bg-[var(--raised)]" aria-label="Sign in to your account" title="Sign in">
              <span className="material-symbols-outlined text-[var(--ink-faint)] text-[18px]" aria-hidden="true">person</span>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Until a signed-in person has chosen whether to share usage (Profile ›
 * Help improve AbleSpeak), a one-line ask. Nothing is shared until they agree.
 * "Later" hides it until AbleSpeak next opens.
 */
const CONSENT_LATER = 'ablespeak-consent-later';
function ConsentPrompt() {
  const { pathname } = useLocation();
  const { data: account } = useQuery({ queryKey: ['account'], queryFn: api.getAccountStatus, retry: false, refetchInterval: 60000 });
  const [later, setLater] = useState(() => { try { return sessionStorage.getItem(CONSENT_LATER) === '1'; } catch { return false; } });
  if (!account?.signedIn || account.user?.consentAsked || later || pathname === '/profile' || pathname === '/exam') return null;
  const dismiss = () => {
    try { sessionStorage.setItem(CONSENT_LATER, '1'); } catch {}
    setLater(true);
  };
  return (
    <div role="region" aria-label="Help improve AbleSpeak" className="mx-8 mt-6 rounded-lg bg-[var(--sunken)] border-l-2 border-[var(--accent-soft)] px-4 py-3 flex flex-wrap items-center gap-3">
      <p className="text-[14px] leading-5 text-[var(--ink)] flex-1 min-w-[260px]">
        Help improve AbleSpeak: choose whether to share how you use it — never what you say. Nothing is shared until you agree.
      </p>
      <Link to="/profile#privacy-heading" className="inline-flex items-center min-h-[44px] px-4 rounded-[10px] text-[14px] font-[600] bg-[image:var(--accent-grad)] text-[var(--on-accent)]">Choose in your profile</Link>
      <button type="button" onClick={dismiss} className="min-h-[44px] px-4 rounded-[10px] text-[14px] text-[var(--ink-quiet)] hover:text-[var(--ink)] hover:bg-[var(--raised)]">Later</button>
    </div>
  );
}

function Shell() {
  useSignInFirst(); // the sign-in page is the first screen until an account is signed in
  const [connected, setConnected] = useState(false);
  // The dashboard's own connection (voice navigation, status); Home's top bar sends through it too
  const wsRef = useRef(null);
  const { pathname } = useLocation();
  const home = pathname === '/';
  const bare = pathname === '/sign-in';

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-3 focus:rounded-xl focus:bg-[var(--accent)] focus:text-[var(--on-accent)] focus:font-bold"
      >
        Skip to main content
      </a>
      <div className="h-full flex overflow-hidden text-[var(--ink)] antialiased bg-[var(--page)]">
        {!bare && <HomeSidebar connected={connected} />}

        <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden bg-[var(--page)]">
          {!bare && <HomeTopBar wsRef={wsRef} connected={connected} />}
          <main id="main-content" className="relative flex-1 min-h-0 overflow-y-auto" tabIndex={-1}>
            {!bare && <ConsentPrompt />}
            <AppRoutes onConnectionChange={setConnected} wsRef={wsRef} />
          </main>
        </div>
      </div>
      {/* Screen reader live region for voice navigation announcements */}
      <div id="a11y-announcer" className="sr-only" aria-live="assertive" aria-atomic="true" />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
