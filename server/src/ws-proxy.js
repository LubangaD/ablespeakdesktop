import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { insertCommand, insertSession, endSession, getStudents, upsertHealthCheck, getSpeechProfile } from './db.js';
import { matchStudentName } from './identity.js';
import { getFullSystemContext } from './system-info.js';
import { VoiceHandler } from './voice-handler.js';
import { matchFastCommand, isSilentTool, isBrowserTool, listCanonicalPhrases } from './fast-commands.js';
import { parseConfirmationReply } from './safety.js';
import { evaluateTranscript } from './speech-tuning.js';

/**
 * AbleSpeak WebSocket Hub
 * 
 * STANDALONE mode — no Voqal dependency.
 * - Manages Chrome extension connections (receives context, sends tool commands)
 * - Manages dashboard connections (chat, status, context broadcast)
 * - Routes chat commands to AIEngine for processing
 */

export class WsProxy {
  constructor({ server, aiEngine, dashboardPath = '/ws/dashboard', extensionPath = '/ws/extension' }) {
    this.aiEngine = aiEngine;
    this.voiceHandler = new VoiceHandler();
    this.extensionClients = new Set();
    this.dashboardClients = new Set();
    this.pendingToolCalls = new Map(); // id → { resolve, reject, timeout }
    this.activePrompt = 'ablespeak';
    this.lastContextUpdate = null;
    this.browserContext = { tabs: [], activeTab: null };
    this._voiceProcessing = false; // Mutex: prevents concurrent voice command processing
    this._pendingConfirmation = null; // { toolName, args, prompt, expiresAt, unclearCount }
    this._pendingRepair = null; // { candidate, expiresAt, unclearCount } — "Did you mean X?" state
    this._activeSession = null; // { studentId, sessionId } — set by startStudentSession
    this._pickerState = null;   // null | { retryCount, awaitingConfirmation, pendingStudent }
    this._fallbackCapture = null; // callback installed by handleVoiceText() for HTTP/IPC path

    // Extension-facing WS server
    this.extensionWss = new WebSocketServer({ noServer: true });
    this.extensionWss.on('connection', (ws) => this._handleExtensionConnect(ws));

    // Dashboard-facing WS server
    this.dashboardWss = new WebSocketServer({ noServer: true });
    this.dashboardWss.on('connection', (ws) => this._handleDashboardConnect(ws));

    // Handle HTTP upgrade
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

      if (pathname === extensionPath) {
        this.extensionWss.handleUpgrade(request, socket, head, (ws) => {
          this.extensionWss.emit('connection', ws, request);
        });
      } else if (pathname === dashboardPath) {
        this.dashboardWss.handleUpgrade(request, socket, head, (ws) => {
          this.dashboardWss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    // Heartbeat: detect and prune dead WebSocket connections (Fix #4)
    this._heartbeatInterval = setInterval(() => {
      const prune = (clients, label) => {
        for (const ws of clients) {
          if (ws._isAlive === false) {
            console.log(`[WsHub] Pruning dead ${label} client`);
            ws.terminate();
            clients.delete(ws);
            continue;
          }
          ws._isAlive = false;
          try { ws.ping(); } catch { clients.delete(ws); }
        }
      };
      prune(this.extensionClients, 'extension');
      prune(this.dashboardClients, 'dashboard');
    }, 30000);
  }

  // ── Extension Client Handling ──

  _handleExtensionConnect(ws) {
    console.log('[WsHub] Extension client connected');
    this.extensionClients.add(ws);
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });
    upsertHealthCheck({ component: 'chrome_ext', status: 'ok', message: 'Chrome extension connected' });
    this._broadcastDashboard({ type: 'extension_status', connected: true, count: this.extensionClients.size });

    ws.on('message', (data) => {
      const raw = data.toString();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      // Handle keepalive pings from extension
      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Track context updates from extension
      if (parsed.type === 'context_update') {
        this.lastContextUpdate = parsed;
        // Update browser context
        if (parsed.result) {
          this.browserContext = parsed.result;
        } else if (parsed.context === 'integration' && parsed.result) {
          this.browserContext = parsed.result;
        }
        this._broadcastDashboard({ type: 'context_update', data: parsed, timestamp: new Date().toISOString() });
      }

      // Handle tool call responses from extension
      if (parsed.voqal_resp_id || parsed.replyTo) {
        const id = parsed.voqal_resp_id || parsed.replyTo;
        const pending = this.pendingToolCalls.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingToolCalls.delete(id);
          pending.resolve(parsed.result || parsed);
        }
      }
    });

    ws.on('close', () => {
      this.extensionClients.delete(ws);
      console.log('[WsHub] Extension client disconnected');
      if (this.extensionClients.size === 0) {
        upsertHealthCheck({ component: 'chrome_ext', status: 'warn', message: 'No extension clients connected' });
      }
      this._broadcastDashboard({ type: 'extension_status', connected: this.extensionClients.size > 0, count: this.extensionClients.size });
    });

    ws.on('error', (err) => {
      console.error('[WsHub] Extension client error:', err.message);
    });
  }

