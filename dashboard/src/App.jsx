import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { LayoutDashboard, MessageCircle, Wrench, GitBranch, ScrollText, Settings, FileText, GraduationCap, Plug, Unplug } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Tools from './pages/Tools';
import Context from './pages/Context';
import Logs from './pages/Logs';
import SettingsPage from './pages/Settings';
import Chat from './pages/Chat';
import Prompt from './pages/Prompt';
import Teacher from './pages/Teacher';
import { StatusPill } from './components/ui';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, ariaLabel: 'Navigate to Dashboard' },
  { path: '/prompt', label: 'Prompt', icon: FileText, ariaLabel: 'Navigate to Prompt Editor' },
  { path: '/chat', label: 'Chat', icon: MessageCircle, ariaLabel: 'Navigate to Voice Chat' },
  { path: '/tools', label: 'Tools', icon: Wrench, ariaLabel: 'Navigate to Tools' },
  { path: '/context', label: 'Context', icon: GitBranch, ariaLabel: 'Navigate to Context' },
  { path: '/teacher', label: 'Teacher', icon: GraduationCap, ariaLabel: 'Navigate to Teacher Analytics' },
  { path: '/logs', label: 'Logs', icon: ScrollText, ariaLabel: 'Navigate to Logs' },
  { path: '/settings', label: 'Settings', icon: Settings, ariaLabel: 'Navigate to Settings' },
];

/**
 * Inner component that can use useNavigate() (must be inside BrowserRouter).
 * Listens for voice navigation and settings WebSocket messages.
 */
function AppRoutes({ onConnectionChange }) {
  const navigate = useNavigate();
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

          // Voice navigation: "go to settings", "open chat", etc.
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
  }, [navigate, onConnectionChange]);

  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/prompt" element={<Prompt />} />
      <Route path="/chat" element={<Chat />} />
      <Route path="/teacher" element={<Teacher />} />
      <Route path="/tools" element={<Tools />} />
      <Route path="/context" element={<Context />} />
      <Route path="/logs" element={<Logs />} />
      <Route path="/settings" element={<SettingsPage />} />
      {/* Unknown or retired addresses (such as the removed /commands page) go to the Dashboard */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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
            <img src="/ablespeak-logo.png" alt="AbleSpeak" className="sidebar-logo" />
          </div>

          {/* Navigation links */}
          <div className="sidebar-nav">
            {navItems.map(({ path, label, icon: Icon, ariaLabel }) => (
              <NavLink
                key={path}
                to={path}
                end={path === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                aria-label={ariaLabel}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>

          {/* Is the dashboard talking to the AbleSpeak server? */}
          <div className="sidebar-footer">
            <span className="sidebar-footer-label" id="gateway-label">AbleSpeak gateway</span>
            {connected
              ? <StatusPill tone="success" icon={Plug} label="Connected" aria-describedby="gateway-label" />
              : <StatusPill tone="error" icon={Unplug} label="Offline" aria-describedby="gateway-label" />}
          </div>
        </nav>
        <main id="main-content" className="main-content" role="main">
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
