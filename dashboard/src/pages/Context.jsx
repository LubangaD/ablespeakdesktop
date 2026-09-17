import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Folder, FileText, GitBranch } from 'lucide-react';
import { Checkbox } from '../components/ui';

export default function Context() {
  const { data: context } = useQuery({ queryKey: ['context'], queryFn: api.getContext, refetchInterval: 1000 });
  // The desktop window, read through Windows accessibility (Stage 2)
  const { data: screen } = useQuery({ queryKey: ['screen'], queryFn: api.getScreen, refetchInterval: 5000, retry: false });
  const { data: resolution } = useQuery({ queryKey: ['resolution'], queryFn: () => api.getResolution(30), refetchInterval: 30000 });
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedValue, setSelectedValue] = useState(null);
  const [showDebug, setShowDebug] = useState(false);

  const handleNodeSelect = useCallback((path, value) => {
    setSelectedKey(path);
    setSelectedValue(value);
  }, []);

  // Build the context tree structure that mirrors Voqal's tree
  const browserTree = context && !context.message ? buildContextTree(context) : null;
  const desktopTree = buildDesktopTree(screen, resolution);
  const contextTree = browserTree || desktopTree ? { ...(desktopTree || {}), ...(browserTree || {}) } : null;

  return (
    <div className="as-context-page">
      {/* Header strip */}
      <header className="as-context-header">
        <div className="page-header compact">
          <h2><GitBranch size={28} aria-hidden="true" /> Context</h2>
          <p>What AbleSpeak knows about this computer and the open browser. Choose an item to see its value.</p>
        </div>
        <Checkbox label="Show debug info" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} />
      </header>

      <div className="as-context-split">
        {/* Left panel — tree */}
        <div className="as-context-tree-panel">
          {contextTree ? (
            <div className="as-context-tree" role="tree" aria-label="Context">
              {Object.entries(contextTree).map(([key, val]) => (
                <ContextTreeNode
                  key={key}
                  label={key}
                  value={val}
                  path={key}
                  depth={0}
                  onSelect={handleNodeSelect}
                  selectedKey={selectedKey}
                  defaultOpen={key === 'assistant' || key === 'computer' || key === 'desktop'}
                  showDebug={showDebug}
                />
              ))}
            </div>
          ) : (
            <div className="as-context-empty">
              Waiting for context data...
            </div>
          )}
        </div>

        {/* Right panel — detail viewer */}
        <div className="as-context-detail-panel" aria-live="polite">
          <div className="as-context-key-label" id="context-key-label">Context key</div>
          <div className="as-context-key-field" aria-labelledby="context-key-label">
            {selectedKey || 'Nothing chosen yet'}
          </div>

          <div className="as-context-value-label" id="context-value-label">Context value</div>
          <div className="as-context-value-field" aria-labelledby="context-value-label">
            {selectedValue !== null && selectedValue !== undefined
              ? (typeof selectedValue === 'object'
                ? JSON.stringify(selectedValue, null, 2)
                : String(selectedValue))
              : ''}
          </div>
        </div>
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
      elements: screen.elements.map(e => `${e.type} "${e.name}"${e.actions.length ? ` [${e.actions.join(', ')}]` : ''}`),
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

function buildContextTree(data) {
  // Restructure flat context into Voqal's hierarchy
  const tree = {};

  // Assistant context
  tree.assistant = {
    availableTools: data.availableTools || data.tools || [],
    directiveMode: data.directiveMode ?? true,
    includeSystemPrompt: data.includeSystemPrompt ?? true,
    includeToolsInMarkdown: data.includeToolsInMarkdown ?? false,
    promptSettings: data.promptSettings || {},
    speechId: data.speechId || '',
    usingAudioModality: data.usingAudioModality ?? false,
  };

  // Computer context
  tree.computer = {
    activeApplication: data.activeApplication || data.computer?.activeApplication || {
      foreground: true,
      id: '',
      os: 'Windows',
      processName: '',
      title: ''
    },
    currentTime: data.currentTime || new Date().toISOString(),
    osArch: data.osArch || 'amd64',
    osName: data.osName || 'Windows',
    osVersion: data.osVersion || '10',
    visibleApplications: data.visibleApplications || data.computer?.visibleApplications || [],
  };

  // Integration context (Chrome)
  tree.integration = {
    chrome: data.chrome || data.integration?.chrome || {
      tabs: data.tabs || [],
      activeTab: data.activeTab || null,
    }
  };

  // Library context
  tree.library = data.library || {};

  // User context
  tree.user = data.user || {};

  // If the raw data doesn't fit these categories, add it as raw
  if (data.result) {
    tree.integration.chrome = data.result;
  }

  return tree;
}

function ContextTreeNode({ label, value, path, depth, onSelect, selectedKey, defaultOpen = false, showDebug }) {
  const [open, setOpen] = useState(defaultOpen);
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const isExpandable = isObject || isArray;
  const isSelected = selectedKey === path;

  const handleClick = () => {
    if (isExpandable) {
      setOpen(!open);
    }
    onSelect(path, value);
  };

  // Leaf node
  if (!isExpandable) {
    return (
      <div
        className={`as-tree-leaf ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: depth * 24 + 44 }}
        onClick={() => onSelect(path, value)}
        role="treeitem"
        tabIndex={0}
        aria-selected={isSelected}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(path, value); }
        }}
      >
        <FileText size={18} className="as-tree-icon leaf" aria-hidden="true" />
        <span className="as-tree-key">{label}</span>
      </div>
    );
  }

  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);

  return (
    <div className="as-tree-node" role="treeitem" aria-expanded={open}>
      <div
        className={`as-tree-branch ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: depth * 24 + 12 }}
        onClick={handleClick}
        tabIndex={0}
        role="button"
        aria-expanded={open}
        aria-label={`${label}, ${open ? 'expanded' : 'collapsed'}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); }
          if (e.key === 'ArrowRight' && !open) { e.preventDefault(); setOpen(true); }
          if (e.key === 'ArrowLeft' && open) { e.preventDefault(); setOpen(false); }
        }}
      >
        {open
          ? <ChevronDown size={20} className="as-tree-chevron" aria-hidden="true" />
          : <ChevronRight size={20} className="as-tree-chevron" aria-hidden="true" />
        }
        <Folder size={18} className="as-tree-icon folder" aria-hidden="true" />
        <span className="as-tree-label">{label}</span>
      </div>
      {open && (
        <div className="as-tree-children" role="group">
          {entries.map(([key, val]) => (
            <ContextTreeNode
              key={key}
              label={String(key)}
              value={val}
              path={`${path}.${key}`}
              depth={depth + 1}
              onSelect={onSelect}
              selectedKey={selectedKey}
              showDebug={showDebug}
            />
          ))}
        </div>
      )}
    </div>
  );
}
