/**
 * Tool catalogue for the dashboard's Tools page.
 *
 * tool-registry.js is the source of truth for what the AI can call. This
 * module only groups those tools into categories a teacher or support person
 * recognises, in the shape the Tools page renders. It is built from the live
 * registry, so the page always shows exactly the tools the AI has.
 *
 * (The page used to read ~/.voqal/library — a folder left over from Voqal that
 * AbleSpeak never creates — so it always showed "0 available".)
 *
 * A tool missing from TOOL_CATEGORIES still appears, under "Other", and
 * tool-catalog.test.mjs fails so the new tool gets a proper home.
 */

export const TOOL_CATEGORIES = [
  {
    name: 'Browser tabs',
    tools: ['create_tab', 'open_url', 'make_tab_active', 'close_tab', 'reload_tab',
      'duplicate_tab', 'pin_tab', 'mute_tab', 'find_tab', 'list_tabs', 'zoom_tab'],
  },
  { name: 'Browser navigation', tools: ['go_back', 'go_forward', 'navigate_to_link'] },
  { name: 'Scrolling', tools: ['scroll', 'scroll_to_top', 'scroll_to_bottom', 'scroll_element'] },
  { name: 'Keyboard & focus', tools: ['focus_next', 'focus_prev', 'press_key_combination'] },
  {
    name: 'Page interaction',
    tools: ['click_element', 'right_click', 'select_option', 'type_text', 'clear_field',
      'get_page_state', 'get_page_content', 'take_screenshot', 'execute_javascript'],
  },
  { name: 'Search', tools: ['search_web', 'search_youtube', 'search_in_page'] },
  { name: 'Media & volume', tools: ['media_control', 'system_media_control', 'system_volume'] },
  {
    name: 'Desktop apps',
    tools: ['open_application', 'close_application', 'focus_application', 'window_control',
      'system_type_text', 'send_system_keys'],
  },
  {
    name: 'Desktop screen reading',
    tools: ['uia_query', 'uia_act', 'list_desktop_elements', 'click_desktop_element', 'read_desktop_window',
      'desktop_scroll', 'list_running_apps', 'fix_spelling'],
  },
  { name: 'Conversation', tools: ['answer_question'] },
  {
    name: 'Dashboard control',
    tools: ['navigate_dashboard', 'switch_ai_provider', 'toggle_continuous_mode',
      'set_silence_timeout', 'clear_chat_history'],
  },
];

export const OTHER_CATEGORY = 'Other';

function toEntry(tool) {
  const description = tool.description || '';
  return {
    name: tool.name,
    description,
    needsExtension: Boolean(tool.selector?.requiresExtension),
    jsonSchema: {
      name: tool.name,
      description,
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  };
}

/**
 * Group registry tools (ToolRegistry#listTools output) into page categories.
 * Returns { total, categories: [{ name, tools: [entry] }] }; empty categories
 * are left out.
 */
export function buildToolCatalog(registryTools) {
  const byName = new Map(registryTools.map(tool => [tool.name, tool]));
  const placed = new Set();
  const categories = [];

  for (const category of TOOL_CATEGORIES) {
    const tools = category.tools
      .filter(name => byName.has(name) && !placed.has(name))
      .map(name => {
        placed.add(name);
        return toEntry(byName.get(name));
      });
    if (tools.length) categories.push({ name: category.name, tools });
  }

  const others = registryTools.filter(tool => !placed.has(tool.name)).map(toEntry);
  if (others.length) categories.push({ name: OTHER_CATEGORY, tools: others });

  return { total: registryTools.length, categories };
}
