/**
 * Settings API — the API keys and AI provider this device uses, saved to its
 * own .env file so the dashboard's Settings page can replace editing it by hand.
 *
 *   GET    /api/settings/keys             which keys are set (masked), where they are saved
 *   PUT    /api/settings/keys/:provider   check a key with its provider, then save it
 *   DELETE /api/settings/keys/:provider   remove a key
 *   POST   /api/settings/provider         switch provider/model and remember the choice
 *
 * Saved keys apply immediately: the AI engine and voice transcription read
 * process.env on every call, and this router updates process.env after the
 * file is written. A key the provider rejects is never saved.
 *
 * Every route is local-only. The server allows cross-origin requests
 * (cors()), so without this guard any web page open in the student's browser
 * could overwrite or delete keys. Requests must come from this machine,
 * address localhost, and — if they carry an Origin — come from a localhost
 * page. Origin "null" (sandboxed iframes) is refused too.
 */

import { Router } from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { maskSecret, readEnvFile, removeEnvValue, setEnvValue, writeEnvFile } from '../env-file.js';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** electron-main.cjs sets ABLESPEAK_ENV_PATH (AppData for a packaged install); dev falls back to server/.env. */
export function defaultEnvPath() {
  return process.env.ABLESPEAK_ENV_PATH || join(SERVER_ROOT, '.env');
}

// Speech-to-text always uses Gemini, whichever chat provider is active (voice-handler.js).
const VOICE_KEY = 'GEMINI_API_KEY';
const AZURE_ENDPOINT = 'AZURE_OPENAI_ENDPOINT';
const AZURE_DEPLOYMENT = 'AZURE_OPENAI_DEPLOYMENT';

const KEY_RE = /^[A-Za-z0-9._~+/-]{8,512}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const DEPLOYMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

const KEY_PAGES = {
  gemini: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  groq: 'https://console.groq.com/keys',
  azure: 'https://portal.azure.com/',
};

const CHECKS = {
  gemini: key => ({ url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}` }),
  openai: key => ({ url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } }),
  groq: key => ({ url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${key}` } }),
  anthropic: key => ({
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  }),
};

/**
 * Ask the provider whether it accepts the key. verified is true (accepted),
 * false (rejected — do not save) or null (could not tell — save unchecked).
 */
export async function checkKeyWithProvider(provider, key, name = provider) {
  const spec = CHECKS[provider]?.(key);
  if (!spec) return { verified: null, message: `${name} keys can't be checked from here.` };
  try {
    const res = await fetch(spec.url, { headers: spec.headers || {}, signal: AbortSignal.timeout(8000) });
    if (res.ok) return { verified: true, message: `${name} accepted the key.` };
    if ([400, 401, 403].includes(res.status)) {
      return { verified: false, message: `${name} rejected this key (HTTP ${res.status}). Check you copied all of it.` };
    }
    return { verified: null, message: `${name} couldn't confirm the key right now (HTTP ${res.status}), so it was saved unchecked.` };
  } catch {
    return { verified: null, message: `${name} couldn't be reached to check the key, so it was saved unchecked.` };
  }
}

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1']);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function localOnly(req, res, next) {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const origin = req.headers.origin;
  const fromThisComputer = LOOPBACK_IPS.has(ip)
    && LOOPBACK_HOST.test(req.headers.host || '')
    && (origin === undefined || LOOPBACK_ORIGIN.test(origin));
  if (!fromThisComputer) {
    return res.status(403).json({ error: 'Settings can only be changed from the AbleSpeak dashboard on this computer.' });
  }
  next();
}

