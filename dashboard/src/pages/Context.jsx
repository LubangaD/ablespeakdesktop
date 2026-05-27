import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Folder, FileText, Search } from 'lucide-react';

export default function Context() {
  const { data: context } = useQuery({ queryKey: ['context'], queryFn: api.getContext, refetchInterval: 1000 });
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedValue, setSelectedValue] = useState(null);
  const [showDebug, setShowDebug] = useState(false);

  const handleNodeSelect = useCallback((path, value) => {
    setSelectedKey(path);
    setSelectedValue(value);
  }, []);

  // Build the context tree structure that mirrors Voqal's tree
  const contextTree = context && !context.message ? buildContextTree(context) : null;

  return (
    <div className="as-context-page">
      {/* Header strip */}
      <div className="as-context-header">
        <span className="as-context-title">AbleSpeak Context</span>
        <label className="as-checkbox-sm">
          <input
            type="checkbox"
            checked={showDebug}
            onChange={e => setShowDebug(e.target.checked)}
          />
          Show debug info
        </label>
      </div>

      <div className="as-context-split">
        {/* Left panel — tree */}
        <div className="as-context-tree-panel">
          {contextTree ? (
            <div className="as-context-tree">
              {Object.entries(contextTree).map(([key, val]) => (
                <ContextTreeNode
                  key={key}
                  label={key}
                  value={val}
                  path={key}
                  depth={0}
                  onSelect={handleNodeSelect}
                  selectedKey={selectedKey}
                  defaultOpen={key === 'assistant' || key === 'computer'}
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
        <div className="as-context-detail-panel">
          <div className="as-context-key-label">Context Key</div>
          <div className="as-context-key-field">
            {selectedKey || ''}
          </div>

          <div className="as-context-value-label">Context Value</div>
          <div className="as-context-value-field">
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
        style={{ paddingLeft: depth * 20 + 12 }}
        onClick={() => onSelect(path, value)}
      >
        <FileText size={14} className="as-tree-icon leaf" />
        <span className="as-tree-key">{label}</span>
      </div>
    );
  }

  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);

  return (
    <div className="as-tree-node">
      <div
        className={`as-tree-branch ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: depth * 20 + 4 }}
        onClick={handleClick}
      >
        {open
          ? <ChevronDown size={16} className="as-tree-chevron" />
          : <ChevronRight size={16} className="as-tree-chevron" />
        }
        <Folder size={14} className="as-tree-icon folder" />
        <span className="as-tree-label">{label}</span>
      </div>
      {open && (
        <div className="as-tree-children">
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
