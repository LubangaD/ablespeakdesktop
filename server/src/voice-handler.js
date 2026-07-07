/**
 * AbleSpeak Voice Handler
 * 
 * Transcribes audio using Google Gemini's native audio understanding.
 * Includes rate limiting to stay within Gemini's free-tier limits
 * (15 RPM for gemini-2.0-flash).
 */

import { checkAudioFloor, parseVocabulary } from './speech-tuning.js';

export class VoiceHandler {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    this.model = process.env.VOICE_MODEL || process.env.LLM_MODEL || 'gemini-2.0-flash';
    
    // Rate limiting: track request timestamps
    this._requestTimes = [];
    this._maxRequestsPerMinute = 12; // Stay under Gemini's 15 RPM limit
    this._minIntervalMs = 3000;      // Minimum 3s between requests
    this._lastRequestTime = 0;
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
   * Transcribe base64-encoded audio using Gemini.
   * profile (optional): per-student speech profile — drives the audio-size
   * floor and biases transcription toward the student's custom vocabulary.
   */
  async transcribe(audioBase64, mimeType = 'audio/webm', profile = null) {
    if (!this.apiKey) {
      return { text: '', error: 'GEMINI_API_KEY not configured' };
    }

    // Strip codec params: 'audio/webm;codecs=opus' → 'audio/webm'
    const cleanMimeType = mimeType.split(';')[0].trim();

    // Reject tiny audio — floor is per-student (defaults to 4000 without a profile)
    const floor = checkAudioFloor(audioBase64 ? audioBase64.length : 0, profile);
    if (!audioBase64 || !floor.pass) {
      return { text: '', error: 'no_speech', reason: 'audio_floor' };
    }

    // Check rate limit
    const delay = this._getRateLimitDelay();
    if (delay > 0) {
      console.log(`[VoiceHandler] Rate limited — waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }

    const audioSizeKB = Math.round(audioBase64.length / 1024);

    // Vocabulary bias: steer Gemini toward the student's known words/commands
    const vocabulary = parseVocabulary(profile?.custom_vocabulary);
    let prompt = 'Transcribe this audio to text. Return ONLY the exact words spoken, nothing else. No quotes, no explanations, no formatting. If no speech is detected, return the word SILENCE.';
    if (vocabulary.length > 0) {
      prompt += ` The speaker may use these words or commands: ${vocabulary.join(', ')}. Prefer them when the audio is ambiguous.`;
    }


    // Try up to 2 times (initial + 1 retry)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this._recordRequest();
        console.log(`[VoiceHandler] Transcribing ${audioSizeKB}KB (${cleanMimeType})${attempt > 0 ? ' [retry]' : ''}`);

        const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
                  text: prompt
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
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

          if (text === 'SILENCE' || text === '') {
            return { text: '', error: 'no_speech', reason: 'no_speech' };
          }

          console.log(`[VoiceHandler] Transcribed: "${text}"`);
          return { text };
        }

        // Handle errors
        const status = response.status;
        const errorBody = await response.text().catch(() => '');
        
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
        console.error('[VoiceHandler] Transcription error:', err.message);
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return { text: '', error: err.message };
      }
    }

    return { text: '', error: 'Transcription failed after retries' };
  }
}
