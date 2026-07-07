/**
 * AbleSpeak Desktop — Electron Main Process
 * 
 * Boots the Express + WebSocket server, then opens a native
 * BrowserWindow pointing at the dashboard.
 * 
 * Also creates a floating overlay window (Wispr Flow style)
 * that lets users voice-command from any application via
 * global keyboard shortcut Ctrl+Shift+A.
 * 
 * Using .cjs because Electron's main script must be CommonJS,
 * while the server code is ESM. We dynamically import() the server.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, session, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Auto-start Electron bridge ──
// Set BEFORE server import so REST endpoints can call it immediately.
// When running headlessly (npm start), globalThis.__ablespeakElectron is absent.
globalThis.__ablespeakElectron = {
  setAutoStart(on) {
    const args = app.isPackaged ? [] : [path.resolve(__dirname, '..')];
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args });
    return app.getLoginItemSettings().openAtLogin;
  },
  getAutoStart() {
    return app.getLoginItemSettings().openAtLogin;
  },
};

// ── Config ──
const PORT = parseInt(process.env.GATEWAY_PORT || '3001');
const DASHBOARD_URL = `http://localhost:${PORT}`;
const OVERLAY_SHORTCUT = 'Ctrl+Shift+A';

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let serverReady = false;
let appIcon = null;

// ── Load AbleSpeak Logo ──
function loadAppIcon() {
  const svgPath = path.join(__dirname, '..', 'dashboard', 'public', 'favicon.svg');
  try {
    if (fs.existsSync(svgPath)) {
      const svgContent = fs.readFileSync(svgPath, 'utf8');
      // Scale SVG to 256×256 for crisp icon
      const scaledSvg = svgContent
        .replace(/width="48"/, 'width="256"')
        .replace(/height="46"/, 'height="256"');
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(scaledSvg).toString('base64')}`;
      const img = nativeImage.createFromDataURL(dataUrl);
      if (!img.isEmpty()) {
        appIcon = img;
        console.log('[Electron] Loaded AbleSpeak logo from favicon.svg');
        return;
      }
    }
  } catch (err) {
    console.warn('[Electron] Could not load SVG icon:', err.message);
  }
  appIcon = nativeImage.createEmpty();
}

// ── Chromium Flags for Speech Recognition ──
// Web Speech API in Electron requires Google API key for the speech service
// Load .env to get the API key before app is ready
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const googleApiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
if (googleApiKey) {
  // This is the critical flag that makes webkitSpeechRecognition work in Electron
  app.commandLine.appendSwitch('google-api-key', googleApiKey);
  console.log('[Electron] Google API key configured for speech recognition');
}
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI,SpeechRecognition');

// ── Single Instance Lock ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Boot Server (with single retry on failure) ──
async function startServer() {
  // Set working directory so dotenv/.env resolves correctly
  process.chdir(path.join(__dirname));

  // Dynamic import of the ESM server entry — retry once after 2 s on failure
  try {
    await import('./src/index.js');
    serverReady = true;
    console.log('[Electron] Server module loaded');
  } catch (err) {
    console.error('[Electron] Failed to start server (attempt 1):', err.message);
    await new Promise(r => setTimeout(r, 2000));
    try {
      await import('./src/index.js');
      serverReady = true;
      console.log('[Electron] Server module loaded (retry)');
    } catch (err2) {
      console.error('[Electron] Server failed on retry — showing error window:', err2.message);
      showServerErrorWindow(err2.message);
    }
  }
}

// ── Show visible error window on unrecoverable boot failure ──
function showServerErrorWindow(message) {
  const errWin = new BrowserWindow({
    width: 520, height: 260, title: 'AbleSpeak — Startup Error',
    autoHideMenuBar: true, alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  errWin.loadURL(`data:text/html,<body style="background:#1a0a0a;color:#f87171;font-family:sans-serif;padding:32px">
    <h2>AbleSpeak could not start</h2>
    <p>The server module failed to load after two attempts.</p>
    <pre style="font-size:12px;overflow:auto">${message.replace(/</g,'&lt;')}</pre>
    <p>Check that Node.js dependencies are installed (<code>npm install</code>).</p></body>`);
}

// ── Create Main Dashboard Window ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'AbleSpeak — Voice Command Center',
    icon: appIcon,
    backgroundColor: '#0a0e1a',
    autoHideMenuBar: true,
    show: false,  // show after load to avoid white flash
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Remove default menu bar
  mainWindow.setMenu(null);

  // ── Grant Microphone Permission (critical for voice commands) ──
  const loggedPermissions = new Set();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture'].includes(permission);
    if (!loggedPermissions.has(permission)) {
      console.log(`[Electron] Permission request: ${permission} → ${allowed ? 'GRANTED' : 'DENIED'}`);
      loggedPermissions.add(permission);
    }
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['media', 'microphone', 'audioCapture'].includes(permission);
  });

  // Wait for server then load dashboard
  const loadDashboard = () => {
    mainWindow.loadURL(DASHBOARD_URL).catch(() => {
      // Server might not be ready yet — retry
      setTimeout(loadDashboard, 500);
    });
  };

  // Give the server a moment to bind the port
  if (serverReady) {
    loadDashboard();
  } else {
    setTimeout(loadDashboard, 1500);
  }

  // Show window when content is painted (no white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in the default browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.includes('localhost')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Crash recovery: auto-reload on renderer crash (Fix #10)
  mainWindow.webContents.on('crashed', () => {
    console.error('[Electron] Renderer crashed, reloading in 2s...');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(DASHBOARD_URL);
      }
    }, 2000);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`[Electron] Page load failed (${errorCode}: ${errorDescription}), retrying in 3s...`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(DASHBOARD_URL);
      }
    }, 3000);
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// ══════════════════════════════════════════════
// ── Floating Voice Overlay (Wispr Flow style) ──
// ══════════════════════════════════════════════

function createOverlay() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  // Position at bottom-center of screen
  // (height fits transcript readout + repair prompt; pill anchors to bottom)
  const overlayW = 420;
  const overlayH = 260;
  const x = Math.round((screenW - overlayW) / 2);
  const y = screenH - overlayH - 20;

  overlayWindow = new BrowserWindow({
    width: overlayW,
    height: overlayH,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'overlay-preload.cjs'),
    },
  });

  // Prevent overlay from appearing in Alt+Tab
  overlayWindow.setAlwaysOnTop(true, 'floating');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Load the self-contained overlay HTML
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  // Don't destroy on close — just hide
  overlayWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      overlayWindow.hide();
    }
  });

  // When overlay loses focus, don't auto-hide (user might be interacting with another app)
  // The overlay auto-hides after AI responds via its own timer

  // Auto-show overlay on boot — the student's primary interaction surface.
  // Show after a brief delay to let the server bind the port first.
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      console.log('[Electron] Overlay auto-shown on boot');
    }
  }, 2000);

  console.log('[Electron] Overlay window created');
}

function toggleOverlay() {
  if (!overlayWindow) return;

  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    // Re-position at bottom-center in case display changed
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;
    const bounds = overlayWindow.getBounds();
    const x = Math.round((screenW - bounds.width) / 2);
    const y = screenH - bounds.height - 20;
    overlayWindow.setPosition(x, y);

    overlayWindow.show();

    // Tell overlay to start listening
    overlayWindow.webContents.send('toggle-listen');
  }
}

// ── IPC Handlers for Overlay ──

function setupOverlayIPC() {

  // ── PRIMARY: Web Speech API path — receives pre-transcribed text (fast) ──
  // Payload: { text, confidence } — confidence is the recognizer's top-alternative
  // score (0..1) or null when unknown; the server treats missing confidence as null.
  ipcMain.on('overlay-voice-text', async (event, { text, confidence }) => {
    if (!text || !text.trim()) return;

    const userText = text.trim();
    const conf = typeof confidence === 'number' ? confidence : null;
    console.log(`[Overlay] ⚡ Text command: "${userText}"${conf != null ? ` (confidence ${conf.toFixed(2)})` : ''}`);

    try {
      // Route through the full gate pipeline (confirmation → repair → picker → evaluate → normal)
      // instead of /api/ai/chat which bypasses all gates.
      const voiceRes = await fetch(`http://localhost:${PORT}/api/voice/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: userText, confidence: conf }),
      });

      if (!voiceRes.ok) {
        throw new Error(`Voice text failed: ${voiceRes.status}`);
      }

      const { events } = await voiceRes.json();

      // Forward each server event to the overlay — handleWSMessage() handles them all.
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        for (const ev of (events || [])) {
          overlayWindow.webContents.send('overlay-event', ev);
        }
      }
    } catch (err) {
      console.error('[Overlay] Error processing text command:', err.message);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay-error', { message: err.message });
      }
    }
  });

  // ── FALLBACK: Audio path — for when Web Speech API is unavailable ──
  ipcMain.on('overlay-voice-audio', async (event, { audio, mimeType }) => {
    console.log(`[Overlay] Received audio (${Math.round(audio.length / 1024)}KB) — using Gemini fallback`);

    try {
      // Step 1: Transcribe using Gemini
      const voiceRes = await fetch(`http://localhost:${PORT}/api/voice/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio, mimeType: mimeType || 'audio/webm' }),
      });

      if (!voiceRes.ok) {
        throw new Error(`Transcription failed: ${voiceRes.status}`);
      }

      const { text: userText, error: transcribeError } = await voiceRes.json();

      if (transcribeError === 'no_speech' || !userText) {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('overlay-error', { message: 'No speech detected' });
        }
        return;
      }

      if (transcribeError) {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('overlay-error', { message: transcribeError });
        }
        return;
      }

      console.log(`[Overlay] Transcribed: "${userText}"`);

      // Step 2: Send to AI engine
      const chatRes = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: userText }),
      });

      if (!chatRes.ok) {
        throw new Error(`AI chat failed: ${chatRes.status}`);
      }

      const result = await chatRes.json();

      const isSilent = result.silent === true ||
        (result.toolCalls && Array.isArray(result.toolCalls) && !result.text?.trim());

      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay-response', {
          text: result.text,
          userText,
          error: result.error || false,
          toolCalls: result.toolCalls,
          silent: isSilent,
        });
      }

    } catch (err) {
      console.error('[Overlay] Error processing voice:', err.message);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay-error', { message: err.message });
      }
    }
  });

  // Hide overlay
  ipcMain.on('overlay-hide', () => {
    if (overlayWindow && overlayWindow.isVisible()) {
      overlayWindow.hide();
    }
  });

  // Show dashboard
  ipcMain.on('show-dashboard', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Register Global Keyboard Shortcut ──

function registerGlobalShortcut() {
  const registered = globalShortcut.register(OVERLAY_SHORTCUT, () => {
    console.log(`[Electron] ${OVERLAY_SHORTCUT} pressed`);
    toggleOverlay();
  });

  if (registered) {
    console.log(`[Electron] Global shortcut registered: ${OVERLAY_SHORTCUT}`);
  } else {
    console.error(`[Electron] Failed to register global shortcut: ${OVERLAY_SHORTCUT}`);
  }
}

// ── System Tray ──
function createTray() {
  const trayIcon = appIcon && !appIcon.isEmpty()
    ? appIcon.resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(trayIcon);
  tray.setToolTip('AbleSpeak — Voice Command Center');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show AbleSpeak',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: `Voice Overlay (${OVERLAY_SHORTCUT})`,
      click: () => toggleOverlay(),
    },
    {
      label: 'Open in Browser',
      click: () => shell.openExternal(DASHBOARD_URL),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── App Lifecycle ──

// Catch unhandled errors — prevent silent death for assistive tool users (Fix #10)
process.on('uncaughtException', (err) => {
  console.error('[Electron] Uncaught exception:', err);
  // Don't exit — attempt to keep running
});
process.on('unhandledRejection', (err) => {
  console.error('[Electron] Unhandled rejection:', err);
});

app.whenReady().then(async () => {
  // Apply persisted auto-start preference before opening windows
  try {
    // Dynamic import: ESM module, loaded after app is ready
    const { getAppSettings } = await import('./src/app-settings.js');
    const settings = getAppSettings();
    globalThis.__ablespeakElectron.setAutoStart(settings.autoStart);
    console.log(`[Electron] Auto-start: ${settings.autoStart} (registry applied)`);
  } catch (err) {
    console.warn('[Electron] Could not apply auto-start preference:', err.message);
  }

  // Load the AbleSpeak logo
  loadAppIcon();

  // Start the Express server first
  await startServer();

  // Setup IPC handlers for overlay (before creating windows)
  setupOverlayIPC();

  // Then create the windows and tray
  createWindow();
  createOverlay();
  createTray();

  // Register global shortcut for overlay
  registerGlobalShortcut();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray on Windows/Linux
  if (process.platform === 'darwin') {
    // On macOS it's common for apps to stay open
  }
});

app.on('will-quit', () => {
  // Unregister all global shortcuts
  globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
