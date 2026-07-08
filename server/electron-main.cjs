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
const { WakeDetector } = require('./overlay-wake.cjs');
const { synthesizeToFile } = require('./src/edge-tts.cjs');

// ── Process crash guard ──
// Prevent stray native errors from killing the app.
process.on('uncaughtException', (err) => {
  // EADDRINUSE on the gateway port means another AbleSpeak instance is
  // ALREADY serving it — this can happen even when requestSingleInstanceLock()
  // succeeds, because Windows' lock-file check (process_singleton_win.cc) is
  // flaky under rapid relaunches. Rather than silently limping along with a
  // half-dead server and duplicate, non-functional windows, quit cleanly so
  // the user isn't left staring at nothing with no idea why.
  if (err.code === 'EADDRINUSE') {
    console.error('[Electron] Another AbleSpeak instance is already running on this port — quitting duplicate.');
    app.quit();
    return;
  }
  console.error('[Electron] Uncaught exception (survived):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Electron] Unhandled rejection (survived):', reason?.message || reason);
});

// ── Config ──
const PORT = parseInt(process.env.GATEWAY_PORT || '3001');
const DASHBOARD_URL = `http://localhost:${PORT}`;
const OVERLAY_SHORTCUT = 'Ctrl+Shift+A';
const WAKE_DETECTION_ENABLED = process.env.WAKE_DETECTION !== 'false'; // ON by default
// Neural voice for Edge TTS (same catalog as Edge Read Aloud / Cortana).
const TTS_VOICE = process.env.ABLESPEAK_TTS_VOICE || 'en-US-AriaNeural';

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let serverReady = false;
let appIcon = null;
let currentTTSProcess = null; // PowerShell playback child — killable on "stop"/"cancel"

// ── TTS helpers ──
// Play a WAV file synchronously via PowerShell's Media.SoundPlayer. Resolves when
// playback finishes (so the caller can re-enable the mic). The child process is
// tracked in `currentTTSProcess` so a voice "stop"/"cancel" can kill it mid-sentence.
function playWavFile(file) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const esc = file.replace(/'/g, "''");
    const psScript =
      `$p = New-Object System.Media.SoundPlayer '${esc}'; ` +
      `$p.PlaySync(); ` +
      `Remove-Item -LiteralPath '${esc}' -ErrorAction SilentlyContinue`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    currentTTSProcess = exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 30000, windowsHide: true },
      (err) => {
        currentTTSProcess = null;
        // A kill (voice interrupt) surfaces as an error — treat it as a clean stop.
        if (err && !err.killed) return reject(err);
        resolve();
      }
    );
  });
}

// Speak text via Windows SAPI (offline fallback). Writes the text to a temp file
// to sidestep all PowerShell quoting issues, then speaks via EncodedCommand.
function speakViaSapi(text) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const { writeFileSync, unlinkSync } = require('fs');
    const { join } = require('path');
    const { tmpdir } = require('os');

    const tmpFile = join(tmpdir(), `ablespeak_tts_${Date.now()}.txt`);
    writeFileSync(tmpFile, text, 'utf8');

    const psScript = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 1
$text = [IO.File]::ReadAllText('${tmpFile.replace(/\\/g, '\\\\')}')
$synth.Speak($text)
Remove-Item '${tmpFile.replace(/\\/g, '\\\\')}' -ErrorAction SilentlyContinue
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    currentTTSProcess = exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 20000, windowsHide: true },
      (err) => {
        currentTTSProcess = null;
        try { unlinkSync(tmpFile); } catch {}
        if (err && !err.killed) return reject(err);
        resolve();
      }
    );
  });
}
let activeShortcut = OVERLAY_SHORTCUT; // actual registered shortcut (may be a fallback)
let wakeDetector = null;

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
  // User tried to relaunch while AbleSpeak is already running hidden in the
  // tray — surface BOTH windows instead of doing nothing visible (Gap: the
  // overlay used to never come back, leaving the user with no sign of life).
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
    toggleOverlay();
  }
});

