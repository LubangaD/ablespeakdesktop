#!/usr/bin/env node
/**
 * UI Automation latency and coverage (Stage 0 week 2, Stage 2 coverage matrix).
 *
 * For each target app that is open, reads its window several times with the
 * screen model and with the older PowerShell scan, and records what the app
 * exposes: controls, which actions they support, and how many have no name.
 *
 *   node tools/uia-bench.mjs [--runs 7] [--out ../docs/measurements]
 *
 * Writes uia-latency-<date>.md and .json. Open the apps you want measured
 * first; apps that are not open are listed as "not open", not guessed.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { cpus, totalmem, release } from 'os';
import { listVisibleWindows, listDesktopElements, warmupSystemTools } from '../src/system-tools.js';
import { getScreenModel } from '../src/screen-model.js';
import { localDate, localDateTime } from '../src/local-time.js';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const RUNS = Math.max(3, Number(arg('runs', 7)));
const OUT = resolve(arg('out', join(here, '..', '..', 'docs', 'measurements')));
const THRESHOLD_MS = 200;

// The five apps named in the roadmap, then anything else worth knowing.
const TARGETS = [
  { label: 'Word', match: w => w.process.toLowerCase() === 'winword', scan: 'winword' },
  { label: 'Chrome', match: w => w.process.toLowerCase() === 'chrome', scan: 'chrome' },
  { label: 'Edge', match: w => w.process.toLowerCase() === 'msedge', scan: 'msedge' },
  { label: 'File Explorer', match: w => w.process.toLowerCase() === 'explorer' && / - File Explorer$/.test(w.title), scan: 'File Explorer' },
  { label: 'Zoom', match: w => /^zoom/i.test(w.process), scan: 'zoom' },
  { label: 'WhatsApp', match: w => /whatsapp/i.test(w.process) || /WhatsApp/.test(w.title), scan: 'whatsapp' },
  { label: 'Spotify', match: w => w.process.toLowerCase() === 'spotify', scan: 'spotify' },
  { label: 'Notepad', match: w => w.process.toLowerCase() === 'notepad', scan: 'notepad' },
];
const CORE = new Set(['Word', 'Chrome', 'Edge', 'File Explorer', 'Zoom', 'WhatsApp']);

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function time(fn) {
  const started = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - started), value };
}

async function measure(target, window) {
  const warm = await getScreenModel({ target: window, fresh: true, maxElements: 400 }); // warm-up, not counted
  if (warm.code === 'MINIMIZED') return { label: target.label, window: window.title, error: 'minimized — restore it and run again' };
  const times = [];
  let model;
  for (let i = 0; i < RUNS; i++) {
    const { ms, value } = await time(() => getScreenModel({ target: window, fresh: true, maxElements: 400 }));
    if (value.status !== 'success') {
      return { label: target.label, window: window.title, error: value.code === 'MINIMIZED' ? 'minimized — restore it and run again' : value.message };
    }
    times.push(ms);
    model = value;
  }
  times.sort((a, b) => a - b);

  const oldTimes = [];
  let oldCount = null;
  for (let i = 0; i < 3; i++) {
    const { ms, value } = await time(() => listDesktopElements(target.scan));
    oldTimes.push(ms);
    if (value.status === 'success') oldCount = value.count;
  }
  oldTimes.sort((a, b) => a - b);

  const actionable = model.elements.filter(e => e.actions.length);
  const count = action => actionable.filter(e => e.actions.includes(action)).length;
  return {
    label: target.label,
    window: model.window,
    process: window.process,
    runs: RUNS,
    p50: pct(times, 50),
    p95: pct(times, 95),
    min: times[0],
    max: times.at(-1),
    uiaReadP50: null,
    controls: model.total,
    actionable: model.actionable,
    unnamedActionable: actionable.filter(e => !e.name).length,
    actions: {
      invoke: count('invoke'),
      set_value: count('set_value'),
      toggle: count('toggle'),
      expand_collapse: count('expand_collapse'),
      select: count('select'),
      scroll: count('scroll'),
      read_text: count('read_text'),
    },
    oldScan: { p50: pct(oldTimes, 50), elements: oldCount },
  };
}

function verdict(r) {
  if (r.error) return 'Could not read';
  if (r.actionable < 5) return 'Tree nearly empty — vision fallback needed';
  if (r.unnamedActionable / r.actionable > 0.4) return 'Many unnamed controls — names need help';
  return 'Tree usable';
}

const t0 = performance.now();
await warmupSystemTools();
const warmup = Math.round(performance.now() - t0);
const windows = await listVisibleWindows();
const windowList = await time(() => listVisibleWindows());

const results = [];
for (const target of TARGETS) {
  const window = windows.find(target.match);
  if (!window) {
    results.push({ label: target.label, notOpen: true });
    continue;
  }
  process.stdout.write(`Measuring ${target.label}… `);
  const r = await measure(target, window);
  results.push(r);
  console.log(r.error ? `error: ${r.error}` : `p50 ${r.p50} ms, p95 ${r.p95} ms, ${r.controls} controls`);
}

const measured = results.filter(r => !r.notOpen && !r.error);
const allTimes = measured.map(r => r.p50).sort((a, b) => a - b);
const machine = `${cpus()[0]?.model?.trim() || 'unknown CPU'}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB RAM, Windows ${release()}, Node ${process.version} (${process.arch})`;
const date = localDate();

const summary = {
  date,
  takenAt: localDateTime(),
  machine,
  runsPerApp: RUNS,
  thresholdMs: THRESHOLD_MS,
  workerWarmupMs: warmup,
  windowListMs: windowList.ms,
  medianOfAppP50: allTimes.length ? allTimes[Math.floor(allTimes.length / 2)] : null,
  worstP95: measured.length ? Math.max(...measured.map(r => r.p95)) : null,
  results,
};

const rows = results.map(r => {
  if (r.notOpen) return `| ${r.label} | not open | | | | | | | |`;
  if (r.error) return `| ${r.label} | could not read: ${r.error} | | | | | | | |`;
  const a = r.actions;
  return `| ${r.label} | ${r.p50} / ${r.p95} | ${r.oldScan.p50} (${r.oldScan.elements ?? 'failed'}) | ${r.controls} | ${r.actionable} | ${r.unnamedActionable} | ${a.invoke} / ${a.set_value} / ${a.toggle} / ${a.expand_collapse} / ${a.select} | ${a.scroll} / ${a.read_text} | ${verdict(r)} |`;
});

const coreMissing = results.filter(r => r.notOpen && CORE.has(r.label)).map(r => r.label);
const decision = summary.worstP95 == null
  ? 'No app was measured.'
  : summary.worstP95 <= THRESHOLD_MS
    ? `Every measured app read in ${summary.worstP95} ms or less at p95, inside the ${THRESHOLD_MS} ms line. The persistent PowerShell worker with the compiled screen model is fast enough; a separate native sidecar is not needed yet.`
    : `The slowest app took ${summary.worstP95} ms at p95, over the ${THRESHOLD_MS} ms line. Reads should stay cached and be refreshed only on window change, and a native sidecar should be scoped for the slow apps.`;

const markdown = `# UI Automation latency and coverage — ${date}

Measured ${summary.takenAt} with \`node tools/uia-bench.mjs\` on one machine:
${machine}.

Each app was read ${RUNS} times after one warm-up read, with the screen model
(\`src/screen-model.js\`: the persistent PowerShell worker running compiled C#
with a UI Automation cache request, up to 400 controls). "Old scan" is the
earlier PowerShell loop (\`list_desktop_elements\`, capped at 60 controls),
median of 3.

**Decision line: ${THRESHOLD_MS} ms per read.** ${decision}

| App | Read p50 / p95 (ms) | Old scan p50 (ms, controls) | Controls | With actions | Unnamed with actions | Invoke / Value / Toggle / Expand / Select | Scroll / Text | Verdict |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

- Worker start-up (once per app launch): ${warmup} ms
- Listing open windows (once per command): ${windowList.ms} ms
- Sample size: ${measured.length} app${measured.length === 1 ? '' : 's'} × ${RUNS} reads, one machine, one sitting.
${coreMissing.length ? `- Not measured because they were not open: ${coreMissing.join(', ')}. Open them and run the script again.\n` : ''}
Raw numbers: \`uia-latency-${date}.json\`.
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `uia-latency-${date}.json`), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, `uia-latency-${date}.md`), markdown);
console.log(`\n${decision}\nWrote ${join(OUT, `uia-latency-${date}.md`)}`);
process.exit(0);
