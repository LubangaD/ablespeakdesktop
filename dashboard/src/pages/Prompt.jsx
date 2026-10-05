/**
 * Developer hub › Prompt — written outlines of what the AI is told in each
 * mode. These are sample text kept in the dashboard, not the live prompt:
 * the server (ai-engine.js, _buildSystemPrompt) writes the real one for every
 * request and doesn't share it with the dashboard, so the page says so.
 * Styled like the Tools tab of the Stitch "Developer hub" screen
 * (docs/design/stitch/developer-hub.html): a list on the left, the chosen
 * item on the right.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SECTION, MUTED, BODY, CARD, WELL, DIVIDER, QUIET, DOT, INK } from '../lib/ui';

const PROMPT_MODES = [
  { id: 'general', label: 'General' },
  { id: 'chrome', label: 'Chrome' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'vscode', label: 'VS Code' },
];

// Named so they don't repeat the Developer hub's own Tools and Context tabs
const DOC_TABS = [
  { id: 'prompt', label: 'Instructions' },
  { id: 'tools', label: 'Tool list' },
  { id: 'context', label: 'Context keys' },
];

const PROMPT_TEMPLATES = {
  general: `# AbleSpeak System Prompt

You are a voice-native AI assistant. You listen to user speech,
understand their intent, and execute the appropriate tool.

## Available Context
- Active Application: computer.activeApplication
- Operating System: computer.osName
- Current Time: computer.currentTime

## Available Tools
- answer_question: Speak a response to the user
- ignore: Ignore a transcription

## Directives
- Always use natural language
- Execute commands immediately
- Respond concisely via TTS`,

  chrome: `# Chrome Integration Prompt

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
Active when: computer.activeApplication.processName ∈ [chrome.exe, brave.exe]`,

  gmail: `# Gmail Integration Prompt

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
Active when: integration.chrome.activeTab.host = mail.google.com`,

  youtube: `# YouTube Integration Prompt

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
Active when: integration.chrome.activeTab.host = www.youtube.com`,

  vscode: `# VS Code Integration Prompt

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
3. Confirm → "looks good" or "cancel"`,
};

const TOOL_LISTS = {
  general: '- answer_question: Speak a response to the user\n- ignore: Ignore a transcription',
  chrome: '- create_tab: Open a new tab in the browser\n- make_tab_active: Switch to a tab by ID\n- answer_question: Respond to user\n- ignore: Ignore noise',
  gmail: '- read_email: Open and read an email\n- draft_email_reply: Draft a reply\n- select_emails: Select emails\n- mark_selected_emails: Mark/star emails\n- back_to_inbox: Return to inbox\n- add_label: Add label (API)\n- make_draft: Create draft (API)',
  youtube: '- search: Search for a video\n- seek_video: Jump to timestamp\n- next_video: Play next\n- previous_video: Play previous',
  vscode: '- open_file: Open a file\n- close_file: Close a file\n- edit_text: Edit active editor\n- goto_line: Navigate to line\n- toggle_edit_mode: Enter/exit edit\n- looks_good: Confirm changes\n- cancel: Revert changes',
};

const CONTEXT_LISTS = {
  general: '- assistant.availableTools\n- assistant.directiveMode\n- computer.activeApplication\n- computer.currentTime\n- computer.visibleApplications',
  chrome: '- integration.chrome.tabs\n- integration.chrome.activeTab\n- computer.activeApplication',
  gmail: '- library.gmail.list_emails\n- library.gmail.displayed_email\n- library.gmail.is_inside_email\n- library.gmail.user_info',
  youtube: '- library.youtube.current_time\n- library.youtube.video_duration',
  vscode: '- library.vscode.active_text_editor\n- library.vscode.open_files\n- library.vscode.project_file_tree\n- library.vscode.project_root\n- library.vscode.workspace_files',
};

function Icon({ name, className = '', style }) {
  return <span className={`material-symbols-outlined ${className}`} style={style} aria-hidden="true">{name}</span>;
}

/** How many "- name: …" lines a sample list has. */
const countItems = text => (text || '').split('\n').filter(line => line.startsWith('- ')).length;

