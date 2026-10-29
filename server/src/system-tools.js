/**
 * AbleSpeak System Tools
 * 
 * OS-level control functions using PowerShell (Windows).
 * Enables voice control of desktop applications, system media, volume, etc.
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, readdirSync, existsSync } from 'fs';
import { join, parse } from 'path';
import { tmpdir } from 'os';
import { resolveAppName, pickWindow } from './app-names.js';
import { SCREEN_MODEL_CS } from './uia/screen-model-cs.js';
import { OFFICE_UIA_CS } from './uia/office-uia-cs.js';

const execAsync = promisify(exec);

// Windows PowerShell 5.1 reads a .ps1 file without a byte-order mark in the
// ANSI code page. Text from speech or the screen (names, typed words) would
// then be misread — and some misread bytes are quotes, which can end a string
// early and run the rest as code. Every script file is written with a BOM.
function writeScript(path, script) {
  writeFileSync(path, '\uFEFF' + script, 'utf8');
}

/**
 * Sanitize a string for safe embedding in PowerShell commands.
 * Prevents command injection via voice input.
 * Allows only alphanumeric, spaces, hyphens, underscores, and dots.
 */
export function sanitizeForPS(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[^a-zA-Z0-9\s\-_\.]/g, '').trim().slice(0, 200);
}

/**
 * Escape free-form text for safe embedding inside a PowerShell *double-quoted*
 * string (used when the literal text — punctuation, unicode, etc. — must
 * survive, unlike sanitizeForPS()'s alnum-only whitelist).
 *
 * Order matters: backtick is PowerShell's escape character, so it MUST be
 * escaped first. Escaping it after quote/dollar would double-escape the
 * backticks those steps just inserted; skipping it entirely (as one caller
 * used to) lets a literal backtick in the input neutralize the very next
 * escape sequence and break out of the string (CVA-2) — e.g. input `` `" ``
 * becomes an escaped backtick followed by a bare, string-terminating quote.
 */
export function escapeForPSString(text) {
  return String(text ?? '').replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
}

/**
 * Sanitize a numeric value for PowerShell embedding.
 */
function sanitizeNumber(value, defaultVal = 5, min = 0, max = 100) {
  const num = parseInt(value, 10);
  if (isNaN(num)) return defaultVal;
  return Math.max(min, Math.min(max, num));
}

/**
 * ── Persistent PowerShell Worker ──
 *
 * Spawning powershell.exe + loading the UI Automation assemblies costs
 * 2-5 SECONDS per call. This worker keeps ONE PowerShell process alive with
 * everything pre-loaded, so each command runs in a few hundred ms.
 * Commands are serialized (one at a time) and the worker auto-respawns on
 * crash or timeout. Falls back to the slow temp-file path on failure.
 */
class PSWorker {
  constructor() {
    this.proc = null;
    this.queue = Promise.resolve();
    this.buffer = '';
    this.pending = null;
    this.consecutiveFailures = 0;
    this.disabled = false; // after repeated failures, stop trying the worker
  }

  _ensure() {
    if (this.proc) return;
    // The worker is a PowerShell process running a dispatch loop from a file:
    // it pre-loads the UI Automation assemblies once, then reads
    // "<id>|<scriptPath>" lines from stdin, executes each script file, and
    // prints a sentinel after each. (NOTE: `powershell -Command -` is NOT
    // usable here — it buffers stdin until EOF instead of streaming.)
    this.workerFile = join(tmpdir(), 'ablespeak_psworker.ps1');
    // Only this long-lived worker listens for focus changes (the screen
    // model's cache uses them); one-off fallback processes do not.
    const workerLoop = `
try { [ScreenModel]::StartFocusWatch() | Out-Null } catch {}
Write-Output "PSWORKER_READY"
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'EXIT') { break }
    $parts = $line.Split('|', 2)
    if ($parts.Count -lt 2) { continue }
    try { & $parts[1] } catch { Write-Output ("ERROR: " + $_.Exception.Message) }
    Write-Output ("<<<DONE_" + $parts[0] + ">>>")
}
`;
    writeScript(this.workerFile, UIA_PRELUDE + '\n' + workerLoop);
    this.ready = false;
    this.buffer = '';
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.workerFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    // A worker killed after a timeout still fires its events later; they must
    // not touch the worker that replaced it.
    proc.stdout.on('data', (d) => { if (this.proc === proc) this._onData(d.toString()); });
    proc.stderr.on('data', () => {}); // PS writes non-fatal noise to stderr
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(new Error('PowerShell worker exited'));
      }
    });
    proc.on('error', () => { if (this.proc === proc) this.proc = null; });
    console.log('[PSWorker] PowerShell worker started (UIA pre-loaded)');
  }

  _onData(chunk) {
    this.buffer += chunk;
    // Drop everything up to the start-up marker, so it never ends up in the
    // first command's output (including the first one after a restart).
    if (!this.ready) {
      const at = this.buffer.indexOf('PSWORKER_READY');
      if (at === -1) return;
      this.ready = true;
      this.buffer = this.buffer.slice(at + 'PSWORKER_READY'.length).replace(/^\r?\n/, '');
    }
    if (!this.pending) return;
    const idx = this.buffer.indexOf(this.pending.sentinel);
    if (idx !== -1) {
      const out = this.buffer.slice(0, idx).trim();
      this.buffer = '';
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(out);
    }
  }

  run(script, timeoutMs = 10000) {
    const task = () => new Promise((resolve, reject) => {
      if (this.disabled) return reject(new Error('PowerShell worker disabled'));
      this._ensure();
      if (!this.proc) return reject(new Error('Could not start PowerShell worker'));
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const sentinel = `<<<DONE_${id}>>>`;
      // Write the command to a script file; the worker loop executes it.
      // (Script files mean no stdin-escaping issues, and `return` inside
      // them ends only that script, never the worker.)
      const scriptFile = join(tmpdir(), `ablespeak_cmd_${id}.ps1`);
      try {
        writeScript(scriptFile, script);
      } catch (err) {
        return reject(err);
      }
      const cleanup = () => { try { unlinkSync(scriptFile); } catch {} };
      if (this.ready) this.buffer = '';
      this.pending = {
        sentinel,
        resolve: (out) => { cleanup(); resolve(out); },
        reject: (err) => { cleanup(); reject(err); },
        timer: setTimeout(() => {
          // Hung — kill and respawn on next use
          const p = this.pending;
          this.pending = null;
          try { this.proc.kill(); } catch {}
          this.proc = null;
          if (p) p.reject(new Error('PowerShell worker timeout'));
        }, timeoutMs),
      };
      this.proc.stdin.write(`${id}|${scriptFile}\n`);
    });
    const result = this.queue.then(task, task).then(
      (out) => { this.consecutiveFailures = 0; return out; },
      (err) => {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 2 && !this.disabled) {
          this.disabled = true;
          console.warn('[PSWorker] 2 consecutive failures — worker disabled, using temp-file mode from now on');
        }
        throw err;
      }
    );
    this.queue = result.catch(() => {});
    return result;
  }
}

const _psWorker = new PSWorker();
// Reading the screen (the window list, the screen model, Office, what is
// playing) has a worker of its own. With one queue, a read started while the
// person speaks made the next action wait behind it, and actions held up
// reads (17 Oct 2026). Each worker is its own PowerShell process.
const _psReadWorker = new PSWorker();

/**
 * Pre-start the PowerShell workers so the first voice command doesn't pay
 * the spawn + assembly-load cost. Called at server startup.
 */
export async function warmupSystemTools() {
  try {
    await Promise.all([_psWorker, _psReadWorker].map(w => w.run('Write-Output "warm"', 20000)));
    console.log('[PSWorker] Warmed up and ready (actions and screen reads)');
  } catch (err) {
    console.warn('[PSWorker] Warmup failed:', err.message);
  }
}

/**
 * Slow fallback: run a script via a temp .ps1 file in a fresh process.
 * UIA_PRELUDE is prepended since fresh processes have nothing loaded.
 */
