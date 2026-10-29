/**
 * "Only my voice", Phases 1–2 (voice-profile.js, routes/voice-profile.js):
 * reading clips, the quality checks, the trim, enrollment and its rules, the
 * measuring-only check, and how the voice bar and the Speed tab carry it.
 *
 * The real model needs Electron's x64 Node (sherpa-onnx); here a stand-in
 * model treats a tone's pitch as its "voice", one direction in 16.
 * Run with:  node --test src/voice-profile.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import {
  samplesFromWav, clipQuality, trimToSpeech, mixRoom, averagePrint, selfScores, similarity, summarizeChecks,
  createVoiceProfiles, createVoiceModel, ENROLL_PHRASES, MIN_CLIPS, MATCH_THRESHOLD, HOLD_MS,
} from './voice-profile.js';
import { createVoiceProfileRouter } from './routes/voice-profile.js';
import { speedOfTurn, speedReport, SpeedMeter } from './speed-meter.js';
import { WsProxy } from './ws-proxy.js';
import { normaliseProfile } from './student-profile.js';

const RATE = 16000;
const silence = seconds => new Float32Array(Math.round(seconds * RATE));
const tone = (pitch, seconds, amp = 0.2) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * pitch * i) / RATE));
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
// A phrase as the dashboard records it: a little quiet, the voice, a pause
const phrase = (pitch, seconds = 1.2) => join(silence(0.3), tone(pitch, seconds), silence(0.5));

function wav(samples, rate = RATE) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf.toString('base64');
}

/** The stand-in model: a clip's "voice" is its pitch, one of 16 directions. */
function fakeModel({ usable = true } = {}) {
  const model = {
    embeds: 0,
    usable: () => usable,
    status: () => ({ state: usable ? 'ready' : 'missing', error: usable ? null : 'the voice model is not on this computer' }),
    async embed(samples) {
      model.embeds++;
      let crossings = 0;
      for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
      const pitch = crossings / 2 / (samples.length / RATE);
      const v = new Float32Array(16);
      v[Math.round(pitch / 100) % 16] = 1;
      return v;
    },
  };
  return model;
}

function memoryStore() {
  const store = {
    value: null, saves: 0, clears: 0,
    load: async () => store.value,
    save: async v => { store.value = JSON.parse(JSON.stringify(v)); store.saves++; },
    clear: async () => { store.value = null; store.clears++; },
  };
  return store;
}

async function enroll(profiles, id, pitch, count = MIN_CLIPS) {
  profiles.start(id, { by: 'self' });
  for (let i = 0; i < count; i++) {
    const result = await profiles.addClip(id, { wav: wav(phrase(pitch)), phrase: i });
    assert.equal(result.ok, true, `phrase ${i}: ${result.problem}`);
  }
  return profiles.finish(id);
}

// ── Reading and judging clips ──

test('a 16 kHz WAV reads back as its samples; anything else is refused', () => {
  const samples = samplesFromWav(wav(tone(300, 0.5)));
  assert.equal(samples.length, 8000);
  assert.ok(Math.abs(samples[100] - tone(300, 0.5)[100]) < 1e-4);
  assert.throws(() => samplesFromWav(wav(tone(300, 0.5), 48000)), /16 kHz/);
  assert.throws(() => samplesFromWav(Buffer.from('not a clip at all, just words').toString('base64')), /not a WAV/);
});

test('a phrase is judged before it is learned from: unheard, too quiet, distorted, too long', () => {
  assert.equal(clipQuality(phrase(200)).ok, true);
  assert.equal(clipQuality(silence(2)).problem, 'not_heard');
  assert.equal(clipQuality(join(silence(0.3), tone(200, 1.2, 0.01), silence(0.5))).problem, 'quiet');
  const square = Float32Array.from(tone(200, 1.2), x => (x >= 0 ? 1 : -1));
  assert.equal(clipQuality(join(silence(0.3), square, silence(0.5))).problem, 'loud');
  assert.equal(clipQuality(tone(200, 21)).problem, 'long');
});

