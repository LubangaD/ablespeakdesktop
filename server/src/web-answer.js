/**
 * Questions answered from a live Google search, like Google's AI mode: Gemini
 * with Grounding with Google Search writes a short spoken answer from what
 * the search found, with its sources. One call, ~2.5 s ("who is Derrick
 * Lubanga" took 6.5 s and came out thin when AbleSpeak opened Google in the
 * browser and read the results page).
 *
 * Google's terms for grounded answers: shown only to the person who asked,
 * with their Search Suggestions (`suggestions`, the Google chip linking to
 * the search) and not changed or mixed with other content. The overlay and
 * the dashboard show both. Billing (2.5 models): 1,500 grounded prompts a
 * day free, then $35 per 1,000.
 */
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';

const INSTRUCTIONS = [
  'You answer questions for a student who listens to the answer instead of reading it.',
  'Search Google for what is asked, and answer from what you find.',
  'Reply in 2 to 4 short spoken sentences, in plain words: no lists, no headings, no markdown, no web addresses.',
  'If the search does not answer it, say so in one sentence. Never make anything up.',
].join('\n');

/** The site a source came from, as Google names it ("raeng.org.uk"). */
const siteOf = chunk => String(chunk?.web?.title || '').trim();

/**
 * → { status: 'success', text, message, sources: [{ title, url }], queries,
 *     suggestions: { html, queries }, usage } or { status: 'error', message }.
 */
export async function webAnswer(question, {
  apiKey = process.env.GEMINI_API_KEY, model = DEFAULT_MODEL, fetchImpl = fetch, timeoutMs = 10000, today = new Date(),
} = {}) {
  const asked = String(question || '').trim();
  if (!asked) return { status: 'error', message: 'What should I look up?' };
  if (!apiKey) return { status: 'error', message: 'Web answers need the Gemini key, which isn’t set.' };
  const started = Date.now();
  let data;
  try {
    const res = await fetchImpl(`${API}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: `${INSTRUCTIONS}\nToday is ${today.toDateString()}.` }] },
        contents: [{ role: 'user', parts: [{ text: asked }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 400, ...(/^gemini-2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
      }),
    });
    data = await res.json().catch(() => null);
    if (!res.ok) {
      console.warn(`[WebAnswer] Gemini answered ${res.status}: ${JSON.stringify(data?.error?.message || '').slice(0, 160)}`);
      return { status: 'error', message: 'I couldn’t search for that right now.' };
    }
  } catch (err) {
    return { status: 'error', message: err?.name === 'TimeoutError' ? 'The search took too long.' : 'I couldn’t reach Google to search.' };
  }
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) return { status: 'error', message: 'The search didn’t find an answer.' };
  const grounding = candidate.groundingMetadata || {};
  const sources = [];
  for (const chunk of grounding.groundingChunks || []) {
    const title = siteOf(chunk);
    if (chunk?.web?.uri && !sources.some(s => s.title === title)) sources.push({ title: title || 'source', url: chunk.web.uri });
  }
  const queries = (grounding.webSearchQueries || []).filter(q => typeof q === 'string');
  const u = data.usageMetadata || {};
  return {
    status: 'success',
    text,
    message: text,
    sources: sources.slice(0, 5),
    queries,
    // Google's Search Suggestions, to be shown with the answer (Gemini API terms)
    suggestions: { html: grounding.searchEntryPoint?.renderedContent || '', queries },
    usage: {
      model, calls: 1, ms: Date.now() - started, searches: queries.length ? 1 : 0,
      input: (u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0),
      cached: u.cachedContentTokenCount || 0, output: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0, audio: 0,
    },
  };
}