async function psScriptFile(script, timeoutMs = 8000) {
  const tmpFile = join(tmpdir(), `ablespeak_${Date.now()}.ps1`);
  try {
    writeScript(tmpFile, UIA_PRELUDE + '\n' + script);
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { timeout: timeoutMs }
    );
    return stdout.trim();
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Run a PowerShell script — fast path via the persistent worker,
 * temp-file fallback if the worker fails.
 */
async function psScript(script, timeoutMs = 8000, worker = _psWorker) {
  try {
    return await worker.run(script, timeoutMs);
  } catch (err) {
    console.warn('[PSWorker] Worker failed (' + err.message + ') — using temp-file fallback');
    return psScriptFile(script, timeoutMs + 5000);
  }
}

/** A script that reads the screen, in the reading worker. */
const psRead = (script, timeoutMs = 8000) => psScript(script, timeoutMs, _psReadWorker);

/** Run a script in the screen-reading UI Automation worker (screen-model.js, office-uia.js). */
export const runPowerShell = psRead;

/** End the PowerShell workers so a script or test process can exit. */
export function stopSystemTools() {
  for (const worker of [_psWorker, _psReadWorker]) {
    const proc = worker.proc;
    if (!proc) continue;
    try { proc.stdin.write('EXIT\n'); } catch {}
    try { proc.kill(); } catch {}
    worker.proc = null;
  }
}

// ── System Media Control ──

/**
 * Control media playback.
 *
 * WITHOUT appName: presses the global Windows media key. NOTE: Windows routes
 * media keys to whichever app most recently played media — often the BROWSER,
 * not the app the user meant.
 *
 * WITH appName (e.g. "spotify"): focuses that app's window and sends its own
 * in-app shortcut, so the command reliably reaches THAT app.
 */
/**
 * "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" → "Spotify", "chrome.exe" →
 * "Chrome": the app behind a Windows media session, as a name to say.
 */
export function mediaAppName(aumid) {
  const raw = String(aumid || '');
  const tail = raw.includes('!') ? raw.split('!').pop() : raw.split(/[\\/]/).pop();
  const name = tail.replace(/\.exe$/i, '').replace(/^msedge$/i, 'Edge').trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'the music';
}

// Windows' own media controls (the sessions the volume flyout shows), as
// $mgr in PowerShell, with AbleAwait for their async calls
const MEDIA_SESSIONS = `
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function AbleAwait($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(3000) | Out-Null; $task.Result }
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
  $mgr = AbleAwait ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])`;

/**
 * What is playing right now, in any app: music, a video, a podcast.
 * → { playing: true, apps: ['Spotify'] } | { playing: false, apps: [] },
 *   or null when Windows didn't answer
 */
export async function mediaPlaying(timeoutMs = 5000) {
  const script = `
try {${MEDIA_SESSIONS}
  $playing = @()
  foreach ($s in $mgr.GetSessions()) {
    if ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { $playing += $s.SourceAppUserModelId }
  }
  Write-Output ('MEDIA|' + ($playing -join ';'))
} catch { Write-Output ('ERR|' + $_.Exception.Message) }
`;
  const out = String(await psRead(script, timeoutMs) || '').trim();
  const line = out.split(/\r?\n/).reverse().find(l => /^(MEDIA|ERR)\|/.test(l)) || '';
  if (!line.startsWith('MEDIA|')) return null;
  const apps = [...new Set(line.slice(6).split(';').filter(Boolean).map(mediaAppName))];
  return { playing: apps.length > 0, apps };
}

const SESSION_METHODS = {
  play_pause: 'TryTogglePlayPauseAsync', play: 'TryPlayAsync', pause: 'TryPauseAsync',
  next: 'TrySkipNextAsync', previous: 'TrySkipPreviousAsync', stop: 'TryStopAsync',
};

/**
 * Play, pause or skip in one app (or, with no app, the one Windows shows)
 * through its media session. No window comes forward and no key is typed,
 * so nothing lands in the app's search box (Spotify's took the space key).
 * → { status: 'success', playing, app, track } | { status: 'none' } (no
 *   session, or it refused) | { status: 'error', message }
 */
async function sessionMediaControl(action, safeName) {
  const pick = safeName
    ? `$mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -like '*${safeName}*' } | Select-Object -First 1`
    : '$mgr.GetCurrentSession()';
  const want = { play: 'Playing', pause: 'Paused', stop: 'Stopped' }[action] || '';
  const waits = action === 'next' || action === 'previous' ? 3 : 10;
  const script = `
try {${MEDIA_SESSIONS}
  $s = ${pick}
  if (-not $s) { Write-Output 'NOSESSION'; return }
  $before = [string]$s.GetPlaybackInfo().PlaybackStatus
  $ok = AbleAwait ($s.${SESSION_METHODS[action]}()) ([bool])
  if (-not $ok) { Write-Output 'REFUSED'; return }
  $after = $before
  for ($i = 0; $i -lt ${waits}; $i++) {
    Start-Sleep -Milliseconds 150
    $after = [string]$s.GetPlaybackInfo().PlaybackStatus
    if (('${want}' -ne '' -and $after -eq '${want}') -or ('${want}' -eq '' -and $after -ne $before)) { break }
  }
  $track = ''
  try {
    $p = AbleAwait ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($p.Title) { $track = $p.Title; if ($p.Artist) { $track = $p.Artist + ' - ' + $p.Title } }
  } catch {}
  Write-Output ('SESSION|' + $before + '|' + $after + '|' + $s.SourceAppUserModelId + '|' + $track)
} catch { Write-Output ('ERR|' + $_.Exception.Message) }
`;
  const out = String(await psScript(script, 10000) || '').trim();
  const line = out.split(/\r?\n/).reverse().find(l => /^(SESSION\||NOSESSION|REFUSED|ERR\|)/.test(l)) || '';
  if (line === 'NOSESSION' || line === 'REFUSED') return { status: 'none' };
  if (!line.startsWith('SESSION|')) return { status: 'error', message: line.startsWith('ERR|') ? line.slice(4) : (out || 'No answer from Windows media controls') };
  const [, before, after, aumid, ...track] = line.split('|');
  return {
    status: 'success', wasPlaying: before === 'Playing', playing: after === 'Playing',
    app: mediaAppName(aumid), track: track.join('|').trim(),
  };
}

/**
 * The part of an app's name that its media session id contains: "Spotify
 * Premium" → "spotify" (SpotifyAB.SpotifyMusic_…!Spotify). Never empty for a
 * name, since an empty one would match whichever app Windows shows.
 */
export function mediaSessionName(appName) {
  return String(appName || '').trim().toLowerCase().split(/\s+/)[0];
}

/** What a media session did, for the AI and the person. */
export function sessionReply(action, { wasPlaying, playing, app, track }) {
  const starting = action === 'play' || (action === 'play_pause' && !wasPlaying);
  if (starting) {
    return playing
      ? { status: 'success', action, app, message: `Playing ${track || app}.` }
      : { status: 'error', message: `${app} didn't start playing. Use click_desktop_element with name:"Play", app_name:"${app}" to click its Play button.` };
  }
  if (action === 'next' || action === 'previous') {
    return { status: 'success', action, app, message: track ? `Now playing ${track}.` : `${action === 'next' ? 'Next' : 'Previous'} track in ${app}.` };
  }
  return playing
    ? { status: 'error', message: `${app} is still playing.` }
    : { status: 'success', action, app, message: `Paused ${app}.` };
}

/**
 * Pause whatever is playing, in any app, through Windows' own media controls
 * (the sessions the volume flyout shows). Unlike the play/pause key this only
 * ever pauses, so "stop" never starts music when nothing was playing.
 * → { status: 'success', apps: ['Spotify'] } | { status: 'none' } | { status: 'error', message }
 */
export async function pauseAllMedia() {
  const script = `
try {${MEDIA_SESSIONS}
  $paused = @()
  foreach ($s in $mgr.GetSessions()) {
    if ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') {
      if (AbleAwait ($s.TryPauseAsync()) ([bool])) { $paused += $s.SourceAppUserModelId }
    }
  }
  if ($paused.Count -gt 0) { Write-Output ('PAUSED|' + ($paused -join ';')) } else { Write-Output 'NONE' }
} catch { Write-Output ('ERR|' + $_.Exception.Message) }
`;
  const out = String(await psScript(script, 10000) || '').trim();
  const line = out.split(/\r?\n/).reverse().find(l => /^(PAUSED|NONE|ERR)/.test(l)) || '';
  if (line.startsWith('PAUSED|')) {
    const apps = [...new Set(line.slice(7).split(';').filter(Boolean).map(mediaAppName))];
    return { status: 'success', apps };
  }
  if (line === 'NONE') return { status: 'none' };
  return { status: 'error', message: line.startsWith('ERR|') ? line.slice(4) : (out || 'No answer from Windows media controls') };
}

export async function systemMediaControl(action, appName) {
  const validActions = ['play', 'pause', 'play_pause', 'next', 'previous', 'stop'];
  if (!validActions.includes(action)) {
    return { status: 'error', message: `Unknown media action: ${action}. Use: ${validActions.join(', ')}` };
  }

  // ── Targeted mode: focus the app, send its in-app shortcut ──
  if (appName) {
    const safe = sanitizeForPS(appName).toLowerCase();
    if (!safe) return { status: 'error', message: 'Invalid application name' };

    // Its Windows media session first ("Spotify Premium" → the Spotify session)
    const session = await sessionMediaControl(action, mediaSessionName(safe));
    if (session.status === 'success') return sessionReply(action, session);
    if (session.status === 'error') console.warn('[Media] Windows media session failed:', session.message);
    // No session (the app never played since it opened): its own shortcut keys

    // In-app shortcuts per known player (SendKeys syntax)
    const APP_KEYS = {
      spotify: { play_pause: ' ', next: '^{RIGHT}', previous: '^{LEFT}', stop: ' ' },
      vlc:     { play_pause: ' ', next: 'n',        previous: 'p',       stop: 's' },
    };
    const keys = (APP_KEYS[safe] || APP_KEYS.spotify)[action === 'play' || action === 'pause' ? 'play_pause' : action];

    const script = `
$proc = Get-Process -Name "*${safe}*" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) {
    # Also try by window title
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*${safe}*" } | Select-Object -First 1
}
if (-not $proc) { Write-Output "NOT_RUNNING"; return }
$before = $proc.MainWindowTitle
$wshell = New-Object -ComObject wscript.shell
$wshell.AppActivate($proc.Id) | Out-Null
Start-Sleep -Milliseconds 300
$wshell.SendKeys("${keys}")
Start-Sleep -Milliseconds 700
$proc.Refresh()
$after = $proc.MainWindowTitle
Write-Output ("STATE|" + $before + "|" + $after)
`;

    const result = await psScript(script, 10000);
    if (result.includes('NOT_RUNNING')) {
      return { status: 'error', message: `${appName} is not running. Say "open ${appName}" first.` };
    }

    // ── Verify the outcome via window title (Spotify shows "Artist - Song"
    //    while playing, "Spotify Free/Premium" when paused) ──
    const stateMatch = result.match(/STATE\|(.*)\|(.*)$/s);
    if (stateMatch && safe.includes('spotify')) {
      const isPlaying = (t) => /\s-\s/.test(t || '');
      const [, before, after] = stateMatch;
      if (action === 'play_pause') {
        if (!isPlaying(before) && !isPlaying(after)) {
          // Key was sent but playback did NOT start — let the AI recover
          return {
            status: 'error',
            message: `Sent the key to Spotify but nothing started playing. Use click_desktop_element with name:"Play", app_name:"spotify" to click the Play button directly.`,
          };
        }
        if (isPlaying(after)) {
          return { status: 'success', action, app: appName, message: `Spotify is now playing: ${after.trim()}` };
        }
        return { status: 'success', action, app: appName, message: 'Paused Spotify' };
      }
      if (isPlaying(after)) {
        return { status: 'success', action, app: appName, message: `Spotify: ${after.trim()}` };
      }
    }
    return { status: 'success', action, app: appName, message: `${action} sent to ${appName}` };
  }

  // ── Global mode ──
  // Play and pause go to Windows' media sessions, so they never toggle the wrong way
  if (action === 'pause') {
    const paused = await pauseAllMedia();
    if (paused.status === 'success') return { status: 'success', action, message: `Paused ${paused.apps.join(' and ')}.` };
    if (paused.status === 'none') return { status: 'success', action, message: 'Nothing is playing.' };
  }
  if (action === 'play') {
    const session = await sessionMediaControl('play', '');
    if (session.status === 'success') return sessionReply('play', session);
  }
  // Otherwise the Windows media key (goes to the most recent media app)
  const keyMap = {
    play_pause: '0xB3',  // VK_MEDIA_PLAY_PAUSE
    next:       '0xB0',  // VK_MEDIA_NEXT_TRACK
    previous:   '0xB1',  // VK_MEDIA_PREV_TRACK
    stop:       '0xB2',  // VK_MEDIA_STOP
  };
  const vk = keyMap[action] || keyMap.play_pause;

  const script = `
try {
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
} catch {}
[MediaKey]::Press(${vk})
`;

  await psScript(script);
  return { status: 'success', action, message: `Media ${action} key sent (global — reaches the most recently active media app)` };
}

// ── System Volume Control ──

/**
 * Get the current system master volume level (0-100).
 * Used by auto-duck to save the volume before lowering it.
 */
export async function getSystemVolume() {
  try {
    const script = `
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AudioHelper {
    [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid riid, out IntPtr ppv);
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator { int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices); int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr ppEndpoint); }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice { int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface); }
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume { int x1(); int x2(); int x3(); int x4(); int x5(); int x6(); int x7(); int x8(); int x9(); int x10(); int x11(); int GetMasterVolumeLevelScalar(out float pfLevel); }
    public static float GetVolume() {
        CoInitializeEx(IntPtr.Zero, 0);
        Guid CLSID = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        Guid IID = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
        IntPtr pEnum; CoCreateInstance(ref CLSID, IntPtr.Zero, 1, ref IID, out pEnum);
        var enumerator = (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(pEnum);
        IntPtr pDevice; enumerator.GetDefaultAudioEndpoint(0, 1, out pDevice);
        var device = (IMMDevice)Marshal.GetObjectForIUnknown(pDevice);
        Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        IntPtr pVol; device.Activate(ref IID_IAudioEndpointVolume, 1, IntPtr.Zero, out pVol);
        var vol = (IAudioEndpointVolume)Marshal.GetObjectForIUnknown(pVol);
        float level; vol.GetMasterVolumeLevelScalar(out level);
        return level * 100;
    }
}
"@
  [math]::Round([AudioHelper]::GetVolume())
} catch {
  Write-Output "-1"
}
`;
    const result = await psScript(script, 5000);
    const level = parseInt(result.trim(), 10);
    return (isNaN(level) || level < 0) ? null : level;
  } catch {
    return null;
  }
}

export async function systemVolume(action, value) {
  const safeSteps = sanitizeNumber(value, 5, 1, 50);
  const safeSetLevel = sanitizeNumber(value, 50, 0, 100);

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
1..${safeSteps} | ForEach-Object { $wshell.SendKeys([char]175) }
`,
    down: `
$wshell = New-Object -ComObject wscript.shell
1..${safeSteps} | ForEach-Object { $wshell.SendKeys([char]174) }
`,
    set: `
try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Vol {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    public static void Press(byte vk) { keybd_event(vk, 0, 0, 0); keybd_event(vk, 0, 2, 0); }
}
"@
} catch {}
1..50 | ForEach-Object { [Vol]::Press(0xAE) }
Start-Sleep -Milliseconds 100
1..${Math.round(safeSetLevel / 2)} | ForEach-Object { [Vol]::Press(0xAF) }
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

/**
 * Every window a student could switch to, front to back:
 * [{ hwnd, process, title }]. Unlike Get-Process, this sees each open Word
 * document, not just one window per program.
 */
export async function listVisibleWindows() {
  const script = `
$names = @{}
Get-Process | ForEach-Object { $names[[string]$_.Id] = $_.ProcessName }
foreach ($line in [WindowList]::Visible()) {
    $parts = $line -split "\`t", 3
    Write-Output ($parts[0] + "\`t" + $names[$parts[1]] + "\`t" + $parts[2])
}
`;
  const output = await psRead(script);
  return output.split(/\r?\n/)
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 3 && /^\d+$/.test(parts[0]))
    .map(([hwnd, process, title]) => ({ hwnd, process, title: title.trim() }));
}

