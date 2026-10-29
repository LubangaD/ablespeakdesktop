/**
 * Real-time speech recognition on AbleSpeak's speech service (Modal,
 * speech-server/stream_service.py): live words while the person speaks
 * (CDLI Whisper small) and accurate final words when they stop (CDLI Whisper
 * large-v3, WER 0.14 on Kenyan English non-standard speech).
 *
 * One WebSocket stays open while AbleSpeak is in use. It opens when the app
 * starts (waking the service, which takes up to a minute from asleep) and
 * closes after 10 minutes without speech, so the service can sleep and costs
 * nothing; the next phrase opens it again. Until it is ready, and whenever it
 * doesn't answer in time, the other engines hear the clip as before.
 *
 * ABLESPEAK_ASR_URL   wss://…/v1/stream
 * ABLESPEAK_ASR_TOKEN the service's key (server/.env, never in the installer)
 */
import WebSocket from 'ws';

const READY_TIMEOUT_MS = 90000;       // waking the service from asleep took 33–57 s in tests
const HEARTBEAT_MS = 15000;
const SILENT_LINK_MS = 45000;         // nothing heard for this long: the link is dead
const IDLE_CLOSE_MS = 10 * 60000;     // no speech for this long: let the service sleep
const RETRY_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const KEEP_RESULT_MS = 2 * 60000;     // a final waits this long for its clip (dictation queues)
const MAX_BUFFERED = 256 * 1024;      // audio not yet sent: beyond this the link is too slow

export class RemoteAsr {
  constructor({ url, token, onChange, onPartial, WebSocketImpl = WebSocket } = {}) {
    this.url = url || '';
    this.token = token || '';
    this.onChange = onChange || (() => {});
    this.onPartial = onPartial || (() => {});
    this.WebSocketImpl = WebSocketImpl;
    this.state = this.configured ? 'off' : 'unconfigured';
    this.error = null;
    this.gpu = null;
    this.rttMs = null;
    this._ws = null;
    this._stopping = false;
    this._idleClosed = false;
    this._retries = 0;
    this._retryTimer = null;
    this._heartbeat = null;
    this._lastHeard = 0;
    this._lastSpeech = 0;
    this._utt = null;                 // the utterance being streamed
    this._finals = new Map();         // utt → { promise, resolve, result }
    this._peeks = new Map();          // id → resolve
    this._peekSeq = 0;
  }

  get configured() { return !!(this.url && this.token); }
  get ready() { return this.state === 'ready'; }

