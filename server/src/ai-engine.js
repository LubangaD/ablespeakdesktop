/**
 * AbleSpeak AI Engine
 * 
 * Standalone LLM integration — replaces Voqal's Kotlin-based agent.
 * Supports multiple providers with runtime switching.
 */

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
  },
  gemini: {
    name: 'Google Gemini',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    defaultModel: 'gemini-2.0-flash',
    envKey: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  azure: {
    name: 'Azure OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4'],
    defaultModel: 'gpt-4o-mini',
    envKey: 'AZURE_OPENAI_API_KEY',
    baseUrl: null, // Set via AZURE_OPENAI_ENDPOINT
  },
  anthropic: {
    name: 'Anthropic Claude',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
    defaultModel: 'claude-sonnet-4-20250514',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
  },
  ollama: {
    name: 'Ollama (Local)',
    models: ['llama3', 'mistral', 'codellama', 'phi3'],
    defaultModel: 'llama3',
    envKey: null, // No key needed
    baseUrl: 'http://localhost:11434/v1',
  },
  groq: {
    name: 'Groq',
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    defaultModel: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
};

export class AIEngine {
  constructor({ toolRegistry, wsHub }) {
    this.toolRegistry = toolRegistry;
    this.wsHub = wsHub;

    // Current provider config
    this.provider = process.env.LLM_PROVIDER || 'openai';
    this.model = process.env.LLM_MODEL || PROVIDERS[this.provider]?.defaultModel || 'gpt-4o-mini';
    this.temperature = parseFloat(process.env.LLM_TEMPERATURE || '0.7');
    this.conversationHistory = [];
    this.maxHistory = 20;
    this.llmTimeoutMs = 15000;
  }

  // ── Network Helpers ──