// ── Opening a file shown in a File Explorer window ──

/**
 * Which of a folder's entries a spoken file name means: by the full name,
 * else by the name without its extension (Explorer hides extensions, so
 * "ablespeak-eval" is shown for both ablespeak-eval.txt and .pdf; agent eval,
 * 24 Oct 2026). Returns { name } for one match, { ambiguous: [names] } for
 * several, or null. Exported for tests.
 */
export function matchFileInFolder(entries, wanted) {
  const lower = String(wanted || '').trim().toLowerCase();
  if (!lower) return null;
  let matches = entries.filter(n => n.toLowerCase() === lower);
  if (!matches.length) matches = entries.filter(n => parse(n).name.toLowerCase() === lower);
  if (!matches.length) return null;
  return matches.length === 1 ? { name: matches[0] } : { ambiguous: matches };
}

/** The folder a File Explorer window shows (Shell.Application knows each folder window by its hwnd), or null. */
export async function explorerFolderOf(hwnd) {
  if (!/^\d+$/.test(String(hwnd))) return null;
  const out = await psScript(`
$s = New-Object -ComObject Shell.Application
foreach ($w in @($s.Windows())) { if ($w.HWND -eq ${Number(hwnd)}) { try { Write-Output $w.Document.Folder.Self.Path } catch {} } }
`).catch(() => '');
  const path = String(out || '').trim().split(/\r?\n/)[0];
  return path && /^[a-z]:\\/i.test(path) ? path : null;
}

/**
 * "Open <file>" in the File Explorer window the person is using: the file is
 * opened by its path with its default app, so it needs no clicking and the
 * hidden extension does not matter. Returns null when the window is not a
 * folder or nothing there has that name; an error that asks which one when
 * several do.
 */
