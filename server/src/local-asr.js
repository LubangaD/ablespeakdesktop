/**
 * Speech recognition on this computer, so commands don't wait on the
 * internet: whisper.cpp's whisper-server running CDLI's Whisper small model,
 * fine-tuned on Kenyan English and non-standard speech.
 *
 * One server process stays loaded while AbleSpeak runs (about 350–570 MB in
 * use, 1 GB reserved). Each clip is a 16 kHz mono WAV the overlay records
 * alongside the clip it sends Gemini. Clips are sent one at a time.
 *
 * If the engine stops, it is started again (after 2, 4, then 6 s; after that
 * once a minute), and a crash is forgiven once it has run well for a minute.
 * An engine that stops answering is restarted the same way.
 *
 * Files (tools/convert-whisper-to-ggml.mjs makes the model file):
 *   development: server/vendor/local-asr/
 *   installed:   resources/local-asr/  (extraResources in package.json)
 *     engine/arm64/Release/whisper-server.exe   (Windows on Arm)
 *     engine/x64/Release/whisper-server.exe
 *     cdli-small/ggml-model-q8_0.bin, or cdli-small/ggml-model.bin
 */
import { spawn, execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { createServer } from 'net';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Smallest first: the 8-bit copy loads and runs faster with the same words
const MODEL_FILES = ['cdli-small/ggml-model-q8_0.bin', 'cdli-small/ggml-model.bin'];
// English, no timestamps, no temperature fallback
const ENGINE_FLAGS = ['-l', 'en', '-nt', '-nf'];
const START_TIMEOUT_MS = 60000;
const QUICK_RESTARTS = 3;          // after 2, 4 and 6 s; then once a minute
const SLOW_RETRY_MS = 60000;
const HEALTHY_AFTER_MS = 60000;    // ready this long, and earlier crashes are forgiven
const STALE_AFTER_MS = 8000;       // a clip that waited this long for its turn is out of date
const HUNG_AFTER_TIMEOUTS = 2;     // unanswered clips in a row before the engine is restarted

// Each AbleSpeak records its engine's process id in a file named after itself
const PID_PREFIX = 'ablespeak-local-asr-';
const pidFile = () => join(os.tmpdir(), `${PID_PREFIX}${process.pid}.pid`);

// Markers Whisper writes for sound that isn't speech: [BLANK_AUDIO], (music), *cough*
const NON_SPEECH_RE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g;
// What Whisper says for noise alone (it learned from film subtitles)
const NOISE_PHRASES_RE = /^(?:you|thank you(?: (?:very|so) much)?|thanks for watching|bye(?:[ -]bye)?|subtitles by.*)[.!?]*$/i;

const wordsOf = text => String(text || '').toLowerCase().match(/[a-z0-9']+/g) || [];

/**
 * The words in a local transcript, or '' when it heard no speech. Whisper
 * sometimes just repeats its hint words (`prompt`) for a clip with no speech.
 */
export function cleanLocalText(raw, prompt = '') {
  const text = String(raw || '').replace(NON_SPEECH_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!/[a-z0-9]/i.test(text) || NOISE_PHRASES_RE.test(text)) return '';
  const said = wordsOf(text);
  if (prompt && said.length >= 2) {
    const hints = new Set(wordsOf(prompt));
    if (said.every(word => hints.has(word))) return '';
  }
  return text;
}

/**
 * How much of Whisper's 30-second window to work through for a clip: its own
 * length and a little more, but never under 512 (about 10 s), where the words
 * stay as good as the full window. A 3-second command then encodes in about
 * 0.2 s instead of 0.7 s. Always a multiple of 256 (or the full 1500): other
 * sizes such as 640 made clips of 9–28 s come back wrong, depending on the
 * clip before (stress test, 15 Oct 2026). Turning the engine's flash attention
 * off also cured that, but made every command about 35% slower.
 */
export function audioContext(wavBytes) {
  const frames = Math.ceil(Math.max(0, wavBytes - 44) / 32000 * 50); // 16 kHz 16-bit: 50 frames a second
  return Math.min(1500, Math.max(512, Math.ceil((frames + 64) / 256) * 256));
}

/**
 * What is in a WAV clip: its format and how loud it is (RMS, 0–1). Throws
 * unless it is the 16 kHz mono 16-bit sound the engine reads.
 */
export function inspectWav(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV clip');
  }
  let format = null, data = null;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    at += 8;
    if (id === 'fmt ' && size >= 16) {
      format = { type: wav.readUInt16LE(at), channels: wav.readUInt16LE(at + 2), rate: wav.readUInt32LE(at + 4), bits: wav.readUInt16LE(at + 14) };
    }
    if (id === 'data') { data = wav.subarray(at, Math.min(wav.length, at + size)); break; }
    at += size + (size % 2);
  }
  if (!format || !data || format.type !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16) {
    throw new Error('not 16 kHz mono 16-bit sound');
  }
  let sum = 0;
  const samples = Math.floor(data.length / 2);
  for (let i = 0; i < samples; i++) sum += (data.readInt16LE(i * 2) / 32768) ** 2;
  return { seconds: samples / 16000, rms: samples ? Math.sqrt(sum / samples) : 0 };
}

// Quieter than this all the way through is silence: the engine isn't asked,
// because Whisper invents words for silence ("you", "Thank you.")
const SILENT_RMS = 0.0005;

/** How long a clip may take: 4 s, and more for a long one (78 s took 7.7 s). */
export function requestTimeout(wavBytes) {
  return Math.round(4000 + Math.max(0, wavBytes - 44) / 32000 * 200);
}

/** Where the engine and model are: next to the installed app, or in the source tree. */
export function localAsrDir() {
  const installed = process.resourcesPath ? join(process.resourcesPath, 'local-asr') : null;
  if (installed && existsSync(installed)) return installed;
  return join(__dirname, '..', 'vendor', 'local-asr');
}

// Electron runs as x64 under emulation on Arm laptops, but the engine is its
// own process and runs natively there.
function isArmWindows() {
  return process.arch === 'arm64' || /\bARM/i.test(process.env.PROCESSOR_IDENTIFIER || '');
}

/** Engine builds to try, best first. */
export function enginePaths(dir, { arm = isArmWindows() } = {}) {
  const exe = arch => join(dir, 'engine', arch, 'Release', 'whisper-server.exe');
  return (arm ? [exe('arm64'), exe('x64')] : [exe('x64')]).filter(path => existsSync(path));
}

export function modelPath(dir) {
  return MODEL_FILES.map(file => join(dir, file)).find(path => existsSync(path)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// End a process only if it is still an engine (process ids are reused).
function endIfEngine(pid) {
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
      if (!err && /whisper-server\.exe/i.test(out)) {
        try { process.kill(pid); } catch {}
      }
      resolve();
    });
  });
}

