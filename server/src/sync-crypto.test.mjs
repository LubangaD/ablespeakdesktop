/**
 * T4 Sync Crypto Tests (TDD — written before implementation, then made green)
 * Tests: roundtrip, wrong-key throws, tampered data throws, tampered tag throws,
 *        distinct IV per call, empty-object roundtrip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, encryptPayload, decryptPayload } from './sync-crypto.js';

const KEY = 'correct-horse-battery-staple-classroom';
const WRONG_KEY = 'wrong-key-that-should-fail-decryption';

// ── deriveKey ──

test('deriveKey: produces 32-byte Buffer', () => {
  const salt = Buffer.from('aaaabbbbccccdddd').toString('base64');
  const key = deriveKey(KEY, salt);
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32);
});

test('deriveKey: same key+salt → same output (deterministic)', () => {
  const salt = Buffer.from('test-salt-16byte').toString('base64');
  const k1 = deriveKey(KEY, salt);
  const k2 = deriveKey(KEY, salt);
  assert.deepEqual(k1, k2);
});

test('deriveKey: different salt → different key', () => {
  const salt1 = Buffer.from('salt111111111111').toString('base64');
  const salt2 = Buffer.from('salt222222222222').toString('base64');
  const k1 = deriveKey(KEY, salt1);
  const k2 = deriveKey(KEY, salt2);
  assert.notDeepEqual(k1, k2);
});

// ── encryptPayload ──

test('encryptPayload: returns { salt, iv, tag, data } all base64 strings', () => {
  const pkg = encryptPayload({ hello: 'world' }, KEY);
  assert.ok(typeof pkg.salt === 'string');
  assert.ok(typeof pkg.iv === 'string');
  assert.ok(typeof pkg.tag === 'string');
  assert.ok(typeof pkg.data === 'string');
  // Verify base64 decodeable
  assert.doesNotThrow(() => Buffer.from(pkg.salt, 'base64'));
  assert.doesNotThrow(() => Buffer.from(pkg.iv, 'base64'));
  assert.doesNotThrow(() => Buffer.from(pkg.tag, 'base64'));
  assert.doesNotThrow(() => Buffer.from(pkg.data, 'base64'));
});

test('encryptPayload: distinct IV per call (probabilistic)', () => {
  const pkg1 = encryptPayload({ x: 1 }, KEY);
  const pkg2 = encryptPayload({ x: 1 }, KEY);
  // With 12 random bytes, collision probability is negligible
  assert.notEqual(pkg1.iv, pkg2.iv);
});

test('encryptPayload: distinct salt per call', () => {
  const pkg1 = encryptPayload({ x: 1 }, KEY);
  const pkg2 = encryptPayload({ x: 1 }, KEY);
  assert.notEqual(pkg1.salt, pkg2.salt);
});

// ── decryptPayload – happy path ──

test('roundtrip: encryptPayload → decryptPayload returns original object', () => {
  const obj = { table: 'commands', rows: [{ id: 'abc', type: 'voice' }] };
  const pkg = encryptPayload(obj, KEY);
  const result = decryptPayload(pkg, KEY);
  assert.deepEqual(result, obj);
});

test('roundtrip: empty object', () => {
  const pkg = encryptPayload({}, KEY);
  const result = decryptPayload(pkg, KEY);
  assert.deepEqual(result, {});
});

test('roundtrip: nested arrays and unicode', () => {
  const obj = { batches: [{ table: 'students', rows: [{ name: 'Ñoño' }] }] };
  const pkg = encryptPayload(obj, KEY);
  const result = decryptPayload(pkg, KEY);
  assert.deepEqual(result, obj);
});

// ── decryptPayload – error paths ──

test('wrong classroomKey throws', () => {
  const pkg = encryptPayload({ secret: 42 }, KEY);
  assert.throws(() => decryptPayload(pkg, WRONG_KEY), /Decryption failed/);
});

test('tampered data throws', () => {
  const pkg = encryptPayload({ ok: true }, KEY);
  // Flip a byte in the encrypted data
  const dataBytes = Buffer.from(pkg.data, 'base64');
  dataBytes[0] ^= 0xff;
  const tampered = { ...pkg, data: dataBytes.toString('base64') };
  assert.throws(() => decryptPayload(tampered, KEY), /Decryption failed/);
});

test('tampered auth tag throws', () => {
  const pkg = encryptPayload({ ok: true }, KEY);
  const tagBytes = Buffer.from(pkg.tag, 'base64');
  tagBytes[0] ^= 0xff;
  const tampered = { ...pkg, tag: tagBytes.toString('base64') };
  assert.throws(() => decryptPayload(tampered, KEY), /Decryption failed/);
});

test('tampered IV throws', () => {
  const pkg = encryptPayload({ ok: true }, KEY);
  const ivBytes = Buffer.from(pkg.iv, 'base64');
  ivBytes[0] ^= 0xff;
  const tampered = { ...pkg, iv: ivBytes.toString('base64') };
  assert.throws(() => decryptPayload(tampered, KEY), /Decryption failed/);
});

test('error message never contains the classroomKey', () => {
  const pkg = encryptPayload({ x: 1 }, KEY);
  try {
    decryptPayload(pkg, WRONG_KEY);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes(WRONG_KEY), 'error must not echo wrong key');
    assert.ok(!err.message.includes(KEY), 'error must not echo correct key');
  }
});
