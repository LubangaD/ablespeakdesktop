/**
 * "Only my voice", Phases 1 and 2 (19 Oct 2026). Each person gets a
 * voiceprint, made on this computer from about twenty short phrases they
 * read, and every voice command gets a score: how much it sounds like them.
 *
 * Measuring only, for now: nothing is ignored because of the score. Each
 * person's lock is turned on later (Phase 3), once their own scores show where
 * to draw the line. The trial found that line moves with the noise: 0.51 in a
 * quiet room, 0.17–0.30 with loud talk around.
 *
 * The first person to finish becomes the computer's owner. After that, adding
 * someone else's voice needs the owner (signed in to Windows) or an admin.
 *
 * Kenya's Data Protection Act counts voice recognition as biometric data, so:
 * - consent comes first, from a parent or guardian under 18;
 * - the voiceprint never leaves this computer, and is kept encrypted with
 *   Windows' own protection, like the sign-in;
 * - the recordings are dropped once it is made;
 * - it can be deleted at any time.
 *
 * The model is TitaNet-small (NVIDIA NeMo, 40 MB), run by sherpa-onnx in its
 * own thread (voiceprint-worker.cjs), at about 40–75 ms a check on a
 * classroom laptop. The trial made no mistakes in a quiet room, even on 1 s
 * clips. In loud talk (10 dB), 38% of the person's own 1 s commands scored
 * low, and 22% once half the enrollment had room sound mixed in. That is why
 * there is an optional half minute of the person's usual room.
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const VOICE_MODEL = {
  id: 'titanet-small',
  file: 'nemo_en_titanet_small.onnx',
  bytes: 40257283,
  sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e',
  // From sherpa-onnx's own releases; the misspelt tag name is theirs
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
};
export const SAMPLE_RATE = 16000;
export const VOICE_CONSENT_VERSION = 1;

/**
 * What the person reads: short commands, like the ones they will say, then
 * two sentences. Nothing personal: the phrases are the same for everyone.
 */
export const ENROLL_PHRASES = [
  'AbleSpeak',
  'Scroll down',
  'Go back',
  'Open Google Chrome',
  'Search for the weather in Nairobi',
  'Click the first link',
  'Read this page',
  'Start dictation',
  'Open a new tab',
  'Pause the video',
  'Open my email',
  'Zoom in',
  'Type hello, how are you',
  'Close this window',
  'What time is it',
  'Scroll up a little',
  'Go to the next page',
  'Open Microsoft Word',
  'Show me what I can say',
  'Turn the volume down',
  'I can use this computer with my voice, without a keyboard or a mouse.',
  'Every morning I check my messages, and then I read the news.',
];
// Enough for a steady voiceprint; a phrase someone can't say can be skipped
export const MIN_CLIPS = 12;
/**
 * At or above this, a command "sounds like" the person. It is provisional:
 * nothing is ignored by it yet, and each person's own scores will set their
 * line in Phase 3.
 */
export const MATCH_THRESHOLD = 0.45;

const FRAME = 320; // 20 ms
const GAP_FRAMES = 15; // a pause shorter than 300 ms is still the same stretch of speech
const SPEECH_FLOOR = 0.004; // quieter than this is never speech
const QUIET_LEVEL = 0.01; // speech this soft gives a poor voiceprint
const MIN_VOICED_SECONDS = 0.3;
const MAX_CLIP_SECONDS = 20;
const MIN_ROOM_SECONDS = 10;
const MAX_ROOM_SECONDS = 60;
const QUIET_ROOM = 0.002; // a room this quiet adds nothing to mix in
const ROOM_SNR_DB = 10; // the room is mixed in no louder than this below the voice
const MIN_FIT = 0.25; // a phrase this unlike the others was probably someone (or something) else
const EMBED_TIMEOUT_MS = 5000;
// An enrollment untouched this long was left: voice commands work again
export const HOLD_MS = 45000;

/** The voice model's folder: next to the installed app, or in the source tree. */
export function voiceModelDir() {
  const installed = process.resourcesPath ? join(process.resourcesPath, 'voice-lock') : null;
  if (installed && existsSync(installed)) return installed;
  return join(__dirname, '..', 'vendor', 'voice-lock');
}

/** 16 kHz mono 16-bit WAV (base64 or bytes) → samples from -1 to 1. Throws for anything else. */
export function samplesFromWav(wav) {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(String(wav), 'base64');
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV clip');
  }
  let format = null, data = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    at += 8;
    if (id === 'fmt ' && size >= 16) {
      format = { type: buf.readUInt16LE(at), channels: buf.readUInt16LE(at + 2), rate: buf.readUInt32LE(at + 4), bits: buf.readUInt16LE(at + 14) };
    }
    if (id === 'data') { data = buf.subarray(at, Math.min(buf.length, at + size)); break; }
    at += size + (size % 2);
  }
  if (!format || !data || format.type !== 1 || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) {
    throw new Error('not 16 kHz mono 16-bit sound');
  }
  const samples = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return samples;
}

