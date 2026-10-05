/**
 * Developer hub › Context — what AbleSpeak knows about this computer and the
 * open browser: the last update from the Chrome extension (GET /api/context),
 * the window in front read through Windows accessibility (GET /api/screen),
 * and how often controls were found that way (GET /api/screen/resolution).
 * Only what those return is shown; nothing is filled in. Styled like the
 * Tools tab of the Stitch "Developer hub" screen
 * (docs/design/stitch/developer-hub.html).
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { JsonText } from './Tools';
import { SECTION, MUTED, CARD, DIVIDER, BUTTON, QUIET, DOT, INK } from '../lib/ui';

function Icon({ name, className = '', style }) {
  return <span className={`material-symbols-outlined ${className}`} style={style} aria-hidden="true">{name}</span>;
}

// Where each top-level part of the tree comes from, and how often it is read
const EXTENSION = { icon: 'extension', text: 'From the Chrome extension’s last update', api: 'GET /api/context', every: '1s' };
const SOURCES = {
  desktop: { icon: 'desktop_windows', text: 'Read from the window in front (Windows accessibility)', api: 'GET /api/screen', every: '5s' },
  screenResolution: { icon: 'insights', text: 'How controls were found, last 30 days', api: 'GET /api/screen/resolution', every: '30s' },
};
const DEBUG = {
  contextUpdate: { icon: 'bug_report', text: 'Exactly as the server sent it', api: 'GET /api/context', every: '1s' },
  screenModel: { icon: 'bug_report', text: 'Exactly as the server sent it', api: 'GET /api/screen', every: '5s' },
};

function sourceFor(keys) {
  if (keys[0] === 'debug') return DEBUG[keys[1]] || { icon: 'bug_report', text: 'Exactly as the server sent it', api: 'GET /api/context · /api/screen', every: '1s' };
  return SOURCES[keys[0]] || EXTENSION;
}

/** The item at `keys` in the tree as it is now, or undefined. */
function lookUp(tree, keys) {
  let node = tree;
  for (const key of keys) {
    if (node === null || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

/** "object · 5 keys", "list · 3 items", "string" … */
function kindLabel(value) {
  if (Array.isArray(value)) return `list · ${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  if (value === null) return 'null';
  if (typeof value === 'object') {
    const n = Object.keys(value).length;
    return `object · ${n} ${n === 1 ? 'key' : 'keys'}`;
  }
  return typeof value;
}

export default function Context() {
  const { data: context } = useQuery({ queryKey: ['context'], queryFn: api.getContext, refetchInterval: 1000 });
  // The desktop window, read through Windows accessibility (Stage 2)
  const { data: screen } = useQuery({ queryKey: ['screen'], queryFn: api.getScreen, refetchInterval: 5000, retry: false });
  const { data: resolution } = useQuery({ queryKey: ['resolution'], queryFn: () => api.getResolution(30), refetchInterval: 30000 });
  const [selected, setSelected] = useState(null); // { path, keys, value } as chosen
  const [showDebug, setShowDebug] = useState(false);
  const [copyState, setCopyState] = useState(null); // 'copied' | 'failed'

  useEffect(() => {
    if (!copyState) return undefined;
    const timer = setTimeout(() => setCopyState(null), 1600);
    return () => clearTimeout(timer);
  }, [copyState]);

  const handleNodeSelect = useCallback((path, keys, value) => setSelected({ path, keys, value }), []);

  const browserTree = buildBrowserTree(context);
  const desktopTree = buildDesktopTree(screen, resolution);
  const debugTree = showDebug ? buildDebugTree(context, screen) : null;
  const contextTree = browserTree || desktopTree || debugTree
    ? { ...(desktopTree || {}), ...(browserTree || {}), ...(debugTree || {}) }
    : null;
  const topKeys = contextTree ? Object.keys(contextTree) : [];

  // The chosen item follows the refreshes; if it has gone, the last value seen stays.
  const live = selected && contextTree ? lookUp(contextTree, selected.keys) : undefined;
  const selectedValue = selected ? (live !== undefined ? live : selected.value) : undefined;
  const source = selected ? sourceFor(selected.keys) : null;

  const valueText = selectedValue === undefined ? ''
    : selectedValue !== null && typeof selectedValue === 'object' ? JSON.stringify(selectedValue, null, 2)
    : String(selectedValue);
  const valueIsJson = selectedValue !== undefined && (selectedValue === null || typeof selectedValue !== 'string');

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(valueText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className={`${MUTED} text-[14px]`}>
          What AbleSpeak knows about this computer and the open browser. Choose an item to see its value.
        </p>
        <button
          type="button"
          aria-pressed={showDebug}
          onClick={() => setShowDebug(on => !on)}
          className={`${BUTTON} border shrink-0 ${showDebug
            ? 'bg-[#222a37] text-[#ffc880] border-[#f5a623]/40'
            : 'bg-[#18202d] hover:bg-[#222a37] text-[#dae3f4] border-white/[0.08]'}`}
        >
          <Icon name={showDebug ? 'check' : 'bug_report'} className={`text-[18px] ${showDebug ? '' : 'text-[#c9b8a5]'}`} />
          <span>Show debug info</span>
        </button>
      </div>

      <div className={`${CARD} overflow-hidden flex flex-col lg:flex-row min-h-[580px]`}>
        {/* The tree */}
        <div className={`w-full lg:w-[360px] border-b lg:border-b-0 lg:border-r ${DIVIDER} flex flex-col shrink-0`}>
          <div className="relative flex-1 min-h-0">
            <div className="overflow-y-auto p-3 max-h-[520px] lg:max-h-none lg:absolute lg:inset-0">
              <div id="context-tree-label" className="px-3 py-1.5 text-[12px] leading-4 text-[#c9b8a5]">
                Context ({topKeys.length})
              </div>
              {contextTree ? (
                <ul aria-labelledby="context-tree-label" className="flex flex-col gap-0.5 mt-1">
                  {topKeys.map(key => (
                    <ContextTreeNode
                      key={key}
                      label={key}
                      value={contextTree[key]}
                      keys={[key]}
                      onSelect={handleNodeSelect}
                      selectedPath={selected?.path}
                      defaultOpen={key === 'desktop' || key === 'integration'}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-3 text-[13px] leading-5 text-[#8b95a7]">
                  Waiting for context. The browser part appears when the Chrome extension sends an update; the desktop
                  part when AbleSpeak can read the window in front.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* The chosen item */}
        <section aria-label="Context value" className="flex-1 min-w-0 p-5 lg:p-6 flex flex-col">
          {selected ? (
            <div className="flex-1 flex flex-col justify-between gap-6">
              <div className="flex flex-col gap-6">
                <div className={`flex items-start justify-between flex-wrap gap-4 pb-4 border-b ${DIVIDER}`}>
                  <div className="min-w-0 flex flex-col gap-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <h2 className="font-mono text-[15px] leading-6 font-semibold text-[#dae3f4] [overflow-wrap:anywhere]" aria-live="polite">{selected.path}</h2>
                      <span className={`${MUTED} whitespace-nowrap`}>{kindLabel(selectedValue)}</span>
                    </div>
                    <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[13px] leading-5">
                      <span className="flex items-center gap-1.5 text-[#c9b8a5]">
                        <Icon name={source.icon} className="text-[16px] text-[#8b95a7]" />
                        <span>{source.text}</span>
                      </span>
                      {live === undefined && (
                        <>
                          <span className="text-[#4a5466]" aria-hidden="true">·</span>
                          <span className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${DOT.warn}`} aria-hidden="true" />
                            <span className={INK.warn}>No longer there; last value shown</span>
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button type="button" onClick={copyValue} className={QUIET}>
                      <Icon name={copyState === 'copied' ? 'check' : 'content_copy'} className={`text-[18px] ${copyState === 'copied' ? INK.ok : 'text-[#c9b8a5]'}`} />
                      <span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? "Couldn't copy" : 'Copy value'}</span>
                    </button>
                    <span className="sr-only" role="status">
                      {copyState === 'copied' ? 'Value copied' : copyState === 'failed' ? "Couldn't copy the value" : ''}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <h3 id="context-value-label" className={SECTION}>Context value</h3>
                    <span className={`text-[13px] leading-5 flex items-center gap-1.5 ${INK.ok}`}>
                      <span className={`w-2 h-2 rounded-full ${DOT.ok}`} aria-hidden="true" />
                      Refreshes every {source.every}
                    </span>
                  </div>
                  <div className="bg-[#0f1724] border border-white/[0.06] rounded-lg p-4 overflow-auto max-h-[560px]" tabIndex={0} aria-labelledby="context-value-label">
                    <pre data-private className="font-mono text-[12px] leading-5 text-[#dae3f4] whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {valueIsJson ? <code className="block"><JsonText text={valueText} /></code> : valueText}
                    </pre>
                  </div>
                </div>
              </div>

              <div className={`pt-4 border-t ${DIVIDER} flex items-center justify-between flex-wrap gap-x-4 gap-y-1 text-[12px] leading-5 text-[#c9b8a5]`}>
                <span>Source: <code className="font-mono text-[#dae3f4]">{source.api}</code></span>
                <span>Read: <strong className="font-normal text-[#dae3f4]">every {source.every}</strong></span>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center">
              <p className="text-[13px] leading-5 text-[#8b95a7]">Choose an item on the left to see its value.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// What AbleSpeak reads from the desktop window, and how often it found
// controls through the accessibility tree rather than by screen position.
function buildDesktopTree(screen, resolution) {
  const tree = {};
  if (screen?.status === 'success') {
    tree.desktop = {
      window: screen.window,
      app: screen.app,
      controls: screen.total,
      withActions: screen.actionable,
      readMs: screen.ms,
      elements: (screen.elements || []).map(e => `${e.type} "${e.name}"${e.actions?.length ? ` [${e.actions.join(', ')}]` : ''}`),
    };
  }
  if (resolution?.apps?.length) {
    tree.screenResolution = Object.fromEntries(resolution.apps.map(app => [app.app, {
      resolutionRate: app.resolutionRate == null ? '—' : `${Math.round(app.resolutionRate * 100)}%`,
      throughControls: app.uia,
      byScreenPosition: app.coordinates,
      notFound: app.not_found,
      failedActions: app.failed_actions,
      attempts: app.attempts,
      since: resolution.since,
    }]));
  }
  return Object.keys(tree).length ? tree : null;
}

/** The keys of `obj` that are actually present. */
function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));
}

