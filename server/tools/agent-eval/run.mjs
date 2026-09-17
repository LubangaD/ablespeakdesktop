#!/usr/bin/env node
/**
 * Stage 3 acceptance: run the 20 multi-step tasks through the running
 * AbleSpeak app and write down completion rate and recovery rate.
 *
 *   node tools/agent-eval/run.mjs              plans only — nothing on screen changes
 *   node tools/agent-eval/run.mjs --live --yes runs every task on this computer
 *   node tools/agent-eval/run.mjs --live --yes --only notepad-type,calculator-add
 *
 * AbleSpeak must be running (http://localhost:3001) with an AI key.
 *
 * --live opens apps, types and clicks on THIS computer. Close anything you
 * are working on first. Apps a task opens are closed afterwards; apps that
 * were already open are left alone (so a task may type into your open Word
 * document). Confirmations inside tasks (e.g. closing Notepad) are answered
 * "yes" only for tasks marked "confirm".
 *
 * Results: docs/measurements/agent-eval-<date>.md and .json
 *   completion rate = tasks whose checks all passed / tasks run
 *   recovery rate   = tasks that re-planned at least once and still passed
 *                     / tasks that re-planned at least once
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ABLESPEAK_URL || 'http://localhost:3001';
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const only = (args[args.indexOf('--only') + 1] || '').split(',').filter(Boolean);
const OUT = resolve(join(here, '..', '..', '..', 'docs', 'measurements'));

if (LIVE && !args.includes('--yes')) {
  console.error('--live opens apps, types and clicks on this computer. Add --yes to confirm you have closed your own work.');
  process.exit(1);
}

const pad = n => String(n).padStart(2, '0');
const now = new Date();
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const stamp = `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function runningProcesses() {
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).map(line => line.split('","')[0].replace(/^"/, '').replace(/\.exe$/i, '').toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function closeProcess(name) {
  try { execFileSync('taskkill', ['/im', `${name}.exe`, '/f'], { stdio: 'ignore' }); } catch {}
}

async function check(spec) {
  if (spec.kind === 'gone') {
    const screen = await api('GET', `/screen?app=${encodeURIComponent(spec.app)}&fresh=1`);
    return { ok: !screen.ok, detail: screen.ok ? `still open: ${screen.data.window}` : 'closed' };
  }
  if (spec.kind === 'text') {
    const read = await api('GET', `/screen/text?app=${encodeURIComponent(spec.app)}`);
    if (!read.ok) return { ok: false, detail: read.data.message || 'could not read' };
    const text = String(read.data.text || '');
    const missing = (spec.includes || []).filter(t => !text.toLowerCase().includes(t.toLowerCase()));
    const unwanted = (spec.excludes || []).filter(t => text.toLowerCase().includes(t.toLowerCase()));
    return { ok: !missing.length && !unwanted.length, detail: missing.length ? `missing ${missing.join(', ')}` : unwanted.length ? `still has ${unwanted.join(', ')}` : 'text found' };
  }
  const screen = await api('GET', `/screen?app=${encodeURIComponent(spec.app)}&fresh=1`);
  if (!screen.ok) return { ok: false, detail: screen.data.message || 'window not found' };
  if (spec.kind === 'window') {
    const ok = screen.data.window.toLowerCase().includes(spec.titleIncludes.toLowerCase());
    return { ok, detail: `window "${screen.data.window}"` };
  }
  if (spec.kind === 'control') {
    const hit = screen.data.elements.find(e => `${e.name} ${e.value || ''}`.toLowerCase().includes(spec.nameIncludes.toLowerCase()));
    return { ok: !!hit, detail: hit ? `found ${hit.type} "${hit.name}"` : `no control mentioning "${spec.nameIncludes}"` };
  }
  return { ok: false, detail: `unknown check ${spec.kind}` };
}

const { tasks } = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const chosen = only.length ? tasks.filter(t => only.includes(t.id)) : tasks;

const status = await api('GET', '/ai/status').catch(() => null);
if (!status?.ok) {
  console.error(`AbleSpeak is not answering at ${BASE}. Start the app first.`);
  process.exit(1);
}

const results = [];
for (const task of chosen) {
  process.stdout.write(`${task.id} … `);
  if (!LIVE) {
    const plan = await api('POST', '/agent/plan', { instruction: task.instruction });
    const steps = plan.data.steps || [];
    results.push({ id: task.id, instruction: task.instruction, planned: steps.length, steps: steps.map(s => s.do), reason: plan.data.reason || null, error: plan.ok ? null : plan.data.error });
    console.log(plan.ok ? `${steps.length} steps` : `error: ${plan.data.error}`);
    continue;
  }

  const before = runningProcesses();
  const started = Date.now();
  const run = await api('POST', '/agent/run', { instruction: task.instruction, autoConfirm: task.confirm === true });
  await sleep(1500); // let the last action settle before reading the screen
  const checks = [];
  for (const spec of task.checks) checks.push({ ...spec, ...(await check(spec)) });
  const passed = run.ok && checks.every(c => c.ok);
  results.push({
    id: task.id,
    instruction: task.instruction,
    status: run.data.status || 'error',
    said: run.data.text || run.data.error,
    steps: (run.data.record || []).map(r => ({ do: r.do, tool: r.tool, ok: r.ok, why: r.why })),
    replans: run.data.replans || 0,
    confirmations: run.data.confirmations || 0,
    ms: Date.now() - started,
    checks,
    passed,
  });
  console.log(`${passed ? 'PASS' : 'FAIL'} (${run.data.status}, ${run.data.replans || 0} re-plans, ${Math.round((Date.now() - started) / 1000)} s)`);

  for (const app of task.apps || []) {
    if (!before.has(app.toLowerCase())) closeProcess(app);
  }
  await sleep(1000);
}

mkdirSync(OUT, { recursive: true });
const name = `agent-eval-${date}${LIVE ? '' : '-plans'}`;
if (LIVE) {
  const passed = results.filter(r => r.passed).length;
  const replanned = results.filter(r => r.replans > 0);
  const recovered = replanned.filter(r => r.passed).length;
  const summary = {
    date: stamp,
    tasks: results.length,
    completed: passed,
    completionRate: results.length ? passed / results.length : null,
    replanned: replanned.length,
    recovered,
    recoveryRate: replanned.length ? recovered / replanned.length : null,
    medianSeconds: results.length ? Math.round([...results].sort((a, b) => a.ms - b.ms)[Math.floor(results.length / 2)].ms / 1000) : null,
    results,
  };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(summary, null, 2));
  const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const md = `# Task agent evaluation — ${date}

Run ${stamp} with \`node tools/agent-eval/run.mjs --live\` on one machine: ${results.length} tasks from \`tools/agent-eval/tasks.json\`, each run once.

| Measure | Result |
|---|---|
| Completion rate | **${pct(summary.completionRate)}** (${passed} of ${results.length}) |
| Recovery rate | **${pct(summary.recoveryRate)}** (${recovered} of ${replanned.length} tasks that needed a new plan) |
| Median time per task | ${summary.medianSeconds} s |

| Task | Result | Re-plans | Time | What AbleSpeak said | Check |
|---|---|---|---|---|---|
${results.map(r => `| ${r.id} | ${r.passed ? 'pass' : 'fail'} (${r.status}) | ${r.replans} | ${Math.round(r.ms / 1000)} s | ${String(r.said || '').replace(/\|/g, '/').slice(0, 90)} | ${r.checks.map(c => c.detail).join('; ').replace(/\|/g, '/')} |`).join('\n')}

Sample size: ${results.length} tasks, one run each, one computer. Raw data: \`${name}.json\`.
`;
  writeFileSync(join(OUT, `${name}.md`), md);
  console.log(`\nCompletion ${pct(summary.completionRate)}, recovery ${pct(summary.recoveryRate)}. Wrote ${join(OUT, `${name}.md`)}`);
} else {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ date: stamp, plansOnly: true, results }, null, 2));
  const planned = results.filter(r => r.planned > 0).length;
  console.log(`\n${planned} of ${results.length} tasks got a plan. Nothing was run. Wrote ${join(OUT, `${name}.json`)}`);
}
