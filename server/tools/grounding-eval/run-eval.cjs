'use strict';

/**
 * AbleSpeak — Click-Grounding A/B Harness
 * ----------------------------------------
 * Measures how accurately each "grounding provider" predicts the click point
 * for a natural-language instruction over a screenshot. Scores point-in-box hit
 * rate + normalised center distance + latency, then writes a self-contained HTML
 * report (with overlays), results.json, and results.csv.
 *
 * Usage:
 *   node run-eval.cjs --dataset ./dataset.json
 *   node run-eval.cjs --dataset ./dataset.json --providers gemini
 *   node run-eval.cjs --dataset ./dataset.json --providers gemini,molmoweb --out ./out
 *
 * Env (auto-loaded from ../../.env if present):
 *   GEMINI_API_KEY       required for the gemini provider
 *   GEMINI_MODEL         optional (default gemini-2.5-flash)
 *   MOLMOWEB_ENDPOINT    required for the molmoweb provider (e.g. http://127.0.0.1:8001)
 *
 * Dataset schema (JSON):
 *   { "cases": [
 *       { "id": "wiki-link", "image": "images/shot1.png",
 *         "instruction": "click the Wikipedia link",
 *         "category": "web", "box": [x, y, w, h] }   // box in image pixels, top-left origin
 *   ]}
 *   (A bare top-level array of cases is also accepted.)
 */

const fs = require('fs');
const path = require('path');

// Best-effort .env load (dotenv is already a dependency of the server).
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch { /* optional */ }

const { imageSize } = require('./lib/image-size.cjs');

const PROVIDERS = {
  gemini: require('./providers/gemini.cjs'),
  molmoweb: require('./providers/molmoweb.cjs'),
};
const COLORS = { gemini: '#e07b39', molmoweb: '#4c8bf5' };
const FALLBACK_COLORS = ['#9b59b6', '#16a085', '#c0392b', '#2c3e50'];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function pointInBox(x, y, [bx, by, bw, bh]) {
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
}

function scoreCase(pred, box, diag) {
  if (!pred.ok) return { ...pred, hit: false, normDist: null };
  const hit = pointInBox(pred.x, pred.y, box);
  const cx = box[0] + box[2] / 2;
  const cy = box[1] + box[3] / 2;
  const dist = Math.hypot(pred.x - cx, pred.y - cy);
  return { ...pred, hit, normDist: dist / diag };
}

