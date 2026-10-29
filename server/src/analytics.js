/**
 * Usage analytics in Google Analytics 4, through its Measurement Protocol
 * (sent by this computer's AbleSpeak server, not from a web page), and only
 * for an account whose person agreed (profile.js analyticsAllowed; under 18,
 * a parent or guardian). Withdrawing consent stops it at once and drops
 * anything not yet sent.
 *
 * Never names, emails, what was said or what is on the screen: GA forbids
 * personal data, and AbleSpeak doesn't need it. The account is known by its
 * random id (user_id), the computer by a random install id (client_id).
 *
 *   app_open        AbleSpeak started (or the account agreed)
 *   voice_command   way (quick, ai, dictation, control), ok (1/0),
 *                   duration_ms, hearing (speech engine), feature
 *   user properties role, age_group, country, county, school, app_version
 *   traffic_type    'internal' on every event of a Developer (the team's
 *                   testing), for GA's Internal traffic data filter
 *
 * Config: GA_MEASUREMENT_ID (G-…) and GA_API_SECRET (GA › Admin › Data
 * streams › the stream › Measurement Protocol API secrets), set in Settings.
 */
import { analyticsAllowed } from './profile.js';

const ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const SESSION_GAP_MS = 30 * 60000;  // GA's own session timeout
const MAX_BATCH = 25;               // events per request, GA's limit
const MAX_WAITING = 500;            // kept while offline, then the oldest go
export const MEASUREMENT_ID_RE = /^G-[A-Z0-9]{4,20}$/;
export const API_SECRET_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Which part of AbleSpeak a command used, from the tools it ran (first match)
const FEATURES = [
  [/^web_answer$/, 'web_answer'],
  [/^gmail_/, 'gmail'],
  [/^youtube_|^search_youtube$/, 'youtube'],
  [/^set_document_text$|^fix_spelling$/, 'documents'],
  [/^search_web$|^search_in_page$/, 'web_search'],
  [/media_control|system_volume|pause_media/, 'media'],
  [/^answer_question$/, 'question'],
  [/^(uia_|click_desktop|read_desktop|list_desktop|desktop_)|application|window_control|send_system_keys|system_type_text/, 'desktop_apps'],
  [/tab|open_url|go_back|go_forward|scroll|click_element|navigate|type_text|select_option|clear_field|focus_/, 'browser'],
  [/^dictation/, 'dictation'],
];

/** "search_web, youtube_play_result" → "web_search". */
export function featureOf(tools) {
  const names = String(tools || '').split(/,\s*/).filter(Boolean);
  for (const [pattern, feature] of FEATURES) if (names.some(name => pattern.test(name))) return feature;
  return names.length ? 'other' : 'none';
}

// GA's limits: names up to 40 characters, user property values up to 36, other values up to 100
const shortText = (value, max) => String(value).slice(0, max);

/** The account's details GA may hold, as GA user properties. */
function userProperties(meta = {}, appVersion = '') {
  const props = {
    role: meta.role, age_group: meta.age_group, country: meta.country, county: meta.county, school: meta.school, app_version: appVersion,
  };
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v).map(([k, v]) => [k, { value: shortText(v, 36) }]));
}

export function createAnalytics({
  identity,                                  // () → { userId, meta } of the signed-in account, or null
  clientId,                                  // () → this computer's install id
  appVersion = '',
  measurementId = () => process.env.GA_MEASUREMENT_ID || '',
  apiSecret = () => process.env.GA_API_SECRET || '',
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  flushMs = 20000,
} = {}) {
  let queue = [];
  let session = null;
  let lastEventAt = 0;
  let timer = null;

  const configured = () => MEASUREMENT_ID_RE.test(measurementId()) && API_SECRET_RE.test(apiSecret());

  /** The account, when it may be counted now. */
  function allowedAccount() {
    const who = identity?.();
    return who?.userId && analyticsAllowed(who.meta) ? who : null;
  }

  function sessionId() {
    const t = now();
    if (!session || t - lastEventAt > SESSION_GAP_MS) session = String(Math.floor(t / 1000));
    lastEventAt = t;
    return session;
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs);
    timer.unref?.();
  }

  /** Count one event; false when it isn't (not set up, no consent). */
  function track(name, params = {}) {
    if (!configured() || !allowedAccount()) return false;
    const clean = Object.fromEntries(Object.entries(params)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => [shortText(k, 40), typeof v === 'number' ? v : shortText(v, 100)]));
    queue.push({
      name: shortText(name, 40),
      at: now(),
      params: { ...clean, session_id: sessionId(), engagement_time_msec: Math.max(1, Math.round(Number(params.engagement_time_msec) || 1000)) },
    });
    if (queue.length > MAX_WAITING) queue = queue.slice(-MAX_WAITING);
    if (queue.length >= MAX_BATCH) flush().catch(() => {});
    else schedule();
    return true;
  }

  /** Send what is waiting. Consent withdrawn since: dropped, never sent. */
  async function flush() {
    clearTimeout(timer);
    timer = null;
    const who = allowedAccount();
    if (!who) { queue = []; return null; }
    if (!queue.length || !configured()) return null;
    const batch = queue.splice(0, MAX_BATCH);
    // The team's own use (Developer) is GA's "internal traffic": its Internal
    // traffic data filter keeps it out of the real numbers
    const internal = who.meta.role === 'developer' ? { traffic_type: 'internal' } : {};
    const body = {
      client_id: clientId(),
      user_id: who.userId,
      user_properties: userProperties(who.meta, appVersion),
      events: batch.map(e => ({ name: e.name, params: { ...e.params, ...internal }, timestamp_micros: e.at * 1000 })),
    };
    const url = `${ENDPOINT}?measurement_id=${encodeURIComponent(measurementId())}&api_secret=${encodeURIComponent(apiSecret())}`;
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!res.ok) console.warn(`[Analytics] Google Analytics answered ${res.status}`);
    } catch {
      queue = [...batch, ...queue].slice(-MAX_WAITING); // offline: try again later
      schedule();
      return null;
    }
    if (queue.length) schedule();
    return body;
  }

  /** One voice turn (ws-proxy.js turn log + speed-meter.js timings): what kind, whether it worked, how long. */
  function turn(log = {}, speed = {}) {
    const way = speed.path || log.path || log.outcome;
    if (!['quick', 'ai', 'dictation', 'control'].includes(way)) return false; // noise and nothing heard aren't uses
    return track('voice_command', {
      way,
      ok: log.failed ? 0 : 1,
      duration_ms: speed.totalMs ?? null,
      hearing: speed.hearEngine || null,
      feature: way === 'dictation' ? 'dictation' : featureOf(log.tool),
      engagement_time_msec: speed.totalMs || 1000,
    });
  }

  return { configured, track, turn, flush, waiting: () => queue.length };
}