export async function openFileInFolderWindow(name, appName) {
  const windows = await listVisibleWindows();
  const win = appName
    ? pickWindow(windows, appName)
    : windows.find(w => !OWN_TITLE.test(String(w.title || '').trim()) && !NOT_AN_APP.test(String(w.title || '').trim()));
  if (!win || String(win.process).toLowerCase() !== 'explorer') return null;
  const folder = await explorerFolderOf(win.hwnd);
  if (!folder) return null;
  let entries;
  try { entries = readdirSync(folder); } catch { return null; }
  const match = matchFileInFolder(entries, name);
  console.log(`[SystemTools] Open "${name}" in "${win.title}" (${folder}): ${match ? (match.name || `${match.ambiguous.length} matches`) : 'no such file'}`);
  if (!match) return null;
  if (match.ambiguous) {
    return { status: 'error', message: `There are ${match.ambiguous.length} items called "${name}" in ${win.title.replace(/ - File Explorer$/, '')}: ${match.ambiguous.join(', ')}. Say which one.`, ambiguous: match.ambiguous };
  }
  const target = join(folder, match.name);
  const before = new Set(windows.map(w => String(w.hwnd)));
  const foregroundBefore = String(await psScript('[Win32Input]::GetForegroundWindow().ToInt64()').catch(() => '')).trim();
  const quoted = `'${target.replace(/'/g, "''")}'`;
  await psScript(`Invoke-Item -LiteralPath ${quoted}`);

  // No default app for this kind of file: Windows shows its "Open With"
  // chooser, an untitled window that keeps the keyboard until it is answered
  // and blocks every other window from coming forward (24 Oct 2026). It is
  // found by its process, as it is not always the foreground window. Plain
  // text then opens in Notepad; anything else is asked about.
  let chooser = false;
  for (let waited = 0; !chooser && waited < 3000; waited += 500) {
    await new Promise(resolve => setTimeout(resolve, 500));
    chooser = String(await psScript('@(Get-Process OpenWith -ErrorAction SilentlyContinue).Count').catch(() => '0')).trim() !== '0';
  }
  if (chooser) {
    console.log(`[SystemTools] Windows asked which app should open ${match.name}`);
    await psScript('Get-Process OpenWith -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue').catch(() => {});
    if (/\.(?:txt|md|log|csv|ini|json)$/i.test(match.name)) {
      // By full path: Git's "notepad" script comes first on PATH here
      await psScript(`Start-Process -FilePath "$env:WINDIR\\notepad.exe" -ArgumentList ${quoted}`);
    } else {
      return { status: 'error', message: `Windows asked which app should open ${match.name}, as none is set for ${parse(match.name).ext} files. Say which app to use, or set a default app in Settings.` };
    }
  }

  // Bring the app that opened it to the front: a new window, an existing one
  // that now shows the file (a PDF opened as a tab in the Edge window already
  // open, which stayed behind Explorer), or whichever window Windows
  // activated for it (an editor that already had the file open; agent eval,
  // 24 Oct 2026).
  const stem = parse(match.name).name.toLowerCase();
  const started = Date.now();
  let shown = null;
  while (!shown && Date.now() - started < 8000) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const now = await listVisibleWindows().catch(() => []);
    const notExplorer = w => String(w.process).toLowerCase() !== 'explorer';
    const foreground = String(await psScript('[Win32Input]::GetForegroundWindow().ToInt64()').catch(() => '')).trim();
    shown = now.find(w => !before.has(String(w.hwnd)) && notExplorer(w))
      || now.find(w => String(w.title).toLowerCase().includes(stem) && notExplorer(w))
      || (foreground && foreground !== foregroundBefore ? now.find(w => String(w.hwnd) === foreground && notExplorer(w)) : null);
  }
  if (shown) {
    await psScript(`
$h = [IntPtr]${Number(shown.hwnd)}
${bringToFront('$h')}
`).catch(() => {});
  }
  console.log(`[SystemTools] ${match.name} ${shown ? `shown in "${shown.title}"` : 'opened, but no window for it was found'}`);
  return { status: 'success', message: `Opened ${match.name}${shown ? ` in ${shown.title}` : ''}`, path: target, ...(shown ? { window: shown.title } : {}) };
}

// ── Saving the document in front under a name ──

const SAVE_FOLDERS = { documents: 'shell:Personal', 'my documents': 'shell:Personal', downloads: 'shell:Downloads', desktop: 'shell:Desktop', pictures: 'shell:My Pictures', music: 'shell:My Music', videos: 'shell:My Video' };

/** Where "in Documents" is: a shell: folder name, a full path as given, or null for "wherever the dialog is". Exported for tests. */
export function saveFolderSpec(folder) {
  const said = String(folder || '').trim().replace(/^(?:my |the )/i, '').replace(/ folder$/i, '').toLowerCase();
  if (!said) return null;
  if (/^[a-z]:\\/i.test(folder)) return { path: String(folder).trim() };
  return SAVE_FOLDERS[said] ? { shell: SAVE_FOLDERS[said] } : null;
}

const windowTitled = (windows, re) => windows.find(w => re.test(String(w.title || '').trim()));

async function waitForWindow(re, maxMs) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const hit = windowTitled(await listVisibleWindows().catch(() => []), re);
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return null;
}

/**
 * Save the document in the app in front under `name`, through the app's own
 * Save As dialog: Ctrl+Shift+S, the full path into the "File name" box,
 * Enter, and a check that the file exists. The dialog is driven here rather
 * than step by step by the AI, which typed into the label, browsed the folder
 * tree (which reset the name) and answered "replace?" with yes (24 Oct
 * 2026). An existing file is never replaced unless `replace` is true.
 */
export async function saveDocumentAs({ name, folder, replace = false } = {}) {
  const fileName = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, ' ').trim();
  if (!fileName) return { status: 'error', message: 'Say what to call the file.' };
  const spec = saveFolderSpec(folder);
  if (folder && !spec) return { status: 'error', message: `I don't know a folder called "${folder}". Say Documents, Downloads, Desktop, Pictures, Music or Videos.` };

  const front = await ensureUserAppInFront();
  if (front.status !== 'success') return { status: 'error', message: front.message };
  const app = front.title;

  // The dialog, unless it is already open
  let dialog = windowTitled(await listVisibleWindows().catch(() => []), /^save as$/i);
  if (!dialog) {
    await sendKeys('Ctrl+Shift+S');
    dialog = await waitForWindow(/^save as$/i, 8000);
  }
  if (!dialog) return { status: 'error', message: `I couldn't open the Save As dialog in ${app}.` };

  // Where to save: the folder's real path, so the dialog needs no browsing
  let folderPath = null;
  if (spec?.path) folderPath = spec.path;
  else if (spec?.shell) {
    folderPath = String(await psScript(`(New-Object -ComObject Shell.Application).NameSpace('${spec.shell}').Self.Path`).catch(() => '')).trim();
    if (!/^[a-z]:\\/i.test(folderPath)) return { status: 'error', message: `I couldn't find your ${folder} folder.` };
  }
  const target = folderPath ? join(folderPath, fileName) : fileName;

  // Typed, not set: setting the box's value through accessibility reported
  // success but the dialog kept the old name and asked to replace that file
  const { getScreenModel, findElement, actOnElement } = await import('./screen-model.js');
  const model = await getScreenModel({ fresh: true, maxElements: 300 });
  const field = model.status === 'success' ? findElement(model, 'File name', { action: 'set_value' }) : null;
  if (!field) return { status: 'error', message: "I couldn't find the file name box in the Save As dialog." };
  if (!field.focused) {
    const focused = await actOnElement({ ref: field.ref, action: 'focus', log: false }).catch(() => ({ status: 'error' }));
    if (focused.status !== 'success' && field.rect) {
      const [x, y, w, h] = field.rect;
      await mouseClick(x + w / 2, y + h / 2);
    }
  }
  await sendKeys('Ctrl+A');
  const typed = await typeTextSystem(target);
  if (typed.status !== 'success') return { status: 'error', message: `I couldn't put the name into the Save As dialog: ${typed.message}` };
  await new Promise(resolve => setTimeout(resolve, 300));
  await sendKeys('Enter');

  // Either the dialog closes, or Windows asks about replacing an existing file
  const started = Date.now();
  while (Date.now() - started < 6000) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const windows = await listVisibleWindows().catch(() => []);
    const confirm = windowTitled(windows, /^confirm save as$/i);
    if (confirm) {
      if (!replace) {
        await actOnElement({ name: 'No', action: 'invoke', log: false }).catch(() => {});
        await sendKeys('Escape');
        return { status: 'error', message: `A file called ${fileName} already exists there, so I didn't replace it. Say "replace it" if you want to.` };
      }
      await actOnElement({ name: 'Yes', action: 'invoke', log: false }).catch(() => {});
      continue;
    }
    if (!windowTitled(windows, /^save as$/i)) break;
  }
  if (windowTitled(await listVisibleWindows().catch(() => []), /^save as$/i)) {
    // Still open: Windows refused the name (a message box with OK)
    await actOnElement({ name: 'OK', action: 'invoke', log: false }).catch(() => {});
    await sendKeys('Escape');
    return { status: 'error', message: `Windows did not accept "${fileName}" as a file name.` };
  }
  if (folderPath) {
    const saved = [target, `${target}.txt`].find(p => existsSync(p));
    if (!saved) return { status: 'error', message: `The Save As dialog closed, but ${fileName} is not in ${folder}.` };
    return { status: 'success', message: `Saved as ${parse(saved).base} in ${folder}`, path: saved };
  }
  return { status: 'success', message: `Saved as ${fileName}` };
}

// ── The student's app, never AbleSpeak's own windows ──

const OWN_TITLE = /^AbleSpeak(?: Overlay$| — )/;
const NOT_AN_APP = /^(?:Program Manager|Windows Input Experience)$/i;

/** The dashboard, the overlay and their dialogs (this process), or the dashboard in a browser. */
export function isOwnWindow(win, pid = process.pid) {
  return String(win.pid) === String(pid) || OWN_TITLE.test(String(win.title || '').trim());
}

/** The window in front of all but AbleSpeak's: the app used last. */
export function pickUserWindow(windows, pid = process.pid) {
  return windows.find(w => !isOwnWindow(w, pid) && !NOT_AN_APP.test(String(w.title || '').trim())) || null;
}

