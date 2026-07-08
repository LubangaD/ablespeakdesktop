/**
 * AbleSpeak Wake Detection — Preload Script
 * 
 * Bridges the hidden wake-detection window to the Electron main process.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronWake', {
  // Signal that speech energy was detected
  detected: () => {
    ipcRenderer.send('wake-detected');
  },

  // Listen for pause signal (overlay is active)
  onPause: (callback) => {
    ipcRenderer.on('wake-pause', () => callback());
  },

  // Listen for resume signal (overlay closed)
  onResume: (callback) => {
    ipcRenderer.on('wake-resume', () => callback());
  },
});