async function main() {
  const args = parseArgs(process.argv);
  const datasetPath = path.resolve(args.dataset || path.join(__dirname, 'dataset.json'));
  if (!fs.existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}\nCreate one with annotator.html or copy dataset.sample.json.`);
    process.exit(1);
  }
  const datasetDir = path.dirname(datasetPath);
  const outDir = path.resolve(args.out || path.join(__dirname, 'out'));
  fs.mkdirSync(outDir, { recursive: true });

  const raw = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  let cases = Array.isArray(raw) ? raw : raw.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error('Dataset has no cases.');
    process.exit(1);
  }
  if (args.limit) cases = cases.slice(0, parseInt(args.limit, 10));

  const wanted = (args.providers || 'gemini,molmoweb').split(',').map(s => s.trim()).filter(Boolean);
  const active = wanted.filter(p => PROVIDERS[p]);
  if (!active.length) { console.error('No valid providers selected.'); process.exit(1); }

  // Skip molmoweb silently if no endpoint configured (Gemini-baseline-first flow).
  const enabled = active.filter(p => {
    if (p === 'molmoweb' && !process.env.MOLMOWEB_ENDPOINT) {
      console.warn('[skip] molmoweb: MOLMOWEB_ENDPOINT not set — running Gemini baseline only.');
      return false;
    }
    return true;
  });

  console.log(`Cases: ${cases.length} | Providers: ${enabled.join(', ')}`);
  const rows = [];        // flat rows for CSV
  const perCase = [];     // for HTML report

  for (const c of cases) {
    const imgPath = path.isAbsolute(c.image) ? c.image : path.resolve(datasetDir, c.image);
    if (!fs.existsSync(imgPath)) {
      console.warn(`[skip] ${c.id}: image not found (${c.image})`);
      continue;
    }
    const buf = fs.readFileSync(imgPath);
    const { width, height } = imageSize(imgPath);
    const diag = Math.hypot(width, height);
    const imageBase64 = buf.toString('base64');
    const mimeType = mimeFor(imgPath);
    if (!Array.isArray(c.box) || c.box.length !== 4) {
      console.warn(`[skip] ${c.id}: missing/invalid box [x,y,w,h]`);
      continue;
    }

    const caseResult = { id: c.id, instruction: c.instruction, category: c.category || 'uncategorized',
      image: c.image, width, height, box: c.box, dataUri: `data:${mimeType};base64,${imageBase64}`,
      predictions: {} };

    for (const p of enabled) {
      process.stdout.write(`  ${c.id} → ${p} ... `);
      const res = await PROVIDERS[p].ground({ imageBase64, mimeType, instruction: c.instruction, width, height });
      const scored = scoreCase(res, c.box, diag);
      caseResult.predictions[p] = scored;
      console.log(scored.ok ? (scored.hit ? `HIT (${scored.latencyMs}ms)` : `miss (${scored.latencyMs}ms)`) : `ERROR: ${scored.error}`);
      rows.push({
        case_id: c.id, category: caseResult.category, provider: p,
        ok: scored.ok, hit: scored.hit,
        pred_x: scored.ok ? Math.round(scored.x) : '', pred_y: scored.ok ? Math.round(scored.y) : '',
        box_x: c.box[0], box_y: c.box[1], box_w: c.box[2], box_h: c.box[3],
        norm_dist: scored.normDist != null ? scored.normDist.toFixed(4) : '',
        latency_ms: scored.latencyMs ?? '', error: scored.error || '',
      });
    }
    perCase.push(caseResult);
  }

  // ── Aggregate ──
  const summary = aggregate(rows, enabled);

  // ── Write outputs ──
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ summary, rows, perCase: perCase.map(stripDataUri) }, null, 2));
  fs.writeFileSync(path.join(outDir, 'results.csv'), toCsv(rows));
  fs.writeFileSync(path.join(outDir, 'report.html'), renderHtml(summary, perCase, enabled));

  console.log('\n=== Summary (overall) ===');
  for (const p of enabled) {
    const s = summary.overall[p];
    console.log(`  ${p}: ${s.hits}/${s.n} hits (${(s.hitRate * 100).toFixed(1)}%), median normDist ${s.medianNormDist != null ? s.medianNormDist.toFixed(4) : 'n/a'}, mean ${s.meanLatency != null ? Math.round(s.meanLatency) : 'n/a'}ms, ${s.errors} errors`);
  }
  console.log(`\nReport: ${path.join(outDir, 'report.html')}`);
}

function aggregate(rows, providers) {
  const byCat = {};
  const overall = {};
  const mkBucket = () => ({ n: 0, hits: 0, errors: 0, dists: [], lats: [] });
  for (const p of providers) overall[p] = mkBucket();

  for (const r of rows) {
    const cat = r.category;
    byCat[cat] = byCat[cat] || {};
    byCat[cat][r.provider] = byCat[cat][r.provider] || mkBucket();
    for (const bucket of [overall[r.provider], byCat[cat][r.provider]]) {
      if (!bucket) continue;
      bucket.n += 1;
      if (!r.ok) { bucket.errors += 1; continue; }
      if (r.hit) bucket.hits += 1;
      if (r.norm_dist !== '') bucket.dists.push(parseFloat(r.norm_dist));
      if (r.latency_ms !== '') bucket.lats.push(Number(r.latency_ms));
    }
  }
  const finalize = (b) => ({
    n: b.n, hits: b.hits, errors: b.errors,
    hitRate: b.n ? b.hits / b.n : 0,
    medianNormDist: median(b.dists), meanLatency: mean(b.lats),
  });
  const out = { overall: {}, byCategory: {} };
  for (const p of providers) out.overall[p] = finalize(overall[p]);
  for (const cat of Object.keys(byCat)) {
    out.byCategory[cat] = {};
    for (const p of providers) if (byCat[cat][p]) out.byCategory[cat][p] = finalize(byCat[cat][p]);
  }
  return out;
}

function stripDataUri(c) { const { dataUri, ...rest } = c; return rest; }

function toCsv(rows) {
  const cols = ['case_id', 'category', 'provider', 'ok', 'hit', 'pred_x', 'pred_y', 'box_x', 'box_y', 'box_w', 'box_h', 'norm_dist', 'latency_ms', 'error'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

function colorFor(provider, idx) { return COLORS[provider] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length]; }

function renderHtml(summary, perCase, providers) {
  const esc = (s) => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  const summaryRows = [];
  const addRow = (scope, p, s) => summaryRows.push(
    `<tr><td>${esc(scope)}</td><td><span class="dot" style="background:${colorFor(p, providers.indexOf(p))}"></span>${esc(p)}</td>` +
    `<td>${s.hits}/${s.n}</td><td><b>${(s.hitRate * 100).toFixed(1)}%</b></td>` +
    `<td>${s.medianNormDist != null ? s.medianNormDist.toFixed(4) : '—'}</td>` +
    `<td>${s.meanLatency != null ? Math.round(s.meanLatency) : '—'}</td><td>${s.errors}</td></tr>`
  );
  for (const p of providers) addRow('overall', p, summary.overall[p]);
  for (const cat of Object.keys(summary.byCategory)) {
    for (const p of providers) if (summary.byCategory[cat][p]) addRow(cat, p, summary.byCategory[cat][p]);
  }

  const caseCards = perCase.map(c => {
    const points = providers.map((p, i) => {
      const pr = c.predictions[p];
      if (!pr || !pr.ok) return '';
      const col = colorFor(p, i);
      return `<circle cx="${pr.x}" cy="${pr.y}" r="9" fill="${col}" fill-opacity="0.85" stroke="white" stroke-width="2"/>` +
             `<text x="${pr.x + 12}" y="${pr.y + 4}" fill="${col}" font-size="16" font-weight="700" stroke="white" stroke-width="0.5">${esc(p)}${pr.hit ? ' ✓' : ' ✗'}</text>`;
    }).join('');
    const [bx, by, bw, bh] = c.box;
    const legend = providers.map((p, i) => {
      const pr = c.predictions[p];
      const status = !pr ? '—' : (!pr.ok ? `error: ${esc(pr.error || '')}` : (pr.hit ? 'HIT' : 'miss') + ` · ${pr.latencyMs}ms · normDist ${pr.normDist != null ? pr.normDist.toFixed(3) : '—'}`);
      return `<div><span class="dot" style="background:${colorFor(p, i)}"></span><b>${esc(p)}</b>: ${status}` +
             (pr && pr.raw ? `<div class="raw">${esc(String(pr.raw).slice(0, 160))}</div>` : '') + `</div>`;
    }).join('');
    return `<div class="card">
      <div class="card-h"><b>${esc(c.id)}</b> <span class="cat">${esc(c.category)}</span><div class="instr">"${esc(c.instruction)}"</div></div>
      <svg viewBox="0 0 ${c.width} ${c.height}" class="shot">
        <image href="${c.dataUri}" x="0" y="0" width="${c.width}" height="${c.height}"/>
        <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="#2ecc71" stroke-width="3" stroke-dasharray="6 4"/>
        ${points}
      </svg>
      <div class="legend">${legend}</div>
    </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>AbleSpeak Grounding A/B</title>
<style>
  body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1a1a1a;background:#fafafa}
  h1{font-size:20px} h2{font-size:16px;margin-top:28px}
  table{border-collapse:collapse;margin:12px 0;background:#fff} th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
  th{background:#f0f0f0}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:18px}
  .card{background:#fff;border:1px solid #e2e2e2;border-radius:8px;padding:12px}
  .card-h{margin-bottom:8px} .cat{background:#eee;border-radius:4px;padding:1px 8px;font-size:12px;margin-left:6px}
  .instr{color:#555;font-style:italic;margin-top:4px}
  .shot{width:100%;height:auto;border:1px solid #ccc;border-radius:4px;background:#000}
  .legend{margin-top:8px;font-size:13px} .legend>div{margin:3px 0}
  .raw{color:#888;font-size:11px;font-family:ui-monospace,monospace;margin:2px 0 6px 16px}
  .note{color:#666;font-size:12px;margin-top:6px}
</style></head><body>
  <h1>AbleSpeak — Click-Grounding A/B</h1>
  <div class="note">Green dashed box = ground-truth target. Dots = each provider's predicted click point (✓ inside box, ✗ miss). Distance is normalised by image diagonal.</div>
  <h2>Summary</h2>
  <table><thead><tr><th>Scope</th><th>Provider</th><th>Hits</th><th>Hit rate</th><th>Median normDist</th><th>Mean latency (ms)</th><th>Errors</th></tr></thead>
  <tbody>${summaryRows.join('')}</tbody></table>
  <h2>Cases (${perCase.length})</h2>
  <div class="cards">${caseCards}</div>
</body></html>`;
}

main().catch(err => { console.error(err); process.exit(1); });
