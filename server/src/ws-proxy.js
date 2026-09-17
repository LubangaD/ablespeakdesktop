import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { insertCommand, updateCommandOutcome, upsertHealthCheck, logVoiceTurn } from './db.js';
import { getFullSystemContext } from './system-info.js';
import { VoiceHandler } from './voice-handler.js';
import { matchFastCommand, isSilentTool, isBrowserTool } from './fast-commands.js';
import { isAffirmative, isNegative } from './safety.js';
import { normaliseProfile, listeningSettings, expandAlias, findMacro } from './student-profile.js';
import { toolFailed, aiCommandFailed } from './tool-outcome.js';
import { TaskAgent, needsPlan } from './agent.js';

// Phrases that resume normal operation from sleep OR bring the overlay back
// from a voice "dismiss" (HFI-1) — shared so the two recovery paths never drift.
const WAKE_PHRASES_RE = /^(wake up|wake|i'?m back|ablespeak|hey ablespeak|listen|start listening|resume|come back|show yourself)$/;

// About a minute of continuous dictation. Past this, clips are refused rather
// than typed long after they were spoken.
const MAX_QUEUED_DICTATION_CLIPS = 8;

// In dictation, "AbleSpeak, open Chrome" is a command rather than text. The
// word after the name must be a command verb, so "AbleSpeak is great" is typed.
const DICTATION_COMMAND_RE = /^\s*(?:hey\s+)?able\s*-?\s*speak\b[\s,.:;!-]*((?:open|close|go|switch|click|press|scroll|search|play|pause|show|find|select|save|send|reload|refresh|zoom|mute|unmute|start|stop|take|read|summari[sz]e|tell|set|turn|navigate|focus|minimi[sz]e|maximi[sz]e|copy|paste|print|undo|redo)\b[\s\S]*)$/i;

const STOP_RE = /^(stop|cancel|abort|shut up|be quiet|quiet|nevermind|never mind)[\s.,!]?/i;

// How long a bare "type this" waits for the words.
const AWAIT_TYPE_TEXT_MS = 2 * 60 * 1000;

const LEAD_IN = String.raw`(?:(?:please|can you|could you|now|and)\s+)*`;
const TYPE_ASK_RE = new RegExp(String.raw`^${LEAD_IN}(?:type|write)(?:\s+(?:this|that|the following|this out|something|some text))?(?:\s+(?:for me|please))?\s*[:.!?]?$`, 'i');
const TYPE_TEXT_RE = new RegExp(String.raw`^${LEAD_IN}(?:type|write)(?:\s+(?:this|the following|out))?\s*(?::|\r?\n)\s*([\s\S]*\S)$`, 'i');

/**
 * "Type this: <words>" → { text }; a bare "type this" → { ask: true };
 * anything else (including "type hello in Notepad") → null.
 */
export function parseTypeRequest(said) {
  const text = String(said || '').trim();
  if (TYPE_ASK_RE.test(text)) return { ask: true };
  const match = text.match(TYPE_TEXT_RE);
  return match ? { text: match[1] } : null;
}

/** The command in "AbleSpeak, <command>", or null for ordinary dictated text. */
export function matchDictationPrefixCommand(text) {
  const match = String(text || '').match(DICTATION_COMMAND_RE);
  return match ? match[1].trim() : null;
}

// ── Command outcomes for the progress engine ──

// A command said this soon after a failed one, and sounding like it, is the
// student trying the same thing again.
const RETRY_WINDOW_MS = 60000;
// "Undo that" / "no, I meant …" only reach back this far, and never into
// another student's session.
const CORRECTION_WINDOW_MS = 5 * 60000;

export { toolFailed, aiCommandFailed };

function editSimilarity(a, b) {
  if (!a.length && !b.length) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/**
 * Does `text` look like another go at `previousText`? True for a mishearing
 * fixed ("scroll town" → "scroll down") or a rewording that keeps most words
 * ("open chrome" → "open google chrome"); false for a new command
 * ("open chrome" → "open word").
 */
export function isLikelyRetry(previousText, text) {
  const clean = value => String(value || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const a = clean(previousText);
  const b = clean(text);
  if (!a || !b) return false;
  if (editSimilarity(a, b) >= 0.6) return true;
  const before = new Set(a.split(' '));
  const after = new Set(b.split(' '));
  const shared = [...after].filter(word => before.has(word)).length;
  return shared / Math.min(before.size, after.size) > 0.5;
}

/**
 * AbleSpeak WebSocket Hub
 * 
 * STANDALONE mode — no Voqal dependency.
 * - Manages Chrome extension connections (receives context, sends tool commands)
 * - Manages dashboard connections (chat, status, context broadcast)
 * - Routes chat commands to AIEngine for processing
 */

export class WsProxy {
  constructor({ server, aiEngine, dashboardPath = '/ws/dashboard', extensionPath = '/ws/extension', wsToken, attribution, activeStudent, profile, readScreen, readScreenModel, onCorrection }) {
    this.aiEngine = aiEngine;
    this.voiceHandler = new VoiceHandler();
    this.extensionClients = new Set();
    this.dashboardClients = new Set();
    this.pendingToolCalls = new Map(); // id → { resolve, reject, timeout }
    this.activePrompt = 'ablespeak';
    this.lastContextUpdate = null;
    this.browserContext = { tabs: [], activeTab: null };
    this.extensionBrowserName = null; // Set by extension's browser_identify message
    // Who each voice command belongs to (TCH-1, AT-50). index.js passes the
    // student the teacher picked and that student's current session; without
    // it (tests), commands carry this run's own session and no student.
    this._sessionId = `session-${uuidv4()}`;
    this._attribution = attribution || (() => ({ session_id: this._sessionId, student_id: null }));
    this._activeStudent = activeStudent || (() => null);
    // The active student's speech profile: vocabulary, shortcuts, listening
    // settings (student-profile.js). Defaults when nobody is chosen.
    this._profile = profile || (() => normaliseProfile({}).profile);
    // Reads the controls of the window the student is using (screen-model.js).
    this._readScreen = readScreen || (async () => null);
    // Full read of the front window, for the task agent's checks.
    this._readScreenModel = readScreenModel || (async () => null);
    // "No, I meant X" after "Y": may teach a shortcut (Stage 4). Returns { learned }.
    this._onCorrection = onCorrection || (() => null);
    this._agentRunning = false;    // a multi-step task is in progress
    this._agentCancelled = false;  // the student said "stop" during it
    this._lastTTSText = '';    // Last text spoken by TTS — for echo detection
    this._lastTTSTime = 0;     // When the last TTS was spoken
    this._voiceProcessing = false; // Mutex: prevents concurrent voice command processing
    this._voiceTurn = null;        // Token for the clip holding the mutex
    this._voiceTurnWaiters = [];   // Dictation clips waiting for the mutex, oldest first
    this._voiceHandoff = false;    // the mutex is reserved for a woken waiter
    this._sleeping = false; // Sleep mode: ignore commands until a wake phrase (Gap 5)
    this._dismissed = false; // Overlay voice-hidden: ignore commands until a wake phrase (HFI-1)
    this._dictationMode = false; // Dictation mode: type speech directly, no AI
    this._awaitingTypeText = null; // when "type this" asked for the words
    this._pendingConfirmation = null; // { tool, args, prompt } awaiting a spoken yes/no
    this._actionHistory = [];   // recent executed actions, for "undo that" / "no, I meant X"
    this._privacyMode = false;  // when true, no screenshots/vision are captured

    // Extension-facing WS server
    this.extensionWss = new WebSocketServer({ noServer: true });
    this.extensionWss.on('connection', (ws) => this._handleExtensionConnect(ws));

    // Dashboard-facing WS server
    this.dashboardWss = new WebSocketServer({ noServer: true });
    this.dashboardWss.on('connection', (ws) => this._handleDashboardConnect(ws));

    // Shared secret clients must connect with (?token=<value>). Origin-lock +
    // loopback apply regardless, so the control plane is never open to the
    // network or to arbitrary websites even without a token — but without one,
    // ANY other local process could open this WS and drive the extension/system
    // tools with zero authentication. index.js resolves (or auto-generates and
    // persists) a token by default now, so this is only ever null if a caller
    // explicitly opts out (EXT-2).
    this._wsToken = wsToken !== undefined ? wsToken : (process.env.ABLESPEAK_WS_TOKEN || null);

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
      sessionId: this._attribution().session_id,
      activeStudent: this._activeStudent(),
      listening: listeningSettings(this._profile()),
      timestamp: new Date().toISOString()
    }));

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // ── Overlay became visible again (wake phrase, shortcut, or tray) ──
        // Clear the dismissed gate so a stale flag doesn't keep swallowing
        // commands after the overlay is back on screen by some other path (HFI-1).
        if (msg.type === 'overlay_shown') {
          this._dismissed = false;
          return;
        }

        // ── Chat Command: handled exactly like speech ──
        if (msg.type === 'chat_command' && msg.text) {
          await this._onChatCommand(ws, msg);
        }

        // ── Pre-transcribed Voice Text (from Web Speech API — instant, no Gemini roundtrip) ──
        if (msg.type === 'voice_text' && msg.text) {
          if (this._voiceProcessing && Date.now() - (this._voiceProcessingSince || 0) > 60000) {
            this._endVoiceTurn(this._voiceTurn);
          }
          if (this._voiceBusy()) {
            ws.send(JSON.stringify({ type: 'voice_busy', message: 'Still processing previous command', timestamp: new Date().toISOString() }));
            return;
          }
          const turn = this._beginVoiceTurn();
          this._turnSource = msg.source === 'overlay' ? 'overlay' : 'dashboard';

          try {
            const startTime = Date.now();
            let text = msg.text.trim();
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

            text = this._applyAlias(text);
            if (await this._runRoutine(text, commandId, startTime)) return;

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

              this._recordVoiceCommand({ id: commandId, type: 'voice_fast', text,
                payload: { text, fastTool: fastMatch.tool }, result: toolResult,
                latency_ms: latency, failed: toolFailed(toolResult) });

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
              screenModel: await this._screenForAgent(),
            };

            if (needsPlan(text)) {
              await this._runTask(text, context, { commandId, startTime });
              return;
            }
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

            this._recordVoiceCommand({ id: commandId, type: 'voice', text,
              payload: { text, source: 'speech_api' }, result,
              latency_ms: result.latency || 0, failed: aiCommandFailed(result) });

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
            this._endVoiceTurn(turn);
          }
        }

        // ── Voice Audio → Transcribe → Fast Route OR AI Pipeline ──
        if (msg.type === 'voice_audio' && msg.audio) {
          await this._onVoiceAudio(ws, msg);
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

  /**
   * A command typed on the Chat page. It takes the same route as speech, so
   * everything can be tried without a microphone, and acts on the app that
   * was in use before the dashboard. An adult is typing, so it never counts
   * toward the student's progress.
   */
  async _onChatCommand(ws, msg) {
    const text = String(msg.text || '').trim();
    if (!text) return;
    console.log(`[Chat] Command: "${text.length > 200 ? `${text.slice(0, 200)}…` : text}"`);

    if (this._voiceProcessing && Date.now() - (this._voiceProcessingSince || 0) > 60000) {
      this._endVoiceTurn(this._voiceTurn);
    }
    if (this._agentRunning) {
      if (STOP_RE.test(text)) {
        this._stopTask();
        return;
      }
      this._reply('Still working on the task. Type "stop" to cancel it.', { silent: true });
      return;
    }
    if (this._voiceBusy()) await this._waitForVoiceTurn();

    const turn = this._beginVoiceTurn();
    this._turnSource = 'dashboard';
    try {
      await this._handleUtterance(ws, text, { typed: true });
    } catch (err) {
      console.error('[Chat] Command error:', err.message);
      this._reply(`That didn't work: ${err.message}`, { error: true });
    } finally {
      this._endVoiceTurn(turn);
    }
  }

  /** Wait to be handed the voice turn. Waiters keep the order they came in. */
  async _waitForVoiceTurn() {
    // A waiter that is woken but finds the turn taken goes back to the front.
    let woken = false;
    do {
      await new Promise(resolve => (woken ? this._voiceTurnWaiters.unshift(resolve) : this._voiceTurnWaiters.push(resolve)));
      woken = true;
    } while (this._voiceProcessing);
  }

  /** A message that isn't a command's result: shown, and spoken unless silent. */
  _reply(text, { error = false, silent = false, model = 'note' } = {}) {
    this._broadcastDashboard({
      type: 'chat_assistant_message', id: uuidv4(), text, error, toolCalls: [],
      provider: 'fast', model, source: 'voice', silent, timestamp: new Date().toISOString(),
    });
  }

  /**
   * "Type this: …" types the words exactly as given. A bare "type this" asks
   * for them, and the next message is typed.
   */
  async _handleTypeRequest(text, { commandId, startTime, typed }) {
    let words = null;
    if (this._awaitingTypeText && Date.now() - this._awaitingTypeText < AWAIT_TYPE_TEXT_MS) {
      words = typed ? text : this._processDictationText(text);
    }
    this._awaitingTypeText = null;

    if (words === null) {
      const request = parseTypeRequest(text);
      if (!request) return false;
      if (request.ask) {
        this._awaitingTypeText = Date.now();
        this._reply(typed ? 'What should I type? Send the words next.' : 'What should I type? Say the words next.', { model: 'type-request' });
        return true;
      }
      words = request.text;
    }
    if (!words.trim()) return true;

    const tool = 'system_type_text';
    const args = { text: words };
    const toolResult = await this.aiEngine.toolRegistry.executeTool(tool, args, this);
    if (toolResult?.status === 'needs_confirmation') {
      this._askConfirmation(toolResult.prompt, startTime);
      return true;
    }
    this._recordAction({ tool, args, result: toolResult });
    const failed = toolFailed(toolResult);
    this._recordVoiceCommand({
      id: commandId, type: 'voice_fast', text,
      payload: { text, fastTool: tool, source: typed ? 'chat' : 'microphone' },
      result: toolResult, latency_ms: Date.now() - startTime, failed,
    });
    const count = words.trim().split(/\s+/).length;
    const where = toolResult?.window ? ` into ${toolResult.window}` : '';
    this._broadcastDashboard({
      type: 'chat_assistant_message', id: commandId,
      text: failed
        ? `That didn't work: ${toolResult?.error || toolResult?.message || 'unknown error'}`
        : `Typed ${count} word${count === 1 ? '' : 's'}${where}.`,
      error: failed, toolCalls: [{ tool, result: toolResult }],
      provider: 'fast', model: 'pattern-match', latency: Date.now() - startTime,
      source: 'voice', silent: !failed, timestamp: new Date().toISOString(),
    });
    return true;
  }

  /** Stop the running task (voice "stop", or "stop" typed on the Chat page). */
  _stopTask() {
    console.log('[Voice] ⚡ Stopping the running task');
    this._agentCancelled = true;
    try { this.aiEngine?.abortActive?.(); } catch {}
  }

  /**
   * Handle one recorded clip from the overlay.
   *
   * Outside dictation, a clip that arrives while another is being handled is
   * turned away with `voice_busy`, since a command said over a running
   * command is usually a repeat. In dictation the student keeps talking while
   * earlier speech is typed, so those clips wait their turn and are typed in
   * the order they were spoken.
   */
  async _onVoiceAudio(ws, msg) {
    // Self-heal: if the mutex has been held > 60s something hung — force release
    if (this._voiceProcessing && Date.now() - (this._voiceProcessingSince || 0) > 60000) {
      console.warn('[WsHub] Voice mutex stuck >60s — force releasing');
      this._endVoiceTurn(this._voiceTurn);
    }
    if (this._voiceProcessing && this._agentRunning && !this._dictationMode) {
      await this._interruptTask(ws, msg);
      return;
    }
    if (this._voiceBusy()) {
      const canWait = this._dictationMode && this._voiceTurnWaiters.length < MAX_QUEUED_DICTATION_CLIPS;
      if (!canWait) {
        ws.send(JSON.stringify({
          type: 'voice_busy',
          message: 'Still processing previous command',
          timestamp: new Date().toISOString()
        }));
        return;
      }
      console.log(`[Voice] Dictation clip queued (${this._voiceTurnWaiters.length + 1} waiting)`);
      // Phrases are typed in the order they were spoken.
      await this._waitForVoiceTurn();
    }

    const turn = this._beginVoiceTurn();
    // Only the overlay is the student speaking; the dashboard's Chat page
    // microphone is an adult trying things, and never counts toward progress.
    this._turnSource = msg.source === 'overlay' ? 'overlay' : 'dashboard';
    turn.log = {
      outcome: 'command', transcript: null, commandId: null,
      started: Date.now(), audioKb: Math.round((msg.audio.length * 3) / 4 / 1024),
    };
    this._turnLog = turn.log;
    try {
      await this._processVoiceAudio(ws, msg);
    } finally {
      this._logTurn(turn.log);
      if (this._turnLog === turn.log) this._turnLog = null;
      this._endVoiceTurn(turn);
    }
  }

  /** Who a voice command belongs to: the student only when they spoke. */
  _voiceAttribution() {
    const ids = this._attribution();
    return this._turnSource === 'dashboard' ? { ...ids, student_id: null } : ids;
  }

  /** How this clip ended, for the recognition readout. */
  _markTurn(outcome) {
    if (this._turnLog) this._turnLog.outcome = outcome;
  }

  _logTurn(turn) {
    if (!turn) return;
    try {
      logVoiceTurn({
        ...this._voiceAttribution(),
        outcome: turn.outcome,
        transcript: turn.transcript,
        command_id: turn.commandId,
        audio_kb: turn.audioKb,
        ms: Date.now() - turn.started,
      });
    } catch {
      // No database (tests); the command itself is unaffected.
    }
  }

  // ── Multi-step tasks (Stage 3) ──

  /** While a task runs, a clip can only stop it. */
  async _interruptTask(ws, msg) {
    const { text } = await this.voiceHandler.transcribe(msg.audio, msg.mimeType || 'audio/webm');
    if (text && STOP_RE.test(text.trim())) {
      this._stopTask();
      this._broadcastDashboard({ type: 'voice_transcription', text, latency: 0, timestamp: new Date().toISOString() });
      return;
    }
    ws.send(JSON.stringify({
      type: 'voice_busy',
      task: true,
      message: 'Still working on the task. Say "stop" to cancel it.',
      timestamp: new Date().toISOString(),
    }));
  }

  _aiContext() {
    const systemContext = getFullSystemContext();
    return {
      tabs: this.browserContext.tabs || [],
      activeTab: this.browserContext.activeTab || null,
      pageContext: this.browserContext.pageContext || null,
      extensionConnected: this.extensionClients.size > 0,
      currentTime: new Date().toLocaleString(),
      computerInfo: systemContext.computerInfo,
      visibleApplications: systemContext.visibleApplications,
    };
  }

  /** A tool call made by the agent: through the safety gate, like any other. */
  async _runAgentTool(name, args, opts = {}) {
    const result = await this.aiEngine.toolRegistry.executeTool(name, args, this, opts);
    if (result?.status !== 'needs_confirmation' && !this._evaluating) {
      this._recordAction({ tool: name, args, result });
      if (isBrowserTool(name)) this._autoFocusBrowser();
    }
    return result;
  }

  _taskAgent() {
    const engine = this.aiEngine;
    return new TaskAgent({
      llm: request => engine.complete(request),
      systemPrompt: context => engine._buildSystemPrompt(context),
      toolsFor: context => engine.toolRegistry.getToolsForContext(context),
      execute: (name, args) => this._runAgentTool(name, args),
      readScreen: async () => (this._privacyMode ? null : this._readScreenModel().catch(() => null)),
      fastMatch: matchFastCommand,
      report: ({ type, ...event }) => this._broadcastDashboard({ ...event, type: 'agent_progress', phase: type, timestamp: new Date().toISOString() }),
      isCancelled: () => this._agentCancelled,
    });
  }

  // ── Task evaluation (Stage 3 acceptance: tools/agent-eval) ──

  /** The plan the agent would make, without doing anything. */
  async planTask(text) {
    const screen = this._privacyMode ? null : await this._readScreenModel().catch(() => null);
    return this._taskAgent().plan(text, screen, this._aiContext());
  }

  /**
   * Run a task for the evaluation: same agent and safety gate, answering
   * "yes" itself when `autoConfirm`, and never saved as a student's data.
   */
  async runTaskForEvaluation(text, { autoConfirm = false } = {}) {
    if (this._voiceProcessing) return { status: 'busy', text: 'AbleSpeak is busy with a voice command.' };
    const turn = this._beginVoiceTurn();
    this._agentRunning = true;
    this._agentCancelled = false;
    this._evaluating = true;
    const started = Date.now();
    let confirmations = 0;
    try {
      const agent = this._taskAgent();
      const context = this._aiContext();
      let outcome = await agent.run(text, context);
      while (outcome.status === 'needs_confirmation') {
        const pending = this._pendingConfirmation;
        this._pendingConfirmation = null;
        if (!autoConfirm || !pending) {
          outcome = await agent.resume(text, context, outcome.state, null);
          break;
        }
        confirmations++;
        const confirmed = await this._runAgentTool(pending.tool, pending.args, { confirmed: true });
        outcome = await agent.resume(text, context, outcome.state, confirmed);
      }
      return { ...outcome, state: undefined, confirmations, ms: Date.now() - started };
    } catch (err) {
      this._broadcastDashboard({ type: 'agent_progress', phase: 'failed', text: err.message, timestamp: new Date().toISOString() });
      throw err;
    } finally {
      this._pendingConfirmation = null;
      this._agentRunning = false;
      this._evaluating = false;
      this._endVoiceTurn(turn);
    }
  }

  /** A routine from the student's profile ("start my homework"). */
  async _runRoutine(text, commandId, startTime) {
    const routine = findMacro(this._profile(), text);
    if (!routine) return false;
    console.log(`[Voice] Routine "${routine.name}": ${routine.steps.join(' → ')}`);
    await this._runTask(routine.name, this._aiContext(), {
      commandId, startTime,
      plan: routine.steps.map(step => ({ do: step, expect: '' })),
    });
    return true;
  }

  /** Plan, act, check and recover; tell the student how it went. */
  async _runTask(text, context, { commandId = uuidv4(), startTime = Date.now(), plan = null, resume = null } = {}) {
    this._agentRunning = true;
    this._agentCancelled = false;
    if (this.aiEngine) this.aiEngine._activeAbortController = new AbortController();
    let outcome;
    try {
      const agent = this._taskAgent();
      outcome = resume
        ? await agent.resume(text, context, resume.state, resume.confirmed)
        : await agent.run(text, context, { plan });
    } catch (err) {
      const stopped = this._agentCancelled;
      if (!stopped) console.error('[Agent] Task error:', err.message);
      outcome = {
        status: stopped ? 'stopped' : 'failed',
        text: stopped ? 'Stopped.' : `Sorry, something went wrong: ${err.message}`,
        steps: [], record: [], replans: 0, toolCalls: [],
      };
      this._broadcastDashboard({ type: 'agent_progress', phase: outcome.status, text: outcome.text, timestamp: new Date().toISOString() });
    } finally {
      this._agentRunning = false;
      if (this.aiEngine) this.aiEngine._activeAbortController = null;
    }

    if (outcome.status === 'needs_confirmation') {
      // The paused task travels with the question it is waiting on, so an
      // answer can only ever resume this task.
      if (this._pendingConfirmation) {
        this._pendingConfirmation.plan = { text, context, state: outcome.state, commandId, startTime };
      }
      this._askConfirmation(outcome.prompt, startTime);
      return outcome;
    }

    const failed = outcome.status === 'failed' || outcome.status === 'cannot';
    console.log(`[Agent] ${outcome.status}: "${text}" — ${outcome.record?.filter(r => r.ok).length || 0}/${outcome.steps?.length || 0} steps, ${outcome.replans} re-plans`);
    this._recordVoiceCommand({
      id: commandId,
      type: 'voice_task',
      text,
      payload: { text, source: 'agent', steps: outcome.steps },
      result: {
        status: outcome.status,
        replans: outcome.replans,
        steps: (outcome.record || []).map(r => ({ do: r.do, tool: r.tool, ok: r.ok, why: r.why })),
      },
      latency_ms: Date.now() - startTime,
      failed: failed || outcome.status === 'stopped',
    });
    this._broadcastDashboard({
      type: 'chat_assistant_message',
      id: commandId,
      text: outcome.text,
      error: failed,
      toolCalls: (outcome.toolCalls || []).map(call => ({ tool: call.tool, result: call.result })),
      provider: 'agent',
      model: this.aiEngine?.model,
      latency: Date.now() - startTime,
      source: 'voice',
      silent: false,
      task: { status: outcome.status, steps: outcome.steps?.length || 0, replans: outcome.replans },
      timestamp: new Date().toISOString(),
    });
    if (outcome.text) {
      this._lastTTSText = outcome.text;
      this._lastTTSTime = Date.now();
    }
    return outcome;
  }

  /** The window's controls for the AI, unless privacy mode is on. */
  async _screenForAgent() {
    if (this._privacyMode) return null;
    try {
      return await this._readScreen({ extensionConnected: this.extensionClients.size > 0 });
    } catch {
      return null;
    }
  }

  /** The student's own phrase for a command ("my music" → "open spotify"). */
  _applyAlias(text) {
    const means = expandAlias(this._profile(), text);
    if (!means) return text;
    console.log(`[Voice] Shortcut "${text}" → "${means}"`);
    return means;
  }

  /** Tell the overlay how to listen for the student now using the computer. */
  broadcastListeningSettings() {
    this._broadcastDashboard({
      type: 'listening_settings',
      ...listeningSettings(this._profile()),
      timestamp: new Date().toISOString(),
    });
  }

  /** Someone holds the voice turn, or it is being handed to a queued clip. */
  _voiceBusy() {
    return this._voiceProcessing || this._voiceHandoff;
  }

  _beginVoiceTurn() {
    const turn = {};
    this._voiceHandoff = false;
    this._voiceTurn = turn;
    this._voiceProcessing = true;
    this._voiceProcessingSince = Date.now();
    return turn;
  }

  /** Free the voice mutex and wake the next queued clip, if any. */
  _endVoiceTurn(turn) {
    // A turn that was force-released must not free the one that replaced it.
    if (turn !== this._voiceTurn) return;
    this._voiceTurn = null;
    this._voiceProcessing = false;
    const next = this._voiceTurnWaiters.shift();
    if (next) {
      // Reserved for the woken clip until it takes the turn.
      this._voiceHandoff = true;
      next();
    }
  }

  /** Transcribe one clip, then type it (dictation) or run it as a command. */
  async _processVoiceAudio(ws, msg) {
    const startTime = Date.now();
    console.log(`[Voice] Received audio (${Math.round(msg.audio.length / 1024)}KB)`);

    // Transcribe with Gemini, expecting this student's own words
    const transcript = await this.voiceHandler.transcribe(msg.audio, msg.mimeType || 'audio/webm', {
      vocabulary: this._profile().vocabulary,
    });
    const { error } = transcript;
    let text = transcript.text;

    if (error === 'no_speech') {
      this._markTurn('no_speech');
      ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
      return;
    }
    if (error) {
      this._markTurn('error');
      ws.send(JSON.stringify({ type: 'voice_error', error, timestamp: new Date().toISOString() }));
      return;
    }
    if (this._turnLog) this._turnLog.transcript = text;

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
        this._markTurn('control');
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
        this._markTurn('filtered');
        ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
        return;
      }
    }

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
          this._markTurn('filtered');
          ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
          return;
        }
      }
    }

    await this._handleUtterance(ws, text, { startTime, screenshot: msg.screenshot || null });
  }

  /**
   * What to do with something the student said, or an adult typed on the
   * Chat page (`typed`): stop/sleep, dictation, a pending question, a
   * correction, "type this", routines, quick commands, tasks, then the AI.
   */
  async _handleUtterance(ws, text, { startTime = Date.now(), screenshot = null, typed = false } = {}) {
    // VOICE CONTROL: interrupt (stop/cancel) + sleep/wake — never hits the LLM
    if (this._handleVoiceControl(text, { typed })) {
      this._markTurn('control');
      return;
    }

    // ────────────────────────────────────────────
    // DICTATION MODE: type speech directly into the active app
    // No AI processing — just transcribe → type → restart mic
    // ────────────────────────────────────────────
    if (this._dictationMode) {
      this._markTurn('dictation');
      const tLower = text.toLowerCase().trim().replace(/[.!?,]+$/, '');

      // A question is waiting ("AbleSpeak, close Word" → "Close this window?"):
      // yes or no answers it; anything else cancels it and is typed as usual.
      if (this._pendingConfirmation) {
        if (isAffirmative(text) || isNegative(text)) {
          this._markTurn('command');
          await this._resolvePendingConfirmation(text, startTime);
          return;
        }
        this._pendingConfirmation = null;
        this._broadcastDashboard({
          type: 'chat_assistant_message', id: uuidv4(),
          text: "Okay, I didn't do that. Carrying on typing.", error: false, toolCalls: [],
          provider: 'fast', model: 'confirmation', source: 'voice', silent: false,
          timestamp: new Date().toISOString(),
        });
      }

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
        let cmdError = null;
        try {
          const { executeDictationCommand } = await import('./system-tools.js');
          const cmdResult = await executeDictationCommand(navCmd);
          if (cmdResult?.status === 'error') cmdError = cmdResult.message || 'Command failed';
        } catch (err) {
          console.error('[Voice] Dictation command error:', err.message);
          cmdError = err.message;
        }
        this._broadcastDictationTyped(`[${navCmd.replace(/_/g, ' ')}]`, cmdError);
        return;
      }

      // "AbleSpeak, open Chrome" runs below as a command. Dictation stays on
      // for whatever is said next.
      const command = matchDictationPrefixCommand(text);
      if (!command) {
        // Convert punctuation words to actual punctuation (typed text is kept as it is)
        const typedText = typed ? text : this._processDictationText(text);
        if (!typedText.trim()) return;

        console.log(`[Voice] ✏️ Dictating: "${typedText}"`);
        const dictateError = await this._dictateAndReport(typedText);

        // Broadcast to overlay so it shows the typed text — and speaks it
        // if it silently failed to type (CVA-3).
        this._broadcastDictationTyped(typedText, dictateError);
        return;
      }
      console.log(`[Voice] ✏️ Command during dictation: "${command}"`);
      this._markTurn('command');
      text = command;
    }

    const commandId = uuidv4();
    console.log(`[Voice] Command: "${text.length > 200 ? `${text.slice(0, 200)}…` : text}"`);

    // ────────────────────────────────────────────
    // CONFIRMATION REPLY: if a consequential action is awaiting a spoken
    // yes/no, THIS utterance is the answer. Handle it before anything else.
    // ────────────────────────────────────────────
    if (await this._resolvePendingConfirmation(text, startTime)) {
      this._awaitingTypeText = null;
      return;
    }

    // "Type this: …", or the words after a bare "type this".
    if (await this._handleTypeRequest(text, { commandId, startTime, typed })) return;

    // Reactive correction: "undo that" / "no, I meant ..." right after a mistake.
    if (await this._handleCorrection(text, startTime)) return;

    text = this._applyAlias(text);
    if (await this._runRoutine(text, commandId, startTime)) return;

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
          const typedText = typed ? fastMatch.args.initialText.trim() : this._processDictationText(fastMatch.args.initialText);
          if (typedText.trim()) {
            console.log(`[Voice] ✏️ Initial dictation: "${typedText}"`);
            const dictateError = await this._dictateAndReport(typedText);
            this._broadcastDictationTyped(typedText, dictateError);
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
      this._recordVoiceCommand({
        id: commandId,
        type: 'voice_fast',
        text,
        payload: { text, fastTool: fastMatch.tool },
        result: toolResult,
        latency_ms: latency,
        failed: toolFailed(toolResult),
      });

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
    if (this._privacyMode) screenshot = null;
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
      screenModel: await this._screenForAgent(),
    };

    if (needsPlan(text)) {
      await this._runTask(text, context, { commandId, startTime });
      return;
    }
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

    this._recordVoiceCommand({
      id: commandId,
      type: 'voice',
      text,
      payload: { text, source: typed ? 'chat' : 'microphone' },
      result,
      latency_ms: result.latency || 0,
      failed: aiCommandFailed(result),
    });

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
        // No extension connected — every browser tool must fail loudly here.
        // create_tab/navigate_to used to resolve as {status:'success', simulated:true}
        // with nothing having actually happened; simulated was read nowhere else,
        // and both are in SILENT_COMMANDS, so the student got silence and the
        // browser never opened (CVA-4).
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
  _handleVoiceControl(rawText, { typed = false } = {}) {
    const t = (rawText || '').trim().toLowerCase().replace(/[.!?,]+$/, '');
    if (!t) return false;
    // Room talk is ignored quietly while asleep; a typed command gets told why.
    const ignored = (why) => {
      if (typed) this._reply(why, { silent: true });
      else this._broadcastDashboard({ type: 'voice_no_speech', timestamp: new Date().toISOString() });
    };

    // ── While voice-dismissed: only a wake phrase restores the overlay; everything
    // else is ignored. This is the ONLY way back for a student who cannot use the
    // keyboard shortcut, tray icon, or an app relaunch (HFI-1). Checked before sleep
    // so a dismissed-and-somehow-also-asleep overlay still responds to the same phrase.
    if (this._dismissed) {
      if (WAKE_PHRASES_RE.test(t)) {
        this._dismissed = false;
        this._sleeping = false;
        console.log('[Voice] 👋 Restored overlay from dismiss');
        this._broadcastDashboard({
          type: 'voice_restored',
          say: "I'm here.",
          timestamp: new Date().toISOString(),
        });
      } else {
        // Stay hidden, quietly — tell the overlay to keep listening, no error shown.
        console.log(`[Voice] 🙈 Ignored while dismissed: "${t.slice(0, 40)}"`);
        ignored('AbleSpeak is hidden. Send "come back" first.');
      }
      return true;
    }

    // ── While asleep: only a wake phrase resumes; everything else is ignored. ──
    if (this._sleeping) {
      if (WAKE_PHRASES_RE.test(t)) {
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
        ignored('AbleSpeak is asleep. Send "wake up" first.');
      }
      return true;
    }

    // ── Interrupt: cancel the current operation / stop talking. ──
    // Skipped while dictating: "stop" there means "stop dictation mode" (the
    // dictation block below owns that), and a bare "stop" must stay typeable
    // as dictated text rather than being swallowed as a global AI interrupt.
    if (!this._dictationMode && STOP_RE.test(t)) {
      console.log('[Voice] ⚡ INTERRUPT — cancelling current operation');
      this._awaitingTypeText = null;
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

    // ── Dismiss: hide the overlay, but the mic stays hot — say "AbleSpeak" or
    // "come back" to bring it back. A student who cannot type or click must never
    // lose voice control just because the overlay is out of sight (HFI-1). ──
    if (/^(close|dismiss|hide|go away)$/.test(t)) {
      this._dismissed = true;
      console.log('[Voice] 🙈 Dismissed — say "AbleSpeak" or "come back" to bring it back');
      this._broadcastDashboard({
        type: 'voice_dismissed',
        say: 'Okay. Say AbleSpeak, or come back, any time.',
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

    // ── "Who am I?" — whose progress this computer is recording (AT-50) ──
    if (!this._dictationMode && /^(who am i|who's using this( computer)?|who is using this( computer)?|whose session is this)$/.test(t)) {
      const student = this._activeStudent();
      this._broadcastDashboard({
        type: 'chat_assistant_message', id: uuidv4(),
        text: student
          ? `This is ${student.name}'s session.`
          : 'No student is chosen on this computer yet. A teacher can choose one on the Teacher page.',
        error: false, toolCalls: [], provider: 'fast', model: 'identity', source: 'voice',
        silent: false, timestamp: new Date().toISOString(),
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

    // A multi-step task paused here: carry on (or stop) after the answer.
    if (pending.plan) {
      const paused = pending.plan;
      // Typed on the Chat page, the answer arrives outside a voice turn;
      // take one so the task never runs alongside a spoken command.
      const turn = this._voiceProcessing ? null : this._beginVoiceTurn();
      try {
        let confirmed = null;
        if (isAffirmative(text)) {
          console.log(`[Voice] ✅ Confirmed task step: ${pending.tool}`);
          confirmed = await this._runAgentTool(pending.tool, pending.args, { confirmed: true });
        }
        await this._runTask(paused.text, paused.context, {
          commandId: paused.commandId, startTime: paused.startTime,
          resume: { state: paused.state, confirmed },
        });
      } finally {
        if (turn) this._endVoiceTurn(turn);
      }
      return true;
    }

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

  /**
   * Save a voice command with its outcome for the progress engine.
   *
   * One task can take several tries. When a command is another go at a
   * failed one (or a spoken correction, `retryOf`), the earlier row becomes
   * "superseded" and this row carries the task: one more prompt, and
   * "repaired" if it worked. So independence_rate counts first-time
   * successes, and task_completion counts each task once.
   */
  _recordVoiceCommand({ id, type, text, payload, result, latency_ms, failed, retryOf = null }) {
    const ids = this._voiceAttribution();
    const last = this._lastVoiceCommand;
    const sameSession = last && last.session_id === ids.session_id;
    const retrying = retryOf
      || (sameSession && last.failed && Date.now() - last.at < RETRY_WINDOW_MS && isLikelyRetry(last.text, text) ? last : null);
    const promptCount = retrying ? retrying.promptCount + 1 : 0;
    const outcome = failed ? 'error' : (promptCount > 0 ? 'repaired' : 'success');
    try {
      if (retrying) updateCommandOutcome(retrying.id, 'superseded');
      insertCommand({
        id, type, direction: 'user_to_ai',
        payload: JSON.stringify(payload),
        result: JSON.stringify(result ?? {}),
        latency_ms,
        ...ids,
        outcome,
        prompt_count: promptCount,
      });
    } catch (err) {
      console.error('[WsHub] DB insert error:', err.message);
    }
    this._lastVoiceCommand = { id, text, failed, at: Date.now(), promptCount, session_id: ids.session_id };
    if (this._turnLog) this._turnLog.commandId = id;
  }

  /** "Undo that": the last command did the wrong thing, so it failed. */
  _markLastCommandWrong() {
    const last = this._lastVoiceCommand;
    if (!last) return null;
    // Too old, or someone else's session: nothing of this student's to correct.
    if (last.session_id !== this._voiceAttribution().session_id || Date.now() - last.at > CORRECTION_WINDOW_MS) {
      return null;
    }
    try { updateCommandOutcome(last.id, 'error'); } catch {}
    this._lastVoiceCommand = { ...last, failed: true, at: Date.now() };
    return this._lastVoiceCommand;
  }

  /**
   * A correction that worked is a labelled example: what AbleSpeak heard,
   * and what the student meant. Returns a sentence to add when it was
   * learned as a shortcut, or ''.
   */
  _learnCorrection(wrong, meant) {
    if (!wrong?.text) return '';
    try {
      const outcome = this._onCorrection(wrong.text, meant);
      return outcome?.learned ? ` I'll remember that "${wrong.text}" means "${meant}".` : '';
    } catch {
      return '';
    }
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
      const wrong = this._markLastCommandWrong();
      await this._undoLast();              // revert the mistaken action
      await this._executeCorrectedCommand(correction, startTime, wrong); // then do the right thing
      return true;
    }

    // Pure undo / "that was wrong".
    const undoRe = /^(undo( that| it| last| the last)?|take that back|revert( that)?|that('?s| is| was)? (wrong|not right|not it)|wrong one|not that one?|nope that('?s| is) wrong)$/;
    if (undoRe.test(t)) {
      console.log('[Voice] ↩️ Undo last action');
      this._markLastCommandWrong();
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

  /**
   * Run a corrected command through fast-match then AI, with spoken feedback.
   * `wrong` is the command it replaces, so the task counts one more prompt.
   */
  async _executeCorrectedCommand(text, startTime = Date.now(), wrong = null) {
    const fast = matchFastCommand(text);
    if (fast && fast.tool !== 'dictation_mode') {
      const r = await this.aiEngine.toolRegistry.executeTool(fast.tool, fast.args, this);
      if (r?.status === 'needs_confirmation') { this._askConfirmation(r.prompt, startTime); return; }
      if (isBrowserTool(fast.tool)) this._autoFocusBrowser();
      this._recordAction({ tool: fast.tool, args: fast.args, result: r });
      const failed = toolFailed(r);
      this._recordVoiceCommand({
        id: uuidv4(), type: 'voice_fast', text,
        payload: { text, fastTool: fast.tool, correction: true }, result: r,
        latency_ms: Date.now() - startTime, failed, retryOf: wrong,
      });
      const learned = failed ? '' : this._learnCorrection(wrong, text);
      this._broadcastDashboard({
        type: 'chat_assistant_message', id: uuidv4(),
        text: failed ? `That didn't work: ${r.error || r.message || 'unknown error'}`
                     : `${fast.silent ? 'Okay, did that instead.' : (r?.message || 'Done.')}${learned}`,
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
      screenModel: await this._screenForAgent(),
    };
    const result = await this.aiEngine.processChat(text, ctx);
    if (this._pendingConfirmation) { this._askConfirmation(this._pendingConfirmation.prompt, startTime); return; }
    const failed = aiCommandFailed(result);
    this._recordVoiceCommand({
      id: uuidv4(), type: 'voice', text,
      payload: { text, source: 'microphone', correction: true }, result,
      latency_ms: result.latency || 0, failed, retryOf: wrong,
    });
    const learned = failed ? '' : this._learnCorrection(wrong, text);
    this._broadcastDashboard({
      type: 'chat_assistant_message', id: uuidv4(), text: `${result.text || ''}${learned}`.trim(), error: result.error || false,
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

  /**
   * Type dictated text via system-tools and report failure instead of
   * swallowing it. dictateText()/executeDictationCommand() can either throw
   * (e.g. a PowerShell/COM error) or resolve with {status:'error', ...} — both
   * must be treated as failure. Returns an error message string, or null on
   * success (CVA-3: a dictation failure must never be silent — the student is
   * mid-sentence and has no way to proofread a word that never got typed).
   */
  async _dictateAndReport(typedText) {
    try {
      const { dictateText } = await import('./system-tools.js');
      const result = await dictateText(typedText);
      if (result?.status === 'error') return result.message || 'Typing failed';
      return null;
    } catch (err) {
      console.error('[Voice] Dictation type error:', err.message);
      return err.message;
    }
  }

  /** Broadcast what got typed — and audibly if it silently failed (CVA-3). */
  _broadcastDictationTyped(text, error) {
    this._broadcastDashboard(error ? {
      type: 'dictation_typed', text,
      error: true, message: `That didn't type: ${error}`,
      timestamp: new Date().toISOString(),
    } : {
      type: 'dictation_typed', text,
      timestamp: new Date().toISOString(),
    });
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
      sessionId: this._attribution().session_id,
      // Voice control state, so the dashboard can show it without waiting for an event
      voice: {
        sleeping: !!this._sleeping,
        dismissed: !!this._dismissed,
        privacyMode: !!this._privacyMode,
        dictationMode: !!this._dictationMode,
      },
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