  // ── Dashboard Client Handling ──

  _handleDashboardConnect(ws) {
    console.log('[WsHub] Dashboard client connected');
    this.dashboardClients.add(ws);
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });

    // Send current status on connect
    ws.send(JSON.stringify({
      type: 'initial_status',
      voqalConnected: true, // We ARE the agent now
      extensionCount: this.extensionClients.size,
      activePrompt: this.activePrompt,
      aiEngine: this.aiEngine?.getStatus() || {},
      timestamp: new Date().toISOString()
    }));

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // ── Chat Command → AI Engine ──
        if (msg.type === 'chat_command' && msg.text) {
          const commandId = uuidv4();
          console.log(`[Chat] Command: "${msg.text}"`);

          // Build context for the LLM
          const systemContext = getFullSystemContext();
          const context = {
            tabs: this.browserContext.tabs || [],
            activeTab: this.browserContext.activeTab || null,
            pageContext: this.browserContext.pageContext || null,
            extensionConnected: this.extensionClients.size > 0,
            currentTime: new Date().toLocaleString(),
            computerInfo: systemContext.computerInfo,
            visibleApplications: systemContext.visibleApplications,
          };

          // Process through AI engine
          const result = await this.aiEngine.processChat(msg.text, context);

          // Store pending confirmation if a tool requires it (chat path)
          const confirmItem = result.toolCalls?.find(tc => tc.result?.needsConfirmation);
          if (confirmItem) {
            this._pendingConfirmation = { toolName: confirmItem.result.toolName, args: confirmItem.result.args, prompt: confirmItem.result.prompt, expiresAt: Date.now() + 30000, unclearCount: 0 };
          }

          // Persist to DB
          try {
            insertCommand({
              id: commandId,
              type: 'chat',
              direction: 'user_to_ai',
              payload: JSON.stringify({ text: msg.text }),
              result: JSON.stringify(result),
              latency_ms: result.latency || 0,
              session_id: this._activeSession?.sessionId ?? null,
              student_id: this._activeSession?.studentId ?? null,
            });
          } catch (err) {
            console.error('[WsHub] DB insert error:', err.message);
          }

          // Send response to dashboard — when confirmation is pending, override with the exact prompt
          this._broadcastDashboard({
            type: 'chat_assistant_message',
            id: commandId,
            text: confirmItem ? confirmItem.result.prompt : result.text,
            error: result.error || false,
            toolCalls: result.toolCalls,
            provider: result.provider,
            model: result.model,
            latency: result.latency,
            timestamp: new Date().toISOString()
          });
        }

        // ── Voice Audio → Transcribe → Gates → Fast Route OR AI Pipeline ──
        if (msg.type === 'voice_audio' && msg.audio) {
          // Mutex: prevent concurrent voice commands (Fix #5)
          if (this._voiceProcessing) {
            ws.send(JSON.stringify({
              type: 'voice_busy',
              message: 'Still processing previous command',
              timestamp: new Date().toISOString()
            }));
            return;
          }
          this._voiceProcessing = true;

          try {
            const startTime = Date.now();
            console.log(`[Voice] Received audio (${Math.round(msg.audio.length / 1024)}KB)`);

            // Per-student thresholds: load the active student's profile for this interaction
            const profile = this._loadSpeechProfile();

            // Transcribe with Gemini — profile drives the audio floor + vocabulary bias
            const { text, error, reason } = await this.voiceHandler.transcribe(msg.audio, msg.mimeType || 'audio/webm', profile);

            if (error === 'no_speech') {
              ws.send(JSON.stringify({ type: 'voice_no_speech', reason: reason || 'no_speech', timestamp: new Date().toISOString() }));
              return;
            }
            if (error) {
              ws.send(JSON.stringify({ type: 'voice_error', error, timestamp: new Date().toISOString() }));
              return;
            }

            // Gemini provides no confidence scores → null (fuzzy evaluation only)
            await this._handleVoiceText(text, null, profile, ws, startTime);
          } finally {
            this._voiceProcessing = false;
          }
        }

        // ── Voice Text (Web Speech results, with confidence) → same gates/pipeline ──
        if (msg.type === 'voice_text' && typeof msg.text === 'string' && msg.text.trim()) {
          if (this._voiceProcessing) {
            ws.send(JSON.stringify({ type: 'voice_busy', message: 'Still processing previous command', timestamp: new Date().toISOString() }));
            return;
          }
          this._voiceProcessing = true;

          try {
            const startTime = Date.now();
            const profile = this._loadSpeechProfile();
            const confidence = typeof msg.confidence === 'number' ? msg.confidence : null;
            await this._handleVoiceText(msg.text.trim(), confidence, profile, ws, startTime);
          } finally {
            this._voiceProcessing = false;
          }
        }

        // ── Switch LLM Provider ──
        if (msg.type === 'switch_provider') {
          try {
            const result = this.aiEngine.setProvider(msg.provider, msg.model);
            this._broadcastDashboard({
              type: 'provider_switched',
              ...result,
              timestamp: new Date().toISOString()
            });
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'provider_error',
              error: err.message,
              timestamp: new Date().toISOString()
            }));
          }
        }

        // ── Clear Chat History ──
        if (msg.type === 'clear_history') {
          this.aiEngine.clearHistory();
          this._broadcastDashboard({ type: 'history_cleared', timestamp: new Date().toISOString() });
        }

      } catch (err) {
        console.error('[WsHub] Dashboard message error:', err.message);
      }
    });

    ws.on('close', () => {
      this.dashboardClients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('[WsHub] Dashboard client error:', err.message);
    });
  }

  // ── Voice Pipeline (shared by voice_audio and voice_text) ──

  /** Load the active student's speech profile; defaults when no student or DB error. */
  _loadSpeechProfile() {
    try {
      return getSpeechProfile(this._activeSession?.studentId ?? null);
    } catch (err) {
      console.error('[Voice] speech profile load failed, using defaults:', err.message);
      return null;
    }
  }

  /**
   * Gate order: confirmation → repair → picker → evaluate → normal (fast/AI).
   * confidence is null when the recognizer gives no scores (Gemini path).
   */
  async _handleVoiceText(text, confidence, profile, ws, startTime) {
    // Send transcription to dashboard + overlay ('Heard: …' readout)
    this._broadcastDashboard({
      type: 'voice_transcription',
      text,
      confidence,
      latency: Date.now() - startTime,
      timestamp: new Date().toISOString()
    });

    const commandId = uuidv4();
    console.log(`[Voice] Command: "${text}"${confidence != null ? ` (confidence ${confidence.toFixed(2)})` : ''}`);

    // ────────────────────────────────────────────
    // CONFIRMATION GATE: pending yes/no reply?
    // ────────────────────────────────────────────
    if (this._pendingConfirmation) {
      if (Date.now() >= this._pendingConfirmation.expiresAt) {
        this._pendingConfirmation = null; // expired — fall through to normal processing
      } else {
        const reply = parseConfirmationReply(text);
        if (reply === 'yes') {
          const { toolName, args } = this._pendingConfirmation;
          this._pendingConfirmation = null;
          const toolResult = await this.aiEngine.toolRegistry.executeTool(toolName, args, this, { confirmed: true });
          const responseText = this.aiEngine._summarizeToolResults([{ tool: toolName, result: toolResult }]);
          try {
            insertCommand({ id: commandId, type: 'voice_confirm', direction: 'user_to_ai', payload: JSON.stringify({ text, toolName, args }), result: JSON.stringify(toolResult), latency_ms: Date.now() - startTime, session_id: this._activeSession?.sessionId ?? null, student_id: this._activeSession?.studentId ?? null, outcome: (toolResult?.status === 'error' || toolResult?.error) ? 'failed' : 'success', prompt_count: 0 });
          } catch {}
          this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: responseText, error: toolResult?.status === 'error' || false, toolCalls: [{ tool: toolName, result: toolResult }], provider: 'confirmation', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
          return;
        } else if (reply === 'no') {
          this._pendingConfirmation = null;
          this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: 'Cancelled.', error: false, toolCalls: null, provider: 'confirmation', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
          return;
        } else { // unclear
          this._pendingConfirmation.unclearCount = (this._pendingConfirmation.unclearCount || 0) + 1;
          const { prompt, unclearCount } = this._pendingConfirmation;
          const responseText = unclearCount >= 2 ? 'Cancelled.' : prompt;
          if (unclearCount >= 2) this._pendingConfirmation = null;
          this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: responseText, error: false, toolCalls: null, provider: 'confirmation', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
          return;
        }
      }
    }

    // ────────────────────────────────────────────
    // REPAIR GATE: pending "Did you mean X?" reply?
    // ────────────────────────────────────────────
    if (this._pendingRepair) {
      if (Date.now() >= this._pendingRepair.expiresAt) {
        this._pendingRepair = null; // expired — fall through to normal processing
        this._broadcastDashboard({ type: 'repair_clear', timestamp: new Date().toISOString() });
      } else {
        const reply = parseConfirmationReply(text);
        if (reply === 'yes') {
          const { candidate } = this._pendingRepair;
          this._pendingRepair = null;
          this._broadcastDashboard({ type: 'repair_clear', timestamp: new Date().toISOString() });
          // Confirmed candidate goes through the NORMAL pipeline (fast-match then AI)
          await this._executeVoiceCommand(candidate, { commandId, startTime, repaired: true });
          return;
        }
        if (reply === 'no') {
          this._pendingRepair = null;
          this._broadcastDashboard({ type: 'repair_clear', timestamp: new Date().toISOString() });
          this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: 'Okay.', error: false, toolCalls: null, provider: 'repair', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
          return;
        }
        // unclear — if the reply is itself a valid command, it wins over the repair
        if (matchFastCommand(text)) {
          this._pendingRepair = null;
          this._broadcastDashboard({ type: 'repair_clear', timestamp: new Date().toISOString() });
          // fall through: treat as a brand-new command
        } else {
          this._pendingRepair.unclearCount = (this._pendingRepair.unclearCount || 0) + 1;
          const { candidate, unclearCount } = this._pendingRepair;
          if (unclearCount >= 2) {
            this._pendingRepair = null;
            this._broadcastDashboard({ type: 'repair_clear', timestamp: new Date().toISOString() });
            this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: 'Okay.', error: false, toolCalls: null, provider: 'repair', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
            return;
          }
          // Re-ask once
          const prompt = `Did you mean "${candidate}"?`;
          this._broadcastDashboard({ type: 'repair_prompt', question: prompt, candidate, timestamp: new Date().toISOString() });
          this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: prompt, error: false, toolCalls: null, provider: 'repair', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
          return;
        }
      }
    }

    // ────────────────────────────────────────────
    // PICKER GATE: Student identity selection
    // ────────────────────────────────────────────
    {
      const pickerResult = await this._handlePickerGate(text, commandId, startTime);
      if (pickerResult === 'handled') return;
    }

    // ────────────────────────────────────────────
    // EVALUATE: per-student thresholds → accept / repair / reject
    // ────────────────────────────────────────────
    const evaluation = evaluateTranscript({ transcript: text, confidence, profile, knownCommands: listCanonicalPhrases() });

    if (evaluation.action === 'reject') {
      // Never a silent drop — overlay renders failed(<reason>)
      ws.send(JSON.stringify({ type: 'voice_no_speech', reason: evaluation.reason, timestamp: new Date().toISOString() }));
      return;
    }

    if (evaluation.action === 'repair') {
      this._pendingRepair = { candidate: evaluation.candidate, expiresAt: Date.now() + 30000, unclearCount: 0 };
      const prompt = `Did you mean "${evaluation.candidate}"?`;
      console.log(`[Voice] Repair: "${text}" → "${evaluation.candidate}"`);
      this._broadcastDashboard({ type: 'repair_prompt', question: prompt, candidate: evaluation.candidate, timestamp: new Date().toISOString() });
      this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: prompt, error: false, toolCalls: null, provider: 'repair', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
      return;
    }

    // accept → normal pipeline
    await this._executeVoiceCommand(text, { commandId, startTime, repaired: false });
  }

  /**
   * NORMAL pipeline: fast-command match, else AI engine.
   * repaired=true stamps the command outcome='repaired', prompt_count=1.
   */
  async _executeVoiceCommand(text, { commandId, startTime, repaired = false }) {
    // ────────────────────────────────────────────
    // FAST PATH: Match common commands instantly
    // ────────────────────────────────────────────
    const fastMatch = matchFastCommand(text);

    if (fastMatch) {
      console.log(`[Voice] ⚡ Fast match: ${fastMatch.tool}(${JSON.stringify(fastMatch.args)})`);

      // Intercept student management fast commands
      if (fastMatch.tool === 'switch_student') {
        if (this._activeSession) {
          try { endSession(this._activeSession.sessionId); } catch {}
          this._activeSession = null;
        }
        this._pickerState = null;
        const students = getStudents();
        const responseText = students.length === 0 ? "No students in roster." : "Who's using AbleSpeak?";
        if (students.length > 0) {
          this._pickerState = { retryCount: 0, awaitingConfirmation: false, pendingStudent: null };
          this._broadcastDashboard({ type: 'picker_prompt', question: "Who's using AbleSpeak?", names: students.map(s => s.display_name), timestamp: new Date().toISOString() });
        }
        this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: responseText, error: false, toolCalls: null, provider: 'picker', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
        return;
      }

      if (fastMatch.tool === 'set_student_by_name') {
        const students = getStudents();
        const { student, confidence } = matchStudentName(fastMatch.args.name, students);
        if (student && confidence >= 0.5) {
          this._pickerState = null;
          this.startStudentSession(student.id);
          const responseText = `Hi ${student.display_name}!`;
          this._broadcastDashboard({ type: 'picker_clear', timestamp: new Date().toISOString() });
          this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: responseText, error: false, toolCalls: null, provider: 'picker', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
        } else {
          this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: "Sorry, I didn't catch that name. Who's using AbleSpeak?", error: false, toolCalls: null, provider: 'picker', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
        }
        return;
      }

      const toolResult = await this.aiEngine.toolRegistry.executeTool(fastMatch.tool, fastMatch.args, this);
      const latency = Date.now() - startTime;

      // Auto-focus browser for browser commands
      if (isBrowserTool(fastMatch.tool)) {
        this._autoFocusBrowser();
      }

      // Persist to DB
      try {
        insertCommand({
          id: commandId,
          type: 'voice_fast',
          direction: 'user_to_ai',
          payload: JSON.stringify({ text, fastTool: fastMatch.tool }),
          result: JSON.stringify(toolResult),
          latency_ms: latency,
          session_id: this._activeSession?.sessionId ?? null,
          student_id: this._activeSession?.studentId ?? null,
          outcome: repaired ? 'repaired' : ((toolResult?.status === 'error' || toolResult?.error) ? 'failed' : 'success'),
          prompt_count: repaired ? 1 : 0,
        });
      } catch (err) {
        console.error('[WsHub] DB insert error:', err.message);
      }

      // Send response — silent tools get empty text (no TTS)
      const responseText = fastMatch.silent ? '' : (toolResult?.message || `Done: ${fastMatch.tool}`);
      this._broadcastDashboard({
        type: 'chat_assistant_message',
        id: commandId,
        text: responseText,
        error: false,
        toolCalls: [{ tool: fastMatch.tool, result: toolResult }],
        provider: 'fast',
        model: 'pattern-match',
        latency,
        source: 'voice',
        silent: fastMatch.silent,
        timestamp: new Date().toISOString()
      });

      console.log(`[Voice] ⚡ Fast executed in ${latency}ms (silent: ${fastMatch.silent})`);
      return;
    }

    // ────────────────────────────────────────────
    // FULL AI PATH: Complex commands go to LLM
    // ────────────────────────────────────────────
    const systemContext = getFullSystemContext();
    const context = {
      tabs: this.browserContext.tabs || [],
      activeTab: this.browserContext.activeTab || null,
      pageContext: this.browserContext.pageContext || null,
      extensionConnected: this.extensionClients.size > 0,
      currentTime: new Date().toLocaleString(),
      computerInfo: systemContext.computerInfo,
      visibleApplications: systemContext.visibleApplications,
    };

    const result = await this.aiEngine.processChat(text, context);

    // Store pending confirmation if a tool requires it
    const confirmItem = result.toolCalls?.find(tc => tc.result?.needsConfirmation);
    if (confirmItem) {
      this._pendingConfirmation = { toolName: confirmItem.result.toolName, args: confirmItem.result.args, prompt: confirmItem.result.prompt, expiresAt: Date.now() + 30000, unclearCount: 0 };
    }

    // Auto-focus browser if AI used browser tools
    if (result.toolCalls && Array.isArray(result.toolCalls)) {
      const usedBrowserTool = result.toolCalls.some(tc => isBrowserTool(tc.tool || tc.name));
      if (usedBrowserTool) {
        this._autoFocusBrowser();
      }
    }

    // Determine if the response should be silent
    let silent = false;
    if (result.toolCalls && Array.isArray(result.toolCalls) && !result.text?.trim()) {
      silent = result.toolCalls.every(tc => isSilentTool(tc.tool || tc.name));
    }

    try {
      insertCommand({
        id: commandId,
        type: 'voice',
        direction: 'user_to_ai',
        payload: JSON.stringify({ text, source: 'microphone' }),
        result: JSON.stringify(result),
        latency_ms: result.latency || 0,
        session_id: this._activeSession?.sessionId ?? null,
        student_id: this._activeSession?.studentId ?? null,
        outcome: repaired ? 'repaired' : (result?.error ? 'failed' : 'success'),
        prompt_count: repaired ? 1 : 0,
      });
    } catch (err) {
      console.error('[WsHub] DB insert error:', err.message);
    }

    this._broadcastDashboard({
      type: 'chat_assistant_message',
      id: commandId,
      text: confirmItem ? confirmItem.result.prompt : result.text,
      error: result.error || false,
      toolCalls: result.toolCalls,
      provider: result.provider,
      model: result.model,
      latency: result.latency,
      source: 'voice',
      silent,
      timestamp: new Date().toISOString()
    });
  }

  // ── Auto-focus browser window after browser commands ──
  async _autoFocusBrowser() {
    try {
      const { focusApplication } = await import('./system-tools.js');
      
      // Try to detect which browser the extension is connected to
      const activeTab = this.browserContext?.activeTab;
      let browserName = null;

      // Check if we know the browser from extension user agent or tab info
      if (activeTab?.browserName) {
        browserName = activeTab.browserName;
      }

      // Try detected browser first, then common browsers
      const browsers = browserName 
        ? [browserName, 'Brave', 'Chrome', 'Edge']
        : ['Brave', 'Chrome', 'Edge'];

      for (const browser of browsers) {
        try {
          await focusApplication(browser);
          return; // Success — stop trying
        } catch {
          continue;
        }
      }
    } catch {
      // Silently fail — don't block the voice pipeline
    }
  }

  // ── Tool Execution → Extension ──

  sendToolToExtension(type, payload) {
    return new Promise((resolve, reject) => {
      if (this.extensionClients.size === 0) {
        // No extension — execute what we can locally
        if (type === 'create_tab' || type === 'navigate_to') {
          resolve({ status: 'success', message: `Would open: ${payload.url}`, simulated: true });
          return;
        }
        reject(new Error('No Chrome extension connected. Please install and enable the AbleSpeak extension.'));
        return;
      }

      const callId = uuidv4();
      const message = JSON.stringify({
        type,
        payload,
        replyTo: callId,
      });

      console.log(`[WsHub] → Extension: type=${type}, id=${callId}, payload=${typeof payload === 'string' ? payload.substring(0, 120) + '...' : JSON.stringify(payload)}`);

      // Set timeout — resolve even on timeout so the chat doesn't hang
      const timeout = setTimeout(() => {
        console.log(`[WsHub] ⏱ Timeout for ${type} (id=${callId})`);
        this.pendingToolCalls.delete(callId);
        resolve({ status: 'success', message: `Command ${type} sent to extension (timeout waiting for response)` });
      }, 10000);

      this.pendingToolCalls.set(callId, {
        resolve: (result) => {
          console.log(`[WsHub] ← Extension response for ${type}: ${JSON.stringify(result).substring(0, 200)}`);
          resolve(result);
        },
        reject,
        timeout,
      });

      // Send to first connected extension
      const ext = [...this.extensionClients][0];
      if (ext && ext.readyState === WebSocket.OPEN) {
        ext.send(message);
      } else {
        clearTimeout(timeout);
        this.pendingToolCalls.delete(callId);
        resolve({ status: 'error', message: `Extension WebSocket not open` });
      }
    });
  }

  // ── Broadcasting ──

  _broadcastDashboard(message) {
    if (this._fallbackCapture) this._fallbackCapture(message);
    const raw = JSON.stringify(message);
    this.dashboardClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    });
  }

  /**
   * Public entry point for the HTTP/IPC fallback path.
   * Runs the same gate pipeline as the WS voice_text path and returns
   * the collected events (same WS broadcast message shape) so the caller
   * can forward them to the overlay without losing any gate behaviour.
   */
  async handleVoiceText(text, confidence) {
    if (this._voiceProcessing) {
      return [{ type: 'voice_busy', message: 'Still processing previous command', timestamp: new Date().toISOString() }];
    }

    const startTime = Date.now();
    const events = [];

    // Capture messages sent directly to the overlay via ws.send (reject path)
    const mockWs = {
      send: (raw) => {
        try { events.push(JSON.parse(raw)); } catch {}
      }
    };

    // Capture messages broadcast to dashboard clients
    this._fallbackCapture = (msg) => events.push(msg);

    this._voiceProcessing = true;

    try {
      const profile = this._loadSpeechProfile();
      await this._handleVoiceText(text, confidence, profile, mockWs, startTime);
    } finally {
      this._voiceProcessing = false;
      this._fallbackCapture = null;
    }

    return events;
  }

  // ── Public API ──

  getStatus() {
    return {
      voqalConnected: true, // We ARE the agent
      extensionClients: this.extensionClients.size,
      dashboardClients: this.dashboardClients.size,
      activePrompt: this.activePrompt,
      pendingCommands: this.pendingToolCalls.size,
      lastContextUpdate: this.lastContextUpdate ? new Date().toISOString() : null,
      aiEngine: this.aiEngine?.getStatus() || {},
    };
  }

  setActivePrompt(prompt) {
    this.activePrompt = prompt;
    this._broadcastDashboard({ type: 'prompt_switch', prompt, timestamp: new Date().toISOString() });
  }

  getLastContext() {
    return this.lastContextUpdate;
  }

  // ── Voice Student Picker ──

  /**
   * Handle student picker gate for incoming voice text.
   * Returns 'handled' if the text was consumed by the picker, null otherwise.
   */
  async _handlePickerGate(text, commandId, startTime) {
    // If student already selected, pass through
    if (this._activeSession) return null;

    const students = getStudents();

    // Empty roster — skip picker entirely
    if (students.length === 0) return null;

    // Single student — auto-select on first interaction, then replay the utterance
    if (students.length === 1 && !this._pickerState) {
      this.startStudentSession(students[0].id);
      const responseText = `Hi ${students[0].display_name}!`;
      this._broadcastDashboard({ type: 'picker_clear', timestamp: new Date().toISOString() });
      this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: responseText, error: false, toolCalls: null, provider: 'picker', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
      return null; // fall through so the triggering utterance is processed normally
    }

    // Not in picker mode yet — enter it, ask the question
    if (!this._pickerState) {
      this._pickerState = { retryCount: 0, awaitingConfirmation: false, pendingStudent: null };
      this._broadcastDashboard({ type: 'picker_prompt', question: "Who's using AbleSpeak?", names: students.map(s => s.display_name), timestamp: new Date().toISOString() });
      this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: "Who's using AbleSpeak?", error: false, toolCalls: null, provider: 'picker', model: 'gate', latency: Date.now() - startTime, source: 'voice', timestamp: new Date().toISOString() });
      return 'handled';
    }

    // In picker mode — handle the response
    const latency = Date.now() - startTime;

    // If awaiting yes/no confirmation for a candidate
    if (this._pickerState.awaitingConfirmation) {
      const reply = parseConfirmationReply(text);
      if (reply === 'yes') {
        const student = this._pickerState.pendingStudent;
        this._pickerState = null;
        this.startStudentSession(student.id);
        const responseText = `Hi ${student.display_name}!`;
        this._broadcastDashboard({ type: 'picker_clear', timestamp: new Date().toISOString() });
        this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: responseText, error: false, toolCalls: null, provider: 'picker', model: 'gate', latency, source: 'voice', timestamp: new Date().toISOString() });
        return 'handled';
      } else {
        // no or unclear — re-ask or give up
        this._pickerState.retryCount++;
        this._pickerState.awaitingConfirmation = false;
        this._pickerState.pendingStudent = null;
        if (this._pickerState.retryCount >= 2) {
          this._pickerState = null;
          this._broadcastDashboard({ type: 'picker_clear', timestamp: new Date().toISOString() });
          this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: "Okay — continuing without a profile.", error: false, toolCalls: null, provider: 'picker', model: 'gate', latency, source: 'voice', timestamp: new Date().toISOString() });
          return 'handled';
        }
        this._broadcastDashboard({ type: 'picker_prompt', question: "Who's using AbleSpeak?", names: students.map(s => s.display_name), timestamp: new Date().toISOString() });
        this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: "Who's using AbleSpeak?", error: false, toolCalls: null, provider: 'picker', model: 'gate', latency, source: 'voice', timestamp: new Date().toISOString() });
        return 'handled';
      }
    }

    // Try to match a student name — honour "I'm {name}" pattern by extracting name first
    const preFast = matchFastCommand(text);
    // "switch student" mid-picker: reset to fresh state without burning a retry
    if (preFast?.tool === 'switch_student') {
      this._pickerState = { retryCount: 0, awaitingConfirmation: false, pendingStudent: null };
      this._broadcastDashboard({ type: 'picker_prompt', question: "Who's using AbleSpeak?", names: students.map(s => s.display_name), timestamp: new Date().toISOString() });
      this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: "Who's using AbleSpeak?", error: false, toolCalls: null, provider: 'picker', model: 'gate', latency, source: 'voice', timestamp: new Date().toISOString() });
      return 'handled';
    }
    const matchText = preFast?.tool === 'set_student_by_name' ? preFast.args.name : text;
    const { student, confidence } = matchStudentName(matchText, students);

    if (student && confidence >= 0.8) {
      // High confidence — select immediately
      this._pickerState = null;
      this.startStudentSession(student.id);
      const responseText = `Hi ${student.display_name}!`;
      this._broadcastDashboard({ type: 'picker_clear', timestamp: new Date().toISOString() });
      this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: responseText, error: false, toolCalls: null, provider: 'picker', model: 'gate', latency, source: 'voice', timestamp: new Date().toISOString() });
      return 'handled';
    }

    if (student && confidence >= 0.5) {
      // Medium confidence — ask for confirmation
      this._pickerState.awaitingConfirmation = true;
      this._pickerState.pendingStudent = student;
      const prompt = `Did you mean ${student.display_name} — yes or no?`;
      this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: prompt, error: false, toolCalls: null, provider: 'picker', model: 'gate', latency, source: 'voice', timestamp: new Date().toISOString() });
      return 'handled';
    }

    // No match — re-ask or give up
    this._pickerState.retryCount++;
    if (this._pickerState.retryCount >= 2) {
      this._pickerState = null;
      this._broadcastDashboard({ type: 'picker_clear', timestamp: new Date().toISOString() });
      this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: "Okay — continuing without a profile.", error: false, toolCalls: null, provider: 'picker', model: 'gate', latency, source: 'voice', timestamp: new Date().toISOString() });
      return 'handled';
    }
    this._broadcastDashboard({ type: 'picker_prompt', question: "Who's using AbleSpeak?", names: students.map(s => s.display_name), timestamp: new Date().toISOString() });
    this._broadcastDashboard({ type: 'chat_assistant_message', id: commandId, text: "Who's using AbleSpeak?", error: false, toolCalls: null, provider: 'picker', model: 'gate', latency, source: 'voice', timestamp: new Date().toISOString() });
    return 'handled';
  }

  // ── Student Session Management ──

  startStudentSession(studentId) {
    if (this._activeSession) {
      try { endSession(this._activeSession.sessionId); } catch {}
      this._activeSession = null;
    }
    const sessionId = uuidv4();
    try {
      insertSession({ id: sessionId, started_at: new Date().toISOString(), student_id: studentId });
      this._activeSession = { studentId, sessionId };
      return this._activeSession;
    } catch (err) {
      console.error('[WsHub] startStudentSession DB error:', err.message);
      return null;
    }
  }

  getActiveSession() { return this._activeSession; }

  // Legacy compat
  sendCommandToVoqal() { return false; }
  sendCommandToExtension(data) {
    const raw = JSON.stringify(data);
    let sent = 0;
    this.extensionClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
        sent++;
      }
    });
    return sent;
  }

  // ── Cleanup (perf fix #8) ──
  destroy() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    this.extensionClients.forEach(ws => ws.terminate());
    this.dashboardClients.forEach(ws => ws.terminate());
    this.extensionClients.clear();
    this.dashboardClients.clear();
  }
}
