import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { insertCommand, updateCommandOutcome, upsertHealthCheck, logVoiceTurn, getRecentAiCommands } from './db.js';
import { learnFrom, findLearned, stepsOf } from './learned-commands.js';
import { autocorrectCommand } from './command-autocorrect.js';
import { getFullSystemContext } from './system-info.js';
import { VoiceHandler } from './voice-handler.js';
import { matchFastCommand, isSilentTool, isBrowserTool } from './fast-commands.js';
import { isAffirmative, isNegative, isEchoOf } from './safety.js';
import { normaliseProfile, listeningSettings, expandAlias, findMacro } from './student-profile.js';
import { toolFailed, aiCommandFailed } from './tool-outcome.js';
import { TaskAgent, needsPlan } from './agent.js';
import { spokenWindowName } from './app-names.js';
import { gateByName, isWakePhrase, stripName, afterName, NAME_WORD, NAME_WINDOW_MS } from './wake-name.js';
import { cleanLocalText } from './local-asr.js';
import { uniqueByName } from './screen-model.js';
import { onSite } from './tool-registry.js';
import { speedMeter, speedOfTurn } from './speed-meter.js';
import { sponsorSegments } from './sponsorblock.js';
import { samplesFromWav } from './voice-profile.js';

// Phrases that resume normal operation from sleep OR bring the overlay back
// from a voice "dismiss" (HFI-1) are isWakePhrase (wake-name.js), shared so the
// two recovery paths never drift. It takes the name on either side and the way
// speech recognition writes it: "Wake up, able speak." used to be ignored.

// About a minute of continuous dictation. Past this, clips are refused rather
// than typed long after they were spoken.
const MAX_QUEUED_DICTATION_CLIPS = 8;

// In dictation, "AbleSpeak, open Chrome" is a command rather than text. The
// word after the name must be a command verb, so "AbleSpeak is great" is typed.
const DICTATION_COMMAND_RE = /^\s*(?:hey\s+)?able\s*-?\s*speak\b[\s,.:;!-]*((?:open|close|go|switch|click|press|scroll|search|play|pause|show|find|select|save|send|reload|refresh|zoom|mute|unmute|start|stop|take|read|summari[sz]e|tell|set|turn|navigate|focus|minimi[sz]e|maximi[sz]e|copy|paste|print|undo|redo)\b[\s\S]*)$/i;

const STOP_RE = /^(stop|cancel|abort|shut up|be quiet|quiet|nevermind|never mind)[\s.,!]?/i;
const SLEEP_RE = /^(go to sleep|sleep|stop listening|hush|pause listening)$/;
// Speech is ignored this long after each evaluation task (tools/agent-eval), so
// nothing said in the room runs between one task and the next
const EVALUATION_QUIET_MS = 30_000;
const DICTATION_END_RE = /^(stop|end|exit)\s+dictat(ing|ion)|^command\s+mode$/;

// Dictation with speech recognised on this computer (local-asr.js): how long
// Gemini gets before the words heard here are typed instead.
const DICTATION_ONLINE_WAIT_MS = 8000;
// How long a browser command waits for the extension to (re)connect
const EXTENSION_GRACE_MS = 3000;
// The speech service (remote-asr.js): how long its final words get before the
// clip is heard another way, and how long the real-time check waits.
const REMOTE_FINAL_WAIT_MS = 3000;
const REMOTE_PEEK_WAIT_MS = 2000;

/** "https://www.youtube.com/watch?v=…" → "youtube.com": the site, never the page's own address. */
function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || null; } catch { return null; }
}

/** What the speech service heard: '' for silence or noise (Whisper's own no-speech rule). */
function remoteText({ text, no_speech_prob: noSpeech, avg_logprob: logprob }) {
  if (noSpeech > 0.6 && (logprob == null || logprob < -1)) return '';
  return cleanLocalText(text);
}
// Real time (_onVoicePeek): commands that are complete as soon as they are
// said. Anything that takes free words ("search for …", "switch to …",
// "type …") or can be the start of something longer ("close" is Alt+F4,
// "play" may be "play Michael Jackson") waits for the person's full pause.
const EARLY_TOOLS = new Set([
  'scroll', 'scroll_to_top', 'scroll_to_bottom', 'reload_tab', 'go_back', 'go_forward',
  'create_tab', 'close_tab', 'mute_tab', 'media_control', 'system_media_control', 'system_volume',
  'window_control', 'focus_next', 'focus_prev', 'press_key_combination', 'navigate_dashboard',
  'open_application', 'clear_field', 'youtube_next_video', 'youtube_previous_video', 'youtube_play_result',
  'youtube_seek', 'youtube_skip_sponsor',
]);
// An AI step that only read something: "undo that" passes over it to what was done
const READ_ONLY_STEPS = new Set([
  'uia_query', 'list_desktop_elements', 'read_desktop_window', 'list_running_apps', 'get_page_content',
  'get_page_state', 'find_tab', 'list_tabs', 'take_screenshot', 'answer_question', 'ignore', 'gmail_open_email',
]);
// The voice bar records at most 30 s (dictation); this is about 39 s of
// 16 kHz audio, base64. Anything bigger isn't one of its clips.
const MAX_WAV_BASE64 = 1.6 * 1024 * 1024;

