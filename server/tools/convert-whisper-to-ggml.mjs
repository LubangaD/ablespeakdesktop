/**
 * Convert a Hugging Face Whisper model (config.json, vocab.json,
 * model.safetensors) into the single file whisper.cpp loads — without
 * PyTorch. A Node port of whisper.cpp's models/convert-h5-to-ggml.py.
 *
 *   node tools/convert-whisper-to-ggml.mjs <model dir> <mel_filters.npz> <out.bin>
 *
 * Layout written (all little-endian):
 *   magic 'ggml' · hparams (11 × int32) · mel filters (n_mel, n_fft, float32…)
 *   · vocabulary (count, then each token's bytes) · tensors
 *     (n_dims, name length, type, dims reversed, name, data).
 * Matrices are stored as float16; 1-D tensors, the conv biases and the
 * positional embeddings as float32, as the Python converter does.
 */
import { readFileSync, openSync, readSync, writeSync, closeSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import JSZip from 'jszip';

// ── Hugging Face names → whisper.cpp names (convert-h5-to-ggml.py conv_map) ──
const CONV_MAP = {
  'self_attn.k_proj': 'attn.key', 'self_attn.q_proj': 'attn.query', 'self_attn.v_proj': 'attn.value',
  'self_attn.out_proj': 'attn.out', 'self_attn_layer_norm': 'attn_ln',
  'encoder_attn.q_proj': 'cross_attn.query', 'encoder_attn.v_proj': 'cross_attn.value',
  'encoder_attn.out_proj': 'cross_attn.out', 'encoder_attn_layer_norm': 'cross_attn_ln',
  'fc1': 'mlp.0', 'fc2': 'mlp.2', 'final_layer_norm': 'mlp_ln',
  'encoder.layer_norm.bias': 'encoder.ln_post.bias', 'encoder.layer_norm.weight': 'encoder.ln_post.weight',
  'encoder.embed_positions.weight': 'encoder.positional_embedding',
  'decoder.layer_norm.bias': 'decoder.ln.bias', 'decoder.layer_norm.weight': 'decoder.ln.weight',
  'decoder.embed_positions.weight': 'decoder.positional_embedding',
  'decoder.embed_tokens.weight': 'decoder.token_embedding.weight',
};

const KEEP_F32 = new Set(['encoder.conv1.bias', 'encoder.conv2.bias', 'encoder.positional_embedding', 'decoder.positional_embedding']);

export function ggmlName(hfName) {
  const nn = hfName.split('.').slice(1); // drop "model."
  if (nn[1] === 'layers') {
    nn[1] = 'blocks';
    const inner = nn.slice(3, -1).join('.');
    const mapped = inner === 'encoder_attn.k_proj'
      ? (nn[0] === 'encoder' ? 'attn.key' : 'cross_attn.key')
      : CONV_MAP[inner];
    if (!mapped) throw new Error(`no mapping for ${hfName}`);
    return [...nn.slice(0, 3), mapped, nn[nn.length - 1]].join('.');
  }
  const name = nn.join('.');
  return CONV_MAP[name] || name;
}

// GPT-2's byte ↔ printable-character table (tokens in vocab.json use it)
function byteDecoder() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const decoder = new Map();
  bs.forEach((b, i) => decoder.set(String.fromCodePoint(cs[i]), b));
  return decoder;
}

// float32 → float16 bits, rounding to nearest even (numpy's astype(float16))
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf / nan
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00; // too big → inf
  if (exp <= 0) { // subnormal half
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let half = mant >> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = sign | (exp << 10) | (mant >> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++; // may carry into the exponent, which is correct
  return half;
}

// One float32 matrix out of whisper.cpp's mel_filters.npz
export async function melFilters(npzPath, nMels) {
  const zip = await JSZip.loadAsync(readFileSync(npzPath));
  const entry = zip.file(`mel_${nMels}.npy`);
  if (!entry) throw new Error(`${npzPath} has no mel_${nMels}.npy`);
  const buf = Buffer.from(await entry.async('uint8array'));
  const major = buf[6];
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const start = (major === 1 ? 10 : 12) + headerLen;
  const header = buf.subarray(start - headerLen, start).toString('latin1');
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) throw new Error(`unexpected mel filter layout: ${header}`);
  const shape = header.match(/'shape':\s*\((\d+),\s*(\d+)\)/).slice(1).map(Number);
  return { shape, bytes: buf.subarray(start, start + shape[0] * shape[1] * 4) };
}

