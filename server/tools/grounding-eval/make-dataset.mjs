#!/usr/bin/env node
/**
 * Build a grounding test set from real screens, with no hand labelling.
 *
 *   node tools/grounding-eval/make-dataset.mjs --app word --app chrome [--max 15]
 *
 * For each app: brings its window to the front, reads its controls through
 * UI Automation, saves a screenshot to images/, and adds "click the <name>
 * <kind>" cases (with the control's box as the answer) to dataset.json.
 * Then run: node run-eval.cjs --dataset ./dataset.json
 *
 * Screenshots show whatever is in those windows. They stay on this computer
 * (images/ is not committed) — but run-eval sends them to the AI provider,
 * so use windows with nothing private in them, or a student's screen only
 * with consent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listVisibleWindows, runPowerShell, stopSystemTools } from '../../src/system-tools.js';
import { getScreenModel } from '../../src/screen-model.js';
import { pickWindow } from '../../src/app-names.js';
import { casesFromScreen, visiblePart } from './lib/cases-from-screen.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const apps = args.flatMap((a, i) => (a === '--app' ? [args[i + 1]] : []));
const max = Number(args[args.indexOf('--max') + 1]) || 15;
const datasetPath = join(here, 'dataset.json');
const imagesDir = join(here, 'images');

if (!apps.length) {
  console.error('Name at least one app: --app word --app chrome');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** The screen's bounds, and where the overlay sits (it can hide controls). */
async function screenAndOverlay(overlayHwnd) {
  const out = await runPowerShell(`
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Grab -Name Native -MemberDefinition '
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }' -ErrorAction SilentlyContinue
$screen = @([Grab.Native]::GetSystemMetrics(76), [Grab.Native]::GetSystemMetrics(77), [Grab.Native]::GetSystemMetrics(78), [Grab.Native]::GetSystemMetrics(79))
$overlay = $null
if (${overlayHwnd ? 1 : 0}) {
  $r = New-Object Grab.Native+RECT
  if ([Grab.Native]::GetWindowRect([IntPtr]${Number(overlayHwnd) || 0}, [ref]$r)) { $overlay = @($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)) }
}
@{ screen = $screen; overlay = $overlay } | ConvertTo-Json -Compress
`, 20000);
  return JSON.parse(out);
}

async function saveImage([x, y, w, h], file) {
  const safe = file.replace(/'/g, "''");
  await runPowerShell(`
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap ${w}, ${h}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size ${w}, ${h}))
$bmp.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
'saved'`, 20000);
}

mkdirSync(imagesDir, { recursive: true });
const dataset = existsSync(datasetPath) ? JSON.parse(readFileSync(datasetPath, 'utf8')) : { cases: [] };
const known = new Set(dataset.cases.map(c => c.id));

for (const app of apps) {
  const windows = await listVisibleWindows();
  const target = pickWindow(windows, app);
  if (!target) { console.log(`${app}: no open window`); continue; }
  const overlay = windows.find(w => w.title === 'AbleSpeak Overlay');

  await runPowerShell(`[Win32Input]::ForceFocus([IntPtr]${Number(target.hwnd)}) | Out-Null`, 10000);
  await sleep(700);
  const model = await getScreenModel({ target, fresh: true, maxElements: 400, restore: true });
  if (model.status !== 'success') { console.log(`${app}: ${model.message}`); continue; }

  const { screen, overlay: covered } = await screenAndOverlay(overlay?.hwnd);
  const region = visiblePart(model.rect, screen);
  if (!region) { console.log(`${app}: the window is off screen`); continue; }

  const prefix = `${String(model.app).toLowerCase()}-${stamp}`;
  const image = `images/${prefix}.png`;
  await saveImage(region, join(here, image).replace(/\//g, '\\'));
  const cases = casesFromScreen(model, region, { image, prefix, max, covered }).filter(c => !known.has(c.id));
  dataset.cases.push(...cases);
  console.log(`${app}: ${cases.length} cases from "${model.window}"`);
}

writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));
console.log(`\n${dataset.cases.length} cases in ${datasetPath}. Next: node run-eval.cjs --dataset ./dataset.json`);
stopSystemTools();
process.exit(0);