test('only the main stretch of speech is kept: a sound well before it is cut away', () => {
  const clip = join(silence(0.5), tone(900, 0.15), silence(1), tone(200, 1.2), silence(0.5));
  const kept = trimToSpeech(clip).length / RATE;
  assert.ok(kept > 1.3 && kept < 1.5, `kept ${kept} s`);
  assert.equal(trimToSpeech(silence(1)).length, 0);
});

test("the room's sound is mixed in quietly, and a silent room changes nothing", () => {
  const voice = phrase(200);
  assert.deepEqual(mixRoom(voice, silence(5)), voice);
  const loudRoom = Float32Array.from({ length: RATE * 5 }, (_, i) => 0.5 * Math.sin(i * 1.7));
  const mixed = mixRoom(voice, loudRoom);
  let sum = 0;
  for (let i = 0; i < voice.length; i++) sum += (mixed[i] - voice[i]) ** 2;
  const added = Math.sqrt(sum / voice.length);
  // the voice is about 0.14; 10 dB below it is about 0.045
  assert.ok(added > 0.03 && added < 0.06, `added ${added}`);
});

test('voiceprints: an average direction, compared by cosine; self scores leave each phrase out', () => {
  const print = averagePrint([[1, 0, 0], [0.8, 0.6, 0]]);
  assert.ok(Math.abs(similarity(print, print) - 1) < 1e-6);
  assert.ok(similarity(print, Float32Array.from([0, 0, 1])) === 0);
  const self = selfScores([[1, 0], [1, 0], [0.6, 0.8]]);
  assert.equal(self.count, 3);
  assert.equal(self.lowest, 0.6);
});

// ── Enrollment ──

test('the first person to finish owns the voices; the recordings are not kept', async () => {
  const store = memoryStore();
  const profiles = await createVoiceProfiles({ store, model: fakeModel() }).load();
  assert.equal(profiles.measuring(), false);
  const done = await enroll(profiles, 5, 200);
  assert.equal(done.clips, MIN_CLIPS);
  assert.equal(done.mode, 'measure');
  assert.equal(done.consent.by, 'self');
  assert.equal(profiles.owner(), 5);
  assert.equal(profiles.holding(), false, 'voice commands work again');
  assert.equal(profiles.measuring(), true);

  const saved = store.value.people['5'];
  assert.equal(saved.print.length, 16);
  assert.equal(Object.keys(saved).includes('samples'), false);
  assert.ok(JSON.stringify(store.value).length < 2000, 'a voiceprint, not recordings');

  await enroll(profiles, 6, 700);
  assert.equal(profiles.owner(), 5, 'the owner stays the first');
});

test('a voice can only be finished with enough phrases, and one that sounds like someone else is not kept', async () => {
  const profiles = await createVoiceProfiles({ store: memoryStore(), model: fakeModel() }).load();
  profiles.start(5, { by: 'guardian' });
  for (let i = 0; i < 5; i++) await profiles.addClip(5, { wav: wav(phrase(200)), phrase: i });
  const other = await profiles.addClip(5, { wav: wav(phrase(1200)), phrase: 5 });
  assert.equal(other.ok, false);
  assert.equal(other.problem, 'different');
  const unheard = await profiles.addClip(5, { wav: wav(silence(2)), phrase: 5 });
  assert.equal(unheard.problem, 'not_heard');
  // The same phrase again replaces it
  const again = await profiles.addClip(5, { wav: wav(phrase(200)), phrase: 4 });
  assert.equal(again.count, 5);
  await assert.rejects(profiles.finish(5), /at least 12 phrases/);
});

