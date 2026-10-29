/**
 * How fast AbleSpeak answers, stage by stage, and what it costs: the
 * Developer › Speed tab (the idea of the speech-to-text, AI and voice timings
 * and costs Voqal shows for each request).
 *
 * Each voice command is timed in six stages:
 *   pause  the voice bar waiting for the person to stop talking, then sending
 *   hear   the clip arriving → its words (the speech service, this computer or Gemini)
 *   look   reading the window in front and the page (only when the AI is asked)
 *   think  the AI model's own time, every call of the command added up
 *   act    everything else until it is done: the actions, pages loading
 *   speak  the reply asked for → its first sound (Edge's voice or Windows')
 *
 * Costs are estimates from list prices (PRICES, checked 17 Oct 2026). Gemini
 * is paid per token, so each command has its own cost. The speech service
 * (Modal) is paid for every second its GPU is awake, whether anyone speaks or
 * not, so it is counted as time awake, not per command.
 */

export const PRICES = {
  checked: '2026-10-17',
  // US$ per million tokens, paid tier (ai.google.dev/gemini-api/docs/pricing).
  // The free tier costs nothing but has low limits.
  gemini: {
    'gemini-2.5-flash': { input: 0.30, audio: 1.00, cached: 0.03, output: 2.50 },
    'gemini-2.5-flash-lite': { input: 0.10, audio: 0.30, cached: 0.01, output: 0.40 },
    'gemini-2.5-pro': { input: 1.25, cached: 0.125, output: 10.00 },
    'gemini-3-flash-preview': { input: 0.50, audio: 1.00, cached: 0.05, output: 3.00 },
  },
  // US$ per GPU-second (modal.com/pricing), and the "eu" region's 1.15×
  // (modal.com/docs/guide/region-selection; speech-server/stream_service.py)
  gpuPerSecond: { A10: 0.000306, L4: 0.000222, T4: 0.000164 },
  regionFactor: 1.15,
  // The service stays awake this long after its last connection closes (scaledown_window)
  scaledownSeconds: 300,
  // Answers grounded in Google Search (web_answer) on the 2.5 models: free up
  // to 1,500 a day (shared by the project), then $35 per 1,000
  groundedSearch: { freePerDay: 1500, each: 0.035 },
};

const STAGES = ['pause', 'hear', 'look', 'think', 'act', 'speak'];
// While the speech service is in one of these, its GPU is (or is being) paid for
const AWAKE = new Set(['connecting', 'reconnecting', 'ready']);
const KEEP_TURNS = 200;
const VOICE_WAIT_MS = 60000; // a reply's first sound reported before its turn was recorded

