/**
 * AbleSpeak System Info
 * 
 * Enumerates visible desktop applications, OS info, and foreground window.
 * Gives the AI "eyes" on the whole desktop.
 * 
 * Performance: Uses async exec with 2s result caching to avoid
 * blocking the event loop with synchronous PowerShell calls.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

// ── Result Cache (perf fix #2) ──
let _appCache = { data: [], ts: 0 };
const CACHE_TTL = 2000; // 2 seconds — apps don't change faster than this

// ── OS Info (cheap, no caching needed) ──
export function getComputerInfo() {
  return {
    currentTime: new Date().toLocaleString(),
    osName: `${os.type()} ${os.release()}`,
    osVersion: os.version(),
    osArch: os.arch(),
    hostname: os.hostname(),
    uptime: Math.round(os.uptime() / 60) + ' minutes',
  };
}

// ── Visible Applications (Windows) ──
export function getVisibleApplications() {
  // Return cached result if fresh
  if (Date.now() - _appCache.ts < CACHE_TTL) {
    return _appCache.data;
  }

  try {
    if (process.platform === 'win32') {
      // Kick off async refresh but return stale cache for now
      _refreshWindowsApps();
      return _appCache.data;
    }
    return [];
  } catch (err) {
    console.error('[SystemInfo] Error enumerating applications:', err.message);
    return _appCache.data; // Return stale cache on error
  }
}

// Async refresh — doesn't block event loop
let _refreshInFlight = false;

async function _refreshWindowsApps() {
  if (_refreshInFlight) return; // Deduplicate concurrent refreshes
  _refreshInFlight = true;

  try {
    const ps = `
$fgHwnd = $null
$fgPid = 0
try {
  Add-Type -ErrorAction SilentlyContinue -Name Win32 -Namespace AbleSpeak -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@
  $fgHwnd = [AbleSpeak.Win32]::GetForegroundWindow()
  $tmp = [uint32]0
  [AbleSpeak.Win32]::GetWindowThreadProcessId($fgHwnd, [ref]$tmp) | Out-Null
  $fgPid = $tmp
} catch {}

$apps = Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
  [PSCustomObject]@{ Id=$_.Id; ProcessName=$_.ProcessName; Title=$_.MainWindowTitle; Fg=($_.Id -eq $fgPid) }
}

@{ ForegroundPid=$fgPid; Apps=$apps } | ConvertTo-Json -Compress -Depth 3
`.trim();

    const encoded = Buffer.from(ps, 'utf16le').toString('base64');

    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 8000, windowsHide: true }
    );

    const raw = stdout.trim();
    if (!raw) return;

    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) return;
    const jsonStr = raw.slice(jsonStart);

    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      return;
    }

    let apps = data.Apps || [];
    if (!Array.isArray(apps)) apps = [apps];

    _appCache = {
      data: apps.map(p => ({
        id: p.Id,
        processName: p.ProcessName + '.exe',
        title: p.Title,
        foreground: !!p.Fg,
      })),
      ts: Date.now(),
    };
  } catch (err) {
    // Don't log on timeout — expected during heavy load
    if (!err.message?.includes('timed out')) {
      console.error('[SystemInfo] Async refresh error:', err.message);
    }
  } finally {
    _refreshInFlight = false;
  }
}

// ── Eager first load ──
if (process.platform === 'win32') {
  _refreshWindowsApps();
}

// ── Full System Context (for AI) ──
export function getFullSystemContext() {
  return {
    computerInfo: getComputerInfo(),
    visibleApplications: getVisibleApplications(),
  };
}
