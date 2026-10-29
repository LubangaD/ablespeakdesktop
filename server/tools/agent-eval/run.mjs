#!/usr/bin/env node
/**
 * Stage 3 acceptance: run the multi-step tasks through the running AbleSpeak
 * app and write down completion rate and recovery rate.
 *
 *   node tools/agent-eval/run.mjs                         plans only — nothing on screen changes
 *   node tools/agent-eval/run.mjs --live --yes            runs every task on this computer
 *   node tools/agent-eval/run.mjs --live --yes --runs 3   three times; lowest, typical and highest reported
 *   node tools/agent-eval/run.mjs --live --yes --only notepad-type,calculator-add
 *   node tools/agent-eval/run.mjs --live --yes --label baseline   → agent-eval-<date>-baseline.md
 *
 * AbleSpeak must be running (http://localhost:3001) with an AI key. Run it on
 * the test laptop in its own Windows account (see README.md): a live run
 * opens apps, types and clicks, and the browser tasks act in whatever Chrome
 * and Edge windows are open.
 *
 * --live: apps a task opens are closed afterwards; apps that were already
 * open are left alone. Word and Excel are asked to quit without saving, never
 * killed. Confirmations inside tasks (e.g. closing Notepad) are answered
 * "yes" only for tasks marked "confirm". The files some tasks open or save
 * (ablespeak-eval.txt, ablespeak-eval.pdf, eval-saved.txt) are made and
 * cleared in Documents before each run.
 *
 * Results: docs/measurements/agent-eval-<date>[-label].md and .json
 *   completion rate      = tasks whose checks all passed / tasks run
 *   completed and said so = checks passed AND AbleSpeak said it finished
 *   false "done"          = AbleSpeak said it finished but a check failed
 *   recovery rate        = tasks that re-planned at least once and still passed
 *                          / tasks that re-planned at least once
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ABLESPEAK_URL || 'http://localhost:3001';
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const valueOf = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] || '' : '');
const only = valueOf('--only').split(',').filter(Boolean);
const label = valueOf('--label').replace(/[^\w-]/g, ''); // e.g. --label baseline, so reruns on one day don't overwrite
const RUNS = LIVE ? Math.max(1, parseInt(valueOf('--runs') || '1', 10) || 1) : 1;
const OUT = resolve(join(here, '..', '..', '..', 'docs', 'measurements'));
const RENDER = valueOf('--render'); // rebuild the .md report from a saved .json, nothing runs
// --fresh-notepad: forget Notepad's unsaved tabs before the run (only while
// Notepad is closed), so no restored tab or "Keep unsaved changes?" pop-up
// is there for a task to type into. Deletes whatever unsaved tabs exist: for
// the test account, not a person's own machine.
const FRESH_NOTEPAD = args.includes('--fresh-notepad');

if (LIVE && !args.includes('--yes')) {
  console.error('--live opens apps, types and clicks on this computer. Add --yes to confirm you have closed your own work.');
  process.exit(1);
}

const pad = n => String(n).padStart(2, '0');
const now = new Date();
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const stamp = `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ps = (script, timeout = 30000) => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout }).trim();

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** The Explorer folder windows open now, by window handle. */
function explorerWindows() {
  try {
    const out = ps("foreach ($w in @((New-Object -ComObject Shell.Application).Windows())) { if ($w.FullName -like '*explorer.exe') { $w.HWND } }");
    return new Set(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Close the Explorer folder windows a task opened (File Explorer is one process, so they can't be closed by name). */
function closeNewExplorerWindows(before) {
  const opened = [...explorerWindows()].filter(h => !before.has(h));
  if (!opened.length) return;
  try {
    ps(`foreach ($w in @((New-Object -ComObject Shell.Application).Windows())) { if (@(${opened.join(',')}) -contains $w.HWND) { $w.Quit() } }`);
  } catch {}
}

function runningProcesses() {
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).map(line => line.split('","')[0].replace(/^"/, '').replace(/\.exe$/i, '').toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// Office apps restore the document on their next start after a forced kill,
// so they are asked to quit without saving. A dialog the task left open
// ("Save your changes?") blocks that, so its "Don't Save" is pressed first.
const OFFICE = { winword: ['WINWORD', 'Word.Application', '$a.Quit(0)'], excel: ['EXCEL', 'Excel.Application', '$a.DisplayAlerts = $false; $a.Quit()'] };

// Notepad keeps unsaved tabs across a forced kill and shows "Keep unsaved
// changes?" on its next start, which blocked the next task's dialog (24 Oct
// 2026): it is closed through its window, answering "Don't save".
const NOTEPAD_CLOSE = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
for ($round = 0; $round -lt 3 -and (Get-Process Notepad -ErrorAction SilentlyContinue); $round++) {
  Get-Process Notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Milliseconds 1500
  $buttons = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  foreach ($p in Get-Process Notepad -ErrorAction SilentlyContinue) {
    $own = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $own)) {
      foreach ($b in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttons)) {
        if ($b.Current.Name -match "^Don'?t save$") { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
      }
    }
  }
  Start-Sleep -Milliseconds 1500
}
if (Get-Process Notepad -ErrorAction SilentlyContinue) { 'OPEN' } else { 'CLOSED' }`;

function closeProcess(name) {
  if (name.toLowerCase() === 'notepad') {
    let state = 'OPEN';
    try { state = ps(NOTEPAD_CLOSE, 40000); } catch {}
    if (!state.endsWith('CLOSED')) { try { execFileSync('taskkill', ['/im', 'notepad.exe', '/f'], { stdio: 'ignore' }); } catch {} }
    return;
  }
  const office = OFFICE[name.toLowerCase()];
  if (!office) {
    try { execFileSync('taskkill', ['/im', `${name}.exe`, '/f'], { stdio: 'ignore' }); } catch {}
    return;
  }
  const [proc, com, quit] = office;
  // Excel is often not reachable through COM from here (it registers itself
  // late), so after the COM quit the main window is closed and the "Don't
  // Save" button of the dialog that follows is pressed.
  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function PressDontSave {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Don't Save")
  foreach ($p in Get-Process ${proc} -ErrorAction SilentlyContinue) {
    $own = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $own)) {
      $b = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
      if ($b) { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    }
  }
}
PressDontSave
try { $a = [Runtime.InteropServices.Marshal]::GetActiveObject('${com}'); ${quit} } catch {}
Start-Sleep -Seconds 2
if (Get-Process ${proc} -ErrorAction SilentlyContinue) {
  Get-Process ${proc} -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 2
  PressDontSave
}
for ($i = 0; $i -lt 16 -and (Get-Process ${proc} -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
if (Get-Process ${proc} -ErrorAction SilentlyContinue) { 'OPEN' } else { 'CLOSED' }`;
  let state = 'OPEN';
  try { state = ps(script, 60000); } catch {}
  if (!state.endsWith('CLOSED')) console.log(`  ${proc} is still open — close it without saving.`);
}

// ── Files the tasks open or save, in Documents ──

let documents = null;
function documentsFolder() {
  if (!documents) {
    try { documents = ps("[Environment]::GetFolderPath('MyDocuments')"); } catch { documents = join(process.env.USERPROFILE || '', 'Documents'); }
  }
  return documents;
}

/** A small, valid PDF with one line of text (offsets computed, so viewers need no repair). */
function minimalPdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // the content stream, below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function prepareFixtures(fixtures) {
  const dir = documentsFolder();
  for (const f of fixtures.create || []) {
    // Written every run: a task once saved over one (24 Oct 2026)
    writeFileSync(join(dir, f.name), f.name.endsWith('.pdf') ? minimalPdf(f.text) : f.text, 'latin1');
  }
  for (const name of fixtures.remove || []) {
    const path = join(dir, name);
    if (existsSync(path)) unlinkSync(path);
  }
}

// ── Checks, read from the screen after a task ──

const includes = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle).toLowerCase());

