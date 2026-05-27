/**
 * AbleSpeak System Tools
 * 
 * OS-level control functions using PowerShell (Windows).
 * Enables voice control of desktop applications, system media, volume, etc.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execAsync = promisify(exec);

/**
 * Run a PowerShell script reliably using a temp .ps1 file.
 * This avoids escaping issues with inline commands.
 */
async function psScript(script, timeoutMs = 8000) {
  const tmpFile = join(tmpdir(), `ablespeak_${Date.now()}.ps1`);
  try {
    writeFileSync(tmpFile, script, 'utf8');
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { timeout: timeoutMs }
    );
    return stdout.trim();
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

// ── System Media Control ──

/**
 * Simulate a Windows media key press.
 * Works with Spotify, VLC, Windows Media Player, etc.
 */
export async function systemMediaControl(action) {
  const keyMap = {
    play_pause: '0xB3',  // VK_MEDIA_PLAY_PAUSE
    next:       '0xB0',  // VK_MEDIA_NEXT_TRACK
    previous:   '0xB1',  // VK_MEDIA_PREV_TRACK
    stop:       '0xB2',  // VK_MEDIA_STOP
  };

  const vk = keyMap[action];
  if (!vk) {
    return { status: 'error', message: `Unknown media action: ${action}. Use: play_pause, next, previous, stop` };
  }

  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MediaKey {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    public static void Press(byte vk) {
        keybd_event(vk, 0, 0, 0);
        keybd_event(vk, 0, 2, 0);
    }
}
"@
[MediaKey]::Press(${vk})
`;

  await psScript(script);
  return { status: 'success', action, message: `Media ${action} key sent` };
}

// ── System Volume Control ──

export async function systemVolume(action, value) {
  const scripts = {
    mute: `
$wshell = New-Object -ComObject wscript.shell
$wshell.SendKeys([char]173)
`,
    unmute: `
$wshell = New-Object -ComObject wscript.shell
$wshell.SendKeys([char]173)
`,
    up: `
$wshell = New-Object -ComObject wscript.shell
1..${value || 5} | ForEach-Object { $wshell.SendKeys([char]175) }
`,
    down: `
$wshell = New-Object -ComObject wscript.shell
1..${value || 5} | ForEach-Object { $wshell.SendKeys([char]174) }
`,
    set: `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Vol {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    public static void Press(byte vk) { keybd_event(vk, 0, 0, 0); keybd_event(vk, 0, 2, 0); }
}
"@
1..50 | ForEach-Object { [Vol]::Press(0xAE) }
Start-Sleep -Milliseconds 100
1..${Math.round((value || 50) / 2)} | ForEach-Object { [Vol]::Press(0xAF) }
`,
  };

  const script = scripts[action];
  if (!script) {
    return { status: 'error', message: `Unknown volume action: ${action}. Use: mute, unmute, up, down, set` };
  }

  await psScript(script, 12000);
  return { status: 'success', action, value, message: `Volume ${action}${value ? ' to ' + value : ''}` };
}

// ── Focus / Switch Application ──

export async function focusApplication(appName) {
  const script = `
$found = $false
Get-Process | Where-Object { $_.MainWindowTitle -like "*${appName}*" } | Select-Object -First 1 | ForEach-Object {
    $wshell = New-Object -ComObject wscript.shell
    $wshell.AppActivate($_.Id)
    $found = $true
    Write-Output "Focused: $($_.MainWindowTitle)"
}
if (-not $found) {
    Get-Process -Name "*${appName}*" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 | ForEach-Object {
        $wshell = New-Object -ComObject wscript.shell
        $wshell.AppActivate($_.Id)
        Write-Output "Focused: $($_.ProcessName)"
        $found = $true
    }
}
if (-not $found) { Write-Output "NOT_FOUND" }
`;

  const result = await psScript(script);
  if (result === 'NOT_FOUND') {
    return { status: 'error', message: `Application "${appName}" not found or has no visible window` };
  }
  return { status: 'success', message: result };
}

// ── Open Application ──

export async function openApplication(appName) {
  const appMap = {
    notepad: 'notepad',
    calculator: 'calc',
    paint: 'mspaint',
    explorer: 'explorer',
    'file explorer': 'explorer',
    'task manager': 'taskmgr',
    terminal: 'wt',
    powershell: 'powershell',
    cmd: 'cmd',
    settings: 'start ms-settings:',
    spotify: 'start spotify:',
    'microsoft edge': 'start msedge',
    edge: 'start msedge',
    chrome: 'start chrome',
    firefox: 'start firefox',
    word: 'start winword',
    excel: 'start excel',
    powerpoint: 'start powerpnt',
    outlook: 'start outlook',
    teams: 'start msteams:',
    vscode: 'code',
    'visual studio code': 'code',
    snipping: 'snippingtool',
    'snipping tool': 'snippingtool',
  };

  const lower = appName.toLowerCase().trim();
  const command = appMap[lower] || `start ${appName}`;

  try {
    await execAsync(command, { shell: 'cmd.exe', timeout: 5000 });
    return { status: 'success', message: `Opened ${appName}` };
  } catch {
    try {
      await psScript(`Start-Process "${appName}"`, 5000);
      return { status: 'success', message: `Opened ${appName}` };
    } catch (err) {
      return { status: 'error', message: `Could not open "${appName}": ${err.message}` };
    }
  }
}

// ── Close Application ──

export async function closeApplication(appName) {
  const script = `
$closed = $false
Get-Process -Name "*${appName}*" -ErrorAction SilentlyContinue | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
    $closed = $true
    Write-Output "Closed: $($_.ProcessName) (PID $($_.Id))"
}
if (-not $closed) {
    # Also try matching by window title
    Get-Process | Where-Object { $_.MainWindowTitle -like "*${appName}*" } | ForEach-Object {
        $_.CloseMainWindow() | Out-Null
        $closed = $true
        Write-Output "Closed: $($_.ProcessName) - $($_.MainWindowTitle)"
    }
}
if (-not $closed) { Write-Output "NOT_FOUND" }
`;

  const result = await psScript(script);
  if (result.includes('NOT_FOUND')) {
    return { status: 'error', message: `No running application matching "${appName}" found` };
  }
  return { status: 'success', message: result };
}

// ── Send Keyboard Shortcut ──

export async function sendKeys(keys) {
  const keyMap = {
    'ctrl': '^', 'alt': '%', 'shift': '+',
    'enter': '{ENTER}', 'tab': '{TAB}',
    'escape': '{ESC}', 'esc': '{ESC}',
    'backspace': '{BACKSPACE}', 'delete': '{DELETE}',
    'home': '{HOME}', 'end': '{END}',
    'pageup': '{PGUP}', 'pagedown': '{PGDN}',
    'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
    'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}',
    'f5': '{F5}', 'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}',
    'f9': '{F9}', 'f10': '{F10}', 'f11': '{F11}', 'f12': '{F12}',
    'space': ' ',
  };

  const parts = keys.split('+').map(k => k.trim().toLowerCase());
  let sendKeysStr = '';
  let regularKeys = [];

  for (const part of parts) {
    if (keyMap[part] && ['ctrl', 'alt', 'shift'].includes(part)) {
      sendKeysStr += keyMap[part];
    } else if (keyMap[part]) {
      regularKeys.push(keyMap[part]);
    } else {
      regularKeys.push(part);
    }
  }

  sendKeysStr += regularKeys.join('');

  const script = `
$wshell = New-Object -ComObject wscript.shell
Start-Sleep -Milliseconds 100
$wshell.SendKeys("${sendKeysStr}")
`;

  await psScript(script);
  return { status: 'success', keys, message: `Sent keys: ${keys}` };
}

// ── Type Text into Active App ──

export async function typeTextSystem(text) {
  const escaped = text
    .replace(/[+^%~(){}[\]]/g, '{$&}')
    .replace(/\n/g, '{ENTER}');

  const script = `
$wshell = New-Object -ComObject wscript.shell
Start-Sleep -Milliseconds 100
$wshell.SendKeys("${escaped.replace(/"/g, '`"')}")
`;

  await psScript(script);
  return { status: 'success', text, message: `Typed: ${text.substring(0, 50)}...` };
}

// ── List Running Applications ──

export async function listApplications() {
  const script = `
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | Select-Object ProcessName, MainWindowTitle, Id | ConvertTo-Json
`;

  const result = await psScript(script, 8000);
  try {
    const apps = JSON.parse(result);
    const list = (Array.isArray(apps) ? apps : [apps]).map(a => ({
      name: a.ProcessName,
      title: a.MainWindowTitle,
      pid: a.Id,
    }));
    return { status: 'success', applications: list };
  } catch {
    return { status: 'success', raw: result };
  }
}
