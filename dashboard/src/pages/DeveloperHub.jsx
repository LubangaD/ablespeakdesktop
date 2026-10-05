/**
 * Developer hub, built from the Stitch "Developer hub" screen
 * (docs/design/stitch/developer-hub.html): what the AI is told, the tools it
 * can call, what it knows about the computer, and the engine's log, as tabs.
 * Each tab has its own address (/developer/tools, …) so voice navigation
 * and bookmarks can open it directly.
 */
import { useEffect, useState } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { TITLE, MUTED, PAGE, DIVIDER, DOT, INK } from '../lib/ui';
import Prompt from './Prompt';
import Tools from './Tools';
import Context from './Context';
import Logs from './Logs';

const TABS = [
  { id: 'prompt', label: 'Prompt', icon: 'description', Page: Prompt },
  { id: 'tools', label: 'Tools', icon: 'build', Page: Tools },
  { id: 'context', label: 'Context', icon: 'account_tree', Page: Context },
  { id: 'logs', label: 'Logs', icon: 'receipt_long', Page: Logs },
];

/** Which AI answers, and whether it can (its API key is set). */
function AiStatus() {
  const { data: ai, isError } = useQuery({ queryKey: ['aiStatus'], queryFn: api.getAiStatus, refetchInterval: 10000 });
  if (!ai && !isError) return null;
  const ready = !!ai?.configured;
  const tone = !ai ? 'idle' : ready ? 'ok' : 'bad';
  return (
    <div role="status" className="flex items-center gap-2 min-h-[36px] text-[13px] leading-5 self-start">
      <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[tone]}`} aria-hidden="true" />
      <span className="text-[#c9b8a5]">AI engine:</span>
      <span className={INK[tone]}>{!ai ? 'Unavailable' : ready ? 'Ready' : 'No API key'}</span>
      {ai && (
        <>
          <span className="text-[#4a5466]" aria-hidden="true">·</span>
          <span className="text-[#dae3f4]">{ai.providerName || ai.provider}{ai.model ? ` · ${ai.model}` : ''}</span>
        </>
      )}
    </div>
  );
}

/** How many tools the AI can call, from the live tool registry. */
function ToolCount() {
  const { data: catalog } = useQuery({ queryKey: ['tools'], queryFn: api.getTools, staleTime: 30000 });
  if (!catalog) return null;
  const total = catalog.total ?? (catalog.categories || []).reduce((n, cat) => n + cat.tools.length, 0);
  return (
    <p className={`${MUTED} pr-1 shrink-0`}>
      <span className="text-[#dae3f4] tabular-nums">{total}</span> tools available
    </p>
  );
}

/**
 * Whether the engine log can be read (the Logs tab's dot), and whether it has
 * a line newer than the last one there while the Logs tab was open (or when
 * the hub opened), which makes the dot pulse. Checks every 5 seconds.
 */
function useLogState(onLogsTab) {
  const { data, isSuccess } = useQuery({
    queryKey: ['recentLogs', 'latest'],
    queryFn: () => api.getRecentLogs({ limit: 1 }),
    refetchInterval: 5000,
    retry: false,
  });
  const latest = Array.isArray(data) ? (data[data.length - 1]?.raw ?? null) : undefined;
  const [seen, setSeen] = useState(undefined);
  useEffect(() => {
    if (latest === undefined) return;
    if (onLogsTab || seen === undefined) setSeen(latest);
  }, [latest, onLogsTab, seen]);
  return {
    live: isSuccess,
    fresh: !onLogsTab && seen !== undefined && latest !== undefined && latest !== seen,
  };
}

export default function DeveloperHub() {
  const { tab } = useParams();
  const current = TABS.find(t => t.id === tab);
  const logState = useLogState(tab === 'logs');
  if (!current) return <Navigate to="/developer/tools" replace />;
  const { Page: TabPage } = current;

  return (
    <div className={PAGE}>
      <div className="flex flex-col w-full gap-6">
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className={TITLE}>Developer</h1>
            <p className={`${MUTED} text-[14px] mt-1`}>What the AI sees and can do. For technical staff.</p>
          </div>
          <AiStatus />
        </header>

        <div className={`flex items-end justify-between gap-4 border-b ${DIVIDER}`}>
          <nav aria-label="Developer hub sections" className="flex items-center gap-1 overflow-x-auto">
            {TABS.map(({ id, label, icon }) => (
              <NavLink
                key={id}
                to={`/developer/${id}`}
                className={({ isActive }) => `min-h-[44px] px-3 -mb-px border-b-2 text-[14px] flex items-center gap-2 shrink-0 transition-colors ${
                  isActive
                    ? 'border-[#f5a623] text-[#ffc880] font-medium'
                    : 'border-transparent text-[#c9b8a5] hover:text-[#dae3f4]'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{icon}</span>
                <span>{label}</span>
                {id === 'logs' && logState.live && (
                  <span className="relative flex w-2 h-2" aria-hidden="true">
                    {logState.fresh && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#68d9c3] opacity-75" />}
                    <span className={`relative inline-flex w-2 h-2 rounded-full ${DOT.ok}`} />
                  </span>
                )}
                {id === 'logs' && logState.fresh && <span className="sr-only">(new lines)</span>}
              </NavLink>
            ))}
          </nav>
          <div className="pb-2.5"><ToolCount /></div>
        </div>

        <TabPage />
      </div>
    </div>
  );
}