function frameLevels(samples) {
  const levels = new Float32Array(Math.floor(samples.length / FRAME));
  for (let f = 0; f < levels.length; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += samples[i] * samples[i];
    levels[f] = Math.sqrt(sum / FRAME);
  }
  return levels;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * Where the speech is in a clip: the frames clearly louder than its quiet
 * parts. `start` and `end` are sample positions; `level` is the speech's
 * typical loudness (RMS) and `floor` the room's.
 */
export function findSpeech(samples) {
  const levels = frameLevels(samples);
  const floor = quantile(levels, 0.1);
  const line = Math.max(SPEECH_FLOOR, floor * 3, quantile(levels, 0.95) * 0.1);
  const voiced = [];
  let first = -1, last = -1;
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] < line) continue;
    voiced.push(levels[f]);
    if (first < 0) first = f;
    last = f;
  }
  return {
    start: first < 0 ? 0 : first * FRAME,
    end: last < 0 ? 0 : (last + 1) * FRAME,
    voicedSeconds: (voiced.length * FRAME) / SAMPLE_RATE,
    level: quantile(voiced, 0.5),
    floor,
  };
}

/**
 * The clip's main stretch of speech, with a little either side: the loudest
 * continuous stretch, pauses under 300 ms joined. Other people talking before
 * or after the person (the voice bar's clips start early and end with a
 * pause) then stay out of the voiceprint. In the 19 Oct check, cutting from
 * the first loud moment to the last instead put the person's typical score in
 * loud talk at 0.26; this puts it at 0.50, and a quiet room's is unchanged.
 */
export function trimToSpeech(samples, { ratio = 0.4, margin = 0.1 } = {}) {
  const levels = frameLevels(samples);
  const line = Math.max(SPEECH_FLOOR, quantile(levels, 0.1) * 3, quantile(levels, 0.9) * ratio);
  let best = null, stretch = null;
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] < line) continue;
    if (stretch && f - stretch.end <= GAP_FRAMES) {
      stretch.end = f;
      stretch.energy += levels[f] ** 2;
    } else {
      stretch = { start: f, end: f, energy: levels[f] ** 2 };
    }
    if (!best || stretch.energy > best.energy) best = stretch;
  }
  if (!best) return samples.subarray(0, 0);
  const pad = Math.round(margin * SAMPLE_RATE);
  return samples.subarray(Math.max(0, best.start * FRAME - pad), Math.min(samples.length, (best.end + 1) * FRAME + pad));
}

/**
 * Whether a phrase is good enough to learn from. `problem` says what to ask
 * for: 'not_heard', 'quiet', 'loud' (distorted), 'noisy' (the voice is hardly
 * above the room) or 'long'.
 */
export function clipQuality(samples) {
  const seconds = samples.length / SAMPLE_RATE;
  if (seconds > MAX_CLIP_SECONDS) return { ok: false, problem: 'long', seconds };
  const speech = findSpeech(samples);
  const facts = { seconds, voicedSeconds: speech.voicedSeconds, level: speech.level };
  if (speech.voicedSeconds < MIN_VOICED_SECONDS) return { ok: false, problem: 'not_heard', ...facts };
  if (speech.level < QUIET_LEVEL) return { ok: false, problem: 'quiet', ...facts };
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= 0.99) clipped++;
  if (clipped / samples.length > 0.002) return { ok: false, problem: 'loud', ...facts };
  if (speech.floor > 0 && speech.level / speech.floor < 2) return { ok: false, problem: 'noisy', ...facts };
  return { ok: true, ...facts };
}

/**
 * The phrase as it would sound in the person's room: the room's own sound
 * added, no louder than ROOM_SNR_DB below the voice (and never louder than it
 * was recorded). `offset` picks where in the room recording to start.
 */
export function mixRoom(samples, room, { offset = 0, snrDb = ROOM_SNR_DB } = {}) {
  const out = Float32Array.from(samples);
  if (!room?.length) return out;
  const voice = findSpeech(samples).level;
  let sum = 0;
  for (let i = 0; i < room.length; i++) sum += room[i] * room[i];
  const roomLevel = Math.sqrt(sum / room.length);
  if (!voice || roomLevel < QUIET_ROOM) return out;
  const gain = Math.min(1, voice / (roomLevel * 10 ** (snrDb / 20)));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(-1, Math.min(1, out[i] + gain * room[(offset + i) % room.length]));
  }
  return out;
}

