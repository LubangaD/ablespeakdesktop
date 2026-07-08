import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';
import { CheckSquare, Square, ChevronDown, FileText, Copy, Check } from 'lucide-react';

const PROMPT_MODES = ['general', 'chrome', 'gmail', 'youtube', 'vscode'];

export default function Prompt() {
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.getConfig, refetchInterval: 10000 });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 3000 });
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [activeMode, setActiveMode] = useState('general');
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeTab, setActiveTab] = useState('prompt');
  const [copied, setCopied] = useState(false);

  // Build a representative system prompt based on the active mode
  const getPromptTemplate = () => {
    const mode = activeMode;
    const computerCtx = status?.computerContext || {};

    if (mode === 'general') {
      return `# AbleSpeak System Prompt

You are a voice-native AI assistant. You listen to user speech,
understand their intent, and execute the appropriate tool.

## Available Context
- Active Application: ${computerCtx.activeApplication?.processName || 'unknown'}
- Operating System: ${computerCtx.osName || 'Windows'}
- Current Time: ${computerCtx.currentTime || new Date().toISOString()}

## Available Tools
- answer_question: Speak a response to the user
- ignore: Ignore a transcription

## Directives
- Always use natural language
- Execute commands immediately
- Respond concisely via TTS`;
    }

    if (mode === 'chrome') {
      return `# Chrome Integration Prompt

You are controlling a Chrome-based browser via voice commands.

## Available Context
- Active Tab: integration.chrome.activeTab
- All Tabs: integration.chrome.tabs
- Active App: computer.activeApplication

## Available Tools
- create_tab: Open a new tab with a URL
- make_tab_active: Switch to a specific tab by ID
- answer_question: Respond to the user
- ignore: Ignore noise

## Selector
Active when: computer.activeApplication.processName ∈ [chrome.exe, brave.exe]`;
    }

    if (mode === 'gmail') {
      return `# Gmail Integration Prompt

You are helping the user manage their Gmail inbox via voice.

## Available Context
- list_emails: Current inbox emails
- displayed_email: Currently viewed email
- is_inside_email: Whether viewing an email
- user_info: Gmail user details

## Available Tools
- read_email: Open and read an email
- draft_email_reply: Draft a reply
- select_emails: Select emails
- mark_selected_emails: Mark/star selected emails
- back_to_inbox: Return to inbox view

## Selector
Active when: integration.chrome.activeTab.host = mail.google.com`;
    }

    if (mode === 'youtube') {
      return `# YouTube Integration Prompt

You are controlling YouTube playback and navigation via voice.

## Available Context
- current_time: Video playback position
- video_duration: Total video length

## Available Tools
- search: Search for a video
- seek_video: Jump to timestamp
- next_video: Play next in playlist
- previous_video: Play previous

## Selector
Active when: integration.chrome.activeTab.host = www.youtube.com`;
    }

    if (mode === 'vscode') {
      return `# VS Code Integration Prompt

You are a voice programming assistant for Visual Studio Code.

## Available Context
- active_text_editor: Current file content
- open_files: All open editor tabs
- project_file_tree: Workspace file structure
- project_root: Root directory path
- workspace_files: All workspace files

## Available Tools
- open_file: Open a file
- close_file: Close a file
- edit_text: Edit code in active editor
- goto_line: Navigate to line number
- toggle_edit_mode: Enter/exit edit mode
- looks_good: Confirm changes
- cancel: Revert changes

## Modes
1. Idle Mode → navigate, run, debug
2. Edit Mode → create/modify code
3. Confirm → "looks good" or "cancel"`;
    }

    return '# Select a mode from the dropdown above';
  };

  // Resolve the document text shown for the current tab
  const docText =
    activeTab === 'prompt' ? getPromptTemplate()
    : activeTab === 'tools' ? `# Available Tools for "${activeMode}" mode\n\n${getToolsList(activeMode)}`
    : `# Context for "${activeMode}" mode\n\n${getContextList(activeMode)}`;

  const docTitle =
    activeTab === 'prompt' ? 'System Prompt'
    : activeTab === 'tools' ? 'Available Tools'
    : 'Active Context';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(docText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="as-prompt-page">
      {/* Page header */}
      <div className="pp-header">
        <h2><FileText size={24} aria-hidden="true" /> Prompt Studio</h2>
        <p className="pp-subtitle">The instructions AbleSpeak follows for each app. Switch modes to see what changes.</p>
      </div>

      {/* Top bar — carded */}
      <div className="as-topbar">
        <div className="as-tabs">
          {['prompt', 'tools', 'context'].map(tab => (
            <button
              key={tab}
              className={`as-tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div className="as-topbar-right">
          {/* Auto-Update checkbox */}
          <label className="as-checkbox" onClick={() => setAutoUpdate(!autoUpdate)}>
            {autoUpdate ? <CheckSquare size={18} /> : <Square size={18} />}
            <span>Auto-Update</span>
          </label>

          {/* Active mode dropdown */}
          <div className="as-dropdown-wrap">
            <span className="as-dropdown-label">Active:</span>
            <div className="as-dropdown" onClick={() => setShowDropdown(!showDropdown)}>
              <span>{activeMode}</span>
              <ChevronDown size={16} />
              {showDropdown && (
                <div className="as-dropdown-menu">
                  {PROMPT_MODES.map(mode => (
                    <button
                      key={mode}
                      className={`as-dropdown-item ${mode === activeMode ? 'active' : ''}`}
                      onClick={(e) => { e.stopPropagation(); setActiveMode(mode); setShowDropdown(false); }}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Document card */}
      <div className="pp-doc">
        <div className="pp-doc-bar">
          <div className="pp-doc-title">
            <span className="pp-doc-dot" />
            {docTitle}
            <span className="pp-doc-mode">{activeMode}</span>
          </div>
          <button className="pp-copy-btn" onClick={handleCopy} aria-label="Copy to clipboard">
            {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
          </button>
        </div>
        <div className="pp-doc-body">
          {renderMarkdown(docText)}
        </div>
      </div>
    </div>
  );
}

// Lightweight markdown renderer for the prompt document
function renderMarkdown(text) {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <div key={i} className="pp-h2">{line.slice(3)}</div>;
    if (line.startsWith('# ')) return <div key={i} className="pp-h1">{line.slice(2)}</div>;
    if (line.startsWith('- ')) {
      const rest = line.slice(2);
      const idx = rest.indexOf(':');
      if (idx > -1) {
        return (
          <div key={i} className="pp-li">
            <span className="pp-dash">–</span>
            <span className="pp-key">{rest.slice(0, idx)}</span>
            <span className="pp-val">{rest.slice(idx)}</span>
          </div>
        );
      }
      return <div key={i} className="pp-li"><span className="pp-dash">–</span>{rest}</div>;
    }
    if (/^\d+\.\s/.test(line)) return <div key={i} className="pp-li pp-num">{line}</div>;
    if (line.trim() === '') return <div key={i} className="pp-blank" />;
    return <div key={i} className="pp-text">{line}</div>;
  });
}

function getToolsList(mode) {
  const tools = {
    general: '- answer_question: Speak a response to the user\n- ignore: Ignore a transcription',
    chrome: '- create_tab: Open a new tab in the browser\n- make_tab_active: Switch to a tab by ID\n- answer_question: Respond to user\n- ignore: Ignore noise',
    gmail: '- read_email: Open and read an email\n- draft_email_reply: Draft a reply\n- select_emails: Select emails\n- mark_selected_emails: Mark/star emails\n- back_to_inbox: Return to inbox\n- add_label: Add label (API)\n- make_draft: Create draft (API)',
    youtube: '- search: Search for a video\n- seek_video: Jump to timestamp\n- next_video: Play next\n- previous_video: Play previous',
    vscode: '- open_file: Open a file\n- close_file: Close a file\n- edit_text: Edit active editor\n- goto_line: Navigate to line\n- toggle_edit_mode: Enter/exit edit\n- looks_good: Confirm changes\n- cancel: Revert changes',
  };
  return tools[mode] || '(none)';
}

function getContextList(mode) {
  const ctx = {
    general: '- assistant.availableTools\n- assistant.directiveMode\n- computer.activeApplication\n- computer.currentTime\n- computer.visibleApplications',
    chrome: '- integration.chrome.tabs\n- integration.chrome.activeTab\n- computer.activeApplication',
    gmail: '- library.gmail.list_emails\n- library.gmail.displayed_email\n- library.gmail.is_inside_email\n- library.gmail.user_info',
    youtube: '- library.youtube.current_time\n- library.youtube.video_duration',
    vscode: '- library.vscode.active_text_editor\n- library.vscode.open_files\n- library.vscode.project_file_tree\n- library.vscode.project_root\n- library.vscode.workspace_files',
  };
  return ctx[mode] || '(none)';
}
