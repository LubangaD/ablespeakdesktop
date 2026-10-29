/**
 * Speech recognition on this computer (local-asr.js) and the model converter
 * (tools/convert-whisper-to-ggml.mjs).
 * Run with:  node --test src/local-asr.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { cleanLocalText, enginePaths, modelPath, audioContext, requestTimeout } from './local-asr.js';
import { ggmlName, toHalf } from '../tools/convert-whisper-to-ggml.mjs';

test('markers for sound that is not speech are removed', () => {
  assert.equal(cleanLocalText(' Scroll down.'), 'Scroll down.');
  assert.equal(cleanLocalText('[BLANK_AUDIO]'), '');
  assert.equal(cleanLocalText('(music) open Chrome'), 'open Chrome');
  assert.equal(cleanLocalText('*coughs*'), '');
});

test('what Whisper says for noise alone counts as no speech', () => {
  assert.equal(cleanLocalText('Thank you.'), '');
  assert.equal(cleanLocalText(' you'), '');
  assert.equal(cleanLocalText('Thank you very much.'), '');
  assert.equal(cleanLocalText('Bye-bye.'), '');
  assert.equal(cleanLocalText('Subtitles by the Amara.org community'), '');
  assert.equal(cleanLocalText('.'), '');
  assert.equal(cleanLocalText('Thank you for opening Word'), 'Thank you for opening Word');
});

test('hint words repeated back with no speech count as no speech, but the name alone does not', () => {
  const prompt = 'Derrick, Strathmore, AbleSpeak';
  assert.equal(cleanLocalText('Derrick, Strathmore, AbleSpeak.', prompt), '');
  assert.equal(cleanLocalText('AbleSpeak.', prompt), 'AbleSpeak.');
  assert.equal(cleanLocalText('Able speak.', prompt), 'Able speak.');
  assert.equal(cleanLocalText('Call Derrick', prompt), 'Call Derrick');
});

test('a long clip is given longer to come back', () => {
  const seconds = s => 44 + s * 32000;
  assert.equal(requestTimeout(seconds(3)), 4600);
  assert.equal(requestTimeout(seconds(78)), 19600);
});

test('a short clip is worked through quickly; a long one gets the whole window', () => {
  const seconds = s => 44 + s * 32000;
  assert.equal(audioContext(seconds(3)), 512);
  assert.equal(audioContext(seconds(20)), 1280);
  assert.equal(audioContext(seconds(11.5)), 768);
  assert.equal(audioContext(seconds(45)), 1500);
});

test('the Arm engine is tried first on Arm computers, and only x64 elsewhere', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'local-asr-'));
  try {
    for (const arch of ['arm64', 'x64']) {
      mkdirSync(join(dir, 'engine', arch, 'Release'), { recursive: true });
      writeFileSync(join(dir, 'engine', arch, 'Release', 'whisper-server.exe'), '');
    }
    assert.deepEqual(enginePaths(dir, { arm: true }).map(p => p.includes('arm64')), [true, false]);
    assert.deepEqual(enginePaths(dir, { arm: false }).map(p => p.includes('arm64')), [false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the 8-bit model is used when it exists, else the full one, else none', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'local-asr-'));
  try {
    assert.equal(modelPath(dir), null);
    mkdirSync(join(dir, 'cdli-small'));
    writeFileSync(join(dir, 'cdli-small', 'ggml-model.bin'), '');
    assert.ok(modelPath(dir).endsWith('ggml-model.bin'));
    writeFileSync(join(dir, 'cdli-small', 'ggml-model-q8_0.bin'), '');
    assert.ok(modelPath(dir).endsWith('ggml-model-q8_0.bin'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Hugging Face tensor names become whisper.cpp names', () => {
  assert.equal(ggmlName('model.encoder.layers.3.self_attn.k_proj.weight'), 'encoder.blocks.3.attn.key.weight');
  assert.equal(ggmlName('model.decoder.layers.0.encoder_attn.k_proj.weight'), 'decoder.blocks.0.cross_attn.key.weight');
  assert.equal(ggmlName('model.decoder.layers.2.fc2.bias'), 'decoder.blocks.2.mlp.2.bias');
  assert.equal(ggmlName('model.encoder.layer_norm.weight'), 'encoder.ln_post.weight');
  assert.equal(ggmlName('model.decoder.embed_tokens.weight'), 'decoder.token_embedding.weight');
  assert.equal(ggmlName('model.encoder.conv1.weight'), 'encoder.conv1.weight');
});

test('float16 conversion rounds like numpy', () => {
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(toHalf(65504), 0x7bff);
  assert.equal(toHalf(1e9), 0x7c00);
  assert.equal(toHalf(0), 0);
  // Every float32 value matches the built-in Float16Array, where there is one
  if (typeof Float16Array !== 'undefined') {
    const half = new Float16Array(1);
    const bits = new Uint16Array(half.buffer);
    const single = new Float32Array(1);
    for (let i = 0; i < 20000; i++) {
      single[0] = (Math.random() - 0.5) * 10 ** (Math.floor(Math.random() * 12) - 8);
      half[0] = single[0];
      assert.equal(toHalf(single[0]), bits[0], `value ${single[0]}`);
    }
  }
});

test('a clip is checked before the engine runs: format, and silence', async () => {
  const { inspectWav } = await import('./local-asr.js');
  const wav = (samples, rate = 16000, channels = 1) => {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(Math.round(s * 32767), i * 2));
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
    head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(channels, 22); head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * 2 * channels, 28); head.writeUInt16LE(2 * channels, 32); head.writeUInt16LE(16, 34);
    head.write('data', 36); head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
  };
  const tone = Array.from({ length: 16000 }, (_, i) => 0.3 * Math.sin(i / 5));
  const sound = inspectWav(wav(tone));
  assert.equal(sound.seconds, 1);
  assert.ok(sound.rms > 0.2);
  assert.ok(inspectWav(wav(new Array(16000).fill(0))).rms < 0.0005, 'silence');
  assert.throws(() => inspectWav(wav(tone, 44100)), /16 kHz mono/);
  assert.throws(() => inspectWav(Buffer.from('not audio at all, just text')), /not a WAV/);
});
