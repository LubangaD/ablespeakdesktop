/**
 * AbleSpeak Tool Registry
 * 
 * Defines all available tools in OpenAI function-calling format.
 * Mirrors Voqal's YAML tool schemas but in JavaScript.
 * Tools are context-aware — only included when their selector matches.
 */

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { classifyConsequential, appDependentKey } from './safety.js';

// How long the safety gate waits to learn the app in front (a window list
// from PowerShell) before it asks about the key anyway.
const FRONT_WINDOW_WAIT_MS = 1500;

/** The student whose session a tool runs in, for the resolution log. */
const studentOf = wsHub => (wsHub?._evaluating ? null : wsHub?._attribution?.().student_id ?? null);

// ── Tool Definitions ──

const TOOLS = [
  // ── Tab Management ──
  {
    name: 'create_tab',
    description: 'Open a new tab in the browser with the given URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to open in the new tab.' },
      },
      required: ['url'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('create_tab', args);
    },
  },
  {
    name: 'open_url',
    description: 'Navigate the current active tab to a new URL. Use this when the user wants to go to a specific website without opening a new tab.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to in the current tab.' },
      },
      required: ['url'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('open_url', args);
    },
  },
  {
    name: 'make_tab_active',
    description: 'Switch to a specific browser tab by its tab ID.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab ID to switch to.' },
      },
      required: ['tab_id'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('make_tab_active', args);
    },
  },
  {
    name: 'close_tab',
    description: 'Close a browser tab by its tab ID. If no tab_id is provided, closes the active tab.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab ID to close. Leave empty to close active tab.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('close_tab', args);
    },
  },
  {
    name: 'reload_tab',
    description: 'Reload a browser tab. If no tab_id is provided, reloads the active tab.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab ID to reload. Leave empty for active tab.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('reload_tab', args);
    },
  },
  {
    name: 'duplicate_tab',
    description: 'Duplicate a browser tab. If no tab_id is provided, duplicates the active tab.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab ID to duplicate. Leave empty for active tab.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('duplicate_tab', args);
    },
  },
  {
    name: 'pin_tab',
    description: 'Pin a browser tab. If no tab_id is provided, pins the active tab.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab ID to pin. Leave empty for active tab.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('pin_tab', args);
    },
  },
  {
    name: 'mute_tab',
    description: 'Mute or unmute a browser tab. If no tab_id is provided, affects the active tab.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab ID to mute/unmute. Leave empty for active tab.' },
        muted: { type: 'boolean', description: 'True to mute, false to unmute. Defaults to true.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      const type = (args.muted === false) ? 'unmute_tab' : 'mute_tab';
      return wsHub.sendToolToExtension(type, args);
    },
  },
  {
    name: 'find_tab',
    description: 'Search for open browser tabs by title or URL. Returns matching tabs with their IDs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to match against tab titles and URLs.' },
      },
      required: ['query'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('find_tab', args);
    },
  },
  {
    name: 'list_tabs',
    description: 'Get a list of all open browser tabs with their IDs, titles, and URLs.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('find_tab', { query: '' });
    },
  },
  {
    name: 'zoom_tab',
    description: 'Set the zoom level of a browser tab. 1.0 is 100%, 1.5 is 150%, 0.5 is 50%.',
    parameters: {
      type: 'object',
      properties: {
        zoom_factor: { type: 'string', description: 'The zoom factor (e.g. "1.0" for 100%, "1.5" for 150%, "0.75" for 75%).' },
        tab_id: { type: 'string', description: 'The tab ID to zoom. Leave empty for active tab.' },
      },
      required: ['zoom_factor'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('zoom_tab', args);
    },
  },

  // ── Navigation ──
  {
    name: 'go_back',
    description: 'Go back to the previous page in browser history, like pressing the back button.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab ID. Leave empty for active tab.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('go_back', args);
    },
  },
  {
    name: 'go_forward',
    description: 'Go forward to the next page in browser history, like pressing the forward button.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'The tab ID. Leave empty for active tab.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('go_forward', args);
    },
  },

  // ── Scrolling ──
  {
    name: 'scroll',
    description: 'Scroll the page in a given direction. Use for "scroll down", "scroll up", "scroll left", "scroll right".',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction to scroll.' },
        amount: { type: 'string', description: 'Pixels to scroll. Defaults to 400 if not specified.' },
      },
      required: ['direction'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('scroll', args);
    },
  },
  {
    name: 'scroll_to_top',
    description: 'Scroll to the very top of the page.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('scroll_to_top', {});
    },
  },
  {
    name: 'scroll_to_bottom',
    description: 'Scroll to the very bottom of the page.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('scroll_to_bottom', {});
    },
  },
  {
    name: 'scroll_element',
    description: 'Scroll inside a specific scrollable container (chat panels, sidebars, dropdown menus, etc.).',
    parameters: {
      type: 'object',
      properties: {
        xpath: { type: 'string', description: 'XPath of the scrollable container.' },
        query_selector: { type: 'string', description: 'CSS selector of the scrollable container (alternative to xpath).' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction to scroll.' },
        amount: { type: 'string', description: 'Pixels to scroll. Defaults to 300.' },
      },
      required: ['direction'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('scroll_element', args);
    },
  },

  // ── Focus & Keyboard ──
  {
    name: 'focus_next',
    description: 'Move keyboard focus to the next interactive element on the page (like pressing Tab). Essential for hands-free navigation.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('focus_next', {});
    },
  },
  {
    name: 'focus_prev',
    description: 'Move keyboard focus to the previous interactive element on the page (like pressing Shift+Tab).',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('focus_prev', {});
    },
  },
  {
    name: 'press_key_combination',
    description: 'Press a keyboard key or combination. Supports Ctrl, Shift, Alt, Meta modifiers. Examples: Escape, Tab, Enter, Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z, ArrowDown, ArrowUp, Space, Backspace, Delete.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key to press (e.g. "Escape", "Tab", "Enter", "a", "c", "ArrowDown").' },
        ctrl: { type: 'boolean', description: 'Hold Ctrl key.' },
        shift: { type: 'boolean', description: 'Hold Shift key.' },
        alt: { type: 'boolean', description: 'Hold Alt key.' },
        meta: { type: 'boolean', description: 'Hold Meta/Windows/Cmd key.' },
      },
      required: ['key'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('press_key_combination', args);
    },
  },

  // ── Media Controls ──
  {
    name: 'media_control',
    description: 'Control video or audio playback on the page. Actions: play, pause, toggle, seek (set time), seek_by (skip forward/back), volume (0-100), mute, unmute, rate (playback speed), skip_ad (press Skip on a YouTube ad — use this for "skip the ad", not click_element).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'toggle', 'seek', 'seek_by', 'volume', 'mute', 'unmute', 'rate', 'skip_ad'], description: 'The media action to perform.' },
        value: { type: 'string', description: 'Value for seek (seconds), seek_by (+/- seconds), volume (0-100), or rate (e.g. "1.5").' },
        xpath: { type: 'string', description: 'XPath of specific media element. If omitted, targets first video/audio on page.' },
      },
      required: ['action'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('media_control', args);
    },
  },

  // ── YouTube (ideas from the Voqal library's youtube profile, Apache-2.0) ──
  // Offered only while the active tab is on YouTube (selector.site). Videos are
  // opened by their ID, from the list the page itself gives (the YouTube
  // section of the context), not by clicking a place on the page.
  {
    name: 'youtube_open_video',
    description: 'Open and play a YouTube video by its ID, from the videos listed in the YouTube section of the context ("play the one by Michael Jackson", "play Thriller").',
    parameters: {
      type: 'object',
      properties: { video_id: { type: 'string', description: 'The video ID from the YouTube section.' } },
      required: ['video_id'],
    },
    selector: { requiresExtension: true, site: 'youtube.com' },
    execute: async (args, wsHub) => wsHub.sendToolToExtension('youtube', { action: 'open', videoId: args.video_id }),
  },
  {
    name: 'youtube_play_result',
    description: 'Play the Nth video on the YouTube page, counting as the person sees them: search results, or "up next" on a video page ("play the second one").',
    parameters: {
      type: 'object',
      properties: { number: { type: 'integer', description: '1 for the first video, 2 for the second, and so on.' } },
      required: ['number'],
    },
    selector: { requiresExtension: true, site: 'youtube.com' },
    execute: async (args, wsHub) => wsHub.sendToolToExtension('youtube', { action: 'open_index', index: args.number }),
  },
  {
    name: 'youtube_next_video',
    description: 'Play the next video on YouTube (the playlist\'s next, or the first one up next).',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true, site: 'youtube.com' },
    execute: async (_args, wsHub) => wsHub.sendToolToExtension('youtube', { action: 'next' }),
  },
  {
    name: 'youtube_previous_video',
    description: 'Go back to the previous video on YouTube.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true, site: 'youtube.com' },
    execute: async (_args, wsHub) => wsHub.sendToolToExtension('youtube', { action: 'previous' }),
  },
  {
    // The Voqal library's youtube/tools/seek_video
    name: 'youtube_seek',
    description: 'Move through the YouTube video playing: `seconds` forward (negative: back), or `to` a time in seconds from the start (0 = the beginning).',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How far to move: 30 = forward 30 s, -10 = back 10 s.' },
        to: { type: 'number', description: 'A time in the video, in seconds from the start. Use this or seconds.' },
      },
    },
    selector: { requiresExtension: true, site: 'youtube.com' },
    execute: async (args, wsHub) => wsHub.sendToolToExtension('youtube', args.to != null && args.to !== '' && Number.isFinite(Number(args.to))
      ? { action: 'seek', to: Number(args.to) }
      : { action: 'seek', by: Number(args.seconds) || 10 }),
  },
  {
    name: 'youtube_skip_sponsor',
    description: 'Skip the sponsor part of the YouTube video playing (the parts viewers marked on SponsorBlock: sponsor reads, self-promotion, subscribe reminders).',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true, site: 'youtube.com' },
    execute: async (_args, wsHub) => {
      const state = await wsHub.sendToolToExtension('youtube', { action: 'state' });
      if (state?.status !== 'success' || state.page !== 'watch' || !state.videoId) return { status: 'error', message: 'No YouTube video is playing.' };
      const { sponsorSegments, segmentToSkip, nextSegment, CATEGORY_NAMES } = await import('./sponsorblock.js');
      const segments = await sponsorSegments(state.videoId);
      if (!segments.length) return { status: 'error', message: 'No one has marked a sponsor in this video.' };
      const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      const skip = segmentToSkip(segments, state.currentTime);
      if (!skip) {
        const next = nextSegment(segments, state.currentTime);
        return { status: 'success', message: next ? `There’s no sponsor right now. The next one is at ${clock(next.start)}.` : 'There are no more sponsors in this video.' };
      }
      const moved = await wsHub.sendToolToExtension('youtube', { action: 'seek', to: skip.end });
      return moved?.status === 'success'
        ? { status: 'success', message: `Skipped the ${CATEGORY_NAMES[skip.category] || 'sponsor'}.`, at: moved.at }
        : moved;
    },
  },

  // ── Gmail (after the Voqal library's gmail profile, Apache-2.0) ──
  // Ids are the ones in the Gmail part of the AI's context. Nothing here sends.
  {
    name: 'gmail_open_email',
    description: 'Open an email in Gmail by its id, and get its whole text (each message in the thread) to read out or summarise.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The email\'s id from the Gmail list.' } }, required: ['id'] },
    selector: { requiresExtension: true, site: 'mail.google.com' },
    execute: async (args, wsHub) => wsHub.sendToolToExtension('gmail', { action: 'open', id: args.id }),
  },
  {
    name: 'gmail_back_to_inbox',
    description: 'Go back from an open email to the Gmail inbox.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true, site: 'mail.google.com' },
    execute: async (_args, wsHub) => wsHub.sendToolToExtension('gmail', { action: 'back' }),
  },
  {
    name: 'gmail_select_emails',
    description: 'Select (tick) these emails in the Gmail list by their ids; every other email is unticked. Do this before gmail_mark_selected or gmail_delete_selected.',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'The ids of the emails to select.' } }, required: ['ids'] },
    selector: { requiresExtension: true, site: 'mail.google.com' },
    execute: async (args, wsHub) => wsHub.sendToolToExtension('gmail', { action: 'select', ids: Array.isArray(args.ids) ? args.ids : [args.ids] }),
  },
  {
    name: 'gmail_mark_selected',
    description: 'Mark the selected emails (or the open email) as read or unread, or archive them.',
    parameters: { type: 'object', properties: { as: { type: 'string', enum: ['read', 'unread', 'archive'] } }, required: ['as'] },
    selector: { requiresExtension: true, site: 'mail.google.com' },
    execute: async (args, wsHub) => wsHub.sendToolToExtension('gmail', { action: 'mark', as: args.as }),
  },
  {
    // "delete" in its name: the person is asked to confirm first (safety.js)
    name: 'gmail_delete_selected',
    description: 'Delete the selected emails (or the open email). The person is asked to confirm first.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true, site: 'mail.google.com' },
    execute: async (_args, wsHub) => wsHub.sendToolToExtension('gmail', { action: 'mark', as: 'delete' }),
  },
  {
    name: 'gmail_draft_reply',
    description: 'Write a reply to the open email in Gmail\'s reply box, without sending it. Only when the person asks for a reply.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'The reply, as the person would write it.' } }, required: ['text'] },
    selector: { requiresExtension: true, site: 'mail.google.com' },
    execute: async (args, wsHub) => wsHub.sendToolToExtension('gmail', { action: 'draft_reply', text: String(args.text || '') }),
  },

  // ── Notepad (after the Voqal library's notepad profile, Apache-2.0) ──
  {
    name: 'set_document_text',
    description: 'Replace all the text in the Notepad document in front with this text: for the edits the person asks for (add, change, remove, rewrite, fix). Write the whole new text, keeping every part they did not ask to change. "Undo that" puts the old text back.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'The whole new text of the document.' } }, required: ['text'] },
    selector: { app: 'notepad' },
    execute: async (args) => {
      const { setDocumentText } = await import('./document-text.js');
      return setDocumentText(args.text);
    },
  },

  // ── Page Interaction ──
  {
    name: 'right_click',
    description: 'Open a context menu on an element (right-click). Targets the focused element by default.',
    parameters: {
      type: 'object',
      properties: {
        xpath: { type: 'string', description: 'XPath of the element to right-click.' },
        query_selector: { type: 'string', description: 'CSS selector of the element to right-click.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('right_click', args);
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture a screenshot of the currently visible tab. Returns the image as a data URL.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('take_screenshot', {});
    },
  },
  {
    name: 'get_page_state',
    description: 'Force an immediate refresh of the page state including all visible elements, focused element, media state, and scroll position. Use when you need the latest page information.',
    parameters: { type: 'object', properties: {} },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('get_page_state', {});
    },
  },

  // ── Element Interaction (critical for voice commands) ──
  {
    name: 'click_element',
    description: 'Click an element on the current page. Give the xpath from the visible interactive elements list AND the label (the words on the element), so the right element is still found if the xpath no longer matches. This is the PRIMARY way to interact with web pages.',
    parameters: {
      type: 'object',
      properties: {
        xpath: { type: 'string', description: 'The XPath of the element to click (from the viewport elements list).' },
        label: { type: 'string', description: 'The words on the element, e.g. "Sign Up". Used to find it when the xpath is missing or no longer matches.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      if (!args.xpath && !clickWords(args.label).length) {
        return { status: 'error', message: 'Element not found: no xpath or label given' };
      }

      // The click runs in the page itself. ('javascript' runs in the
      // extension's sandbox on a COPY of the page: an xpath never matched
      // there, and a click on the copy did nothing.)
      const reply = await wsHub.sendToolToExtension('execute_script', clickScript(args));
      if (reply?.timedOut) return reply;
      const done = reply?.value;

      if (done?.status === 'success') {
        // A link that opens a new tab is opened here instead: Chrome blocks
        // a new tab that no real click asked for
        if (done.href) {
          await wsHub.sendToolToExtension('open_url', { url: done.href });
          return { status: 'success', message: `Opening ${spokenPageName(done.href, done.label)}.`, url: done.href };
        }
        return { status: 'success', message: `Clicked ${done.label ? `“${done.label}”` : 'it'}.` };
      }
      if (done?.status === 'error') return done;

      // The page does not allow scripts to be run this way (its security
      // policy), or cannot be scripted at all. The extension's own click
      // still works on the first kind; it needs an xpath and cannot report back.
      const xpath = args.xpath || xpathForLabel(wsHub.browserContext?.pageContext?.viewportElements, args.label);
      if (!xpath) {
        return { status: 'error', message: `Element not found: ${args.label || args.xpath}` };
      }
      console.log(`[Tools] click_element: page refused the script (${String(done ?? reply?.message ?? 'no reply').slice(0, 80)}) — using the extension's own click`);
      const fallback = await wsHub.sendToolToExtension('javascript', `(${JSON.stringify({ action: 'click', xpath })})`);
      if (fallback?.status === 'error') return fallback;
      return { status: 'success', message: 'Clicked.' };
    },
  },
  {
    name: 'select_option',
    description: 'Select a radio button, checkbox, tab, or dropdown option by its visible label text. ALWAYS use this instead of click_element when the user asks to select, choose, check, or toggle a form control (radio buttons, checkboxes, dropdown options, tabs). Uses fuzzy matching to find the element by its label text — much more reliable than xpath for form controls.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'The visible text label of the option to select (e.g. "Dark", "Light", "One-way", "Economy").' },
      },
      required: ['label'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      const code = `(${JSON.stringify({ action: 'select_option', label: args.label })})`;
      return wsHub.sendToolToExtension('javascript', code);
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the currently focused input field, or into a specific element identified by xpath. Use this for filling in search boxes, text fields, and forms.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type into the field.' },
        xpath: { type: 'string', description: 'Optional xpath of the input element. If not provided, types into the currently focused element.' },
        clear: { type: 'boolean', description: 'If true, clear the field before typing. Default is true.' },
      },
      required: ['text'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      let xpath = args.xpath;
      if (!xpath && args.label) {
        const elements = wsHub.browserContext?.pageContext?.viewportElements || [];
        const lower = args.label.toLowerCase();
        const match = elements.find(el => el.label && el.label.toLowerCase().includes(lower));
        if (match) xpath = match.xpath;
      }

      // Use content script's fill_input action — handles React/SPA inputs properly
      const action = { action: 'fill_input', text: args.text };
      if (xpath) action.xpath = xpath;
      const code = `(${JSON.stringify(action)})`;
      return wsHub.sendToolToExtension('javascript', code);
    },
  },

  // ── Navigate to Link by Text ──
  // More reliable than click_element for SPA pages (YouTube, Google, etc.)
  // where programmatic .click() is ignored by the framework's event system.
  // Extracts the href and sets location.href directly.
  {
    name: 'navigate_to_link',
    description: 'Find a link on the page by its text content and navigate to it by setting location.href. FAR more reliable than click_element for YouTube videos, Google results, or any SPA where programmatic clicks are ignored. Always prefer this over click_element when the target is an <a> link.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'What the person called the link, e.g. "Michael Jackson Wikipedia" or "the Wikipedia link". Matched word by word against each link\'s text and its web address, so a site name works too.' },
        index: { type: 'number', description: '0-based index when multiple links match (default: 0 = first match).' },
      },
      required: ['label'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      const escaped = JSON.stringify(linkWords(args.label));
      const phrase = JSON.stringify(String(args.label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
      const idx = typeof args.index === 'number' ? Math.max(0, args.index) : 0;

      // Step 1: Find the best matching link's raw href via content script.
      // Every word said must appear in the link's text or its address
      // ("Michael Jackson Wikipedia" → en.wikipedia.org/wiki/Michael_Jackson,
      // whose text runs "Michael JacksonWikipedia…" on Google). The exact
      // phrase, words in the visible text, and links on screen rank higher.
      const findCode = `(function(){
        var words = ${escaped};
        var phrase = ${phrase};
        var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
        var scored = [];
        Array.from(document.querySelectorAll('a[href]')).forEach(function (a) {
          var href = a.getAttribute('href') || '';
          if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
          var text = norm((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + (a.title || ''));
          var where = '';
          try { var u = new URL(a.href); where = norm(u.hostname + ' ' + decodeURIComponent(u.pathname)); } catch (e) {}
          var hay = text + ' ' + where;
          if (!words.length || !words.every(function (w) { return hay.indexOf(w) !== -1; })) return;
          var r = a.getBoundingClientRect();
          var shown = r.width > 0 && r.height > 0;
          var score = (phrase && text.indexOf(phrase) !== -1 ? 50 : 0)
            + words.filter(function (w) { return text.indexOf(w) !== -1; }).length * 10
            + (shown ? 20 : 0) + (shown && r.top >= 0 && r.top < innerHeight ? 10 : 0)
            - Math.min(text.length, 200) / 50;
          scored.push({ href: href, score: score });
        });
        scored.sort(function (x, y) { return y.score - x.score; });
        var best = scored[${idx}];
        return best ? best.href : 'NOT_FOUND';
      })()`;

      const result = await wsHub.sendToolToExtension('javascript', findCode);
      const rawHref = typeof result === 'string' ? result : result?.message || result?.result || '';

      if (!rawHref || rawHref === 'NOT_FOUND' || rawHref.includes('NOT_FOUND') || rawHref.includes('timeout')) {
        return { status: 'error', message: `No link found matching "${args.label}"` };
      }

      // Step 2: Resolve relative URL server-side using known page URL
      let fullUrl = rawHref;
      if (!fullUrl.startsWith('http')) {
        const pageUrl = wsHub.browserContext?.pageContext?.url || '';
        try { fullUrl = new URL(rawHref, pageUrl).href; } catch {}
      }

      if (!fullUrl.startsWith('http')) {
        return { status: 'error', message: `Could not resolve URL: ${rawHref.substring(0, 60)}` };
      }

      // Step 3: Navigate via open_url (background service worker — no timeout)
      await wsHub.sendToolToExtension('open_url', { url: fullUrl });
      // Said and shown to the person: what is opening, never the raw address
      return { status: 'success', message: `Opening ${spokenPageName(fullUrl, args.label)}.`, url: fullUrl };
    },
  },

  // ── JavaScript Execution ──
  {
    name: 'execute_javascript',
    description: 'Execute JavaScript code in the active browser tab. Use this for page interactions like clicking buttons, filling forms, reading text, or other custom actions.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The JavaScript code to execute in the active tab.' },
      },
      required: ['code'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      return wsHub.sendToolToExtension('javascript', args.code);
    },
  },
  {
    name: 'get_page_content',
    description: 'Get the text content of the currently active browser tab. Useful for reading articles, emails, or understanding what the user is looking at.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to get content from a specific element. If not provided, gets the full page text.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      // The page's own words, not its menus: big sites (Microsoft Learn, news,
      // docs) start with thousands of characters of navigation, so the first
      // 5,000 characters of <body> held no article at all.
      const code = args.selector
        ? `document.querySelector(${JSON.stringify(String(args.selector))})?.innerText || 'Element not found'`
        : PAGE_TEXT_SCRIPT;
      return wsHub.sendToolToExtension('javascript', code);
    },
  },

  // ── Search ──
  {
    name: 'search_web',
    description: 'Search the web using Google. Navigates the active tab to Google search results.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      const url = `https://www.google.com/search?q=${encodeURIComponent(args.query)}`;
      return wsHub.sendToolToExtension('open_url', { url });
    },
  },
  {
    name: 'search_youtube',
    description: 'Search for videos on YouTube. ONLY use this when the user explicitly asks to SEARCH. Do NOT use when the user asks to PLAY a song — use click_element or media_control instead.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The YouTube search query.' },
      },
      required: ['query'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(args.query)}`;
      // Use update_window action — content script sets location.href (YouTube SPA handles it)
      const code = `({"action": "update_window", "variable_name": "location.href", "variable_value": ${JSON.stringify(url)}})`;
      return wsHub.sendToolToExtension('javascript', code);
    },
  },

  // ── In-page Search (clear and re-search without navigating away) ──
  {
    name: 'search_in_page',
    description: 'Find the search bar on the current page, clear it, type a new query, and submit. Use this when the user is ALREADY on a search page (Google, YouTube, Wikipedia, etc.) and wants to search for something different. This clears the existing search text and types the new query. For a fresh Google search from any page, use search_web instead.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to type into the search bar.' },
      },
      required: ['query'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      const code = `(${JSON.stringify({ action: 'search_page', query: args.query })})`;
      return wsHub.sendToolToExtension('javascript', code);
    },
  },

  // ── Clear Field ──
  {
    name: 'clear_field',
    description: 'Clear the currently focused input field or search bar. Use when the user says "clear", "clear the search bar", "erase", etc.',
    parameters: {
      type: 'object',
      properties: {
        xpath: { type: 'string', description: 'Optional xpath of the input element to clear. If not provided, clears the currently focused element.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      const action = { action: 'clear_field' };
      if (args.xpath) action.xpath = args.xpath;
      const code = `(${JSON.stringify(action)})`;
      return wsHub.sendToolToExtension('javascript', code);
    },
  },

  // ── Conversational ──
  {
    // From the Voqal library's default profile (voqal/tools/ignore, Apache-2.0)
    name: 'ignore',
    description: 'Ignore what was heard because it was not said to you: song lyrics, a video or TV playing, other people talking, a cough, or empty or garbled words. Nothing happens and nothing is said. Never use it for a real request, even an unclear one.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'A few words on why, for the log (e.g. "song lyrics").' } },
    },
    selector: {},
    execute: async (args) => ({ status: 'success', ignored: true, reason: String(args?.reason || '').slice(0, 80) }),
  },
  {
    name: 'answer_question',
    description: 'Respond to the user with spoken text. Use this when the user asks a question or when you want to provide information without performing a browser action.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text response to speak to the user.' },
      },
      required: ['text'],
    },
    selector: {},
    execute: async (args, wsHub) => {
      // TTS will be handled by the dashboard
      return { status: 'success', text: args.text, spoken: true };
    },
  },
  {
    // Like Google's AI mode: a live Google search, answered out loud with its sources
    name: 'web_answer',
    description: 'Answer a question from a live Google search, out loud, with sources: people, places, organisations, news, weather, prices, scores, dates and other facts, or whenever the person asks to search, google or look up a question. Give the whole question, with names from the conversation filled in. No browser needed.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The whole question, e.g. "Who is Derrick Lubanga?"' } },
      required: ['question'],
    },
    selector: {},
    execute: async (args) => {
      const { webAnswer } = await import('./web-answer.js');
      return webAnswer(args.question);
    },
  },

  // ── System / Desktop Control (no extension needed) ──
  {
    name: 'system_media_control',
    description: 'Control media playback in desktop applications. IMPORTANT: when the user names a specific app ("pause Spotify", "next song on VLC"), ALWAYS pass app_name — without it, Windows sends the media key to whichever app played media most recently (often the browser, NOT the app the user meant).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'play_pause', 'next', 'previous', 'stop'], description: 'The media action to perform. Use "play" or "pause" for what the person said; "play_pause" only toggles.' },
        app_name: { type: 'string', description: 'Target application, e.g. "spotify" or "vlc". STRONGLY RECOMMENDED whenever the user names the app. Omit only for generic commands like "pause the music".' },
      },
      required: ['action'],
    },
    selector: {},
    execute: async (args) => {
      const { systemMediaControl } = await import('./system-tools.js');
      return systemMediaControl(args.action, args.app_name);
    },
  },
  {
    name: 'system_type_text',
    description: 'Type text into the currently focused DESKTOP application (Notepad, Word, any app). Use focus_application first to target a specific app. For typing in the BROWSER, use type_text instead.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type into the focused desktop application.' },
      },
      required: ['text'],
    },
    selector: {},
    execute: async (args) => {
      const { typeTextSystem } = await import('./system-tools.js');
      return typeTextSystem(args.text);
    },
  },
  {
    name: 'window_control',
    description: 'Manage the foreground desktop WINDOW: minimize, maximize, restore, or snap it to the left/right half of the screen. Use for "minimize this", "maximize the window", "snap left", "restore". For switching between apps use focus_application instead.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'snap_left', 'snap_right'], description: 'The window action.' },
      },
      required: ['action'],
    },
    selector: {},
    execute: async (args) => {
      const { windowControl } = await import('./system-tools.js');
      return windowControl(args.action);
    },
  },
  {
    name: 'system_volume',
    description: 'Control the system volume of the computer. Can mute, unmute, increase, decrease, or set to a specific level (0-100).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['mute', 'unmute', 'up', 'down', 'set'], description: 'The volume action.' },
        value: { type: 'number', description: 'For "set": level 0-100. For "up"/"down": number of steps (default 5).' },
      },
      required: ['action'],
    },
    selector: {},
    execute: async (args) => {
      const { systemVolume } = await import('./system-tools.js');
      return systemVolume(args.action, args.value);
    },
  },
  {
    name: 'focus_application',
    description: 'Bring a desktop application window to the foreground. Use this when the user wants to switch to an app like Spotify, Notepad, Chrome, VS Code, etc. Everyday names work ("Word document", "my spreadsheet"), and so does the title of an open document ("bring my essay to the front").',
    parameters: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'The name of the application (e.g. "Spotify", "Notepad", "Chrome").' },
      },
      required: ['app_name'],
    },
    selector: {},
    execute: async (args) => {
      const { focusApplication } = await import('./system-tools.js');
      return focusApplication(args.app_name);
    },
  },
  {
    name: 'open_application',
    description: 'Open/launch a desktop application. Supports common apps like Notepad, Calculator, Chrome, Spotify, VS Code, File Explorer, Settings, etc.',
    parameters: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'The name of the application to open (e.g. "notepad", "spotify", "calculator").' },
      },
      required: ['app_name'],
    },
    selector: {},
    execute: async (args) => {
      const { openApplication } = await import('./system-tools.js');
      return openApplication(args.app_name);
    },
  },
  {
    name: 'close_application',
    description: 'Close a running desktop application gracefully.',
    parameters: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'The name of the application to close (e.g. "notepad", "spotify").' },
      },
      required: ['app_name'],
    },
    selector: {},
    execute: async (args) => {
      // SAFETY: Never close browsers — use close_tab instead
      const browserNames = ['chrome', 'brave', 'edge', 'firefox', 'safari', 'opera'];
      if (browserNames.some(b => args.app_name.toLowerCase().includes(b))) {
        return { status: 'error', message: `Cannot close browser "${args.app_name}" — use close_tab to close individual tabs.` };
      }
      const { closeApplication } = await import('./system-tools.js');
      return closeApplication(args.app_name);
    },
  },
  {
    name: 'send_system_keys',
    description: 'Send keyboard shortcuts to the currently focused desktop application. Use this for shortcuts like Ctrl+C, Alt+F4, Ctrl+S, etc.',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'The keyboard shortcut (e.g. "Ctrl+C", "Alt+F4", "Ctrl+Shift+S", "Enter").' },
      },
      required: ['keys'],
    },
    selector: {},
    execute: async (args) => {
      const { sendKeys } = await import('./system-tools.js');
      return sendKeys(args.keys);
    },
  },
  // ── Desktop UI Automation — see and click anything in ANY desktop app ──
  {
    name: 'uia_query',
    description: "Read the controls in a desktop app window through Windows accessibility — fast, no screenshot needed. Returns each control's ref, type, name, position, state (focused, toggled, expanded, selected, current value, slider position) and the actions it supports: invoke, set_value, toggle, expand_collapse, select, scroll, scroll_into_view, read_text, set_range. Use this first to understand any desktop app, then act with uia_act using a ref. Omit app_name for the window the student is using.",
    parameters: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'The app or document to read (e.g. "word", "spotify", "my essay"). Omit for the window the student is using.' },
        name: { type: 'string', description: 'Only list controls whose name contains this text.' },
        limit: { type: 'number', description: 'Most controls to return (default 80, up to 200).' },
      },
    },
    selector: {},
    execute: async (args) => {
      const { getScreenModel, describeElements } = await import('./screen-model.js');
      const model = await getScreenModel({ app: args.app_name, fresh: true, maxElements: 400, restore: true });
      if (model.status !== 'success') return model;
      const filter = String(args.name || '').toLowerCase().trim();
      const matching = filter ? model.elements.filter(e => e.name.toLowerCase().includes(filter)) : model.elements;
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 80));
      const shown = matching.slice(0, limit);
      return {
        status: 'success',
        window: model.window,
        app: model.app,
        count: matching.length,
        total: model.total,
        ms: model.ms,
        elements: shown,
        message: `${model.window} — ${matching.length} control${matching.length === 1 ? '' : 's'}${matching.length > shown.length ? ` (first ${shown.length})` : ''}:\n${describeElements({ elements: shown }, limit)}`,
      };
    },
  },
  {
    name: 'uia_act',
    description: "Act on a control in a desktop app through its own accessibility action — press a button (invoke), switch a checkbox (toggle), pick a list or tab item (select), open or close a menu or tree item (expand / collapse), replace a field's text (set_value, with value), scroll a pane (scroll_up / scroll_down / scroll_left / scroll_right), bring a control into view (scroll_into_view), move a slider or spinner (set_range, with value a position on the min–max scale uia_query shows; that scale is the app's own and may not be the number on screen, so check what the result says it now shows and move again if needed), read a document's text (read_text; value picks how much: selection, word, line, paragraph, page, or all by default; with no ref or name it reads the document the student is in, at their cursor) or move focus (focus). Give the ref from uia_query, or the control's name. Leave action out to press it. Prefer this to clicking screen coordinates.",
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: "The control's ref from uia_query." },
        name: { type: 'string', description: "The control's visible name, if you have no ref." },
        app_name: { type: 'string', description: 'The app containing it. Omit for the window the student is using.' },
        action: {
          type: 'string',
          enum: ['invoke', 'toggle', 'select', 'expand', 'collapse', 'set_value', 'focus', 'scroll_into_view', 'scroll_up', 'scroll_down', 'scroll_left', 'scroll_right', 'read_text', 'set_range'],
          description: 'What to do. Omit to press the control.',
        },
        value: { type: 'string', description: 'Text for set_value; a number for set_range; for read_text, how much: selection, word, line, paragraph, page or all.' },
        type: { type: 'string', description: 'Only match controls of this type (e.g. "Button", "Edit") when using name.' },
      },
    },
    selector: {},
    execute: async (args, wsHub) => {
      // read_text alone reads the document in front ("read this paragraph").
      if (!args.ref && !args.name && args.action !== 'read_text') return { status: 'error', message: "Give a ref from uia_query or the control's name." };
      const { actOnElement } = await import('./screen-model.js');
      const result = await actOnElement({ ...args, app: args.app_name, studentId: studentOf(wsHub) });
      // "Open <file>" by name in a folder window: the file itself, by its path
      if (result.notFound && args.name && !args.ref && (!args.action || args.action === 'invoke')) {
        const { openFileInFolderWindow } = await import('./system-tools.js');
        const opened = await openFileInFolderWindow(args.name, args.app_name).catch(() => null);
        if (opened) return opened;
      }
      return result;
    },
  },
  {
    name: 'save_document_as',
    description: 'Save the document in the app in front under a new name, through the app\'s own Save As dialog: "save this as homework", "save it as notes in Documents". Opens the dialog, fills in the full path, presses Enter and checks the file is there. Never replaces an existing file unless replace is true, which needs the person to have said so.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The file name, e.g. "homework" or "notes.txt".' },
        folder: { type: 'string', description: 'Documents, Downloads, Desktop, Pictures, Music, Videos, or a full path. Leave out to save where the dialog opens.' },
        replace: { type: 'boolean', description: 'Replace a file of the same name. Only when the person said to.' },
      },
      required: ['name'],
    },
    selector: {},
    execute: async (args) => {
      const { saveDocumentAs } = await import('./system-tools.js');
      return saveDocumentAs(args);
    },
  },
  {
    name: 'fix_spelling',
    description: 'Fix a spelling mistake in Microsoft Word using Word’s own suggestions: the mistake at or nearest the cursor, or the misspelled word the person names. "fix that spelling" or "use the first suggestion" → choice 1; "use the second one" → choice 2; "what are the suggestions?" → choice 0 (lists them, changes nothing). Works without the Editor pane open.',
    parameters: {
      type: 'object',
      properties: {
        choice: { type: 'number', description: 'Which of Word’s suggestions to use, 1 = first (default). 0 only lists them.' },
        word: { type: 'string', description: 'The misspelled word, if the person named one. Leave out for the mistake at the cursor.' },
      },
    },
    selector: {},
    execute: async (args) => {
      const { fixSpelling } = await import('./office-uia.js');
      return fixSpelling({ choice: args.choice ?? 1, word: args.word || '' });
    },
  },
  {
    name: 'list_desktop_elements',
    description: 'Scan a desktop application window and list ALL its clickable elements (buttons, menus, inputs, list items) with their names. This is your EYES on desktop apps — use it when you need to know what can be clicked, or when click_desktop_element could not find an element. Omit app_name to scan the window the user is currently using.',
    parameters: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'The application to scan (e.g. "spotify", "notepad"). Omit for the currently active window.' },
      },
    },
    selector: {},
    execute: async (args) => {
      // Same answer as before, read through the faster screen model.
      const { getScreenModel } = await import('./screen-model.js');
      const model = await getScreenModel({ app: args.app_name, fresh: true, maxElements: 200, restore: true });
      if (model.status !== 'success') {
        const { listDesktopElements } = await import('./system-tools.js');
        return model.code === 'MINIMIZED' ? model : listDesktopElements(args.app_name);
      }
      const elements = model.elements
        .filter(e => e.actions.length && e.name)
        .slice(0, 60)
        .map(e => ({
          name: e.name, type: e.type, enabled: e.enabled !== false, ref: e.ref,
          x: Math.round(e.rect[0] + e.rect[2] / 2), y: Math.round(e.rect[1] + e.rect[3] / 2),
        }));
      return {
        status: 'success',
        window: model.window,
        count: elements.length,
        elements,
        message: `Found ${elements.length} interactive elements in "${model.window}": ` +
          elements.slice(0, 25).map(e => `"${e.name}" (${e.type})`).join(', '),
      };
    },
  },
  {
    name: 'click_desktop_element',
    description: 'Click a button, menu, or any element INSIDE a desktop application by its visible name (e.g. click "Play" in Spotify, "Save" in Notepad). Works on ANY Windows app. Uses the accessibility Invoke action with a real mouse click fallback. If the element is not found, use list_desktop_elements to see available names. Can also click raw screen coordinates via x/y.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Visible name/label of the element to click (case-insensitive, partial match OK).' },
        app_name: { type: 'string', description: 'The application containing the element (e.g. "spotify"). Omit for the currently active window.' },
        x: { type: 'number', description: 'Screen X coordinate (alternative to name; use coordinates from list_desktop_elements).' },
        y: { type: 'number', description: 'Screen Y coordinate (alternative to name).' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button. Default left.' },
        double_click: { type: 'boolean', description: 'Double-click (e.g. to open items). Default false.' },
      },
    },
    selector: {},
    execute: async (args, wsHub) => {
      const { clickDesktopElement, mouseClick } = await import('./system-tools.js');
      const { actOnElement, recordResolution, resolveTargetWindow } = await import('./screen-model.js');
      const studentId = studentOf(wsHub);
      const plainClick = !args.double_click && (args.button || 'left') === 'left';

      // By name: act through the control's accessibility action first.
      if (args.name && plainClick) {
        const result = await actOnElement({ app: args.app_name, name: args.name, studentId });
        if (result.notFound) {
          // "Open <file>" in a folder window: the file itself, by its path
          const { openFileInFolderWindow } = await import('./system-tools.js');
          const opened = await openFileInFolderWindow(args.name, args.app_name).catch(() => null);
          return opened || result;
        }
        if (result.status === 'success' || result.code === 'MINIMIZED') return result;
        // Found, but it would not take the action: click where it is.
        if (result.element?.rect && ['NOT_SUPPORTED', 'FAILED'].includes(result.code)) {
          const [x, y, w, h] = result.element.rect;
          const clicked = await mouseClick(x + w / 2, y + h / 2);
          return { ...clicked, message: `Clicked "${result.element.name}"` };
        }
        // The screen model could not read the window: use the older scan.
      }

      // A double-click by name (open a file or icon): find it through the
      // screen model too. The older scan missed Explorer's files, so "open
      // ablespeak-eval.txt" found nothing (agent eval, 24 Oct 2026). An item
      // that can be opened through its own action (Explorer's files support
      // invoke) is opened that way; otherwise it is double-clicked where it is.
      if (args.name && args.double_click && (args.button || 'left') === 'left') {
        // In a folder window, a file is opened by its path (Explorer hides extensions)
        const { openFileInFolderWindow } = await import('./system-tools.js');
        const opened = await openFileInFolderWindow(args.name, args.app_name).catch(() => null);
        if (opened) return opened;
        const { getScreenModel, findElement } = await import('./screen-model.js');
        const model = await getScreenModel({ app: args.app_name, maxElements: 400, restore: true }).catch(() => null);
        const found = model?.status === 'success' ? findElement(model, args.name, { type: args.type }) : null;
        if (found?.actions?.includes('invoke')) {
          const opened = await actOnElement({ app: args.app_name, ref: found.ref, action: 'invoke', studentId });
          if (opened.status === 'success') return { ...opened, message: `Opened "${found.name}"` };
        }
        if (found?.rect) {
          const [x, y, w, h] = found.rect;
          const clicked = await mouseClick(x + w / 2, y + h / 2, 'left', true);
          return { ...clicked, message: `Double-clicked "${found.name}"` };
        }
      }

      // A bare screen position (usually read off the screenshot) is a pixel,
      // not a control — counted separately for the UIA resolution rate.
      if (typeof args.x === 'number' && typeof args.y === 'number' && !args.name) {
        const win = await resolveTargetWindow(args.app_name).catch(() => null);
        recordResolution({ app: win?.process || args.app_name, method: 'coordinates', action: 'click', started: Date.now(), studentId });
      }
      return clickDesktopElement(args);
    },
  },
  {
    name: 'read_desktop_window',
    description: 'Read the visible text content of a desktop application window (dialogs, messages, documents, status text). Use this to tell the user what an app is showing — e.g. reading an error dialog or a document in Notepad.',
    parameters: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'The application to read (e.g. "notepad"). Omit for the currently active window.' },
      },
    },
    selector: {},
    execute: async (args) => {
      const { readDesktopWindow } = await import('./system-tools.js');
      return readDesktopWindow(args.app_name);
    },
  },
  {
    name: 'desktop_scroll',
    description: 'Scroll inside a desktop application window (NOT the browser — use scroll for browser pages). Sends mouse-wheel events to the app.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
        amount: { type: 'number', description: 'Scroll strength in wheel notches (1-20). Default 3.' },
        app_name: { type: 'string', description: 'The application to scroll. Omit for the currently active window.' },
      },
      required: ['direction'],
    },
    selector: {},
    execute: async (args) => {
      const { desktopScroll } = await import('./system-tools.js');
      return desktopScroll(args.direction, args.amount, args.app_name);
    },
  },
  {
    name: 'list_running_apps',
    description: 'List all currently running applications with visible windows on the computer.',
    parameters: {
      type: 'object',
      properties: {},
    },
    selector: {},
    execute: async () => {
      const { listApplications } = await import('./system-tools.js');
      return listApplications();
    },
  },

  // ── AbleSpeak Dashboard Control (Accessibility — voice-navigable UI) ──
  {
    name: 'navigate_dashboard',
    description: 'Open one of the user\'s own AbleSpeak pages: home ("show dashboard"), their progress ("show my progress") or their voice and words ("open my words"). The admin pages (users, test console, Developer Hub, Settings) need the admin PIN and cannot be opened by voice: if asked for them, answer "That page is for your teacher." A plain "open settings" usually means the Windows or app settings, not this dashboard.',
    parameters: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: ['dashboard', 'progress', 'speech'],
          description: 'The dashboard page to navigate to.',
        },
      },
      required: ['page'],
    },
    selector: {},
    execute: async (args, wsHub) => {
      // The user's own pages; admin pages (users, test console, Developer Hub, Settings) are PIN-only.
      const pageMap = {
        dashboard: '/',
        progress: '/progress',
        speech: '/speech',
      };
      if (!pageMap[args.page]) {
        return { status: 'error', message: 'That page is for your teacher.' };
      }
      const path = pageMap[args.page];
      wsHub.broadcastToDashboard({
        type: 'dashboard_navigate',
        path,
        page: args.page,
      });
      return { status: 'success', message: `Navigated to ${args.page} page` };
    },
  },
  {
    name: 'switch_ai_provider',
    description: 'Switch the AI language model provider and/or model. Use when the user says "switch to OpenAI", "use GPT-4", "change to Gemini", "use Claude", etc.',
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['gemini', 'openai', 'anthropic'],
          description: 'The AI provider to switch to.',
        },
        model: {
          type: 'string',
          description: 'Optional specific model name (e.g. "gpt-4o", "gemini-2.0-flash", "claude-sonnet-4-20250514").',
        },
      },
      required: ['provider'],
    },
    selector: {},
    execute: async (args) => {
      try {
        const res = await fetch(`http://localhost:${process.env.GATEWAY_PORT || 3001}/api/ai/switch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: args.provider, model: args.model }),
        });
        const data = await res.json();
        if (!res.ok) {
          return { status: 'error', message: data.error || 'Failed to switch provider' };
        }
        return { status: 'success', message: `Switched to ${data.name} / ${data.model}` };
      } catch (err) {
        return { status: 'error', message: err.message };
      }
    },
  },
  {
    name: 'toggle_continuous_mode',
    description: 'Enable or disable continuous listening mode. When ON, the microphone automatically restarts after each command for fully hands-free operation. When OFF, the mic stops after one command.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'True to enable continuous listening, false to disable.' },
      },
      required: ['enabled'],
    },
    selector: {},
    execute: async (args, wsHub) => {
      wsHub.broadcastToDashboard({
        type: 'dashboard_setting',
        setting: 'continuousMode',
        value: args.enabled,
      });
      return {
        status: 'success',
        message: `Continuous listening ${args.enabled ? 'enabled' : 'disabled'}. ${args.enabled ? 'Mic will auto-restart after each command.' : 'Mic will stop after one command.'}`,
      };
    },
  },
  {
    name: 'set_silence_timeout',
    description: 'Set how long to wait for silence before stopping the microphone. Longer values help users with speech impairments who need more time between words. Range: 1-8 seconds.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Silence timeout in seconds (1-8). Default is 2.5.' },
      },
      required: ['seconds'],
    },
    selector: {},
    execute: async (args, wsHub) => {
      const ms = Math.max(1000, Math.min(8000, Math.round(args.seconds * 1000)));
      wsHub.broadcastToDashboard({
        type: 'dashboard_setting',
        setting: 'silenceTimeout',
        value: ms,
      });
      return { status: 'success', message: `Silence timeout set to ${ms / 1000} seconds` };
    },
  },
  {
    name: 'clear_chat_history',
    description: 'Clear the AbleSpeak conversation history and start fresh.',
    parameters: { type: 'object', properties: {} },
    selector: {},
    execute: async () => {
      try {
        await fetch(`http://localhost:${process.env.GATEWAY_PORT || 3001}/api/ai/clear`, { method: 'POST' });
        return { status: 'success', message: 'Conversation history cleared. Starting fresh.' };
      } catch (err) {
        return { status: 'error', message: err.message };
      }
    },
  },
];