/** The window in front, and every app window front to back. */
async function readWindows() {
  const out = await psScript(`
$fg = [Win32Input]::GetForegroundWindow()
$fgPid = [uint32]0
[Win32Input]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
Write-Output ("FG\`t" + $fg.ToInt64() + "\`t" + $fgPid)
foreach ($line in [WindowList]::Visible()) { Write-Output $line }
`);
  const lines = String(out).split(/\r?\n/);
  const [, fgHwnd = '0', fgPid = '0'] = (lines.find(l => l.startsWith('FG\t')) || '').split('\t');
  const windows = lines
    .map(line => line.split('\t'))
    .filter(parts => parts.length === 3 && /^\d+$/.test(parts[0]))
    .map(([hwnd, pid, title]) => ({ hwnd, pid, title: title.trim() }));
  const front = fgHwnd === '0' ? null : (windows.find(w => w.hwnd === fgHwnd) || { hwnd: fgHwnd, pid: fgPid, title: '' });
  return { front, windows };
}

/** The app the student is using, without changing what is in front. */
async function userWindow() {
  const { front, windows } = await readWindows();
  return front && front.title && !isOwnWindow(front) ? front : pickUserWindow(windows);
}

/**
 * The app a key press would go to (ensureUserAppInFront's choice), without
 * changing what is in front: { process, title }, or null. For the safety
 * gate; the window list's first window can be an always-on-top bar (Voice Access).
 */
export async function keyTargetApp() {
  const win = await userWindow();
  return win ? { process: await processNameOf(win), title: win.title } : null;
}

/** "winword", "excel", "notepad"… for a window. */
async function processNameOf(win) {
  if (!win || !/^\d+$/.test(String(win.pid))) return '';
  const out = await psScript(`(Get-Process -Id ${Number(win.pid)} -ErrorAction SilentlyContinue).ProcessName`);
  return String(out).trim().toLowerCase();
}

/**
 * Typing, keys and clicks go to the window in front. When that is AbleSpeak
 * itself (a command sent from the Chat page, or the overlay was clicked),
 * bring back the app that was in use before it.
 *
 * Returns { status, hwnd, title, switched } or { status: 'error', message }.
 */
/**
 * PowerShell that brings a window to the front and waits until Windows says
 * it is there: checked every 15 ms, so usually a few ms instead of the fixed
 * 200 ms (350 ms when the first try was refused) it used to sleep. Retries
 * once if Windows refuses. `$h` is the PowerShell variable holding the hwnd.
 */
export function bringToFront(h) {
  return `[Win32Input]::ForceFocus(${h}) | Out-Null
for ($i = 0; $i -lt 14 -and [Win32Input]::GetForegroundWindow() -ne ${h}; $i++) { Start-Sleep -Milliseconds 15 }
if ([Win32Input]::GetForegroundWindow() -ne ${h}) {
    [Win32Input]::ForceFocus(${h}) | Out-Null
    for ($i = 0; $i -lt 10 -and [Win32Input]::GetForegroundWindow() -ne ${h}; $i++) { Start-Sleep -Milliseconds 15 }
}`;
}

export async function ensureUserAppInFront() {
  const { front, windows } = await readWindows();
  // An untitled foreground window (one not in the visible list) is not the
  // app: keys sent to it went nowhere, so Ctrl+Shift+S opened Save As only
  // sometimes (24 Oct 2026). The app's own window is brought forward instead.
  if (front && front.title && !isOwnWindow(front)) {
    return { status: 'success', hwnd: front.hwnd, title: front.title, switched: false };
  }

  const target = pickUserWindow(windows);
  if (!target) return { status: 'error', message: 'There is no app open to use. Open one first.' };
  // A moment to settle after it comes forward: keys or clicks follow
  const result = await psScript(`
$h = [IntPtr]${Number(target.hwnd)}
${bringToFront('$h')}
if ([Win32Input]::GetForegroundWindow() -eq $h) { Start-Sleep -Milliseconds 40; 'FOCUSED' } else { 'FOCUS_FAILED' }
`);
  if (String(result).trim() !== 'FOCUSED') {
    // What is holding the foreground (an "Open With" chooser did, 24 Oct 2026)
    const holder = front ? `${await processNameOf(front) || 'pid ' + front.pid} "${front.title}"` : 'nothing';
    console.warn(`[SystemTools] Could not bring "${target.title}" forward; the foreground is ${holder}`);
    return { status: 'error', message: `I couldn't bring "${target.title}" to the front.` };
  }
  console.log(`[SystemTools] AbleSpeak was in front; switched back to "${target.title}"`);
  return { status: 'success', hwnd: target.hwnd, title: target.title, switched: true };
}

export async function focusApplication(appName) {
  const { query, app } = resolveAppName(appName);
  if (!query) return { status: 'error', message: 'Invalid application name' };

  const target = pickWindow(await listVisibleWindows(), appName);
  if (!target) {
    return {
      status: 'error',
      message: app
        ? `${app} isn't open. Say "open ${app}" to start it.`
        : `I couldn't find an open window called "${appName}".`,
    };
  }

  // Uses Win32Input.ForceFocus (pre-compiled in UIA_PRELUDE) which calls
  // SetForegroundWindow with the Alt-key trick to bypass Windows'
  // focus-stealing prevention. hwnd is digits only (checked when listed).
  const script = `
$hWnd = [IntPtr]${target.hwnd}
${bringToFront('$hWnd')}
if ([Win32Input]::GetForegroundWindow() -eq $hWnd) { Write-Output "FOCUSED" } else { Write-Output "FOCUS_FAILED" }
`;

  const result = await psScript(script);
  if (result !== 'FOCUSED') {
    return { status: 'error', message: `Could not bring "${target.title}" to the front` };
  }
  return { status: 'success', message: `Focused: ${target.title}` };
}

// ── Open Application ──

/**
 * The window an app just opened: one of its windows that wasn't open before
 * (`before` = the hwnds then), or null.
 */
export function pickLaunchedWindow(before, windows, appName) {
  return pickWindow(windows.filter(w => !before.has(String(w.hwnd))), appName);
}

/**
 * After starting an app, wait for its window and bring it to the front:
 * Windows can open it behind the app in use (23 Oct 2026: Notepad opened
 * behind Chrome, and the next step typed into Chrome). An app that was
 * already open may reuse its window (Settings, Spotify), so after a short
 * wait that one is brought forward instead. Returns the window's title, or
 * null if no window showed up in time.
 */
async function showLaunchedWindow(appName, before, hadWindow) {
  const started = Date.now();
  const maxMs = hadWindow ? 1500 : 6000;
  let target = null;
  while (!target && Date.now() - started < maxMs) {
    await new Promise(resolve => setTimeout(resolve, 300));
    target = pickLaunchedWindow(before, await listVisibleWindows().catch(() => []), appName);
  }
  if (!target && hadWindow) target = pickWindow(await listVisibleWindows().catch(() => []), appName);
  if (!target) return null;
  await psScript(`
$h = [IntPtr]${Number(target.hwnd)}
${bringToFront('$h')}
`).catch(() => {});
  return target.title;
}

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
    word: 'start winword /w', // /w = open a blank document, skipping Word's Start screen
    excel: 'start excel', // no blank-workbook switch exists; its Start screen is off per machine
    powerpoint: 'start powerpnt /B', // /B = open a blank presentation
    outlook: 'start outlook',
    teams: 'start msteams:',
    vscode: 'code',
    'visual studio code': 'code',
    snipping: 'snippingtool',
    'snipping tool': 'snippingtool',
  };

  const lower = appName.toLowerCase().trim();
  // "open my Word document" launches Word, like "open Word"
  const command = appMap[lower] || resolveAppName(appName).launch;

  // The windows open now, to find the one the app opens and bring it forward
  const windowsBefore = await listVisibleWindows().catch(() => []);
  const before = new Set(windowsBefore.map(w => String(w.hwnd)));
  const hadWindow = !!pickWindow(windowsBefore, appName);
  const opened = async () => {
    const title = await showLaunchedWindow(appName, before, hadWindow);
    return { status: 'success', message: `Opened ${appName}`, ...(title ? { window: title } : { starting: true }) };
  };

  // Only allow whitelisted apps or sanitized names — never raw user input in shell
  if (!command) {
    const safe = sanitizeForPS(appName);
    if (!safe) return { status: 'error', message: 'Invalid application name' };
    try {
      await psScript(`Start-Process "${safe}"`, 5000);
      return await opened();
    } catch (err) {
      return { status: 'error', message: `Could not open "${appName}": ${err.message}` };
    }
  }

  // Through "start", so cmd returns once the app is launched. Run directly,
  // Windows 11's Notepad launcher stays open with the window, the 5 s wait
  // ran out, and "open Notepad" was reported as failed although it opened.
  const launch = /^start\s/i.test(command) ? command : `start "" ${command}`;
  try {
    await execAsync(launch, { shell: 'cmd.exe', timeout: 5000 });
  } catch (err) {
    return { status: 'error', message: `Could not open "${appName}": ${err.message}` };
  }
  return opened();
}

// ── Close Application ──

