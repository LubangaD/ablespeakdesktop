/**
 * The voice model's own thread (voice-profile.js). It turns 16 kHz speech
 * into a voiceprint: 192 numbers from TitaNet-small, run by sherpa-onnx. A
 * check takes 40–75 ms, and it never holds up the rest of AbleSpeak.
 *
 * In: { id, samples: Float32Array }.
 * Out: { ready: true, dim } once loaded, or { failed: message } if loading
 * failed; then { id, embedding } or { id, error } per request.
 */
const { parentPort, workerData } = require('worker_threads');

let extractor = null;
try {
  const sherpa = require('sherpa-onnx-node');
  extractor = new sherpa.SpeakerEmbeddingExtractor({ model: workerData.modelPath, numThreads: 1, debug: 0 });
  parentPort.postMessage({ ready: true, dim: extractor.dim });
} catch (err) {
  parentPort.postMessage({ failed: err.message });
}

parentPort.on('message', ({ id, samples }) => {
  if (!extractor) {
    parentPort.postMessage({ id, error: 'the voice model is not loaded' });
    return;
  }
  try {
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    // Electron allows no external buffers, so the result is copied out (false)
    const embedding = Float32Array.from(extractor.compute(stream, false));
    parentPort.postMessage({ id, embedding }, [embedding.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
