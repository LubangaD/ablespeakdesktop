/**
 * Tests for the Settings API (API keys and provider choice).
 * Run with:  node --test src/settings-routes.test.mjs
 *
 * Uses a real express app on a random local port, a real AIEngine, a temp
 * .env file and a fake key checker — no network calls.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AIEngine } from './ai-engine.js';
import { createSettingsRouter, defaultEnvPath } from './routes/settings.js';

const MANAGED = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT',
  'LLM_PROVIDER', 'LLM_MODEL',
];
const saved = Object.fromEntries(MANAGED.map(k => [k, process.env[k]]));

let dir, envPath, server, port, engine;
let verdict = { verified: true, message: 'Checked.' };

function clearEnv() {
  for (const k of MANAGED) delete process.env[k];
}

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: {
        Host: `localhost:${port}`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const envText = () => (existsSync(envPath) ? readFileSync(envPath, 'utf8') : '');

before(async () => {
  clearEnv();
  dir = mkdtempSync(join(tmpdir(), 'ablespeak-settings-'));
  envPath = join(dir, '.env');
  engine = new AIEngine({ toolRegistry: { getToolsForContext: () => [] }, wsHub: null });
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRouter({
    aiEngine: engine,
    envPath: () => envPath,
    verifyKey: async () => verdict,
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  port = server.address().port;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  clearEnv();
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

beforeEach(() => {
  clearEnv();
  rmSync(envPath, { force: true });
  engine.provider = 'openai';
  engine.model = 'gpt-4o-mini';
  verdict = { verified: true, message: 'Checked.' };
});

test('lists every provider that needs a key, Gemini first, with nothing set', async () => {
  const { status, body } = await request('GET', '/api/settings/keys');
  assert.equal(status, 200);
  assert.equal(body.envPath, envPath);
  assert.equal(body.voiceReady, false);
  assert.equal(body.providers[0].id, 'gemini');
  assert.equal(body.providers[0].usedForVoice, true);
  assert.deepEqual(body.providers.map(p => p.id).sort(), ['anthropic', 'azure', 'gemini', 'groq', 'openai']);
  assert.ok(body.providers.every(p => p.configured === false && p.masked === null));
});

test('saving a key writes the file, applies at once, and never echoes the key', async () => {
  writeFileSync(envPath, '# my notes\nOTHER=1\n');
  const key = 'AIzaSyTESTKEY000000001234';
  const { status, body } = await request('PUT', '/api/settings/keys/gemini', { body: { key } });
  assert.equal(status, 200);
  assert.equal(process.env.GEMINI_API_KEY, key);
  assert.ok(envText().startsWith('# my notes\nOTHER=1\n'));
  assert.ok(envText().includes(`GEMINI_API_KEY=${key}\n`));
  assert.ok(!JSON.stringify(body).includes(key), 'the full key must not come back');
  const gemini = body.providers.find(p => p.id === 'gemini');
  assert.equal(gemini.masked, '••••1234');
  assert.equal(body.voiceReady, true);
});

test('the first working key becomes the active provider and is remembered', async () => {
  const { body } = await request('PUT', '/api/settings/keys/gemini', { body: { key: 'AIzaSyTESTKEY000000001234' } });
  assert.equal(body.switchedTo, 'Google Gemini');
  assert.equal(engine.provider, 'gemini');
  assert.ok(envText().includes('LLM_PROVIDER=gemini\n'));
  assert.ok(!envText().includes('LLM_MODEL='), 'the model is left to the provider default');
  assert.match(body.message, /now uses Google Gemini/);
});

test('a key for another provider does not change a working provider', async () => {
  process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY000000001234';
  engine.provider = 'gemini';
  const { body } = await request('PUT', '/api/settings/keys/openai', { body: { key: 'sk-test-000000000000abcd' } });
  assert.equal(body.switchedTo, null);
  assert.equal(engine.provider, 'gemini');
});

test('a key the provider rejects is not saved', async () => {
  verdict = { verified: false, message: 'Google Gemini rejected this key (HTTP 400).' };
  const { status, body } = await request('PUT', '/api/settings/keys/gemini', { body: { key: 'AIzaSyWRONG0000000000000' } });
  assert.equal(status, 400);
  assert.match(body.error, /rejected/);
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  assert.equal(envText(), '');
});

test('a key that could not be checked is saved, and says so', async () => {
  verdict = { verified: null, message: "Google Gemini couldn't be reached to check the key, so it was saved unchecked." };
  const { status, body } = await request('PUT', '/api/settings/keys/gemini', { body: { key: 'AIzaSyTESTKEY000000001234' } });
  assert.equal(status, 200);
  assert.equal(body.verified, null);
  assert.match(body.message, /saved unchecked/);
});

test('malformed keys are refused, including attempts to inject settings', async () => {
  for (const key of ['', 'short', 'has space inside key', 'AIzaGOOD\nLLM_PROVIDER=evil', 'key#comment00']) {
    const { status } = await request('PUT', '/api/settings/keys/gemini', { body: { key } });
    assert.equal(status, 400, `should refuse ${JSON.stringify(key)}`);
  }
  assert.equal(envText(), '');
});

test('Azure needs an https endpoint and saves it with the key', async () => {
  const bad = await request('PUT', '/api/settings/keys/azure', { body: { key: '0123456789abcdef0123' } });
  assert.equal(bad.status, 400);
  const ok = await request('PUT', '/api/settings/keys/azure', {
    body: { key: '0123456789abcdef0123', endpoint: 'https://example.openai.azure.com', deployment: 'gpt-4o-mini' },
  });
  assert.equal(ok.status, 200);
  assert.ok(envText().includes('AZURE_OPENAI_ENDPOINT=https://example.openai.azure.com\n'));
  assert.ok(envText().includes('AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini\n'));
});

test('removing a key clears the file and the running process', async () => {
  writeFileSync(envPath, 'GEMINI_API_KEY=AIzaSyTESTKEY000000001234\nOTHER=1\n');
  process.env.GEMINI_API_KEY = 'AIzaSyTESTKEY000000001234';
  const { status, body } = await request('DELETE', '/api/settings/keys/gemini');
  assert.equal(status, 200);
  assert.equal(envText(), 'OTHER=1\n');
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  assert.match(body.message, /Voice won't work/);
});

test('switching provider is applied and remembered', async () => {
  process.env.GROQ_API_KEY = 'gsk_test000000000000';
  const { status, body } = await request('POST', '/api/settings/provider', {
    body: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  });
  assert.equal(status, 200);
  assert.equal(body.saved, true);
  assert.equal(engine.provider, 'groq');
  assert.ok(envText().includes('LLM_PROVIDER=groq\n'));
  assert.ok(envText().includes('LLM_MODEL=llama-3.3-70b-versatile\n'));
});

test('switching to a provider with no key, or an unknown one, is refused', async () => {
  const noKey = await request('POST', '/api/settings/provider', { body: { provider: 'anthropic' } });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error, 'Add your Anthropic Claude key first.');
  const unknown = await request('POST', '/api/settings/provider', { body: { provider: 'nope' } });
  assert.equal(unknown.status, 400);
  assert.equal(engine.provider, 'openai');
});

test('requests from other websites are refused', async () => {
  for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.example']) {
    const { status } = await request('PUT', '/api/settings/keys/gemini', {
      body: { key: 'AIzaSyTESTKEY000000001234' }, headers: { Origin: origin },
    });
    assert.equal(status, 403, `should refuse Origin ${origin}`);
  }
  assert.equal(envText(), '');
});

test('a request addressed to another host name (DNS rebinding) is refused', async () => {
  const { status } = await request('GET', '/api/settings/keys', { headers: { Host: `evil.example:${port}` } });
  assert.equal(status, 403);
});

test('the dashboard served from localhost is allowed', async () => {
  const { status } = await request('GET', '/api/settings/keys', { headers: { Origin: `http://localhost:${port}` } });
  assert.equal(status, 200);
});

test('without an override the key file is server/.env', () => {
  const previous = process.env.ABLESPEAK_ENV_PATH;
  delete process.env.ABLESPEAK_ENV_PATH;
  try {
    assert.match(defaultEnvPath().replace(/\\/g, '/'), /\/server\/\.env$/);
  } finally {
    if (previous !== undefined) process.env.ABLESPEAK_ENV_PATH = previous;
  }
});