// ── Boot Server ──
async function startServer() {
  // In packaged app: .env is in resources/ (extraResources), not inside the asar.
  // In dev: .env is in the same directory as electron-main.cjs.
  const envPath = app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '.env');

  // Load .env BEFORE importing the server (which uses dotenv/config)
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = value;
      }
    }
    console.log('[Electron] .env loaded from', envPath);
  } else {
    console.warn('[Electron] No .env file found at', envPath);
  }

  // Set working directory for any relative path references
  if (!app.isPackaged) {
    process.chdir(path.join(__dirname));
  }

  // Dynamic import of the ESM server entry
  try {
    await import('./src/index.js');
    serverReady = true;
    console.log('[Electron] Server module loaded');
  } catch (err) {
    console.error('[Electron] Failed to start server:', err);
  }
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
    const allowed = ['media', 'microphone', 'audioCapture', 'screen'].includes(permission);
    if (!loggedPermissions.has(permission)) {
      console.log(`[Electron] Permission request: ${permission} → ${allowed ? 'GRANTED' : 'DENIED'}`);
      loggedPermissions.add(permission);
    }
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['media', 'microphone', 'audioCapture', 'screen'].includes(permission);
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
  let windowShown = false;
  mainWindow.once('ready-to-show', () => {
    if (!windowShown) {
      windowShown = true;
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Fallback: force-show after 5s even if ready-to-show never fires
  setTimeout(() => {
    if (!windowShown && mainWindow && !mainWindow.isDestroyed()) {
      windowShown = true;
      console.log('[Electron] Force-showing main window (ready-to-show timeout)');
      mainWindow.show();
      mainWindow.focus();
    }
  }, 5000);

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
  const overlayW = 420;
  const overlayH = 180;
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
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'overlay-preload.cjs'),
    },
  });

  // Prevent overlay from appearing in Alt+Tab — use 'screen-saver' level
  // so it stays above ALL windows including fullscreen apps
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Re-assert always-on-top periodically — some Windows actions can
  // knock the overlay behind other windows (e.g. Alt+Tab, fullscreen apps)
  setInterval(() => {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 5000);

  // Load the self-contained overlay HTML
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  // ── Crash recovery ──
  // The overlay IS the student's hands-free interface. If its renderer dies it
  // must come back on its own — the student has no mouse to relaunch it. The
  // main window already has this; the overlay previously did not.
  const reloadOverlay = (why) => {
    console.error(`[Electron] Overlay ${why} — reloading in 1.5s`);
    setTimeout(() => {
      try {
        if (!overlayWindow || overlayWindow.isDestroyed()) {
          createOverlay(); // fully gone — rebuild it
        } else {
          overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
          overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        }
      } catch (e) {
        console.error('[Electron] Overlay reload failed:', e.message);
      }
    }, 1500);
  };
  // 'render-process-gone' is the modern event; 'crashed' covers older Electron.
  overlayWindow.webContents.on('render-process-gone', (_e, details) =>
    reloadOverlay(`render-process-gone (${details?.reason || 'unknown'})`));
  overlayWindow.webContents.on('crashed', () => reloadOverlay('crashed'));
  overlayWindow.webContents.on('did-fail-load', (_e, code, desc) =>
    reloadOverlay(`failed to load (${code}: ${desc})`));
  overlayWindow.on('unresponsive', () => reloadOverlay('unresponsive'));

  // Don't destroy on close — just hide
  overlayWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      overlayWindow.hide();
    }
  });

  // When overlay loses focus, don't auto-hide (user might be interacting with another app)
  // The overlay auto-hides after AI responds via its own timer

  console.log('[Electron] Overlay window created');
}

