import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { LayoutDashboard, MessageCircle, History, Wrench, GitBranch, ScrollText, Settings, FileText, Mic, Sun } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Commands from './pages/Commands';
import Tools from './pages/Tools';
import Context from './pages/Context';
import Logs from './pages/Logs';
import SettingsPage from './pages/Settings';
import Chat from './pages/Chat';
import Prompt from './pages/Prompt';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, ariaLabel: 'Navigate to Dashboard' },
  { path: '/prompt', label: 'Prompt', icon: FileText, ariaLabel: 'Navigate to Prompt Editor' },
  { path: '/chat', label: 'Chat', icon: MessageCircle, ariaLabel: 'Navigate to Voice Chat' },
  { path: '/tools', label: 'Tools', icon: Wrench, ariaLabel: 'Navigate to Tools' },
  { path: '/context', label: 'Context', icon: GitBranch, ariaLabel: 'Navigate to Context' },
  { path: '/commands', label: 'Commands', icon: History, ariaLabel: 'Navigate to Commands' },
  { path: '/logs', label: 'Logs', icon: ScrollText, ariaLabel: 'Navigate to Logs' },
  { path: '/settings', label: 'Settings', icon: Settings, ariaLabel: 'Navigate to Settings' },
];

export default function App() {
  return (
    <BrowserRouter>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <div className="app-layout">
        <nav className="sidebar" role="navigation" aria-label="Main navigation">
          {/* Brand header */}
          <div className="sidebar-brand">
            <div className="sidebar-brand-info">
              <h1>AbleSpeak</h1>
              <span className="sidebar-tagline">Voice Command Center</span>
            </div>
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

          {/* Footer — Powered by AbleSpeak */}
          <div className="sidebar-footer">
            <span className="powered-by">AbleSpeak Gateway</span>
          </div>
        </nav>
        <main id="main-content" className="main-content" role="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/prompt" element={<Prompt />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/commands" element={<Commands />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/context" element={<Context />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