async function check(spec) {
  if (spec.kind === 'gone') {
    const screen = await api('GET', `/screen?app=${encodeURIComponent(spec.app)}&fresh=1`);
    return { ok: !screen.ok, detail: screen.ok ? `still open: ${screen.data.window}` : 'closed' };
  }
  if (spec.kind === 'file') {
    const path = join(documentsFolder(), spec.name);
    if (!existsSync(path)) return { ok: spec.exists === false, detail: `${spec.name} not in Documents` };
    if (spec.exists === false) return { ok: false, detail: `${spec.name} still in Documents` };
    const text = readFileSync(path, 'utf8');
    const missing = (spec.includes || []).filter(t => !includes(text, t));
    return { ok: !missing.length, detail: missing.length ? `${spec.name} saved, but missing ${missing.join(', ')}` : `${spec.name} saved` };
  }
  if (spec.kind === 'text') {
    const read = await api('GET', `/screen/text?app=${encodeURIComponent(spec.app)}`);
    if (!read.ok) return { ok: false, detail: read.data.message || 'could not read' };
    const text = String(read.data.text || '');
    const missing = (spec.includes || []).filter(t => !includes(text, t));
    const unwanted = (spec.excludes || []).filter(t => includes(text, t));
    return { ok: !missing.length && !unwanted.length, detail: missing.length ? `missing ${missing.join(', ')}` : unwanted.length ? `still has ${unwanted.join(', ')}` : 'text found' };
  }
  // `app` omitted: whatever window is in front (a PDF opens in whichever viewer is the default)
  const screen = await api('GET', `/screen?${spec.app ? `app=${encodeURIComponent(spec.app)}&` : ''}fresh=1`);
  if (!screen.ok) return { ok: false, detail: screen.data.message || 'window not found' };
  if (spec.kind === 'window') {
    const ok = includes(screen.data.window, spec.titleIncludes);
    return { ok, detail: `window "${screen.data.window}"` };
  }
  if (spec.kind === 'control') {
    // Strict: the control's type and one of the exact phrases, so a page's
    // subtitle on the menu ("Monitors, brightness…") does not pass for the
    // page, and (notType) the words typed into a search box do not pass for
    // its results
    const names = spec.nameIncludesAny || [spec.nameIncludes];
    const typeOk = e => (!spec.type || e.type === spec.type) && !(spec.notType || []).includes(e.type);
    const hit = screen.data.elements.find(e => typeOk(e) && names.some(n => includes(`${e.name} ${e.value || ''}`, n)));
    return { ok: !!hit, detail: hit ? `found ${hit.type} "${hit.name}"` : `no ${spec.type || 'control'} mentioning "${names.join('" or "')}"` };
  }
  return { ok: false, detail: `unknown check ${spec.kind}` };
}

