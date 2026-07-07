/**
 * Speech-profile REST tests — real express router over HTTP, temp DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { initDatabase, closeDatabase, upsertStudent } from './db.js';
import { createApiRouter } from './routes/api.js';

function tmpFile(name) {
  return join(tmpdir(), `ablespeak-test-${name}-${Date.now()}.db`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
    try { if (existsSync(p + '.tmp')) unlinkSync(p + '.tmp'); } catch {}
  }
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ wsProxy: {}, logTailer: {}, libraryScanner: {}, voqalHomePath: tmpdir() }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

test('speech-profile REST: GET/PUT roundtrip, validation, 404s', async () => {
  const path = tmpFile('speech-api');
  try {
    await initDatabase(path);
    upsertStudent({ id: 'stu-1', display_name: 'Alice', external_ref: null });

    await withServer(async (base) => {
      // GET unknown student → 404
      let res = await fetch(`${base}/students/nope/speech-profile`);
      assert.equal(res.status, 404);

      // GET existing student → defaults
      res = await fetch(`${base}/students/stu-1/speech-profile`);
      assert.equal(res.status, 200);
      let profile = await res.json();
      assert.equal(profile.min_audio_b64, 4000);
      assert.equal(profile.min_confidence, 0.45);
      assert.deepEqual(profile.custom_vocabulary, []);

      // PUT out-of-range values → 400
      const badBodies = [
        { min_audio_b64: 100 },              // below 500
        { min_audio_b64: 30000 },            // above 20000
        { min_confidence: 2 },               // above 1
        { min_confidence: -0.1 },            // below 0
        { fuzzy_threshold: 1.5 },            // above 1
        { min_confidence: 'high' },          // wrong type
        { custom_vocabulary: 'not an array' },
        { custom_vocabulary: [1, 2] },       // not strings
        { repair_enabled: 'yes' },           // wrong type
      ];
      for (const body of badBodies) {
        res = await fetch(`${base}/students/stu-1/speech-profile`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }

      // PUT unknown student → 404
      res = await fetch(`${base}/students/nope/speech-profile`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ min_confidence: 0.3 }),
      });
      assert.equal(res.status, 404);

      // PUT valid tuned values → 200 with updated profile
      res = await fetch(`${base}/students/stu-1/speech-profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          min_audio_b64: 1800, min_confidence: 0.3, fuzzy_threshold: 0.45,
          repair_enabled: true, custom_vocabulary: ['open seesaw', 'starfall'],
        }),
      });
      assert.equal(res.status, 200);
      profile = await res.json();
      assert.equal(profile.min_audio_b64, 1800);
      assert.equal(profile.min_confidence, 0.3);
      assert.equal(profile.fuzzy_threshold, 0.45);
      assert.equal(profile.repair_enabled, 1);
      assert.deepEqual(profile.custom_vocabulary, ['open seesaw', 'starfall']);

      // Values persist — next GET (i.e. next interaction) sees them immediately
      res = await fetch(`${base}/students/stu-1/speech-profile`);
      profile = await res.json();
      assert.equal(profile.min_audio_b64, 1800);
      assert.deepEqual(profile.custom_vocabulary, ['open seesaw', 'starfall']);

      // Partial update keeps other fields (COALESCE upsert)
      res = await fetch(`${base}/students/stu-1/speech-profile`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ min_confidence: 0.1 }),
      });
      assert.equal(res.status, 200);
      profile = await res.json();
      assert.equal(profile.min_confidence, 0.1);
      assert.equal(profile.min_audio_b64, 1800, 'untouched fields survive partial update');
    });
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});
