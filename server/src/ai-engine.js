/**
 * AbleSpeak AI Engine
 * 
 * Standalone LLM integration — replaces Voqal's Kotlin-based agent.
 * Supports multiple providers with runtime switching.
 */

// NOTE: `models` is only a STATIC FALLBACK — the live list is fetched from each
// provider's API at runtime (listModels). `prefer` is an ordered list of regex
// patterns used to auto-pick the best available model (autoSelectModel), so
// the app keeps working when providers retire old models.
const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
    defaultModel: 'gpt-4o-mini',
    prefer: [/^gpt-[\d.]+[a-z]*-mini$/, /^gpt-4o-mini$/, /mini/, /^gpt-4o$/, /^gpt-/],
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
  },
  gemini: {
    name: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    defaultModel: 'gemini-2.5-flash',
    prefer: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash-lite$/, /flash/, /^gemini-[\d.]+-pro$/],
    envKey: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  azure: {
    name: 'Azure OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4'],
    defaultModel: 'gpt-4o-mini',
    prefer: [/mini/, /.*/],
    envKey: 'AZURE_OPENAI_API_KEY',
    baseUrl: null, // Set via AZURE_OPENAI_ENDPOINT
  },
  anthropic: {
    name: 'Anthropic Claude',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-sonnet-4-20250514',
    prefer: [/sonnet/, /haiku/, /^claude-/],
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
  },
  ollama: {
    name: 'Ollama (Local)',
    models: ['llama3', 'mistral', 'codellama', 'phi3'],
    defaultModel: 'llama3',
    prefer: [/llama/, /.*/],
    envKey: null, // No key needed
    baseUrl: 'http://localhost:11434/v1',
  },
  groq: {
    name: 'Groq',
    models: ['llama-3.3-70b-versatile', 'gemma2-9b-it'],
    defaultModel: 'llama-3.3-70b-versatile',
    prefer: [/llama-[\d.]+-70b/, /llama.*70b/, /llama/, /.*/],
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
};

// Models that are not chat/tool-use models — excluded from auto-selection
const NON_CHAT_RE = /(audio|realtime|tts|whisper|embed|embedding|image|imagen|veo|dall|moderation|transcribe|search|live|robotics|aqa|learnlm|thinking)/i;

