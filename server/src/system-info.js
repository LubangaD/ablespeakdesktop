/**
 * AbleSpeak System Info
 * 
 * Enumerates visible desktop applications, OS info, and foreground window.
 * Gives the AI "eyes" on the whole desktop.
 */

import { execSync } from 'child_process';
import os from 'os';

// ── OS Info ──
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
  try {
    if (process.platform === 'win32') {
      return getWindowsApplications();
    }
    return [];
  } catch (err) {
    console.error('[SystemInfo] Error enumerating applications:', err.message);
    return [];
  }
}

function getWindowsApplications() {
  // Single PowerShell call: get all visible-window processes AND the foreground PID
  // Using -EncodedCommand to avoid all quoting issues
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

  const raw = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  }).trim();

  if (!raw) return [];

  // Find the JSON object in the output (skip any CLIXML progress messages)
  const jsonStart = raw.indexOf('{');
  if (jsonStart === -1) return [];
  const jsonStr = raw.slice(jsonStart);

  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  let apps = data.Apps || [];
  if (!Array.isArray(apps)) apps = [apps];

  return apps.map(p => ({
    id: p.Id,
    processName: p.ProcessName + '.exe',
    title: p.Title,
    foreground: !!p.Fg,
  }));
}

// ── Full System Context (for AI) ──
export function getFullSystemContext() {
  return {
    computerInfo: getComputerInfo(),
    visibleApplications: getVisibleApplications(),
  };
}