export function normalize(vector) {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const length = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, x => x / length);
}

/** Cosine similarity of two voiceprints already of length 1: 1 is the same voice, 0 unrelated. */
export function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** One voiceprint from many: the average direction of the phrases' own prints. */
export function averagePrint(embeddings) {
  const sum = new Float32Array(embeddings[0].length);
  for (const e of embeddings) {
    const unit = normalize(e);
    for (let i = 0; i < sum.length; i++) sum[i] += unit[i];
  }
  return normalize(sum);
}

/**
 * How the person's own phrases score against a voiceprint made without each
 * one: the closest thing to their real commands' scores, before there are any.
 */
export function selfScores(embeddings) {
  if (embeddings.length < 2) return null;
  const units = embeddings.map(e => normalize(e));
  const sum = new Float32Array(units[0].length);
  for (const u of units) for (let i = 0; i < sum.length; i++) sum[i] += u[i];
  const scores = units.map(u => similarity(u, normalize(sum.map((x, i) => x - u[i])))).sort((a, b) => a - b);
  return { lowest: round(scores[0]), median: round(scores[Math.floor(scores.length / 2)]), count: scores.length };
}

const round = (x, places = 3) => Math.round(x * 10 ** places) / 10 ** places;
const key = id => String(id);

/**
 * The voice model, in its own thread, started on first use. `state`:
 * 'missing' (no model file), 'idle', 'starting', 'ready' or 'failed'.
 */
export function createVoiceModel({
  modelPath = join(voiceModelDir(), VOICE_MODEL.file),
  workerPath = join(__dirname, 'voiceprint-worker.cjs'),
} = {}) {
  let state = existsSync(modelPath) ? 'idle' : 'missing';
  let error = state === 'missing' ? 'the voice model is not on this computer' : null;
  let worker = null;
  let starting = null;
  let seq = 0;
  const waiting = new Map();

  function fail(message) {
    if (state === 'failed') return;
    state = 'failed';
    error = message;
    console.warn(`[Voice lock] The voice model stopped: ${message}`);
    for (const job of waiting.values()) job.reject(new Error(message));
    waiting.clear();
    worker?.terminate().catch(() => {});
    worker = null;
  }

  function start() {
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      state = 'starting';
      let thread;
      try {
        // In the installed app the thread's file is unpacked next to the archive
        thread = new Worker(workerPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), { workerData: { modelPath } });
      } catch (err) {
        fail(err.message);
        reject(err);
        return;
      }
      worker = thread;
      thread.unref();
      thread.on('message', msg => {
        if (msg.ready) { state = 'ready'; resolve(); return; }
        if (msg.failed) { fail(msg.failed); reject(new Error(msg.failed)); return; }
        const job = waiting.get(msg.id);
        if (!job) return;
        waiting.delete(msg.id);
        if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.embedding);
      });
      thread.on('error', err => { fail(err.message); reject(err); });
      // close() lets go of the thread first: its ending then is not a failure
      thread.on('exit', code => {
        if (worker !== thread) return;
        fail(`its thread ended (${code})`);
        reject(new Error(error));
      });
    });
    starting.catch(() => {}); // a failure is reported through state
    return starting;
  }

  return {
    get state() { return state; },
    status: () => ({ state, error }),
    usable: () => state !== 'missing' && state !== 'failed',
    /** The voiceprint (length 1) of some 16 kHz speech. */
    async embed(samples) {
      if (state === 'missing' || state === 'failed') throw new Error(error);
      await start();
      const id = ++seq;
      const copy = Float32Array.from(samples);
      const raw = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('the voice model took too long')); }, EMBED_TIMEOUT_MS);
        waiting.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: err => { clearTimeout(timer); reject(err); },
        });
        worker.postMessage({ id, samples: copy }, [copy.buffer]);
      });
      return normalize(raw);
    },
    /** Stop the thread; the next embed() starts it again. */
    close() {
      const ending = worker;
      worker = null;
      starting = null;
      if (state !== 'missing' && state !== 'failed') state = 'idle';
      ending?.terminate().catch(() => {});
    },
  };
}

export class VoiceProfileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const empty = () => ({ version: 1, model: VOICE_MODEL.id, owner: null, people: {} });

/**
 * Everyone's voiceprints on this computer, and the enrollment in progress
 * (one at a time: there is one microphone). `store` is a secure store
 * (account.js createSecureStore); `model` is createVoiceModel().
 */
