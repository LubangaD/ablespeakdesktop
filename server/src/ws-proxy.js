import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { insertCommand, upsertHealthCheck } from './db.js';
import { getFullSystemContext } from './system-info.js';
import { VoiceHandler } from './voice-handler.js';
import { matchFastCommand, isSilentTool, isBrowserTool } from './fast-commands.js';
import { isAffirmative } from './safety.js';

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
    this.extensionBrowserName = null; // Set by extension's browser_identify message
    this._lastTTSText = '';    // Last text spoken by TTS — for echo detection
    this._lastTTSTime = 0;     // When the last TTS was spoken
    this._voiceProcessing = false; // Mutex: prevents concurrent voice command processing
    this._sleeping = false; // Sleep mode: ignore commands until a wake phrase (Gap 5)
    this._dictationMode = false; // Dictation mode: type speech directly, no AI
    this._pendingConfirmation = null; // { tool, args, prompt } awaiting a spoken yes/no
    this._actionHistory = [];   // recent executed actions, for "undo that" / "no, I meant X"
    this._privacyMode = false;  // when true, no screenshots/vision are captured

    // Extension-facing WS server
    this.extensionWss = new WebSocketServer({ noServer: true });
    this.extensionWss.on('connection', (ws) => this._handleExtensionConnect(ws));

    // Dashboard-facing WS server
    this.dashboardWss = new WebSocketServer({ noServer: true });
    this.dashboardWss.on('connection', (ws) => this._handleDashboardConnect(ws));

    // Optional shared secret. When set (recommended on shared machines),
    // clients must connect with ?token=<value>. Origin-lock + loopback apply
    // regardless, so the control plane is never open to the network or to
    // arbitrary websites even without a token.
    this._wsToken = process.env.ABLESPEAK_WS_TOKEN || null;

    // Handle HTTP upgrade — AUTHENTICATE before accepting the socket.
    server.on('upgrade', (request, socket, head) => {
      const reject = (code, why) => {
        console.warn(`[WsHub] 🔒 Rejected WS upgrade (${why})`);
        try { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); } catch {}
        socket.destroy();
      };

      let url;
      try { url = new URL(request.url, `http://${request.headers.host}`); }
      catch { return reject('400 Bad Request', 'bad url'); }
      const pathname = url.pathname;

      if (pathname !== extensionPath && pathname !== dashboardPath) {
        return reject('404 Not Found', 'unknown path');
      }

      // 1. Loopback only — the control plane must never be reachable over the network.
      const ra = (request.socket.remoteAddress || '').replace('::ffff:', '');
      if (ra !== '127.0.0.1' && ra !== '::1') {
        return reject('403 Forbidden', `non-loopback ${ra}`);
      }

      // 2. Shared-secret token, if one is configured.
      if (this._wsToken && url.searchParams.get('token') !== this._wsToken) {
        return reject('401 Unauthorized', 'bad/missing token');
      }

      // 3. Origin-lock — block cross-site WebSocket hijacking. A malicious page
      //    in the student's browser can otherwise open ws://localhost and drive
      //    the computer. Allow only same-machine/Electron and extension origins.
      if (!this._isAllowedOrigin(request.headers.origin || '', pathname)) {
        return reject('403 Forbidden', `origin ${request.headers.origin || '(none)'}`);
      }

      const wss = pathname === extensionPath ? this.extensionWss : this.dashboardWss;
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
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

  /**
   * Origin allow-list for the WS control plane. Blocks cross-site WebSocket
   * hijacking while permitting the legitimate local clients.
   */
  _isAllowedOrigin(origin, pathname) {
    // Electron windows loading local content send no Origin (or 'null'/'file://').
    if (!origin || origin === 'null' || origin.startsWith('file://')) return true;
    // The AbleSpeak browser extension.
    if (/^(chrome-extension|moz-extension|extension):\/\//i.test(origin)) {
      if (process.env.ABLESPEAK_EXT_ID && pathname.endsWith('/extension')) {
        return origin === `chrome-extension://${process.env.ABLESPEAK_EXT_ID}`;
      }
      return true;
    }
    // Same-machine web origin (the locally-served dashboard).
    try {
      const h = new URL(origin).hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1';
    } catch {
      // Unparseable / unusual origin on an already loopback-locked socket.
      // Real cross-site attackers always send a valid http(s) Origin (caught
      // above), so allow this rather than risk rejecting a first-party local
      // client like the file:// overlay window.
      return true;
    }
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

      // Extension identifies which browser it's running in
      if (parsed.type === 'browser_identify') {
        this.extensionBrowserName = parsed.browserName || null;
        console.log(`[WsHub] Extension browser identified: ${this.extensionBrowserName}`);
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

          // A consequential action may be awaiting a typed yes/no.
          if (await this._resolvePendingConfirmation(msg.text)) return;

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

          // The AI tried a consequential action → it was gated. Ask first.
          if (this._pendingConfirmation) {
            this._askConfirmation(this._pendingConfirmation.prompt);
            return;
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
            });
          } catch (err) {
            console.error('[WsHub] DB insert error:', err.message);
          }

          // Send response to dashboard
          this._broadcastDashboard({
            type: 'chat_assistant_message',
            id: commandId,
            text: result.text,
            error: result.error || false,
            toolCalls: result.toolCalls,
            provider: result.provider,
            model: result.model,
            latency: result.latency,
            timestamp: new Date().toISOString()
          });
        }

        // ── Pre-transcribed Voice Text (from Web Speech API — instant, no Gemini roundtrip) ──
        if (msg.type === 'voice_text' && msg.text) {
          if (this._voiceProcessing && Date.now() - (this._voiceProcessingSince || 0) > 60000) {
            this._voiceProcessing = false;
          }
          if (this._voiceProcessing) {
            ws.send(JSON.stringify({ type: 'voice_busy', message: 'Still processing previous command', timestamp: new Date().toISOString() }));
            return;
          }
          this._voiceProcessing = true;
          this._voiceProcessingSince = Date.now();

          try {
            const startTime = Date.now();
            const text = msg.text.trim();
            if (!text) { return; }

            console.log(`[Voice] Direct text: "${text}"`);

            // Show transcription on dashboard
            this._broadcastDashboard({
              type: 'voice_transcription',
              text,
              latency: 0,
              timestamp: new Date().toISOString()
            });

            // VOICE CONTROL: interrupt (stop/cancel) + sleep/wake — never hits the LLM
            if (this._handleVoiceControl(text)) return;

            const commandId = uuidv4();

            // CONFIRMATION REPLY: if a consequential action is awaiting yes/no,
            // this utterance IS the answer — consume it here.
            if (await this._resolvePendingConfirmation(text, startTime)) return;

            // Reactive correction: "undo that" / "no, I meant ..."
            if (await this._handleCorrection(text, startTime)) return;

            // FAST PATH
            const fastMatch = matchFastCommand(text);
            if (fastMatch && fastMatch.tool !== 'dictation_mode') {
              console.log(`[Voice] ⚡ Fast match: ${fastMatch.tool}(${JSON.stringify(fastMatch.args)})`);
              const toolResult = await this.aiEngine.toolRegistry.executeTool(fastMatch.tool, fastMatch.args, this);
              const latency = Date.now() - startTime;

              // Consequential action → ask before doing anything else.
              if (toolResult?.status === 'needs_confirmation') {
                this._askConfirmation(toolResult.prompt, startTime);
                return;
              }

              if (isBrowserTool(fastMatch.tool)) this._autoFocusBrowser();
              this._recordAction({ tool: fastMatch.tool, args: fastMatch.args, result: toolResult });

              try {
                insertCommand({ id: commandId, type: 'voice_fast', direction: 'user_to_ai',
                  payload: JSON.stringify({ text, fastTool: fastMatch.tool }),
                  result: JSON.stringify(toolResult), latency_ms: latency });
              } catch (err) { console.error('[WsHub] DB insert error:', err.message); }

              // A failure must NEVER be silent — the student has to know it failed.
              const failed = toolResult?.status === 'error' || !!toolResult?.error;
              const responseText = failed
                ? `That didn't work: ${toolResult.error || toolResult.message || 'unknown error'}`
                : (fastMatch.silent ? '' : (toolResult?.message || `Done: ${fastMatch.tool}`));
              this._broadcastDashboard({
                type: 'chat_assistant_message', id: commandId, text: responseText,
                error: failed, toolCalls: [{ tool: fastMatch.tool, result: toolResult }],
                provider: 'fast', model: 'pattern-match', latency, source: 'voice',
                silent: failed ? false : fastMatch.silent, timestamp: new Date().toISOString()
              });
              console.log(`[Voice] ⚡ Fast executed in ${latency}ms${failed ? ' (FAILED)' : ''}`);
              return;
            }

            // FULL AI PATH
            // Request FRESH context from the extension before AI processing.
            // The extension's service worker may have been suspended, leaving
            // browserContext.pageContext stale or null. Without this, the AI
            // can't see page elements and asks the user for page info instead
            // of automatically fetching it.
            if (this.extensionClients.size > 0) {
              try {
                // Race: give the extension 2s to respond, then use stale context
                const freshCtx = await Promise.race([
                  this.sendToolToExtension('context_updater', {}),
                  new Promise(r => setTimeout(() => r(null), 2000)),
                ]);
                if (freshCtx && freshCtx.result) {
                  this.browserContext = freshCtx.result;
                } else if (freshCtx && freshCtx.pageContext) {
                  this.browserContext.pageContext = freshCtx.pageContext;
                }
              } catch (err) {
                console.warn('[WsHub] Failed to get fresh context:', err.message);
              }
            }

            const systemContext = getFullSystemContext();
            const context = {
              tabs: this.browserContext.tabs || [], activeTab: this.browserContext.activeTab || null,
              pageContext: this.browserContext.pageContext || null,
              extensionConnected: this.extensionClients.size > 0,
              currentTime: new Date().toLocaleString(),
              computerInfo: systemContext.computerInfo,
              visibleApplications: systemContext.visibleApplications,
            };

            const result = await this.aiEngine.processChat(text, context);

            // The AI tried a consequential action → it was gated. Ask first.
            if (this._pendingConfirmation) {
              this._askConfirmation(this._pendingConfirmation.prompt, startTime);
              return;
            }

            if (result.toolCalls && Array.isArray(result.toolCalls)) {
              if (result.toolCalls.some(tc => isBrowserTool(tc.tool || tc.name))) this._autoFocusBrowser();
            }

            let silent = false;
            if (result.toolCalls && Array.isArray(result.toolCalls)) {
              // Mark as silent if ALL tool calls are action-type tools (scroll, click, open, etc.)
              // regardless of whether the AI also returned text — action commands
              // shouldn't trigger TTS, they should just execute and restart the mic.
              const allSilent = result.toolCalls.every(tc => isSilentTool(tc.tool || tc.name));
              if (allSilent) silent = true;
            }

            try {
              insertCommand({ id: commandId, type: 'voice', direction: 'user_to_ai',
                payload: JSON.stringify({ text, source: 'speech_api' }),
                result: JSON.stringify(result), latency_ms: result.latency || 0 });
            } catch (err) { console.error('[WsHub] DB insert error:', err.message); }

            this._broadcastDashboard({
              type: 'chat_assistant_message', id: commandId, text: result.text,
              error: result.error || false, toolCalls: result.toolCalls,
              provider: result.provider, model: result.model, latency: result.latency,
              source: 'voice', silent, timestamp: new Date().toISOString()
            });

            // Store response text for echo detection
            if (result.text && !silent) {
              this._lastTTSText = result.text;
              this._lastTTSTime = Date.now();
            }
          } finally {
            this._voiceProcessing = false;
          }
        }

        // ── Voice Audio → Transcribe → Fast Route OR AI Pipeline ──
        if (msg.type === 'voice_audio' && msg.audio) {
          // Mutex: prevent concurrent voice commands (Fix #5)
          // Self-heal: if the mutex has been held > 60s something hung — force release
          if (this._voiceProcessing && Date.now() - (this._voiceProcessingSince || 0) > 60000) {
            console.warn('[WsHub] Voice mutex stuck >60s — force releasing');
            this._voiceProcessing = false;
          }
          if (this._voiceProcessing) {
            ws.send(JSON.stringify({
              type: 'voice_busy',
              message: 'Still processing previous command',
              timestamp: new Date().toISOString()
            }));
            return;
          }
          this._voiceProcessing = true;
          this._voiceProcessingSince = Date.now();


          try {
          const startTime = Date.now();
          console.log(`[Voice] Received audio (${Math.round(msg.audio.length / 1024)}KB)`);

          // Transcribe with Gemini
          const { text, error } = await this.voiceHandler.transcribe(msg.audio, msg.mimeType || 'audio/webm');

          if (error === 'no_speech') {
            ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
            return;
          }
          if (error) {
            ws.send(JSON.stringify({ type: 'voice_error', error, timestamp: new Date().toISOString() }));
            return;
          }

          // Send transcription to dashboard
          this._broadcastDashboard({
            type: 'voice_transcription',
            text,
            latency: Date.now() - startTime,
            timestamp: new Date().toISOString()
          });

          // ────────────────────────────────────────────
          // ESCAPE HATCH: Critical commands that bypass all filters
          // When music is playing, the mic picks up noise + the user's voice.
          // Uses browser media_control FIRST (directly pauses video, no mic interference).
          // Falls back to system media keys only if extension isn't connected.
          // ────────────────────────────────────────────
          if (!this._dictationMode) {
            const lowerForEscape = text.toLowerCase().trim();
            const wordCount = lowerForEscape.split(/\s+/).length;
            const escapeMatch = lowerForEscape.match(/\b(pause|stop|mute|shut up|quiet|silence|hush)\b/);

            if (escapeMatch && wordCount <= 6) {
              console.log(`[Voice] 🚨 Escape command: "${escapeMatch[1]}" in "${text.slice(0, 60)}"`);
              try {
                // Browser media_control — directly pauses the video without affecting the mic
                await this.aiEngine.toolRegistry.executeTool('media_control', { action: 'pause' }, this);
              } catch {
                // Fallback: system media key (may also pause the mic — last resort)
                try {
                  await this.aiEngine.toolRegistry.executeTool('system_media_control', { action: 'play_pause' }, this);
                } catch {}
              }
              ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
              return;
            }
          }

          // ────────────────────────────────────────────
          // NOISE + HALLUCINATION FILTER
          // Detect song lyrics, speaker bleed, and Gemini phantom transcriptions.
          // SKIPPED in dictation mode — long text and common phrases are expected.
          // ────────────────────────────────────────────
          if (!this._dictationMode) {
          const HALLUCINATIONS = [
            'the quick brown fox jumps over the lazy dog',
            'thank you for watching',
            'thanks for watching',
            'please subscribe',
            'like and subscribe',
            'subtitles by',
            'music playing',
          ];
          const lowerText = text.toLowerCase().trim();

          const isHallucination = HALLUCINATIONS.some(h => lowerText.includes(h));

          const isLikelyMusic = (() => {
            if (isHallucination) return true;
            // Very long transcriptions (>300 chars) are usually music, not commands
            if (text.length > 300) return true;
            // Detect repetitive patterns: same phrase repeated 3+ times
            const words = lowerText.split(/\s+/);
            if (words.length > 20) {
              const phrases = new Map();
              for (let i = 0; i < words.length - 2; i++) {
                const p = words.slice(i, i + 3).join(' ');
                phrases.set(p, (phrases.get(p) || 0) + 1);
              }
              for (const count of phrases.values()) {
                if (count >= 3) return true;
              }
            }
            return false;
          })();

          if (isLikelyMusic) {
            console.log(`[Voice] Filtered: ${isHallucination ? 'hallucination' : 'music/noise'} — "${text.slice(0, 60)}"`);
            ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
            return;
          }
          } // end !dictationMode

          // ────────────────────────────────────────────
          // ECHO DETECTION: Ignore mic picking up TTS speaker output
          // If the transcription closely matches the last spoken TTS text,
          // it's the mic hearing our own voice — discard it.
          // SKIPPED in dictation mode — no TTS is spoken during dictation.
          // ────────────────────────────────────────────
          if (!this._dictationMode && this._lastTTSText && (Date.now() - this._lastTTSTime) < 30000) {
            const lowerText = text.toLowerCase().trim();
            const ttsWords = this._lastTTSText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            const heardWords = lowerText.split(/\s+/).filter(w => w.length > 2);
            if (ttsWords.length > 0 && heardWords.length > 0) {
              const overlap = heardWords.filter(w => ttsWords.includes(w)).length;
              const ratio = overlap / Math.min(ttsWords.length, heardWords.length);
              if (ratio > 0.4) {
                console.log(`[Voice] 🔇 Echo detected (${Math.round(ratio*100)}% overlap with TTS) — "${text.slice(0, 60)}"`);
                ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
                return;
              }
            }
          }

          // VOICE CONTROL: interrupt (stop/cancel) + sleep/wake — never hits the LLM
          if (this._handleVoiceControl(text)) return;

          // ────────────────────────────────────────────
          // DICTATION MODE: type speech directly into the active app
          // No AI processing — just transcribe → type → restart mic
          // ────────────────────────────────────────────
          if (this._dictationMode) {
            const tLower = text.toLowerCase().trim().replace(/[.!?,]+$/, '');

            // Check for exit phrases first
            if (/^(stop|end|exit)\s+dictat(ing|ion)|^command\s+mode$/.test(tLower)) {
              this._dictationMode = false;
              try { const { clearDictationTarget } = await import('./system-tools.js'); clearDictationTarget(); } catch {}
              console.log('[Voice] ✏️ Dictation mode OFF');
              this._broadcastDashboard({
                type: 'dictation_mode', enabled: false,
                say: 'Dictation mode off. Back to commands.',
                timestamp: new Date().toISOString(),
              });
              return;
            }

            // Check for in-dictation navigation / formatting commands
            const navCmd = this._matchDictationCommand(tLower);
            if (navCmd) {
              console.log(`[Voice] ✏️ Dictation command: ${navCmd}`);
              try {
                const { executeDictationCommand } = await import('./system-tools.js');
                await executeDictationCommand(navCmd);
              } catch (err) {
                console.error('[Voice] Dictation command error:', err.message);
              }
              this._broadcastDashboard({
                type: 'dictation_typed', text: `[${navCmd.replace(/_/g, ' ')}]`,
                timestamp: new Date().toISOString(),
              });
              return;
            }

            // Convert punctuation words to actual punctuation
            let typedText = this._processDictationText(text);
            if (!typedText.trim()) return;

            console.log(`[Voice] ✏️ Dictating: "${typedText}"`);
            try {
              const { dictateText } = await import('./system-tools.js');
              await dictateText(typedText);
            } catch (err) {
              console.error('[Voice] Dictation type error:', err.message);
            }

            // Broadcast to overlay so it shows the typed text
            this._broadcastDashboard({
              type: 'dictation_typed', text: typedText,
              timestamp: new Date().toISOString(),
            });
            return;
          }

          const commandId = uuidv4();
          console.log(`[Voice] Command: "${text}"`);

          // ────────────────────────────────────────────
          // CONFIRMATION REPLY: if a consequential action is awaiting a spoken
          // yes/no, THIS utterance is the answer. Handle it before anything else.
          // ────────────────────────────────────────────
          if (await this._resolvePendingConfirmation(text, startTime)) return;

          // Reactive correction: "undo that" / "no, I meant ..." right after a mistake.
          if (await this._handleCorrection(text, startTime)) return;

          // ────────────────────────────────────────────
          // FAST PATH: Match common commands instantly
          // ────────────────────────────────────────────
          const fastMatch = matchFastCommand(text);

          if (fastMatch) {
            console.log(`[Voice] ⚡ Fast match: ${fastMatch.tool}(${JSON.stringify(fastMatch.args)})`);

            // Special handling: dictation mode toggle (not a real tool)
            if (fastMatch.tool === 'dictation_mode') {
              this._dictationMode = fastMatch.args.enabled;
              console.log(`[Voice] ✏️ Dictation mode ${this._dictationMode ? 'ON' : 'OFF'}`);

              // Capture/clear the target window HWND
              if (this._dictationMode) {
                try {
                  const { captureDictationTarget } = await import('./system-tools.js');
                  await captureDictationTarget();
                } catch (err) {
                  console.error('[Voice] Failed to capture dictation target:', err.message);
                }
              } else {
                try {
                  const { clearDictationTarget } = await import('./system-tools.js');
                  clearDictationTarget();
                } catch {}
              }

              this._broadcastDashboard({
                type: 'dictation_mode',
                enabled: this._dictationMode,
                say: this._dictationMode
                  ? 'Dictation mode on.'
                  : 'Dictation mode off. Back to commands.',
                timestamp: new Date().toISOString(),
              });

              // If user said "dictate My name is..." — type the initial text immediately
              if (this._dictationMode && fastMatch.args.initialText) {
                const typedText = this._processDictationText(fastMatch.args.initialText);
                if (typedText.trim()) {
                  console.log(`[Voice] ✏️ Initial dictation: "${typedText}"`);
                  try {
                    const { dictateText } = await import('./system-tools.js');
                    await dictateText(typedText);
                  } catch (err) {
                    console.error('[Voice] Dictation type error:', err.message);
                  }
                  this._broadcastDashboard({
                    type: 'dictation_typed', text: typedText,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
              return;
            }

            const toolResult = await this.aiEngine.toolRegistry.executeTool(fastMatch.tool, fastMatch.args, this);
            const latency = Date.now() - startTime;

            // Consequential action → pause and ask before doing anything else.
            if (toolResult?.status === 'needs_confirmation') {
              this._askConfirmation(toolResult.prompt, startTime);
              return;
            }

            // Auto-focus browser for browser commands
            if (isBrowserTool(fastMatch.tool)) {
              this._autoFocusBrowser();
            }
            this._recordAction({ tool: fastMatch.tool, args: fastMatch.args, result: toolResult });

            // Persist to DB
            try {
              insertCommand({
                id: commandId,
                type: 'voice_fast',
                direction: 'user_to_ai',
                payload: JSON.stringify({ text, fastTool: fastMatch.tool }),
                result: JSON.stringify(toolResult),
                latency_ms: latency,
              });
            } catch (err) {
              console.error('[WsHub] DB insert error:', err.message);
            }

            // A FAILURE IS NEVER SILENT — the student must hear that it failed,
            // otherwise they wait and retry blind. Only successes honour `silent`.
            const failed = toolResult?.status === 'error' || !!toolResult?.error;
            const responseText = failed
              ? `That didn't work: ${toolResult.error || toolResult.message || 'unknown error'}`
              : (fastMatch.silent ? '' : (toolResult?.message || `Done: ${fastMatch.tool}`));
            this._broadcastDashboard({
              type: 'chat_assistant_message',
              id: commandId,
              text: responseText,
              error: failed,
              toolCalls: [{ tool: fastMatch.tool, result: toolResult }],
              provider: 'fast',
              model: 'pattern-match',
              latency,
              source: 'voice',
              silent: failed ? false : fastMatch.silent,
              timestamp: new Date().toISOString()
            });

            console.log(`[Voice] ⚡ Fast executed in ${latency}ms (silent: ${failed ? false : fastMatch.silent}${failed ? ', FAILED' : ''})`);
            return;
          }

          // ────────────────────────────────────────────
          // FULL AI PATH: Complex commands go to LLM
          // ────────────────────────────────────────────
          const systemContext = getFullSystemContext();

          // Desktop screenshot from overlay, or fallback to extension tab screenshot.
          // Privacy mode disables ALL screen capture — voice control still works.
          let screenshot = this._privacyMode ? null : (msg.screenshot || null);
          if (!this._privacyMode && !screenshot && this.extensionClients.size > 0) {
            try {
              const ssResult = await this.sendToolToExtension('take_screenshot', {});
              if (ssResult && typeof ssResult === 'string' && ssResult.startsWith('data:')) {
                screenshot = ssResult.replace(/^data:image\/\w+;base64,/, '');
              }
            } catch {}
          }

          const context = {
            tabs: this.browserContext.tabs || [],
            activeTab: this.browserContext.activeTab || null,
            pageContext: this.browserContext.pageContext || null,
            extensionConnected: this.extensionClients.size > 0,
            currentTime: new Date().toLocaleString(),
            computerInfo: systemContext.computerInfo,
            visibleApplications: systemContext.visibleApplications,
            screenshot,
          };

          const result = await this.aiEngine.processChat(text, context);

          // The AI tried a consequential action → it was gated. Ask first.
          if (this._pendingConfirmation) {
            this._askConfirmation(this._pendingConfirmation.prompt, startTime);
            return;
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
          if (result.toolCalls && Array.isArray(result.toolCalls)) {
            const allSilent = result.toolCalls.every(tc => isSilentTool(tc.tool || tc.name));
            if (allSilent) silent = true;
          }

          try {
            insertCommand({
              id: commandId,
              type: 'voice',
              direction: 'user_to_ai',
              payload: JSON.stringify({ text, source: 'microphone' }),
              result: JSON.stringify(result),
              latency_ms: result.latency || 0,
            });
          } catch (err) {
            console.error('[WsHub] DB insert error:', err.message);
          }

          this._broadcastDashboard({
            type: 'chat_assistant_message',
            id: commandId,
            text: result.text,
            error: result.error || false,
            toolCalls: result.toolCalls,
            provider: result.provider,
            model: result.model,
            latency: result.latency,
            source: 'voice',
            silent,
            timestamp: new Date().toISOString()
          });

          // Store response text so the echo guard can reject the mic picking it up
          if (result.text && !silent) {
            this._lastTTSText = result.text;
            this._lastTTSTime = Date.now();
          }
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

  // ── Auto-focus browser window after browser commands ──
  async _autoFocusBrowser() {
    // Only focus the browser that has the extension active.
    // extensionBrowserName is set when the extension sends 'browser_identify' on connect.
    if (!this.extensionBrowserName) return; // No extension identified — don't guess

    try {
      const { focusApplication } = await import('./system-tools.js');
      console.log(`[WsHub] Focusing extension browser: ${this.extensionBrowserName}`);
      await focusApplication(this.extensionBrowserName);
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

      // Timeout — resolve so the chat doesn't hang, but as an EXPLICIT ERROR.
      // Never report success we can't verify: a student told "done" when the
      // extension actually went dark will retry blind or assume work happened.
      const timeout = setTimeout(() => {
        console.log(`[WsHub] ⏱ Timeout for ${type} (id=${callId})`);
        this.pendingToolCalls.delete(callId);
        resolve({
          status: 'error',
          error: `No response from the browser for "${type}". It may have disconnected — the action may not have happened.`,
          timedOut: true,
        });
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
    const raw = JSON.stringify(message);
    this.dashboardClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    });
  }

  /**
   * Handle voice "control" utterances that must NOT reach the fast-matcher or the
   * LLM: interrupt ("stop"/"cancel" — Gap 4) and sleep/wake (Gap 5).
   *
   * Returns true if the utterance was a control phrase (caller should stop and
   * release the voice mutex). Returns false for normal commands.
   */
  _handleVoiceControl(rawText) {
    const t = (rawText || '').trim().toLowerCase().replace(/[.!?,]+$/, '');
    if (!t) return false;

    // ── While asleep: only a wake phrase resumes; everything else is ignored. ──
    if (this._sleeping) {
      if (/^(wake up|wake|i'?m back|ablespeak|hey ablespeak|listen|start listening|resume)$/.test(t)) {
        this._sleeping = false;
        console.log('[Voice] 👋 Woke up');
        this._broadcastDashboard({
          type: 'voice_awake',
          say: "I'm listening.",
          timestamp: new Date().toISOString(),
        });
      } else {
        // Stay asleep, quietly — tell the overlay to keep listening, no error shown.
        console.log(`[Voice] 💤 Ignored while asleep: "${t.slice(0, 40)}"`);
        this._broadcastDashboard({ type: 'voice_no_speech', timestamp: new Date().toISOString() });
      }
      return true;
    }

    // ── Interrupt: cancel the current operation / stop talking. ──
    // Skipped while dictating: "stop" there means "stop dictation mode" (the
    // dictation block below owns that), and a bare "stop" must stay typeable
    // as dictated text rather than being swallowed as a global AI interrupt.
    if (!this._dictationMode && /^(stop|cancel|abort|shut up|be quiet|quiet|nevermind|never mind)[\s.,!]?/i.test(t)) {
      console.log('[Voice] ⚡ INTERRUPT — cancelling current operation');
      try { if (this.aiEngine && this.aiEngine.abortActive) this.aiEngine.abortActive(); } catch {}
      this._voiceProcessing = false; // release mutex immediately
      this._broadcastDashboard({ type: 'voice_cancelled', timestamp: new Date().toISOString() });
      return true;
    }

    // ── Sleep: stop acting on commands until woken. ──
    if (/^(go to sleep|sleep|stop listening|hush|pause listening)$/.test(t)) {
      this._sleeping = true;
      console.log('[Voice] 💤 Going to sleep — say "wake up" to resume');
      this._broadcastDashboard({
        type: 'voice_sleeping',
        say: 'Going to sleep. Say wake up when you need me.',
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    // ── Privacy mode: stop capturing the screen, KEEP voice control. ──
    // In a shared/classroom lab, the screen (possibly others' work) should not
    // be streamed to a cloud model on every turn. This pauses vision only.
    if (/^(privacy mode|private mode|stop watching|stop looking|vision off|turn off vision|do ?n'?t look|stop seeing|eyes off)$/.test(t)) {
      this._privacyMode = true;
      console.log('[Voice] 🛡️ Privacy mode ON — screen capture disabled');
      this._broadcastDashboard({
        type: 'privacy_mode', enabled: true,
        say: 'Privacy mode on. I have stopped looking at your screen, but I am still listening.',
        timestamp: new Date().toISOString(),
      });
      return true;
    }
    if (/^(vision on|turn on vision|you can look|start watching|privacy off|exit privacy mode|resume vision|eyes on)$/.test(t)) {
      this._privacyMode = false;
      console.log('[Voice] 🛡️ Privacy mode OFF — screen capture re-enabled');
      this._broadcastDashboard({
        type: 'privacy_mode', enabled: false,
        say: 'Privacy mode off. I can see the screen again.',
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    return false;
  }

  /**
   * If a consequential action is awaiting confirmation, interpret THIS utterance
   * as the yes/no reply. Returns true if it consumed the utterance.
   */
  async _resolvePendingConfirmation(text, startTime = Date.now()) {
    if (!this._pendingConfirmation) return false;
    const pending = this._pendingConfirmation;
    this._pendingConfirmation = null;
    const commandId = uuidv4();

    if (isAffirmative(text)) {
      console.log(`[Voice] ✅ Confirmed: ${pending.tool}`);
      const toolResult = await this.aiEngine.toolRegistry.executeTool(
        pending.tool, pending.args, this, { confirmed: true }
      );
      this._recordAction({ tool: pending.tool, args: pending.args, result: toolResult });
      if (isBrowserTool(pending.tool)) this._autoFocusBrowser();
      const failed = toolResult?.status === 'error' || toolResult?.error;
      this._broadcastDashboard({
        type: 'chat_assistant_message', id: commandId,
        text: failed
          ? `That didn't work: ${toolResult.error || toolResult.message || 'unknown error'}`
          : (toolResult?.message || 'Done.'),
        error: !!failed, toolCalls: [{ tool: pending.tool, result: toolResult }],
        provider: 'fast', model: 'confirmation', source: 'voice',
        silent: false, latency: Date.now() - startTime, timestamp: new Date().toISOString(),
      });
    } else {
      console.log(`[Voice] ✋ Cancelled: ${pending.tool}`);
      this._broadcastDashboard({
        type: 'chat_assistant_message', id: commandId,
        text: 'Okay, cancelled.', error: false, toolCalls: [],
        provider: 'fast', model: 'confirmation', source: 'voice',
        silent: false, latency: Date.now() - startTime, timestamp: new Date().toISOString(),
      });
    }
    return true;
  }

  /** Broadcast a spoken confirmation prompt for a pending consequential action. */
  _askConfirmation(prompt, startTime = Date.now()) {
    this._broadcastDashboard({
      type: 'chat_assistant_message', id: uuidv4(),
      text: prompt, error: false, toolCalls: [],
      provider: 'fast', model: 'confirmation-prompt', source: 'voice',
      silent: false, latency: Date.now() - startTime, timestamp: new Date().toISOString(),
    });
  }

  /** Keep a short rolling history of executed actions for reactive correction. */
  _recordAction(entry) {
    this._actionHistory.push({ ...entry, at: Date.now() });
    if (this._actionHistory.length > 10) this._actionHistory.shift();
  }

  /**
   * Reactive correction — the moment AFTER a mistake, which is exactly when a
   * student discovers it. Handles "undo that", "no that's wrong", and
   * "no, I meant <X>" (undo, then run the corrected command). Returns true if
   * it consumed the utterance.
   */
  async _handleCorrection(rawText, startTime = Date.now()) {
    const t = (rawText || '').trim().toLowerCase().replace(/[.!?,]+$/, '');
    if (!t) return false;

    // "(no,) I meant X" / "actually I meant X" / "I wanted X" / "I said X"
    const meant = t.match(/^(?:no,?\s*)?(?:i meant|i said|i wanted|actually,?(?:\s*i meant)?|not that,?\s*i meant)\s+(.+)$/);
    if (meant && meant[1].trim().length > 1) {
      const correction = meant[1].trim();
      console.log(`[Voice] ↩️ Correction → "${correction}"`);
      await this._undoLast();              // revert the mistaken action
      await this._executeCorrectedCommand(correction, startTime); // then do the right thing
      return true;
    }

    // Pure undo / "that was wrong".
    const undoRe = /^(undo( that| it| last| the last)?|take that back|revert( that)?|that('?s| is| was)? (wrong|not right|not it)|wrong one|not that one?|nope that('?s| is) wrong)$/;
    if (undoRe.test(t)) {
      console.log('[Voice] ↩️ Undo last action');
      const ok = await this._undoLast();
      this._broadcastDashboard({
        type: 'chat_assistant_message', id: uuidv4(),
        text: ok ? 'Okay, I undid that.' : 'I tried to undo, but there may be nothing to undo.',
        error: false, toolCalls: [], provider: 'fast', model: 'correction',
        source: 'voice', silent: false, latency: Date.now() - startTime, timestamp: new Date().toISOString(),
      });
      return true;
    }
    return false;
  }

  /** Undo the most recent action: go_back for navigation, Ctrl+Z otherwise. */
  async _undoLast() {
    const last = this._actionHistory[this._actionHistory.length - 1];
    try {
      if (last && /(^|_)(tab|navigate|link|open_url|create_tab|go_forward)(_|$)/.test(last.tool)) {
        await this.aiEngine.toolRegistry.executeTool('go_back', {}, this, { confirmed: true });
        this._autoFocusBrowser();
      } else {
        await this.aiEngine.toolRegistry.executeTool('send_system_keys', { keys: 'Ctrl+Z' }, this, { confirmed: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Run a corrected command through fast-match then AI, with spoken feedback. */
  async _executeCorrectedCommand(text, startTime = Date.now()) {
    const fast = matchFastCommand(text);
    if (fast && fast.tool !== 'dictation_mode') {
      const r = await this.aiEngine.toolRegistry.executeTool(fast.tool, fast.args, this);
      if (r?.status === 'needs_confirmation') { this._askConfirmation(r.prompt, startTime); return; }
      if (isBrowserTool(fast.tool)) this._autoFocusBrowser();
      this._recordAction({ tool: fast.tool, args: fast.args, result: r });
      const failed = r?.status === 'error' || !!r?.error;
      this._broadcastDashboard({
        type: 'chat_assistant_message', id: uuidv4(),
        text: failed ? `That didn't work: ${r.error || r.message || 'unknown error'}`
                     : (fast.silent ? 'Okay, did that instead.' : (r?.message || 'Done.')),
        error: failed, toolCalls: [{ tool: fast.tool, result: r }], provider: 'fast',
        model: 'correction', source: 'voice', silent: false,
        latency: Date.now() - startTime, timestamp: new Date().toISOString(),
      });
      return;
    }
    const sys = getFullSystemContext();
    const ctx = {
      tabs: this.browserContext.tabs || [], activeTab: this.browserContext.activeTab || null,
      pageContext: this.browserContext.pageContext || null, extensionConnected: this.extensionClients.size > 0,
      currentTime: new Date().toLocaleString(), computerInfo: sys.computerInfo, visibleApplications: sys.visibleApplications,
    };
    const result = await this.aiEngine.processChat(text, ctx);
    if (this._pendingConfirmation) { this._askConfirmation(this._pendingConfirmation.prompt, startTime); return; }
    this._broadcastDashboard({
      type: 'chat_assistant_message', id: uuidv4(), text: result.text, error: result.error || false,
      toolCalls: result.toolCalls, provider: result.provider, model: result.model, latency: result.latency,
      source: 'voice', silent: false, timestamp: new Date().toISOString(),
    });
  }

  /**
   * Match in-dictation navigation / formatting / editing commands.
   * Returns a command key for executeDictationCommand(), or null if not a command.
   */
  _matchDictationCommand(t) {
    // Paragraph navigation
    if (/^(next paragraph|move (to )?next paragraph|go to next paragraph|paragraph (down|forward))$/.test(t)) return 'next_paragraph';
    if (/^(previous paragraph|last paragraph|move (to )?(previous|last|prior) paragraph|go back (a )?paragraph|paragraph (up|back))$/.test(t)) return 'prev_paragraph';
    // Line navigation
    if (/^(next line|move down( one line)?|line down)$/.test(t)) return 'next_line';
    if (/^(previous line|last line|move up( one line)?|line up)$/.test(t)) return 'prev_line';
    if (/^(end of (the )?line|go to end of (the )?line|line end)$/.test(t)) return 'line_end';
    if (/^(beginning of (the )?line|start of (the )?line|line start)$/.test(t)) return 'line_start';
    // Document navigation
    if (/^(end of (the )?document|go to (the )?end|document end|bottom of (the )?document)$/.test(t)) return 'doc_end';
    if (/^(beginning of (the )?document|start of (the )?document|top of (the )?document|go to (the )?top)$/.test(t)) return 'doc_start';
    // Undo / redo
    if (/^(undo|undo that|undo last|take that back)$/.test(t)) return 'undo';
    if (/^(redo|redo that|redo last)$/.test(t)) return 'redo';
    // Delete
    if (/^(delete (last )?word|erase (last )?word|remove (last )?word)$/.test(t)) return 'delete_word';
    if (/^(delete (that|last) character|backspace)$/.test(t)) return 'delete_char';
    // Formatting
    if (/^(bold|bold that|make (it )?bold|toggle bold)$/.test(t)) return 'bold';
    if (/^(italic|italics|italicize|make (it )?italic|toggle italic)$/.test(t)) return 'italic';
    if (/^(underline|underline that|make (it )?underline|toggle underline)$/.test(t)) return 'underline';
    // Selection
    if (/^(select all|select everything)$/.test(t)) return 'select_all';
    // Scrolling
    if (/^(page down|scroll down)$/.test(t)) return 'page_down';
    if (/^(page up|scroll up)$/.test(t)) return 'page_up';
    return null;
  }

  /**
   * Process dictation text: convert spoken punctuation to actual characters.
   * "My name is Derek period I live in Nairobi comma Kenya period"
   * → "My name is Derek. I live in Nairobi, Kenya."
   */
  _processDictationText(rawText) {
    let text = rawText.trim();
    // Remove leading punctuation artifacts from Gemini transcription
    text = text.replace(/^[.,!?;:]+\s*/, '');

    // Map spoken punctuation → characters
    const punctuationMap = [
      [/\b(full stop|period|dot)\b/gi, '.'],
      [/\b(comma)\b/gi, ','],
      [/\b(question mark)\b/gi, '?'],
      [/\b(exclamation mark|exclamation point|exclamation)\b/gi, '!'],
      [/\b(colon)\b/gi, ':'],
      [/\b(semicolon|semi colon)\b/gi, ';'],
      [/\b(open quote|open quotes|opening quote)\b/gi, '"'],
      [/\b(close quote|close quotes|closing quote|end quote)\b/gi, '"'],
      [/\b(open parenthesis|open paren|left paren)\b/gi, '('],
      [/\b(close parenthesis|close paren|right paren)\b/gi, ')'],
      [/\b(hyphen|dash)\b/gi, '-'],
      [/\b(at sign|at symbol)\b/gi, '@'],
    ];

    for (const [pattern, replacement] of punctuationMap) {
      text = text.replace(pattern, replacement);
    }

    // Handle "new line" and "new paragraph" — convert to Enter keypresses
    text = text.replace(/\b(new line|newline)\b/gi, '\n');
    text = text.replace(/\b(new paragraph)\b/gi, '\n\n');

    // Clean up extra spaces around punctuation
    text = text.replace(/\s+([.,!?;:])/g, '$1');
    text = text.replace(/([.,!?;:])(?=[A-Za-z])/g, '$1 ');

    // Add a trailing space so the next dictation segment starts after a space
    if (text && !text.endsWith('\n') && !text.endsWith(' ')) {
      text += ' ';
    }

    return text;
  }

  // ── Public API ──

  /**
   * Public broadcast to all dashboard clients (used by tool-registry voice commands)
   */
  broadcastToDashboard(message) {
    this._broadcastDashboard(message);
  }

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

  // ── Cleanup ──
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