// The last context update, arranged the way the AI's context is named
// (assistant, computer, integration.chrome, library, user). Only keys the
// update carries are included.
function buildBrowserTree(data) {
  if (!data || typeof data !== 'object' || data.message) return null;
  const tree = {};

  const assistant = pick(data, ['directiveMode', 'includeSystemPrompt', 'includeToolsInMarkdown', 'promptSettings', 'speechId', 'usingAudioModality']);
  const availableTools = data.availableTools ?? data.tools;
  if (availableTools !== undefined) assistant.availableTools = availableTools;
  if (Object.keys(assistant).length) tree.assistant = assistant;

  const computer = {
    ...pick(data, ['activeApplication', 'currentTime', 'osArch', 'osName', 'osVersion', 'visibleApplications']),
    ...(data.computer && typeof data.computer === 'object' ? data.computer : {}),
  };
  if (Object.keys(computer).length) tree.computer = computer;

  // The Chrome extension sends its tabs as `result` (context: 'integration');
  // a page's library updater sends its answer the same way (context: 'library').
  if (data.context === 'library' && data.result !== undefined) {
    tree.library = { [data.name || 'result']: data.result };
  } else {
    const chrome = data.result ?? data.chrome ?? data.integration?.chrome
      ?? (data.tabs !== undefined || data.activeTab !== undefined ? pick(data, ['tabs', 'activeTab']) : undefined);
    if (chrome != null) tree.integration = { chrome };
  }

  if (data.library && typeof data.library === 'object') tree.library = { ...(tree.library || {}), ...data.library };
  if (data.user !== undefined) tree.user = data.user;

  return Object.keys(tree).length ? tree : null;
}

