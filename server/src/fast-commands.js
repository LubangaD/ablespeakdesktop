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

// ── Silent commands: these execute without TTS feedback ──
const SILENT_COMMANDS = new Set([
  'scroll', 'scroll_to_top', 'scroll_to_bottom',
  'go_back', 'go_forward', 'focus_next', 'focus_prev',
  'reload_tab', 'close_tab', 'click_element',
  'press_key_combination', 'media_control',
  'system_media_control', 'system_volume',
  'send_system_keys', 'focus_application',
]);

// ── Browser tools: auto-focus Chrome after these ──
const BROWSER_TOOLS = new Set([
  'create_tab', 'open_url', 'make_tab_active', 'close_tab',
  'reload_tab', 'go_back', 'go_forward', 'scroll',
  'scroll_to_top', 'scroll_to_bottom', 'scroll_element',
  'click_element', 'type_text', 'search_web', 'search_youtube',
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
export function matchFastCommand(text) {
  const t = cleanTranscription(text);

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

  // ── Media (browser) ──
  if (/^(pause|play)(\s+(the\s+)?(video|music|media))?$/.test(t) || /^toggle\s+(play|pause)$/.test(t)) {
    return { tool: 'media_control', args: { action: 'toggle' }, silent: true };
  }

  // ── System Media (Spotify, VLC, etc.) ──
  if (/^(pause|play|resume)\s+(spotify|vlc|music|media\s+player)$/.test(t)) {
    return { tool: 'system_media_control', args: { action: 'play_pause' }, silent: true };
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

  // ── Student Picker ──
  if (/^(switch|change)\s+(student|user)$/.test(t)) {
    return { tool: 'switch_student', args: {}, silent: false };
  }
  const iAmMatch = t.match(/^(?:i'?m|this is)\s+(.+)$/);
  if (iAmMatch) {
    return { tool: 'set_student_by_name', args: { name: iAmMatch[1].trim() }, silent: false };
  }

  // ── Click (by label) — "click X" ──
  const clickMatch = t.match(/^click\s+(?:on\s+)?(?:the\s+)?(.+)$/);
  if (clickMatch) {
    return { tool: 'click_element', args: { label: clickMatch[1].trim() }, silent: true };
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

  // ── App Focus — "bring/show VS Code to front", "open spotify" ──
  const focusAppMatch = t.match(/^(?:bring|show|switch to|focus)\s+(?:the\s+)?(.+?)(?:\s+to the front|\s+to front|\s+window)?$/);
  if (focusAppMatch) {
    let appName = focusAppMatch[1].trim()
      .replace(/\b(tab|browser|window|app|application)\b/gi, '').trim();
    // Only match if it looks like an app name (1-3 words, no complex phrases)
    if (appName && appName.split(/\s+/).length <= 3 && !/\b(and|or|then|after|also|this|that)\b/.test(appName)) {
      return { tool: 'focus_application', args: { app_name: appName }, silent: true };
    }
  }

  // No match — fall through to AI engine
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
