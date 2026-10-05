/**
 * AbleSpeak Fast Command Router
 * 
 * Intercepts common voice commands and executes them INSTANTLY
 * without going through the LLM. This cuts response time from
 * ~5-15 seconds to ~200ms for simple navigation commands.
 * 
 * IMPORTANT: Gemini transcription adds punctuation (periods, commas)
 * and sometimes extra words ("on this tab", "please").
 * All patterns must tolerate this.
 */

import { resolveAppName } from './app-names.js';

// AbleSpeak dashboard pages that can be opened by voice ("go to students")
const NAV_MAP = {
  dashboard: 'dashboard', home: 'dashboard',
  progress: 'progress', 'my progress': 'progress',
  'speech profile': 'speech', 'speech settings': 'speech', 'voice and words': 'speech', 'my words': 'speech', 'voice settings': 'speech',
};

// The admin pages (managing users, the test console, Developer Hub, Settings)
// need the admin PIN (admin-pin.js), so voice never opens them. Their own names get a spoken answer; everyday words
// that used to open them ("settings", "tools", "logs") go to the AI instead,
// since a student saying them usually means the app in front of them.
const ADMIN_PAGE_NAMES = new Set(['developer hub', 'developer', 'admin', 'admin pages', 'prompt editor',
  'users', 'students', 'teacher', 'teacher page', 'test console', 'chat']);
const ADMIN_PAGE_WORDS = new Set(['tools', 'context', 'logs', 'settings', 'preferences', 'options', 'prompt']);
const isDashboardName = name => !!NAV_MAP[name] || ADMIN_PAGE_NAMES.has(name) || ADMIN_PAGE_WORDS.has(name);

// ── Silent commands: these execute without TTS feedback ──
const SILENT_COMMANDS = new Set([
  'scroll', 'scroll_to_top', 'scroll_to_bottom',
  'go_back', 'go_forward', 'focus_next', 'focus_prev',
  'reload_tab', 'close_tab', 'click_element', 'select_option',
  'search_in_page', 'clear_field',
  'press_key_combination', 'media_control',
  'system_media_control', 'system_volume',
  'send_system_keys', 'focus_application',
  // Action commands — execute silently, restart mic immediately
  'create_tab', 'open_url', 'make_tab_active',
  'open_application', 'close_application',
  'desktop_scroll', 'system_type_text', 'mouse_click',
  'click_desktop_element', 'window_control',
]);

// ── Browser tools: auto-focus Chrome after these ──
const BROWSER_TOOLS = new Set([
  'create_tab', 'open_url', 'make_tab_active', 'close_tab',
  'reload_tab', 'go_back', 'go_forward', 'scroll',
  'scroll_to_top', 'scroll_to_bottom', 'scroll_element',
  'click_element', 'navigate_to_link', 'select_option', 'type_text', 'search_web', 'search_youtube', 'search_in_page',
  'clear_field',
  'media_control', 'focus_next', 'focus_prev',
  'get_page_content', 'get_page_state',
  'press_key_combination', 'right_click',
  'zoom_tab', 'pin_tab', 'mute_tab',
]);

/**
 * Clean transcription text: remove punctuation, trailing filler words.
 * Gemini often outputs "Scroll down." or "Scroll down on this tab." 
 */
function cleanTranscription(text) {
  return text
    .toLowerCase()
    .trim()
    // Remove trailing punctuation
    .replace(/[.,!?;:]+$/g, '')
    // Remove common filler suffixes
    .replace(/\s+(please|now|for me|on this tab|on this page|on the page|on the tab|on the screen)$/gi, '')
    .trim();
}

/**
 * Pattern-based fast command matching.
 * Returns { tool, args, silent } or null if no match.
 */
// Pages with their own search bar, where "search for X" searches again in place
const SEARCH_PAGE = /^https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com\/|(?:m\.)?youtube\.com\/|[a-z-]+\.wikipedia\.org\/)/i;

/**
 * `activeUrl` is the browser's active tab, when known; it decides whether a
 * search happens on the current page or as a new Google search.
 */
