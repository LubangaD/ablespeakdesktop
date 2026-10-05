/**
 * AbleSpeak Voice Handler
 * 
 * Transcribes audio using Google Gemini's native audio understanding.
 * Includes rate limiting to stay within Gemini's free-tier limits
 * (15 RPM for gemini-2.0-flash).
 */

// Whole sentences Gemini has been seen to invent for audio with no clear
// speech (seen 16 Sep 2026 on long background-noise recordings). Matched as a
// full pattern so a student can still dictate "I can't make it to the meeting".
const INVENTED_SENTENCES = [
  /going to go ahead and say that .{0,20}not going to be able to make it/i,
];

// Codes Node's fetch reports when the computer can't reach Google at all
// (no network, no DNS, Wi-Fi dropped), as opposed to Google answering badly.
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);
const REQUEST_TIMEOUT_MS = 12000;
export const OFFLINE_MESSAGE = 'AbleSpeak needs the internet right now. I’ll reconnect automatically.';

/** Whether a fetch failure means the internet (or Google) can't be reached. */
export function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = err.cause?.code || err.code;
  if (code && NETWORK_CODES.has(code)) return true;
  return /fetch failed/i.test(err.message || '');
}

export function isInventedTranscript(text) {
  return INVENTED_SENTENCES.some(pattern => pattern.test(String(text || '')));
}

const BASE_PROMPT = 'Transcribe this audio clip. Rules:\n1. Return ONLY the exact words spoken by a human voice. No quotes, no explanations.\n2. If you hear SILENCE, background noise, music, humming, or any non-speech audio, return exactly: SILENCE\n3. Do NOT invent or hallucinate text. If you are unsure whether speech was spoken, return SILENCE.\n4. Common hallucinations to avoid: "The quick brown fox", "I\'m not sure if", "Thank you for watching", generic sentences about meetings or weather.\n5. Only transcribe clear, intentional human speech directed at a microphone.';

/**
 * The transcription instructions, with the speaker's own words when known.
 * The words only guide spelling; they must never be returned unless spoken.
 */
