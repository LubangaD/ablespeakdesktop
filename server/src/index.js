import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { getFullSystemContext } from './system-info.js';
import { VoiceHandler } from './voice-handler.js';

import { initDatabase } from './db.js';
import { AIEngine } from './ai-engine.js';
import { ToolRegistry } from './tool-registry.js';
import { WsProxy } from './ws-proxy.js';
import { LogTailer } from './log-tailer.js';
import { LibraryScanner } from './library-scanner.js';
import { createApiRouter } from './routes/api.js';
import { getAppSettings } from './app-settings.js';
import { SyncClient } from './sync-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ──
const PORT = parseInt(process.env.GATEWAY_PORT || '3001');
const VOQAL_HOME = process.env.VOQAL_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.voqal');
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'ablespeak.db');

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
initDatabase(DB_PATH);
console.log('[DB] SQLite initialized');

// ── Express App ──
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Large enough for long voice recordings
app.use(express.text({ type: 'text/plain', limit: '1mb' })); // For CSV roster import
app.use(rateLimit({ windowMs: 60000, max: 300 }));

// ── HTTP Server (shared with WebSocket) ──
const server = createServer(app);

// ── AI Engine ──
const toolRegistry = new ToolRegistry();
console.log(`[Tools] ${toolRegistry.listTools().length} tools registered`);

// AIEngine needs wsHub, but wsHub needs aiEngine — use lazy init
const aiEngine = new AIEngine({ toolRegistry, wsHub: null });

// ── WebSocket Hub (standalone — no Voqal) ──
const wsProxy = new WsProxy({ server, aiEngine });
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

// ── T4 Sync Client (sender) ──
// Settings are re-read every cycle, so URL/key/interval changes apply live.
// The loop itself starts/stops when sync.enabled or sync.role changes (applySyncSettings
// is invoked from POST /api/setup/app-settings via req._restartSync).
const syncClient = new SyncClient({ settings: getAppSettings });

function applySyncSettings() {
  const s = getAppSettings();
  const shouldRun = !!(s.sync?.enabled && s.sync?.role === 'sender');
  if (shouldRun && !syncClient.isRunning()) {
    syncClient.start();
    console.log('[Sync] Sender started (interval', (s.sync.intervalMs || 30000) + 'ms)');
  } else if (!shouldRun && syncClient.isRunning()) {
    syncClient.stop();
    console.log('[Sync] Sender stopped');
  }
}
applySyncSettings(); // start only if already enabled in settings (default OFF)
app.use((req, res, next) => { req._restartSync = applySyncSettings; next(); });

// ── API Routes ──
app.use('/api', createApiRouter({ wsProxy, logTailer, libraryScanner, voqalHomePath: VOQAL_HOME, aiEngine }));

// ── Additional AI-specific API routes ──

// GET /api/ai/status — current LLM provider and model
app.get('/api/ai/status', (req, res) => res.json(aiEngine.getStatus()));

// GET /api/ai/providers — all available providers
app.get('/api/ai/providers', (req, res) => res.json(aiEngine.getAvailableProviders()));

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

// ── Serve Dashboard SPA ──
const dashboardDist = join(__dirname, '..', '..', 'dashboard', 'dist');
if (existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      res.sendFile(join(dashboardDist, 'index.html'));
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
});