export async function closeApplication(appName) {
  const safe = sanitizeForPS(appName);
  if (!safe) return { status: 'error', message: 'Invalid application name' };

  const script = `
$closed = $false
Get-Process -Name "*${safe}*" -ErrorAction SilentlyContinue | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
    $closed = $true
    Write-Output "Closed: $($_.ProcessName) (PID $($_.Id))"
}
if (-not $closed) {
    # Also try matching by window title
    Get-Process | Where-Object { $_.MainWindowTitle -like "*${safe}*" } | ForEach-Object {
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

// The Windows key, as the AI or a person may name it. SendKeys has no such
// key, so it is pressed through keybd_event, as windowControl's snapping
// already does: a tap on its own opens the Start menu.
const WIN_KEY_RE = /^(?:l|r)?win(?:dows)?(?:\s*key)?$|^(?:super|meta|start)$/;
const VK = { left: 0x25, up: 0x26, right: 0x27, down: 0x28, tab: 0x09, enter: 0x0d, space: 0x20, home: 0x24, end: 0x23 };

/**
 * How to press a shortcut: { sendKeys } text for SendKeys, { vk } key codes
 * to press with the Windows key held, or { error } for one that can't be
 * pressed. Exported for tests.
 */
export function keyPlan(keys) {
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

  const parts = String(keys || '').split('+').map(k => k.trim().toLowerCase()).filter(Boolean);
  if (parts.some(p => WIN_KEY_RE.test(p))) {
    const rest = parts.filter(p => !WIN_KEY_RE.test(p));
    if (!rest.length) return { vk: [] }; // a tap of the Windows key alone: the Start menu ("press the Windows key" did nothing, 24 Oct 2026)
    const codes = rest.map(p => (/^[a-z0-9]$/.test(p) ? p.toUpperCase().charCodeAt(0) : VK[p]));
    if (codes.some(c => !c)) return { error: `I can't press Windows+${rest.join('+')} yet.` };
    return { vk: codes };
  }

  let sendKeysStr = '';
  const regularKeys = [];
  for (const part of parts) {
    if (keyMap[part] && ['ctrl', 'alt', 'shift'].includes(part)) {
      sendKeysStr += keyMap[part];
    } else if (keyMap[part]) {
      regularKeys.push(keyMap[part]);
    } else {
      // Unrecognized token — e.g. a misheard word the AI passed through as a
      // literal key. Route through the same whitelist used everywhere else in
      // this file rather than embedding it verbatim: it sits inside a
      // PowerShell double-quoted SendKeys(...) string, and an unescaped
      // backtick/quote/dollar here is a command-injection path (CVA-2).
      const safe = sanitizeForPS(part);
      if (safe) regularKeys.push(safe);
    }
  }
  return { sendKeys: sendKeysStr + regularKeys.join('') };
}

export async function sendKeys(keys) {
  const plan = keyPlan(keys);
  if (plan.error) return { status: 'error', keys, message: plan.error };

  const front = await ensureUserAppInFront();
  if (front.status !== 'success') return { status: 'error', keys, message: front.message };
  // Which window the keys go to, for working out a shortcut that did nothing
  console.log(`[SystemTools] Keys ${keys} → "${String(front.title || '').slice(0, 60)}"${front.switched ? ' (brought forward)' : ''}`);

  const script = plan.vk
    ? `
[Win32Input]::keybd_event(0x5B, 0, 0, 0)        # LWIN down
${plan.vk.map(c => `[Win32Input]::keybd_event(${c}, 0, 0, 0)`).join('\n')}
Start-Sleep -Milliseconds 30
${plan.vk.map(c => `[Win32Input]::keybd_event(${c}, 0, 2, 0)`).join('\n')}
[Win32Input]::keybd_event(0x5B, 0, 2, 0)        # LWIN up
`
    : `
$wshell = New-Object -ComObject wscript.shell
Start-Sleep -Milliseconds 100
$wshell.SendKeys("${plan.sendKeys}")
`;

  await psScript(script);
  return { status: 'success', keys, message: `Sent keys: ${keys}` };
}

// ── Window Management ──
// Minimize / maximize / restore the foreground window, or snap it left/right.
// A student can't drag a title bar, so these matter for a usable desktop.
export async function windowControl(action) {
  const A = String(action || '').toLowerCase().replace(/\s+/g, '_');
  const front = await ensureUserAppInFront();
  if (front.status !== 'success') return { status: 'error', error: front.message };
  const SHOW = { minimize: 6, maximize: 3, restore: 9 }; // SW_MINIMIZE / SW_MAXIMIZE / SW_RESTORE

  if (SHOW[A] !== undefined) {
    const script = `
$h = [Win32Input]::GetForegroundWindow()
if ($h -ne [IntPtr]::Zero) { [Win32Input]::ShowWindow($h, ${SHOW[A]}) | Out-Null; Write-Output "OK" } else { Write-Output "NO_WINDOW" }
`;
    const r = (await psScript(script)).trim();
    return r.includes('OK')
      ? { status: 'success', message: `Window ${A}d` }
      : { status: 'error', error: 'No foreground window to control' };
  }

  if (A === 'snap_left' || A === 'snap_right') {
    const vk = A === 'snap_left' ? '0x25' : '0x27'; // VK_LEFT / VK_RIGHT
    const script = `
[Win32Input]::keybd_event(0x5B, 0, 0, 0)        # LWIN down
[Win32Input]::keybd_event(${vk}, 0, 0, 0)       # arrow down
Start-Sleep -Milliseconds 30
[Win32Input]::keybd_event(${vk}, 0, 2, 0)       # arrow up
[Win32Input]::keybd_event(0x5B, 0, 2, 0)        # LWIN up
Write-Output "OK"
`;
    await psScript(script);
    return { status: 'success', message: `Snapped window ${A === 'snap_left' ? 'left' : 'right'}` };
  }

  return { status: 'error', error: `Unknown window action: ${action}. Use minimize, maximize, restore, snap_left, snap_right.` };
}

// ── Type Text into Active App ──

export async function typeTextSystem(text) {
  const escaped = escapeForPSString(text);
  const front = await ensureUserAppInFront();
  if (front.status !== 'success') return { status: 'error', text, message: front.message };

  // Clipboard-paste is far more reliable than SendKeys in apps like Word:
  // it handles special characters, respects autocorrect, and doesn't drop
  // keystrokes if the window isn't fully focused yet.
  const script = `
$savedClip = $null
try { $savedClip = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
Set-Clipboard -Value "${escaped}"
Start-Sleep -Milliseconds 100
$wshell = New-Object -ComObject wscript.shell
$wshell.SendKeys("^v")
Start-Sleep -Milliseconds 200
if ($null -ne $savedClip) { try { Set-Clipboard -Value $savedClip } catch {} }
Write-Output "OK"
`;

  await psScript(script);
  const where = front.title ? ` into ${front.title}` : '';
  return { status: 'success', text, window: front.title, message: `Typed${where}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}` };
}

// ── Dictation Text — insert into a specific window ──

/**
 * The window dictation types into, captured when dictation starts, so the
 * text still lands there after the overlay or dashboard takes focus.
 */
let _dictationTarget = null; // { hwnd, pid, title }

/**
 * Capture the app in use as the dictation target: the window in front, or,
 * when that is AbleSpeak, the app in front of the rest.
 */
export async function captureDictationTarget() {
  _dictationTarget = await userWindow();
  console.log(`[Dictation] Target: ${_dictationTarget ? `"${_dictationTarget.title}" (${_dictationTarget.hwnd})` : 'none'}`);
  return _dictationTarget; // { hwnd, title, ... } or null
}

export function clearDictationTarget() {
  _dictationTarget = null;
}

async function dictationWindow() {
  return _dictationTarget || userWindow();
}

/**
 * Type text into the dictation target window.
 *   1. Word, when the target is Word: COM automation types at the cursor, no focus tricks needed
 *   2. Excel, when the target is Excel: the same for the active cell
 *   3. Clipboard paste — everything else (Notepad, browsers…), and if COM fails
 */
export async function dictateText(text) {
  const escaped = escapeForPSString(text);
  const target = await dictationWindow();
  if (!target) return { status: 'error', text, message: 'There is no app open to type into.' };
  const app = await processNameOf(target);

  // ── Path 1: Microsoft Word (COM) ──
  // GetActiveObject finds the already-open Word instance without stealing focus.
  // TypeText types at the current cursor; TypeParagraph inserts a real paragraph mark.
  const wordScript = `
try {
  $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
  $lines = "${escaped}" -split "\`n"
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i].Length -gt 0) { $word.Selection.TypeText($lines[$i]) }
    if ($i -lt $lines.Length - 1) { $word.Selection.TypeParagraph() }
  }
  Write-Output "OK_WORD"
} catch { Write-Output "SKIP" }
`;
  const wordResult = app === 'winword' ? (await psScript(wordScript, 6000)).trim() : 'SKIP';
  if (wordResult === 'OK_WORD') {
    return { status: 'success', text, message: `Dictated to Word: ${text.substring(0, 50)}` };
  }

  // ── Path 2: Microsoft Excel (COM) ──
  const excelScript = `
try {
  $xl = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
  $xl.ActiveCell.Value = ($xl.ActiveCell.Value + "${escaped}")
  Write-Output "OK_EXCEL"
} catch { Write-Output "SKIP" }
`;
  const excelResult = app === 'excel' ? (await psScript(excelScript, 6000)).trim() : 'SKIP';
  if (excelResult === 'OK_EXCEL') {
    return { status: 'success', text, message: `Dictated to Excel: ${text.substring(0, 50)}` };
  }

  // ── Path 3: Universal clipboard paste ──
  const script = `
$hWnd = [IntPtr]${Number(target.hwnd)}
[Win32Input]::ForceFocus($hWnd) | Out-Null
Start-Sleep -Milliseconds 250
$savedClip = $null
try { $savedClip = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
Set-Clipboard -Value "${escaped}"
$wshell = New-Object -ComObject wscript.shell
$wshell.SendKeys("^v")
Start-Sleep -Milliseconds 200
if ($null -ne $savedClip) { try { Set-Clipboard -Value $savedClip } catch {} }
Write-Output "OK"
`;

  await psScript(script, 10000);
  return { status: 'success', text, message: `Dictated: ${text.substring(0, 50)}...` };
}

