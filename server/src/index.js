import 'dotenv/config';
import express from 'express';

// Keep the server alive on unhandled errors — log them, never exit.
process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception (server kept alive):', err?.message, err?.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] Unhandled rejection (server kept alive):', reason?.message ?? reason);
});
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { getFullSystemContext } from './system-info.js';
import { VoiceHandler } from './voice-handler.js';

import { initDatabase } from './db.js';
import { AIEngine } from './ai-engine.js';
import { ToolRegistry } from './tool-registry.js';
import { WsProxy } from './ws-proxy.js';
import { LogTailer } from './log-tailer.js';
import { LibraryScanner } from './library-scanner.js';
import { createApiRouter } from './routes/api.js';
import { startProbeScheduler, stopProbeScheduler } from './probe-computer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ──
const PORT = parseInt(process.env.GATEWAY_PORT || '3001');
const VOQAL_HOME = process.env.VOQAL_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.voqal');
// In packaged Electron, __dirname is inside the read-only asar archive.
// Use the app's userData directory for writable files like the database.
const isPackaged = typeof process.resourcesPath === 'string' && !process.resourcesPath.includes('node_modules');
const DB_PATH = process.env.DB_PATH || (isPackaged
  ? join(process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'AbleSpeak', 'data', 'ablespeak.db')
  : join(__dirname, '..', 'data', 'ablespeak.db'));

console.log('╔══════════════════════════════════════╗');
console.log('║     AbleSpeak AI Agent v2.0.0        ║');
console.log('║  Standalone Voice Command Center     ║');
console.log('╚══════════════════════════════════════╝');
console.log(`  LLM:         ${process.env.LLM_PROVIDER || 'openai'} / ${process.env.LLM_MODEL || 'auto'}`);
console.log(`  Voqal Home:  ${VOQAL_HOME}`);
console.log(`  Database:    ${DB_PATH}`);
console.log(`  Port:        ${PORT}`);
console.log('');

// ── Initialize Database ──
await initDatabase(DB_PATH);
console.log('[DB] SQLite initialized');

// ── Express App ──
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Large enough for long voice recordings
app.use(rateLimit({ windowMs: 60000, max: 300 }));

// ── HTTP Server (shared with WebSocket) ──
const server = createServer(app);

// ── AI Engine ──
const toolRegistry = new ToolRegistry();
console.log(`[Tools] ${toolRegistry.listTools().length} tools registered`);

// AIEngine needs wsHub, but wsHub needs aiEngine — use lazy init
const aiEngine = new AIEngine({ toolRegistry, wsHub: null });

// ── WS shared-secret token (EXT-2) ──
// ABLESPEAK_WS_TOKEN used to be unset out of the box, so ANY other local
// process could open the extension/dashboard WebSocket and drive the browser
// or system tools with zero authentication — the loopback+origin lock only
// stops remote/web attackers, not a second process on the same machine.
// Auto-generate one on first run and persist it next to the database so it
// survives restarts (the extension caches whatever it's given — a token that
// changed every launch would break the connection, not secure it).
const WS_TOKEN_PATH = join(VOQAL_HOME, 'ws-token.txt');
function resolveWsToken() {
  if (process.env.ABLESPEAK_WS_TOKEN) return process.env.ABLESPEAK_WS_TOKEN;
  try {
    const existing = existsSync(WS_TOKEN_PATH) ? readFileSync(WS_TOKEN_PATH, 'utf8').trim() : '';
    if (existing) return existing;
  } catch (err) {
    console.warn('[WsHub] Could not read persisted WS token:', err.message);
  }
  const generated = randomBytes(24).toString('hex');
  try {
    mkdirSync(VOQAL_HOME, { recursive: true });
    writeFileSync(WS_TOKEN_PATH, generated);
  } catch (err) {
    console.error('[WsHub] Could not persist WS token — it will change on next restart:', err.message);
  }
  return generated;
}
const wsToken = resolveWsToken();

