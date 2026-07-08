/**
 * AbleSpeak Tool Registry
 * 
 * Defines all available tools in OpenAI function-calling format.
 * Mirrors Voqal's YAML tool schemas but in JavaScript.
 * Tools are context-aware — only included when their selector matches.
 */

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { classifyConsequential } from './safety.js';

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
    description: 'Control video or audio playback on the page. Actions: play, pause, toggle, seek (set time), seek_by (skip forward/back), volume (0-100), mute, unmute, rate (playback speed).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'toggle', 'seek', 'seek_by', 'volume', 'mute', 'unmute', 'rate'], description: 'The media action to perform.' },
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
    description: 'Click an element on the current page. Use the xpath from the visible interactive elements list, OR provide a label to search for. This is the PRIMARY way to interact with web pages.',
    parameters: {
      type: 'object',
      properties: {
        xpath: { type: 'string', description: 'The XPath of the element to click (from the viewport elements list).' },
        label: { type: 'string', description: 'Text label of the element to click. Used as fallback if xpath is not provided.' },
      },
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      let xpath = args.xpath;

      // If label provided but no xpath, resolve label → xpath from viewport elements
      if (!xpath && args.label) {
        const elements = wsHub.browserContext?.pageContext?.viewportElements || [];
        const lower = args.label.toLowerCase();
        const match = elements.find(el =>
          el.label && el.label.toLowerCase().includes(lower)
        );
        if (match) xpath = match.xpath;
      }

      if (!xpath) {
        return { status: 'error', message: `Element not found: ${args.label || 'no xpath provided'}` };
      }

      // Smart click: dispatch mouse events, and for <a> elements extract the raw href
      const code = `(function(){
        var el = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!el) return JSON.stringify({action:'click',error:'element not found'});
        el.scrollIntoView({block:'center'});
        ['mousedown','mouseup','click'].forEach(function(t){
          el.dispatchEvent(new MouseEvent(t, {bubbles:true,cancelable:true,view:window}));
        });
        var a = el.closest('a[href]') || (el.tagName === 'A' && el.getAttribute('href') ? el : null);
        if (a && a.getAttribute('href') && !a.getAttribute('href').startsWith('javascript:')) {
          return JSON.stringify({action:'click',rawHref:a.getAttribute('href')});
        }
        return JSON.stringify({action:'click',clicked:true});
      })()`;

      const result = await wsHub.sendToolToExtension('javascript', code);

      // If the click was on an <a> link, resolve the URL server-side and navigate
      try {
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (parsed?.rawHref) {
          let fullUrl = parsed.rawHref;
          if (!fullUrl.startsWith('http')) {
            // Resolve relative URL using the known page URL from browser context
            const pageUrl = wsHub.browserContext?.pageContext?.url || '';
            try { fullUrl = new URL(parsed.rawHref, pageUrl).href; } catch {}
          }
          if (fullUrl.startsWith('http')) {
            await wsHub.sendToolToExtension('open_url', { url: fullUrl });
            return { status: 'success', message: `Clicked and navigated to: ${fullUrl.substring(0, 80)}` };
          }
        }
      } catch {}

      return result;
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
        label: { type: 'string', description: 'Text to match against link labels on the page (partial, case-insensitive).' },
        index: { type: 'number', description: '0-based index when multiple links match (default: 0 = first match).' },
      },
      required: ['label'],
    },
    selector: { requiresExtension: true },
    execute: async (args, wsHub) => {
      const escaped = JSON.stringify((args.label || '').toLowerCase());
      const idx = typeof args.index === 'number' ? Math.max(0, args.index) : 0;

      // Step 1: Find the matching link's raw href via content script
      const findCode = `(function(){
        var links = Array.from(document.querySelectorAll('a[href]'));
        var matches = links.filter(function(a){
          var t = (a.textContent || a.getAttribute('aria-label') || a.title || '').trim().toLowerCase();
          return t.includes(${escaped});
        });
        var el = matches[${idx}];
        if (el && el.getAttribute('href')) return el.getAttribute('href');
        return 'NOT_FOUND';
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
      return { status: 'success', message: `Navigated to: ${fullUrl.substring(0, 80)}` };
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
      const code = args.selector
        ? `document.querySelector('${args.selector}')?.innerText || 'Element not found'`
        : `document.body.innerText.substring(0, 5000)`;
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

  // ── System / Desktop Control (no extension needed) ──
  {
    name: 'system_media_control',
    description: 'Control media playback in desktop applications. IMPORTANT: when the user names a specific app ("pause Spotify", "next song on VLC"), ALWAYS pass app_name — without it, Windows sends the media key to whichever app played media most recently (often the browser, NOT the app the user meant).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'stop'], description: 'The media action to perform.' },
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
    description: 'Bring a desktop application window to the foreground. Use this when the user wants to switch to an app like Spotify, Notepad, Chrome, VS Code, etc.',
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
      const { listDesktopElements } = await import('./system-tools.js');
      return listDesktopElements(args.app_name);
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
    execute: async (args) => {
      const { clickDesktopElement } = await import('./system-tools.js');
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
    description: 'Navigate the AbleSpeak dashboard to a specific page. Use when the user says "go to settings", "open chat", "show tools", "show logs", "show commands", "go to context", "show dashboard", or "open prompt editor".',
    parameters: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: ['dashboard', 'chat', 'tools', 'context', 'commands', 'logs', 'settings', 'prompt'],
          description: 'The dashboard page to navigate to.',
        },
      },
      required: ['page'],
    },
    selector: {},
    execute: async (args, wsHub) => {
      const pageMap = {
        dashboard: '/',
        chat: '/chat',
        tools: '/tools',
        context: '/context',
        commands: '/commands',
        logs: '/logs',
        settings: '/settings',
        prompt: '/prompt',
      };
      const path = pageMap[args.page] || '/';
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
          enum: ['gemini', 'openai', 'anthropic', 'groq'],
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

// ── Tool Registry Class ──

export class ToolRegistry {
  constructor() {
    this.tools = [...TOOLS];
    this.pendingToolCalls = new Map();
  }

  /**
   * Get tools available for the current context
   */
  getToolsForContext(context = {}) {
    const hasExtension = context.extensionConnected !== false;

    return this.tools
      .filter(tool => {
        if (tool.selector.requiresExtension && !hasExtension) return false;
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

    // ── Consequential-action gate ──────────────────────────────────────────
    // For a student who cannot grab a mouse to undo, an irreversible action
    // triggered by a misheard word is disqualifying. Any tool classified as
    // consequential (close-app, delete, send/submit/post) is NOT executed on
    // first request — instead we stash it on the hub and ask for explicit
    // spoken confirmation. Passing { confirmed: true } (after the user says
    // "yes") bypasses the gate. This is the single chokepoint for BOTH the
    // fast path and the AI tool-calling loop.
    if (!opts.confirmed) {
      const consequence = classifyConsequential(name, args);
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