function toggleOverlay() {
  if (!overlayWindow) return;

  if (overlayWindow.isVisible()) {
    // Stop the mic BEFORE hiding — otherwise it keeps recording in the
    // hidden window and the listening state desyncs from visibility.
    overlayWindow.webContents.send('overlay-stop');
    overlayWindow.hide();
  } else {
    // Re-position at bottom-center in case display changed
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;
    const bounds = overlayWindow.getBounds();
    const x = Math.round((screenW - bounds.width) / 2);
    const y = screenH - bounds.height - 20;
    overlayWindow.setPosition(x, y);

    // showInactive: don't steal focus from the app the user is voice-controlling.
    // Keystroke tools (send_system_keys, type) must land in THEIR app, not the overlay.
    overlayWindow.showInactive();

    // Pause wake detection while overlay is active
    if (wakeDetector) wakeDetector.pause();

    // Tell overlay to START listening (always start on show — never toggle,
    // toggling inverts state if the overlay was hidden while still active)
    overlayWindow.webContents.send('overlay-shown');
  }
}

// ── IPC Handlers for Overlay ──

function setupOverlayIPC() {

  // ── Screen Capture ──
  // NOTE: desktopCapturer.getSources() causes a native C++ crash on some Windows
  // setups (ERROR_BUSY 170 in Chromium's desktop.cc:68). This crash happens at
  // the Chromium level and CANNOT be caught by JavaScript try/catch.
  // Instead, screenshots are provided by the Chrome extension via
  // chrome.tabs.captureVisibleTab() which is reliable and already integrated.
  ipcMain.handle('capture-screen', async () => {
    // Disabled — use extension screenshot via take_screenshot tool instead
    return null;
  });

  // ── Text-to-Speech: Edge neural TTS (primary) → Windows SAPI (fallback) ──
  // Browser speechSynthesis fails silently in transparent Electron windows, so TTS
  // is routed through the main process. Edge TTS gives a natural neural voice and
  // avoids the ARM64 SAPI/Add-Type crashes; SAPI remains the offline fallback.
  //
  // Emits 'tts-state' IPC events ('speaking' | 'done') so the overlay can mute the
  // mic while audio is playing (breaks the mic↔speaker feedback loop — Gap 3).
  ipcMain.handle('speak-text', async (_event, text) => {
    if (!text || typeof text !== 'string') return false;
    const safeText = text.slice(0, 500);

    const sendTtsState = (state) => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('tts-state', state);
      }
    };

    // ── Primary: Edge neural TTS (network) ──
    try {
      const { join } = require('path');
      const { tmpdir } = require('os');
      const audioFile = join(tmpdir(), `ablespeak_tts_${Date.now()}.wav`);

      await synthesizeToFile(safeText, audioFile, { voice: TTS_VOICE, timeoutMs: 10000 });

      sendTtsState('speaking');
      await playWavFile(audioFile);
      sendTtsState('done');

      console.log(`[TTS] Edge neural (${TTS_VOICE}): "${safeText.slice(0, 50)}..."`);
      return true;
    } catch (err) {
      console.warn('[TTS] Edge TTS failed, falling back to SAPI:', err.message);
    }

    // ── Fallback: Windows SAPI via EncodedCommand (offline-safe) ──
    try {
      sendTtsState('speaking');
      await speakViaSapi(safeText);
      sendTtsState('done');
      console.log(`[TTS] SAPI fallback: "${safeText.slice(0, 50)}..."`);
      return true;
    } catch (err) {
      console.error('[TTS] SAPI fallback failed:', err.message);
      sendTtsState('done'); // never leave the overlay's mic muted
      return false;
    }
  });

  // ── Stop any in-progress TTS playback (voice "stop"/"cancel" interrupt — Gap 4) ──
  ipcMain.handle('stop-tts', async () => {
    if (currentTTSProcess) {
      // Killing the PowerShell playback child stops SoundPlayer.PlaySync immediately.
      try { currentTTSProcess.kill(); } catch {}
      currentTTSProcess = null;
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('tts-state', 'done');
    }
    return true;
  });

  // ── PRIMARY: Web Speech API path — receives pre-transcribed text (fast) ──
  ipcMain.on('overlay-voice-text', async (event, { text }) => {
    if (!text || !text.trim()) return;

    const userText = text.trim();
    console.log(`[Overlay] ⚡ Text command: "${userText}"`);

    try {
      const chatRes = await fetch(`http://localhost:${PORT}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: userText }),
      });

      if (!chatRes.ok) {
        throw new Error(`AI chat failed: ${chatRes.status}`);
      }

      const result = await chatRes.json();

      // Silent mode: fast-path sets it, or detect from empty text + tools
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
      // Resume wake detection after cooldown
      if (wakeDetector) wakeDetector.resume();
    }
  });

  // Configure overlay settings (silence timeout, continuous mode, etc.)
  ipcMain.on('overlay-set-config', (event, config) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay-config', config);
    }
  });

  // Toggle wake detection from settings
  ipcMain.on('set-wake-detection', (event, { enabled }) => {
    if (wakeDetector) {
      wakeDetector.setEnabled(enabled);
      console.log(`[Electron] Wake detection ${enabled ? 'enabled' : 'disabled'}`);
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
  // Try the preferred shortcut first, then fallbacks (another app may have
  // already grabbed Ctrl+Shift+A — registration fails silently otherwise).
  const candidates = [OVERLAY_SHORTCUT, 'Ctrl+Shift+Space', 'Ctrl+Alt+A', 'Alt+Shift+A'];

  for (const shortcut of candidates) {
    const registered = globalShortcut.register(shortcut, () => {
      console.log(`[Electron] ${shortcut} pressed`);
      // If TTS is currently playing, the shortcut acts as a stop button
      // rather than toggling the overlay — stops the speech immediately.
      if (currentTTSProcess) {
        try { currentTTSProcess.kill(); } catch {}
        currentTTSProcess = null;
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('tts-state', 'done');
        }
        return;
      }
      toggleOverlay();
    });

    if (registered) {
      activeShortcut = shortcut;
      console.log(`[Electron] Global shortcut registered: ${shortcut}`);
      // Tell the overlay which shortcut is live so the hint text is correct
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.once('did-finish-load', () => {
          overlayWindow.webContents.send('overlay-shortcut', { shortcut });
        });
        if (!overlayWindow.webContents.isLoading()) {
          overlayWindow.webContents.send('overlay-shortcut', { shortcut });
        }
      }
      return;
    }
    console.warn(`[Electron] Could not register ${shortcut}, trying next...`);
  }

  console.error('[Electron] Failed to register ANY global shortcut');
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
      label: `Voice Overlay (${activeShortcut})`,
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
  // Load the AbleSpeak logo
  loadAppIcon();

  // Start the Express server first
  await startServer();

  // Setup IPC handlers for overlay (before creating windows)
  setupOverlayIPC();

  // Then create the windows
  createWindow();
  createOverlay();

  // Register global shortcut BEFORE the tray so the tray label
  // shows the shortcut that actually registered
  registerGlobalShortcut();
  createTray();

  // ── Auto-start on boot (accessibility: user can't launch manually) ──
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      name: 'AbleSpeak',
    });
    console.log('[Electron] Auto-start on boot enabled');
  }

  // ── Auto-show overlay on startup (always-listening like dictation tools) ──
  // The overlay auto-starts its mic — no keyboard shortcut needed.
  // Ctrl+Shift+A still works as a manual toggle for dismiss/restore.
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;
      const bounds = overlayWindow.getBounds();
      const x = Math.round((screenW - bounds.width) / 2);
      const y = screenH - bounds.height - 20;
      overlayWindow.setPosition(x, y);
      overlayWindow.showInactive();
      overlayWindow.webContents.send('overlay-shown');
      console.log('[Electron] Overlay auto-shown — always-listening mode');
    }
  }, 3000); // Give the server + dashboard time to boot

  // Wake detection no longer needed — overlay itself is always listening.
  // Keep the module available for future use but don't start it.
  wakeDetector = new WakeDetector({
    enabled: false,
    onWake: () => {
      if (overlayWindow && !overlayWindow.isVisible()) {
        toggleOverlay();
      }
    },
  });

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
  // Shutdown wake detector
  if (wakeDetector) wakeDetector.destroy();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