// ── WebSocket Hub (standalone — no Voqal) ──
const wsProxy = new WsProxy({ server, aiEngine, wsToken });
aiEngine.wsHub = wsProxy; // Back-reference
console.log('[WsHub] Initialized (standalone mode)');

// ── Broadcast console output to dashboard Logs page ──
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
let _broadcasting = false; // Re-entrancy guard (perf fix #4)

function broadcastLog(level, args) {
  if (_broadcasting) return; // Prevent infinite loop: broadcast → log → broadcast
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  // Skip CLIXML noise from PowerShell
  if (message.includes('CLIXML') || message.includes('Preparing modules')) return;
  _broadcasting = true;
  try {
    wsProxy._broadcastDashboard({
      type: 'log_event',
      event: { level, message, timestamp: new Date().toLocaleTimeString() },
      timestamp: new Date().toISOString()
    });
  } catch {}
  _broadcasting = false;
}

console.log = (...args) => { _origLog(...args); broadcastLog('INFO', args); };
console.warn = (...args) => { _origWarn(...args); broadcastLog('WARN', args); };
console.error = (...args) => { _origError(...args); broadcastLog('ERROR', args); };

// ── Library Scanner ──
const libraryPath = join(VOQAL_HOME, 'library');
const libraryScanner = new LibraryScanner(libraryPath);
console.log('[Library] Scanner initialized for', libraryPath);

// ── Log Tailer ──
const logFilePath = join(VOQAL_HOME, 'voqal.log');
const logTailer = new LogTailer({
  logFilePath,
  wsProxy,
  onEvent: (event) => {
    if (event.level !== 'DEBUG') {
      wsProxy._broadcastDashboard({ type: 'log_event', event, timestamp: new Date().toISOString() });
    }
  },
  onHealthChange: (health) => {
    wsProxy._broadcastDashboard({ type: 'health_change', ...health });
  }
});
logTailer.start().then(() => console.log('[LogTailer] Started'));

// ── API Routes ──
app.use('/api', createApiRouter({ wsProxy, logTailer, libraryScanner, voqalHomePath: VOQAL_HOME, aiEngine }));