// An engine left behind when its AbleSpeak crashed keeps hundreds of MB in
// memory. End those, but never the engine of an AbleSpeak that is still running.
export async function endLeftoverEngines() {
  let files = [];
  try { files = readdirSync(os.tmpdir()).filter(f => f.startsWith(PID_PREFIX) && f.endsWith('.pid')); } catch { return; }
  for (const file of files) {
    const owner = Number(file.slice(PID_PREFIX.length, -'.pid'.length));
    if (owner !== process.pid && isRunning(owner)) continue;
    const path = join(os.tmpdir(), file);
    let pid = 0;
    try { pid = Number(readFileSync(path, 'utf8')); } catch {}
    rmSync(path, { force: true });
    if (Number.isInteger(pid) && pid > 0) await endIfEngine(pid);
  }
}

export class LocalAsr {
  /**
   * `onChange(state)` is called whenever the state changes (the voice bar
   * only sends WAV audio while it is 'ready').
   */
  constructor({ dir = localAsrDir(), threads = Math.max(2, Math.min(8, os.cpus().length - 2)), onChange } = {}) {
    this.dir = dir;
    this.threads = threads;
    this.onChange = onChange || (() => {});
    this.state = 'off';      // off → starting → ready; or failed (retrying) / missing
    this.engine = null;      // path of the whisper-server.exe in use
    this.model = null;
    this.error = null;
    this._child = null;
    this._url = null;
    this._starting = null;
    this._stopping = false;
    this._restarts = 0;      // crashes in a row
    this._readySince = 0;
    this._working = null;    // the engine build that started; restarts use only it
    this._retryTimer = null;
    this._timeouts = 0;
    this._queue = Promise.resolve();
  }

