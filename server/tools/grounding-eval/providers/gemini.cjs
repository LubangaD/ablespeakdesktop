'use strict';

/**
 * Gemini grounding adapter — mirrors how AbleSpeak calls Gemini in production
 * (server/src/ai-engine.js _callGemini):
 *   - same base URL + default model (gemini-2.5-flash)
 *   - screenshot attached as inline_data on the user message
 *   - thinkingBudget: 0 for gemini-2.5* (voice path needs speed, not reasoning)
 *
 * Difference for evaluation: instead of function-calling, we ask for a single
 * click POINT as strict JSON in the image's own pixel space, and use
 * temperature 0 for deterministic, repeatable measurements.
 *
 * Returns: { ok, x, y, raw, latencyMs, error }
 *   x, y are pixel coordinates in the supplied image (top-left origin).
 */

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function buildPrompt(instruction, width, height) {
  return (
    `You are a precise UI grounding model. The attached screenshot is exactly ` +
    `${width} pixels wide and ${height} pixels tall, with (0,0) at the TOP-LEFT.\n` +
    `Identify the single best on-screen target to satisfy this instruction:\n` +
    `"${instruction}"\n\n` +
    `Respond with ONLY a compact JSON object giving the pixel coordinates to click ` +
    `at the CENTER of that target, no prose, no code fences:\n` +
    `{"x": <integer 0-${width}>, "y": <integer 0-${height}>}`
  );
}

function parsePoint(text, width, height) {
  if (!text) return null;
  // Prefer a JSON object; fall back to the first "x..y" number pair.
  const jsonMatch = text.match(/\{[^{}]*"x"[^{}]*\}/i);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj.x === 'number' && typeof obj.y === 'number') {
        return { x: obj.x, y: obj.y };
      }
    } catch { /* fall through */ }
  }
  const nums = text.match(/-?\d+(\.\d+)?/g);
  if (nums && nums.length >= 2) {
    return { x: parseFloat(nums[0]), y: parseFloat(nums[1]) };
  }
  return null;
}

/**
 * @param {object} args
 * @param {string} args.imageBase64  base64 (no data: prefix)
 * @param {string} args.mimeType     e.g. 'image/png'
 * @param {string} args.instruction
 * @param {number} args.width
 * @param {number} args.height
 * @param {string} [args.model]
 * @param {string} [args.apiKey]
 */
async function ground({ imageBase64, mimeType, instruction, width, height, model, apiKey }) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  const mdl = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!key) return { ok: false, error: 'GEMINI_API_KEY not set' };

  const generationConfig = { temperature: 0 };
  if (/^gemini-2\.5/.test(mdl)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: buildPrompt(instruction, width, height) },
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig,
  };

  const url = `${BASE_URL}/models/${mdl}:generateContent?key=${key}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      return { ok: false, error: `HTTP ${res.status}: ${errText}`, latencyMs };
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const raw = parts.filter(p => p.text).map(p => p.text).join('').trim();
    const pt = parsePoint(raw, width, height);
    if (!pt) return { ok: false, error: 'could not parse a point', raw, latencyMs };
    return { ok: true, x: pt.x, y: pt.y, raw, latencyMs };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - started };
  }
}

module.exports = { ground, name: 'gemini' };