/**
 * Execute an in-dictation command (navigation / formatting / editing).
 * Tries Word COM first (no focus steal); falls back to SendKeys on the
 * dictation target window.
 *
 * @param {string} command - one of the COMMANDS keys below
 */
export async function executeDictationCommand(command) {
  // Word VBA constants used below:
  //   wdCharacter=1  wdWord=2  wdSentence=3  wdParagraph=4  wdLine=5  wdStory=6
  const WORD_SCRIPT = {
    next_paragraph:   `$word.Selection.MoveDown(4, 1)`,
    prev_paragraph:   `$word.Selection.MoveUp(4, 1)`,
    next_line:        `$word.Selection.MoveDown(5, 1)`,
    prev_line:        `$word.Selection.MoveUp(5, 1)`,
    line_end:         `$word.Selection.EndKey(5, 0)`,      // wdLine, wdMove
    line_start:       `$word.Selection.HomeKey(5, 0)`,
    doc_end:          `$word.Selection.EndKey(6, 0)`,      // wdStory
    doc_start:        `$word.Selection.HomeKey(6, 0)`,
    undo:             `$word.Application.Undo()`,
    redo:             `$word.Application.Redo()`,
    delete_word:      `$word.Selection.Delete(2, 1)`,      // wdWord
    delete_char:      `$word.Selection.TypeBackspace()`,
    bold:             `$word.Selection.Font.Bold = if ($word.Selection.Font.Bold -eq -1) { 0 } else { -1 }`,
    italic:           `$word.Selection.Font.Italic = if ($word.Selection.Font.Italic -eq -1) { 0 } else { -1 }`,
    underline:        `$word.Selection.Font.Underline = if ($word.Selection.Font.Underline -gt 0) { 0 } else { 1 }`,
    select_all:       `$word.Selection.WholeStory()`,
    page_down:        `$word.Selection.MoveDown(5, 25)`,
    page_up:          `$word.Selection.MoveUp(5, 25)`,
  };
  // SendKeys fallback (used when Word COM fails — e.g. Notepad, browser)
  const SEND_KEYS = {
    next_paragraph: '^{DOWN}',   prev_paragraph: '^{UP}',
    next_line: '{DOWN}',         prev_line: '{UP}',
    line_end: '{END}',           line_start: '{HOME}',
    doc_end: '^{END}',           doc_start: '^{HOME}',
    undo: '^z',                  redo: '^y',
    delete_word: '^{BACKSPACE}', delete_char: '{BACKSPACE}',
    bold: '^b',                  italic: '^i',
    underline: '^u',             select_all: '^a',
    page_down: '{PGDN}',         page_up: '{PGUP}',
  };

  const wordAction = WORD_SCRIPT[command];
  const keyCombo = SEND_KEYS[command];
  if (!wordAction && !keyCombo) return { status: 'error', message: `Unknown command: ${command}` };

  const target = await dictationWindow();
  if (!target) return { status: 'error', message: 'There is no app open to use.' };

  // Try Word COM (no focus change needed)
  if (wordAction && await processNameOf(target) === 'winword') {
    const wordScript = `
try {
  $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
  ${wordAction}
  Write-Output "OK_WORD"
} catch { Write-Output "SKIP" }
`;
    const result = (await psScript(wordScript, 5000)).trim();
    if (result === 'OK_WORD') return { status: 'success', command };
  }

  // SendKeys fallback — focus the saved dictation target first
  // Win32Input is already loaded by PSWorker via UIA_PRELUDE, so no Add-Type needed.
  if (keyCombo) {
    const script = `
$hWnd = [IntPtr]${Number(target.hwnd)}
[Win32Input]::ForceFocus($hWnd) | Out-Null
Start-Sleep -Milliseconds 200
$wsh = New-Object -ComObject wscript.shell
$wsh.SendKeys("${keyCombo}")
Write-Output "OK"
`;
    await psScript(script, 5000);
  }

  return { status: 'success', command };
}

// ══════════════════════════════════════════════════════════════
// ── Desktop UI Automation — see and click ANYTHING in ANY app ──
// Uses Windows UI Automation (the same API screen readers use)
// via PowerShell + .NET. No extra dependencies.
// ══════════════════════════════════════════════════════════════

const UIA_PRELUDE = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Threading;
using System.Runtime.InteropServices;
public class Win32Input {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    public static bool ForceFocus(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;
        if (IsIconic(hWnd)) { ShowWindow(hWnd, 9); Thread.Sleep(150); }
        IntPtr fg = GetForegroundWindow();
        uint pid;
        uint fgThread = GetWindowThreadProcessId(fg, out pid);
        uint myThread = GetCurrentThreadId();
        if (fgThread != myThread) AttachThreadInput(myThread, fgThread, true);
        // An Alt press lets this process take the foreground. A bare Alt
        // release would open the menu keys in the app (Office's ribbon then
        // takes focus from the document), so an unassigned key (0xE8) is
        // tapped in between, as AutoHotkey does.
        keybd_event(0x12, 0, 0, 0);
        keybd_event(0xE8, 0, 0, 0);
        keybd_event(0xE8, 0, 2, 0);
        keybd_event(0x12, 0, 2, 0);
        bool ok = SetForegroundWindow(hWnd);
        if (!ok) { BringWindowToTop(hWnd); SwitchToThisWindow(hWnd, true); ok = true; }
        if (fgThread != myThread) AttachThreadInput(myThread, fgThread, false);
        return ok;
    }
}
public class WindowList {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
    // Visible, titled top-level windows, front to back, as "hwnd<TAB>pid<TAB>title".
    // Skips owned windows (tool palettes, popups) unless one is in front: a
    // dialog (Save As, Open, "Save your changes?") is an owned window, and
    // while it is in front it is what the person sees and must act on. Before
    // this the agent pressed Ctrl+Shift+S and saw "nothing changed" (24 Oct
    // 2026). Also skips cloaked windows (suspended Store apps, other virtual
    // desktops), which Windows reports as visible.
    public static string[] Visible() {
        var found = new System.Collections.Generic.List<string>();
        IntPtr front = GetForegroundWindow();
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h) || (GetWindow(h, 4) != IntPtr.Zero && h != front)) return true;
            int cloaked;
            if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            var text = new System.Text.StringBuilder(512);
            if (GetWindowText(h, text, 512) == 0) {
                // An untitled window in front (Windows' "Open With" chooser)
                // holds the keyboard and must be seen: its class stands in
                // for its title (24 Oct 2026).
                if (h != front) return true;
                GetClassName(h, text, 512);
                if (text.Length == 0) return true;
            }
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            found.Add(h.ToInt64() + "\\t" + pid + "\\t" + text.ToString().Replace("\\t", " "));
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
}
"@
Add-Type -AssemblyName WindowsBase
$screenModelSource = @'
${SCREEN_MODEL_CS}
'@
try {
    Add-Type -TypeDefinition $screenModelSource -ErrorAction Stop -ReferencedAssemblies @(
        [System.Windows.Automation.AutomationElement].Assembly.Location,
        [System.Windows.Automation.ControlType].Assembly.Location,
        [System.Windows.Rect].Assembly.Location)
} catch {
    [Console]::Error.WriteLine("ScreenModel did not compile: " + $_.Exception.Message)
}
$officeUiaSource = @'
${OFFICE_UIA_CS}
'@
try {
    Add-Type -TypeDefinition $officeUiaSource -ErrorAction Stop -ReferencedAssemblies System.Drawing
} catch {
    [Console]::Error.WriteLine("OfficeUia did not compile: " + $_.Exception.Message)
}
function Get-TargetWindow([string]$app) {
    if ($app) {
        $proc = Get-Process -Name "*$app*" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if (-not $proc) { $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$app*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
        if ($proc) { return [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle) }
        return $null
    }
    $hwnd = [Win32Input]::GetForegroundWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        if ($el -and $el.Current.Name -notlike 'AbleSpeak*') { return $el }
    }
    # Foreground is AbleSpeak itself (or nothing) — the app in front of the rest
    foreach ($line in [WindowList]::Visible()) {
        $parts = $line -split "\`t", 3
        if ($parts[2] -like 'AbleSpeak*' -or $parts[2] -eq 'Program Manager' -or $parts[2] -eq 'Windows Input Experience') { continue }
        return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$parts[0])
    }
    return $null
}
`;

/**
 * Scan a desktop app window for interactive elements (buttons, menus,
 * inputs, list items...). The desktop equivalent of the browser
 * extension's viewport scan — this is the AI's "eyes" on desktop apps.
 */
export async function listDesktopElements(appName) {
  const safe = appName ? sanitizeForPS(appName) : '';

  const script = `