// Extract a numeric version from a model name for "newest first" sorting
function versionScore(name) {
  const m = String(name).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Tools whose success COMPLETES the command — no need to ask the LLM
// "what next?" afterwards. Skipping that follow-up call saves 2-4 seconds.
const TERMINAL_TOOLS = new Set([
  'click_desktop_element', 'desktop_scroll', 'system_type_text', 'mouse_click',
  'system_media_control', 'system_volume', 'send_system_keys',
  'open_application', 'close_application', 'focus_application',
  'scroll', 'scroll_to_top', 'scroll_to_bottom', 'scroll_element',
  'go_back', 'go_forward', 'reload_tab', 'close_tab', 'create_tab',
  'open_url', 'make_tab_active', 'zoom_tab', 'pin_tab', 'mute_tab',
  'media_control', 'press_key_combination', 'click_element', 'select_option', 'type_text',
  'search_in_page', 'clear_field', 'focus_next', 'focus_prev', 'answer_question',
]);

export class AIEngine {
  constructor({ toolRegistry, wsHub }) {
    this.toolRegistry = toolRegistry;
    this.wsHub = wsHub;

    // Current provider config
    this.provider = process.env.LLM_PROVIDER || 'openai';
    // LLM_MODEL empty or "auto" → resolve dynamically from the provider's live model list
    const envModel = (process.env.LLM_MODEL || '').trim();
    this.model = (envModel && envModel.toLowerCase() !== 'auto')
      ? envModel
      : PROVIDERS[this.provider]?.defaultModel || 'gpt-4o-mini';
    this.temperature = parseFloat(process.env.LLM_TEMPERATURE || '0.7');
    this.conversationHistory = [];
    this.maxHistory = 20;
    this.llmTimeoutMs = 15000;
    this._modelCache = {}; // provider → { models, at }
  }

  // ── Dynamic Model Discovery ──

  /**
   * Fetch the live list of available models from the provider's API.
   * Falls back to the static list if the API can't be reached.
   */
  async listModels(provider = this.provider, force = false) {
    const config = PROVIDERS[provider];
    if (!config) return [];

    const cached = this._modelCache[provider];
    if (!force && cached && Date.now() - cached.at < 5 * 60 * 1000) {
      return cached.models;
    }

    let models = [];
    try {
      if (provider === 'gemini') {
        const key = process.env.GEMINI_API_KEY || '';
        const res = await this._fetchWithTimeout(`${config.baseUrl}/models?key=${key}&pageSize=200`, {}, 10000);
        if (res.ok) {
          const data = await res.json();
          models = (data.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => m.name.replace(/^models\//, ''));
        }
      } else if (provider === 'anthropic') {
        const res = await this._fetchWithTimeout(`${config.baseUrl}/models?limit=100`, {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY || '',
            'anthropic-version': '2023-06-01',
          },
        }, 10000);
        if (res.ok) {
          const data = await res.json();
          models = (data.data || []).map(m => m.id);
        }
      } else if (provider === 'azure') {
        models = [...config.models]; // deployments can't be listed with just an API key
      } else {
        // OpenAI-compatible: openai, groq, ollama
        const headers = {};
        if (config.envKey && process.env[config.envKey]) {
          headers['Authorization'] = `Bearer ${process.env[config.envKey]}`;
        }
        const res = await this._fetchWithTimeout(`${config.baseUrl}/models`, { headers }, 10000);
        if (res.ok) {
          const data = await res.json();
          models = (data.data || []).map(m => m.id);
          if (provider === 'openai') {
            models = models.filter(id => /^(gpt-|o\d|chatgpt)/.test(id));
          }
        }
      }
    } catch (err) {
      console.warn(`[AIEngine] Could not list ${provider} models: ${err.message}`);
    }

    // Exclude non-chat models (audio, embeddings, image, etc.)
    models = models.filter(m => !NON_CHAT_RE.test(m));

    if (models.length === 0) models = [...config.models]; // static fallback

    this._modelCache[provider] = { models, at: Date.now() };
    return models;
  }

  /**
   * Pick the best available model for the current provider.
   * - Keeps the current model if it still exists (unless force=true, used
   *   when the current model just failed with a "model not found" error).
   * - Otherwise walks the provider's `prefer` patterns, newest version first,
   *   preferring stable over preview/experimental builds.
   */
  async autoSelectModel(force = false) {
    const config = PROVIDERS[this.provider];
    if (!config) return null;

    let models = await this.listModels(this.provider, force);
    if (models.length === 0) return null;

    if (!force && this.model && models.includes(this.model)) {
      return this.model; // current model is still valid
    }
    if (force && this.model) {
      models = models.filter(m => m !== this.model); // current model is broken — exclude it
      if (models.length === 0) return null;
    }

    const isUnstable = (m) => /(preview|exp|latest|beta)/i.test(m);
    let chosen = null;
    for (const pattern of (config.prefer || [])) {
      const matches = models
        .filter(m => pattern.test(m))
        .sort((a, b) => (versionScore(b) - versionScore(a)) || (isUnstable(a) - isUnstable(b)));
      if (matches.length) {
        chosen = matches.find(m => !isUnstable(m)) || matches[0];
        break;
      }
    }
    if (!chosen) chosen = models[0];

    if (chosen !== this.model) {
      console.log(`[AIEngine] Auto-selected model: ${this.provider}/${chosen}${this.model ? ` (was ${this.model})` : ''}`);
      this.model = chosen;
    }
    return chosen;
  }

  // ── Network Helpers ──

  /**
   * Fetch with AbortController timeout — prevents LLM hangs from freezing the voice pipeline.
   */
  async _fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.llmTimeoutMs);

    // Link the active "voice interrupt" controller (set in processChat) so that a
    // spoken "stop"/"cancel" can abort an in-flight LLM request (Gap 4).
    const ext = this._activeAbortController;
    const onExtAbort = () => controller.abort();
    if (ext) {
      if (ext.signal.aborted) controller.abort();
      else ext.signal.addEventListener('abort', onExtAbort, { once: true });
    }

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (ext) ext.signal.removeEventListener('abort', onExtAbort);
    }
  }

  /**
   * Abort the in-flight LLM request, if any (spoken "stop"/"cancel" — Gap 4).
   * Returns true if there was an active request to abort.
   */
  abortActive() {
    if (this._activeAbortController && !this._activeAbortController.signal.aborted) {
      console.log('[AIEngine] Aborting active request (voice interrupt)');
      this._activeAbortController.abort();
      return true;
    }
    return false;
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
    // No explicit model chosen → auto-pick the best live one in the background
    if (!model) {
      this.autoSelectModel().catch(() => {});
    }
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
    const hasScreenshot = !!context.screenshot;
    console.log(`[AIEngine] Context: ${vpCount} viewport elements, ${mediaCount} media, active: ${activeUrl}${hasScreenshot ? ', +screenshot' : ''}`);

    // Add user message to history
    this.conversationHistory.push({ role: 'user', content: userText });

    // Trim history
    if (this.conversationHistory.length > this.maxHistory) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistory);
    }

    // Store screenshot for the current request (used by _callGemini)
    this._currentScreenshot = context.screenshot || null;

    // Fresh abort controller for this request so a spoken "stop" can cancel it (Gap 4).
    this._activeAbortController = new AbortController();

    try {
      let result = await this._callLLM(systemPrompt, tools);

      const latency = Date.now() - startTime;

      // Multi-turn tool calling loop — allows AI to chain actions
      // e.g. "play finale by Bien" → search_youtube → click first video
      const allToolResults = [];
      let currentResult = result;
      let rounds = 0;
      const MAX_ROUNDS = 3; // allows focus → list_desktop_elements → click chains

      // Navigation tools trigger a page load — after they run we must wait for the
      // extension to send an updated context_update, then inject the fresh viewport
      // elements into the next round's message so the AI can click the right XPaths.
      const NAVIGATION_TOOLS = new Set([
        'search_youtube', 'search_web', 'open_url', 'navigate', 'navigate_to',
        'create_tab', 'go_back', 'go_forward', 'reload_tab', 'make_tab_active',
      ]);

      while (currentResult.toolCalls && currentResult.toolCalls.length > 0 && rounds < MAX_ROUNDS) {
        rounds++;
        const roundResults = [];
        const usedNavigation = currentResult.toolCalls.some(tc => NAVIGATION_TOOLS.has(tc.name));

        for (const toolCall of currentResult.toolCalls) {
          console.log(`[AIEngine] Tool call (round ${rounds}): ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`);
          const toolResult = await this.toolRegistry.executeTool(toolCall.name, toolCall.arguments, this.wsHub);
          roundResults.push({ tool: toolCall.name, result: toolResult });
        }
        allToolResults.push(...roundResults);

        // ── After navigation: wait for extension to push fresh page context ──
        // Without this, round 2 still sees the OLD viewport elements and can't
        // click the right video after search_youtube redirects the page.
        if (usedNavigation && this.wsHub) {
          await new Promise(r => setTimeout(r, 2000));
        }

        // ── Latency short-circuit ──
        // If every tool was a "terminal" action and all succeeded, the command
        // is DONE — skip the extra LLM round that would just say "Okay."
        const allTerminal = currentResult.toolCalls.every(tc => TERMINAL_TOOLS.has(tc.name));
        const allSucceeded = roundResults.every(r => r.result?.status !== 'error' && !r.result?.error);
        if (allTerminal && allSucceeded) {
          this.conversationHistory.push({
            role: 'assistant',
            content: currentResult.text || `[executed: ${roundResults.map(r => r.tool).join(', ')}]`,
          });
          return {
            text: currentResult.text || this._summarizeToolResults(allToolResults),
            toolCalls: allToolResults,
            latency: Date.now() - startTime,
            provider: this.provider,
            model: this.model,
          };
        }

        // Add assistant tool call + results to history
        this.conversationHistory.push({
          role: 'assistant',
          content: currentResult.text || '',
          toolCalls: currentResult.toolCalls
        });

        // Include fresh viewport elements in the next round's message when page changed
        let freshContext = '';
        if (usedNavigation && this.wsHub?.browserContext?.pageContext?.viewportElements?.length > 0) {
          const vp = this.wsHub.browserContext.pageContext.viewportElements;
          const activeTab = this.wsHub.browserContext.activeTab;
          freshContext = `\n\nPage loaded: ${activeTab?.url || 'new page'}\nFresh visible elements (${vp.length} total — use these XPaths for next click):\n` +
            vp.slice(0, 60).map((el, i) =>
              `${i + 1}. <${el.tag}${el.role ? ` role="${el.role}"` : ''}> "${el.label}" — xpath: ${el.xpath}`
            ).join('\n');
        }

        this.conversationHistory.push({
          role: 'user',
          content: this._truncateContent(
            `Tool results: ${JSON.stringify(roundResults.map(r => ({ tool: r.tool, status: r.result?.status || 'done', message: r.result?.message || '' })))}${freshContext}

IMPORTANT: ONLY call another tool if the user explicitly asked for a MULTI-STEP action (like "play [song]" which requires search then click). Do NOT add extra actions the user did not ask for. If the command is complete, respond with a SHORT confirmation or empty text.`
          )
        });

        // Ask AI for next step
        try {
          currentResult = await this._callLLM(systemPrompt, tools);
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
      let finalText = result.text;
      // Never reply with NOTHING when no action was taken — that leaves the
      // user staring at an empty bubble wondering what happened.
      if (!finalText?.trim()) {
        finalText = context.extensionConnected === false
          ? 'The Chrome extension is not connected, so I could not do that in the browser. Click the AbleSpeak extension icon in Chrome to reconnect it.'
          : 'I did not perform any action for that command. Could you rephrase it?';
      }
      this.conversationHistory.push({ role: 'assistant', content: finalText });

      return {
        text: finalText,
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
    } finally {
      // Clean up screenshot so it doesn't persist across requests
      this._currentScreenshot = null;
      this._activeAbortController = null;
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
      '- **System media control**: Use `system_media_control` to play/pause/next/previous music. CRITICAL: when the user names an app ("pause Spotify"), pass app_name — without it the media key goes to the most recently active media app (often the browser), NOT the named app.',
      '- **Type into desktop apps**: Use `system_type_text` to type text into the focused desktop app (use `focus_application` first to pick the app)',
      '- **System volume**: Use `system_volume` to mute, unmute, increase, decrease, or set volume',
      '- **Keyboard shortcuts**: Use `send_system_keys` to send shortcuts like Ctrl+C, Ctrl+V, Alt+F4 to the focused app',
      '- **List running apps**: Use `list_running_apps` to see what applications are currently open',
      '',
      '### Desktop UI Control — click ANYTHING in ANY app (like having hands)',
      '- **Click inside desktop apps**: Use `click_desktop_element` with the element\'s visible name — e.g. name:"Play", app_name:"spotify". Works on every Windows application.',
      '- **See what is clickable**: Use `list_desktop_elements` to scan an app\'s window and get all button/menu/input names with coordinates.',
      '- **Read a window**: Use `read_desktop_window` to read dialogs, documents, error messages in any app.',
      '- **Scroll desktop apps**: Use `desktop_scroll` (browser pages use `scroll` instead).',
      '- **Workflow**: Try `click_desktop_element` directly with the name the user said. If it returns "not found", call `list_desktop_elements`, find the closest matching name, and click that.',
      '- **Double-click** to open files/icons: pass double_click:true.',
      '',
      '## Rules',
      '- Execute commands immediately when the intent is clear. You do NOT need to ask for confirmation yourself — irreversible actions (closing an app, deleting, sending/submitting) are automatically confirmed with the user by the system before they run.',
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
      '- **To search on the current page** (clear search bar and type new query): use the `search_in_page` tool — works on Google, YouTube, Wikipedia, etc.',
      '- **To clear a text field**: use the `clear_field` tool',
      '- **To select radio buttons, checkboxes, tabs, or dropdown options**: use the `select_option` tool with the visible label text — it finds and activates the actual form element. MUCH more reliable than click_element for form controls.',
      '- **To click ANYTHING ELSE in browser**: use the `click_element` tool with the xpath from the Visible Interactive Elements list below',
      '- **To play/pause browser video or audio**: use the `media_control` tool with action "play", "pause", or "toggle"',
      '- **To play/pause desktop media (Spotify, VLC)**: use the `system_media_control` tool with action "play_pause"',
      '- **To type text in browser**: use the `type_text` tool',
      '- **To press keyboard shortcuts**: use `press_key_combination` (browser) or `send_system_keys` (any app)',
      '- **To scroll**: use `scroll` with direction "up" or "down"',
      '- **To switch tabs**: use `make_tab_active` with the tab ID from the Browser Tabs list',
      '- **To switch apps**: use `focus_application` with the app name',
      '',
      '## Examples',
      '- User: "play Finale by Bien" → No app mentioned → call `search_youtube` with query "Finale Bien". After results load, use `navigate_to_link` with label:"Finale Bien" to open the first matching video. NEVER use click_element for YouTube videos — it is silently ignored.',
      '- User: "play Finale by Bien on Spotify" → Spotify mentioned! → `focus_application` app_name:"spotify", then `click_desktop_element` name:"search", app_name:"spotify", then `system_type_text` text:"Finale Bien", then `send_system_keys` keys:"enter"',
      '- User: "play Carisma Sinanoma" → No app → call `search_youtube` with query "Charisma Sina Noma". After results load, use `navigate_to_link` with label:"Charisma" to open the video.',
      '- User: "pause Spotify" → Use `system_media_control` with action:"play_pause", app_name:"spotify" (ALWAYS pass app_name when the user names the app!)',
      '- User: "play the song on Spotify" → Use `system_media_control` with action:"play_pause", app_name:"spotify"',
      '- User: "next song" → Use `system_media_control` with action:"next" (no app named → global media key)',
      '- User: "type hello world in Notepad" → Use `focus_application` with app_name:"notepad", then `system_type_text` with text:"hello world"',
      '- User: "click the like button in Spotify" → Use `click_desktop_element` with name:"like", app_name:"spotify"',
      '- User: "click play on the song in Spotify" → Use `click_desktop_element` with name:"play", app_name:"spotify". If not found, `list_desktop_elements` app_name:"spotify" then click the closest match.',
      '- User: "what does this dialog say" → Use `read_desktop_window`, then tell the user the content',
      '- User: "what\'s on my screen" → Look at the SCREENSHOT attached and describe what you see',
      '- User: "read that error" → Look at the SCREENSHOT for error messages/dialogs and read them out',
      '- User: "open the file report.docx in File Explorer" → Use `click_desktop_element` with name:"report", app_name:"explorer", double_click:true',
      '- User: "open Notepad" → Use `open_application` with app_name:"notepad"',
      '- User: "switch to Chrome" → Use `focus_application` with app_name:"Chrome"',
      '- User: "close Notepad" → Use `close_application` with app_name:"notepad"',
      '- User: "volume up" → Use `system_volume` with action:"up"',
      '- User: "mute" → Use `system_volume` with action:"mute"',
      '- User: "select dark mode" → Use `select_option` with label:"Dark"',
      '- User: "choose light" → Use `select_option` with label:"Light"',
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
      '- **LISTEN for which app the user wants**: If they say "on Spotify", "in Spotify", "on VLC", etc. — use DESKTOP tools, NOT YouTube.',
      '- **Spotify / desktop media players**: Use `focus_application` to bring the app forward, then `click_desktop_element` to interact with it (search, play, etc.). For play/pause/next/previous, use `system_media_control` with `app_name`.',
      '- **YouTube / browser**: Only use `search_youtube` when the user says "on YouTube" OR does not mention any specific app.',
      '- **Default behavior**: If the user just says "play [song]" with NO app mentioned, use `search_youtube`.',
      '- **ALREADY on YouTube search results**: If the active tab URL contains "youtube.com/results" AND the user asks to play a specific video, use `navigate_to_link` with the video title — do NOT call search_youtube again.',
      '- NEVER use click_element for YouTube video thumbnails or titles — YouTube SPA ignores programmatic clicks. ALWAYS use navigate_to_link instead.',
      '- NEVER click on random videos from the YouTube homepage. ALWAYS search first (unless you are already on a search results page with matching videos).',
      '- After search_youtube, the page reloads with new results. Use `navigate_to_link` with the song/video title to open the first matching result.',
      '- Use the song/artist name from what the user said as the search query. Fix obvious misspellings (e.g. "Carisma" → "Charisma").',
      '- Do NOT open a new tab for YouTube if YouTube is already open — just search in the existing tab.',
      '',
      '## CRITICAL: Interacting with Desktop Apps',
      '- When the user mentions a SPECIFIC desktop app (Spotify, Notepad, Word, Excel, etc.), use DESKTOP tools to interact with it.',
      '- **Workflow**: `focus_application` → `list_desktop_elements` (if needed) → `click_desktop_element` or `system_type_text`.',
      '- Use the SCREENSHOT attached to understand what is currently on screen — it shows which app is active and what elements are visible.',
      '- If the user says "click play" or "click the search bar" while a desktop app is visible in the screenshot, use `click_desktop_element` with the app name.',
      '',
      '## IMPORTANT',
      '- Do NOT open new tabs unless explicitly asked.',
      '- You can call multiple tools in sequence. After a tool executes, you will see the result and can call more tools.',
      '- Use xpaths from the Visible Interactive Elements list for clicking browser elements.',
      '- When the user says "play [song]" without mentioning an app, use search_youtube THEN click_element on the first video result.',
      '- When the user says "play [song] on Spotify", use focus_application("spotify") THEN click_desktop_element to search and play.',
      '- YOU CAN CONTROL DESKTOP APPS. Never say "I cannot control Spotify" — use system_media_control instead!',
      '- When creating new documents (Google Docs, Sheets, Slides), ALWAYS use the direct /create URL instead of trying to click UI elements.',
      '- If a click_element does not seem to work, try using open_url with a direct URL as a fallback.',
    ];

    // ── Screen Vision (borrowed from Clicky) ──
    if (context.screenshot) {
      parts.push('', '## 👁️ Desktop Screenshot Attached');
      parts.push('A screenshot of the user\'s current desktop is attached to this message.');
      parts.push('You can see what the user sees — use this to:');
      parts.push('- Identify UI elements, buttons, text, and colors on screen');
      parts.push('- Answer "what\'s on my screen" / "read this" / "what does it say" questions');
      parts.push('- Find the correct element names for click_desktop_element');
      parts.push('- Describe errors, dialogs, or notifications visible on screen');
    }

    // ── Extension status — be honest with the user when browser control is unavailable ──
    if (context.extensionConnected === false) {
      parts.push('', '## ⚠ BROWSER EXTENSION NOT CONNECTED');
      parts.push('The Chrome extension is NOT connected. You CANNOT control the browser right now — no tabs, clicking, YouTube, page reading, or scrolling.');
      parts.push('If the user asks for ANY browser action, do NOT stay silent. Tell them clearly: "The Chrome extension is not connected — click the AbleSpeak extension icon in Chrome to reconnect it."');
      parts.push('Desktop tools still work: system_media_control (pause ANY media via media keys), system_volume, open/close/focus applications, send_system_keys.');
      parts.push('TIP: "pause the video" can still be done with system_media_control action:"play_pause" — the media keys reach the browser too.');
    }

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
        // On YouTube results pages, prioritize video title links so they don't get
        // buried below nav elements. On all other pages, keep standard order.
        const isYouTubeResults = context.activeTab?.url?.includes('youtube.com/results');
        let elements = pc.viewportElements;
        if (isYouTubeResults) {
          const videoLinks = elements.filter(el => el.tag === 'a' && el.label && el.label.length > 10);
          const other = elements.filter(el => !(el.tag === 'a' && el.label && el.label.length > 10));
          elements = [...videoLinks, ...other];
        }
        const CAP = 60;
        elements = elements.slice(0, CAP);
        elements.forEach((el, i) => {
          const extras = [];
          if (el.disabled) extras.push('disabled');
          if (el.checked !== null) extras.push(el.checked ? 'checked' : 'unchecked');
          if (el.value) extras.push(`value="${el.value.slice(0, 60)}"`);
          if (el.focused) extras.push('FOCUSED');
          const suffix = extras.length ? ` (${extras.join(', ')})` : '';
          parts.push(`${i + 1}. <${el.tag}${el.role ? ` role="${el.role}"` : ''}> "${el.label}"${suffix} — xpath: ${el.xpath}`);
        });
        if (pc.viewportElements.length > CAP) {
          parts.push(`... and ${pc.viewportElements.length - CAP} more elements not shown`);
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
    // Import the silent tool checker
    const SILENT = new Set([
      'scroll', 'scroll_to_top', 'scroll_to_bottom',
      'go_back', 'go_forward', 'focus_next', 'focus_prev',
      'reload_tab', 'close_tab', 'click_element', 'select_option',
      'press_key_combination', 'media_control',
      'system_media_control', 'system_volume',
      'send_system_keys', 'open_url', 'create_tab',
      'search_web', 'search_youtube', 'search_in_page', 'type_text',
      'make_tab_active', 'scroll_element', 'clear_field',
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

  // ── LLM Dispatch (with retired-model auto-recovery) ──

  _isModelError(err) {
    return /404|not[_ ]?found|no longer available|not available|does not exist|deprecated|decommissioned|invalid model/i
      .test(err?.message || '');
  }

  _dispatch(systemPrompt, tools) {
    if (this.provider === 'gemini') return this._callGemini(systemPrompt, tools);
    if (this.provider === 'anthropic') return this._callAnthropic(systemPrompt, tools);
    // OpenAI-compatible (openai, azure, ollama, groq)
    return this._callOpenAICompatible(systemPrompt, tools);
  }

  /**
   * Call the current provider. If the configured model has been retired
   * (404 / "no longer available"), auto-select a live replacement and retry once.
   */
  async _callLLM(systemPrompt, tools) {
    try {
      return await this._dispatch(systemPrompt, tools);
    } catch (err) {
      if (!this._isModelError(err)) throw err;
      console.warn(`[AIEngine] Model "${this.model}" appears unavailable — auto-selecting a replacement...`);
      const replacement = await this.autoSelectModel(true);
      if (!replacement) throw err;
      return await this._dispatch(systemPrompt, tools);
    }
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

    const contents = this.conversationHistory.map((m, idx) => {
      const parts = [{ text: m.content }];

      // ── Screen Vision (borrowed from Clicky) ──
      // Attach desktop screenshot to the LAST user message so Gemini can see
      // what the user sees when they give a voice command.
      if (m.role === 'user' && idx === this.conversationHistory.length - 1 && this._currentScreenshot) {
        parts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: this._currentScreenshot,
          }
        });
        console.log(`[AIEngine] Attached screenshot to Gemini request`);
      }

      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      };
    });

    const generationConfig = { temperature: this.temperature };
    // Gemini 2.5+ models "think" by default, adding seconds of latency.
    // Voice commands need speed, not deep reasoning — disable thinking.
    if (/^gemini-2\.5/.test(model)) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig,
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
