/**
 * Tests for POST /api/voice/text — the HTTP/IPC fallback that runs the same
 * gate pipeline as the WebSocket voice_text path.
 *
 * Uses the real Express router (createApiRouter) with a minimal wsProxy mock
 * so no sockets or full server are required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApiRouter } from './routes/api.js';

async function withServer(wsProxy, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    wsProxy,
    logTailer: {},
    libraryScanner: {},
    voqalHomePath: '/tmp',
  }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

test('POST /api/voice/text: 400 when text missing', async () => {
  const proxy = { handleVoiceText: async () => [] };
  await withServer(proxy, async (base) => {
    const res = await fetch(`${base}/voice/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('POST /api/voice/text: 400 when text is blank', async () => {
  const proxy = { handleVoiceText: async () => [] };
  await withServer(proxy, async (base) => {
    const res = await fetch(`${base}/voice/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/voice/text: returns events array from wsProxy.handleVoiceText', async () => {
  const fakeEvents = [
    { type: 'voice_transcription', text: 'scroll down', confidence: 0.9, latency: 1, timestamp: new Date().toISOString() },
    { type: 'chat_assistant_message', text: 'Done.', error: false, toolCalls: null, provider: 'fast', model: 'pattern-match', latency: 5, source: 'voice', silent: true, timestamp: new Date().toISOString() },
  ];
  let capturedText, capturedConf;
  const proxy = {
    handleVoiceText: async (text, confidence) => {
      capturedText = text;
      capturedConf = confidence;
      return fakeEvents;
    }
  };

  await withServer(proxy, async (base) => {
    const res = await fetch(`${base}/voice/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'scroll down', confidence: 0.9 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.events, fakeEvents);
    assert.equal(capturedText, 'scroll down');
    assert.equal(capturedConf, 0.9);
  });
});

test('POST /api/voice/text: passes null confidence when omitted', async () => {
  let capturedConf;
  const proxy = {
    handleVoiceText: async (_text, confidence) => {
      capturedConf = confidence;
      return [];
    }
  };

  await withServer(proxy, async (base) => {
    const res = await fetch(`${base}/voice/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'open chrome' }),
    });
    assert.equal(res.status, 200);
    assert.equal(capturedConf, null);
  });
});

test('POST /api/voice/text: 500 when handleVoiceText throws', async () => {
  const proxy = {
    handleVoiceText: async () => { throw new Error('boom'); }
  };

  await withServer(proxy, async (base) => {
    const res = await fetch(`${base}/voice/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'scroll down' }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'boom');
  });
});