// ── One run of the chosen tasks ──

function freshNotepad() {
  closeProcess('notepad');
  try {
    ps(`$state = Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.WindowsNotepad_8wekyb3d8bbwe\\LocalState\\TabState'
if (-not (Get-Process Notepad -ErrorAction SilentlyContinue) -and (Test-Path $state)) { Get-ChildItem $state -File | Remove-Item -Force -ErrorAction SilentlyContinue; 'cleared' } else { 'kept' }`, 20000);
  } catch {}
}

async function runOnce(runNumber) {
  if (LIVE) prepareFixtures(fixtures);
  if (LIVE && FRESH_NOTEPAD) freshNotepad();
  const results = [];
  for (const task of chosen) {
    process.stdout.write(`${RUNS > 1 ? `[${runNumber}/${RUNS}] ` : ''}${task.id} … `);
    if (!LIVE) {
      const plan = await api('POST', '/agent/plan', { instruction: task.instruction });
      const steps = plan.data.steps || [];
      results.push({ id: task.id, instruction: task.instruction, planned: steps.length, steps: steps.map(s => s.do), reason: plan.data.reason || null, error: plan.ok ? null : plan.data.error });
      console.log(plan.ok ? `${steps.length} steps` : `error: ${plan.data.error}`);
      continue;
    }

    // A "Which app should open this?" chooser left by an earlier task holds the
    // keyboard and blocks every window from coming forward: never carry one over
    try { ps('Get-Process OpenWith -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue', 15000); } catch {}
    const before = runningProcesses();
    const foldersBefore = explorerWindows();
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
    closeNewExplorerWindows(foldersBefore);
    await sleep(1000);
  }
  return results;
}

