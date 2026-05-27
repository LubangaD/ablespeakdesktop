/**
 * AbleSpeak Desktop — Electron Main Process
 * 
 * Boots the Express + WebSocket server, then opens a native
 * BrowserWindow pointing at the dashboard.
 * 
 * Using .cjs because Electron's main script must be CommonJS,
 * while the server code is ESM. We dynamically import() the server.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Config ──
const PORT = parseInt(process.env.GATEWAY_PORT || '3001');
const DASHBOARD_URL = `http://localhost:${PORT}`;

let mainWindow = null;
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
// Web Speech API needs these to work properly in Electron
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI');

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

// ── Boot Server ──
async function startServer() {
  // Set working directory so dotenv/.env resolves correctly
  process.chdir(path.join(__dirname));

  // Dynamic import of the ESM server entry
  try {
    await import('./src/index.js');
    serverReady = true;
    console.log('[Electron] Server module loaded');
  } catch (err) {
    console.error('[Electron] Failed to start server:', err);
  }
}

// ── Create Window ──
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

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
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
app.whenReady().then(async () => {
  // Load the AbleSpeak logo
  loadAppIcon();

  // Start the Express server first
  await startServer();

  // Then create the window and tray
  createWindow();
  createTray();

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

app.on('before-quit', () => {
  app.isQuitting = true;
});
