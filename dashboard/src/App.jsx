import { BrowserRouter, Routes, Route, NavLink, Navigate, Link, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { House, Users, AudioLines, MessageSquareText, TerminalSquare, Settings, Plug, Unplug, UserRound, Moon, EyeOff, Mic } from 'lucide-react';
import Home from './pages/Home';
import Students from './pages/Students';
import SpeechProfile from './pages/SpeechProfile';
import TestConsole from './pages/TestConsole';
import DeveloperHub from './pages/DeveloperHub';
import SettingsPage from './pages/Settings';
import { StatusPill } from './components/ui';
import { api } from './lib/api';

// The dashboard's six sections (Stitch "AbleSpeak Redesign System")
const navItems = [
  { path: '/', label: 'Home', icon: House },
  { path: '/students', label: 'Students', icon: Users },
  { path: '/speech', label: 'Speech profile', icon: AudioLines },
  { path: '/test', label: 'Test console', icon: MessageSquareText },
  { path: '/developer', label: 'Developer hub', icon: TerminalSquare },
  { path: '/settings', label: 'Settings', icon: Settings },
];

// Server events that change what the top bar and Home show
const STATUS_EVENTS = ['voice_sleeping', 'voice_awake', 'voice_dismissed', 'voice_restored', 'privacy_mode', 'dictation_mode', 'extension_status'];

/**
 * Inner component that can use useNavigate() (must be inside BrowserRouter).
 * Listens for voice navigation, settings and state WebSocket messages.
 */
function AppRoutes({ onConnectionChange }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const wsRef = useRef(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Same token the useWebSocket hook reads (EXT-2) — this is a separate,
    // independent connection (voice navigation + settings sync), not routed
    // through that hook, so it needs its own copy of the same logic.
    const token = window.__ABLESPEAK_WS_TOKEN__ ||
      document.querySelector('meta[name="ablespeak-ws-token"]')?.content || '';
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${protocol}://${window.location.host}/ws/dashboard${qs}`;

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
            // Forward settings to the overlay via postMessage (caught by Settings page)
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
        // Reconnect after 3s
        setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [navigate, onConnectionChange, queryClient]);

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/students" element={<Students />} />
      <Route path="/speech" element={<SpeechProfile />} />
      <Route path="/test" element={<TestConsole />} />
      <Route path="/developer" element={<Navigate to="/developer/prompt" replace />} />
      <Route path="/developer/:tab" element={<DeveloperHub />} />
      <Route path="/settings" element={<SettingsPage />} />
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
  );
}

// Who is at this computer, and whether voice is acting on what it hears
function SessionBar() {
  const { data: active } = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 5000 });
  const student = active?.student;
  const since = active?.startedAt ? active.startedAt.slice(11, 16) : null;
  const voice = status?.voice;

  return (
    <header className="session-bar" aria-label="Session">
      <Link to="/students" className="session-chip">
        <UserRound size={20} aria-hidden="true" />
        {student
          ? <span><strong>{student.name}</strong>{since ? <> · in session since <span className="tabular">{since}</span></> : ' · in session'}</span>
          : <span>No student chosen</span>}
      </Link>
      <div className="session-bar-right">
        <span className="session-bar-label" id="voice-state-label">Voice</span>
        {!voice ? null
          : voice.sleeping ? <StatusPill tone="warning" icon={Moon} label="Asleep" aria-describedby="voice-state-label" />
          : voice.dismissed ? <StatusPill tone="neutral" icon={EyeOff} label="Hidden" aria-describedby="voice-state-label" />
          : <StatusPill tone="success" icon={Mic} label="Listening" aria-describedby="voice-state-label" />}
        {voice?.privacyMode && <StatusPill tone="info" icon={EyeOff} label="Privacy mode" />}
      </div>
    </header>
  );
}

// How long the gateway takes to answer, measured here rather than reported
function GatewayFooter({ connected }) {
  const { data: roundTrip } = useQuery({
    queryKey: ['gatewayPing'],
    queryFn: async () => {
      const started = performance.now();
      await api.getHealth();
      return Math.round(performance.now() - started);
    },
    refetchInterval: 10000,
    enabled: connected,
  });

  return (
    <div className="sidebar-footer">
      <span className="sidebar-footer-label" id="gateway-label">AbleSpeak gateway</span>
      {connected
        ? <StatusPill tone="success" icon={Plug} label="Connected" aria-describedby="gateway-label" />
        : <StatusPill tone="error" icon={Unplug} label="Offline" aria-describedby="gateway-label" />}
      {connected && roundTrip != null && (
        <span className="sidebar-footer-note">Answers in <span className="tabular">{roundTrip} ms</span></span>
      )}
    </div>
  );
}

export default function App() {
  const [connected, setConnected] = useState(false);

  return (
    <BrowserRouter>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <div className="app-layout">
        <nav className="sidebar" role="navigation" aria-label="Main navigation">
          {/* Brand header */}
          <div className="sidebar-brand">
            <img src="/ablespeak-logo.png" alt="" className="sidebar-logo" />
            <div className="sidebar-brand-text">
              <span className="sidebar-name">AbleSpeak</span>
              <span className="sidebar-tag">Tier 2 assistive</span>
            </div>
          </div>

          {/* Navigation links */}
          <div className="sidebar-nav">
            {navItems.map(({ path, label, icon: Icon }) => (
              <NavLink
                key={path}
                to={path}
                end={path === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>

          {/* Is the dashboard talking to the AbleSpeak server? */}
          <GatewayFooter connected={connected} />
        </nav>
        <main id="main-content" className="main-content" role="main">
          <SessionBar />
          <AppRoutes onConnectionChange={setConnected} />
          <footer className="app-footer">
            <span>Built with <span className="heart" role="img" aria-label="love">❤</span> for people</span>
            <span aria-hidden="true">·</span>
            <span>© 2026 Tunga Innovation Ltd</span>
          </footer>
        </main>
      </div>
      {/* Screen reader live region for voice navigation announcements */}
      <div id="a11y-announcer" className="sr-only" aria-live="assertive" aria-atomic="true" />
    </BrowserRouter>
  );
}
