import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import {
  initDatabase, closeDatabase,
  upsertStudent, getStudents,
  getSpeechProfile, saveSpeechProfile,
  insertCommand,
} from './db.js';

const TMP = tmpdir();

function tmpFile(name) {
  return join(TMP, `ablespeak-test-${name}-${Date.now()}.db`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
    try { if (existsSync(p + '.tmp')) unlinkSync(p + '.tmp'); } catch {}
  }
}

// ── (a) Migration is idempotent ──

test('migration is idempotent — init twice on same file, no throw', async () => {
  const path = tmpFile('idempotent');
  try {
    await initDatabase(path);
    await closeDatabase();
    await initDatabase(path);
    await closeDatabase();
  } finally {
    cleanup(path);
  }
});

// ── (b) Student upsert/get roundtrip incl. update path ──

test('upsertStudent and getStudents roundtrip', async () => {
  const path = tmpFile('students');
  try {
    await initDatabase(path);

    upsertStudent({ id: 's1', display_name: 'Alice', external_ref: 'ext-001' });
    const students = getStudents();
    assert.equal(students.length, 1);
    assert.equal(students[0].id, 's1');
    assert.equal(students[0].display_name, 'Alice');
    assert.equal(students[0].external_ref, 'ext-001');
    assert.equal(students[0].active, 1);

    // Update path
    upsertStudent({ id: 's1', display_name: 'Alice B', external_ref: 'ext-001' });
    const updated = getStudents();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].display_name, 'Alice B');
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

test('getStudents activeOnly filters inactive', async () => {
  const path = tmpFile('active');
  try {
    await initDatabase(path);
    upsertStudent({ id: 'a1', display_name: 'Active' });
    upsertStudent({ id: 'i1', display_name: 'Inactive' });
    // manually deactivate i1
    const { getDb } = await import('./db.js');
    getDb().run(`UPDATE students SET active=0 WHERE id='i1'`);

    const active = getStudents({ activeOnly: true });
    assert.equal(active.length, 1);
    assert.equal(active[0].id, 'a1');

    const all = getStudents({ activeOnly: false });
    assert.equal(all.length, 2);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── (c) getSpeechProfile returns defaults for unknown student ──

test('getSpeechProfile returns schema defaults for unknown student', async () => {
  const path = tmpFile('profile-defaults');
  try {
    await initDatabase(path);
    const profile = getSpeechProfile('unknown-student');
    assert.ok(profile, 'should return an object');
    assert.equal(profile.student_id, 'unknown-student');
    assert.equal(profile.min_audio_b64, 4000);
    assert.equal(profile.min_confidence, 0.45);
    assert.equal(profile.fuzzy_threshold, 0.34);
    assert.equal(profile.silence_threshold, 15);
    assert.equal(profile.silence_duration_ms, 2000);
    assert.equal(profile.repair_enabled, 1);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── (d) saveSpeechProfile then getSpeechProfile roundtrip ──

test('saveSpeechProfile and getSpeechProfile roundtrip', async () => {
  const path = tmpFile('profile-roundtrip');
  const { v4: uuidv4 } = await import('uuid');
  try {
    await initDatabase(path);
    const profileId = uuidv4();
    const studentId = 's-round';

    saveSpeechProfile({
      id: profileId,
      student_id: studentId,
      custom_vocabulary: JSON.stringify(['ablespeak', 'voqal']),
      min_audio_b64: 5000,
      min_confidence: 0.5,
      fuzzy_threshold: 0.4,
      silence_threshold: 20,
      silence_duration_ms: 2500,
      repair_enabled: 0,
    });

    const profile = getSpeechProfile(studentId);
    assert.ok(profile, 'should return saved profile');
    assert.equal(profile.id, profileId);
    assert.equal(profile.student_id, studentId);
    assert.equal(profile.min_audio_b64, 5000);
    assert.equal(profile.min_confidence, 0.5);
    assert.equal(profile.fuzzy_threshold, 0.4);
    assert.equal(profile.repair_enabled, 0);

    // Upsert update
    saveSpeechProfile({ id: profileId, student_id: studentId, min_confidence: 0.6 });
    const updated = getSpeechProfile(studentId);
    assert.equal(updated.min_confidence, 0.6);
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});

// ── (e) Legacy DB upgrade: new columns on commands table work ──

test('legacy-DB upgrade: insertCommand with student_id/outcome/prompt_count works', async () => {
  const path = tmpFile('legacy');
  const { v4: uuidv4 } = await import('uuid');
  try {
    // First init — creates original schema
    await initDatabase(path);
    await closeDatabase();

    // Re-init — runs migrate() which adds new columns via ALTER TABLE
    await initDatabase(path);

    // insertCommand with new columns must not throw
    insertCommand({
      id: uuidv4(),
      type: 'voice',
      direction: 'user_to_ai',
      payload: '{}',
      result: '{}',
      latency_ms: 100,
      student_id: 's-legacy',
      outcome: 'success',
      prompt_count: 1,
    });
  } finally {
    await closeDatabase();
    cleanup(path);
  }
});
