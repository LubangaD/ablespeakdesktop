/**
 * When an AI call fails. After ARTEMIS's llm/reliability.py (Google,
 * Apache-2.0), adapted for voice: a busy model (rate limit, overloaded,
 * server error) is tried once more on a backup model straight away, and a
 * model that keeps failing is skipped for a minute. ARTEMIS waits 10–60 s
 * between tries; a person waiting on a spoken command can't, so anything
 * else (a bad request, a missing key, the person saying "stop") fails at once.
 */

/**
 * What kind of failure an AI call ended in:
 *   stopped  the person said "stop" (never retried)
 *   timeout  no answer in time (already retried by _fetchWithRetry)
 *   auth     the key is missing or refused
 *   busy     rate limit, quota, overloaded or a server error: try the backup model
 *   network  no connection (the backup model is on the same server)
 *   other    anything else, e.g. a bad request
 */
export function classifyFailure(err, { stopped = false } = {}) {
  if (stopped) return 'stopped';
  const text = `${err?.name || ''} ${err?.message || ''}`;
  if (/AbortError|TimeoutError|aborted/i.test(text)) return 'timeout';
  if (/\b(401|403)\b|API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) return 'auth';
  if (/\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|rate.?limit/i.test(text)) return 'busy';
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(text)) return 'network';
  return 'other';
}

/**
 * A model that was busy `threshold` times in a row is skipped for `coolMs`:
 * the next calls go to the backup model at once instead of waiting for the
 * busy one to fail again.
 */
export class CircuitBreaker {
  constructor({ threshold = 3, coolMs = 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { threshold, coolMs, now });
    this.models = new Map(); // model → { busy, until }
  }

  isOpen(model) {
    return (this.models.get(model)?.until || 0) > this.now();
  }

  /** One more busy answer. Returns true when the model is now skipped. */
  failure(model) {
    const state = this.models.get(model) || { busy: 0, until: 0 };
    state.busy++;
    if (state.busy >= this.threshold) {
      state.busy = 0;
      state.until = this.now() + this.coolMs;
    }
    this.models.set(model, state);
    return this.isOpen(model);
  }

  success(model) {
    this.models.delete(model);
  }
}

// Backup models, best first: a lighter model from the same provider, which
// is served from separate capacity. Gemini 2.5 first, as its thinking can be
// switched off (_callGemini); newer models think by default and answer slower.
export const FALLBACK_PREFER = {
  gemini: [/^gemini-2\.5-flash-lite$/, /^gemini-2\.0-flash$/, /^gemini-2\.5-flash$/],
  openai: [/^gpt-4\.1-mini$/, /^gpt-4o-mini$/, /^gpt-4o$/],
  anthropic: [/haiku/, /sonnet/],
};

const version = name => parseFloat(String(name).match(/(\d+(?:\.\d+)?)/)?.[1] || '0');

/**
 * The backup for `current` among the provider's live `models`: the one set
 * in LLM_FALLBACK_MODEL, else the first match of `prefer` (newest version
 * first) that isn't `current`. Null when there is none.
 */
export function pickFallbackModel(models, current, prefer = [], override = '') {
  if (override && override !== current) return override;
  for (const pattern of prefer) {
    const match = (models || [])
      .filter(m => m !== current && pattern.test(m))
      .sort((a, b) => version(b) - version(a))[0];
    if (match) return match;
  }
  return null;
}
