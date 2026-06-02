import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';
import { CheckSquare, Square, ChevronDown } from 'lucide-react';

const PROMPT_MODES = ['general', 'chrome', 'gmail', 'youtube', 'vscode'];

export default function Prompt() {
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.getConfig, refetchInterval: 10000 });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 3000 });
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [activeMode, setActiveMode] = useState('general');
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeTab, setActiveTab] = useState('prompt');

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

  return (
    <div className="as-prompt-page">
      {/* Top bar — matches Voqal's Prompt|Tools|Context strip */}
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

      {/* Prompt content area */}
      {activeTab === 'prompt' && (
        <div className="as-prompt-content">
          <pre className="as-prompt-text">{getPromptTemplate()}</pre>
        </div>
      )}

      {activeTab === 'tools' && (
        <div className="as-prompt-content">
          <p style={{ color: 'var(--text-muted)', padding: 24 }}>
            Tools are shown on the dedicated Tools page in the sidebar. Select a mode above to see which tools are available for that context.
          </p>
          <pre className="as-prompt-text">{`# Available Tools for "${activeMode}" mode\n\n${getToolsList(activeMode)}`}</pre>
        </div>
      )}

      {activeTab === 'context' && (
        <div className="as-prompt-content">
          <p style={{ color: 'var(--text-muted)', padding: 24 }}>
            Context data is shown on the dedicated Context page in the sidebar. The active context for the current mode is displayed below.
          </p>
          <pre className="as-prompt-text">{`# Context for "${activeMode}" mode\n\n${getContextList(activeMode)}`}</pre>
        </div>
      )}
    </div>
  );
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
