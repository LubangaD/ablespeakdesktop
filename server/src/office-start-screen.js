/**
 * Office Start screens — so "open Excel" lands the student in a sheet.
 *
 * Word and PowerPoint take a switch that opens a blank file (/w, /B). Excel
 * has none: it always opens the Start screen with a "Blank workbook" tile, and
 * a student who cannot use a mouse cannot get past it. The only way through is
 * a per-user setting — the same tick box as
 * Excel > Options > General > "Show the Start screen when this application starts".
 *
 * A teacher can set it by hand (docs/INSTALL-FOR-TEACHERS.md), but one skipped
 * setup step leaves a student stuck at a tile they cannot click, so AbleSpeak
 * also sets it itself at startup.
 *
 * Deliberately narrow:
 *   · one DWORD, under HKEY_CURRENT_USER only — never machine-wide;
 *   · only for an Office version this user already has;
 *   · idempotent, and it never fails the boot.
 */
import { runPowerShell } from './system-tools.js';

/** Office releases that still use this setting (16.0 = 2016/2019/2021/365). */
export const OFFICE_VERSIONS = ['16.0', '15.0'];

const VALUE_NAME = 'DisableBootToOfficeStart';

/**
 * The PowerShell that applies the setting. Separated out so the exact registry
 * reach can be asserted in tests without touching a real registry.
 */
export function excelStartScreenScript(versions = OFFICE_VERSIONS) {
  const list = versions.map((v) => `'${v}'`).join(',');
  return `
$done = @()
foreach ($v in @(${list})) {
  $excel = "HKCU:\\Software\\Microsoft\\Office\\$v\\Excel"
  if (-not (Test-Path $excel)) { continue }
  $opts = "$excel\\Options"
  if (-not (Test-Path $opts)) { New-Item -Path $opts -Force | Out-Null }
  $current = (Get-ItemProperty $opts -ErrorAction SilentlyContinue).${VALUE_NAME}
  if ($current -eq 1) { $done += "$v already" }
  else {
    New-ItemProperty -Path $opts -Name ${VALUE_NAME} -PropertyType DWord -Value 1 -Force | Out-Null
    $done += "$v set"
  }
}
if ($done.Count -eq 0) { 'no-excel' } else { $done -join ', ' }`.trim();
}

/**
 * Turn Excel's Start screen off for this user. Returns what happened; never
 * throws, because nothing here is worth stopping the gateway for.
 *
 * status: 'set' · 'already' · 'no-excel' · 'skipped' (not Windows) · 'failed'
 */
export async function ensureExcelOpensBlankWorkbook({
  run = runPowerShell,
  platform = process.platform,
  log = console,
} = {}) {
  if (platform !== 'win32') return { status: 'skipped', detail: 'not Windows' };

  try {
    const output = String((await run(excelStartScreenScript(), 8000)) || '').trim();

    if (!output || output === 'no-excel') {
      log.log?.('[Office] Excel is not installed for this user — nothing to change');
      return { status: 'no-excel', detail: output };
    }

    const status = output.includes('set') ? 'set' : 'already';
    log.log?.(
      status === 'set'
        ? `[Office] Excel Start screen turned off (${output}) — "open Excel" now opens a blank sheet`
        : `[Office] Excel Start screen already off (${output})`
    );
    return { status, detail: output };
  } catch (err) {
    // A locked-down school machine can refuse the write. Say what a teacher can
    // do by hand instead of failing the boot.
    log.warn?.(
      `[Office] Could not turn off Excel's Start screen (${err.message}). ` +
        'A teacher can untick Excel > Options > General > "Show the Start screen when this application starts".'
    );
    return { status: 'failed', detail: err.message };
  }
}
