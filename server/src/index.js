import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

import { initDatabase } from './db.js';
import { AIEngine } from './ai-engine.js';
import { ToolRegistry } from './tool-registry.js';
import { WsProxy } from './ws-proxy.js';
import { LogTailer } from './log-tailer.js';
import { LibraryScanner } from './library-scanner.js';
import { createApiRouter } from './routes/api.js';

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
app.use(express.json());
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

function broadcastLog(level, args) {
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  // Skip CLIXML noise from PowerShell
  if (message.includes('CLIXML') || message.includes('Preparing modules')) return;
  try {
    wsProxy._broadcastDashboard({
      type: 'log_event',
      event: {
        level,
        message,
        timestamp: new Date().toLocaleTimeString(),
      },
      timestamp: new Date().toISOString()
    });
  } catch {}
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
    const { getFullSystemContext } = await import('./system-info.js');
    res.json(getFullSystemContext());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/chat — REST fallback for chat
app.post('/api/ai/chat', async (req, res) => {
  const { getFullSystemContext } = await import('./system-info.js');
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
  const result = await aiEngine.processChat(req.body.text, context);
  res.json(result);
});

// POST /api/ai/clear — Clear conversation history
app.post('/api/ai/clear', (req, res) => {
  aiEngine.clearHistory();
  res.json({ status: 'ok', message: 'Conversation history cleared' });
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
