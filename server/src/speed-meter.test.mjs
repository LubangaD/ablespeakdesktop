/**
 * The Speed tab's numbers: each voice command timed stage by stage (the pause,
 * hearing, looking, the AI thinking, acting, the first sound of the reply) and
 * what it cost, plus the speech service's paid-for time awake.
 * Run with:  node --test src/speed-meter.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priceOf, tokenCost, speechServiceHourly, AwakeClock, speedOfTurn, SpeedMeter, speedReport, newSpend, addSpend,
} from './speed-meter.js';
import { WsProxy } from './ws-proxy.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('Gemini tokens are priced by the list: cached and audio tokens at their own rates', () => {
  assert.equal(priceOf('models/gemini-2.5-flash-001').output, 2.5);
  assert.equal(priceOf('gemini-2.5-flash-lite').input, 0.10, 'the longest matching name wins');
  assert.equal(priceOf('claude-sonnet-5-5'), null);
  // 8,000 plain + 2,000 cached in, 50 out
  close(tokenCost('gemini-2.5-flash', { input: 10000, cached: 2000, output: 50 }), (8000 * 0.30 + 2000 * 0.03 + 50 * 2.50) / 1e6);
  // A clip heard by Gemini: 800 audio tokens of 1,000
  close(tokenCost('gemini-2.5-flash', { input: 1000, audio: 800, output: 5, thoughts: 5 }), (200 * 0.30 + 800 * 1.00 + 10 * 2.50) / 1e6);
  assert.equal(tokenCost('some-other-model', { input: 10 }), null, 'an unknown price is not guessed');
  close(speechServiceHourly('NVIDIA A10G'), 0.000306 * 1.15 * 3600);
  close(speechServiceHourly('NVIDIA A10'), 0.000306 * 1.15 * 3600, 'nvidia-smi says "A10" for the A10G');
  close(speechServiceHourly('NVIDIA L4'), 0.000222 * 1.15 * 3600);
});

test('the speech service is paid while awake, and for its 5 minutes after being let go', () => {
  const clock = new AwakeClock({ tailMs: 300000, now: () => 0 });
  clock.set(true, 0);
  assert.equal(clock.ms(60000), 60000);
  clock.set(false, 60000);
  assert.equal(clock.ms(60000), 360000, 'the scaledown is counted at once');
  clock.set(true, 100000); // woken again before it slept: the same stretch
  clock.set(false, 200000);
  assert.equal(clock.ms(250000), 500000);
  clock.set(true, 900000); // asleep by then: a new stretch
  assert.equal(clock.ms(960000), 560000);
});

test("a command's stages add up to the whole, and its AI calls are priced", () => {
  const think = addSpend(addSpend(newSpend('gemini-2.5-flash'), { input: 3000, output: 10 }, 500), { input: 2000, output: 10 }, 400);
  const speed = speedOfTurn({
    started: 10000, speechEndedAt: 9200, heardAt: 10600, hearEngine: 'remote',
    lookMs: 50, think, doneAt: 12000, path: 'ai', tool: 'open_url', replied: true,
  });
  assert.deepEqual(
    [speed.pauseMs, speed.hearMs, speed.lookMs, speed.thinkMs, speed.actMs, speed.totalMs],
    [800, 600, 50, 900, 450, 2000],
  );
  assert.equal(speed.ai.calls, 2);
  close(speed.cost, (5000 * 0.30 + 20 * 2.50) / 1e6);
  const quick = speedOfTurn({ started: 0, heardAt: 400, doneAt: 520, path: 'quick', speechEndedAt: Number.NaN });
  assert.equal(quick.pauseMs, null, 'no pause without its time');
  assert.equal(quick.actMs, 120);
  assert.equal(quick.cost, null, 'a quick command costs nothing per command');
});

test("a reply's first sound is linked to its command, even when it comes first", () => {
  const meter = new SpeedMeter();
  const saved = [];
  meter.onUpdate = turn => saved.push(turn.id);
  meter.addTurn({ id: 7, commandId: 'a', replied: true, speakMs: null });
  assert.equal(meter.addVoice({ ref: 'a', ms: 340, voice: 'windows' }).speakMs, 340);
  assert.equal(meter.addVoice({ ref: 'a', ms: 2000, voice: 'windows' }).speakMs, 340, 'only the first piece counts');
  assert.deepEqual(saved, [7]);
  assert.equal(meter.addVoice({ ref: 'b', ms: 250, voice: 'edge' }), null);
  assert.equal(meter.addTurn({ id: 8, commandId: 'b', replied: true, speakMs: null }).voice, 'edge');
  assert.equal(meter.addVoice({ ref: null, ms: 10 }), null, 'speech with no command is not timed');
});

test("the report: each stage's median and today's cost, the speech service by the hour", () => {
  const row = (id, day, speed) => ({ id, created_at: `${day} 10:00:0${id}`, transcript: `phrase ${id}`, speed });
  const rows = [
    row(3, '2026-10-17', { path: 'ai', hearMs: 700, thinkMs: 1000, totalMs: 2500, ai: { model: 'gemini-2.5-flash' }, cost: 0.002, hearEngine: 'remote', voice: 'windows', speakMs: 300 }),
    row(2, '2026-10-17', { path: 'quick', hearMs: 500, totalMs: 600, cost: null, hearEngine: 'remote' }),
    row(1, '2026-10-16', { path: 'ai', hearMs: 900, thinkMs: 1400, totalMs: 3000, ai: { model: 'gemini-2.5-flash' }, cost: 0.004, hearEngine: 'gemini' }),
  ];
  const report = speedReport({ rows, today: '2026-10-17', service: { gpu: 'NVIDIA A10G', awakeMs: 30 * 60000, state: 'ready' } });
  assert.equal(report.stages.hear.median, 700);
  assert.equal(report.stages.total.median, 2500);
  assert.deepEqual(report.paths, { quick: { median: 600, count: 1 }, ai: { median: 2750, count: 2 } }, 'two timings: their middle');
  assert.equal(report.stages.speak.count, 1);
  assert.deepEqual(report.engines.hear, { remote: 2, gemini: 1 });
  assert.equal(report.today.commands, 2);
  assert.equal(report.today.ai, 1);
  close(report.today.aiCost, 0.002);
  close(report.today.speechService.cost, 0.5 * 0.000306 * 1.15 * 3600);
  close(report.today.total, 0.002 + report.today.speechService.cost);
  assert.equal(report.recent[0].said, 'phrase 3');
});

function gateway() {
  const speed = new SpeedMeter();
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null, speed });
  proxy._heartbeatInterval?.unref?.();
  return { proxy, speed };
}

const client = () => ({ readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } });

test('a quick command is timed through the gateway: the pause, hearing and acting', async () => {
  const { proxy, speed } = gateway();
  proxy.aiEngine = {
    toolRegistry: { executeTool: async () => ({ status: 'success', message: 'Scrolled.' }) },
    processChat: async () => { throw new Error('no AI for a quick command'); },
  };
  await proxy._onVoiceAudio(client(), {
    type: 'voice_audio', source: 'overlay', audio: 'A'.repeat(8000),
    heard: { text: 'scroll down', engine: 'remote', ms: 300 },
    speechEndedAt: Date.now() - 700,
  });
  const turn = speed.turns.at(-1);
  assert.equal(turn.path, 'quick');
  assert.equal(turn.tool, 'scroll');
  assert.equal(turn.hearEngine, 'remote');
  assert.ok(turn.pauseMs >= 700 && turn.pauseMs < 2000, `pause ${turn.pauseMs}`);
  assert.ok(Number.isFinite(turn.actMs) && Number.isFinite(turn.totalMs));
  assert.equal(turn.cost, null);
});

test('an AI command is timed with its calls and cost, and its reply’s first sound', async () => {
  const { proxy, speed } = gateway();
  const usage = { ...newSpend('gemini-2.5-flash'), calls: 2, ms: 800, input: 6000, cached: 4000, output: 30 };
  proxy.aiEngine = {
    toolRegistry: { executeTool: async () => ({ status: 'success' }) },
    processChat: async () => ({ text: 'Michael Jackson was a singer.', toolCalls: null, latency: 900, provider: 'gemini', model: 'gemini-2.5-flash', usage }),
  };
  await proxy._onVoiceAudio(client(), {
    type: 'voice_audio', source: 'overlay', audio: 'A'.repeat(8000),
    heard: { text: 'who is michael jackson', engine: 'remote', ms: 300 },
  });
  const turn = speed.turns.at(-1);
  assert.equal(turn.path, 'ai');
  assert.equal(turn.thinkMs, 800);
  assert.equal(turn.ai.calls, 2);
  close(turn.cost, (2000 * 0.30 + 4000 * 0.03 + 30 * 2.50) / 1e6);
  assert.equal(turn.replied, true);
  assert.ok(Number.isFinite(turn.lookMs));
  speed.addVoice({ ref: turn.commandId, ms: 420, voice: 'windows' });
  assert.equal(turn.speakMs, 420);
});
