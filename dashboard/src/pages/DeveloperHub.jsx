/**
 * Developer hub — the AI's instructions, tools, context and logs, as tabs.
 * Each tab has its own address (/developer/tools, …) so voice navigation
 * and bookmarks can open it directly.
 */
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { TerminalSquare, FileText, Wrench, GitBranch, ScrollText } from 'lucide-react';
import Prompt from './Prompt';
import Tools from './Tools';
import Context from './Context';
import Logs from './Logs';

const TABS = [
  { id: 'prompt', label: 'Prompt', icon: FileText, Page: Prompt },
  { id: 'tools', label: 'Tools', icon: Wrench, Page: Tools },
  { id: 'context', label: 'Context', icon: GitBranch, Page: Context },
  { id: 'logs', label: 'Logs', icon: ScrollText, Page: Logs },
];

export default function DeveloperHub() {
  const { tab } = useParams();
  const current = TABS.find(t => t.id === tab);
  if (!current) return <Navigate to="/developer/prompt" replace />;
  const { Page } = current;

  return (
    <div className="dev-hub workspace">
      <header className="page-header compact">
        <h2><TerminalSquare size={28} aria-hidden="true" /> Developer hub</h2>
        <p>What the AI sees and can do. For technical staff.</p>
      </header>

      <nav className="hub-tabs" aria-label="Developer hub sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <NavLink key={id} to={`/developer/${id}`} className={({ isActive }) => `hub-tab${isActive ? ' active' : ''}`}>
            <Icon size={20} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className={`dev-hub-panel panel-${current.id}`}>
        <Page embedded />
      </div>
    </div>
  );
}
