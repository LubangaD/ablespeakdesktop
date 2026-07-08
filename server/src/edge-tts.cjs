'use strict';

/**
 * AbleSpeak — Minimal Edge (Azure) neural Text-to-Speech client
 * ---------------------------------------------------------------
 * Connects directly to Microsoft's public "read aloud" WebSocket endpoint —
 * the same neural voices used by Microsoft Edge's Read Aloud feature and the
 * `edge-tts` Python package. Free, no API key, no account.
 *
 * Why a hand-rolled client instead of an npm dependency?
 *   - Zero new dependencies: reuses `ws` (already a project dependency) + Node `crypto`.
 *   - Works on ARM64 Windows where native SAPI / Add-Type DllImport can crash.
 *   - The caller (electron-main) always keeps SAPI as an offline fallback, so any
 *     failure here (offline, endpoint change) degrades gracefully.
 *
 * Output is WAV (RIFF PCM) so the existing PowerShell `Media.SoundPlayer`
 * playback path can play it synchronously. (SoundPlayer cannot play MP3.)
 */

const crypto = require('crypto');
const WebSocket = require('ws');
const { writeFile } = require('fs/promises');

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
// Seconds between the Windows epoch (1601-01-01) and the Unix epoch (1970-01-01).
const WIN_EPOCH_OFFSET = 11644473600n;

/**
 * Generate Microsoft's Sec-MS-GEC anti-abuse token.
 * SHA-256 (uppercase hex) of: <windows-filetime-rounded-to-5min><trusted-token>.
 * Uses BigInt because the filetime value (~1.3e17) exceeds Number.MAX_SAFE_INTEGER.
 */
function generateSecMsGec() {
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000));
  let ticks = (unixSeconds + WIN_EPOCH_OFFSET) * 10000000n; // 100-nanosecond intervals
  ticks = ticks - (ticks % 3000000000n); // round down to the nearest 5 minutes
  const toHash = ticks.toString() + TRUSTED_TOKEN;
  return crypto.createHash('sha256').update(toHash, 'ascii').digest('hex').toUpperCase();
}

function isoTimestamp() {
  return new Date().toString().replace(/GMT.*$/, 'GMT+0000 (Coordinated Universal Time)');
}

function escapeSsml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Synthesize `text` with a neural voice and write a WAV file to `outFile`.
 *
 * @param {string} text
 * @param {string} outFile  Absolute path ending in .wav
 * @param {object} [opts]
 * @param {string} [opts.voice='en-US-AriaNeural']
 * @param {string} [opts.rate='+0%']
 * @param {string} [opts.pitch='+0Hz']
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<string>} resolves with outFile on success
 */
function synthesizeToFile(text, outFile, opts = {}) {
  const voice = opts.voice || 'en-US-AriaNeural';
  const rate = opts.rate || '+0%';
  const pitch = opts.pitch || '+0Hz';
  const timeoutMs = opts.timeoutMs || 10000;

  return new Promise((resolve, reject) => {
    const secMsGec = generateSecMsGec();
    const connectId = crypto.randomUUID().replace(/-/g, '');
    const url =
      `${WSS_BASE}?TrustedClientToken=${TRUSTED_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=1-130.0.2849.68` +
      `&ConnectionId=${connectId}`;

    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      },
    });

    const audioChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      reject(new Error('Edge TTS timed out'));
    }, timeoutMs);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    ws.on('open', () => {
      // 1) Speech config: request a RIFF/PCM (WAV) stream.
      const config = {
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat: 'riff-24khz-16bit-mono-pcm',
            },
          },
        },
      };
      ws.send(
        `X-Timestamp:${isoTimestamp()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify(config)
      );

      // 2) The SSML payload to synthesize.
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${voice}'>` +
        `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapeSsml(text)}</prosody>` +
        `</voice></speak>`;
      ws.send(
        `X-RequestId:${connectId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${isoTimestamp()}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary || Buffer.isBuffer(data)) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        // Text frames may arrive as Buffers too; detect by sniffing the header.
        const headerEnd = buf.indexOf('\r\n\r\n');
        const head = headerEnd >= 0 ? buf.slice(0, headerEnd).toString('utf8') : '';
        if (head.includes('Path:turn.end')) {
          finalize();
          return;
        }
        if (head.includes('Path:audio') || /audio\//.test(head)) {
          // Binary audio frame: first 2 bytes = big-endian header length.
          const hdrLen = (buf[0] << 8) | buf[1];
          const audio = buf.slice(2 + hdrLen);
          if (audio.length) audioChunks.push(audio);
          return;
        }
        // Other text-as-buffer frames (turn.start, response) — ignore.
        if (head.includes('Path:turn.start') || head.includes('Path:response')) return;
        return;
      }

      // Text frame (string)
      const msg = data.toString();
      if (msg.includes('Path:turn.end')) finalize();
    });

    async function finalize() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (audioChunks.length === 0) {
        return reject(new Error('Edge TTS returned no audio'));
      }
      try {
        await writeFile(outFile, Buffer.concat(audioChunks));
        resolve(outFile);
      } catch (err) {
        reject(err);
      }
    }

    ws.on('error', fail);
    ws.on('close', (code) => {
      if (!settled) fail(new Error(`Edge TTS socket closed (${code})`));
    });
  });
}

module.exports = { synthesizeToFile, generateSecMsGec };
