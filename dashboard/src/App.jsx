import { BrowserRouter, Routes, Route, NavLink, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ADMIN_EVENT, setAdminToken } from './lib/api';
import AdminGate from './components/AdminGate';
import { useSignInFirst } from './lib/signInFirst';

// Each section loads on its own, so the app opens on the page asked for
const Home = lazy(() => import('./pages/Home'));
const MyProgress = lazy(() => import('./pages/MyProgress'));
const Students = lazy(() => import('./pages/Students'));
const SpeechProfile = lazy(() => import('./pages/SpeechProfile'));
const TestConsole = lazy(() => import('./pages/TestConsole'));
const DeveloperHub = lazy(() => import('./pages/DeveloperHub'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const SignIn = lazy(() => import('./pages/SignIn'));

// The dashboard's sections. The person signed in sees their own pages; the
// `admin` ones (managing users, the test console, keys, prompts, raw logs)
// are reached through the small Admin link, need the admin PIN, and only then
// appear in the menu.
const allSections = [
  { path: '/', label: 'Home', icon: ['M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6'] },
  { path: '/progress', label: 'My progress', icon: ['M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'] },
  { path: '/speech', label: 'Voice & words', icon: ['M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z'] },
  { path: '/students', label: 'Users', admin: true, helper: true, icon: ['M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z'] },
  { path: '/test', label: 'Test console', admin: true, icon: ['M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z'] },
  { path: '/developer', label: 'Developer Hub', admin: true, icon: ['M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4'] },
  { path: '/settings', label: 'Settings', admin: true, icon: [
    'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  ] },
];
const navItems = allSections.filter(s => !s.admin);
const adminItems = allSections.filter(s => s.admin);
// The three tiers, always shown so everyone can see how AbleSpeak is split up:
// helper pages open with the helper or admin PIN, admin pages with the admin PIN.
const helperItems = adminItems.filter(s => s.helper);
const adminOnlyItems = adminItems.filter(s => !s.helper);

const SENSITIVITY_LABEL = { standard: 'Standard profile', quiet: 'Quiet voice profile', noisy: 'Noisy room profile' };

// Server events that change what the top bar and Home show
const STATUS_EVENTS = ['voice_sleeping', 'voice_awake', 'voice_dismissed', 'voice_restored', 'privacy_mode', 'dictation_mode', 'extension_status'];

/**
 * Inner component that can use useNavigate() (must be inside BrowserRouter).
 * Listens for voice navigation, settings and state WebSocket messages.
 */
function AppRoutes({ onConnectionChange, wsRef }) {
  const navigate = useNavigate();
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
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/progress" element={<MyProgress />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/students" element={<AdminGate need="helper"><Students /></AdminGate>} />
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
  );
}

const pad = n => String(n).padStart(2, '0');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 17 Sep 2026 · 10:48" */
function clockText(date) {
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The HH:MM a session started, from "YYYY-MM-DD HH:MM:SS" in local time. */
function startTime(startedAt) {
  const match = /\d{2}:\d{2}/.exec(startedAt?.split(' ')[1] || '');
  return match ? match[0] : null;
}

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

// Who is at this computer, how their microphone is set, the time, and this computer
function TopBar() {
  const [now, setNow] = useState(() => new Date());
  const { data: active } = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 5000 });
  const student = active?.student;
  const { data: profile } = useQuery({
    queryKey: ['profile', student?.id],
    queryFn: () => api.getProfile(student.id),
    enabled: !!student,
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);

  const since = startTime(active?.startedAt);
  const notice = voiceNotice(status?.voice);
  const computer = status?.computer;

  return (
    <header className="h-14 bg-[#0A1628] border-b border-[rgba(255,255,255,0.12)] flex items-center justify-between gap-4 px-8 flex-shrink-0 z-10" aria-label="Session">
      <div className="flex items-center gap-3 min-w-0">
        <Link to="/students" className="inline-flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-[#102038] border border-[rgba(255,255,255,0.14)] text-xs text-[#EDF0F5] min-w-0 overflow-hidden hover:border-[rgba(255,255,255,0.28)] transition-colors">
          {student ? (
            <>
              <span className="w-2 h-2 rounded-full bg-[#34D399] shrink-0" aria-hidden="true" />
              <span className="font-semibold text-white truncate min-w-0">{student.name}</span>
              <span className="text-[#94A3B8] shrink-0" aria-hidden="true">·</span>
              <span className="text-[#94A3B8] whitespace-nowrap shrink-0">Active Session{since ? ` (${since})` : ''}</span>
              {/* A voice notice takes the profile's room, so the name stays readable */}
              {profile?.listening?.sensitivity && !notice && (
                <>
                  <span className="text-[#94A3B8] hidden xl:inline" aria-hidden="true">·</span>
                  <span className="text-[#1D9E8A] font-medium whitespace-nowrap hidden xl:inline">{SENSITIVITY_LABEL[profile.listening.sensitivity]}</span>
                </>
              )}
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-[#64748B] shrink-0" aria-hidden="true" />
              <span className="font-semibold text-white">No user chosen</span>
              <span className="text-[#94A3B8]" aria-hidden="true">·</span>
              <span className="text-[#94A3B8] whitespace-nowrap">Choose one on Users</span>
            </>
          )}
        </Link>
        {notice && (
          <span role="status" className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#F5A623]/10 border border-[#F5A623]/30 text-[#F5A623] text-xs font-semibold whitespace-nowrap">
            {notice}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 shrink-0">
        <div className="text-xs text-[#94A3B8] font-mono tabular">{clockText(now)}</div>
        {computer && (
          <>
            <div className="h-4 w-px bg-[rgba(255,255,255,0.12)]" aria-hidden="true" />
            <div className="flex items-center gap-2" data-private title={`${computer} (Facilitator console)`}>
              <div className="w-7 h-7 rounded-full bg-[#152A4A] border border-[rgba(255,255,255,0.16)] flex items-center justify-center text-xs font-semibold text-[#F5A623]" aria-hidden="true">
                {initials(computer)}
              </div>
              <span className="text-xs text-[#EDF0F5] font-medium hidden xl:inline">{computer} (Facilitator console)</span>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

/**
 * The way into Developer Hub and Settings: small, at the foot of the sidebar,
 * and behind the admin PIN. Round-trip times, ports and versions moved there
 * too (Settings shows the version) — teachers and students don't need them.
 */
function AdminLink({ className }) {
  return (
    <NavLink to="/settings" className={className} aria-label="Admin pages (PIN needed)">
      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">lock</span>
      <span>Admin</span>
    </NavLink>
  );
}

// Is the dashboard talking to AbleSpeak?
function GatewayStatus({ connected }) {
  return (
    <div className="p-4 border-t border-[rgba(255,255,255,0.08)] bg-[#07101E]">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2" role="status">
          {connected ? (
            <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#34D399] opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#34D399]" />
            </span>
          ) : (
            <span className="inline-flex rounded-full h-2.5 w-2.5 bg-[#FB7185]" aria-hidden="true" />
          )}
          <span className="text-[#EDF0F5] font-medium text-sm">{connected ? 'Connected' : 'Offline'}</span>
        </div>
        <AdminLink className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[#94A3B8] hover:text-white hover:bg-[#102038]" />
      </div>
    </div>
  );
}

function NavIcon({ paths, active }) {
  return (
    <svg className={`w-5 h-5 flex-shrink-0${active ? ' text-[#F5A623]' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={active ? 2.2 : 2} aria-hidden="true">
      {paths.map(d => <path key={d} strokeLinecap="round" strokeLinejoin="round" d={d} />)}
    </svg>
  );
}

// The navy sidebar the Students, Speech profile, Test console, Developer hub and Settings screens draw
function Sidebar({ connected }) {
  return (
    <aside className="w-[260px] flex-shrink-0 bg-[#0A1628] border-r border-[rgba(255,255,255,0.12)] flex flex-col justify-between h-full z-20">
      <div className="flex flex-col min-h-0">
        {/* Logo and name */}
        <div className="p-6 pb-5 border-b border-[rgba(255,255,255,0.08)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#0F1F38] border border-[#F5A623] flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-[#F5A623]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </div>
            <div>
              <div className="font-heading text-lg font-bold text-white tracking-tight leading-tight">AbleSpeak</div>
              <div className="inline-flex items-center gap-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-[#1D9E8A]" aria-hidden="true" />
                <span className="text-xs font-medium text-[#94A3B8] tracking-wide">Tier 2 assistive AI</span>
              </div>
            </div>
          </div>
        </div>

        <nav className="p-4 space-y-2 overflow-y-auto" aria-label="Main navigation">
          {navItems.map(({ path, label, icon }) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) => `flex items-center gap-3.5 px-4 h-12 rounded-xl text-sm transition-colors ${
                isActive
                  ? 'font-semibold text-[#F5A623] bg-[#0F1F38] border-2 border-[#F5A623]'
                  : 'font-medium text-[#94A3B8] hover:text-white hover:bg-[#102038]'
              }`}
            >
              {({ isActive }) => (
                <>
                  <NavIcon paths={icon} active={isActive} />
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </div>

      <GatewayStatus connected={connected} />
    </aside>
  );
}

// ── Home's own frame ──
// The Home screen (docs/design/stitch/home.html) draws a charcoal sidebar and
// top bar in its own palette, unlike the other five screens.
const HOME_NAV_ICONS = { '/': 'grid_view', '/progress': 'insights', '/students': 'groups', '/speech': 'tune', '/test': 'forum', '/developer': 'terminal', '/settings': 'settings' };
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
          ? 'bg-[#222a37] text-[#dae3f4] font-semibold shadow-[inset_3px_0_0_#f5a623]'
          : 'text-[#c9b8a5] font-medium hover:bg-[#18202d] hover:text-[#dae3f4]'
      }`}
    >
      {({ isActive }) => (
        <>
          <span className={`material-symbols-outlined text-[20px] ${isActive ? 'text-[#ffc880]' : ''}`} aria-hidden="true">{HOME_NAV_ICONS[path]}</span>
          <span className="flex-1">{label}</span>
          {locked && <span className="material-symbols-outlined text-[16px] text-[#8b95a7]" aria-hidden="true">lock</span>}
        </>
      )}
    </NavLink>
  );
}

/** A heading in the menu: the tier's name, and whether it is open or which PIN opens it. */
function NavGroup({ title, note }) {
  return (
    <p className="px-3 pt-4 pb-1 flex items-center justify-between text-[12px] leading-4 text-[#8b95a7]">
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
    <aside className="w-[250px] flex-shrink-0 h-full bg-[#141c28]/95 z-20 flex flex-col justify-between p-4 shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
      <div className="flex flex-col gap-4 min-h-0">
        <div className="flex items-center gap-2.5 px-1.5 pt-1 pb-2">
          <img src="/ablespeak-logo.png" alt="" className="w-10 h-10 rounded-full shrink-0" draggable="false" />
          <span className="font-heading text-[18px] leading-7 font-semibold text-[#dae3f4] tracking-tight">AbleSpeak</span>
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
        <div className="min-h-[48px] px-3 py-1.5 rounded-lg bg-[#18202d] flex items-center justify-between">
          <div className="flex items-center gap-1.5" role="status">
            {connected ? (
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#54ebaf] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#54ebaf]" />
              </span>
            ) : (
              <span className="inline-flex rounded-full h-2 w-2 bg-[#ffb4ab]" aria-hidden="true" />
            )}
            <span className={`${H_LABEL_SM} text-[#dae3f4]`}>{connected ? 'Connected' : 'Offline'}</span>
          </div>
          {adminRole && !byAccount && (
            <button type="button" onClick={lock} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[#d7c3ae] hover:text-[#dae3f4] hover:bg-[#222a37] ${H_LABEL_SM}`}>
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">lock</span>
              <span>Lock</span>
            </button>
          )}
        </div>
        <Link to="/sign-in" className="min-h-[40px] px-3 rounded-lg flex items-center gap-2 text-[13px] font-medium text-[#dae3f4] bg-[#18202d] hover:bg-[#222a37] border border-white/[0.06] transition-colors">
          <span className="material-symbols-outlined text-[18px] text-[#ffc880]" aria-hidden="true">account_circle</span>
          <span className="truncate">{account?.signedIn ? account.user?.email || 'Your account' : 'Sign in to your account'}</span>
        </Link>
        {(me || computer) && (
          <div className="flex items-center gap-3 px-1.5 py-1.5">
            <div className="w-8 h-8 rounded-full bg-[#ffc880] flex items-center justify-center shrink-0 text-[#452b00] text-[13px] font-semibold" aria-hidden="true">
              {me ? initials(me.name) : <span className="material-symbols-outlined text-[18px]">person</span>}
            </div>
            <div className="flex flex-col min-w-0">
              <span className={`${H_LABEL_MD} text-[#dae3f4] leading-tight truncate`} data-private>{me ? me.name : computer}</span>
              <span className="text-[12px] leading-4 text-[#c9b8a5]">
                {me ? 'On this computer' : 'No user signed in'}
                {adminRole && <> · <span className="text-[#ffc880]">{byAccount ? 'Admin account' : adminRole === 'admin' ? 'Admin pages open' : 'Helper pages open'}</span></>}
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
    <header className="h-16 shrink-0 bg-[#141c28]/80 z-10 shadow-[0_1px_8px_rgba(0,0,0,0.04)]" aria-label="Session">
      <div className="h-16 w-full px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Link to="/progress" className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-[#18202d] hover:bg-[#222a37] transition-colors min-w-0">
            <span className="material-symbols-outlined text-[#ffc880] text-[20px]" aria-hidden="true">account_box</span>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`${H_LABEL_MD} text-[#dae3f4] truncate`}>{student ? student.name : 'No user signed in'}</span>
              <span className={`${H_LABEL_SM} text-[#d7c3ae]`} aria-hidden="true">•</span>
              <span className={`text-[12px] leading-4 ${student ? 'text-[#68d9c3]' : 'text-[#c9b8a5]'} whitespace-nowrap`}>{student ? 'Signed in' : 'Sign in to Windows to start'}</span>
            </div>
          </Link>
          {listening && (
            <div className={`hidden lg:flex items-center gap-1.5 px-3 py-1 rounded bg-[#222a37] text-[#d7c3ae] whitespace-nowrap ${H_LABEL_SM}`}>
              <span className="material-symbols-outlined text-[#68d9c3] text-[16px]" aria-hidden="true">hearing</span>
              <span>{SENSITIVITY_SHORT[listening.sensitivity] || 'Standard'} · {Number(listening.pauseSeconds).toFixed(1)} s pause</span>
            </div>
          )}
          {notice && (
            <span role="status" className={`px-3 py-1 rounded bg-[#f5a623]/20 text-[#ffc880] whitespace-nowrap ${H_LABEL_SM}`}>{notice}</span>
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#18202d] hover:bg-[#222a37] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className={`${H_LABEL_SM} text-[#d7c3ae]`}>Overlay</span>
            <span className={`w-9 h-5 rounded-full p-0.5 flex items-center ${shown ? 'bg-[#24a28e] justify-end' : 'bg-[#2d3543] justify-start'}`} aria-hidden="true">
              <span className={`w-4 h-4 rounded-full ${shown ? 'bg-[#00382f]' : 'bg-[#d7c3ae]'}`} />
            </span>
            <span className={`${H_LABEL_SM} text-[#dae3f4]`}>{shown == null ? '—' : shown ? 'Shown' : 'Hidden'}</span>
          </button>
          <div className="w-8 h-8 rounded-full bg-[#ffc880] flex items-center justify-center" title="Facilitator console" aria-hidden="true">
            <span className="material-symbols-outlined text-[#452b00] text-[18px]">person</span>
          </div>
        </div>
      </div>
    </header>
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
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-3 focus:rounded-xl focus:bg-[#F5A623] focus:text-[#050D19] focus:font-bold"
      >
        Skip to main content
      </a>
      <div className="h-full flex overflow-hidden text-[#EDF0F5] antialiased bg-[#0D1627]">
        {!bare && <HomeSidebar connected={connected} />}

        <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden bg-[#0D1627]">
          {!bare && <HomeTopBar wsRef={wsRef} connected={connected} />}
          <main id="main-content" className="relative flex-1 min-h-0 overflow-y-auto" tabIndex={-1}>
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