/**
 * The words that identify a link: what was said, without filler such as
 * "the", "link", "open" or "click on". "the Wikipedia link" → ["wikipedia"].
 */
/**
 * Runs in the page (get_page_content): the title and the main content —
 * <main>, <article> or role="main" when it holds real text — with tidy spacing.
 */
export const PAGE_TEXT_SCRIPT = `(() => {
  const picks = ['main article', 'article', 'main', '[role="main"]', '#main-content', '#main', '#content'];
  let el = null;
  for (const s of picks) {
    const found = document.querySelector(s);
    if (found && (found.innerText || '').trim().length > 200) { el = found; break; }
  }
  const text = ((el || document.body).innerText || '')
    .replace(/[ \\t\\u00a0]+/g, ' ')
    .replace(/\\s*\\n\\s*(\\n\\s*)+/g, '\\n\\n')
    .trim();
  return (document.title ? 'Title: ' + document.title + '\\n\\n' : '') + text.substring(0, 8000);
})()`;

/**
 * A web page as a person would say it: "Michael Jackson on Wikipedia", the
 * link's own words, or the site's name — never "https://en.wikipedia.org/…".
 */
export function spokenPageName(url, label = '') {
  let parsed;
  try { parsed = new URL(url); } catch { return 'the link'; }
  const host = parsed.hostname.replace(/^www\./, '');
  if (/(^|\.)wikipedia\.org$/.test(host)) {
    const article = parsed.pathname.match(/^\/wiki\/([^/?#]+)/);
    if (article) {
      let title = article[1];
      try { title = decodeURIComponent(title); } catch {}
      title = title.replace(/_/g, ' ').trim();
      if (title && !title.includes(':')) return `${title} on Wikipedia`;
    }
    return 'Wikipedia';
  }
  const words = String(label || '').replace(/\s+/g, ' ').trim();
  if (words && words.length <= 60 && !/^https?:|^www\./i.test(words)) return `“${words}”`;
  return host;
}

export function linkWords(label) {
  const FILLER = new Set(['the', 'a', 'an', 'link', 'links', 'open', 'click', 'on', 'go', 'to', 'page', 'website', 'site', 'result', 'please', 'one']);
  return String(label || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !FILLER.has(w));
}

/** The words that name an element: "the sign up button" → sign, up. */
export function clickWords(label) {
  const FILLER = new Set(['the', 'a', 'an', 'button', 'buttons', 'link', 'tab', 'icon', 'option', 'click', 'press', 'on', 'please']);
  return String(label || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !FILLER.has(w));
}

/** The xpath of the element on screen that carries every word of the label. */
export function xpathForLabel(elements, label) {
  const words = clickWords(label);
  if (!words.length) return null;
  const match = (elements || []).find(el => {
    const have = String(el.label || '').toLowerCase().split(/[^a-z0-9]+/);
    return words.every(w => have.includes(w));
  });
  return match?.xpath || null;
}

/**
 * The script click_element runs in the page. It finds the element by xpath,
 * or by its words when the xpath is missing, matches nothing, or matches
 * something that does not carry those words; then clicks it and says what it
 * clicked. A link that opens a new tab is returned as `href` and not clicked.
 */
export function clickScript({ xpath, label } = {}) {
  return `(function(){
    var xpath = ${JSON.stringify(xpath || '')};
    var words = ${JSON.stringify(clickWords(label))};
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
    var nameOf = function (el) {
      return norm([el.getAttribute('aria-label'), el.innerText, el.value, el.getAttribute('title'), el.getAttribute('placeholder'), el.getAttribute('alt')].join(' '));
    };
    var carries = function (name) { var have = name.split(' '); return words.every(function (w) { return have.indexOf(w) !== -1; }); };
    var shown = function (el) {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      var s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    var byXPath = null;
    if (xpath) {
      try { byXPath = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) {}
    }
    var el = byXPath;
    if (words.length && !(el && carries(nameOf(el)))) {
      var best = null, bestScore = -Infinity, said = words.join(' ');
      document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [onclick], [tabindex]:not([tabindex="-1"])').forEach(function (c) {
        if (!shown(c)) return;
        var name = nameOf(c);
        if (!carries(name)) return;
        var r = c.getBoundingClientRect();
        var score = (name === said ? 50 : 0) + (r.bottom > 0 && r.top < innerHeight ? 20 : 0) - Math.min(name.length, 200) / 50;
        if (score > bestScore) { bestScore = score; best = c; }
      });
      el = best || byXPath;
    }
    if (!el) return { status: 'error', message: 'Element not found on this page: ' + (words.join(' ') || xpath) };
    var label = String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { status: 'error', message: '"' + label + '" is switched off on this page right now.' };
    var a = el.closest('a[href]');
    var href = a ? (a.getAttribute('href') || '') : '';
    if (a && a.target === '_blank' && href && href.charAt(0) !== '#' && !/^javascript:/i.test(href)) {
      return { status: 'success', href: a.href, label: label };
    }
    el.scrollIntoView({ block: 'center' });
    if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (e) {} }
    ['mousedown', 'mouseup'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { status: 'success', clicked: true, label: label };
  })()`;
}

// Tools the AI almost never needs (none was used in 288 AI commands up to
// 17 Oct 2026), sent with a command only when its words ask for them. Each
// tool sent makes every request bigger and slower: a one-step command took
// 0.92 s with 17 tools and 1.55 s with all 56 (median of 3, measured).
export const ON_REQUEST = {
  duplicate_tab: /\bduplicate\b|\bcopy (this|the) tab\b/,
  pin_tab: /\b(un)?pin\b/,
  mute_tab: /\b(un)?mute\b|\bsilence\b/,
  find_tab: /\btabs?\b/,
  list_tabs: /\btabs?\b/,
  zoom_tab: /\bzoom\b|\bbigger\b|\bsmaller\b|\blarger\b|\bmagnif/,
  focus_next: /\bnext\b.*\b(field|box|button|item|link|control)\b/,
  focus_prev: /\b(previous|last|back)\b.*\b(field|box|button|item|link|control)\b/,
  right_click: /\bright[- ]?click\b|\bcontext menu\b/,
  take_screenshot: /\bscreen ?shot\b|\bcapture\b|\bsnip\b/,
  get_page_state: /\btabs?\b|\bpage state\b/,
  execute_javascript: /\bjava ?script\b|\bscript\b/,
  list_running_apps: /\b(apps?|programs?|applications?|windows?)\b.*\b(open|running)\b|\bwhat('s| is) open\b/,
  switch_ai_provider: /\b(provider|openai|gpt|claude|anthropic|gemini|ai model)\b/,
  set_silence_timeout: /\b(silence|timeout|pause length|wait (longer|less))\b/,
  clear_chat_history: /\b(clear|delete|forget|reset)\b.*\b(chat|history|conversation)\b/,
};

// Words that mean a site's tools may be needed even from another page
const SITE_WORDS = { 'youtube.com': /\b(youtube|videos?|watch|play)\b/ };

/** Whether a page's address is on a site: "https://m.youtube.com/watch?v=1" is on "youtube.com". */
export function onSite(url, site) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === site || host.endsWith(`.${site}`);
  } catch {
    return false;
  }
}

// ── Tool Registry Class ──

export class ToolRegistry {
  constructor() {
    this.tools = [...TOOLS];
    this.pendingToolCalls = new Map();
  }

  /** The desktop control a uia_act / click_desktop_element call will press, or null. */
  async findDesktopControl(args) {
    const { getScreenModel, findElement } = await import('./screen-model.js');
    const model = await getScreenModel({ app: args.app_name, maxElements: 400 });
    if (model.status !== 'success') return null;
    return args.ref
      ? model.elements.find(e => e.ref === args.ref) || null
      : findElement(model, args.name, { type: args.type });
  }

  /**
   * Get tools available for the current context
   */
  getToolsForContext(context = {}, said = '') {
    const hasExtension = context.extensionConnected !== false;
    const words = typeof said === 'string' ? said.toLowerCase() : '';

    return this.tools
      .filter(tool => {
        if (tool.selector.requiresExtension && !hasExtension) return false;
        // With the person's words: rarely needed tools only when the words ask for them
        if (words && ON_REQUEST[tool.name] && !ON_REQUEST[tool.name].test(words)) return false;
        // A site's own tools only while the active tab is on that site (YouTube),
        // or when the words are about it ("play Thriller": search, then pick one)
        if (tool.selector.site && !onSite(context.activeTab?.url, tool.selector.site)
            && !(words && SITE_WORDS[tool.selector.site]?.test(words))) return false;
        // An app's own tools only while that app is in front (Notepad)
        if (tool.selector.app && String(context.screenModel?.app || '').toLowerCase().replace(/\.exe$/, '') !== tool.selector.app) return false;
        return true;
      })
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  /**
   * Execute a tool by name
   */
  async executeTool(name, args, wsHub, opts = {}) {
    const tool = this.tools.find(t => t.name === name);
    if (!tool) {
      return { status: 'error', error: `Unknown tool: ${name}` };
    }
    // During an exam no tool runs: nothing may open, search, type or click
    if (this.examLock?.()) {
      return { status: 'error', error: 'An exam is running, so AbleSpeak\'s tools are switched off until it ends.' };
    }

    // ── Consequential-action gate ──────────────────────────────────────────
    // For a student who cannot grab a mouse to undo, an irreversible action
    // triggered by a misheard word is disqualifying. Any tool classified as
    // consequential (close-app, delete, send/submit/post) is NOT executed on
    // first request — instead we stash it on the hub and ask for explicit
    // spoken confirmation. Passing { confirmed: true } (after the user says
    // "yes") bypasses the gate. This is the single chokepoint for BOTH the
    // fast path and the AI tool-calling loop.
    if (!opts.confirmed) {
      const consequence = classifyConsequential(name, await this._resolveGateArgs(name, args, wsHub), await this._gateWhere(name, args, wsHub));
      if (consequence) {
        if (wsHub) {
          wsHub._pendingConfirmation = { tool: name, args, prompt: consequence.prompt, id: consequence.id };
        }
        return {
          status: 'needs_confirmation',
          needsConfirmation: true,
          prompt: consequence.prompt,
          message: consequence.prompt,
          tool: name,
        };
      }
    }

    try {
      const result = await tool.execute(args, wsHub);
      return result || { status: 'success' };
    } catch (err) {
      console.error(`[ToolRegistry] Error executing ${name}:`, err.message);
      return { status: 'error', error: err.message };
    }
  }

  /**
   * Where a key that sends or deletes only in some apps (safety.js) would
   * land: the app in front and the browser's active tab. Looked up only for
   * those keys; a lookup that fails or is slow leaves it unknown, and then
   * the gate asks anyway.
   */
  async _gateWhere(name, args, wsHub) {
    // A key that answers a dialog (Enter, Y) matters only for what is in front
    const answerKey = name === 'send_system_keys' && /^(?:enter|space|y|alt\+y)$/i.test(String(args?.keys || '').replace(/\s+/g, ''));
    if (!appDependentKey(name, args) && !answerKey) return {};
    const tabUrl = wsHub?.browserContext?.activeTab?.url || null;
    // press_key_combination always goes to the browser's tab
    if (name !== 'send_system_keys') return { tabUrl };
    let timer;
    const front = await Promise.race([
      Promise.resolve().then(() => this.keyTarget()).catch(() => null),
      new Promise(resolve => { timer = setTimeout(resolve, FRONT_WINDOW_WAIT_MS, null); }),
    ]).finally(() => clearTimeout(timer));
    return { frontApp: front?.process || null, frontTitle: front?.title || null, tabUrl };
  }

  /** The app send_system_keys would press keys into: { process, title } or null. */
  async keyTarget() {
    const { keyTargetApp } = await import('./system-tools.js');
    return keyTargetApp();
  }

  /**
   * click_element is often called with only an xpath (no label) — the AI reads
   * it straight off the viewport-elements list. Resolve the element's visible
   * text the same way click_element's own execute() resolves label → xpath, but
   * in reverse, so the safety gate can see what's actually about to be clicked
   * instead of gating on the tool name alone (CVA-1).
   */
  async _resolveGateArgs(name, args, wsHub) {
    // Desktop controls: gate on the control that will actually be pressed —
    // a ref carries no name, and a spoken name may match a longer one
    // ("receive" → "Send/Receive").
    if ((name === 'uia_act' || name === 'click_desktop_element') && (args?.ref || args?.name)) {
      try {
        const element = await this.findDesktopControl(args);
        if (element?.name) return { ...args, resolvedLabel: element.name };
      } catch {
        // The screen could not be read; gate on the words given.
      }
      return args;
    }
    if (name !== 'click_element' || args?.label || !args?.xpath || !wsHub) return args;
    const elements = wsHub.browserContext?.pageContext?.viewportElements || [];
    const match = elements.find(el => el.xpath === args.xpath);
    return match?.label ? { ...args, resolvedLabel: match.label } : args;
  }

  /**
   * List all registered tools
   */
  listTools() {
    return this.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      selector: t.selector,
    }));
  }
}
