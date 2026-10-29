/**
 * One long-running PowerShell that speaks: Windows' own voice (SAPI) and audio
 * files (Edge neural MP3s). Starting PowerShell and loading the speech engine
 * for every reply cost seconds each time; this process loads them once and
 * then takes one request per line on stdin, answering "DONE <id>" or
 * "ERR <id> <message>" when it has finished speaking.
 *
 * stop() ends the speech at once by ending the process; the next request
 * starts a new one.
 */
const { spawn } = require('child_process');

const HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName PresentationCore
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$wanted = $env:ABLESPEAK_SAPI_VOICE
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
$voice = $null
if ($wanted) { $voice = $voices | Where-Object { $_.Name -like "*$wanted*" } | Select-Object -First 1 }
if (-not $voice) { $voice = $voices | Where-Object { $_.Gender -eq 'Female' -and $_.Culture.Name -eq 'en-US' } | Select-Object -First 1 }
if (-not $voice) { $voice = $voices | Where-Object { $_.Gender -eq 'Female' -and $_.Culture.Name -like 'en*' } | Select-Object -First 1 }
if ($voice) { $synth.SelectVoice($voice.Name) }
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ', 4)
  $id = $parts[0]
  try {
    if ($parts[1] -eq 'SAY') {
      $synth.Rate = [int]$parts[2]
      $synth.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[3])))
    } elseif ($parts[1] -eq 'PLAY') {
      $file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[3]))
      $p = New-Object System.Windows.Media.MediaPlayer
      $p.Open([uri]$file)
      $n = 0
      while (-not $p.NaturalDuration.HasTimeSpan -and $n -lt 50) { Start-Sleep -Milliseconds 50; $n++ }
      if (-not $p.NaturalDuration.HasTimeSpan) { $p.Close(); throw 'the audio would not load' }
      $p.Play()
      Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 100)
      $p.Close()
      Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
    }
    [Console]::Out.WriteLine("DONE $id")
  } catch {
    [Console]::Out.WriteLine("ERR $id " + ($_.Exception.Message -replace '\s+', ' '))
  }
  [Console]::Out.Flush()
}
`;

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');

class TtsHost {
  constructor({ maxMs = 120000 } = {}) {
    this.proc = null;
    this.ready = null;
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.nextId = 1;
    this.buffer = '';
    this.maxMs = maxMs;
  }

  _start() {
    if (this.proc) return this.ready;
    const encoded = Buffer.from(HOST_SCRIPT, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    });
    this.proc = proc;
    this.buffer = '';
    this.ready = new Promise((resolve, reject) => {
      this._onReady = resolve;
      this._onFail = reject;
    });
    this.ready.catch(() => {}); // a failed start is reported to whoever is waiting
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        this._line(line);
      }
    });
    proc.stderr.on('data', () => {}); // PowerShell progress noise; failures come back as ERR lines
    proc.on('exit', () => this._ended(proc));
    proc.on('error', err => this._ended(proc, err));
    return this.ready;
  }

  _line(line) {
    if (line === 'READY') { this._onReady?.(); return; }
    const m = line.match(/^(DONE|ERR) (\d+)(?: (.*))?$/);
    if (!m) return;
    const job = this.pending.get(m[2]);
    if (!job) return;
    this.pending.delete(m[2]);
    clearTimeout(job.timer);
    if (m[1] === 'DONE') job.resolve(true);
    else job.reject(new Error(m[3] || 'speech failed'));
  }

  // The process ended (stopped on purpose, or crashed): anything waiting is over.
  _ended(proc, err) {
    if (this.proc !== proc) return;
    this.proc = null;
    this._onFail?.(err || new Error('the speaker stopped'));
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      job.resolve(false); // stopped, not failed: "stop" ends speech this way
      this.pending.delete(id);
    }
  }

  async _send(kind, a, b) {
    await this._start();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stop(); reject(new Error('speech took too long')); }, this.maxMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${id} ${kind} ${a} ${b}\n`);
    });
  }

  /** Speak with Windows' voice. rate: SAPI -10…10. Resolves when finished (false if stopped). */
  say(text, rate = 1) {
    return this._send('SAY', Math.max(-10, Math.min(10, Math.round(rate))), b64(text));
  }

  /** Play an audio file, then delete it. Resolves when finished (false if stopped). */
  play(file) {
    return this._send('PLAY', 0, b64(file));
  }

  /** Load the voice now, so the first reply does not wait for it. */
  warm() { return this._start().catch(() => {}); }

  /** Stop speaking at once. */
  stop() {
    const proc = this.proc;
    if (!proc) return;
    try { proc.kill(); } catch {}
  }
}

module.exports = { TtsHost };
