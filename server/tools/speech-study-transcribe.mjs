#!/usr/bin/env node
/**
 * Speech study (Stage 1): transcribe the study recordings with Tier 2's
 * recogniser (Gemini), so the study compares it with the Whisper models.
 *
 *   node tools/speech-study-transcribe.mjs [--recordings <folder>]
 *
 * Reads <folder>/manifest.csv (written by ablespeak/research/collect.py) and
 * writes <folder>/transcripts-tier2-gemini.csv. score_recordings.py then
 * scores those transcripts with the same command-match judge it uses for
 * every other model. Safe to stop and run again: clips already transcribed
 * are skipped.
 *
 * The recordings are participant data. They are sent to Google's Gemini API
 * to be transcribed, exactly as they would be in the product — make sure the
 * consent forms say so (research/PROTOCOL.md) before running this.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { VoiceHandler } from '../src/voice-handler.js';

const here = dirname(fileURLToPath(import.meta.url));
const argAt = process.argv.indexOf('--recordings');
const folder = resolve(argAt > 0 ? process.argv[argAt + 1] : join(here, '..', '..', '..', '..', 'ablespeak', 'research', 'recordings'));
const manifestPath = join(folder, 'manifest.csv');
const outPath = join(folder, 'transcripts-tier2-gemini.csv');
const FIELDS = ['speaker', 'n', 'file', 'transcript', 'error'];

/** Rows of a CSV file with a header line; handles quoted fields. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows;
  return body.map(values => Object.fromEntries(header.map((name, i) => [name, values[i] ?? ''])));
}

export function csvLine(values) {
  return values.map(value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',') + '\n';
}

const MIME = { '.webm': 'audio/webm', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mp3', '.m4a': 'audio/mp4' };

async function main() {
  if (!existsSync(manifestPath)) {
    console.error(`No manifest.csv in ${folder}. Record some sessions with research/collect.py first.`);
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set (server/.env or Settings → API keys).');
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(manifestPath, 'utf8')).filter(r => r.file && existsSync(join(folder, r.file)));
  const done = new Set(existsSync(outPath) ? parseCsv(readFileSync(outPath, 'utf8')).map(r => r.file) : []);
  if (!existsSync(outPath)) writeFileSync(outPath, csvLine(FIELDS));

  const todo = rows.filter(r => !done.has(r.file));
  console.log(`${rows.length} clips, ${done.size} already transcribed, ${todo.length} to go (about ${Math.ceil(todo.length / 12)} min at Gemini's rate limit).`);

  const handler = new VoiceHandler();
  let heard = 0;
  for (const [i, row] of todo.entries()) {
    const ext = row.file.slice(row.file.lastIndexOf('.')).toLowerCase();
    const audio = readFileSync(join(folder, row.file)).toString('base64');
    const { text = '', error = '' } = await handler.transcribe(audio, MIME[ext] || 'audio/webm');
    if (text) heard++;
    appendFileSync(outPath, csvLine([row.speaker, row.n, row.file, text, error === 'no_speech' ? '' : error]));
    console.log(`${i + 1}/${todo.length} ${row.speaker} "${row.prompt}" → "${text}"${error ? ` (${error})` : ''}`);
  }
  console.log(`Done: ${heard} of ${todo.length} clips gave words. Wrote ${outPath}.`);
  console.log('Next: modal run research/score_recordings.py');
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('speech-study-transcribe.mjs')) {
  main();
}
