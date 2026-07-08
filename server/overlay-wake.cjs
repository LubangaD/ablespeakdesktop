/**
 * AbleSpeak Overlay — Wake Detection
 * 
 * Energy-based wake detection that monitors ambient audio levels and
 * triggers the overlay when speech-like energy is detected.
 * 
 * This is NOT keyword detection — it activates when any sustained
 * voice-level audio appears, providing a hands-free trigger for
 * users who cannot press keyboard shortcuts.
 * 
 * Uses a hidden BrowserWindow with Web Audio API for audio analysis.
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

class WakeDetector {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.onWake = options.onWake || (() => {});
    this.paused = false;
    this.window = null;
    this._pauseTimer = null;
    // Cooldown: don't re-trigger within 5s of overlay closing
    this.cooldownMs = options.cooldownMs || 5000;
  }

  /**
   * Start the wake detector — creates a hidden window that
   * listens to the microphone and reports energy levels.
   */
  start() {
    if (!this.enabled || this.window) return;

    this.window = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'wake-preload.cjs'),
      },
    });

    // Load minimal HTML that runs the audio monitor
    this.window.loadURL('data:text/html,' + encodeURIComponent(WAKE_HTML));

    // Listen for wake signals from the hidden window
    ipcMain.on('wake-detected', () => {
      if (!this.paused && this.enabled) {
        console.log('[WakeDetector] Speech energy detected — triggering overlay');
        this.pause(); // Pause until overlay is done
        this.onWake();
      }
    });

    this.window.on('closed', () => {
      this.window = null;
    });

    console.log('[WakeDetector] Started — monitoring for speech energy');
  }

  /**
   * Pause detection (e.g., while overlay is active).
   */
  pause() {
    this.paused = true;
    if (this._pauseTimer) clearTimeout(this._pauseTimer);
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('wake-pause');
    }
  }

  /**
   * Resume detection after a cooldown period.
   */
  resume() {
    if (this._pauseTimer) clearTimeout(this._pauseTimer);
    this._pauseTimer = setTimeout(() => {
      this.paused = false;
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('wake-resume');
      }
      console.log('[WakeDetector] Resumed listening for wake signal');
    }, this.cooldownMs);
  }

  /**
   * Enable/disable the detector.
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.pause();
    } else if (!this.window) {
      this.start();
    } else {
      this.resume();
    }
  }

  /**
   * Shutdown and cleanup.
   */
  destroy() {
    ipcMain.removeAllListeners('wake-detected');
    if (this._pauseTimer) clearTimeout(this._pauseTimer);
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }
}

// Minimal HTML for the wake detection window
const WAKE_HTML = `<!DOCTYPE html>
<html><head><title>AbleSpeak Wake</title></head>
<body>
<script>
(async () => {
  let paused = false;
  let stream = null;
  let analyser = null;
  let audioCtx = null;
  let rafId = null;

  // Energy detection config
  const ENERGY_THRESHOLD = 30;      // Average frequency energy to trigger
  const SUSTAINED_MS = 400;         // Must be sustained for this long
  const CHECK_INTERVAL_MS = 100;    // How often to check

  let aboveThresholdSince = null;

  async function startMonitoring() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });

      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);

      function check() {
        if (paused) {
          rafId = setTimeout(check, CHECK_INTERVAL_MS);
          return;
        }

        analyser.getByteFrequencyData(data);

        // Focus on speech frequencies (300Hz-3000Hz)
        // With fftSize=256, each bin = sampleRate/256 ≈ 187Hz
        // Bins 2-16 roughly cover 375Hz-3000Hz
        const speechBins = data.slice(2, 16);
        const avg = speechBins.reduce((a, b) => a + b, 0) / speechBins.length;

        if (avg >= ENERGY_THRESHOLD) {
          if (!aboveThresholdSince) {
            aboveThresholdSince = Date.now();
          } else if (Date.now() - aboveThresholdSince >= SUSTAINED_MS) {
            // Sustained speech-like energy detected!
            aboveThresholdSince = null;
            paused = true; // Auto-pause after trigger
            window.electronWake.detected();
          }
        } else {
          aboveThresholdSince = null;
        }

        rafId = setTimeout(check, CHECK_INTERVAL_MS);
      }

      check();
    } catch (err) {
      console.error('[Wake] Mic error:', err);
    }
  }

  // Listen for pause/resume from main process
  window.electronWake.onPause(() => { paused = true; });
  window.electronWake.onResume(() => { paused = false; aboveThresholdSince = null; });

  startMonitoring();
})();
</script>
</body></html>`;

module.exports = { WakeDetector };
