/**
 * Tests for the speech-study transcript files: the manifest collect.py writes
 * has prompts with commas and quotes, and the transcript file must read back
 * exactly in Python's csv module. Run with:
 *   node --test tools/speech-study-transcribe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, csvLine } from './speech-study-transcribe.mjs';

test('a manifest with quoted prompts is read field by field', () => {
  const text = 'speaker,n,prompt,command,why,file,recorded_at\r\n'
    + 'KISE-04,1,scroll down,Scroll Down,T1 baseline,KISE-04/01-scroll-down.webm,2026-10-06T09:00:00\r\n'
    + 'KISE-04,32,"Tell us, in your own words, what you used a computer for this week.",,"open response, ~15 seconds",KISE-04/32-tell.webm,2026-10-06T09:10:00\r\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].prompt, 'Tell us, in your own words, what you used a computer for this week.');
  assert.equal(rows[1].command, '');
  assert.equal(rows[1].file, 'KISE-04/32-tell.webm');
});

test('transcripts with commas, quotes and line breaks survive a round trip', () => {
  const values = ['KISE-04', '7', 'a.webm', 'He said "go", then\nstopped', ''];
  const [row] = parseCsv(csvLine(['speaker', 'n', 'file', 'transcript', 'error']) + csvLine(values));
  assert.deepEqual(Object.values(row), values);
});
