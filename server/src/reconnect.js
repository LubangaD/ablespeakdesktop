/**
 * Capped exponential backoff calculator.
 *
 * nextRetryDelay(attempt) = min(capMs, baseMs * 2^attempt)
 *
 * Server-side source of truth for the backoff curve.
 * The overlay (overlay.html) and Chrome extension (service-worker.js)
 * embed the same one-liner inline — see those files' reconnect comments.
 *
 * @param {number} attempt - 0-based retry count
 * @param {{ baseMs?: number, capMs?: number }} [opts]
 * @returns {number} milliseconds to wait before next attempt
 */
export function nextRetryDelay(attempt, { baseMs = 500, capMs = 15000 } = {}) {
  return Math.min(capMs, baseMs * Math.pow(2, attempt));
}
