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

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, session, globalShortcut, ipcMain, screen, dialog } = require('electron');
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
// Play an audio file (MP3 or WAV) through Windows' media player and resolve
// when it has finished, so the caller can re-enable the mic. The child process
// is tracked in `currentTTSProcess` so a voice "stop"/"cancel" can kill it
// mid-sentence.
function playAudioFile(file) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const esc = file.replace(/'/g, "''");
    const psScript = `
Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([uri]'${esc}')
$n = 0
while (-not $p.NaturalDuration.HasTimeSpan -and $n -lt 50) { Start-Sleep -Milliseconds 100; $n++ }
$loaded = $p.NaturalDuration.HasTimeSpan
if ($loaded) {
  $p.Play()
  Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 150)
}
$p.Close()
Remove-Item -LiteralPath '${esc}' -ErrorAction SilentlyContinue
if (-not $loaded) { exit 3 }
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    currentTTSProcess = exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 60000, windowsHide: true },
      (err) => {
        currentTTSProcess = null;
        // A kill (voice interrupt) surfaces as an error — treat it as a clean stop.
        if (err && !err.killed) {
          try { fs.unlinkSync(file); } catch {}
          return reject(err.code === 3 ? new Error('the audio would not load') : err);
        }
        resolve();
      }
    );
  });
}

// Speak text via Windows SAPI (offline fallback). Writes the text to a temp file
// to sidestep all PowerShell quoting issues, then speaks via EncodedCommand.
// Picks an English female voice (Zira on most computers) so the fallback
// sounds like Aria rather than switching to a man's voice.
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
$wanted = $env:ABLESPEAK_SAPI_VOICE
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
$voice = $null
if ($wanted) { $voice = $voices | Where-Object { $_.Name -like "*$wanted*" } | Select-Object -First 1 }
if (-not $voice) { $voice = $voices | Where-Object { $_.Gender -eq 'Female' -and $_.Culture.Name -eq 'en-US' } | Select-Object -First 1 }
if (-not $voice) { $voice = $voices | Where-Object { $_.Gender -eq 'Female' -and $_.Culture.Name -like 'en*' } | Select-Object -First 1 }
if ($voice) { $synth.SelectVoice($voice.Name) }
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
// A PNG: Electron's nativeImage cannot read SVG, which left the tray icon
// blank — and the install guide sends teachers to that icon.
function loadAppIcon() {
  const candidates = [
    path.join(__dirname, '..', 'dashboard', 'public', 'ablespeak-logo.png'),       // running from source
    path.join(process.resourcesPath || '', 'dashboard', 'dist', 'ablespeak-logo.png'), // installed
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) {
        appIcon = img;
        console.log('[Electron] Loaded AbleSpeak logo from', file);
        return;
      }
    } catch (err) {
      console.warn('[Electron] Could not load icon:', err.message);
    }
  }
  console.warn('[Electron] No AbleSpeak logo found — the tray icon will be blank');
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
// Windows can wrongly count the always-on-top, see-through voice bar as hidden
// behind other windows and stop painting it: its listening loop froze and its
// drag area stopped working. Keep painting it.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

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

// First-run template for a packaged install's OWN .env — never the developer's.
// GEMINI_API_KEY is called out as required regardless of chat provider because
// voice transcription always uses Gemini (see voice-handler.js).
const ENV_TEMPLATE = `# AbleSpeak — API keys for this device (SEC-1: each install brings its own).
#
# GEMINI_API_KEY is REQUIRED no matter which provider you pick below — voice
# transcription always uses Gemini. Get a free key: https://aistudio.google.com/apikey
GEMINI_API_KEY=

# Pick ONE chat provider: gemini, openai or anthropic. Only its matching key below is needed; Gemini needs
# no second key, so leave LLM_PROVIDER=gemini for the simplest one-key setup.
LLM_PROVIDER=gemini
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=

# Restart AbleSpeak after editing this file for changes to take effect.
`;

// ── Boot Server ──
async function startServer() {
  // In packaged app: .env lives in the user's own writable AppData directory —
  // the same place the database already lives — NOT in resources/ (which used
  // to be populated by copying the developer's real .env, with live API keys,
  // into every distributed installer). In dev: .env is next to electron-main.cjs.
  const envPath = app.isPackaged
    ? path.join(app.getPath('userData'), '.env')
    : path.join(__dirname, '.env');
  // The dashboard's Settings page saves API keys to this same file.
  process.env.ABLESPEAK_ENV_PATH = envPath;

  // First launch of a packaged install with no keys yet — seed a template and
  // tell the adult doing setup where to fill it in, rather than the app just
  // silently having no voice.
  if (app.isPackaged && !fs.existsSync(envPath)) {
    try {
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      fs.writeFileSync(envPath, ENV_TEMPLATE);
      console.warn(`[Electron] No API keys configured — created a template at: ${envPath}`);
      dialog.showMessageBox({
        type: 'info',
        title: 'AbleSpeak needs an API key',
        message: 'AbleSpeak needs an API key before it can listen or speak.',
        detail: `First set an admin PIN: right-click the AbleSpeak icon near the clock and choose "Set admin PIN…". Then add a Google Gemini key under Settings → API keys. It works straight away.\n\nThe key is saved on this computer in:\n${envPath}`,
        buttons: ['Open Folder', 'Later'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) shell.showItemInFolder(envPath);
      }).catch(() => {});
    } catch (err) {
      console.error('[Electron] Could not create .env template:', err.message);
    }
  }

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

// ── Where the voice bar sits ──
// The window is only as big as the bar (it asks for its size), it stays where
// the student drags it, snaps to a screen edge dropped near one, and opens in
// the same place next time. With no saved place it starts bottom-centre.
const OVERLAY_START = { width: 300, height: 76 };
const SNAP_PX = 24;
const overlayPlaceFile = () => path.join(app.getPath('userData'), 'overlay-position.json');

function savedOverlayPlace() {
  try {
    const p = JSON.parse(fs.readFileSync(overlayPlaceFile(), 'utf8'));
    return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  } catch { return null; }
}

function saveOverlayPlace(bounds) {
  try { fs.writeFileSync(overlayPlaceFile(), JSON.stringify({ x: bounds.x, y: bounds.y })); } catch { /* not important */ }
}

/** Keep a rectangle inside the screen it is mostly on. */
function onScreen(rect) {
  const area = screen.getDisplayMatching(rect).workArea;
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return {
    x: Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - height)),
    width, height,
  };
}

/** Where the bar opens: its saved place, or bottom-centre of the main screen. */
function overlayStartBounds(size = OVERLAY_START) {
  const saved = savedOverlayPlace();
  if (saved) return onScreen({ x: saved.x, y: saved.y, ...size });
  const area = screen.getPrimaryDisplay().workArea;
  return onScreen({
    x: area.x + Math.round((area.width - size.width) / 2),
    y: area.y + area.height - size.height - 20,
    ...size,
  });
}

/**
 * Give the bar a new size without it jumping: the side nearest a screen edge
 * stays put (a bar on the right grows leftwards, one at the bottom grows
 * upwards), and a centred bar stays centred.
 */
function resizeOverlay(width, height) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const b = overlayWindow.getBounds();
  if (b.width === width && b.height === height) return;
  const area = screen.getDisplayMatching(b).workArea;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  let x;
  if (Math.abs(cx - (area.x + area.width / 2)) < 60) x = Math.round(cx - width / 2);
  else x = cx > area.x + area.width / 2 ? b.x + b.width - width : b.x;
  const y = cy > area.y + area.height / 2 ? b.y + b.height - height : b.y;
  overlayWindow.setBounds(onScreen({ x, y, width, height }));
}

/** After a drag: snap to a screen edge it was dropped near, and remember it. */
function settleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const b = overlayWindow.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  let { x, y } = b;
  if (x - area.x < SNAP_PX) x = area.x;
  if (area.x + area.width - (x + b.width) < SNAP_PX) x = area.x + area.width - b.width;
  if (y - area.y < SNAP_PX) y = area.y;
  if (area.y + area.height - (y + b.height) < SNAP_PX) y = area.y + area.height - b.height;
  const settled = onScreen({ x, y, width: b.width, height: b.height });
  if (settled.x !== b.x || settled.y !== b.y) overlayWindow.setBounds(settled);
  saveOverlayPlace(settled);
}

function createOverlay() {
  const start = overlayStartBounds();
  const overlayW = start.width;
  const overlayH = start.height;
  const { x, y } = start;

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
      // The overlay keeps listening while hidden ("dismiss", Ctrl+Shift+A).
      // With throttling on, Chromium pauses its speech-detection loop in a
      // hidden window, so a recording never ends until the overlay is shown
      // again — minutes of audio that Gemini turns into invented sentences.
      backgroundThrottling: false,
    },
  });

  // Prevent overlay from appearing in Alt+Tab — use 'screen-saver' level
  // so it stays above ALL windows including fullscreen apps
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Dragged by its grip: snap and remember where it was put
  overlayWindow.on('moved', settleOverlay);

  // The overlay's own warnings and errors (a TTS watchdog firing, a mic that
  // won't open) used to stay in its hidden console; they go in the app log.
  overlayWindow.webContents.on('console-message', (event, legacyLevel, legacyMessage) => {
    const level = typeof event?.level === 'string' ? event.level : ['debug', 'info', 'warning', 'error'][legacyLevel] || 'info';
    const message = typeof event?.message === 'string' ? event.message : String(legacyMessage ?? '');
    if (level === 'warning') console.warn(`[Overlay] ${message}`);
    else if (level === 'error') console.error(`[Overlay] ${message}`);
  });

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

// Re-position (display may have changed) and show the overlay, then tell it
// to start listening. Shared by the shortcut toggle, the voice-restore path
// (HFI-1), the auto-show-on-boot timer, and second-instance relaunch, so all
// four ways the overlay can come back behave identically.
function showOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  // Where the student left it (or bottom-centre), still on a screen that exists
  const bounds = overlayWindow.getBounds();
  overlayWindow.setBounds(overlayStartBounds({ width: bounds.width, height: bounds.height }));

  // showInactive: don't steal focus from the app the user is voice-controlling.
  // Keystroke tools (send_system_keys, type) must land in THEIR app, not the overlay.
  overlayWindow.showInactive();

  // Pause wake detection while overlay is active
  if (wakeDetector) wakeDetector.pause();

  // Tell overlay to START listening (always start on show — never toggle,
  // toggling inverts state if the overlay was hidden while still active)
  overlayWindow.webContents.send('overlay-shown');
}

function toggleOverlay() {
  if (!overlayWindow) return;

  if (overlayWindow.isVisible()) {
    // Stop the mic BEFORE hiding — otherwise it keeps recording in the
    // hidden window and the listening state desyncs from visibility.
    overlayWindow.webContents.send('overlay-stop');
    overlayWindow.hide();
  } else {
    showOverlayWindow();
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
  // One voice at a time: each request waits for the one before it, and
  // "stop" drops everything still waiting.
  const speakNow = async (safeText) => {
    const sendTtsState = (state) => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('tts-state', state);
      }
    };

    // ── Primary: Edge neural TTS (network) ──
    try {
      const { join } = require('path');
      const { tmpdir } = require('os');
      const audioFile = join(tmpdir(), `ablespeak_tts_${Date.now()}.mp3`);

      await synthesizeToFile(safeText, audioFile, { voice: TTS_VOICE, timeoutMs: 10000 });

      sendTtsState('speaking');
      try {
        await playAudioFile(audioFile);
      } finally {
        sendTtsState('done');
      }

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
  };

  let ttsQueue = Promise.resolve();
  let ttsGeneration = 0;
  ipcMain.handle('speak-text', (_event, text) => {
    if (!text || typeof text !== 'string') return false;
    const generation = ttsGeneration;
    const turn = ttsQueue.then(() => (generation === ttsGeneration ? speakNow(text.slice(0, 500)) : false));
    ttsQueue = turn.catch(() => false);
    return turn;
  });

  // ── Stop any in-progress TTS playback (voice "stop"/"cancel" interrupt — Gap 4) ──
  ipcMain.handle('stop-tts', async () => {
    ttsGeneration++;
    if (currentTTSProcess) {
      // Killing the PowerShell playback child stops the audio immediately.
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

      const { text: userText, error: transcribeError, message: transcribeMessage } = await voiceRes.json();

      if (transcribeError === 'no_speech' || !userText) {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('overlay-error', { message: 'No speech detected' });
        }
        return;
      }

      if (transcribeError) {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('overlay-error', { message: transcribeMessage || transcribeError });
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
  ipcMain.on('overlay-resize', (_event, size) => {
    // As small as the round mic on its own (about 76 × 72 with its shadow room)
    const width = Math.max(56, Math.min(480, Math.round(Number(size?.width) || 0)));
    const height = Math.max(48, Math.min(420, Math.round(Number(size?.height) || 0)));
    resizeOverlay(width, height);
  });

  ipcMain.on('overlay-hide', () => {
    console.log('[Electron] Overlay asked to hide itself');
    if (overlayWindow && overlayWindow.isVisible()) {
      overlayWindow.hide();
      // Resume wake detection after cooldown
      if (wakeDetector) wakeDetector.resume();
    }
  });

  // Show overlay again — the voice-only recovery path after "dismiss" (HFI-1).
  // The renderer keeps listening while hidden and calls this once it hears the
  // wake phrase back from the server.
  ipcMain.on('overlay-show', () => {
    if (overlayWindow && !overlayWindow.isVisible()) {
      showOverlayWindow();
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
    {
      // Setup step: Chrome's "Load unpacked" needs this folder (docs/INSTALL-FOR-TEACHERS.md).
      label: 'Show Chrome Extension Folder',
      click: () => {
        const folder = app.isPackaged
          ? path.join(process.resourcesPath, 'chrome-extension')
          : path.join(__dirname, '..', 'chrome-integration-master');
        shell.openPath(folder);
      },
    },
    {
      // The first admin PIN can only be set from here (src/admin-pin.js), so a
      // student using the dashboard by voice can't make themselves admin.
      label: 'Set admin PIN…',
      click: async () => {
        try {
          const { openPinSetup } = await import('./src/admin-pin.js');
          openPinSetup();
        } catch (err) {
          console.error('[Electron] Could not open admin PIN setup:', err.message);
          return;
        }
        if (mainWindow) {
          mainWindow.loadURL(`${DASHBOARD_URL}/settings`).catch(() => {});
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      // On the admin's own computer: every page open with no PIN (src/admin-account.js).
      // Here and in Settings only, never by voice; refused on shared computers.
      label: 'Admin pages without a PIN…',
      click: async () => {
        try {
          const { adminAccountStatus, setAdminAccount } = await import('./src/admin-account.js');
          const status = adminAccountStatus();
          if (status.blocked) {
            await dialog.showMessageBox({ type: 'info', title: 'AbleSpeak', message: 'On this computer the admin pages need the PIN.', detail: status.reason });
            return;
          }
          const { response } = await dialog.showMessageBox({
            type: 'question',
            title: 'AbleSpeak',
            message: status.on
              ? `Every page is open without a PIN while "${status.account}" is signed in to Windows.`
              : `Open every page, including the admin pages, without a PIN while "${status.account}" is signed in to Windows?`,
            detail: 'Only for your own computer. On a computer other people use, keep using the PIN.',
            buttons: status.on ? ['Keep it on', 'Turn off'] : ['Turn on', 'Cancel'],
            defaultId: 0,
            cancelId: status.on ? 0 : 1,
          });
          const turnOn = !status.on && response === 0;
          const turnOff = status.on && response === 1;
          if (!turnOn && !turnOff) return;
          setAdminAccount(turnOn);
          console.log(`[Electron] Admin account ${turnOn ? 'on' : 'off'} for "${status.account}"`);
          if (mainWindow) {
            mainWindow.webContents.reload();
            mainWindow.show();
            mainWindow.focus();
          }
        } catch (err) {
          console.error('[Electron] Could not change the admin account:', err.message);
        }
      },
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

  // ── Auto-show overlay once someone is signed in (always-listening like dictation tools) ──
  // The dashboard opens on the sign-in page first; the voice bar starts when an
  // account signs in or the person chooses "Not now" (src/account.js), and hides
  // again on sign-out. Without sign-in set up, it starts straight away as before.
  // Ctrl+Shift+A and the tray still show it by hand at any time.
  let overlayAllowed = null;
  const checkOverlayAllowed = async () => {
    let allowed;
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/account/status`, { signal: AbortSignal.timeout(3000) });
      const status = res.ok ? await res.json() : null;
      allowed = !status || !status.configured || status.signedIn || status.skipped;
    } catch {
      setTimeout(checkOverlayAllowed, 2000); // server still starting
      return;
    }
    if (allowed !== overlayAllowed && overlayWindow && !overlayWindow.isDestroyed()) {
      const atStart = overlayAllowed === null;
      overlayAllowed = allowed;
      if (allowed) {
        showOverlayWindow();
        const b = overlayWindow.getBounds();
        console.log(`[Electron] Overlay auto-shown — always-listening mode (visible: ${overlayWindow.isVisible()}, at ${b.x},${b.y} ${b.width}×${b.height})`);
      } else if (atStart) {
        console.log('[Electron] Overlay waits for sign-in');
      } else {
        overlayWindow.webContents.send('overlay-stop');
        overlayWindow.hide();
        console.log('[Electron] Overlay hidden — signed out');
      }
    }
    setTimeout(checkOverlayAllowed, 2000);
  };
  setTimeout(checkOverlayAllowed, 3000); // Give the server + dashboard time to boot

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
