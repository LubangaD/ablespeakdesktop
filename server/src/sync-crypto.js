/**
 * AbleSpeak T4 Sync Crypto — application-layer AES-256-GCM encryption.
 *
 * Key derivation: scryptSync (N=16384, r=8, p=1) — each payload gets a fresh
 * random salt, so the same classroomKey produces a different derived key every call.
 *
 * SECURITY: classroomKey is NEVER logged, echoed, or included in error messages.
 * Errors from decryptPayload always say "Decryption failed" regardless of cause
 * (wrong key, tampered data, bad tag) to prevent information leakage.
 *
 * Uses node:crypto only — zero new npm dependencies.
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32; // AES-256 = 32 bytes
const IV_LEN = 12;  // GCM standard IV = 96 bits
const SALT_LEN = 16;

/**
 * Derive a 32-byte AES key from classroomKey + salt (base64).
 */
export function deriveKey(classroomKey, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  return scryptSync(classroomKey, salt, KEY_LEN, SCRYPT_OPTS);
}

/**
 * Encrypt obj (JSON-serialisable) with classroomKey.
 * Returns { salt, iv, tag, data } — all base64 strings.
 * Each call produces distinct salt and IV so identical inputs produce distinct ciphertexts.
 */
export function encryptPayload(obj, classroomKey) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(classroomKey, salt.toString('base64'));

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify(obj);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

/**
 * Decrypt a package produced by encryptPayload.
 * Throws on wrong key, tampered data, or bad auth tag.
 * Error message never contains classroomKey or any secret material.
 */
export function decryptPayload(pkg, classroomKey) {
  const { salt, iv, tag, data } = pkg;
  try {
    const key = deriveKey(classroomKey, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    // Identical error for all failure modes (wrong key / tamper / bad tag)
    throw new Error('Decryption failed');
  }
}
