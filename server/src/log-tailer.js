import { watch } from 'chokidar';
import { createReadStream, statSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { insertLogEvent, upsertHealthCheck } from './db.js';

const LOG_PATTERN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(DEBUG|INFO|WARN|ERROR)\s+(\S+)\s+-\s+(.+)$/;

const HEALTH_PATTERNS = [
  { pattern: /Unable to find provider:\s*(\S+)/i, component: (m) => `provider_${m[1].toLowerCase()}`, status: 'warn', message: (m) => `Unable to find provider: ${m[1]}` },
  { pattern: /Unauthorized access to (\S+)/i, component: () => 'llm', status: 'error', message: (m) => `Unauthorized access to ${m[1]}. Check API key.` },
  { pattern: /Setting active prompt to (\S+)/i, component: () => 'prompt_router', status: 'ok', message: (m) => `Active prompt: ${m[1]}`, meta: (m) => ({ prompt: m[1] }) },
  { pattern: /Ready for microphone audio/i, component: () => 'microphone', status: 'ok', message: () => 'Microphone ready' },
  { pattern: /Audio capture cancelled/i, component: () => 'microphone', status: 'warn', message: () => 'Audio capture cancelled' },
  { pattern: /Audio capture interrupted/i, component: () => 'microphone', status: 'error', message: () => 'Audio capture interrupted' },
  { pattern: /Finished directive (\S+) in (\d+)ms/i, component: () => 'directive', status: 'ok', message: (m) => `Directive ${m[1]} completed in ${m[2]}ms`, meta: (m) => ({ directiveId: m[1], duration_ms: parseInt(m[2]) }) },
  { pattern: /Using microphone:\s*(.+)/i, component: () => 'microphone', status: 'ok', message: (m) => `Using microphone: ${m[1]}` }
];

export class LogTailer {
  constructor({ logFilePath, onEvent, onHealthChange, wsProxy }) {
    this.logFilePath = logFilePath;
    this.onEvent = onEvent || (() => {});
    this.onHealthChange = onHealthChange || (() => {});
    this.wsProxy = wsProxy;
    this.fileOffset = 0;
    this.watcher = null;
    this.recentEvents = [];
    this.maxRecent = 200;
  }

  async start() {
    if (!existsSync(this.logFilePath)) {
      console.warn('[LogTailer] Log file not found:', this.logFilePath);
      return;
    }
    const stats = statSync(this.logFilePath);
    this.fileOffset = Math.max(0, stats.size - 50000);
    await this._readNewLines();
    this.watcher = watch(this.logFilePath, { persistent: true, usePolling: true, interval: 1000 });
    this.watcher.on('change', () => this._readNewLines());
    console.log('[LogTailer] Watching', this.logFilePath);
  }

  stop() { if (this.watcher) { this.watcher.close(); this.watcher = null; } }

  getRecentEvents(limit = 100, level = null) {
    let events = this.recentEvents;
    if (level) events = events.filter(e => e.level === level);
    return events.slice(-limit);
  }

  async _readNewLines() {
    return new Promise((resolve) => {
      const stream = createReadStream(this.logFilePath, { start: this.fileOffset, encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let bytesRead = this.fileOffset;
      rl.on('line', (line) => {
        bytesRead += Buffer.byteLength(line, 'utf-8') + 2;
        const parsed = this._parseLine(line);
        if (!parsed) return;
        this.recentEvents.push(parsed);
        if (this.recentEvents.length > this.maxRecent) this.recentEvents.shift();
        if (parsed.level !== 'DEBUG') {
          try { insertLogEvent({ level: parsed.level, logger: parsed.logger, message: parsed.message, raw_line: line }); } catch {}
        }
        this._checkHealthPatterns(parsed);
        this.onEvent(parsed);
      });
      rl.on('close', () => { this.fileOffset = bytesRead || this.fileOffset; resolve(); });
      rl.on('error', () => resolve());
    });
  }

  _parseLine(line) {
    const match = line.match(LOG_PATTERN);
    if (!match) return null;
    return { timestamp: match[1], level: match[2], logger: match[3], message: match[4], raw: line };
  }

  _checkHealthPatterns(event) {
    for (const hp of HEALTH_PATTERNS) {
      const match = event.message.match(hp.pattern);
      if (match) {
        const component = hp.component(match);
        const status = hp.status;
        const message = hp.message(match);
        const meta = hp.meta ? hp.meta(match) : null;
        try { upsertHealthCheck({ component, status, message }); } catch {}
        this.onHealthChange({ component, status, message, meta, timestamp: event.timestamp });
        if (meta && meta.prompt && this.wsProxy) this.wsProxy.setActivePrompt(meta.prompt);
        break;
      }
    }
  }
}
