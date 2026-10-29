/**
 * The voice model for "only my voice" (src/voice-profile.js): TitaNet-small,
 * put in vendor/voice-lock/ from sherpa-onnx's own releases and checked
 * against its known SHA-256. The installer carries it from there.
 *
 * On an Arm Windows laptop it also adds sherpa-onnx's x64 build: AbleSpeak's
 * Electron is x64 there too (emulated), but npm installs only builds for the
 * laptop's own chip. A later `npm install` can remove it again; run this
 * again then.
 *
 *   npm run voice-model
 */
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { VOICE_MODEL } from '../src/voice-profile.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'vendor', 'voice-lock');
const target = join(dir, VOICE_MODEL.file);
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

if (existsSync(target) && sha256(target) === VOICE_MODEL.sha256) {
  console.log(`The voice model is already in place: ${target}`);
} else {
  mkdirSync(dir, { recursive: true });
  const partial = `${target}.download`;
  console.log(`Downloading the voice model (${Math.round(VOICE_MODEL.bytes / 1e6)} MB)…`);
  const res = await fetch(VOICE_MODEL.url);
  if (!res.ok) throw new Error(`The download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  const got = sha256(partial);
  if (got !== VOICE_MODEL.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`The download is not the expected file (SHA-256 ${got})`);
  }
  renameSync(partial, target);
  console.log(`The voice model is saved: ${target}`);
}

const x64 = join(root, 'node_modules', 'sherpa-onnx-win-x64');
if (process.platform === 'win32' && !existsSync(x64)) {
  const { version } = JSON.parse(readFileSync(join(root, 'node_modules', 'sherpa-onnx-node', 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected sherpa-onnx version: ${version}`);
  console.log(`Adding sherpa-onnx's x64 build (${version}) for AbleSpeak's x64 Electron…`);
  execSync(`npm install --no-save --force sherpa-onnx-win-x64@${version}`, { cwd: root, stdio: 'inherit' });
}