function tally(results) {
  const passed = results.filter(r => r.passed).length;
  const honest = results.filter(r => r.passed && r.status === 'done').length;
  const falseDone = results.filter(r => !r.passed && r.status === 'done').length;
  const replanned = results.filter(r => r.replans > 0);
  const recovered = replanned.filter(r => r.passed).length;
  const sorted = [...results].sort((a, b) => a.ms - b.ms);
  return {
    tasks: results.length,
    completed: passed,
    completionRate: results.length ? passed / results.length : null,
    completedAndSaid: honest,
    completedAndSaidRate: results.length ? honest / results.length : null,
    falseDone,
    replanned: replanned.length,
    recovered,
    recoveryRate: replanned.length ? recovered / replanned.length : null,
    replans: results.reduce((s, r) => s + r.replans, 0),
    medianSeconds: results.length ? Math.round(sorted[Math.floor(results.length / 2)].ms / 1000) : null,
    results,
  };
}

/** Lowest, typical (median) and highest of a number across runs. */
function spread(runs, key) {
  const values = runs.map(r => r[key]).filter(v => v != null).sort((a, b) => a - b);
  if (!values.length) return { min: null, median: null, max: null };
  return { min: values[0], median: values[Math.floor(values.length / 2)], max: values[values.length - 1] };
}

// ── Main ──

const { tasks, fixtures = {} } = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const chosen = only.length ? tasks.filter(t => only.includes(t.id)) : tasks;

if (RENDER) {
  const summary = JSON.parse(readFileSync(RENDER, 'utf8'));
  const name = basename(RENDER, '.json');
  // A report saved before `across` existed (24 Oct 2026)
  summary.byRun ||= [{ run: 1, ...summary }];
  summary.runs ||= summary.byRun.length;
  summary.across ||= Object.fromEntries(['completed', 'completedAndSaid', 'falseDone', 'replans', 'medianSeconds'].map(k => [k, spread(summary.byRun, k)]));
  const ids = summary.byRun[0].results.map(r => ({ id: r.id }));
  const md = renderMarkdown({ summary, runs: summary.byRun, RUNS: summary.runs, chosen: ids, date: summary.date.slice(0, 10), stamp: summary.date, label: summary.label, name });
  writeFileSync(join(dirname(RENDER), `${name}.md`), md);
  console.log(`Wrote ${join(dirname(RENDER), `${name}.md`)}`);
  process.exit(0);
}

const status = await api('GET', '/ai/status').catch(() => null);
if (!status?.ok) {
  console.error(`AbleSpeak is not answering at ${BASE}. Start the app first.`);
  process.exit(1);
}

const runs = [];
for (let k = 1; k <= RUNS; k++) {
  const startedAt = new Date().toISOString();
  const results = await runOnce(k);
  runs.push(LIVE ? { run: k, startedAt, ...tally(results) } : { run: k, startedAt, results });
  if (k < RUNS) await sleep(3000);
}