function isHttpsUrl(value) {
  if (/[\s#"'\\]/.test(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function createSettingsRouter({ aiEngine, envPath = defaultEnvPath, verifyKey = checkKeyWithProvider }) {
  const router = Router();
  router.use(localOnly);

  const resolvePath = () => (typeof envPath === 'function' ? envPath() : envPath);

  function keyProviders() {
    return Object.entries(aiEngine.getAvailableProviders()).filter(([, p]) => p.envKey);
  }

  function findProvider(id) {
    return keyProviders().find(([key]) => key === id);
  }

  /** Write the file first; only then change the running process. */
  function persist(updates) {
    const path = resolvePath();
    let text = readEnvFile(path);
    for (const [name, value] of Object.entries(updates)) {
      text = value === null ? removeEnvValue(text, name) : setEnvValue(text, name, value);
    }
    writeEnvFile(path, text);
    for (const [name, value] of Object.entries(updates)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
  }

  function describe() {
    const status = aiEngine.getStatus();
    const providers = keyProviders().map(([id, p]) => ({
      id,
      name: p.name,
      envKey: p.envKey,
      configured: Boolean(process.env[p.envKey]),
      masked: process.env[p.envKey] ? maskSecret(process.env[p.envKey]) : null,
      active: id === status.provider,
      usedForVoice: p.envKey === VOICE_KEY,
      keyPage: KEY_PAGES[id] || null,
      ...(id === 'azure'
        ? { endpoint: process.env[AZURE_ENDPOINT] || '', deployment: process.env[AZURE_DEPLOYMENT] || '' }
        : {}),
    }));
    providers.sort((a, b) => Number(b.usedForVoice) - Number(a.usedForVoice));
    return {
      envPath: resolvePath(),
      voiceReady: Boolean(process.env[VOICE_KEY]),
      active: { provider: status.provider, name: status.providerName, model: status.model, configured: status.configured },
      providers,
    };
  }

  router.get('/keys', (req, res) => res.json(describe()));

  router.put('/keys/:provider', async (req, res) => {
    const entry = findProvider(req.params.provider);
    if (!entry) return res.status(404).json({ error: `Unknown provider: ${req.params.provider}` });
    const [id, config] = entry;

    const key = String(req.body?.key ?? '').trim();
    if (!KEY_RE.test(key)) {
      return res.status(400).json({ error: "That doesn't look like an API key. Paste the whole key, with no spaces." });
    }
    const updates = { [config.envKey]: key };

    if (id === 'azure') {
      const endpoint = String(req.body?.endpoint ?? '').trim();
      const deployment = String(req.body?.deployment ?? '').trim();
      if (!isHttpsUrl(endpoint)) {
        return res.status(400).json({ error: 'Azure OpenAI also needs its endpoint, starting with https://' });
      }
      if (deployment && !DEPLOYMENT_RE.test(deployment)) {
        return res.status(400).json({ error: 'The deployment name can only use letters, numbers, dots, dashes and underscores.' });
      }
      updates[AZURE_ENDPOINT] = endpoint;
      updates[AZURE_DEPLOYMENT] = deployment || null;
    }

    const check = await verifyKey(id, key, config.name);
    if (check.verified === false) {
      return res.status(400).json({ error: check.message, verified: false });
    }

    const hadWorkingProvider = aiEngine.getStatus().configured;
    try {
      persist(updates);
    } catch (err) {
      return res.status(500).json({ error: `Couldn't save the key to ${resolvePath()}: ${err.message}` });
    }

    // First usable key on this device: start using it rather than leaving a
    // provider with no key selected.
    let switchedTo = null;
    if (!hadWorkingProvider) {
      aiEngine.setProvider(id, config.defaultModel);
      try {
        persist({ LLM_PROVIDER: id, LLM_MODEL: null });
      } catch { /* the switch still applies until restart */ }
      switchedTo = config.name;
    }

    const message = ['Saved.', check.message, switchedTo ? `AbleSpeak now uses ${switchedTo}.` : '']
      .filter(Boolean).join(' ');
    res.json({ ok: true, verified: check.verified, switchedTo, message, ...describe() });
  });

  router.delete('/keys/:provider', (req, res) => {
    const entry = findProvider(req.params.provider);
    if (!entry) return res.status(404).json({ error: `Unknown provider: ${req.params.provider}` });
    const [id, config] = entry;

    const updates = { [config.envKey]: null };
    if (id === 'azure') Object.assign(updates, { [AZURE_ENDPOINT]: null, [AZURE_DEPLOYMENT]: null });
    const wasActive = aiEngine.getStatus().provider === id;
    try {
      persist(updates);
    } catch (err) {
      return res.status(500).json({ error: `Couldn't update ${resolvePath()}: ${err.message}` });
    }

    const notes = [`Removed the ${config.name} key.`];
    if (config.envKey === VOICE_KEY) notes.push("Voice won't work until a Gemini key is added again.");
    if (wasActive) notes.push(`${config.name} is still selected, so AbleSpeak can't answer until you add a key or switch provider.`);
    res.json({ ok: true, message: notes.join(' '), ...describe() });
  });

  router.post('/provider', (req, res) => {
    const provider = String(req.body?.provider ?? '');
    const available = aiEngine.getAvailableProviders();
    const config = available[provider];
    if (!config) return res.status(400).json({ error: `Unknown provider: ${provider}` });

    const model = String(req.body?.model ?? '').trim() || config.defaultModel;
    if (!MODEL_RE.test(model)) return res.status(400).json({ error: 'That model name is not valid.' });
    if (config.envKey && !process.env[config.envKey]) {
      return res.status(400).json({ error: `Add your ${config.name} key first.` });
    }

    let result;
    try {
      result = aiEngine.setProvider(provider, model);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      persist({ LLM_PROVIDER: result.provider, LLM_MODEL: result.model });
    } catch (err) {
      return res.json({
        ok: true, saved: false, ...result,
        message: `AbleSpeak now uses ${result.name} (${result.model}), but the choice couldn't be saved and will reset on restart: ${err.message}`,
      });
    }
    res.json({ ok: true, saved: true, ...result, message: `AbleSpeak now uses ${result.name} (${result.model}).` });
  });

  return router;
}