/** The list price of a Gemini model ("models/gemini-2.5-flash-001" → 2.5 Flash's), or null. */
export function priceOf(model) {
  const id = String(model || '').replace(/^models\//, '');
  const match = Object.keys(PRICES.gemini)
    .filter(key => id === key || id.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICES.gemini[match] : null;
}

/**
 * What a model's tokens cost, in US$, or null when its price isn't known.
 * `input` counts every prompt token, including the cached and audio ones.
 */
export function tokenCost(model, usage) {
  const price = priceOf(model);
  if (!price || !usage) return null;
  const input = usage.input || 0;
  const cached = usage.cached || 0;
  const audio = usage.audio || 0;
  const plain = Math.max(0, input - cached - audio);
  const out = (usage.output || 0) + (usage.thoughts || 0); // thinking is paid as output
  return (plain * price.input + cached * price.cached + audio * (price.audio ?? price.input) + out * price.output) / 1e6;
}

/** "NVIDIA A10" (Modal's A10G, as nvidia-smi names it) → "A10", "Tesla T4" → "T4". */
export function gpuKind(gpu) {
  return String(gpu || '').toUpperCase().match(/A10|L4|T4/)?.[0] || null;
}

/** What an hour of the speech service costs on this GPU (the A10 it asks for first, when not known yet), in US$. */
export function speechServiceHourly(gpu) {
  return PRICES.gpuPerSecond[gpuKind(gpu) || 'A10'] * PRICES.regionFactor * 3600;
}

/** A fresh tally for one command's AI calls. */
export function newSpend(model = null) {
  return { model, calls: 0, ms: 0, input: 0, cached: 0, output: 0, thoughts: 0, audio: 0, searches: 0 };
}

/** Add one call's tokens, time and Google searches (web_answer) to a tally. */
export function addSpend(spend, usage, ms) {
  if (!spend) return spend;
  spend.calls += 1;
  spend.ms += Math.max(0, ms || 0);
  for (const key of ['input', 'cached', 'output', 'thoughts', 'audio', 'searches']) spend[key] = (spend[key] || 0) + (usage?.[key] || 0);
  return spend;
}

/**
 * Time the speech service has been awake, counting the scaledown after each
 * time it was let go: that time is paid for too, so it is counted at once.
 * Waking again before it ran out carries on the same stretch.
 */
export class AwakeClock {
  constructor({ tailMs = PRICES.scaledownSeconds * 1000, now = Date.now } = {}) {
    this.tailMs = tailMs;
    this.now = now;
    this._done = 0;      // stretches that are over
    this._from = null;   // the current stretch began
    this._until = null;  // ...and will end then (null: still awake)
  }

  set(awake, at = this.now()) {
    if (awake) {
      if (this._from != null && (this._until == null || at <= this._until)) { this._until = null; return; }
      if (this._from != null) this._done += this._until - this._from;
      this._from = at;
      this._until = null;
    } else if (this._from != null && this._until == null) {
      this._until = at + this.tailMs;
    }
  }

  get awake() { return this._from != null && this._until == null; }

  /** Milliseconds awake so far, the scaledown of a finished stretch included. */
  ms(at = this.now()) {
    if (this._from == null) return this._done;
    return this._done + Math.max(0, (this._until ?? at) - this._from);
  }
}

const median = values => percentile(values, 0.5);
/** Between the two nearest values, so two timings' median is their middle. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = p * (sorted.length - 1);
  const below = Math.floor(at);
  const above = Math.ceil(at);
  return Math.round(sorted[below] + (sorted[above] - sorted[below]) * (at - below));
}
const round = n => (n == null ? null : Math.round(n));

/**
 * One voice turn's timings, from what the gateway noted while handling it
 * (ws-proxy.js turn log). Stages that didn't happen are left out.
 */
// Who the command sounded like (voice-profile.js check()). Only measured for now,
// for the Speed tab and the person's own "My voice" card.
const speakerOf = found => (found && !found.skipped
  ? { score: found.score, who: found.who, match: found.match, scores: found.scores, snrDb: found.snrDb, ms: found.ms }
  : null);

/** The voice checks among recent turns: how many sounded like someone set up, and how long a check took. */
function speakerSummary(turns) {
  const checks = turns.map(r => r.speed.speaker).filter(Boolean);
  if (!checks.length) return { checked: 0 };
  return {
    checked: checks.length,
    matched: checks.filter(c => c.match).length,
    medianScore: median(checks.map(c => c.score)),
    lowestScore: Math.min(...checks.map(c => c.score)),
    medianMs: median(checks.map(c => c.ms).filter(Number.isFinite)),
  };
}

export function speedOfTurn(log, { now = Date.now() } = {}) {
  const started = log.started;
  const doneAt = log.doneAt || now;
  const totalMs = Math.max(0, doneAt - started);
  const hearMs = log.heardAt ? Math.max(0, log.heardAt - started) : null;
  const think = log.think || null;
  const thinkMs = think?.calls ? think.ms : null;
  const lookMs = log.lookMs ?? null;
  const pauseMs = Number.isFinite(log.speechEndedAt) && log.speechEndedAt <= started && started - log.speechEndedAt < 30000
    ? started - log.speechEndedAt : null;
  const actMs = log.doneAt ? Math.max(0, totalMs - (hearMs || 0) - (lookMs || 0) - (thinkMs || 0)) : null;
  const aiCost = think?.calls ? tokenCost(think.model, think) : null;
  const hearCost = log.hearUsage ? tokenCost(log.hearUsage.model, log.hearUsage) : null;
  const cleanCost = log.clean?.calls ? tokenCost(log.clean.model, log.clean) : null;
  const costs = [aiCost, hearCost, cleanCost].filter(c => c != null);
  return {
    path: log.path || log.outcome,
    pauseMs: round(pauseMs),
    hearMs: round(hearMs),
    hearEngine: log.hearEngine || null,
    lookMs: round(lookMs),
    thinkMs: round(thinkMs),
    ai: think?.calls ? {
      model: think.model, calls: think.calls,
      input: think.input, cached: think.cached, output: think.output + think.thoughts,
      ...(think.searches ? { searches: think.searches } : {}),
    } : null,
    cleanMs: log.clean?.calls ? round(log.clean.ms) : null,
    actMs: round(actMs),
    tool: log.tool || null,
    totalMs: round(totalMs),
    replied: !!log.replied,
    speakMs: null,
    voice: null,
    speaker: speakerOf(log.speaker),
    cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    priced: !(think?.calls && aiCost == null), // false: a model whose price isn't listed
  };
}

/**
 * The latest turns (to link a reply's first sound to its command) and the
 * speech service's awake time.
 */
export class SpeedMeter {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.turns = [];                  // newest last
    this.clock = new AwakeClock({ now });
    this.gpu = null;
    this.serviceState = 'off';
    this.onUpdate = null;             // (turn) → keep a change made after the turn was recorded
    this._waitingVoice = new Map();   // commandId → { ms, voice, at }
    this._takenMs = 0;
  }

  /** A finished voice turn: its id (database row), commandId and speedOfTurn() fields. */
  addTurn(turn) {
    const entry = { at: this.now(), ...turn };
    const early = entry.commandId && this._waitingVoice.get(entry.commandId);
    if (early) {
      this._waitingVoice.delete(entry.commandId);
      entry.speakMs = early.ms;
      entry.voice = early.voice;
    }
    this.turns.push(entry);
    if (this.turns.length > KEEP_TURNS) this.turns.shift();
    return entry;
  }

  /** A reply started sounding `ms` after it was asked for; `ref` is its command's id. */
  addVoice({ ref, ms, voice }) {
    if (!ref || !Number.isFinite(ms)) return null;
    const turn = this.turns.findLast(t => t.commandId === ref);
    if (!turn) {
      // Spoken before its turn finished being recorded
      for (const [key, value] of this._waitingVoice) if (this.now() - value.at > VOICE_WAIT_MS) this._waitingVoice.delete(key);
      this._waitingVoice.set(ref, { ms: Math.round(ms), voice, at: this.now() });
      return null;
    }
    if (turn.speakMs != null) return turn; // only its first piece
    turn.speakMs = Math.round(ms);
    turn.voice = voice || null;
    try { this.onUpdate?.(turn); } catch (err) { console.warn('[Speed] Saving the voice timing failed:', err.message); }
    return turn;
  }

  /** Who a recorded turn sounded like, when the voice check came after it was recorded. */
  addSpeaker(turn, found) {
    const speaker = speakerOf(found);
    if (!turn || !speaker || turn.speaker) return null;
    turn.speaker = speaker;
    try { this.onUpdate?.(turn); } catch (err) { console.warn('[Speed] Saving the voice check failed:', err.message); }
    return turn;
  }

  /** The speech service's connection changed (remote-asr.js state). */
  speechService(state, gpu = null) {
    this.serviceState = state;
    if (gpu) this.gpu = gpu;
    this.clock.set(AWAKE.has(state));
  }

  /** Awake time not yet saved; saved from now on. */
  takeAwakeMs() {
    const total = this.clock.ms();
    const delta = Math.max(0, total - this._takenMs);
    this._takenMs = total;
    return delta;
  }

  untakenAwakeMs() {
    return Math.max(0, this.clock.ms() - this._takenMs);
  }
}

/** The one meter, shared by the gateway, the speaker (electron-main.cjs) and the API. */
export const speedMeter = new SpeedMeter();

/**
 * The Speed tab's figures, from saved turns (newest first: { id, created_at,
 * outcome, transcript, speed }) and the speech service's awake time today.
 */
export function speedReport({ rows = [], today, service = {}, recent = 40, sample = 100 } = {}) {
  const turns = rows.filter(r => r.speed);
  const stats = key => {
    const values = turns.slice(0, sample).map(r => r.speed[`${key}Ms`]).filter(Number.isFinite);
    return { median: median(values), p90: percentile(values, 0.9), count: values.length };
  };
  const stages = Object.fromEntries(STAGES.map(key => [key, stats(key)]));
  // The whole command only for those that did something
  const done = turns.slice(0, sample).filter(r => ['quick', 'ai'].includes(r.speed.path)).map(r => r.speed.totalMs).filter(Number.isFinite);
  stages.total = { median: median(done), p90: percentile(done, 0.9), count: done.length };
  // Without the AI and with it: the difference is what the quick commands save
  const byPath = path => {
    const values = turns.slice(0, sample).filter(r => r.speed.path === path).map(r => r.speed.totalMs).filter(Number.isFinite);
    return { median: median(values), count: values.length };
  };

  const count = (list, key) => list.reduce((tally, r) => {
    const value = r.speed[key];
    if (value) tally[value] = (tally[value] || 0) + 1;
    return tally;
  }, {});
  const ofToday = today ? turns.filter(r => String(r.created_at || '').startsWith(today)) : turns;
  const aiTurns = ofToday.filter(r => r.speed.ai);
  const aiCost = aiTurns.reduce((sum, r) => sum + (r.speed.cost || 0), 0);
  const otherCost = ofToday.filter(r => !r.speed.ai).reduce((sum, r) => sum + (r.speed.cost || 0), 0);
  const hourly = speechServiceHourly(service.gpu);
  const awakeMs = service.awakeMs || 0;
  const serviceCost = (awakeMs / 3600000) * hourly;
  // Google searches for web answers: only those past the free ones a day are paid
  const searches = ofToday.reduce((sum, r) => sum + (r.speed.ai?.searches || 0), 0);
  const searchCost = Math.max(0, searches - PRICES.groundedSearch.freePerDay) * PRICES.groundedSearch.each;
  return {
    prices: { checked: PRICES.checked, regionFactor: PRICES.regionFactor, scaledownSeconds: PRICES.scaledownSeconds },
    stages,
    paths: { quick: byPath('quick'), ai: byPath('ai') },
    engines: {
      hear: count(turns.slice(0, sample), 'hearEngine'),
      voice: count(turns.slice(0, sample), 'voice'),
      model: turns.find(r => r.speed.ai)?.speed.ai.model || null,
    },
    today: {
      turns: ofToday.length,
      commands: ofToday.filter(r => ['quick', 'ai'].includes(r.speed.path)).length,
      quick: ofToday.filter(r => r.speed.path === 'quick').length,
      ai: aiTurns.length,
      aiCost,
      otherCost, // Gemini hearing a clip, dictation autocorrect
      perAiCommand: aiTurns.length ? aiCost / aiTurns.length : null,
      unpriced: ofToday.some(r => r.speed.priced === false),
      speechService: { awakeMinutes: awakeMs / 60000, cost: serviceCost },
      searches: { count: searches, free: PRICES.groundedSearch.freePerDay, each: PRICES.groundedSearch.each, cost: searchCost },
      total: aiCost + otherCost + serviceCost + searchCost,
    },
    speechService: { state: service.state || 'off', gpu: gpuKind(service.gpu), hourly },
    speaker: speakerSummary(turns.slice(0, sample)),
    recent: turns.slice(0, recent).map(r => ({ id: r.id, at: r.created_at, said: r.transcript, ...r.speed })),
  };
}
