import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { insertCommand, upsertHealthCheck } from './db.js';
import { getFullSystemContext } from './system-info.js';
import { VoiceHandler } from './voice-handler.js';

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
  }

  // ── Extension Client Handling ──

  _handleExtensionConnect(ws) {
    console.log('[WsHub] Extension client connected');
    this.extensionClients.add(ws);
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

        // ── Voice Audio → Transcribe → AI Pipeline ──
        if (msg.type === 'voice_audio' && msg.audio) {
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

          // Feed into AI pipeline (reuse chat_command logic)
          const commandId = uuidv4();
          console.log(`[Voice] Command: "${text}"`);

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
            timestamp: new Date().toISOString()
          });
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
    const raw = JSON.stringify(message);
    this.dashboardClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    });
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
}
