/**
 * AbleSpeak Overlay — Preload Script
 * 
 * Bridges the overlay renderer to the Electron main process
 * using contextBridge for secure IPC communication.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Capture the desktop screen as base64 JPEG (for Gemini Vision)
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  // Speak text aloud via system TTS (bypasses broken browser speechSynthesis)
  speak: (text) => ipcRenderer.invoke('speak-text', text),

  // Stop any in-progress TTS playback (voice "stop"/"cancel" interrupt)
  stopTTS: () => ipcRenderer.invoke('stop-tts'),

  // Receive TTS playback state ('speaking' | 'done') — used to mute the mic
  // while audio plays, preventing the speaker→mic feedback loop.
  onTTSState: (callback) => {
    ipcRenderer.on('tts-state', (_event, state) => callback(state));
  },

  // Send pre-transcribed text directly to AI (Web Speech API path — fast)
  sendText: (text) => {
    ipcRenderer.send('overlay-voice-text', { text });
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

  // Overlay was shown via shortcut — always START listening
  onShown: (callback) => {
    ipcRenderer.on('overlay-shown', () => callback());
  },

  // Overlay is about to hide — always STOP the mic
  onStop: (callback) => {
    ipcRenderer.on('overlay-stop', () => callback());
  },

  // Receive the actual registered global shortcut (may be a fallback)
  onShortcut: (callback) => {
    ipcRenderer.on('overlay-shortcut', (_event, data) => callback(data));
  },

  // Receive errors from main process
  onError: (callback) => {
    ipcRenderer.on('overlay-error', (_event, data) => callback(data));
  },

  // Receive configuration updates (silence timeout, continuous mode, etc.)
  onConfig: (callback) => {
    ipcRenderer.on('overlay-config', (_event, data) => callback(data));
  },

  // Receive wake detection trigger (from energy-based detector)
  onWake: (callback) => {
    ipcRenderer.on('overlay-wake', () => callback());
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