export function createVoiceProfiles({ store, model, now = () => Date.now() }) {
  let data = empty();
  let session = null; // { id, consent, clips: [{ phrase, samples, embedding }], room, lastAt }

  const person = id => data.people[key(id)] || null;

  async function save() {
    if (Object.keys(data.people).length) await store.save(data);
    else await store.clear(); // nobody left: nothing kept at all
  }

  function current(id) {
    if (session && now() - session.lastAt > HOLD_MS) session = null;
    if (!session || session.id !== key(id)) throw new VoiceProfileError('That voice is not being set up. Start again.', 409);
    session.lastAt = now();
    return session;
  }

  return {
    /** Read what is saved. A voiceprint from another model can't be compared, so it is dropped. */
    async load() {
      let saved = null;
      try { saved = await store.load(); } catch {}
      if (saved?.version === 1 && saved.model === VOICE_MODEL.id && saved.people && typeof saved.people === 'object') {
        data = { ...empty(), ...saved };
      } else {
        if (saved) console.warn('[Voice lock] Saved voiceprints are from another voice model; they need setting up again');
        data = empty();
      }
      return this;
    },

    owner: () => (data.owner == null ? null : Number(data.owner)),
    has: id => !!person(id),
    count: () => Object.keys(data.people).length,
    /** Scores are worked out for every voice command when someone is set up and the model works. */
    measuring() { return this.count() > 0 && model.usable(); },
    model: () => model.status(),

    /** One person's voiceprint record, without the voiceprint itself. */
    describe(id) {
      const p = person(id);
      if (!p) return null;
      return { enrolledAt: p.enrolledAt, clips: p.clips, noisy: p.noisy, self: p.self, consent: p.consent, mode: p.mode };
    },
    people: () => Object.entries(data.people).map(([id, p]) => ({ id: Number(id), enrolledAt: p.enrolledAt, clips: p.clips })),

    /** While a voice is being set up, voice commands are not acted on: the phrases are not commands. */
    holding() {
      if (session && now() - session.lastAt > HOLD_MS) {
        console.log('[Voice lock] The voice setup was left: voice commands work again');
        session = null;
      }
      return !!session;
    },
    enrolling() {
      if (!this.holding()) return null;
      return { id: Number(session.id), count: session.clips.length, phrases: session.clips.map(c => c.phrase), room: !!session.room };
    },

    /** Begin setting up `id`'s voice, with their consent ({ by: 'self' | 'guardian' }). */
    start(id, { by }) {
      if (!model.usable()) throw new VoiceProfileError(`Voice profiles don't work on this computer: ${model.status().error}.`, 503);
      if (this.holding() && session.id !== key(id)) throw new VoiceProfileError("Another person's voice is being set up. Finish or stop that first.", 409);
      session = {
        id: key(id),
        consent: { at: new Date(now()).toISOString(), by: by === 'guardian' ? 'guardian' : 'self', version: VOICE_CONSENT_VERSION },
        clips: [],
        room: null,
        lastAt: now(),
      };
      model.embed(new Float32Array(SAMPLE_RATE)).catch(() => {}); // load the model while they read the first phrase
      return this.enrolling();
    },

    /** The setup page is still open. */
    keep(id) { current(id); return this.enrolling(); },

    /** One phrase read aloud. A poor one is not kept, and `problem` says why. */
    async addClip(id, { wav, phrase }) {
      const s = current(id);
      let samples;
      try { samples = samplesFromWav(wav); } catch (err) { throw new VoiceProfileError(`That recording can't be used: ${err.message}.`); }
      const quality = clipQuality(samples);
      if (!quality.ok) return { ...quality, count: s.clips.length };
      const speech = Float32Array.from(trimToSpeech(samples));
      const embedding = await model.embed(speech);
      // Unlike all the others: someone else, or AbleSpeak's own voice, was heard
      const others = s.clips.filter(c => c.phrase !== phrase);
      const fit = others.length >= 4 ? round(similarity(embedding, averagePrint(others.map(c => c.embedding)))) : null;
      if (fit != null && fit < MIN_FIT) return { ...quality, ok: false, problem: 'different', fit, count: s.clips.length };
      s.clips = [...others, { phrase, samples: speech, embedding }];
      s.lastAt = now();
      return { ...quality, ok: true, fit, count: s.clips.length };
    },

    /** Half a minute of the person's usual room, nobody speaking to AbleSpeak. */
    addRoom(id, { wav }) {
      const s = current(id);
      let samples;
      try { samples = samplesFromWav(wav); } catch (err) { throw new VoiceProfileError(`That recording can't be used: ${err.message}.`); }
      const seconds = samples.length / SAMPLE_RATE;
      if (seconds < MIN_ROOM_SECONDS) return { ok: false, problem: 'short', seconds };
      s.room = samples.slice(-MAX_ROOM_SECONDS * SAMPLE_RATE);
      let sum = 0;
      for (let i = 0; i < s.room.length; i++) sum += s.room[i] * s.room[i];
      const quiet = Math.sqrt(sum / s.room.length) < QUIET_ROOM;
      return { ok: true, seconds: Math.min(seconds, MAX_ROOM_SECONDS), quiet };
    },

    /** Make and keep the voiceprint; the recordings go. The first person to finish owns the computer's voice lock. */
    async finish(id) {
      const s = current(id);
      if (s.clips.length < MIN_CLIPS) {
        throw new VoiceProfileError(`Read at least ${MIN_CLIPS} phrases first (${s.clips.length} so far).`);
      }
      const clean = s.clips.map(c => c.embedding);
      // With the room's sound mixed in, the voiceprint also knows the person's voice in that noise
      const noisy = [];
      if (s.room) {
        const stride = Math.floor(s.room.length / s.clips.length);
        for (const [i, clip] of s.clips.entries()) {
          const mixed = mixRoom(clip.samples, s.room, { offset: i * stride });
          if (mixed.some((x, j) => x !== clip.samples[j])) noisy.push(await model.embed(mixed));
        }
      }
      const print = averagePrint([...clean, ...noisy]);
      data.people[key(id)] = {
        print: Array.from(print, x => round(x, 6)),
        clips: clean.length,
        noisy: noisy.length > 0,
        self: selfScores(clean),
        enrolledAt: new Date(now()).toISOString(),
        consent: s.consent,
        mode: 'measure', // Phase 3 adds 'lock'
      };
      if (data.owner == null) data.owner = key(id);
      session = null;
      await save();
      console.log(`[Voice lock] Voiceprint saved for user ${id} (${clean.length} phrases${noisy.length ? ', with room sound' : ''})`);
      return this.describe(id);
    },

    /** Stop setting up a voice; nothing is kept. */
    cancel(id) {
      if (session && (id == null || session.id === key(id))) session = null;
    },

    /** Delete a voiceprint. If it was the owner's, the next person set up owns the voice lock. */
    async remove(id) {
      if (!person(id)) return false;
      delete data.people[key(id)];
      if (data.owner === key(id)) {
        const next = Object.entries(data.people).sort((a, b) => a[1].enrolledAt.localeCompare(b[1].enrolledAt))[0];
        data.owner = next ? next[0] : null;
      }
      await save();
      console.log(`[Voice lock] Voiceprint deleted for user ${id}`);
      return true;
    },

    /**
     * How much a voice command sounds like each person set up. Returns null
     * when there is nobody to compare with, { skipped } for a clip with
     * almost no speech, else { score, who, match, scores, seconds, snrDb, ms }.
     * `snrDb` is how far the voice was above the room: the line for Phase 3
     * will likely depend on it.
     */
    async check(samples) {
      if (!this.measuring()) return null;
      const startedAt = now();
      const speech = trimToSpeech(samples);
      const { voicedSeconds } = findSpeech(speech);
      if (voicedSeconds < MIN_VOICED_SECONDS) return { skipped: 'short' };
      const { level, floor } = findSpeech(samples);
      const embedding = await model.embed(speech);
      const scores = {};
      let best = null;
      for (const [id, p] of Object.entries(data.people)) {
        const score = round(similarity(embedding, p.print));
        scores[id] = score;
        if (!best || score > best.score) best = { id: Number(id), score };
      }
      return {
        score: best.score,
        who: best.score >= MATCH_THRESHOLD ? best.id : null,
        match: best.score >= MATCH_THRESHOLD,
        scores,
        seconds: round(voicedSeconds, 2),
        snrDb: floor > 0 ? Math.min(60, round(20 * Math.log10(level / floor), 1)) : 60,
        ms: now() - startedAt,
      };
    },
  };
}

/**
 * A person's measured commands, for their "My voice" card: how many were
 * checked, how many sounded like them, and their typical and lowest score.
 * `checks` are check() results, newest first.
 */
export function summarizeChecks(checks, id) {
  const own = checks.map(c => c?.scores?.[key(id)]).filter(Number.isFinite);
  if (!own.length) return { checked: 0, matched: 0, median: null, lowest: null };
  const sorted = [...own].sort((a, b) => a - b);
  return {
    checked: own.length,
    matched: own.filter(s => s >= MATCH_THRESHOLD).length,
    median: sorted[Math.floor(sorted.length / 2)],
    lowest: sorted[0],
  };
}