// "Show debug info": the answers exactly as the server sent them.
function buildDebugTree(context, screen) {
  const raw = {};
  if (context !== undefined) raw.contextUpdate = context;
  if (screen !== undefined) raw.screenModel = screen;
  return Object.keys(raw).length ? { debug: raw } : null;
}

/** A short look at a value for its row, e.g. "chrome.exe" or 12. */
function preview(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
  return String(value);
}

function ContextTreeNode({ label, value, keys, onSelect, selectedPath, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const path = keys.join('.');
  const isArray = Array.isArray(value);
  const isExpandable = isArray || (value !== null && typeof value === 'object');
  const isSelected = selectedPath === path;

  const rowClass = `w-full min-h-[44px] px-3 py-2 rounded-lg font-mono text-[13px] flex items-center gap-2 text-left transition-colors ${isSelected
    ? 'bg-[#18202d] text-[#ffc880] font-medium'
    : 'text-[#dae3f4] hover:bg-[#18202d]'}`;

  if (!isExpandable) {
    return (
      <li>
        <button type="button" className={rowClass} aria-current={isSelected ? 'true' : undefined} onClick={() => onSelect(path, keys, value)}>
          <Icon name="data_object" className="text-[16px] shrink-0 text-[#4a5466]" />
          <span className="shrink-0">{label}</span>
          <span className={`truncate text-[12px] font-normal ml-auto ${isSelected ? 'text-[#ffc880]' : 'text-[#8b95a7]'}`} data-private>{preview(value)}</span>
        </button>
      </li>
    );
  }

  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  const toggle = () => {
    setOpen(o => !o);
    onSelect(path, keys, value);
  };

  return (
    <li>
      <button
        type="button"
        className={rowClass}
        aria-expanded={open}
        aria-current={isSelected ? 'true' : undefined}
        onClick={toggle}
        onKeyDown={e => {
          if (e.key === 'ArrowRight' && !open) { e.preventDefault(); setOpen(true); }
          if (e.key === 'ArrowLeft' && open) { e.preventDefault(); setOpen(false); }
        }}
      >
        <Icon name={open ? 'expand_more' : 'chevron_right'} className="text-[18px] shrink-0 text-[#8b95a7]" />
        <Icon name={open ? 'folder_open' : 'folder'} className="text-[16px] shrink-0 text-[#c9b8a5]" />
        <span className="truncate">{label}</span>
        <span className={`ml-auto shrink-0 text-[12px] font-sans font-normal ${isSelected ? 'text-[#ffc880]' : 'text-[#8b95a7]'}`}>
          {entries.length} {isArray ? (entries.length === 1 ? 'item' : 'items') : (entries.length === 1 ? 'key' : 'keys')}
        </span>
      </button>
      {open && entries.length > 0 && (
        <ul className="ml-5 pl-2 border-l border-white/[0.06] mt-0.5 flex flex-col gap-0.5">
          {entries.map(([key, val]) => (
            <ContextTreeNode
              key={key}
              label={String(key)}
              value={val}
              keys={[...keys, String(key)]}
              onSelect={onSelect}
              selectedPath={selectedPath}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