export default function Prompt() {
  const [activeMode, setActiveMode] = useState('general');
  const [activeTab, setActiveTab] = useState('prompt');
  const [copyState, setCopyState] = useState(null); // 'copied' | 'failed'

  useEffect(() => {
    if (!copyState) return undefined;
    const timer = setTimeout(() => setCopyState(null), 1600);
    return () => clearTimeout(timer);
  }, [copyState]);

  // The document text shown for the current tab
  const docText =
    activeTab === 'prompt' ? PROMPT_TEMPLATES[activeMode]
    : activeTab === 'tools' ? `# Available Tools for "${activeMode}" mode\n\n${TOOL_LISTS[activeMode] || '(none)'}`
    : `# Context for "${activeMode}" mode\n\n${CONTEXT_LISTS[activeMode] || '(none)'}`;
  const docLabel = DOC_TABS.find(t => t.id === activeTab)?.label;
  const modeLabel = PROMPT_MODES.find(m => m.id === activeMode)?.label;
  const lineCount = docText.split('\n').length;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(docText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  // Arrow keys move between the document tabs
  const onTabKey = e => {
    const i = DOC_TABS.findIndex(t => t.id === activeTab);
    const next = { ArrowRight: (i + 1) % DOC_TABS.length, ArrowLeft: (i - 1 + DOC_TABS.length) % DOC_TABS.length, Home: 0, End: DOC_TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setActiveTab(DOC_TABS[next].id);
    document.getElementById(`prompt-tab-${DOC_TABS[next].id}`)?.focus();
  };

  return (
    <div className={`${CARD} overflow-hidden flex flex-col lg:flex-row min-h-[580px]`}>
      {/* Modes */}
      <div className={`w-full lg:w-[300px] border-b lg:border-b-0 lg:border-r ${DIVIDER} flex flex-col shrink-0`}>
        <p className={`${MUTED} px-5 pt-5 pb-4 border-b ${DIVIDER}`}>
          What AbleSpeak is told in each app. Choose a mode to see what changes.
        </p>
        <div className="p-3">
          <div id="prompt-modes-label" className="px-3 py-1.5 text-[12px] leading-4 text-[#c9b8a5]">
            Prompt modes ({PROMPT_MODES.length})
          </div>
          <ul aria-labelledby="prompt-modes-label" className="flex flex-col gap-0.5 mt-1">
            {PROMPT_MODES.map(mode => {
              const on = mode.id === activeMode;
              const tools = countItems(TOOL_LISTS[mode.id]);
              return (
                <li key={mode.id} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => setActiveMode(mode.id)}
                    aria-current={on ? 'true' : undefined}
                    className={`min-h-[44px] px-3 rounded-lg text-[14px] flex items-center justify-between gap-2 text-left transition-colors ${on
                      ? 'bg-[#18202d] text-[#ffc880] font-medium'
                      : 'text-[#dae3f4] hover:bg-[#18202d]'}`}
                  >
                    <span className="truncate">{mode.label}</span>
                    <span className="text-[12px] text-[#8b95a7] font-normal shrink-0 tabular-nums">{tools} {tools === 1 ? 'tool' : 'tools'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* The chosen mode */}
      <section aria-label={`${modeLabel} mode`} className="flex-1 min-w-0 p-5 lg:p-6 flex flex-col justify-between gap-6">
        <div className="flex flex-col gap-6">
          <div className={`flex items-start justify-between flex-wrap gap-4 pb-4 border-b ${DIVIDER}`}>
            <div className="min-w-0 flex flex-col gap-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <h2 className="font-mono text-[15px] leading-6 font-semibold text-[#dae3f4] break-all">{activeMode}</h2>
                <span className={MUTED}>{modeLabel} mode</span>
              </div>
              <p className="flex items-center gap-1.5 text-[13px] leading-5">
                <span className={`w-2 h-2 rounded-full shrink-0 ${DOT.warn}`} aria-hidden="true" />
                <span className={INK.warn}>Sample text, not the live prompt</span>
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button type="button" onClick={handleCopy} className={QUIET}>
                <Icon name={copyState === 'copied' ? 'check' : 'content_copy'} className={`text-[18px] ${copyState === 'copied' ? INK.ok : 'text-[#c9b8a5]'}`} />
                <span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? "Couldn't copy" : `Copy ${docLabel.toLowerCase()}`}</span>
              </button>
              <span className="sr-only" role="status">
                {copyState === 'copied' ? 'Copied to the clipboard' : copyState === 'failed' ? "Couldn't copy" : ''}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className={SECTION}>About this text</h3>
            <p className={`${BODY} ${WELL} p-4`}>
              These outlines are written into the dashboard, and some name tools AbleSpeak doesn&rsquo;t have. The server
              writes the real prompt fresh for every request and doesn&rsquo;t share it with the dashboard yet. For the
              tools the AI really has, see the{' '}
              <Link to="/developer/tools" className="text-[#ffc880] underline underline-offset-2 hover:text-[#dae3f4]">Tools tab</Link>.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div className={`flex items-end justify-between gap-3 border-b ${DIVIDER}`}>
              <div role="tablist" aria-label="What to show" className="flex items-center gap-1" onKeyDown={onTabKey}>
                {DOC_TABS.map(({ id, label }) => {
                  const selected = activeTab === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`prompt-tab-${id}`}
                      aria-selected={selected}
                      aria-controls="prompt-doc"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setActiveTab(id)}
                      className={`min-h-[44px] px-3 -mb-px border-b-2 text-[14px] transition-colors ${selected
                        ? 'border-[#f5a623] text-[#ffc880] font-medium'
                        : 'border-transparent text-[#c9b8a5] hover:text-[#dae3f4]'}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <span className={`${MUTED} pb-2.5 whitespace-nowrap tabular-nums`}>{lineCount} lines</span>
            </div>
            <div
              id="prompt-doc"
              role="tabpanel"
              aria-labelledby={`prompt-tab-${activeTab}`}
              tabIndex={0}
              className="bg-[#0f1724] border border-white/[0.06] rounded-lg p-4 overflow-x-auto font-mono text-[13px] leading-6 text-[#dae3f4]"
            >
              {renderMarkdown(docText)}
            </div>
          </div>
        </div>

        <div className={`pt-4 border-t ${DIVIDER} flex items-center justify-between flex-wrap gap-x-4 gap-y-1 text-[12px] leading-5 text-[#c9b8a5]`}>
          <span>Written in: <code className="font-mono text-[#dae3f4]">dashboard/src/pages/Prompt.jsx</code></span>
          <span>Live prompt: <strong className="font-normal text-[#dae3f4]">built by ai-engine.js</strong></span>
        </div>
      </section>
    </div>
  );
}

// Lightweight markdown renderer for the prompt document, in calm colours
function renderMarkdown(text) {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <div key={i} className="mt-3 font-medium text-[#c9b8a5]">{line.slice(3)}</div>;
    if (line.startsWith('# ')) return <div key={i} className="font-semibold text-[#dae3f4]">{line.slice(2)}</div>;
    if (line.startsWith('- ')) {
      const rest = line.slice(2);
      const idx = rest.indexOf(':');
      return (
        <div key={i} className="flex gap-2 pl-2">
          <span className="text-[#4a5466]" aria-hidden="true">–</span>
          {idx > -1 ? (
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="text-[#ffc880]">{rest.slice(0, idx)}</span>
              <span className="text-[#c9b8a5]">{rest.slice(idx)}</span>
            </span>
          ) : (
            <span className="min-w-0 [overflow-wrap:anywhere] text-[#ffc880]">{rest}</span>
          )}
        </div>
      );
    }
    if (/^\d+\.\s/.test(line)) return <div key={i} className="pl-2 text-[#c9b8a5]">{line}</div>;
    if (line.trim() === '') return <div key={i} className="h-3" aria-hidden="true" />;
    return <div key={i} className="text-[#c9b8a5] [overflow-wrap:anywhere]">{line}</div>;
  });
}