// GET /api/ws-token — lets the Chrome extension bootstrap the WS token (EXT-2)
// with no manual pairing step. This hands out the shared secret that gates the
// WS control plane, so it must never be reachable over the network — server.listen()
// below binds all interfaces, unlike the WS upgrade handler's own loopback
// check, so that same check is enforced here explicitly rather than relying
// on cors()/helmet() (which don't restrict by IP) or on SEC-2's broader /api
// auth work landing first.
app.get('/api/ws-token', (req, res) => {
  const ra = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (ra !== '127.0.0.1' && ra !== '::1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ token: wsProxy._wsToken });
});

// ── Additional AI-specific API routes ──

// GET /api/ai/status — current LLM provider and model
app.get('/api/ai/status', (req, res) => res.json(aiEngine.getStatus()));

// GET /api/ai/providers — all available providers
app.get('/api/ai/providers', (req, res) => res.json(aiEngine.getAvailableProviders()));

// GET /api/ai/models?provider=gemini&refresh=1 — LIVE model list from the provider's API
app.get('/api/ai/models', async (req, res) => {
  try {
    const provider = req.query.provider || aiEngine.provider;
    const models = await aiEngine.listModels(provider, req.query.refresh === '1');
    res.json({ provider, models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/switch — switch provider
app.post('/api/ai/switch', (req, res) => {
  try {
    const result = aiEngine.setProvider(req.body.provider, req.body.model);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/system — computer info + visible applications
app.get('/api/system', async (req, res) => {
  try {
    res.json(getFullSystemContext()); // Uses static import (perf fix #5)
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/chat — REST fallback for chat (also used by overlay)
app.post('/api/ai/chat', async (req, res) => {
  const userText = req.body.text;

  // ── Fast-path: match common commands instantly ──
  const { matchFastCommand, isBrowserTool } = await import('./fast-commands.js');
  const fastMatch = matchFastCommand(userText);

  if (fastMatch) {
    const startTime = Date.now();
    console.log(`[Chat] ⚡ Fast: ${fastMatch.tool}(${JSON.stringify(fastMatch.args)})`);
    const toolResult = await toolRegistry.executeTool(fastMatch.tool, fastMatch.args, wsProxy);
    const latency = Date.now() - startTime;

    // Auto-focus browser
    if (isBrowserTool(fastMatch.tool)) {
      wsProxy._autoFocusBrowser();
    }

    return res.json({
      text: fastMatch.silent ? '' : (toolResult?.message || ''),
      toolCalls: [{ tool: fastMatch.tool, result: toolResult }],
      latency,
      provider: 'fast',
      model: 'pattern-match',
      silent: fastMatch.silent,
    });
  }

  // ── Full AI path ──
  const systemContext = getFullSystemContext();
  const context = {
    tabs: wsProxy.browserContext?.tabs || [],
    activeTab: wsProxy.browserContext?.activeTab || null,
    pageContext: wsProxy.browserContext?.pageContext || null,
    extensionConnected: wsProxy.extensionClients.size > 0,
    currentTime: new Date().toLocaleString(),
    computerInfo: systemContext.computerInfo,
    visibleApplications: systemContext.visibleApplications,
  };
  const result = await aiEngine.processChat(userText, context);

  // Auto-focus browser if AI used browser tools
  if (result.toolCalls && Array.isArray(result.toolCalls)) {
    const usedBrowser = result.toolCalls.some(tc => isBrowserTool(tc.tool || tc.name));
    if (usedBrowser) wsProxy._autoFocusBrowser();
  }

  res.json(result);
});

// POST /api/ai/clear — Clear conversation history
app.post('/api/ai/clear', (req, res) => {
  aiEngine.clearHistory();
  res.json({ status: 'ok', message: 'Conversation history cleared' });
});

// POST /api/voice/transcribe — Transcribe audio (used by floating overlay)
const _voiceHandler = new VoiceHandler(); // Singleton (perf fix #1)
app.post('/api/voice/transcribe', async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) {
      return res.status(400).json({ text: '', error: 'No audio data provided' });
    }
    const result = await _voiceHandler.transcribe(audio, mimeType || 'audio/webm');
    res.json(result);
  } catch (err) {
    console.error('[VoiceAPI] Transcription error:', err.message);
    res.status(500).json({ text: '', error: err.message });
  }
});

// ── Serve Overlay HTML (works in any browser, no Electron required) ──
const overlayHtml = join(__dirname, '..', 'overlay.html');
if (existsSync(overlayHtml)) {
  app.get('/overlay', (req, res) => res.sendFile(overlayHtml));
}

// POST /api/overlay/reload — Reload the Electron overlay BrowserWindow from disk.
// Server and Electron main share the same process, so BrowserWindow is available here.
app.post('/api/overlay/reload', async (_req, res) => {
  try {
    const electron = await import('electron').catch(() => null);
    if (!electron?.BrowserWindow) {
      return res.status(503).json({ error: 'Not running in Electron — no BrowserWindow available' });
    }
    const wins = electron.BrowserWindow.getAllWindows();
    const overlay = wins.find(w => !w.isDestroyed() && w.webContents.getURL().includes('overlay.html'));
    if (overlay) {
      overlay.webContents.reload();
      res.json({ ok: true, msg: 'Overlay reloaded — fixed overlay.html loaded from disk' });
    } else {
      res.status(404).json({ error: 'Overlay window not found', totalWindows: wins.length });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve Dashboard SPA ──
// In dev: ../dashboard/dist relative to src/
// In packaged app: process.resourcesPath/dashboard/dist (via extraResources)
const dashboardDistDev = join(__dirname, '..', '..', 'dashboard', 'dist');
const dashboardDistPkg = process.resourcesPath ? join(process.resourcesPath, 'dashboard', 'dist') : null;
const dashboardDist = (dashboardDistPkg && existsSync(dashboardDistPkg)) ? dashboardDistPkg : dashboardDistDev;
if (existsSync(dashboardDist)) {
  // Serve index.html with the WS token injected as a meta tag (EXT-2).
  // useWebSocket.js already reads <meta name="ablespeak-ws-token"> — that
  // plumbing pre-dates this change but nothing ever set it, so the dashboard
  // connected with no token, same gap the overlay and extension had. Must
  // run BEFORE express.static, which would otherwise serve the raw file for
  // "/" itself; static still handles the JS/CSS assets that file references.
  const indexHtmlPath = join(dashboardDist, 'index.html');
  const serveIndexWithToken = (req, res) => {
    try {
      const escapedToken = String(wsProxy._wsToken || '').replace(/"/g, '&quot;');
      const html = readFileSync(indexHtmlPath, 'utf8')
        .replace('</head>', `<meta name="ablespeak-ws-token" content="${escapedToken}"></head>`);
      res.type('html').send(html);
    } catch (err) {
      res.status(500).send('Failed to load dashboard: ' + err.message);
    }
  };
  app.get('/', serveIndexWithToken);
  app.use(express.static(dashboardDist));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      serveIndexWithToken(req, res);
    }
  });
  console.log('[Static] Serving dashboard from', dashboardDist);
} else {
  app.get('/', (req, res) => {
    res.json({
      name: 'AbleSpeak AI Agent',
      version: '2.0.0',
      status: 'running',
      dashboard: 'Not built yet. Run: cd dashboard && npm run build',
      api: '/api/health'
    });
  });
  console.log('[Static] Dashboard not built yet');
}

// ── Start Server ──
server.listen(PORT, () => {
  console.log('');
  console.log(`🟢 AbleSpeak AI Agent running at http://localhost:${PORT}`);
  console.log(`   API:       http://localhost:${PORT}/api/health`);
  console.log(`   AI Status: http://localhost:${PORT}/api/ai/status`);
  console.log(`   Dashboard: http://localhost:${PORT}/`);
  console.log(`   WS Ext:    ws://localhost:${PORT}/ws/extension`);
  console.log(`   WS Dash:   ws://localhost:${PORT}/ws/dashboard`);
  console.log('');

  // Pre-start the PowerShell worker (UI Automation assemblies take seconds
  // to load — do it now, not during the user's first voice command)
  import('./system-tools.js').then(m => m.warmupSystemTools()).catch(() => {});

  // Validate the configured model against the provider's LIVE model list.
  // If it was retired (e.g. gemini-2.0-flash), auto-pick a replacement.
  if (aiEngine.getStatus().configured) {
    aiEngine.autoSelectModel()
      .then(m => { if (m) console.log(`[AIEngine] Model verified: ${aiEngine.provider}/${m}`); })
      .catch(err => console.warn('[AIEngine] Model validation skipped:', err.message));

    // ── TLS Warmup (borrowed from Clicky) ──
    // Pre-establish TLS connection to the LLM API so the first voice command
    // doesn't pay 1-3s for a cold TLS handshake.
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`, { method: 'GET' })
        .then(() => console.log('[TLS] Gemini API connection warmed up'))
        .catch(() => {}); // Ignore — this is purely an optimization
    }
  }

  // Check API keys
  const status = aiEngine.getStatus();
  if (!status.configured) {
    console.log('⚠️  No LLM API key configured! Set one in .env:');
    console.log('   OPENAI_API_KEY=sk-...');
    console.log('   GEMINI_API_KEY=...');
    console.log('   ANTHROPIC_API_KEY=...');
    console.log('   GROQ_API_KEY=...');
    console.log('');
  }

  // Progress probe scheduler: computes daily KPI values for active goals
  // (boot: yesterday + today, then hourly recompute) — recovered from eric branch.
  startProbeScheduler();
  console.log('[ProbeScheduler] Started — daily probes + hourly recompute active');
  process.once('SIGTERM', () => stopProbeScheduler());
  process.once('SIGINT', () => stopProbeScheduler());
});