mkdirSync(OUT, { recursive: true });
const name = `agent-eval-${date}${label ? `-${label}` : ''}${LIVE ? '' : '-plans'}`;
if (LIVE) {
  const summary = {
    date: stamp,
    label: label || null,
    model: status.data.model || null,
    tasks: chosen.length,
    runs: RUNS,
    // Lowest, typical and highest across the runs
    across: {
      completed: spread(runs, 'completed'),
      completedAndSaid: spread(runs, 'completedAndSaid'),
      falseDone: spread(runs, 'falseDone'),
      replans: spread(runs, 'replans'),
      medianSeconds: spread(runs, 'medianSeconds'),
    },
    byRun: runs,
    // The single-run shape too (completed, results…), so older comparisons keep working
    ...(RUNS === 1 ? runs[0] : {}),
  };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(summary, null, 2));

  writeFileSync(join(OUT, `${name}.md`), renderMarkdown({ summary, runs, RUNS, chosen, date, stamp, label, name }));
  const s = summary.across;
  const n = chosen.length;
  console.log(`\nCheck passed ${s.completed.median} of ${n}${RUNS > 1 ? ` (${s.completed.min}–${s.completed.max})` : ''}, and said so ${s.completedAndSaid.median} of ${n}, false "done" ${s.falseDone.median}${RUNS > 1 ? ` (${s.falseDone.min}–${s.falseDone.max})` : ''}. Wrote ${join(OUT, `${name}.md`)}`);
} else {
  const results = runs[0].results;
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ date: stamp, plansOnly: true, results }, null, 2));
  const planned = results.filter(r => r.planned > 0).length;
  console.log(`\n${planned} of ${results.length} tasks got a plan. Nothing was run. Wrote ${join(OUT, `${name}.json`)}`);
}

/** The report, from a run's summary (also rebuilt from a saved .json with --render). */
function renderMarkdown({ summary, runs, RUNS, chosen, date, stamp, label, name }) {
  const n = chosen.length;
  const tag = r => (r ? `${r.passed ? 'pass' : 'fail'} (${r.status})` : '—');
  const row = (what, s, fmt = v => v) => (RUNS === 1
    ? `| ${what} | **${fmt(s.median)}** |`
    : `| ${what} | ${fmt(s.min)} | **${fmt(s.median)}** | ${fmt(s.max)} |`);
  const ofN = v => `${v} of ${n}`;
  return `# Task agent evaluation — ${date}${label ? ` (${label})` : ''}

Run ${stamp} with \`node tools/agent-eval/run.mjs --live${RUNS > 1 ? ` --runs ${RUNS}` : ''}\` on one machine, model ${summary.model || 'unknown'}: ${n} tasks from \`tools/agent-eval/tasks.json\`, ${RUNS === 1 ? 'each run once' : `each run ${RUNS} times (lowest, typical and highest shown)`}.

${RUNS === 1 ? '| Measure | Result |\n|---|---|' : '| Measure | Lowest | Typical | Highest |\n|---|---|---|---|'}
${row('Check passed', summary.across.completed, ofN)}
${row('Check passed and AbleSpeak said it finished', summary.across.completedAndSaid, ofN)}
${row('Said it finished but the check failed (false "done")', summary.across.falseDone)}
${row('Re-plans in all', summary.across.replans)}
${row('Median time per task', summary.across.medianSeconds, v => `${v} s`)}

| Task | ${runs.map(r => `Run ${r.run}`).join(' | ')} | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|${runs.map(() => '---|').join('')}---|---|---|---|
${chosen.map(t => {
    const per = runs.map(r => r.results.find(x => x.id === t.id));
    const last = per[per.length - 1];
    return `| ${t.id} | ${per.map(tag).join(' | ')} | ${last?.replans ?? '—'} | ${last ? `${Math.round(last.ms / 1000)} s` : '—'} | ${String(last?.said || '').replace(/\|/g, '/').slice(0, 90)} | ${(last?.checks || []).map(c => c.detail).join('; ').replace(/\|/g, '/')} |`;
  }).join('\n')}

Sample size: ${n} tasks, ${RUNS} run${RUNS === 1 ? '' : 's'} each, one computer. Raw data: \`${name}.json\`.
`;
}