$window = Get-TargetWindow "${safe}"
if (-not $window) { Write-Output '{"error":"NO_WINDOW"}'; return }
$types = @('Button','CheckBox','ComboBox','Edit','Hyperlink','ListItem','MenuItem','RadioButton','TabItem','SplitButton','TreeItem','Slider')
$conds = $types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::$_) }
$orCond = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
$found = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $orCond)
$items = New-Object System.Collections.ArrayList
foreach ($el in $found) {
    if ($items.Count -ge 60) { break }
    try {
        $c = $el.Current
        if ($c.IsOffscreen) { continue }
        if (-not $c.Name) { continue }
        $r = $c.BoundingRectangle
        if ($r.Width -le 0 -or $r.Height -le 0) { continue }
        [void]$items.Add([PSCustomObject]@{
            name = $c.Name
            type = ($c.ControlType.ProgrammaticName -replace 'ControlType\\.','')
            enabled = $c.IsEnabled
            x = [int]($r.X + $r.Width / 2)
            y = [int]($r.Y + $r.Height / 2)
        })
    } catch { continue }
}
[PSCustomObject]@{ window = $window.Current.Name; elements = $items } | ConvertTo-Json -Depth 4 -Compress
`;

  const result = await psScript(script, 25000);
  try {
    const parsed = JSON.parse(result);
    if (parsed.error === 'NO_WINDOW') {
      return { status: 'error', message: appName ? `No window found for "${appName}"` : 'No target window found' };
    }
    const elements = Array.isArray(parsed.elements) ? parsed.elements : (parsed.elements ? [parsed.elements] : []);
    return {
      status: 'success',
      window: parsed.window,
      count: elements.length,
      elements,
      message: `Found ${elements.length} interactive elements in "${parsed.window}": ` +
        elements.slice(0, 25).map(e => `"${e.name}" (${e.type})`).join(', '),
    };
  } catch {
    return { status: 'error', message: 'Could not scan window: ' + String(result).slice(0, 200) };
  }
}

/**
 * Click an element in a desktop app — by visible name, or by coordinates.
 * Tries the accessibility Invoke action first (most reliable), then falls
 * back to a real mouse click at the element's center.
 */
export async function clickDesktopElement({ name, app_name, x, y, button = 'left', double_click = false } = {}) {
  // ── Coordinate mode: raw mouse click ──
  if (typeof x === 'number' && typeof y === 'number' && !name) {
    return mouseClick(x, y, button, double_click);
  }

  if (!name) return { status: 'error', message: 'Provide an element name or x/y coordinates' };
  const safeName = sanitizeForPS(name).toLowerCase();
  const safeApp = app_name ? sanitizeForPS(app_name) : '';
  if (!safeName) return { status: 'error', message: 'Invalid element name' };

  const downFlag = button === 'right' ? '0x0008' : '0x0002';
  const upFlag = button === 'right' ? '0x0010' : '0x0004';

  const script = `
$window = Get-TargetWindow "${safeApp}"
if (-not $window) { Write-Output 'NO_WINDOW'; return }
# Bring the window forward so the click lands on it
try {
    $wshell = New-Object -ComObject wscript.shell
    $wshell.AppActivate($window.Current.ProcessId) | Out-Null
    Start-Sleep -Milliseconds 250
} catch {}
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true)
$found = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$target = $null
$exact = $null
foreach ($el in $found) {
    try {
        if ($el.Current.IsOffscreen) { continue }
        $n = $el.Current.Name
        if (-not $n) { continue }
        $nl = $n.ToLower()
        if ($nl -eq "${safeName}") { $exact = $el; break }
        if (-not $target -and $nl.Contains("${safeName}")) { $target = $el }
    } catch { continue }
}
if ($exact) { $target = $exact }
if (-not $target) { Write-Output 'NOT_FOUND'; return }
$tname = $target.Current.Name
# Try the accessibility Invoke action first (reliable, no mouse movement)
if (-not ${double_click ? '$true' : '$false'} -and "${button}" -eq 'left') {
    try {
        $invoke = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        Write-Output "INVOKED: $tname"
        return
    } catch {}
    try {
        $toggle = $target.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $toggle.Toggle()
        Write-Output "TOGGLED: $tname"
        return
    } catch {}
}
# Fallback: real mouse click at the element's center
$r = $target.Current.BoundingRectangle
$cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
[Win32Input]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 60
[Win32Input]::mouse_event(${downFlag},0,0,0,0); [Win32Input]::mouse_event(${upFlag},0,0,0,0)
if (${double_click ? '$true' : '$false'}) {
    Start-Sleep -Milliseconds 80
    [Win32Input]::mouse_event(${downFlag},0,0,0,0); [Win32Input]::mouse_event(${upFlag},0,0,0,0)
}
Write-Output "CLICKED: $tname at $cx,$cy"
`;

  const result = await psScript(script, 25000);
  if (result.includes('NO_WINDOW')) {
    return { status: 'error', message: app_name ? `No window found for "${app_name}". Is it open?` : 'No target window found' };
  }
  if (result.includes('NOT_FOUND')) {
    return { status: 'error', message: `No element named "${name}" found. Use list_desktop_elements to see what is clickable.` };
  }
  return { status: 'success', message: result };
}

/**
 * Raw mouse click at screen coordinates.
 */
export async function mouseClick(x, y, button = 'left', double_click = false) {
  const px = Math.max(0, parseInt(x, 10) || 0);
  const py = Math.max(0, parseInt(y, 10) || 0);
  const downFlag = button === 'right' ? '0x0008' : '0x0002';
  const upFlag = button === 'right' ? '0x0010' : '0x0004';
  const front = await ensureUserAppInFront();
  if (front.status !== 'success') return { status: 'error', message: front.message };

  const script = `
[Win32Input]::SetCursorPos(${px}, ${py}) | Out-Null
Start-Sleep -Milliseconds 60
[Win32Input]::mouse_event(${downFlag},0,0,0,0); [Win32Input]::mouse_event(${upFlag},0,0,0,0)
${double_click ? `Start-Sleep -Milliseconds 80
[Win32Input]::mouse_event(${downFlag},0,0,0,0); [Win32Input]::mouse_event(${upFlag},0,0,0,0)` : ''}
Write-Output "Clicked at ${px},${py}"
`;

  await psScript(script, 15000);
  return { status: 'success', message: `${button} ${double_click ? 'double-' : ''}clicked at ${px},${py}` };
}

/**
 * Read the text content of a desktop app window (dialogs, documents,
 * status messages) so the AI can describe it to the user.
 */
export async function readDesktopWindow(appName) {
  const safe = appName ? sanitizeForPS(appName) : '';

  const script = `
$window = Get-TargetWindow "${safe}"
if (-not $window) { Write-Output 'NO_WINDOW'; return }
$types = @('Text','Edit','Document')
$conds = $types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::$_) }
$orCond = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
$found = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $orCond)
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("Window: " + $window.Current.Name)
foreach ($el in $found) {
    try {
        if ($el.Current.IsOffscreen) { continue }
        $line = $el.Current.Name
        try {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($vp.Current.Value) { $line = $vp.Current.Value }
        } catch {}
        if ($line) { [void]$sb.AppendLine($line) }
        if ($sb.Length -gt 4000) { break }
    } catch { continue }
}
Write-Output $sb.ToString().Substring(0, [Math]::Min($sb.Length, 4000))
`;

  const result = await psScript(script, 25000);
  if (result.includes('NO_WINDOW')) {
    return { status: 'error', message: appName ? `No window found for "${appName}"` : 'No target window found' };
  }
  return { status: 'success', text: result, message: result.slice(0, 500) };
}

/**
 * Scroll a desktop app window using mouse wheel events at its center.
 */
export async function desktopScroll(direction = 'down', amount = 3, appName) {
  const safe = appName ? sanitizeForPS(appName) : '';
  const notches = sanitizeNumber(amount, 3, 1, 20);
  const delta = direction === 'up' ? 120 : -120;

  const script = `
$window = Get-TargetWindow "${safe}"
if (-not $window) { Write-Output 'NO_WINDOW'; return }
try {
    $wshell = New-Object -ComObject wscript.shell
    $wshell.AppActivate($window.Current.ProcessId) | Out-Null
    Start-Sleep -Milliseconds 200
} catch {}
$r = $window.Current.BoundingRectangle
$cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
[Win32Input]::SetCursorPos($cx, $cy) | Out-Null
1..${notches} | ForEach-Object {
    [Win32Input]::mouse_event(0x0800, 0, 0, ${delta}, 0)
    Start-Sleep -Milliseconds 50
}
Write-Output "Scrolled ${direction}"
`;

  const result = await psScript(script, 15000);
  if (result.includes('NO_WINDOW')) {
    return { status: 'error', message: 'No target window found' };
  }
  return { status: 'success', message: `Scrolled ${direction} in ${appName || 'active window'}` };
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
