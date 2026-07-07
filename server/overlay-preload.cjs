/**
 * AbleSpeak Overlay — Preload Script
 * 
 * Bridges the overlay renderer to the Electron main process
 * using contextBridge for secure IPC communication.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send pre-transcribed text directly to AI (Web Speech API path — fast).
  // confidence: 0..1 from the recognizer, or null/undefined when unknown.
  sendText: (text, confidence) => {
    ipcRenderer.send('overlay-voice-text', { text, confidence: typeof confidence === 'number' ? confidence : null });
  },

  // Send recorded audio to main process for AI processing (Gemini fallback — slow)
  sendAudio: (base64, mimeType) => {
    ipcRenderer.send('overlay-voice-audio', { audio: base64, mimeType });
  },

  // Receive AI response from main process
  onResponse: (callback) => {
    ipcRenderer.on('overlay-response', (_event, data) => callback(data));
  },

  // Receive toggle-listen signal (from global shortcut)
  onToggleListen: (callback) => {
    ipcRenderer.on('toggle-listen', () => callback());
  },

  // Receive errors from main process
  onError: (callback) => {
    ipcRenderer.on('overlay-error', (_event, data) => callback(data));
  },

  // Hide the overlay window
  hideOverlay: () => {
    ipcRenderer.send('overlay-hide');
  },

  // Show the main dashboard window
  showDashboard: () => {
    ipcRenderer.send('show-dashboard');
  },
});
