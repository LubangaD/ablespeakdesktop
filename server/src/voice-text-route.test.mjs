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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { initDatabase, closeDatabase, getCommands } from './db.js';
import { WsProxy } from './ws-proxy.js';

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

// ── Real WsProxy gate pipeline tests ──

function tmpVtrFile(name) {
  return join(tmpdir(), `ablespeak-vtr-${name}-${Date.now()}.db`);
}

function vtrCleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
    try { if (existsSync(p + '.tmp')) unlinkSync(p + '.tmp'); } catch {}
  }
}

function makeStubAiEngine() {
  return {
    toolRegistry: {
      executeTool: async (toolName) => ({ status: 'success', message: 'stub:' + toolName }),
    },
    getStatus: () => ({}),
  };
}

function makeRealProxy() {
  const fakeServer = new EventEmitter();
  return new WsProxy({ server: fakeServer, aiEngine: makeStubAiEngine() });
}

test('gate pipeline (Test A): low-confidence near-miss emits repair_prompt for "scroll down"', async () => {
  const path = tmpVtrFile('repair-a');
  try {
    await initDatabase(path);
    const proxy = makeRealProxy();
    try {
      // "scoll down" at 0.35 confidence (below 0.45 min) → near-miss repair candidate "scroll down"
      // Empty student roster so picker gate passes through
      const events = await proxy.handleVoiceText('scoll down', 0.35);
      const repairEvt = events.find(e => e.type === 'repair_prompt');
      assert.ok(repairEvt, 'should emit repair_prompt event');
      assert.equal(repairEvt.candidate, 'scroll down', 'repair candidate should be "scroll down"');
    } finally {
      proxy.destroy();
    }
  } finally {
    await closeDatabase();
    vtrCleanup(path);
  }
});

test('gate pipeline (Test B): confirming "yes" executes repaired command path', async () => {
  const path = tmpVtrFile('repair-b');
  try {
    await initDatabase(path);
    const proxy = makeRealProxy();
    try {
      // Step 1: trigger repair state
      await proxy.handleVoiceText('scoll down', 0.35);
      assert.ok(proxy._pendingRepair, '_pendingRepair should be set after near-miss');
      assert.equal(proxy._pendingRepair.candidate, 'scroll down');

      // Step 2: answer "yes" → repair gate fires, executes "scroll down" as repaired command
      const events = await proxy.handleVoiceText('yes', 0.95);
      assert.equal(proxy._pendingRepair, null, '_pendingRepair must be cleared after "yes"');

      // Repair path broadcasts repair_clear then routes through fast-match for "scroll down"
      // (tool='scroll', args={direction:'down'}); stub executeTool returns success.
      // Boundary: insertCommand writes to the commands table with outcome='repaired'.
      const repairClear = events.find(e => e.type === 'repair_clear');
      assert.ok(repairClear, 'should emit repair_clear on confirmation');

      const assistMsg = events.find(e => e.type === 'chat_assistant_message');
      assert.ok(assistMsg, 'should emit chat_assistant_message after executing repaired command');

      // Assert DB: most recent command has outcome='repaired' and prompt_count=1
      const commands = getCommands({ limit: 10 });
      assert.ok(commands.length > 0, 'should have at least one command in DB');
      const repairedCmd = commands[0];
      assert.equal(repairedCmd.outcome, 'repaired', 'repaired command should have outcome="repaired"');
      assert.equal(repairedCmd.prompt_count, 1, 'repaired command should have prompt_count=1');
    } finally {
      proxy.destroy();
    }
  } finally {
    await closeDatabase();
    vtrCleanup(path);
  }
});

test('gate pipeline (Test C): voice_busy returned and _pendingRepair untouched when mutex held', async () => {
  const path = tmpVtrFile('mutex-c');
  try {
    await initDatabase(path);
    const proxy = makeRealProxy();
    try {
      const sentinel = { candidate: 'scroll down', expiresAt: Date.now() + 30000, unclearCount: 0 };
      proxy._pendingRepair = sentinel;
      proxy._voiceProcessing = true;

      const events = await proxy.handleVoiceText('scroll down', 0.9);
      const busyEvt = events.find(e => e.type === 'voice_busy');
      assert.ok(busyEvt, 'should return voice_busy when mutex is held');
      assert.strictEqual(proxy._pendingRepair, sentinel, '_pendingRepair must be the same object (untouched)');
    } finally {
      proxy._voiceProcessing = false;
      proxy.destroy();
    }
  } finally {
    await closeDatabase();
    vtrCleanup(path);
  }
});