export function transcriptionPrompt(vocabulary = []) {
  const words = (Array.isArray(vocabulary) ? vocabulary : [])
    .map(word => String(word).replace(/[\r\n"]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 100);
  if (!words.length) return BASE_PROMPT;
  return `${BASE_PROMPT}\n6. This speaker often says these names and words. When you hear one, spell it exactly like this: ${words.join(', ')}. Do not include them unless they were said.`;
}

export class VoiceHandler {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    // Voice transcription ALWAYS uses Gemini (audio understanding), so only
    // honor LLM_MODEL if the main provider is Gemini too. Empty/"auto" → default.
    const envVoice = (process.env.VOICE_MODEL || '').trim();
    const envLlm = (process.env.LLM_MODEL || '').trim();
    this.model = envVoice
      || (process.env.LLM_PROVIDER === 'gemini' && envLlm && envLlm.toLowerCase() !== 'auto' ? envLlm : '')
      || 'gemini-2.5-flash';
    this._modelResolved = false; // becomes true after a successful call or fallback resolution

    // Rate limiting: track request timestamps
    this._requestTimes = [];
    this._maxRequestsPerMinute = 12; // Stay under Gemini's 15 RPM limit
    this._minIntervalMs = 3000;      // Minimum 3s between requests
    this._lastRequestTime = 0;
  }

  // A key passed to the constructor wins. Otherwise read the environment on
  // every call, so a Gemini key saved from the Settings page works at once.
  get apiKey() {
    return this._apiKey || process.env.GEMINI_API_KEY;
  }

  set apiKey(value) {
    this._apiKey = value || null;
  }

  /**
   * Check if we can make a request without hitting rate limits.
   * If not, returns the wait time in ms.
   */
  _getRateLimitDelay() {
    const now = Date.now();
    
    // Enforce minimum interval between requests
    const timeSinceLast = now - this._lastRequestTime;
    if (timeSinceLast < this._minIntervalMs) {
      return this._minIntervalMs - timeSinceLast;
    }

    // Enforce RPM limit
    const oneMinuteAgo = now - 60000;
    this._requestTimes = this._requestTimes.filter(t => t > oneMinuteAgo);
    if (this._requestTimes.length >= this._maxRequestsPerMinute) {
      const oldestInWindow = this._requestTimes[0];
      return (oldestInWindow + 60000) - now + 100; // Wait until oldest expires + 100ms buffer
    }

    return 0;
  }

  _recordRequest() {
    const now = Date.now();
    this._requestTimes.push(now);
    this._lastRequestTime = now;
  }

  /**
   * The configured model was retired (404) — query Gemini's live model list
   * and pick the newest stable flash model that supports generateContent.
   */
  async _resolveFallbackModel() {
    try {
      const res = await fetch(`${this.baseUrl}/models?key=${this.apiKey}&pageSize=200`);
      if (!res.ok) return null;
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''))
        .filter(m => !/(preview|exp|thinking|image|tts|live|audio|embedding|robotics|aqa|learnlm)/i.test(m));

      const byVersionDesc = (a, b) => {
        const v = s => { const m = s.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
        return v(b) - v(a);
      };

      const flash = models.filter(m => /^gemini-[\d.]+-flash$/.test(m)).sort(byVersionDesc);
      const anyFlash = models.filter(m => /flash/.test(m)).sort(byVersionDesc);
      return flash[0] || anyFlash[0] || models.sort(byVersionDesc)[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Transcribe base64-encoded audio using Gemini.
   * `vocabulary`: names and words this speaker uses, spelled as they should
   * appear (Stage 1 per-student vocabulary).
   */
  async transcribe(audioBase64, mimeType = 'audio/webm', { vocabulary = [] } = {}) {
    if (!this.apiKey) {
      return { text: '', error: 'GEMINI_API_KEY not configured' };
    }

    // Strip codec params: 'audio/webm;codecs=opus' → 'audio/webm'
    const cleanMimeType = mimeType.split(';')[0].trim();

    // Reject tiny audio (silence/noise from continuous recording)
    if (!audioBase64 || audioBase64.length < 4000) {
      return { text: '', error: 'no_speech' };
    }

    // Check rate limit
    const delay = this._getRateLimitDelay();
    if (delay > 0) {
      console.log(`[VoiceHandler] Rate limited — waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }

    const audioSizeKB = Math.round(audioBase64.length / 1024);
    
    // Try up to 2 times (initial + 1 retry)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this._recordRequest();
        console.log(`[VoiceHandler] Transcribing ${audioSizeKB}KB (${cleanMimeType})${attempt > 0 ? ' [retry]' : ''}`);

        const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), // a half-dead connection must not hang the turn
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  inlineData: {
                    mimeType: cleanMimeType,
                    data: audioBase64,
                  }
                },
                {
                  text: transcriptionPrompt(vocabulary),
                }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 256,
            }
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

          // ── SILENCE marker handling ──
          // The prompt asks Gemini to return exactly "SILENCE" for non-speech
          // audio. In practice it sometimes wraps that marker around invented
          // filler instead of returning it alone — e.g. "SILENCE\nI'm going to
          // go ahead and say...\nSILENCE" — which slipped past the old exact-
          // match check below and the KNOWN_HALLUCINATIONS list, since the
          // filler text itself isn't a known phrase. The marker is still a
          // reliable signal that Gemini flagged this clip as non-speech, so:
          // strip it from the edges, then only keep what's left if it's short
          // enough to plausibly be a real, terse command that had noise on
          // either side. Long leftover text means the model is still
          // hallucinating even though it also emitted the marker.
          const hadSilenceMarker = /\bsilence\b/i.test(rawText);
          const text = rawText
            .replace(/^\s*silence\b[.,!]?\s*/i, '')
            .replace(/\s*\bsilence\b[.,!]?\s*$/i, '')
            // Gemini sometimes repeats its own instructions after the words
            .replace(/\s*\b(transcribe this audio clip|return only the exact words)\b[^\n]*/gi, '')
            .trim();

          if (!text) {
            return { text: '', error: 'no_speech' };
          }

          if (hadSilenceMarker && text.split(/\s+/).length > 8) {
            console.log(`[VoiceHandler] Filtered hallucination (SILENCE-wrapped): "${rawText.slice(0, 80)}"`);
            return { text: '', error: 'no_speech' };
          }

          // Post-processing: catch common Gemini hallucinations
          // These are generic English sentences Gemini invents when it hears noise
          const lower = text.toLowerCase();
          const KNOWN_HALLUCINATIONS = [
            'i\'m not sure if i\'m going to',
            'i don\'t know what to say',
            'the quick brown fox',
            'thank you for watching',
            'please subscribe',
            'i\'m going to be late',
            'i\'ll be right back',
            'i have to go now',
            'can you hear me',
            'is anybody there',
            'hello is anyone there',
          ];
          if (KNOWN_HALLUCINATIONS.some(h => lower.includes(h)) || isInventedTranscript(text)) {
            console.log(`[VoiceHandler] Filtered hallucination: "${text}"`);
            return { text: '', error: 'no_speech' };
          }

          console.log(`[VoiceHandler] Transcribed: "${text}"`);
          return { text };
        }

        // Handle errors
        const status = response.status;
        const errorBody = await response.text().catch(() => '');

        // Model retired/renamed → resolve a live replacement and retry immediately
        if (status === 404 && !this._modelResolved) {
          console.warn(`[VoiceHandler] Model "${this.model}" unavailable (404) — finding replacement...`);
          const replacement = await this._resolveFallbackModel();
          if (replacement && replacement !== this.model) {
            console.log(`[VoiceHandler] Switched transcription model to: ${replacement}`);
            this.model = replacement;
            this._modelResolved = true;
            attempt--; // don't consume a retry for the model swap
            continue;
          }
        }

        if (status === 429 || status === 400) {
          // Rate limit or transient error — retry after backoff
          const backoff = (attempt + 1) * 3000;
          console.log(`[VoiceHandler] ${status} error — retrying in ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        // Non-retryable error
        console.error(`[VoiceHandler] Gemini ${status}: ${errorBody.substring(0, 200)}`);
        return { text: '', error: `Transcription failed: ${status}` };

      } catch (err) {
        const offline = isNetworkError(err);
        console.error(`[VoiceHandler] Transcription error${offline ? ' (no connection)' : ''}:`, err.message);
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 2000)); // ride out a short blip
          continue;
        }
        // Say plainly that the connection is down, so nobody repeats themselves for nothing.
        if (offline) return { text: '', error: 'offline', message: OFFLINE_MESSAGE };
        return { text: '', error: err.message };
      }
    }

    return { text: '', error: 'Transcription failed after retries' };
  }
}
