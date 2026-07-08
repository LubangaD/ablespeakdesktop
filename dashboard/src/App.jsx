import { BrowserRouter, Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { LayoutDashboard, MessageCircle, History, Wrench, GitBranch, ScrollText, Settings, FileText, Mic, Sun, GraduationCap } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Commands from './pages/Commands';
import Tools from './pages/Tools';
import Context from './pages/Context';
import Logs from './pages/Logs';
import SettingsPage from './pages/Settings';
import Chat from './pages/Chat';
import Prompt from './pages/Prompt';
import Teacher from './pages/Teacher';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, ariaLabel: 'Navigate to Dashboard' },
  { path: '/prompt', label: 'Prompt', icon: FileText, ariaLabel: 'Navigate to Prompt Editor' },
  { path: '/chat', label: 'Chat', icon: MessageCircle, ariaLabel: 'Navigate to Voice Chat' },
  { path: '/tools', label: 'Tools', icon: Wrench, ariaLabel: 'Navigate to Tools' },
  { path: '/context', label: 'Context', icon: GitBranch, ariaLabel: 'Navigate to Context' },
  { path: '/commands', label: 'Commands', icon: History, ariaLabel: 'Navigate to Commands' },
  { path: '/teacher', label: 'Teacher', icon: GraduationCap, ariaLabel: 'Navigate to Teacher Analytics' },
  { path: '/logs', label: 'Logs', icon: ScrollText, ariaLabel: 'Navigate to Logs' },
  { path: '/settings', label: 'Settings', icon: Settings, ariaLabel: 'Navigate to Settings' },
];

/**
 * Inner component that can use useNavigate() (must be inside BrowserRouter).
 * Listens for voice navigation and settings WebSocket messages.
 */
function AppRoutes() {
  const navigate = useNavigate();
  const wsRef = useRef(null);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/ws/dashboard`;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

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
        // Reconnect after 3s
        setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [navigate]);

  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/prompt" element={<Prompt />} />
      <Route path="/chat" element={<Chat />} />
      <Route path="/commands" element={<Commands />} />
      <Route path="/teacher" element={<Teacher />} />
      <Route path="/tools" element={<Tools />} />
      <Route path="/context" element={<Context />} />
      <Route path="/logs" element={<Logs />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  );
}

export default function App() {
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

          {/* Footer — with logo */}
          <div className="sidebar-footer">
            <img src="/ablespeak-logo.png" alt="" className="sidebar-footer-logo" />
            <span className="powered-by">AbleSpeak Gateway</span>
          </div>
        </nav>
        <main id="main-content" className="main-content" role="main">
          <AppRoutes />
          <footer className="app-footer">
            <span>Built with <span className="heart">❤</span> for people</span>
            <span className="app-footer-divider">·</span>
            <span>© 2026 Tunga Innovation Ltd</span>
          </footer>
        </main>
      </div>
      {/* Screen reader live region for voice navigation announcements */}
      <div id="a11y-announcer" aria-live="assertive" aria-atomic="true"
           style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' }} />
    </BrowserRouter>
  );
}