  status() {
    return { state: this.state, gpu: this.gpu, rttMs: this.rttMs, error: this.error };
  }

  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    try { this.onChange(state); } catch (err) { console.warn('[RemoteASR] Telling AbleSpeak about the change failed:', err.message); }
  }

  /** Open the connection (wakes the service). Safe to call again. */
  start() {
    if (!this.configured) return;
    this._stopping = false;
    this._lastSpeech = Date.now();
    if (!this._ws) this._connect();
  }

  _connect() {
    clearTimeout(this._retryTimer);
    this._setState(this._retries ? 'reconnecting' : 'connecting');
    const ws = new this.WebSocketImpl(this.url, { headers: { Authorization: `Bearer ${this.token}` } });
    this._ws = ws;
    const opened = Date.now();
    const readyTimer = setTimeout(() => {
      if (this._ws === ws && !this.ready) {
        this.error = 'the speech service did not wake up in time';
        try { ws.terminate(); } catch {}
      }
    }, READY_TIMEOUT_MS);

    ws.on('message', raw => {
      this._lastHeard = Date.now();
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'ready') {
        clearTimeout(readyTimer);
        this.gpu = msg.gpu || null;
        this.error = null;
        this._retries = 0;
        console.log(`[RemoteASR] Ready in ${Date.now() - opened} ms (${this.gpu || 'GPU'})`);
        this._setState('ready');
        this._startHeartbeat();
      } else if (msg.type === 'partial') {
        if (msg.utt === this._utt) this.onPartial(msg.utt, msg.text || '');
      } else if (msg.type === 'final') {
        this._settleFinal(msg.utt, msg);
      } else if (msg.type === 'peeked') {
        this._peeks.get(msg.id)?.(msg);
        this._peeks.delete(msg.id);
      } else if (msg.type === 'pong' && typeof msg.t === 'number') {
        this.rttMs = Math.round(Date.now() - msg.t);
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(readyTimer);
      this.error = res.statusCode === 403 || res.statusCode === 401
        ? 'the speech service refused this computer\'s key'
        : `the speech service answered ${res.statusCode}`;
      try { ws.terminate(); } catch {}
    });
    ws.on('error', err => { this.error = this.error || err.message; });
    ws.on('close', () => {
      clearTimeout(readyTimer);
      if (this._ws !== ws) return;
      this._ws = null;
      this._stopHeartbeat();
      this._dropPending('the connection closed');
      if (this._stopping) { this._setState(this.configured ? 'off' : 'unconfigured'); return; }
      if (this._idleClosed) { this._idleClosed = false; this._setState('asleep'); return; }
      // A refused key won't work the next second: try again much later
      const refused = /refused this computer/.test(this.error || '');
      const wait = refused ? 5 * 60000 : RETRY_MS[Math.min(this._retries, RETRY_MS.length - 1)];
      this._retries++;
      console.warn(`[RemoteASR] Disconnected (${this.error || 'closed'}); trying again in ${Math.round(wait / 1000)} s`);
      this._setState(refused ? 'failed' : 'reconnecting');
      this._retryTimer = setTimeout(() => { if (!this._stopping) this._connect(); }, wait);
      this._retryTimer.unref?.();
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastHeard = Date.now();
    this._heartbeat = setInterval(() => {
      const ws = this._ws;
      if (!ws) return;
      if (Date.now() - this._lastHeard > SILENT_LINK_MS) {
        this.error = 'the speech service stopped answering';
        try { ws.terminate(); } catch {}
        return;
      }
      // Asleep after a quiet spell, so the service can scale to zero
      if (!this._utt && Date.now() - this._lastSpeech > IDLE_CLOSE_MS) {
        console.log('[RemoteASR] No speech for 10 minutes: letting the speech service sleep');
        this._idleClosed = true;
        try { ws.close(); } catch {}
        return;
      }
      this._send({ type: 'ping', t: Date.now() });
    }, HEARTBEAT_MS);
    this._heartbeat.unref?.();
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeat);
    this._heartbeat = null;
  }

  _send(message) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(typeof message === 'string' || Buffer.isBuffer(message) ? message : JSON.stringify(message)); return true; } catch { return false; }
  }

  _dropPending(why) {
    for (const [utt, entry] of this._finals) if (!entry.result) this._settleFinal(utt, { error: why });
    for (const resolve of this._peeks.values()) resolve({ error: why });
    this._peeks.clear();
    this._utt = null;
  }

  _settleFinal(utt, result) {
    const entry = this._finals.get(utt);
    if (!entry || entry.result) return;
    entry.result = result;
    entry.resolve(result);
    setTimeout(() => this._finals.delete(utt), KEEP_RESULT_MS).unref?.();
  }

  /** Speech started: stream this utterance. False when the service can't hear it now. */
  beginUtterance(utt, prompt = '') {
    this._lastSpeech = Date.now();
    if (!this._ws && this.configured && !this._stopping) this._connect(); // asleep: wake it for next time
    if (!this.ready) return false;
    this._utt = utt;
    return this._send({ type: 'start', utt, prompt });
  }

  /** Audio for the current utterance: 16 kHz mono PCM16. */
  sendAudio(utt, pcm) {
    if (!this.ready || utt !== this._utt) return false;
    if (this._ws.bufferedAmount > MAX_BUFFERED) return false; // too slow a link: the clip path takes over
    return this._send(pcm);
  }

  /** Speech ended: the service starts the final words now; finish() collects them. */
  end(utt) {
    if (utt == null || this._finals.has(utt)) return;
    if (!this.ready || utt !== this._utt) return;
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    this._finals.set(utt, { promise, resolve, result: null, endedAt: Date.now() });
    this._utt = null;
    this._lastSpeech = Date.now();
    if (!this._send({ type: 'end', utt })) this._settleFinal(utt, { error: 'not sent' });
  }

  /** The final words for an utterance, or { error } if they don't come in time. */
  async finish(utt, timeoutMs = 3000) {
    if (utt == null) return { error: 'not streamed' };
    if (!this._finals.has(utt)) this.end(utt);
    const entry = this._finals.get(utt);
    if (!entry) return { error: this.ready ? 'not streamed' : `the speech service is ${this.state}` };
    let timer;
    const result = await Promise.race([
      entry.promise,
      new Promise(r => { timer = setTimeout(() => r({ error: 'timeout' }), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!result.error) this._finals.delete(utt);
    return result.error ? result : { ...result, waitedMs: Date.now() - entry.endedAt };
  }

  /** The accurate words so far, without ending the utterance (the real-time check). */
  async peek(utt, timeoutMs = 2000) {
    if (!this.ready || utt == null || utt !== this._utt) return { error: 'not streamed' };
    const id = ++this._peekSeq;
    let timer;
    const answer = new Promise(resolve => {
      this._peeks.set(id, resolve);
      timer = setTimeout(() => { this._peeks.delete(id); resolve({ error: 'timeout' }); }, timeoutMs);
    });
    if (!this._send({ type: 'peek', utt, id })) { clearTimeout(timer); this._peeks.delete(id); return { error: 'not sent' }; }
    const result = await answer;
    clearTimeout(timer);
    return result;
  }

  /** Drop the current utterance (not speech after all, or already handled). */
  cancel(utt) {
    if (utt == null || utt !== this._utt) return;
    this._utt = null;
    this._send({ type: 'cancel', utt });
  }

  stop() {
    this._stopping = true;
    clearTimeout(this._retryTimer);
    this._stopHeartbeat();
    const ws = this._ws;
    if (ws) { try { ws.close(); } catch {} }
    else this._setState(this.configured ? 'off' : 'unconfigured');
  }
}
