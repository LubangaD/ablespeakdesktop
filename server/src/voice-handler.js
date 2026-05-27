/**
 * AbleSpeak Voice Handler
 * 
 * Transcribes audio using Google Gemini's native audio understanding.
 * Receives base64-encoded audio from the dashboard, sends to Gemini,
 * returns the transcription text.
 */

export class VoiceHandler {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  }

  /**
   * Transcribe base64-encoded audio using Gemini
   * @param {string} audioBase64 - Base64-encoded audio data
   * @param {string} mimeType - Audio MIME type (e.g. 'audio/webm', 'audio/wav')
   * @returns {Promise<{text: string, error?: string}>}
   */
  async transcribe(audioBase64, mimeType = 'audio/webm') {
    if (!this.apiKey) {
      return { text: '', error: 'GEMINI_API_KEY not configured' };
    }

    try {
      const url = `${this.baseUrl}/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: audioBase64,
                }
              },
              {
                text: 'Transcribe this audio to text. Return ONLY the exact words spoken, nothing else. No quotes, no explanations, no formatting. If no speech is detected, return the word SILENCE.'
              }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 256,
          }
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[VoiceHandler] Gemini error:', response.status, errorBody);
        return { text: '', error: `Gemini API error: ${response.status}` };
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

      if (text === 'SILENCE' || text === '') {
        return { text: '', error: 'no_speech' };
      }

      console.log(`[VoiceHandler] Transcribed: "${text}"`);
      return { text };
    } catch (err) {
      console.error('[VoiceHandler] Transcription error:', err.message);
      return { text: '', error: err.message };
    }
  }
}