test('while a voice is set up, commands are held; a setup left alone lets go', async () => {
  let t = 1000;
  const profiles = await createVoiceProfiles({ store: memoryStore(), model: fakeModel(), now: () => t }).load();
  profiles.start(5, { by: 'self' });
  assert.equal(profiles.holding(), true);
  assert.throws(() => profiles.start(6, { by: 'self' }), /Another person's voice/);
  t += HOLD_MS - 1000;
  profiles.keep(5);
  t += HOLD_MS - 1000;
  assert.equal(profiles.holding(), true, 'kept open by the page');
  t += 2000;
  assert.equal(profiles.holding(), false);
  await assert.rejects(profiles.addClip(5, { wav: wav(phrase(200)), phrase: 0 }), /not being set up/);
});

test('without the voice model nothing can be set up, and nothing is measured', async () => {
  const profiles = await createVoiceProfiles({ store: memoryStore(), model: fakeModel({ usable: false }) }).load();
  assert.throws(() => profiles.start(5, { by: 'self' }), /don't work on this computer/);
  assert.equal(await profiles.check(phrase(200)), null);
  // The real model with no file: missing, not a crash
  const missing = createVoiceModel({ modelPath: 'Z:/nowhere/model.onnx' });
  assert.equal(missing.status().state, 'missing');
  await assert.rejects(missing.embed(phrase(200)), /not on this computer/);
});

test('each command is scored against everyone set up (measuring only)', async () => {
  const profiles = await createVoiceProfiles({ store: memoryStore(), model: fakeModel() }).load();
  await enroll(profiles, 5, 200);
  await enroll(profiles, 6, 700);
  const own = await profiles.check(phrase(200));
  assert.equal(own.match, true);
  assert.equal(own.who, 5);
  assert.equal(own.scores['5'], 1);
  assert.equal(own.scores['6'], 0);
  assert.ok(Number.isFinite(own.snrDb));
  const stranger = await profiles.check(phrase(1300));
  assert.equal(stranger.match, false);
  assert.equal(stranger.who, null);
  assert.deepEqual(await profiles.check(join(silence(1), tone(200, 0.1), silence(1))), { skipped: 'short' });
});

test("deleting the owner's voice passes the voices to the next person; deleting the last keeps nothing", async () => {
  const store = memoryStore();
  let t = Date.parse('2026-10-19T10:00:00Z');
  const profiles = await createVoiceProfiles({ store, model: fakeModel(), now: () => (t += 1000) }).load();
  await enroll(profiles, 5, 200);
  await enroll(profiles, 6, 700);
  assert.equal(await profiles.remove(5), true);
  assert.equal(profiles.owner(), 6);
  await profiles.remove(6);
  assert.equal(profiles.owner(), null);
  assert.equal(store.value, null);
  assert.equal(store.clears, 1);
});

test('saved voiceprints are read back, unless they came from another model', async () => {
  const store = memoryStore();
  const first = await createVoiceProfiles({ store, model: fakeModel() }).load();
  await enroll(first, 5, 200);
  const again = await createVoiceProfiles({ store, model: fakeModel() }).load();
  assert.equal(again.owner(), 5);
  assert.equal((await again.check(phrase(200))).match, true);
  store.value = { ...store.value, model: 'another-model' };
  const other = await createVoiceProfiles({ store, model: fakeModel() }).load();
  assert.equal(other.count(), 0);
});

test("a person's card counts their own scores", () => {
  const checks = [{ scores: { 5: 0.7 } }, { scores: { 5: 0.3, 6: 0.8 } }, { scores: { 6: 0.9 } }, { scores: { 5: 0.6 } }];
  assert.deepEqual(summarizeChecks(checks, 5), { checked: 3, matched: 2, median: 0.6, lowest: 0.3 });
  assert.deepEqual(summarizeChecks([], 5), { checked: 0, matched: 0, median: null, lowest: null });
});

// ── Who may set up which voice (routes/voice-profile.js) ──

async function routeServer() {
  const profiles = await createVoiceProfiles({ store: memoryStore(), model: fakeModel() }).load();
  const users = new Map([[1, { id: 1, name: 'Derrick' }], [2, { id: 2, name: 'Wanjiru' }]]);
  const state = { active: 1, changes: 0 };
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/voice-profile', createVoiceProfileRouter({
    profiles,
    activeStudent: () => users.get(state.active) || null,
    getStudent: id => users.get(id) || null,
    getStudents: () => [...users.values()],
    addStudent: ({ name }) => { const s = { id: users.size + 1, name }; users.set(s.id, s); return s; },
    requestRole: req => req.get('x-test-role') || null,
    speakerChecks: () => [{ scores: { 1: 0.7 } }],
    captureFor: () => ({ autoGain: true }),
    onChange: () => { state.changes++; },
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: `/api/voice-profile${path}`,
      headers: {
        Host: `localhost:${port}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const enrollOver = async (id, pitch) => {
    for (let i = 0; i < MIN_CLIPS; i++) {
      const r = await call('POST', `/${id}/clips`, { body: { wav: wav(phrase(pitch)), phrase: i } });
      assert.equal(r.body.ok, true);
    }
    return call('POST', `/${id}/finish`);
  };
  return { server, call, state, profiles, enrollOver };
}

test('setting up a voice needs consent, and a guardian under 18', async () => {
  const { server, call } = await routeServer();
  try {
    const first = await call('GET', '/');
    assert.equal(first.status, 200);
    assert.equal(first.body.canEnroll, true);
    assert.equal(first.body.owner, null);
    assert.equal(first.body.phrases.length, ENROLL_PHRASES.length);
    assert.equal(first.body.threshold, MATCH_THRESHOLD);
    assert.deepEqual(first.body.capture, { autoGain: true });
    assert.equal((await call('POST', '/1/start', { body: { agree: false, adult: true } })).status, 400);
    assert.equal((await call('POST', '/1/start', { body: { agree: true, adult: false } })).status, 400);
    assert.equal((await call('POST', '/1/start', { body: { agree: true, adult: false, guardian: true } })).status, 201);
  } finally {
    server.close();
  }
});

test('after the owner, others need the owner or an admin; deleting is for the person, the owner or an admin', async () => {
  const { server, call, state, enrollOver } = await routeServer();
  try {
    assert.equal((await call('POST', '/1/start', { body: { agree: true, adult: true } })).status, 201);
    const done = await enrollOver(1, 200);
    assert.equal(done.status, 200);
    assert.equal(done.body.owner, 1);
    assert.ok(state.changes >= 2, 'the voice bar is told');

    // Someone else signed in, not set up: refused, and told who to ask
    state.active = 2;
    const theirs = await call('GET', '/');
    assert.equal(theirs.body.canEnroll, false);
    assert.match(theirs.body.why, /Derrick/);
    assert.equal(theirs.body.people, null, 'only the owner or an admin sees the list');
    assert.equal((await call('POST', '/2/start', { body: { agree: true, adult: true } })).status, 403);
    assert.equal((await call('GET', '/?student=1')).status, 403);
    assert.equal((await call('DELETE', '/1')).status, 403);
    // An admin may
    assert.equal((await call('GET', '/?student=1', { headers: { 'x-test-role': 'admin' } })).body.person.voice.clips, MIN_CLIPS);

    // The owner adds someone, and sets up their voice
    state.active = 1;
    const mine = await call('GET', '/');
    assert.equal(mine.body.owner.you, true);
    assert.deepEqual(mine.body.person.measured, { checked: 1, matched: 1, median: 0.7, lowest: 0.7 });
    const added = await call('POST', '/people', { body: { name: 'Amina' } });
    assert.equal(added.status, 201);
    const amina = added.body.student.id;
    assert.equal((await call('POST', `/${amina}/start`, { body: { agree: true, adult: true } })).status, 201);
    assert.equal((await enrollOver(amina, 700)).status, 200);
    assert.equal((await call('GET', '/')).body.people.length, 2);

    // A person may delete their own
    state.active = amina;
    assert.equal((await call('DELETE', `/${amina}`)).body.deleted, true);
  } finally {
    server.close();
  }
});

test('voices are only set up from AbleSpeak\'s own pages', async () => {
  const { server, call } = await routeServer();
  try {
    const foreign = await call('GET', '/', { headers: { Origin: 'https://example.com' } });
    assert.equal(foreign.status, 403);
    const crossSite = await call('POST', '/1/start', { body: { agree: true, adult: true }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
  } finally {
    server.close();
  }
});

// ── The Speed tab and the voice bar ──

test("a turn's voice check goes into its speed record, also when it comes later", () => {
  const log = { started: 1000, heardAt: 1500, doneAt: 1800, transcript: 'scroll down', path: 'quick' };
  assert.equal(speedOfTurn(log).speaker, null);
  log.speaker = { score: 0.62, who: 5, match: true, scores: { 5: 0.62 }, seconds: 1.1, snrDb: 24, ms: 41 };
  assert.deepEqual(speedOfTurn(log).speaker, { score: 0.62, who: 5, match: true, scores: { 5: 0.62 }, snrDb: 24, ms: 41 });
  assert.equal(speedOfTurn({ ...log, speaker: { skipped: 'short' } }).speaker, null);

  const meter = new SpeedMeter();
  const saved = [];
  meter.onUpdate = turn => saved.push(turn.speaker);
  const entry = meter.addTurn({ id: 9, commandId: 'c1', ...speedOfTurn({ ...log, speaker: undefined }) });
  meter.addSpeaker(entry, { score: 0.3, who: null, match: false, scores: { 5: 0.3 }, snrDb: 6, ms: 50 });
  meter.addSpeaker(entry, { score: 0.9, match: true, scores: {}, ms: 1 });
  assert.equal(saved.length, 1, 'saved once');
  assert.equal(entry.speaker.score, 0.3);

  const report = speedReport({
    rows: [
      { id: 2, created_at: '2026-10-19 10:00:01', transcript: 'a', speed: { path: 'quick', speaker: { score: 0.6, match: true, ms: 40 } } },
      { id: 1, created_at: '2026-10-19 10:00:00', transcript: 'b', speed: { path: 'quick', speaker: { score: 0.2, match: false, ms: 60 } } },
      { id: 0, created_at: '2026-10-19 09:59:00', transcript: 'c', speed: { path: 'quick', speaker: null } },
    ],
    today: '2026-10-19',
  });
  assert.equal(report.speaker.checked, 2);
  assert.equal(report.speaker.matched, 1);
  assert.equal(report.speaker.lowestScore, 0.2);
});

function makeProxy(voiceProfile) {
  const profile = normaliseProfile({}).profile;
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null, profile: () => profile, voiceProfile });
  proxy._heartbeatInterval?.unref?.();
  proxy._broadcastDashboard = () => {};
  let heard = 0;
  proxy.voiceHandler.transcribe = async () => { heard++; return { text: 'scroll down' }; };
  proxy._handleUtterance = async () => {};
  const sent = [];
  const ws = { send: raw => sent.push(JSON.parse(raw)) };
  return { proxy, sent, ws, heardCount: () => heard };
}

test('while a voice is set up, the voice bar\'s clips are not even heard', async () => {
  const { proxy, sent, ws, heardCount } = makeProxy({ holding: () => true, measuring: () => true });
  await proxy._processVoiceAudio(ws, { audio: 'a'.repeat(5000), mimeType: 'audio/webm', source: 'overlay' });
  assert.equal(heardCount(), 0);
  assert.equal(sent.at(-1).type, 'voice_no_speech');
  assert.equal(sent.at(-1).reason, 'enrolling');
});

test('with a voice set up, the voice bar sends each clip\'s WAV, and the clip is scored while it is heard', async () => {
  const checked = [];
  const voiceProfile = {
    holding: () => false,
    measuring: () => true,
    check: async samples => { checked.push(samples.length); return { score: 0.7, who: 1, match: true, scores: { 1: 0.7 }, ms: 30 }; },
  };
  const { proxy, ws } = makeProxy(voiceProfile);
  assert.equal(proxy._listeningForOverlay().voiceCheck, true);
  assert.equal(makeProxy(null).proxy._listeningForOverlay().voiceCheck, false);
  proxy._turnLog = { started: Date.now() };
  await proxy._processVoiceAudio(ws, { audio: 'a'.repeat(5000), mimeType: 'audio/webm', source: 'overlay', wav: wav(phrase(200)) });
  await proxy._turnLog.speakerCheck;
  assert.equal(checked.length, 1);
  assert.equal(proxy._turnLog.speaker.score, 0.7);
  // The dashboard's own microphone is not the student
  proxy._turnLog = { started: Date.now() };
  await proxy._processVoiceAudio(ws, { audio: 'a'.repeat(5000), mimeType: 'audio/webm', source: 'dashboard', wav: wav(phrase(200)) });
  assert.equal(checked.length, 1);
});
