'use strict';

/**
 * MolmoWeb grounding adapter — talks to a running MolmoWeb model server:
 *   POST {endpoint}/predict  { prompt, image_base64 }  ->  { ... text ... }
 *
 * MolmoWeb / Molmo emit points as XML-ish tags with coordinates expressed as
 * PERCENTAGES of the image (0–100), e.g.:
 *   <point x="34.5" y="60.2" alt="Wikipedia link">Wikipedia link</point>
 *   <points x1="..." y1="..." .../>
 * We parse the first point and convert to pixels.
 *
 * ⚠ VERIFY AGAINST YOUR LIVE ENDPOINT: the exact response envelope (which JSON
 * field holds the generated text) and the point format can vary by server build.
 * Set MOLMOWEB_RESPONSE_FIELD if the text is not under `response`/`text`/`output`.
 *
 * Returns: { ok, x, y, raw, latencyMs, error }  (x,y in image pixels, top-left origin)
 */

function buildPrompt(instruction) {
  return `Point to the single UI element you should click to accomplish: "${instruction}".`;
}

function extractText(data) {
  if (typeof data === 'string') return data;
  const field = process.env.MOLMOWEB_RESPONSE_FIELD;
  if (field && data && typeof data[field] === 'string') return data[field];
  // Common envelope shapes, in priority order.
  for (const k of ['response', 'text', 'output', 'prediction', 'result', 'generation']) {
    if (data && typeof data[k] === 'string') return data[k];
  }
  // Last resort: stringify so the caller can see what came back.
  return JSON.stringify(data);
}

function parsePoint(text, width, height) {
  if (!text) return null;

  // 1) Molmo percentage points: <point x="34.5" y="60.2" ...>
  const pct = text.match(/x\s*1?\s*=\s*"?(\d+(?:\.\d+)?)"?[^>]*?\by\s*1?\s*=\s*"?(\d+(?:\.\d+)?)"?/i);
  if (pct) {
    const xPct = parseFloat(pct[1]);
    const yPct = parseFloat(pct[2]);
    // Heuristic: values <=100 are percentages; larger values are already pixels.
    if (xPct <= 100 && yPct <= 100) {
      return { x: (xPct / 100) * width, y: (yPct / 100) * height, mode: 'percent' };
    }
    return { x: xPct, y: yPct, mode: 'pixel' };
  }

  // 2) Plain JSON {"x":..,"y":..}
  const jsonMatch = text.match(/\{[^{}]*"x"[^{}]*\}/i);
  if (jsonMatch) {
    try {
      const o = JSON.parse(jsonMatch[0]);
      if (typeof o.x === 'number' && typeof o.y === 'number') {
        const asPct = o.x <= 100 && o.y <= 100;
        return asPct
          ? { x: (o.x / 100) * width, y: (o.y / 100) * height, mode: 'percent?' }
          : { x: o.x, y: o.y, mode: 'pixel' };
      }
    } catch { /* fall through */ }
  }

  // 3) Bare "x, y" pair
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (nums && nums.length >= 2) {
    const a = parseFloat(nums[0]); const b = parseFloat(nums[1]);
    if (a <= 100 && b <= 100) return { x: (a / 100) * width, y: (b / 100) * height, mode: 'percent?' };
    return { x: a, y: b, mode: 'pixel' };
  }
  return null;
}

async function ground({ imageBase64, instruction, width, height, endpoint }) {
  const ep = (endpoint || process.env.MOLMOWEB_ENDPOINT || '').replace(/\/+$/, '');
  if (!ep) return { ok: false, error: 'MOLMOWEB_ENDPOINT not set' };

  const url = `${ep}/predict`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: buildPrompt(instruction), image_base64: imageBase64 }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      return { ok: false, error: `HTTP ${res.status}: ${errText}`, latencyMs };
    }
    const data = await res.json().catch(async () => (await res.text()));
    const raw = extractText(data);
    const pt = parsePoint(raw, width, height);
    if (!pt) return { ok: false, error: 'could not parse a point', raw, latencyMs };
    return { ok: true, x: pt.x, y: pt.y, raw, latencyMs, mode: pt.mode };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - started };
  }
}

module.exports = { ground, name: 'molmoweb' };