  /**
   * Fetch with AbortController timeout — prevents LLM hangs from freezing the voice pipeline.
   */
  async _fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.llmTimeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch with timeout + single retry with backoff.
   */
  async _fetchWithRetry(url, options, { timeoutMs, retries = 1 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._fetchWithTimeout(url, options, timeoutMs);
      } catch (err) {
        if (attempt === retries) throw err;
        const backoff = 1000 * (attempt + 1);
        console.warn(`[AIEngine] Attempt ${attempt + 1} failed (${err.name}), retrying in ${backoff}ms...`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  /**
   * Truncate content to prevent unbounded history growth (Fix #2).
   */
  _truncateContent(content, maxChars = 2000) {
    if (typeof content !== 'string') return '';
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + '\n...[truncated]';
  }

  // ── Provider Management ──

  getAvailableProviders() {
    const available = {};
    for (const [key, config] of Object.entries(PROVIDERS)) {
      const hasKey = config.envKey ? !!process.env[config.envKey] : true;
      available[key] = {
        ...config,
        configured: hasKey,
        active: key === this.provider,
        apiKey: hasKey ? '••••••••' : null,
      };
    }
    return available;
  }

  setProvider(provider, model) {
    if (!PROVIDERS[provider]) {
      throw new Error(`Unknown provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
    }
    const config = PROVIDERS[provider];
    if (config.envKey && !process.env[config.envKey]) {
      throw new Error(`${config.name} API key not configured. Set ${config.envKey} in .env`);
    }
    this.provider = provider;
    this.model = model || config.defaultModel;
    console.log(`[AIEngine] Switched to ${config.name} / ${this.model}`);
    return { provider: this.provider, model: this.model, name: config.name };
  }

  getStatus() {
    const config = PROVIDERS[this.provider] || {};
    return {
      provider: this.provider,
      providerName: config.name || this.provider,
      model: this.model,
      temperature: this.temperature,
      historyLength: this.conversationHistory.length,
      configured: config.envKey ? !!process.env[config.envKey] : true,
    };
  }

  // ── Chat Processing ──

  async processChat(userText, context = {}) {
    const startTime = Date.now();

    // Build the system prompt with available tools and context
    const systemPrompt = this._buildSystemPrompt(context);
    const tools = this.toolRegistry.getToolsForContext(context);

    // Debug: log what context the AI is getting
    const vpCount = context.pageContext?.viewportElements?.length || 0;
    const mediaCount = context.pageContext?.mediaElements?.length || 0;
    const activeUrl = context.activeTab?.url || 'none';
    console.log(`[AIEngine] Context: ${vpCount} viewport elements, ${mediaCount} media, active: ${activeUrl}`);

    // Add user message to history
    this.conversationHistory.push({ role: 'user', content: userText });

    // Trim history
    if (this.conversationHistory.length > this.maxHistory) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistory);
    }

    try {
      let result;

      if (this.provider === 'gemini') {
        result = await this._callGemini(systemPrompt, tools);
      } else if (this.provider === 'anthropic') {
        result = await this._callAnthropic(systemPrompt, tools);
      } else {
        // OpenAI-compatible (openai, azure, ollama, groq)
        result = await this._callOpenAICompatible(systemPrompt, tools);
      }

      const latency = Date.now() - startTime;

      // Multi-turn tool calling loop — allows AI to chain actions
      // e.g. "play finale by Bien" → search_youtube → click first video
      const allToolResults = [];
      let currentResult = result;
      let rounds = 0;
      const MAX_ROUNDS = 2;

      while (currentResult.toolCalls && currentResult.toolCalls.length > 0 && rounds < MAX_ROUNDS) {
        rounds++;
        const roundResults = [];
        for (const toolCall of currentResult.toolCalls) {
          console.log(`[AIEngine] Tool call (round ${rounds}): ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);
          const toolResult = await this.toolRegistry.executeTool(toolCall.name, toolCall.arguments, this.wsHub);
          roundResults.push({ tool: toolCall.name, result: toolResult });
        }
        allToolResults.push(...roundResults);

        // Add assistant tool call + results to history
        this.conversationHistory.push({
          role: 'assistant',
          content: currentResult.text || '',
          toolCalls: currentResult.toolCalls
        });
        this.conversationHistory.push({
          role: 'user',
          content: this._truncateContent(
            `Tool results: ${JSON.stringify(roundResults.map(r => ({ tool: r.tool, status: r.result?.status || 'done', message: r.result?.message || '' })))}

IMPORTANT: ONLY call another tool if the user explicitly asked for a MULTI-STEP action (like "play [song]" which requires search then click). Do NOT add extra actions the user did not ask for. If the command is complete, respond with a SHORT confirmation or empty text.`
          )
        });

        // Ask AI for next step
        try {
          if (this.provider === 'gemini') {
            currentResult = await this._callGemini(systemPrompt, tools);
          } else if (this.provider === 'anthropic') {
            currentResult = await this._callAnthropic(systemPrompt, tools);
          } else {
            currentResult = await this._callOpenAICompatible(systemPrompt, tools);
          }
        } catch (err) {
          console.error('[AIEngine] Multi-turn error:', err.message);
          break;
        }
      }

      // Final response
      if (allToolResults.length > 0) {
        this.conversationHistory.push({ role: 'assistant', content: currentResult.text || '' });
        return {
          text: currentResult.text || this._summarizeToolResults(allToolResults),
          toolCalls: allToolResults,
          latency: Date.now() - startTime,
          provider: this.provider,
          model: this.model,
        };
      }

      // Plain text response
      this.conversationHistory.push({ role: 'assistant', content: result.text });

      return {
        text: result.text,
        toolCalls: null,
        latency,
        provider: this.provider,
        model: this.model,
      };

    } catch (err) {
      console.error('[AIEngine] Error:', err.message);
      return {
        text: `Error: ${err.message}`,
        error: true,
        latency: Date.now() - startTime,
        provider: this.provider,
        model: this.model,
      };
    }
  }

  clearHistory() {
    this.conversationHistory = [];
  }

  // ── System Prompt Builder ──

  _buildSystemPrompt(context) {
    const parts = [
      'You are AbleSpeak, a voice-native AI assistant that controls the user\'s ENTIRE computer hands-free.',
      'You help users with disabilities interact with their computer using voice commands.',
      '',
      '## Your Capabilities',
      '',
      '### Browser Control (via Chrome extension)',
      '- Open, close, switch, reload, duplicate, pin, mute, and zoom browser tabs',
      '- Navigate to URLs in the current tab or open new tabs',
      '- Go back and forward in browser history',
      '- Scroll pages and scroll inside containers',
      '- Navigate between interactive elements using focus_next / focus_prev',
      '- Control browser video/audio playback (play, pause, seek, volume, speed)',
      '- Click elements, type text, search YouTube',
      '- Read and interact with web page content',
      '',
      '### Desktop / System Control (works with ANY application)',
      '- **Open applications**: Use `open_application` to launch Notepad, Calculator, Spotify, Chrome, VS Code, File Explorer, Settings, etc.',
      '- **Close applications**: Use `close_application` to gracefully close any running app',
      '- **Switch to applications**: Use `focus_application` to bring any app to the foreground (e.g. switch to Spotify)',
      '- **System media control**: Use `system_media_control` to play/pause/next/previous music in Spotify, VLC, or ANY media player',
      '- **System volume**: Use `system_volume` to mute, unmute, increase, decrease, or set volume',
      '- **Keyboard shortcuts**: Use `send_system_keys` to send shortcuts like Ctrl+C, Ctrl+V, Alt+F4 to the focused app',
      '- **List running apps**: Use `list_running_apps` to see what applications are currently open',
      '',
      '## Rules',
      '- Execute commands immediately when the intent is clear — do NOT ask for confirmation',
      '- Always respond concisely — your responses will be spoken aloud via TTS',
      '- For simple action commands (scroll, go back, click, volume), respond with EMPTY TEXT or at most one word. Do NOT narrate what you did.',
      '- CRITICAL: Only execute the EXACT action the user asked for. Do NOT chain extra actions they did not request.',
      '- Example: if user says "scroll down", ONLY scroll. Do NOT also search or navigate.',
      '- When opening URLs, use full URLs (e.g., https://www.google.com)',
      '- For desktop media (Spotify, VLC), use `system_media_control`. For browser media (YouTube), use `media_control`.',
      '- When the user says "pause Spotify" or "next song", use `system_media_control` — NOT the browser media_control.',
      '- CRITICAL SAFETY: NEVER use `close_application` for browsers (Chrome, Brave, Edge, Firefox). To close a browser TAB, use `close_tab`. `close_application` will KILL THE ENTIRE BROWSER and lose all tabs.',
      '- When user says "close this tab" or "close the tab", use `close_tab` — NEVER `close_application`.',
      '',
      '## CRITICAL: How to Click and Interact with Pages',
      '- **To click ANYTHING in browser**: use the `click_element` tool with the xpath from the Visible Interactive Elements list below',
      '- **To play/pause browser video or audio**: use the `media_control` tool with action "play", "pause", or "toggle"',
      '- **To play/pause desktop media (Spotify, VLC)**: use the `system_media_control` tool with action "play_pause"',
      '- **To type text in browser**: use the `type_text` tool',
      '- **To press keyboard shortcuts**: use `press_key_combination` (browser) or `send_system_keys` (any app)',
      '- **To scroll**: use `scroll` with direction "up" or "down"',
      '- **To switch tabs**: use `make_tab_active` with the tab ID from the Browser Tabs list',
      '- **To switch apps**: use `focus_application` with the app name',
      '',
      '## Examples',
      '- User: "play Finale by Bien" → call `search_youtube` with query "Finale Bien". Wait for results. Then click_element on the FIRST video result from the Visible Interactive Elements list.',
      '- User: "play Carisma Sinanoma" → call `search_youtube` with query "Charisma Sina Noma". Wait for results. Then click the first video.',
      '- User: "pause Spotify" → Use `system_media_control` with action:"play_pause"',
      '- User: "next song" → Use `system_media_control` with action:"next"',
      '- User: "open Notepad" → Use `open_application` with app_name:"notepad"',
      '- User: "switch to Chrome" → Use `focus_application` with app_name:"Chrome"',
      '- User: "close Notepad" → Use `close_application` with app_name:"notepad"',
      '- User: "volume up" → Use `system_volume` with action:"up"',
      '- User: "mute" → Use `system_volume` with action:"mute"',
      '- User: "click the first video" → Use `click_element` with the xpath from the visible elements list',
      '- User: "go to google" → Use `open_url` with url:"https://www.google.com"',
      '- User: "scroll down" → Use `scroll` with direction:"down"',
      '- User: "summarize this page" → Use `get_page_content` to read the page, then provide a concise summary in your response',
      '- User: "read it out" / "read this page" → Use `get_page_content` to read the page, then provide the key content in your response',
      '- User: "what is this page about" → Use `get_page_content` to read the page, then explain what the page is about',
      '',
      '## CRITICAL: Page Content Commands',
      '- When the user asks you to "summarize", "read", "tell me about", or "what is on" a page, you MUST:',
      '  1. Call `get_page_content` to get the page text',
      '  2. Actually provide the summary or content IN YOUR RESPONSE TEXT',
      '  3. NEVER just say "I have summarized/read the content" — the user wants to HEAR the summary',
      '  4. Keep summaries concise (2-4 sentences) since responses are spoken via TTS',
      '  5. For "read it out", provide the key information from the page in a spoken-friendly format',
      '',
      '## Google Workspace Shortcuts',
      '- To create a new Google Doc: use `open_url` with url:"https://docs.google.com/document/create"',
      '- To create a new Google Sheet: use `open_url` with url:"https://docs.google.com/spreadsheets/create"',
      '- To create a new Google Slide: use `open_url` with url:"https://docs.google.com/presentation/create"',
      '- To open Google Drive: use `open_url` with url:"https://drive.google.com"',
      '- To open Gmail: use `open_url` with url:"https://mail.google.com"',
      '- To open Google Calendar: use `open_url` with url:"https://calendar.google.com"',
      '',
      '## CRITICAL RULES FOR PLAYING MUSIC/VIDEOS',
      '- When the user says "play [song name]", you MUST use `search_youtube` with the song name as the query.',
      '- NEVER click on random videos from the YouTube homepage. ALWAYS search first.',
      '- After search_youtube, wait for the Visible Interactive Elements to update with search results, then click the FIRST video result.',
      '- Use the song/artist name from what the user said as the search query. Fix obvious misspellings (e.g. "Carisma" → "Charisma").',
      '- Do NOT open a new tab for YouTube if YouTube is already open — just search in the existing tab.',
      '',
      '## IMPORTANT',
      '- Do NOT open new tabs unless explicitly asked.',
      '- You can call multiple tools in sequence. After a tool executes, you will see the result and can call more tools.',
      '- Use xpaths from the Visible Interactive Elements list for clicking.',
      '- When the user says "play [song]", use search_youtube THEN click_element on the first video result.',
      '- YOU CAN CONTROL DESKTOP APPS. Never say "I cannot control Spotify" — use system_media_control instead!',
      '- When creating new documents (Google Docs, Sheets, Slides), ALWAYS use the direct /create URL instead of trying to click UI elements.',
      '- If a click_element does not seem to work, try using open_url with a direct URL as a fallback.',
    ];

    // Add context info
    if (context.tabs && context.tabs.length > 0) {
      parts.push('', '## Current Browser Tabs');
      context.tabs.forEach(tab => {
        const marker = tab.active ? ' [ACTIVE]' : '';
        parts.push(`- Tab ${tab.id}: ${tab.title || tab.url}${marker}`);
      });
    }

    if (context.activeTab) {
      parts.push('', `## Active Tab: ${context.activeTab.title || context.activeTab.url}`);
      parts.push(`URL: ${context.activeTab.url}`);
    }

    // ── Rich Page Context (from extension viewport scan) ──
    const pc = context.pageContext;
    if (pc) {
      // Scroll position — tells the AI where on the page we are
      if (pc.scroll) {
        const s = pc.scroll;
        parts.push('', '## Scroll Position');
        parts.push(`${s.percentScrolled}% scrolled | ${s.atTop ? 'At top' : ''}${s.atBottom ? 'At bottom' : ''} | ${s.canScrollMore ? 'Can scroll more' : 'Cannot scroll further'}`);
      }

      // Focused element — what the keyboard is currently on
      if (pc.focusedElement) {
        const f = pc.focusedElement;
        parts.push('', '## Currently Focused Element');
        parts.push(`<${f.tag}> "${f.label}" ${f.isEditable ? '(editable)' : ''} ${f.value ? `value="${f.value}"` : ''}`);
        parts.push(`XPath: ${f.xpath}`);
      }

      // Selected text
      if (pc.selectedText) {
        parts.push('', `## Selected Text: "${pc.selectedText.slice(0, 300)}"`);
      }

      // Visible interactive elements — the AI's "eyes" on the page
      if (pc.viewportElements && pc.viewportElements.length > 0) {
        parts.push('', '## Visible Interactive Elements');
        // Cap at 40 to keep prompt size manageable
        const elements = pc.viewportElements.slice(0, 40);
        elements.forEach((el, i) => {
          const extras = [];
          if (el.disabled) extras.push('disabled');
          if (el.checked !== null) extras.push(el.checked ? 'checked' : 'unchecked');
          if (el.value) extras.push(`value="${el.value.slice(0, 60)}"`);
          if (el.focused) extras.push('FOCUSED');
          const suffix = extras.length ? ` (${extras.join(', ')})` : '';
          parts.push(`${i + 1}. <${el.tag}${el.role ? ` role="${el.role}"` : ''}> "${el.label}"${suffix} — xpath: ${el.xpath}`);
        });
        if (pc.viewportElements.length > 40) {
          parts.push(`... and ${pc.viewportElements.length - 40} more elements not shown`);
        }
      }

      // Media elements — for voice control of video/audio
      if (pc.mediaElements && pc.mediaElements.length > 0) {
        parts.push('', '## Media on Page');
        pc.mediaElements.forEach(m => {
          const state = m.paused ? 'PAUSED' : (m.ended ? 'ENDED' : 'PLAYING');
          const time = m.duration ? `${m.currentTime}s / ${m.duration}s` : `${m.currentTime}s`;
          parts.push(`- <${m.tag}> ${state} | ${time} | vol ${m.volume}%${m.muted ? ' (muted)' : ''} | speed ${m.playbackRate}x | xpath: ${m.xpath}`);
        });
      }
    }

    // ── Computer Info ──
    if (context.computerInfo) {
      const ci = context.computerInfo;
      parts.push('', '## Computer Info');
      parts.push(`- Current time: ${ci.currentTime}`);
      parts.push(`- OS: ${ci.osName}`);
      parts.push(`- OS Version: ${ci.osVersion}`);
      parts.push(`- Architecture: ${ci.osArch}`);
    }

    // ── Visible Desktop Applications ──
    if (context.visibleApplications && context.visibleApplications.length > 0) {
      parts.push('', `## Visible Applications (${context.visibleApplications.length})`);
      context.visibleApplications.forEach(app => {
        const fg = app.foreground ? ' [FOREGROUND]' : '';
        parts.push(`- **${app.title}**${fg}`);
        parts.push(`  ID: ${app.id} | Process: ${app.processName}`);
      });
    }

    if (context.currentTime && !context.computerInfo) {
      parts.push('', `Current time: ${context.currentTime}`);
    }

    return parts.join('\n');
  }

  _summarizeToolResults(toolResults) {
    // Confirmation gate: surface the spoken prompt before anything else
    const needsConf = toolResults.find(r => r.result?.needsConfirmation);
    if (needsConf) return needsConf.result.prompt;

    // Import the silent tool checker
    const SILENT = new Set([
      'scroll', 'scroll_to_top', 'scroll_to_bottom',
      'go_back', 'go_forward', 'focus_next', 'focus_prev',
      'reload_tab', 'close_tab', 'click_element',
      'press_key_combination', 'media_control',
      'system_media_control', 'system_volume',
      'send_system_keys', 'open_url', 'create_tab',
      'search_web', 'search_youtube', 'type_text',
      'make_tab_active', 'scroll_element',
      'right_click', 'zoom_tab', 'pin_tab', 'mute_tab',
      'execute_javascript', 'get_page_state',
    ]);

    const parts = toolResults.map(r => {
      const res = r.result;

      // Silent action tools: return nothing (no TTS)
      if (SILENT.has(r.tool) && res?.status !== 'error') {
        return '';
      }

      // answer_question returns the actual spoken text — use it directly
      if (r.tool === 'answer_question' && res?.text) {
        return res.text;
      }

      // Tools that return tab data
      if (res?.tabs) {
        return `Found ${res.tabs.length} tab(s):\n` +
          res.tabs.map(t => `  • [${t.id}] ${t.title || t.url}${t.active ? ' (active)' : ''}`).join('\n');
      }

      // Extension returned an error message
      if (res?.status === 'error' && res?.message) {
        return `⚠ ${res.message}`;
      }

      // Generic error
      if (res?.error) {
        return `⚠ ${res.error}`;
      }

      // Success with a descriptive message (non-silent tools)
      if (res?.status === 'success') {
        if (res.text) return res.text;
        if (res.message) return res.message;
        return '';
      }

      return '';
    }).filter(Boolean);

    return parts.join('\n');
  }

  // ── OpenAI-Compatible Provider ──

  async _callOpenAICompatible(systemPrompt, tools) {
    const config = PROVIDERS[this.provider];
    let baseUrl = config.baseUrl;
    let apiKey = process.env[config.envKey] || '';

    // Azure special handling
    if (this.provider === 'azure') {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || this.model;
      baseUrl = `${endpoint}/openai/deployments/${deployment}`;
      apiKey = process.env.AZURE_OPENAI_API_KEY;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory.map(m => ({ role: m.role, content: m.content })),
    ];

    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
    };

    // Add tools if available
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    const url = this.provider === 'azure'
      ? `${baseUrl}/chat/completions?api-version=2024-02-01`
      : `${baseUrl}/chat/completions`;

    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.provider === 'azure') {
      headers['api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await this._fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`${config.name} API error ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];

    if (!choice) throw new Error('No response from LLM');

    const message = choice.message;
    const toolCalls = message.tool_calls?.map(tc => ({
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));

    return {
      text: message.content || '',
      toolCalls: toolCalls || null,
    };
  }

  // ── Google Gemini Provider ──

  async _callGemini(systemPrompt, tools) {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = this.model;

    const contents = this.conversationHistory.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: this.temperature,
      },
    };

    // Add tools if available
    if (tools.length > 0) {
      body.tools = [{
        function_declarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    const url = `${PROVIDERS.gemini.baseUrl}/models/${model}:generateContent?key=${apiKey}`;

    const res = await this._fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('No response from Gemini');

    const parts = candidate.content?.parts || [];
    const textParts = parts.filter(p => p.text).map(p => p.text).join('');
    const functionCalls = parts.filter(p => p.functionCall).map(p => ({
      name: p.functionCall.name,
      arguments: p.functionCall.args || {},
    }));

    return {
      text: textParts,
      toolCalls: functionCalls.length > 0 ? functionCalls : null,
    };
  }

  // ── Anthropic Claude Provider ──

  async _callAnthropic(systemPrompt, tools) {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    const messages = this.conversationHistory.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const body = {
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    };

    // Add tools if available
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const res = await this._fetchWithRetry(`${PROVIDERS.anthropic.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const toolUses = (data.content || []).filter(b => b.type === 'tool_use').map(b => ({
      name: b.name,
      arguments: b.input || {},
    }));

    return {
      text: textBlocks,
      toolCalls: toolUses.length > 0 ? toolUses : null,
    };
  }
}