// While music or a video plays, the mic hears the song as well as the person,
// and lyrics became commands ("It singsed me a melody in"). Then only phrases
// with the name are acted on — and these, so the music can always be stopped,
// skipped or turned down without it. ("Pose the song" is how "pause" came out.)
const MEDIA_COMMAND_RE = /^(?:please\s+)?(?:pause|pose|pos|stop|mute|unmute|quiet|silence|hush|shut up|skip|next|previous|volume|louder|quieter|softer|(?:turn|put) (?:it|this|that|the (?:music|song|sound|volume|video)) (?:up|down|off)|(?:lower|raise) the (?:volume|music|sound))\b/;
export function isMediaCommand(text) {
  const t = stripName(text).rest.toLowerCase().replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  return !!t && t.split(' ').length <= 6 && MEDIA_COMMAND_RE.test(t);
}
// The voice bar re-opens the mic 0.5 s after AbleSpeak stops speaking; the
// last of the sound can still be in the room a little after that
const ECHO_RECENT_MS = 1500;
// How long a phrase waits for Windows to say whether something is playing.
// The check runs while the phrase is transcribed, so it is normally ready.
const MEDIA_CHECK_WAIT_MS = 1500;
// The last answer is used for live words and real-time commands this long
const MEDIA_KNOWN_MS = 15000;
// Browsers: a click by name there goes through the Chrome extension
const BROWSER_APPS = new Set(['chrome', 'msedge', 'brave', 'firefox', 'opera']);
// A screen read started when speech began serves the AI command from that phrase
// (speaking, the pause and the words take a few seconds; a recording is at most 8 s)
const SCREEN_PREFETCH_MS = 12000;
const LOCAL_UNAVAILABLE = 'Speech recognition on this computer isn’t ready. Wait a moment and try again, or ask your helper to choose another setting.';

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
  constructor({ server, aiEngine, dashboardPath = '/ws/dashboard', extensionPath = '/ws/extension', wsToken, attribution, activeStudent, profile, readScreen, readScreenModel, onCorrection, localAsr, remoteAsr, mediaState, frontWindow, windowControls, speed, analytics, voiceProfile }) {
    this.aiEngine = aiEngine;
    // Voiceprints ("only my voice", voice-profile.js): each command's score, measuring only; null = none
    this.voiceProfile = voiceProfile || null;
    this.voiceHandler = new VoiceHandler();
    // Each voice turn's stage timings and cost (speed-meter.js, the Speed tab)
    this.speed = speed || speedMeter;
    // Usage counted in Google Analytics, with consent (analytics.js); null = none
    this.analytics = analytics || null;
    // Speech recognition on this computer (local-asr.js); null = Gemini only
    this.localAsr = localAsr || null;
    // Real-time speech recognition on AbleSpeak's speech service (remote-asr.js); null = none
    this.remoteAsr = remoteAsr || null;
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
    // What is playing in any app (system-tools.js mediaPlaying): { playing, apps } or null.
    // None in tests: phrases are never held back for music there.
    this._mediaSource = mediaState || null;
    this._media = null;       // the last answer, with when it came: { playing, apps, at }
    this._mediaCheck = null;  // the check in progress
    // "Click X" by name (_clickByName): the window in front { hwnd, process, title },
    // and its controls (a screen model). None in tests: clicks go to the AI there.
    this._frontWindow = frontWindow || null;
    this._windowControls = windowControls || null;
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
    // One browser connection: the newest is the extension that just woke or
    // reconnected. An older one left open got the commands while the new one
    // got nothing, and its replies could be lost.
    for (const old of this.extensionClients) {
      if (old !== ws) { try { old.close(4000, 'replaced by a newer connection'); } catch {} }
    }
    this.extensionClients.clear();
    this.extensionClients.add(ws);
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });
    upsertHealthCheck({ component: 'chrome_ext', status: 'ok', message: 'Chrome extension connected' });
    this._broadcastDashboard({ type: 'extension_status', connected: true, count: this.extensionClients.size });

    ws.on('message', (data) => {
      if (!this.extensionClients.has(ws)) return; // a replaced connection: ignore it
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
        // The extension's own tabs and page ('integration'). A library page
        // reader's result ('library') is something else and used to replace it.
        if (parsed.context === 'integration' && parsed.result) {
          this.browserContext = { ...parsed.result, receivedAt: Date.now() };
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
      // Commands sent on this connection will never be answered: say so now,
      // not after the 10-second timeout
      for (const [id, pending] of this.pendingToolCalls) {
        if (pending.socket !== ws) continue;
        clearTimeout(pending.timeout);
        this.pendingToolCalls.delete(id);
        pending.resolve({ status: 'error', error: 'The browser disconnected before it answered. The action may not have happened.' });
      }
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
      listening: this._listeningForOverlay(),
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

        // ── The voice bar as the student sees it, for the dashboard's picture of the screen ──
        // Its mode and words, where it sits, the screen size and the mic level (overlay.html sendMirror)
        if (msg.type === 'overlay_state') {
          this._overlayState = { ...msg, at: Date.now() };
          this._broadcastDashboard({ ...msg, timestamp: new Date().toISOString() });
          return;
        }

        // ── Chat Command: handled exactly like speech ──
        if (msg.type === 'chat_command' && msg.text) {
          await this._onChatCommand(ws, msg);
        }

        // ── Pre-transcribed Voice Text (from Web Speech API — instant, no Gemini roundtrip) ──
        if (msg.type === 'voice_text' && msg.text) {
          // During an exam, words from this path go to the exam too, and nowhere else
          if (this.examSession?.active) {
            await this._handleUtterance(ws, msg.text);
            return;
          }
          if (this._quietForEvaluation()) {
            console.log('[Voice] Ignored: the agent evaluation is running');
            this._broadcastDashboard({ type: 'voice_no_speech', timestamp: new Date().toISOString() });
            return;
          }
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
            const fastMatch = matchFastCommand(text, { activeUrl: this.browserContext.activeTab?.url });
            if (fastMatch && fastMatch.tool !== 'dictation_mode') {
              console.log(`[Voice] ⚡ Fast match: ${fastMatch.tool}(${JSON.stringify(fastMatch.args)})`);
              const toolResult = await this._searchFallback(fastMatch, await this.aiEngine.toolRegistry.executeTool(fastMatch.tool, fastMatch.args, this));
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
                // get_page_state answers with the tabs, active tab and page right
                // now. (This used to send context_updater with no code, which made
                // the extension add a broken updater that stalled its updates.)
                const freshCtx = await Promise.race([
                  this.sendToolToExtension('get_page_state', {}),
                  new Promise(r => setTimeout(() => r(null), 2000)),
                ]);
                if (freshCtx && Array.isArray(freshCtx.tabs)) {
                  this.browserContext = { ...freshCtx, receivedAt: Date.now() };
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

        // ── Real time: the audio, streamed to the speech service while it is said ──
        if (msg.type === 'voice_stream_start') this._onStreamStart(msg);
        if (msg.type === 'voice_chunk' && typeof msg.pcm === 'string') {
          this.remoteAsr?.sendAudio(msg.utt, Buffer.from(msg.pcm, 'base64'));
        }
        if (msg.type === 'voice_stream_end') this.remoteAsr?.end(msg.utt);
        if (msg.type === 'voice_stream_cancel') this.remoteAsr?.cancel(msg.utt);

        // ── Real time: is what was said so far already a command? ──
        if (msg.type === 'voice_peek') {
          await this._onVoicePeek(ws, msg);
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

  /**
   * An exam is starting: nothing left over from before may carry on beside
   * it — a running task, a question waiting for yes or no, dictation, sleep.
   */
  enterExam() {
    if (this._agentRunning) this._stopTask();
    try { this.aiEngine?.abortActive?.(); } catch {}
    this._pendingConfirmation = null;
    this._awaitingTypeText = null;
    this._sleeping = false;
    if (this._dictationMode) {
      this._dictationMode = false;
      import('./system-tools.js').then(({ clearDictationTarget }) => clearDictationTarget()).catch(() => {});
      this._broadcastDashboard({ type: 'dictation_mode', enabled: false, timestamp: new Date().toISOString() });
    }
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
    if (this._quietForEvaluation()) {
      console.log('[Voice] Ignored: the agent evaluation is running');
      this._broadcastDashboard({ type: 'voice_no_speech', timestamp: new Date().toISOString() });
      return;
    }
    this._wakeSpeechService();
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
      // When the voice bar last heard speech: the wait for the pause before this clip was sent
      speechEndedAt: Number.isFinite(msg.speechEndedAt) ? msg.speechEndedAt : null,
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
    // Timed only when something was heard: the Speed tab is about what was said
    const speed = turn.transcript ? speedOfTurn(turn) : null;
    let id = null;
    try {
      id = logVoiceTurn({
        ...this._voiceAttribution(),
        outcome: turn.outcome,
        transcript: turn.transcript,
        command_id: turn.commandId,
        audio_kb: turn.audioKb,
        ms: Date.now() - turn.started,
        speed,
      });
    } catch {
      // No database (tests); the command itself is unaffected.
    }
    const entry = speed ? this.speed.addTurn({ id, commandId: turn.commandId, said: turn.transcript, ...speed }) : null;
    // Counted as a use (kind, worked, time, feature; never the words), if the account agreed
    if (speed) this.analytics?.turn(turn, speed);
    // A quick command can be done before its voice check: the score is saved when it comes
    if (entry && turn.speakerCheck && !turn.speaker) {
      turn.speakerCheck.then(found => this.speed.addSpeaker?.(entry, found));
    }
  }

  /**
   * How much this clip sounds like each person set up (voice-profile.js),
   * worked out on this computer while the words are being heard. Only the
   * student's own voice bar; the clip's 16 kHz WAV is used, never kept.
   */
  _checkSpeaker(msg) {
    const log = this._turnLog;
    if (!log || msg.source !== 'overlay' || !this.voiceProfile?.measuring()) return;
    if (typeof msg.wav !== 'string' || msg.wav.length > MAX_WAV_BASE64) return;
    let samples;
    try { samples = samplesFromWav(msg.wav); } catch { return; }
    log.speakerCheck = this.voiceProfile.check(samples).then(found => {
      if (found && !found.skipped) {
        log.speaker = found;
        console.log(`[Voice lock] Sounds ${found.match ? 'like' : 'unlike'} who is set up: ${found.score} (${found.ms} ms, measuring only)`);
      }
      return found;
    }, err => {
      console.warn('[Voice lock] Voice check failed:', err.message);
      return null;
    });
  }

  // ── Multi-step tasks (Stage 3) ──

  /** While a task runs, a clip can only stop it. */
  async _interruptTask(ws, msg) {
    const { text } = await this._transcribeClip(msg);
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
    if (result?.status !== 'needs_confirmation') {
      // An evaluation isn't the student's data, but the browser still comes
      // forward as it does for them: without it, the agent opened Wikipedia
      // in the extension's tab and then read another Chrome window (23 Oct 2026).
      // Waited for, so the next read of the screen sees the browser.
      if (!this._evaluating) this._recordAction({ tool: name, args, result });
      if (isBrowserTool(name)) await this._autoFocusBrowser();
    }
    return result;
  }

  /**
   * The front window's controls, for the AI to see whether its actions
   * changed anything; null in privacy mode. `fresh: false` may reuse the
   * read made for this command (screen-model.js keeps it for 4 s).
   */
  async readScreenForAgent({ fresh = true } = {}) {
    if (this._privacyMode) return null;
    const screen = await this._readScreenModel({ fresh }).catch(() => null);
    // Which window each read saw, for working out why a step was judged as it was
    console.log(`[Agent] Screen: ${screen ? `"${String(screen.window).slice(0, 60)}" (${screen.app}, ${screen.elements?.length ?? 0} controls)` : 'not read'}`);
    return screen;
  }

  _taskAgent() {
    const engine = this.aiEngine;
    return new TaskAgent({
      llm: request => engine.complete(request),
      systemPrompt: context => engine._buildSystemPrompt(context),
      toolsFor: context => engine.toolRegistry.getToolsForContext(context),
      execute: (name, args) => this._runAgentTool(name, args),
      readScreen: () => this.readScreenForAgent(),
      // What the document in front says, to check typing; nothing in privacy mode
      readDocument: async () => {
        if (this._privacyMode) return null;
        const { actOnElement } = await import('./screen-model.js');
        const read = await actOnElement({ action: 'read_text', value: 'all', log: false });
        return read?.status === 'success' && typeof read.text === 'string' ? read.text : null;
      },
      // The extension's browser as a process name; null when it isn't connected
      extensionBrowser: () => {
        if (!this.extensionClients.size) return null;
        const name = String(this.extensionBrowserName || 'chrome').toLowerCase();
        return name.includes('edge') ? 'msedge' : name.includes('brave') ? 'brave' : name.includes('opera') ? 'opera' : 'chrome';
      },
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
    // Speech in the room is ignored from now until 30 s after the task (the
    // gap to the next one): on 23 Oct 2026 the always-on microphone heard the
    // room and a task came back "busy". A command already being heard is
    // let finish, for up to 15 s, rather than failing the task.
    this._evaluationQuietUntil = Date.now() + EVALUATION_QUIET_MS;
    for (let waited = 0; this._voiceBusy() && waited < 15000; waited += 100) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this._voiceBusy()) return { status: 'busy', text: 'AbleSpeak is busy with a voice command.' };
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
      this._evaluationQuietUntil = Date.now() + EVALUATION_QUIET_MS;
      this._endVoiceTurn(turn);
    }
  }

  /** While the agent evaluation runs, speech must not run commands or hold up a task. */
  _quietForEvaluation() {
    return !this.examSession?.active && (this._evaluating || Date.now() < (this._evaluationQuietUntil || 0));
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
    // Read while the person was speaking: the AI doesn't wait for it after the words
    const pre = this._screenPrefetch;
    this._screenPrefetch = null;
    if (pre && Date.now() - pre.at < SCREEN_PREFETCH_MS) {
      const waited = Date.now();
      const model = await pre.read;
      console.log(`[Voice] Screen read while speaking: waited ${Date.now() - waited} ms more for it`);
      return model;
    }
    return this._readScreenNow();
  }

  async _readScreenNow() {
    try {
      return await this._readScreen({ extensionConnected: this.extensionClients.size > 0 });
    } catch {
      return null;
    }
  }

  /**
   * Speech started: read the screen now (in its own PowerShell worker, so no
   * action waits behind it). An AI command then finds it ready instead of
   * reading it after the words, which took up to 1.5 s. A quick command
   * doesn't use it.
   */
  _prefetchScreen(utt = null) {
    if (this._privacyMode || this._dictationMode || this.examSession?.active) return;
    const pre = this._screenPrefetch;
    // Once per phrase (speech start and the early check both ask)
    if (pre && (utt != null ? pre.utt === utt : Date.now() - pre.at < 3000)) return;
    this._screenPrefetch = { at: Date.now(), utt, read: this._readScreenNow() };
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
      ...this._listeningForOverlay(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Real time: at the first short pause the voice bar sends the words so far.
   * When they are already a known command, it runs now (and the voice bar
   * drops the rest of the clip) instead of after the person's full pause.
   * Anything else: "not taken", and the clip carries on as usual.
   */
  async _onVoicePeek(ws, msg) {
    this._wakeSpeechService();
    this._checkMedia();
    this._prefetchScreen(msg.streamUtt ?? null); // without streaming, this is the first the server hears of the phrase
    const answer = taken => {
      try { ws.send(JSON.stringify({ type: 'voice_peek_result', id: msg.id, taken })); } catch {}
    };
    if (this._quietForEvaluation()) return answer(false);
    // The speech service's words so far, or the engine on this computer's
    const viaStream = msg.streamUtt != null && this._streamOn();
    const viaLocal = !viaStream && this._localSpeechOn() && typeof msg.wav === 'string' && msg.wav.length <= MAX_WAV_BASE64;
    const usable = (viaStream || viaLocal) && !this._dictationMode && !this._agentRunning && !this.examSession?.active;
    if (!usable || this._voiceBusy()) {
      const why = this._voiceBusy() ? 'busy with the last command' : !(viaStream || viaLocal) ? 'no fast speech engine' : 'dictation, a task or an exam';
      console.log(`[Voice] Early check skipped (${why})`);
      return answer(false);
    }
    const vocabulary = [...this._profile().vocabulary, NAME_WORD];
    let heard;
    try {
      heard = viaStream
        ? await this.remoteAsr.peek(msg.streamUtt, REMOTE_PEEK_WAIT_MS)
        : await this.localAsr.transcribe(msg.wav, { prompt: vocabulary.join(', ') });
    } catch { heard = {}; }
    if (viaStream && !heard.error) heard = { ...heard, text: remoteText(heard), engine: 'remote' };
    // Kept for this phrase: if nothing more is said, these are its final words (_transcribeClip)
    if (viaStream && !heard.error && heard.text) this._peekWords = { utt: msg.streamUtt, heard, at: Date.now() };
    // With "Say AbleSpeak first", a phrase without the name is left to the full clip
    const needsName = !!this._profile().listening?.needsName;
    const named = !!heard.text && (stripName(heard.text).named || Date.now() < (this._nameHeardUntil || 0));
    const nameMissing = needsName && !named && !this._pendingConfirmation && !this._sleeping && !this._dismissed;
    // With music playing, a phrase without the name is left to the full clip too
    const heldForMedia = !needsName && !!heard.text && this._heldForMedia(heard.text);
    // Why a phrase waits for the full pause, so the early check can be tuned from the log
    const waits = !heard.text ? 'no words yet'
      : nameMissing ? 'needs the name'
        : heldForMedia ? 'music playing and no name'
          : !this._isCompleteCommand(heard.text) ? 'not a complete command yet'
            : this._voiceBusy() ? 'busy with the last command' : null;
    if (waits) {
      console.log(`[Voice] Early check: "${String(heard.text || '').slice(0, 40)}" waits for the full pause (${waits})`);
      return answer(false);
    }
    answer(true);
    console.log(`[Voice] ⚡ Real time: "${heard.text}" is a command — running it at the first pause`);
    if (viaStream) this.remoteAsr.cancel(msg.streamUtt); // the rest of the clip isn't needed
    await this._onVoiceAudio(ws, {
      type: 'voice_audio', source: msg.source, audio: msg.wav || '', mimeType: 'audio/wav', wav: msg.wav, heard,
      afterVoiceMs: msg.afterVoiceMs,
    });
  }

  /** A known command that can't be the start of a longer one (real time). */
  _isCompleteCommand(text) {
    if (!this._isKnownCommand(text)) return false;
    const { named, rest } = stripName(text);
    // "AbleSpeak" alone is often followed by the command after a breath
    if (named && !rest) return false;
    if (isWakePhrase(text)) return true;
    const t = rest.toLowerCase().replace(/[.!?,]+$/, '').trim();
    if (this._pendingConfirmation && (isAffirmative(t) || isNegative(t))) return true;
    if (this._dictationMode || this._sleeping || this._dismissed) return false;
    if (/^(stop|cancel|never ?mind)$/.test(t) || SLEEP_RE.test(t)) return true;
    if (t === 'play') return false;
    const fast = matchFastCommand(t, { activeUrl: this.browserContext.activeTab?.url });
    return !!fast && EARLY_TOOLS.has(fast.tool);
  }

  /**
   * Someone is speaking and the speech service is asleep (no speech for 10
   * minutes): wake it. This phrase is heard another way meanwhile; the next
   * ones stream once it is ready (about 20 s). The voice bar only streams
   * while the service is ready, so streaming itself can't be the wake-up.
   */
  _wakeSpeechService() {
    const service = this.remoteAsr;
    if (!service?.configured || !['asleep', 'off'].includes(service.state)) return;
    if ((this._profile().listening?.speechEngine || 'auto') !== 'auto') return;
    console.log('[RemoteASR] Speech heard: waking the speech service');
    service.start();
  }

  /**
   * Whether music or a video is playing now, from Windows' media sessions.
   * Asked when speech starts and again for each phrase, while it is
   * transcribed. Windows busy (a screen read ahead of it): the last answer.
   * → { playing, apps } or null when unknown
   */
  _checkMedia() {
    if (!this._mediaSource) return Promise.resolve(null);
    if (!this._mediaCheck) {
      this._mediaCheck = Promise.resolve()
        .then(() => this._mediaSource())
        .then(state => {
          if (state) this._media = { ...state, at: Date.now() };
          return state;
        })
        .catch(() => null)
        .finally(() => { this._mediaCheck = null; });
    }
    const check = this._mediaCheck;
    return Promise.race([check, new Promise(resolve => {
      setTimeout(() => resolve(this._media), MEDIA_CHECK_WAIT_MS).unref?.();
    })]);
  }

  /** Something was playing at the last check (for live words and real time, which can't wait). */
  _mediaWasPlaying() {
    return !!this._media?.playing && Date.now() - this._media.at < MEDIA_KNOWN_MS;
  }

  /** While something plays, a phrase without the name is the song, not the person (MEDIA_COMMAND_RE). */
  _heldForMedia(text) {
    return this._mediaWasPlaying() && afterName(text) == null && !this._isCommandLike(text)
      && Date.now() >= (this._nameHeardUntil || 0);
  }

  /**
   * With music or a video playing, a phrase without the name still runs when it
   * is clearly a command: pausing, skipping, the volume, any quick command
   * ("search for Michael Jackson", "scroll down", "skip the ad"), one that
   * sounds like one, or a click. Only free talk (lyrics, a video's narration,
   * questions for the AI) needs the name. Requiring it for everything locked a
   * person out of the YouTube video they were watching (17 Oct 2026).
   */
  _isCommandLike(text) {
    if (isMediaCommand(text)) return true;
    const t = stripName(text).rest.toLowerCase().replace(/[.!?,]+$/, '').trim();
    if (!t || t.split(/\s+/).length > 8) return false;
    return this._isKnownCommand(t) || !!autocorrectCommand(t, { activeUrl: this.browserContext.activeTab?.url }) || /^(?:click|press|tap)\s+\S/.test(t);
  }

  /**
   * On YouTube, what the page says of itself: the video playing, how far in,
   * and the videos on screen with their IDs (Voqal library's youtube profile,
   * Apache-2.0). The AI opens a video by its ID instead of clicking. Never
   * holds a command up for long: no answer in 1.2 s, no YouTube section.
   */
  async _youtubeContext(activeTab) {
    if (!activeTab?.url || !onSite(activeTab.url, 'youtube.com') || !this.extensionClients.size) return null;
    const late = new Promise(resolve => { setTimeout(() => resolve(null), 1200).unref?.(); });
    let state;
    try {
      state = await Promise.race([this.sendToolToExtension('youtube', { action: 'state' }), late]);
    } catch {
      return null;
    }
    // A video playing: its sponsor parts (SponsorBlock), kept 10 minutes, so
    // only the first command for a video waits for them, and briefly
    if (state?.status === 'success' && state.page === 'watch' && state.videoId) {
      state.sponsors = await sponsorSegments(state.videoId, { timeoutMs: 600 }).catch(() => []);
    }
    return state;
  }

  /** Gmail's inbox or open email, when the student is in Gmail (never in privacy mode). */
  async _gmailContext(activeTab) {
    if (this._privacyMode || !activeTab?.url || !onSite(activeTab.url, 'mail.google.com') || !this.extensionClients.size) return null;
    const late = new Promise(resolve => { setTimeout(() => resolve(null), 1200).unref?.(); });
    try {
      return await Promise.race([this.sendToolToExtension('gmail', { action: 'state' }), late]);
    } catch {
      return null;
    }
  }

  /** The learned command for these words here, from the student's saved AI commands. */
  _learnedFor(text, where) {
    try {
      if (!this._learned || this._learnedStale) {
        this._learned = learnFrom(getRecentAiCommands(this._attribution().student_id));
        this._learnedStale = false;
      }
      return findLearned(this._learned, text, where);
    } catch {
      return null; // no database (tests) or unreadable rows: nothing learned
    }
  }

  /**
   * Shadow mode: say in the log whether the learned steps are what the AI did.
   * Learned commands act on their own only once these agree.
   */
  _compareLearned(text, learned, result) {
    const same = JSON.stringify(stepsOf(result?.toolCalls)) === JSON.stringify(learned.steps);
    this._shadow ||= { same: 0, different: 0 };
    this._shadow[same ? 'same' : 'different']++;
    console.log(`[Learn] Shadow: "${text}" would have run ${learned.steps.map(s => s.tool).join(' → ')} without the AI (learned from ${learned.successes} runs) · the AI did ${same ? 'the same ✓' : 'something else ✗'} · so far ${this._shadow.same} same, ${this._shadow.different} different`);
  }

  /**
   * "Click Play", "press Save", "tap on Sign up": when exactly one thing in
   * the window in front is called that, click it now instead of asking the AI
   * (1–3.5 s). The window in front decides where: a fast browser click once
   * landed while Spotify was in front, which is why clicks went to the AI.
   * Anything less certain still goes to the AI. → a quick command, or null
   */
  async _clickByName(text) {
    if (this._privacyMode || this._dictationMode || this.examSession?.active) return null;
    const m = String(text || '').toLowerCase().replace(/[.!?,]+$/, '').trim()
      .match(/^(?:click|press|tap)(?:\s+on)?(?:\s+the)?\s+(.+?)(?:\s+(?:button|link|icon))?$/);
    if (!m) return null;
    if (!this._frontWindow) return null;
    const front = await Promise.resolve().then(() => this._frontWindow()).catch(() => null);
    if (!front) return null;
    if (BROWSER_APPS.has(String(front.process).toLowerCase())) {
      if (!this.extensionClients.size) return null;
      const el = uniqueByName(this.browserContext.pageContext?.viewportElements, m[1], e => e.label);
      return el ? { tool: 'click_element', args: { xpath: el.xpath, label: el.label }, silent: true, byName: true } : null;
    }
    const model = await Promise.resolve().then(() => this._windowControls(front)).catch(() => null);
    if (model?.status !== 'success') return null;
    const usable = model.elements.filter(e => e.actions?.length && e.enabled !== false);
    const el = uniqueByName(usable, m[1]);
    return el ? { tool: 'uia_act', args: { ref: el.ref, app_name: front.process }, silent: true, byName: true } : null;
  }

  /**
   * "Search for X" searches inside the page when the page has its own search
   * box. Chrome's own pages (chrome://, the new tab page) can't be touched by
   * the extension, so there it becomes a Google search instead.
   */
  async _searchFallback(fastMatch, result) {
    if (fastMatch.tool !== 'search_in_page' || result?.status !== 'error') return result;
    if (!/chrome:\/\/|edge:\/\/|cannot access|cannot be scripted/i.test(result.message || '')) return result;
    console.log(`[Voice] This page can't be searched: searching Google for "${fastMatch.args.query}" instead`);
    return this.aiEngine.toolRegistry.executeTool('search_web', { query: fastMatch.args.query }, this);
  }

  /** The name alone was said: answer "Yes?". */
  _answerName(text, startTime) {
    this._markTurn('control');
    this._broadcastDashboard({ type: 'voice_transcription', text, latency: Date.now() - startTime, timestamp: new Date().toISOString() });
    this._broadcastDashboard({
      type: 'chat_assistant_message', id: uuidv4(), text: 'Yes?', error: false,
      provider: 'fast', model: 'name', source: 'voice', timestamp: new Date().toISOString(),
    });
    this._lastTTSText = 'Yes?';
    this._lastTTSTime = Date.now();
  }

  /** Speech recognition on this computer is in use for the person using it. */
  _localSpeechOn() {
    return !!this.localAsr?.ready && (this._profile().listening?.speechEngine || 'auto') !== 'online';
  }

  /** Listening settings, whether the overlay also sends 16 kHz audio for
   *  local-asr.js (or for the voice check), and whether it streams it to the speech service. */
  _listeningForOverlay() {
    return {
      ...listeningSettings(this._profile()),
      localSpeech: this._localSpeechOn(),
      speechStream: this._streamOn(),
      voiceCheck: !!this.voiceProfile?.measuring(),
    };
  }

  /** Speech is streamed to the speech service for the person using the computer. Exams keep Gemini. */
  _streamOn() {
    return !!this.remoteAsr?.ready && (this._profile().listening?.speechEngine || 'auto') === 'auto'
      && !this.examSession?.active;
  }

  /** The voice bar heard speech start: stream it, with this person's own words as hints. */
  _onStreamStart(msg) {
    this._checkMedia(); // ready by the time the phrase ends
    this._prefetchScreen(msg.utt ?? null);
    if (!this._streamOn() || msg.utt == null) return;
    this.remoteAsr.beginUtterance(msg.utt, [...this._profile().vocabulary, NAME_WORD].join(', '));
  }

  /** Live words in the voice bar while the person speaks (never read out). */
  _showPartial(utt, text) {
    if (!text || this._sleeping || this._dismissed || this.examSession?.active) return;
    const needsName = !!this._profile().listening?.needsName;
    const waitingForName = needsName && !this._dictationMode && !this._pendingConfirmation
      && Date.now() >= (this._nameHeardUntil || 0);
    if (waitingForName && !stripName(text).named) return; // other people's talk isn't shown
    if (!needsName && !this._dictationMode && !this._pendingConfirmation && this._heldForMedia(text)) return; // nor the song's words
    this._broadcastDashboard({ type: 'voice_partial', utt, text, timestamp: new Date().toISOString() });
  }

  /**
   * A phrase AbleSpeak can act on from the local words alone: a quick command,
   * a shortcut, stop, sleep, a wake phrase, or the answer to a yes/no question.
   * Anything else (questions, typing, Swahili) is checked with Gemini.
   */
  _isKnownCommand(text) {
    if (isWakePhrase(text)) return true;
    const t = stripName(text).rest.toLowerCase().replace(/[.!?,]+$/, '').trim();
    if (!t) return false;
    if (this._pendingConfirmation && (isAffirmative(t) || isNegative(t))) return true;
    if (this._dictationMode) return DICTATION_END_RE.test(t) || !!matchDictationPrefixCommand(text);
    if (this._sleeping || this._dismissed) return false;
    // "Stop", "cancel that": short. "Cancel my meeting with…" is checked with Gemini.
    if ((STOP_RE.test(t) && t.split(/\s+/).length <= 3) || SLEEP_RE.test(t)) return true;
    const profile = this._profile();
    if (expandAlias(profile, t) || findMacro(profile, t)) return true;
    return !!matchFastCommand(t, { activeUrl: this.browserContext.activeTab?.url });
  }

  /**
   * The words in one clip. With speech recognition on this computer
   * (listening.speechEngine 'auto'), a known command runs on the local words
   * at once: no wait on the internet and no Gemini request. Anything else goes
   * to Gemini. Dictation asks both at once, and types the local words when
   * Gemini is slow or offline.
   * 'local' never uses the internet; 'online' is Gemini alone, as before.
   */
  async _transcribeClip(msg, vocabulary = []) {
    // Gemini is told to stop once the words heard here are used instead
    const gemini = new AbortController();
    // With its tokens, for the Speed tab's cost
    const online = () => this.voiceHandler.transcribe(msg.audio, msg.mimeType || 'audio/webm', { vocabulary, signal: gemini.signal })
      .then(result => (result && this.voiceHandler.lastUsage ? { ...result, usage: this.voiceHandler.lastUsage } : result));
    const fromLocal = heard => {
      gemini.abort();
      const remote = heard.engine === 'remote';
      console.log(`[Voice] ${remote ? '☁️ Heard by the speech service' : '🖥️ Heard on this computer'} in ${heard.ms} ms: "${heard.text}"`);
      return { text: heard.text, engine: remote ? 'remote' : 'local' };
    };
    // Already heard: a real-time check that was a command
    if (msg.heard?.text) return fromLocal(msg.heard);
    const mode = this._profile().listening?.speechEngine || 'auto';

    // Real time: the words were streamed to the speech service as they were said
    if (msg.streamUtt != null && this.remoteAsr && mode === 'auto') {
      // Nothing was said after the early check (no voice-level sound at all):
      // its words are the whole phrase, and the same audio isn't heard again
      // (that took ~0.55 s, up to 2.7 s)
      const early = this._peekWords;
      this._peekWords = null;
      if (msg.wordsAtPeek === true && early?.utt === msg.streamUtt && early.heard?.text) {
        this.remoteAsr.cancel(msg.streamUtt);
        gemini.abort();
        console.log(`[Voice] ☁️ Heard at the early check, nothing said after it: "${early.heard.text}"`);
        return { text: early.heard.text, engine: 'remote' };
      }
      const heard = await this.remoteAsr.finish(msg.streamUtt, REMOTE_FINAL_WAIT_MS * (this._dictationMode ? 2 : 1));
      if (!heard.error) {
        gemini.abort();
        const text = remoteText(heard);
        console.log(`[Voice] ☁️ Heard by the speech service, ${heard.waitedMs} ms after the end of speech (GPU ${heard.ms} ms): "${text}"`);
        return text ? { text, engine: 'remote' } : { text: '', error: 'no_speech' };
      }
      console.warn(`[Voice] The speech service didn't answer (${heard.error}): hearing the clip another way`);
    }
    const wav = typeof msg.wav === 'string' && msg.wav.length <= MAX_WAV_BASE64 ? msg.wav : null;
    const localReady = !!this.localAsr?.ready && !!wav;
    // "This computer only" is a promise that speech never leaves the computer:
    // when the engine can't hear it, say so instead of asking Gemini.
    if (mode === 'local' && !localReady) {
      console.warn(`[Voice] Speech on this computer only, but it isn't ready (${this.localAsr?.state || 'no engine'}${wav ? '' : ', no WAV in the clip'})`);
      return { text: '', error: 'local_failed', message: LOCAL_UNAVAILABLE };
    }
    if (mode === 'online' || !localReady) return online();

    const onlineJob = this._dictationMode && mode === 'auto' ? online() : null;
    onlineJob?.catch(() => {}); // it may not be needed; an unwanted failure isn't an error
    let heard;
    try {
      heard = await this.localAsr.transcribe(wav, { prompt: vocabulary.join(', ') });
    } catch (err) {
      heard = { error: err.message };
    }
    if (heard.error) console.warn(`[Voice] Speech recognition on this computer failed: ${heard.error}`);

    if (mode === 'local') {
      if (heard.error) return { text: '', error: 'local_failed', message: LOCAL_UNAVAILABLE };
      return heard.text ? fromLocal(heard) : { text: '', error: 'no_speech' };
    }
    if (heard.text && this._isKnownCommand(heard.text)) return fromLocal(heard);
    // Asleep or hidden, only a wake phrase matters, and that is a known
    // command: room talk is not sent to Gemini, and "wake up" isn't kept waiting.
    if ((this._sleeping || this._dismissed) && !heard.error) {
      return heard.text ? fromLocal(heard) : { text: '', error: 'no_speech' };
    }
    const job = onlineJob || online();
    // Only dictation falls back to the words heard here. Anything else that
    // isn't a known command goes to the AI, which needs the internet anyway,
    // and the local words for room talk ("but it a quite a") must never
    // reach it as a command (seen live, 15 Oct 2026, with Gemini slow).
    if (!heard.text || !this._dictationMode) return job;
    let timer;
    const waited = new Promise(resolve => { timer = setTimeout(resolve, DICTATION_ONLINE_WAIT_MS, null); });
    const result = await Promise.race([job, waited]);
    clearTimeout(timer);
    if (result && (!result.error || result.error === 'no_speech')) return result;
    console.warn(`[Voice] Gemini ${result ? `failed (${result.error})` : 'was too slow'}: using the words heard on this computer`);
    return fromLocal(heard);
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

  /**
   * A clip said during an exam: transcribed word for word (exam: true) and
   * handed to the exam. A clip that cannot be understood is said to be so,
   * so the student knows to say it again; nothing is ever dropped quietly.
   */
  async _examVoice(ws, msg, startTime) {
    const transcript = await this.voiceHandler.transcribe(msg.audio, msg.mimeType || 'audio/webm', {
      vocabulary: this._profile().vocabulary,
      exam: true,
    });
    const runner = this.examSession.current?.runner;
    const done = (action, text = null) => this._broadcastDashboard({ type: 'exam_heard', text, action, timestamp: new Date().toISOString() });

    if (transcript.error === 'no_speech' && !transcript.filtered) {
      this._markTurn('no_speech');
      ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
      return;
    }
    if (transcript.error) {
      this._markTurn(transcript.error === 'offline' ? 'offline' : 'error');
      const said = transcript.error === 'offline'
        ? 'I cannot hear answers right now, because the internet connection is down. Your answers so far are saved. Please tell your invigilator.'
        : 'I did not catch that clearly. Please say it again.';
      runner?.say(said, transcript.error === 'offline' ? 'offline' : 'not_heard');
      done(transcript.error === 'offline' ? 'offline' : 'not_heard');
      return;
    }
    if (this._turnLog) this._turnLog.transcript = transcript.text;
    this._broadcastDashboard({ type: 'voice_transcription', text: transcript.text, latency: Date.now() - startTime, timestamp: new Date().toISOString() });
    this._markTurn('exam');
    const result = this.examSession.heard(transcript.text);
    done(result?.action || null, transcript.text);
  }

  /** Transcribe one clip, then type it (dictation) or run it as a command. */
  async _processVoiceAudio(ws, msg) {
    const startTime = Date.now();
    console.log(`[Voice] Received audio (${Math.round(msg.audio.length / 1024)}KB)`);
    // A screen read from another phrase isn't this one's
    const pre = this._screenPrefetch;
    if (pre && msg.streamUtt != null && pre.utt != null && pre.utt !== msg.streamUtt) this._screenPrefetch = null;

    // An exam is running: what the student says goes to the exam and nowhere
    // else — no AI, no quick commands, no filters that could drop an answer.
    if (this.examSession?.active) {
      await this._examVoice(ws, msg, startTime);
      return;
    }

    // Someone is setting up their voice on the Voice & words page: the phrases
    // they read ("Close this window") are not commands. Not even sent to be heard.
    if (this.voiceProfile?.holding()) {
      console.log('[Voice] A voice is being set up on the dashboard: not acting on this');
      this._markTurn('filtered');
      ws.send(JSON.stringify({ type: 'voice_no_speech', reason: 'enrolling', timestamp: new Date().toISOString() }));
      return;
    }
    // Who it sounds like, while it is being heard. Measuring only: nothing is ignored because of it.
    this._checkSpeaker(msg);

    // Transcribe (on this computer and/or with Gemini), expecting this
    // student's own words and AbleSpeak's own name, always, so it is written
    // right ("I will speak" was heard for it)
    const needsName = !!this._profile().listening?.needsName;
    // Whether music is playing is asked while the clip is transcribed
    const mediaCheck = !needsName && !this._dictationMode ? this._checkMedia() : Promise.resolve(null);
    const transcript = await this._transcribeClip(msg, [...this._profile().vocabulary, NAME_WORD]);
    const { error } = transcript;
    let text = transcript.text;
    if (this._turnLog) {
      this._turnLog.heardAt = Date.now();
      this._turnLog.hearEngine = transcript.engine || 'gemini';
      if (transcript.usage) this._turnLog.hearUsage = transcript.usage;
    }

    if (error === 'no_speech') {
      this._markTurn('no_speech');
      ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
      return;
    }
    if (error) {
      this._markTurn(error === 'offline' ? 'offline' : 'error');
      ws.send(JSON.stringify({
        type: 'voice_error', error,
        ...(transcript.message ? { message: transcript.message } : {}),
        timestamp: new Date().toISOString(),
      }));
      return;
    }
    if (this._turnLog) this._turnLog.transcript = text;

    // ── "Say AbleSpeak first" (noisy places, wake-name.js) ──
    // Only phrases that start with the name are acted on; other people, TV
    // and music are dropped quietly, before anything is shown. Dictated text
    // and the answer to a yes/no question need no name.
    // Asleep or hidden, a wake phrase always gets through ("Wake up, AbleSpeak"
    // has the name at the end). Awake, just the name still answers "Yes?".
    const waking = (this._sleeping || this._dismissed) && isWakePhrase(text);
    const answersName = !this._dictationMode && !this._pendingConfirmation && !waking;
    if (!needsName && answersName && !this._sleeping && !this._dismissed) {
      // Just the name, with "Say AbleSpeak first" off: still "Yes?", not a question for the AI
      const { named, rest } = stripName(text);
      if (named && !rest) {
        this._nameHeardUntil = Date.now() + NAME_WINDOW_MS; // with music playing, the next phrase needs no name
        this._answerName(text, startTime);
        return;
      }
    }
    if (needsName && answersName) {
      const gate = gateByName(text, { inWindow: Date.now() < (this._nameHeardUntil || 0) });
      if (gate.action === 'ignore') {
        console.log(`[Voice] 🔇 Not for AbleSpeak (no name): "${text.slice(0, 50)}"`);
        this._markTurn('filtered');
        ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
        return;
      }
      this._nameHeardUntil = 0;
      if (gate.action === 'listen') {
        // Just the name: "Yes?" — the next phrase needs no name
        this._nameHeardUntil = Date.now() + NAME_WINDOW_MS;
        this._answerName(text, startTime);
        return;
      }
      text = gate.text;
    }

    // ── Music or a video playing (_isCommandLike) ──
    // Free talk without the name is the song or the video, dropped quietly.
    // Commands still work without it ("pause", "skip the ad", "search for…").
    // The name counts anywhere in the phrase, since the recording may start on the song.
    if (!needsName && answersName && !this._sleeping && !this._dismissed) {
      const media = await mediaCheck;
      if (media?.playing) {
        const said = afterName(text);
        if (said === '') {
          // The name last, after the song's words: "Yes?", and the next phrase needs no name
          this._nameHeardUntil = Date.now() + NAME_WINDOW_MS;
          this._answerName(text, startTime);
          return;
        }
        if (said || Date.now() < (this._nameHeardUntil || 0)) {
          this._nameHeardUntil = 0;
          text = said || text;
        } else if (!this._isCommandLike(text)) {
          console.log(`[Voice] 🔇 ${media.apps.join(' and ')} playing — not for AbleSpeak (no name): "${text.slice(0, 50)}"`);
          this._markTurn('filtered');
          ws.send(JSON.stringify({ type: 'voice_no_speech', reason: 'media', timestamp: new Date().toISOString() }));
          return;
        }
      }
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
    // Pauses whatever is playing in ANY app (Spotify, Chrome, VLC…) through
    // Windows' media controls, which only ever pause, never start. A browser
    // tab Windows doesn't list falls back to the extension. The person is told
    // what was paused, and it counts as a command on their progress.
    // Not while a yes/no question waits: "no, stop" is its answer, a no.
    // ────────────────────────────────────────────
    if (!this._dictationMode && !this._pendingConfirmation) {
      const lowerForEscape = text.toLowerCase().trim();
      const wordCount = lowerForEscape.split(/\s+/).length;
      // "Pos", "Pose", "pose the song" are how "pause" has come out
      const escapeMatch = lowerForEscape.match(/\b(pause|pose(?= (?:the )?(?:song|music|track|video)\b)|stop|mute|shut up|quiet|silence|hush)\b/)
        || lowerForEscape.match(/^(pose?)[\s.!?,]*$/);

      if (escapeMatch && wordCount <= 6) {
        console.log(`[Voice] 🚨 Escape command: "${escapeMatch[1]}" in "${text.slice(0, 60)}"`);
        let paused;
        try {
          const { pauseAllMedia } = await import('./system-tools.js');
          paused = await pauseAllMedia();
        } catch (err) {
          paused = { status: 'error', message: err.message };
        }
        if (paused.status === 'error') console.warn('[Voice] Windows media pause failed:', paused.message);

        let reply;
        if (paused.status === 'success') {
          reply = `Paused ${paused.apps.join(' and ')}.`;
        } else {
          let tab = null;
          try { tab = await this.aiEngine.toolRegistry.executeTool('media_control', { action: 'pause' }, this); } catch {}
          reply = tab?.status === 'success' ? 'Paused.'
            : paused.status === 'none' ? 'Nothing is playing.'
            : "I couldn't pause the music.";
        }
        console.log(`[Voice] Escape result: ${reply}`);
        const failed = reply.startsWith("I couldn't");
        const commandId = uuidv4();
        this._markTurn('control');
        this._recordVoiceCommand({
          id: commandId, type: 'voice_fast', text,
          payload: { text, fastTool: 'pause_media', source: 'microphone' },
          result: { status: failed ? 'error' : 'success', message: reply },
          latency_ms: Date.now() - startTime, failed,
        });
        this._broadcastDashboard({
          type: 'chat_assistant_message', id: commandId, text: reply, error: failed,
          provider: 'fast', model: 'pattern-match', latency: Date.now() - startTime,
          source: 'voice', timestamp: new Date().toISOString(),
        });
        this._lastTTSText = reply; // the echo guard ignores the mic hearing this
        this._lastTTSTime = Date.now();
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
    // The voice bar says how long after AbleSpeak's voice the clip began: one
    // that began later can't hold it, so the person repeating AbleSpeak's own
    // words ("play the current song", three times) is heard.
    // ────────────────────────────────────────────
    // Whatever the timing says, a long stretch of AbleSpeak's last answer, word
    // for word and in order, is its own voice: a person repeating a command is
    // brief (an answer cut off mid-way was taken as a command, 17 Oct 2026)
    const recentVoice = this._lastTTSText && (Date.now() - this._lastTTSTime) < 30000;
    if (!this._dictationMode && recentVoice && text.split(/\s+/).length >= 8 && isEchoOf(text, this._lastTTSText)) {
      console.log(`[Voice] 🔇 Echo detected (AbleSpeak's last answer, word for word) — "${text.slice(0, 60)}"`);
      this._markTurn('filtered');
      ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
      return;
    }
    const mayHoldVoice = typeof msg.afterVoiceMs !== 'number' || msg.afterVoiceMs < ECHO_RECENT_MS;
    if (!this._dictationMode && mayHoldVoice && recentVoice) {
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
    // During an exam only the student's voice answers it; nothing typed elsewhere reaches it.
    if (this.examSession?.active) {
      if (typed) {
        this._broadcastDashboard({
          type: 'chat_assistant_message', id: uuidv4(), error: true, toolCalls: [],
          text: 'An exam is running on this computer, so AbleSpeak only takes the student\'s spoken answers until it ends.',
          provider: 'exam', model: 'exam', source: 'chat', timestamp: new Date().toISOString(),
        });
      } else {
        this._markTurn('exam');
        const result = this.examSession.heard(text);
        this._broadcastDashboard({ type: 'exam_heard', text, action: result?.action || null, timestamp: new Date().toISOString() });
      }
      return;
    }

    // "AbleSpeak, scroll down" is "scroll down": the name in front used to send
    // it past the quick commands to the AI, seconds slower. Not while dictating,
    // where "AbleSpeak, …" is how a command is given (matchDictationPrefixCommand).
    // Just the name is left as it is, for waking and "Yes?".
    if (!this._dictationMode) {
      const { named, rest } = stripName(text);
      if (named && rest) text = rest;
    }

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
      if (DICTATION_END_RE.test(tLower)) {
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
        // Autocorrected (Gemini), then punctuation words to punctuation (typed text is kept as it is)
        const typedText = typed ? text : this._processDictationText(await this._cleanDictation(text));
        if (!typedText.trim()) return;
        this._dictationTyped = `${this._dictationTyped || ''}${typedText}`.slice(-600);

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
    let fastMatch = matchFastCommand(text, { activeUrl: this.browserContext.activeTab?.url });
    // Sounds like a known command ("pose the song", "close this tub"): run that,
    // and show it on the voice bar as what was understood
    if (!fastMatch && !typed) {
      const activeUrl = this.browserContext.activeTab?.url;
      const guess = autocorrectCommand(text, { activeUrl });
      // Only a correction that runs here is taken: otherwise the AI hears what was said, not the guess
      const corrected = guess && matchFastCommand(guess.phrase, { activeUrl });
      if (corrected) {
        console.log(`[Voice] ✨ Understood "${text}" as "${guess.phrase}"`);
        this._broadcastDashboard({ type: 'voice_transcription', text: guess.phrase, heard: text, corrected: true, timestamp: new Date().toISOString() });
        text = guess.phrase;
        fastMatch = corrected;
      }
    }
    fastMatch ||= await this._clickByName(text);

    // `quick:` lets a click by name that didn't work leave for the AI path below
    quick: if (fastMatch) {
      console.log(`[Voice] ⚡ Fast match: ${fastMatch.tool}(${JSON.stringify(fastMatch.args)})${fastMatch.byName ? ' (click by name)' : ''}`);

      // Special handling: dictation mode toggle (not a real tool)
      if (fastMatch.tool === 'dictation_mode') {
        this._dictationMode = fastMatch.args.enabled;
        this._dictationTyped = ''; // a new dictation: earlier text isn't its context
        console.log(`[Voice] ✏️ Dictation mode ${this._dictationMode ? 'ON' : 'OFF'}`);

        // Capture/clear the target window HWND
        let target = null;
        if (this._dictationMode) {
          try {
            const { captureDictationTarget } = await import('./system-tools.js');
            target = await captureDictationTarget();
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
          // Say where the words will go, so a wrong window is caught at once.
          say: this._dictationMode
            ? (spokenWindowName(target?.title) ? `Dictation mode on. Typing into ${spokenWindowName(target.title)}.` : 'Dictation mode on.')
            : 'Dictation mode off. Back to commands.',
          ...(this._dictationMode && target?.title ? { target: target.title, targetName: spokenWindowName(target.title) || '' } : {}),
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

      const toolResult = await this._searchFallback(fastMatch, await this.aiEngine.toolRegistry.executeTool(fastMatch.tool, fastMatch.args, this));
      const latency = Date.now() - startTime;

      // Clicked by name and it didn't work: the AI looks closer, as it always did
      if (fastMatch.byName && toolFailed(toolResult)) {
        console.log(`[Voice] ⚡ Click by name didn't work (${toolResult?.message || toolResult?.error || 'no reason'}): asking the AI`);
        break quick;
      }

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
      // A web answer joins the conversation, so a follow-up question knows who "he" is
      if (fastMatch.tool === 'web_answer' && !toolFailed(toolResult)) this.aiEngine.rememberExchange?.(text, toolResult.text);

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
      this._screenPrefetch = null; // the screen may have changed: the next phrase reads it afresh
      return;
    }

    // ────────────────────────────────────────────
    // FULL AI PATH: Complex commands go to LLM
    // ────────────────────────────────────────────
    const systemContext = getFullSystemContext();

    // A desktop screenshot only if the voice bar sent one. Privacy mode disables
    // ALL screen capture — voice control still works. The browser tab is not
    // captured here: that request held every AI command for up to 3 seconds,
    // and its answer (an object, not the string this expected) was never used —
    // the AI reads the page's elements and the window's controls instead.
    if (this._privacyMode) screenshot = null;

    // The window's controls and, on YouTube or Gmail, the page's own account of itself, together
    const lookStarted = Date.now();
    const [screenModel, youtube, gmail] = await Promise.all([
      this._screenForAgent(),
      this._youtubeContext(this.browserContext.activeTab),
      this._gmailContext(this.browserContext.activeTab),
    ]);
    if (this._turnLog) this._turnLog.lookMs = Date.now() - lookStarted;
    const context = {
      tabs: this.browserContext.tabs || [],
      activeTab: this.browserContext.activeTab || null,
      pageContext: this.browserContext.pageContext || null,
      extensionConnected: this.extensionClients.size > 0,
      currentTime: new Date().toLocaleString(),
      computerInfo: systemContext.computerInfo,
      visibleApplications: systemContext.visibleApplications,
      screenshot,
      screenModel,
      youtube,
      gmail,
    };

    if (needsPlan(text)) {
      await this._runTask(text, context, { commandId, startTime });
      return;
    }
    // Where it was said: the app in front, or the site when the browser is in front
    const front = context.screenModel?.app
      ? { app: context.screenModel.app, window: context.screenModel.window || null }
      : null;
    const site = !front && context.activeTab?.url ? siteOf(context.activeTab.url) : null;
    // Learned commands, in shadow mode: what would have run without the AI
    const learned = this._learnedFor(text, { front, site });

    const result = await this.aiEngine.processChat(text, context);
    // Paid for even when the AI decides it wasn't for AbleSpeak
    if (this._turnLog && result.usage?.calls) this._turnLog.think = result.usage;
    // What the AI did, so "undo that" takes back its last action, not an older one
    for (const call of result.toolCalls || []) {
      const tool = call.tool || call.name;
      const readOnly = READ_ONLY_STEPS.has(tool) || (tool === 'uia_act' && call.args?.action === 'read_text');
      if (!readOnly && !toolFailed(call.result)) this._recordAction({ tool, args: call.args || {}, result: call.result });
    }
    if (learned) this._compareLearned(text, learned, result);

    // The AI judged it wasn't said to AbleSpeak (lyrics, a video, other people):
    // quiet, as with music or room talk, not "could you rephrase it?"
    const ignored = !typed && result.toolCalls?.find(c => (c.tool || c.name) === 'ignore');
    if (ignored) {
      console.log(`[Voice] 🔇 Not for AbleSpeak (the AI's call): "${text.slice(0, 60)}"${ignored.result?.reason ? ` — ${ignored.result.reason}` : ''}`);
      this._markTurn('filtered');
      ws.send(JSON.stringify({ type: 'voice_no_speech', timestamp: new Date().toISOString() }));
      return;
    }

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

    // Where it was said, with each action's arguments (ai-engine.js): enough
    // to learn this command (learned-commands.js) and replay it later
    this._recordVoiceCommand({
      id: commandId,
      type: 'voice',
      text,
      payload: {
        text, source: typed ? 'chat' : 'microphone',
        ...(front ? { front } : {}),
        ...(site ? { site } : {}),
      },
      result,
      latency_ms: result.latency || 0,
      failed: aiCommandFailed(result),
    });

    this._broadcastDashboard({
      type: 'chat_assistant_message',
      id: commandId,
      text: result.text,
      // Every action failed: the overlay shows "Didn't work" and says why, not "Done"
      error: result.error || (Array.isArray(result.toolCalls) && result.toolCalls.length > 0
        && result.toolCalls.every(call => toolFailed(call.result))) || false,
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

  /** Wait up to `ms` for the browser extension to connect (it reconnects within ~2 s). */
  _waitForExtension(ms) {
    if (this.extensionClients.size > 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const started = Date.now();
      const check = setInterval(() => {
        if (this.extensionClients.size > 0 || Date.now() - started >= ms) {
          clearInterval(check);
          resolve(this.extensionClients.size > 0);
        }
      }, 100);
    });
  }

  async sendToolToExtension(type, payload) {
    // Just after AbleSpeak or the browser restarts, the extension is a second
    // or two from reconnecting: wait for it rather than fail at once.
    if (this.extensionClients.size === 0) await this._waitForExtension(EXTENSION_GRACE_MS);
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

      // The (only) connected extension; the command is tied to that connection
      const ext = [...this.extensionClients].at(-1);
      this.pendingToolCalls.set(callId, {
        resolve: (result) => {
          console.log(`[WsHub] ← Extension response for ${type}: ${JSON.stringify(result).substring(0, 200)}`);
          resolve(result);
        },
        reject,
        timeout,
        socket: ext,
      });

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
    if (message?.type === 'chat_assistant_message' && message.text && !message.silent) {
      // A reply the voice bar will say: the Speed tab waits for its first sound
      if (this._turnLog) this._turnLog.replied = true;
      // ...and the echo guard knows it, whichever path said it (a quick
      // command's answer can be long: a web answer is 2–4 sentences)
      this._lastTTSText = message.text;
      this._lastTTSTime = Date.now();
    }
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
      if (isWakePhrase(rawText)) {
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
      if (isWakePhrase(rawText)) {
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

    // ── A question is waiting for yes or no ("Close this window?"): what was
    // said answers it (_resolvePendingConfirmation), so "stop", "cancel" and
    // "go to sleep" are a no. Taken as controls here, they left the question
    // waiting and the next "okay…" ran it (test script SF-05). ──
    if (this._pendingConfirmation) return false;

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
    if (SLEEP_RE.test(t)) {
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
    // The microphone heard the question itself ("…yes to confirm or anything
    // else to cancel"): keep waiting for the student's own answer.
    if (isEchoOf(text, this._pendingConfirmation.prompt)) {
      console.log(`[Voice] 🔇 Heard our own question back — still waiting for yes or no: "${text.slice(0, 60)}"`);
      this._markTurn('filtered');
      this._broadcastDashboard({ type: 'voice_no_speech', timestamp: new Date().toISOString() });
      return true;
    }
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
    if (this._turnLog) {
      // Done now: the Speed tab's "whole command", by the AI or without it
      const log = this._turnLog;
      log.commandId = id;
      log.doneAt = Date.now();
      log.failed = !!failed;
      if (result?.usage?.calls && !log.think) log.think = result.usage;
      log.path = log.think ? 'ai' : 'quick';
      log.tool = payload?.fastTool || result?.toolCalls?.map(c => c.tool || c.name).filter(Boolean).join(', ') || null;
    }
    this._learnedStale = true; // a new AI command, a retry or a failure can change what is learned
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
    this._learnedStale = true; // an undone command is no longer one to learn from
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

  /**
   * Undo the most recent action: its own way back when it gave one (Notepad's
   * old text), go_back for navigation, Ctrl+Z otherwise.
   */
  async _undoLast() {
    const last = this._actionHistory[this._actionHistory.length - 1];
    try {
      if (last?.result?.undo?.tool) {
        this._actionHistory.pop(); // taken back: a second "undo" goes further back
        const undone = await this.aiEngine.toolRegistry.executeTool(last.result.undo.tool, last.result.undo.args || {}, this, { confirmed: true });
        return !toolFailed(undone);
      }
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
    const fast = matchFastCommand(text, { activeUrl: this.browserContext.activeTab?.url });
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
  /**
   * Dictation autocorrect (listening.cleanUpDictation, on unless switched off):
   * the words corrected by Gemini before they are typed, with what was typed
   * just before as context. Very short phrases, exams and failures: as heard.
   */
  async _cleanDictation(heard) {
    const listening = this._profile().listening || {};
    if (listening.cleanUpDictation === false || this.examSession?.active || !this.aiEngine?.cleanDictation) return heard;
    if (String(heard).trim().split(/\s+/).length < 3) return heard;
    const result = await this.aiEngine.cleanDictation(heard, { before: this._dictationTyped || '', vocabulary: this._profile().vocabulary || [] });
    if (this._turnLog && result.usage) this._turnLog.clean = result.usage;
    if (result.changed) console.log(`[Voice] ✏️ Autocorrected in ${result.ms} ms: "${heard}" → "${result.text}"`);
    else if (result.ms > 0) console.log(`[Voice] ✏️ Dictation checked in ${result.ms} ms: no change`);
    return result.text;
  }

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