export async function convert(dir, npzPath, outPath) {
  const hp = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const vocab = JSON.parse(readFileSync(join(dir, 'vocab.json'), 'utf8'));
  const mel = await melFilters(npzPath, hp.num_mel_bins);
  const out = openSync(outPath, 'w');
  const put = buf => writeSync(out, buf);
  const i32 = values => { const b = Buffer.alloc(4 * values.length); values.forEach((v, i) => b.writeInt32LE(v, i * 4)); return b; };

  put(i32([0x67676d6c,
    hp.vocab_size, hp.max_source_positions, hp.d_model, hp.encoder_attention_heads, hp.encoder_layers,
    // The decoder's real length; some fine-tunes save a shorter "max_length" for generation
    hp.max_target_positions ?? hp.max_length, hp.d_model, hp.decoder_attention_heads, hp.decoder_layers,
    hp.num_mel_bins, 1 /* float16 */]));
  put(i32(mel.shape));
  put(mel.bytes);

  const decoder = byteDecoder();
  const tokens = Object.entries(vocab).sort((a, b) => a[1] - b[1]);
  const parts = [i32([tokens.length])];
  for (const [text] of tokens) {
    const bytes = Buffer.from([...text].map(c => {
      if (!decoder.has(c)) throw new Error(`token ${JSON.stringify(text)} has a character outside the GPT-2 byte table`);
      return decoder.get(c);
    }));
    parts.push(i32([bytes.length]), bytes);
  }
  put(Buffer.concat(parts));

  const model = openSync(join(dir, 'model.safetensors'), 'r');
  const lenBuf = Buffer.alloc(8);
  readSync(model, lenBuf, 0, 8, 0);
  const headerLen = Number(lenBuf.readBigUInt64LE(0));
  const headerBuf = Buffer.alloc(headerLen);
  readSync(model, headerBuf, 0, headerLen, 8);
  const tensors = JSON.parse(headerBuf.toString('utf8'));
  const base = 8 + headerLen;

  let count = 0;
  for (const [hfName, info] of Object.entries(tensors)) {
    if (hfName === '__metadata__' || hfName === 'proj_out.weight') continue; // proj_out is the token embedding again
    if (info.dtype !== 'F32') throw new Error(`${hfName}: expected F32, got ${info.dtype}`);
    const name = ggmlName(hfName);
    let shape = info.shape.filter(d => d !== 1); // numpy squeeze()
    if (name === 'encoder.conv1.bias' || name === 'encoder.conv2.bias') shape = [shape[0], 1];
    const [begin, end] = info.data_offsets;
    const raw = Buffer.alloc(end - begin);
    readSync(model, raw, 0, raw.length, base + begin);
    const asF32 = shape.length < 2 || KEEP_F32.has(name);
    let data = raw;
    if (!asF32) {
      const values = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
      const halves = new Uint16Array(values.length);
      for (let i = 0; i < values.length; i++) halves[i] = toHalf(values[i]);
      data = Buffer.from(halves.buffer);
    }
    const nameBuf = Buffer.from(name, 'utf8');
    put(Buffer.concat([i32([shape.length, nameBuf.length, asF32 ? 0 : 1]), i32([...shape].reverse()), nameBuf]));
    put(data);
    count++;
  }
  closeSync(model);
  closeSync(out);
  return { tensors: count, tokens: tokens.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dir, npzPath, outPath] = process.argv.slice(2);
  if (!dir || !npzPath || !outPath) {
    console.error('usage: node tools/convert-whisper-to-ggml.mjs <model dir> <mel_filters.npz> <out.bin>');
    process.exit(1);
  }
  convert(dir, npzPath, outPath)
    .then(r => console.log(`wrote ${r.tensors} tensors and ${r.tokens} tokens to ${outPath}`))
    .catch(err => { console.error(err.message); process.exit(1); });
}