export function matchFastCommand(text, { activeUrl = '' } = {}) {
  // A short stammer before the command ("st start dictating") is dropped
  const t = cleanTranscription(text).replace(/^[a-z]{1,3}[\s,.-]+(?=(start|starts|begin|stop|end)\b)/, '');

  // ── Dictation Mode Toggle ──
  // "start dictation", "starts typing", "begin dictating", "let's start writing",
  // "turn on dictation", "dictation mode", "type for me"
  const START_DICTATION = /^(?:(?:let'?s|please|ok(?:ay)?)\s+)?(?:(?:start|starts|begin|turn\s+on)\s+)?(?:dictat(?:e|ed|ing|ion)|typ(?:e|ing)|writing)(?:\s+mode)?$/i;
  // …and the everyday ways of asking: "write this sentence", "type what I say",
  // "can you type for me", "I want to dictate", "take a note", "voice typing"
  const ASK_TO_TYPE = [
    /^(?:(?:can|could|will)\s+you\s+)?(?:type|write)\s+(?:for\s+me|mode|what\s+i\s+say|what\s+i'?m\s+saying|as\s+i\s+(?:speak|talk)|this(?:\s+down)?|these(?:\s+sentences?)?|this\s+sentence|the\s+following|down)$/i,
    /^(?:can|could|will)\s+you\s+(?:type|write|take\s+dictation)$/i, // "for me" is stripped as filler
    /^i\s+(?:want|would\s+like|need)\s+to\s+(?:dictate|type|write)(?:\s+something)?$/i,
    /^let\s+me\s+(?:dictate|type|write)(?:\s+something)?$/i,
    /^(?:take|start)\s+(?:a\s+)?notes?$/i,
    /^(?:note|jot)\s+this(?:\s+down)?$/i,
    /^voice\s+typing$/i,
  ];
  if (START_DICTATION.test(t) || ASK_TO_TYPE.some(re => re.test(t))) {
    return { tool: 'dictation_mode', args: { enabled: true }, silent: false };
  }
  // Text to type is taken from what was said, not from `t`, which is
  // lower-cased and has filler words like "please" removed.
  const said = String(text || '').trim().replace(/^[a-z]{1,3}[\s,.-]+(?=(start|starts|begin)\b)/i, '');

  // "dictate My name is Derek...", "start typing, My name is Derek...",
  // "begin dictating: ..." — activate AND type the trailing text
  // "write this: …", "type the following, …", "write this sentence. …",
  // "take a note: …", "write down …" — the same, in everyday words
  const dictateFirst = said.match(/^(?:(?:start|starts|begin)\s+)?dictat(?:e|ed|ing)[\s,.:;-]+([\s\S]{5,})$/i)
    || said.match(/^(?:start|starts|begin)\s+(?:typing|writing)[\s,.:;-]+([\s\S]{5,})$/i)
    || said.match(/^(?:(?:can|could|will)\s+you\s+)?(?:please\s+)?(?:type|write)\s+(?:this|these|the\s+following)(?:\s+(?:sentences?|words?|text|paragraph|down))?[\s,.:;-]+([\s\S]{3,})$/i)
    || said.match(/^(?:take\s+a\s+note|note\s+this(?:\s+down)?|jot\s+this\s+down|write\s+down)[\s,.:;-]+([\s\S]{3,})$/i);
  if (dictateFirst) {
    return { tool: 'dictation_mode', args: { enabled: true, initialText: dictateFirst[1].trim() }, silent: false };
  }
  if (/^(stop|end|exit|finish|turn\s+off)\s+(dictat(ing|ion)|typ(ing|e)|writing)(\s+mode)?$/i.test(t)
    || /^(command\s+mode|done\s+dictating|i'?m\s+done\s+dictating)$/i.test(t)) {
    return { tool: 'dictation_mode', args: { enabled: false }, silent: false };
  }
  // "My name is Derek. Dictate." — the sentence first, then the trigger word,
  // set apart by a pause (punctuation) or said as a plain "dictate". The
  // sentence keeps its full stop.
  const dictateLast = said.match(/^([\s\S]{5,}?)([.!?])?([\s,;:-]+)(dictate|dictation)[.!?]*$/i);
  if (dictateLast) {
    const [, sentence, stop = '', gap, trigger] = dictateLast;
    const paused = Boolean(stop) || /[,;:-]/.test(gap);
    // "I want to dictate", "the end of dictation": the words lead into the
    // trigger rather than being text to type.
    const leadsIn = /\b(to|me|us|let's|lets|please|and|then|now|i|we|you|will|can|could|of|the|a|an|my|your|this|that|for|with|about|on|in|from|into|start|begin|stop|end|exit|quit|cancel|not|never|no|don't|dont|won't|can't)$/i.test(sentence.trim());
    if (!leadsIn && (paused || /^dictate$/i.test(trigger))) {
      return { tool: 'dictation_mode', args: { enabled: true, initialText: sentence.trim() + stop }, silent: false };
    }
  }

  // ── Scrolling ──
  if (/^scroll\s+(down|up|left|right)(\s+\d+)?$/.test(t)) {
    const parts = t.split(/\s+/);
    const dir = parts[1];
    const amount = parts[2] || undefined;
    return { tool: 'scroll', args: { direction: dir, ...(amount && { amount }) }, silent: true };
  }
  if (/^(go to |scroll to )?(the )?top$/.test(t)) {
    return { tool: 'scroll_to_top', args: {}, silent: true };
  }
  if (/^(go to |scroll to )?(the )?bottom$/.test(t)) {
    return { tool: 'scroll_to_bottom', args: {}, silent: true };
  }
  if (/^page\s+down$/.test(t)) {
    return { tool: 'scroll', args: { direction: 'down', amount: '800' }, silent: true };
  }
  if (/^page\s+up$/.test(t)) {
    return { tool: 'scroll', args: { direction: 'up', amount: '800' }, silent: true };
  }

  // ── Navigation ──
  if (/^go\s*back$/.test(t) || /^back$/.test(t)) {
    return { tool: 'go_back', args: {}, silent: true };
  }
  if (/^go\s*forward$/.test(t) || /^forward$/.test(t)) {
    return { tool: 'go_forward', args: {}, silent: true };
  }
  if (/^(reload|refresh)(\s+(the\s+)?page)?$/.test(t)) {
    return { tool: 'reload_tab', args: {}, silent: true };
  }
  if (/^close\s+(this\s+)?tab$/.test(t)) {
    return { tool: 'close_tab', args: {}, silent: true };
  }
  if (/^(open\s+)?(a\s+)?new\s+tab$/.test(t)) {
    return { tool: 'create_tab', args: { url: 'about:blank' }, silent: false };
  }

  // ── Focus / Tab ──
  if (/^(next|tab)$/.test(t) || /^next\s+(element|field|button|input)$/.test(t)) {
    return { tool: 'focus_next', args: {}, silent: true };
  }
  if (/^(previous|prev)$/.test(t) || /^(previous|prev)\s+(element|field|button|input)$/.test(t)) {
    return { tool: 'focus_prev', args: {}, silent: true };
  }

  // ── Search — "search for X", "google X", "look up X" ──
  const searchMatch = t.match(/^(?:search\s+(?:for\s+)?|google\s+|look\s+up\s+)(.+)$/);
  if (searchMatch) {
    // "search youtube for X", "search for X on YouTube"
    const youtube = searchMatch[1].match(/^youtube\s+for\s+(.+)$/) || searchMatch[1].match(/^(.+?)\s+(?:on|in)\s+youtube$/);
    if (youtube) return { tool: 'search_youtube', args: { query: youtube[1].trim() }, silent: true };
    // "…on Chrome", "…online", "search the web for…" say where to search, not what for
    const query = searchMatch[1]
      .replace(/^(?:google|chrome|the\s+(?:web|internet)|online)\s+for\s+/, '')
      .replace(/\s+(?:on|in|using|with)\s+(?:the\s+)?(?:chrome|google|browser|internet|web)$|\s+online$/, '')
      .trim();
    if (query) {
      // Already on a search page: clear its search bar and search again there.
      // Anywhere else (a new tab, an ordinary page): a new Google search.
      const tool = SEARCH_PAGE.test(activeUrl) ? 'search_in_page' : 'search_web';
      return { tool, args: { query }, silent: true };
    }
  }

  // ── Clear — "clear", "clear the search bar", "erase", "clear the field" ──
  if (/^(clear|erase)((\s+the)?(\s+search)?(\s+bar|\s+field|\s+input|\s+text))?$/.test(t)) {
    return { tool: 'clear_field', args: {}, silent: true };
  }

  // ── Media (browser) ──
  if (/^(pause|play|stop|resume)(\s+(the\s+)?(video|music|media|song|this|it))?$/.test(t) || /^toggle\s+(play|pause)$/.test(t)) {
    return { tool: 'media_control', args: { action: 'toggle' }, silent: true };
  }
  // "mute this tab", "mute the tab" — quick tab mute
  if (/^mute\s+(this\s+)?tab$/.test(t)) {
    return { tool: 'mute_tab', args: {}, silent: true };
  }

  // ── System Media (Spotify, VLC, etc.) ──
  // When the user NAMES the app, target it directly — global media keys go to
  // whichever app played media last (often the browser), not the named app.
  const namedMedia = t.match(/^(pause|play|resume)\s+(spotify|vlc)$/);
  if (namedMedia) {
    return { tool: 'system_media_control', args: { action: 'play_pause', app_name: namedMedia[2] }, silent: true };
  }
  if (/^(pause|play|resume)\s+(music|media\s+player)$/.test(t)) {
    return { tool: 'system_media_control', args: { action: 'play_pause' }, silent: true };
  }
  const namedSkip = t.match(/^(next|previous|prev)\s+(song|track)\s+on\s+(spotify|vlc)$/);
  if (namedSkip) {
    const action = namedSkip[1] === 'next' ? 'next' : 'previous';
    return { tool: 'system_media_control', args: { action, app_name: namedSkip[3] }, silent: true };
  }
  if (/^(next\s+song|skip(\s+song)?|next\s+track)$/.test(t)) {
    return { tool: 'system_media_control', args: { action: 'next' }, silent: true };
  }
  if (/^(previous\s+song|prev\s+song|previous\s+track)$/.test(t)) {
    return { tool: 'system_media_control', args: { action: 'previous' }, silent: true };
  }
  if (/^stop\s+(the\s+)?(music|song|playback|media)$/.test(t)) {
    return { tool: 'system_media_control', args: { action: 'play_pause' }, silent: true };
  }

  // ── Volume ──
  if (/^(volume\s+up|louder|increase\s+(the\s+)?volume|turn\s+(it\s+)?up)$/.test(t)) {
    return { tool: 'system_volume', args: { action: 'up' }, silent: true };
  }
  if (/^(volume\s+down|quieter|decrease\s+(the\s+)?volume|lower\s+(the\s+)?volume|turn\s+(it\s+)?down)$/.test(t)) {
    return { tool: 'system_volume', args: { action: 'down' }, silent: true };
  }
  if (/^mute(\s+(the\s+)?(sound|volume|audio))?$/.test(t)) {
    return { tool: 'system_volume', args: { action: 'mute' }, silent: true };
  }
  if (/^unmute(\s+(the\s+)?(sound|volume|audio))?$/.test(t)) {
    return { tool: 'system_volume', args: { action: 'unmute' }, silent: true };
  }

  // ── Keyboard Shortcuts ──
  if (/^(press\s+)?escape$/.test(t) || /^(press\s+)?esc$/.test(t)) {
    return { tool: 'press_key_combination', args: { key: 'Escape' }, silent: true };
  }
  if (/^(press\s+)?enter$/.test(t) || /^submit$/.test(t) || /^(hit\s+)?enter$/.test(t)) {
    return { tool: 'press_key_combination', args: { key: 'Enter' }, silent: true };
  }
  if (/^(press\s+)?tab$/.test(t)) {
    return { tool: 'focus_next', args: {}, silent: true };
  }
  if (/^(press\s+)?space(bar)?$/.test(t)) {
    return { tool: 'press_key_combination', args: { key: ' ' }, silent: true };
  }
  if (/^undo$/.test(t)) {
    return { tool: 'send_system_keys', args: { keys: 'Ctrl+Z' }, silent: true };
  }
  if (/^redo$/.test(t)) {
    return { tool: 'send_system_keys', args: { keys: 'Ctrl+Y' }, silent: true };
  }
  if (/^copy$/.test(t) || /^copy\s+(that|this|it|text)$/.test(t)) {
    return { tool: 'send_system_keys', args: { keys: 'Ctrl+C' }, silent: true };
  }
  if (/^paste$/.test(t) || /^paste\s+(that|this|it)$/.test(t)) {
    return { tool: 'send_system_keys', args: { keys: 'Ctrl+V' }, silent: true };
  }
  if (/^cut$/.test(t) || /^cut\s+(that|this|it)$/.test(t)) {
    return { tool: 'send_system_keys', args: { keys: 'Ctrl+X' }, silent: true };
  }
  if (/^select\s+all$/.test(t)) {
    return { tool: 'send_system_keys', args: { keys: 'Ctrl+A' }, silent: true };
  }
  if (/^save$/.test(t) || /^save\s+(this|the\s+file|it)$/.test(t)) {
    return { tool: 'send_system_keys', args: { keys: 'Ctrl+S' }, silent: true };
  }
  if (/^(close|quit)$/.test(t) || /^close\s+(the\s+)?(window|app|application)$/.test(t)) {
    return { tool: 'send_system_keys', args: { keys: 'Alt+F4' }, silent: true };
  }

  // ── Window management ──
  if (/^minimi(z|s)e( (this|the|that))?( window| app)?$/.test(t)) {
    return { tool: 'window_control', args: { action: 'minimize' }, silent: true };
  }
  if (/^maximi(z|s)e( (this|the|that))?( window| app)?$/.test(t) || /^full\s*screen$/.test(t)) {
    return { tool: 'window_control', args: { action: 'maximize' }, silent: true };
  }
  if (/^restore( (this|the|that))?( window)?$/.test(t) || /^un\s*maximi(z|s)e$/.test(t)) {
    return { tool: 'window_control', args: { action: 'restore' }, silent: true };
  }
  if (/^snap( (this|the|that))?( window)?\s+(to (the )?)?left$/.test(t) || /^(dock|move)\s+(window\s+)?left$/.test(t)) {
    return { tool: 'window_control', args: { action: 'snap_left' }, silent: true };
  }
  if (/^snap( (this|the|that))?( window)?\s+(to (the )?)?right$/.test(t) || /^(dock|move)\s+(window\s+)?right$/.test(t)) {
    return { tool: 'window_control', args: { action: 'snap_right' }, silent: true };
  }

  // ── Click — always use the full AI path ──
  // The AI has the screenshot and knows if the foreground is a browser,
  // Spotify, or any other desktop app. Don't fast-match clicks.
  // (Previously fast-matched to browser click_element, which broke
  //  desktop app clicks like "click on the artist profile" in Spotify.)

  // ── Select / Choose / Pick — form controls (radio, checkbox, dropdown) ──
  // "select dark mode", "choose economy", "pick one-way", "switch to dark mode".
  // A plain "switch to Word" is an app switch, handled further down.
  const selectMatch = t.match(/^(?:select|choose|pick)\s+(?:the\s+)?(.+?)(?:\s+(?:option|mode|theme|style|radio|button))?$/)
    || t.match(/^switch to\s+(?:the\s+)?(.+?)\s+(?:option|mode|theme|style)$/);
  if (selectMatch) {
    const label = selectMatch[1].trim();
    // Don't match if it's "select all" (that's Ctrl+A) or app focus patterns
    if (label && label !== 'all' && !/^(dashboard|home|chat|voice|tools|context|logs|settings|preferences|options|prompt)$/.test(label) && !/\b(tab|window|app|field)\b/i.test(label)) {
      return { tool: 'select_option', args: { label }, silent: true };
    }
  }

  // "check [label]" / "uncheck [label]" — checkboxes
  const checkMatch = t.match(/^(check|tick|uncheck|untick)\s+(?:the\s+)?(.+)$/);
  if (checkMatch) {
    return { tool: 'select_option', args: { label: checkMatch[2].trim() }, silent: true };
  }

  // ── Browser Focus — "bring browser/chrome/brave to front" ──
  // Handles: "bring chrome to the front", "show brave tab", "bring chrome browser to front"
  if (/\b(browser|chrome|brave|edge|firefox)\b/.test(t) && 
      /^(?:bring|show|switch to|open|focus)/.test(t)) {
    const browserMap = { browser: 'Brave', chrome: 'Chrome', brave: 'Brave', edge: 'Edge', firefox: 'Firefox' };
    const found = t.match(/\b(brave|chrome|edge|firefox|browser)\b/);
    const appName = found ? browserMap[found[1]] : 'Brave';
    return { tool: 'focus_application', args: { app_name: appName }, silent: true };
  }

  // ── App Focus — "bring/show VS Code to front", "focus on Word" ──
  // Dashboard pages ("show settings") are left for navigation below.
  const focusAppMatch = t.match(/^(?:bring up|bring|show|switch to|focus on|focus)\s+(?:the\s+|my\s+)?(.+?)(?:\s+to the front|\s+to front|\s+window)?$/);
  if (focusAppMatch) {
    let appName = focusAppMatch[1].trim()
      .replace(/\b(tab|browser|window|app|application)\b/gi, '').trim();
    // Only match if it looks like an app name (1-3 words, no complex phrases)
    if (appName && !isDashboardName(appName) && appName.split(/\s+/).length <= 3 && !/\b(and|or|then|after|also|this|that)\b/.test(appName)) {
      return { tool: 'focus_application', args: { app_name: appName }, silent: true };
    }
  }

  // "go to Word", "go to my spreadsheet" — only for apps we know by name, so
  // "go to the top" and "go to settings" keep their own meaning.
  const goToApp = t.match(/^go to\s+(.+)$/);
  if (goToApp && resolveAppName(goToApp[1]).app) {
    return { tool: 'focus_application', args: { app_name: goToApp[1].trim() }, silent: true };
  }

  // ── AbleSpeak Dashboard Navigation — "go to settings", "open chat" ──
  const navMatch = t.match(/^(?:go to|open|show|navigate to|switch to)\s+(?:the\s+)?(.+?)(?:\s+page)?$/);
  if (navMatch) {
    const name = navMatch[1].trim();
    const page = NAV_MAP[name];
    if (page) {
      return { tool: 'navigate_dashboard', args: { page }, silent: false };
    }
    if (ADMIN_PAGE_NAMES.has(name)) {
      return { tool: 'answer_question', args: { text: 'That page is for your teacher.' }, silent: false };
    }
  }

  // No match — fall through to AI engine
  return null;
}

/**
 * Destructive command confirmation system.
 * Returns a confirmation prompt instead of executing immediately.
 */
let pendingDestructive = null;

export function matchWithConfirmation(text) {
  const t = cleanTranscription(text);

  // If there's a pending destructive command, check for confirmation
  if (pendingDestructive) {
    const pending = pendingDestructive;
    pendingDestructive = null;

    if (/^(yes|confirm|do it|go ahead|okay|ok|yep|sure)$/.test(t)) {
      return { ...pending, confirmed: true };
    }
    // Anything else cancels
    return { tool: 'answer_question', args: { text: 'Cancelled.' }, silent: false, confirmed: true };
  }

  // Check if this is a destructive command that needs confirmation
  if (/^(close|quit)$/.test(t) || /^close\s+(the\s+)?(window|app|application)$/.test(t)) {
    pendingDestructive = { tool: 'send_system_keys', args: { keys: 'Alt+F4' }, silent: true };
    return { tool: 'answer_question', args: { text: 'Close this window? Say "yes" to confirm or anything else to cancel.' }, silent: false, needsConfirmation: true };
  }

  return null;
}

/**
 * Check if a tool result should suppress TTS.
 */
export function isSilentTool(toolName) {
  return SILENT_COMMANDS.has(toolName);
}

/**
 * Check if a tool is a browser tool (needs auto-focus).
 */
export function isBrowserTool(toolName) {
  return BROWSER_TOOLS.has(toolName);
}