  get ready() { return this.state === 'ready'; }

  status() {
    const engine = this.engine ? basename(dirname(dirname(this.engine))) : null; // arm64 / x64
    return { state: this.state, engine, model: this.model ? basename(this.model) : null, error: this.error };
  }

  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    try { this.onChange(state); } catch (err) { console.warn('[LocalASR] Telling AbleSpeak about the change failed:', err.message); }
  }

  _retryLater(ms) {
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => { if (!this._stopping) this.start(); }, ms);
    this._retryTimer.unref?.();
  }

  _kill() {
    const child = this._child;
    this._child = null;
    if (child) { try { child.kill(); } catch {} }
  }

  /** Start the engine once; resolves true when it is ready for clips. */
  start() {
    if (this.ready) return Promise.resolve(true);
    if (!this._starting) {
      this._starting = this._start().finally(() => { this._starting = null; });
    }
    return this._starting;
  }

  async _start() {
    this._stopping = false;
    clearTimeout(this._retryTimer);
    this.model = modelPath(this.dir);
    const engines = this._working && existsSync(this._working) ? [this._working] : enginePaths(this.dir);
    if (!this.model || !engines.length) {
      this.error = !this.model ? 'model file not found' : 'engine not found';
      console.warn(`[LocalASR] Not available: ${this.error} (${this.dir})`);
      this._setState('missing');
      return false;
    }
    this._setState('starting');
    await endLeftoverEngines();
    for (const exe of engines) {
      if (this._stopping) break;
      try {
        const started = Date.now();
        await this._launch(exe);
        if (this._stopping) { this._kill(); break; }
        this._working = exe;
        this.engine = exe;
        this.error = null;
        this._timeouts = 0;
        this._readySince = Date.now();
        console.log(`[LocalASR] Ready in ${Date.now() - started} ms (${this.status().engine} engine, ${this.threads} threads)`);
        this._setState('ready');
        return true;
      } catch (err) {
        if (this._stopping) break;
        console.warn(`[LocalASR] ${exe} did not start: ${err.message}`);
        this.error = err.message;
      }
    }
    if (this._stopping) {
      this._setState('off');
      return false;
    }
    this._scheduleRestart();
    return false;
  }

  // After 2, 4 and 6 s; after that, once a minute until it works
  _scheduleRestart() {
    this._restarts++;
    if (this._restarts <= QUICK_RESTARTS) {
      this._setState('starting');
      this._retryLater(2000 * this._restarts);
    } else {
      console.warn(`[LocalASR] Failed ${this._restarts} times in a row; trying again in ${SLOW_RETRY_MS / 1000} s`);
      this._setState('failed');
      this._retryLater(SLOW_RETRY_MS);
    }
  }

  async _launch(exe) {
    const port = await freePort();
    if (this._stopping) throw new Error('stopped');
    const args = ['-m', this.model, '--host', '127.0.0.1', '--port', String(port),
      '-t', String(this.threads), ...ENGINE_FLAGS];
    const child = spawn(exe, args, { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this._child = child;
    this._url = `http://127.0.0.1:${port}`;
    // Recorded at once, so an engine still loading when AbleSpeak is killed is found next time
    try { writeFileSync(pidFile(), String(child.pid)); } catch {}
    const recent = [];

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => { child.kill(); finish(new Error('timed out loading the model')); }, START_TIMEOUT_MS);
      // The engine holds back its "listening at" line when its output is a
      // pipe, so it is ready when it answers over HTTP (after the model loads).
      const poll = setInterval(() => {
        fetch(this._url, { signal: AbortSignal.timeout(1000) }).then(() => finish(), () => {});
      }, 250);
      // Always read its output: a full pipe would stall the engine
      const onLine = chunk => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue;
          recent.push(line);
          if (recent.length > 20) recent.shift();
        }
      };
      child.stdout.on('data', onLine);
      child.stderr.on('data', onLine);
      child.once('error', err => finish(err));
      child.once('exit', code => {
        if (this._child === child) this._child = null;
        rmSync(pidFile(), { force: true });
        finish(new Error(`exited with code ${code}: ${recent.slice(-3).join(' | ')}`));
      });
    });

    child.once('exit', code => {
      if (this._stopping || this.engine !== exe) return;
      if (this._child === child) this._child = null;
      this.error = `engine stopped (code ${code})`;
      console.warn(`[LocalASR] Engine stopped unexpectedly (code ${code}): ${recent.slice(-3).join(' | ')}`);
      // A crash after a good minute is a fresh problem, not part of a crash loop
      if (Date.now() - this._readySince >= HEALTHY_AFTER_MS) this._restarts = 0;
      this._scheduleRestart();
    });
  }

  /**
   * Transcribe one clip: a 16 kHz mono WAV, base64-encoded. Clips are sent one
   * at a time; one that waited too long for its turn is not sent at all.
   * Returns { text, raw, ms } ('' text = no speech), or { error }.
   */
  transcribe(wavBase64, { prompt = '' } = {}) {
    const queued = Date.now();
    const turn = this._queue.then(() => this._transcribeNow(wavBase64, prompt, queued));
    this._queue = turn.catch(() => {});
    return turn;
  }

  async _transcribeNow(wavBase64, prompt, queued) {
    if (!this.ready) return { error: 'not_ready' };
    if (Date.now() - queued > STALE_AFTER_MS) return { error: 'stale' };
    if (typeof wavBase64 !== 'string' || !wavBase64) return { error: 'no WAV audio' };
    const wav = Buffer.from(wavBase64, 'base64');
    let sound;
    try { sound = inspectWav(wav); } catch (err) { return { error: err.message }; }
    if (sound.rms < SILENT_RMS) return { text: '', raw: '', ms: Date.now() - queued, silent: true };
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('audio_ctx', String(audioContext(wav.length)));
    if (prompt) form.append('prompt', prompt);
    try {
      const res = await fetch(`${this._url}/inference`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(requestTimeout(wav.length)),
      });
      const body = await res.json().catch(() => ({}));
      this._timeouts = 0;
      if (!res.ok || body.error) return { error: body.error || `HTTP ${res.status}` };
      const raw = String(body.text || '').trim();
      return { text: cleanLocalText(raw, prompt), raw, ms: Date.now() - queued };
    } catch (err) {
      if (err.name !== 'TimeoutError') return { error: err.message };
      // The engine keeps working on a clip it was too slow for; twice in a
      // row means it is stuck, so start it again.
      if (++this._timeouts >= HUNG_AFTER_TIMEOUTS && this._child) {
        console.warn('[LocalASR] The engine stopped answering; restarting it');
        this._timeouts = 0;
        try { this._child.kill(); } catch {}
      }
      return { error: 'timeout' };
    }
  }

  stop() {
    this._stopping = true;
    clearTimeout(this._retryTimer);
    this._kill();
    rmSync(pidFile(), { force: true });
    if (this.state !== 'missing') this._setState('off');
  }
}
