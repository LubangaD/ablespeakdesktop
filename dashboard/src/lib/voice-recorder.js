/**
 * Recording phrases for "My voice" (server/src/voice-profile.js), the way the
 * voice bar hears commands: the same microphone settings (echo cancellation,
 * noise suppression, the person's own automatic gain), sent as 16 kHz WAV.
 *
 * A phrase starts when speech is heard and ends at a pause, so nobody has to
 * press anything between phrases. While a voice is set up, voice commands are
 * paused, so someone who uses AbleSpeak by voice alone still gets through.
 */

const PREROLL_CHUNKS = 4; // ~0.35 s kept from before the speech was heard

/** Float samples at `rate` → base64 16 kHz 16-bit mono WAV (the voice bar's filter: each sample averages what it covers). */
export function wavBase64(chunks, rate) {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const flat = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { flat.set(chunk, offset); offset += chunk.length; }
  const step = rate / 16000;
  const count = Math.floor(length / step);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.min(length, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += flat[j];
    samples[i] = Math.max(-1, Math.min(1, sum / (to - from))) * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  new Int16Array(buffer, 44).set(samples);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const rms = chunk => {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / chunk.length);
};

/**
 * Open the microphone. `onLevel(level)` is called about 12 times a second
 * (RMS, 0–1) for a level meter. Returns { recordPhrase, recordRoom, close }.
 */
export async function openVoiceMic({ autoGain = true, onLevel = () => {} } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: autoGain, sampleRate: 16000 },
  });
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  let listener = null;
  node.onaudioprocess = e => {
    const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
    const level = rms(chunk);
    onLevel(level);
    listener?.(chunk, level);
  };
  source.connect(node);
  node.connect(ctx.destination); // plays silence; Chromium only runs a connected node
  const chunkMs = (4096 / ctx.sampleRate) * 1000;

  // Resolves when `listen(chunk, level)` returns a result; null if `signal` aborts
  const capture = (listen, signal) => new Promise(resolve => {
    const stop = value => { listener = null; signal?.removeEventListener('abort', aborted); resolve(value); };
    const aborted = () => stop(null);
    if (signal?.aborted) return stop(null);
    signal?.addEventListener('abort', aborted);
    listener = (chunk, level) => { const done = listen(chunk, level); if (done !== undefined) stop(done); };
  });

  return {
    /**
     * One phrase: waits up to `waitMs` for speech, then records until a pause
     * of `pauseMs` (or `maxMs`). Resolves { heard: false } if nothing was said,
     * { heard: true, wav } otherwise, or null if stopped.
     */
    recordPhrase({ waitMs = 8000, pauseMs = 1000, maxMs = 15000, signal } = {}) {
      const before = [];
      const kept = [];
      const quiet = [];
      let floor = 0;
      let loudRun = 0;
      let speaking = false;
      let silentMs = 0;
      let waitedMs = 0;
      let spokenMs = 0;
      return capture((chunk, level) => {
        // The room's own level, from the first moments; never more than a soft
        // voice, in case the person started speaking straight away
        if (!speaking && quiet.length < 3) { quiet.push(level); floor = Math.min(...quiet, 0.01); }
        if (!speaking) {
          before.push(chunk);
          if (before.length > PREROLL_CHUNKS) before.shift();
          loudRun = level >= Math.max(0.01, floor * 3) ? loudRun + 1 : 0;
          if (loudRun >= 2) { speaking = true; kept.push(...before); return undefined; }
          waitedMs += chunkMs;
          return waitedMs >= waitMs ? { heard: false } : undefined;
        }
        kept.push(chunk);
        spokenMs += chunkMs;
        silentMs = level < Math.max(0.006, floor * 1.8) ? silentMs + chunkMs : 0;
        if (silentMs >= pauseMs || spokenMs >= maxMs) return { heard: true, wav: wavBase64(kept, ctx.sampleRate) };
        return undefined;
      }, signal);
    },

    /** `seconds` of the room as it is; `onProgress(secondsSoFar)`. Null if stopped. */
    recordRoom(seconds, { onProgress = () => {}, signal } = {}) {
      const kept = [];
      let ms = 0;
      return capture(chunk => {
        kept.push(chunk);
        ms += chunkMs;
        onProgress(Math.min(seconds, ms / 1000));
        return ms >= seconds * 1000 ? wavBase64(kept, ctx.sampleRate) : undefined;
      }, signal);
    },

    close() {
      listener = null;
      try { source.disconnect(); node.disconnect(); } catch { /* already gone */ }
      node.onaudioprocess = null;
      stream.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

/** Say something with the computer's own voice; resolves when it has finished (or could not). */
export function sayAloud(text) {
  return new Promise(resolve => {
    const synth = window.speechSynthesis;
    if (!synth || !text) return resolve();
    // Never wait forever: some voices never report that they ended
    const timer = setTimeout(resolve, Math.max(2500, text.length * 110));
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.onend = utterance.onerror = () => { clearTimeout(timer); resolve(); };
    synth.cancel();
    synth.speak(utterance);
  });
}
