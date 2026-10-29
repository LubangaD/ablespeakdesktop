/**
 * Exam papers in, plain lines out: a teacher's Word (.docx) or PDF file
 * becomes the lines a person would see, with Word's own list numbers
 * ("1.", "(a)", "A.") written in, so paper-parse.js can find the questions.
 *
 * Nothing here is sent anywhere: the paper is read on this computer.
 */
import JSZip from 'jszip';

/** A paper that cannot be read, said in words a teacher can act on. */
export class PaperError extends Error {}

/** The lines of a .docx or .pdf file, by its name. */
export async function paperLines(buffer, fileName = '') {
  const name = String(fileName).toLowerCase();
  if (name.endsWith('.docx')) return docxLines(buffer);
  if (name.endsWith('.pdf')) return pdfLines(buffer);
  if (name.endsWith('.doc')) throw new PaperError('This is an old Word file (.doc). Open it in Word, choose Save As, pick "Word Document (.docx)", and upload that.');
  throw new PaperError('Upload the exam as a Word document (.docx) or a PDF.');
}

// ── Word ──

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] ?? m;
});
const attr = (xml, tag, name = 'w:val') => {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};

function toRoman(n) {
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}
function toLetters(n) {
  let out = '';
  while (n > 0) { n -= 1; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}
function formatNumber(n, fmt) {
  switch (fmt) {
    case 'upperLetter': return toLetters(n).toUpperCase();
    case 'lowerLetter': return toLetters(n);
    case 'upperRoman': return toRoman(n).toUpperCase();
    case 'lowerRoman': return toRoman(n);
    case 'bullet': return '•';
    case 'none': return '';
    default: return String(n);
  }
}

/** numId → { levels: [{ start, fmt, text }], overrides: { ilvl: start } } */
function readNumbering(xml) {
  const abstracts = {};
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = [];
    for (const l of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      levels[Number(l[1])] = {
        start: Number(attr(l[2], 'w:start') ?? 1),
        fmt: attr(l[2], 'w:numFmt') || 'decimal',
        text: attr(l[2], 'w:lvlText') ?? `%${Number(l[1]) + 1}.`,
      };
    }
    abstracts[m[1]] = levels;
  }
  const nums = {};
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const overrides = {};
    for (const o of m[2].matchAll(/<w:lvlOverride\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g)) {
      const start = attr(o[2], 'w:startOverride');
      if (start !== null) overrides[o[1]] = Number(start);
    }
    const abstractId = attr(m[2], 'w:abstractNumId');
    nums[m[1]] = { levels: abstracts[abstractId] || [], overrides, abstractId };
  }
  return nums;
}

/** styleId → numPr xml, for headings and list styles that carry their own numbering */
function readStyleNumbering(xml) {
  const out = {};
  for (const m of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const numPr = m[2].match(/<w:numPr>[\s\S]*?<\/w:numPr>/);
    if (numPr) out[m[1]] = numPr[0];
  }
  return out;
}

/** The words of one paragraph: text, tabs, line breaks, equations and a marker for pictures. */
function paragraphText(xml) {
  let out = '';
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<m:t(?:\s[^>]*)?>([^<]*)<\/m:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>|<w:drawing\b|<w:pict\b|<w:object\b/g;
  for (const m of xml.matchAll(token)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[2] !== undefined) out += decode(m[2]);
    else if (m[0].startsWith('<w:tab')) out += ' ';
    else if (m[0].startsWith('<w:br') || m[0] === '<w:cr/>') out += '\n';
    else out += ' [picture] ';
  }
  return out;
}

export async function docxLines(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new PaperError('This Word file could not be opened. It may be damaged — try saving it again in Word.');
  }
  const doc = await zip.file('word/document.xml')?.async('string');
  if (!doc) throw new PaperError('This file is not a Word document.');
  const numbering = readNumbering(await zip.file('word/numbering.xml')?.async('string') || '');
  const styleNumbering = readStyleNumbering(await zip.file('word/styles.xml')?.async('string') || '');
  const counters = {}; // list → [count per level]

  const label = numPr => {
    const numId = attr(numPr, 'w:numId');
    const ilvl = Number(attr(numPr, 'w:ilvl') ?? 0);
    const num = numbering[numId];
    if (!num || numId === '0') return '';
    const levels = num.levels;
    const startOf = l => num.overrides[l] ?? levels[l]?.start ?? 1;
    // Lists that share one definition share one count, as in Word, unless
    // this one restarts its numbering
    const counter = Object.keys(num.overrides).length ? `num${numId}` : `abstract${num.abstractId}`;
    const count = counters[counter] || (counters[counter] = []);
    count[ilvl] = count[ilvl] === undefined ? startOf(ilvl) : count[ilvl] + 1;
    for (let l = ilvl + 1; l < 9; l++) count[l] = undefined; // a new item restarts the levels below it
    const lvl = levels[ilvl] || { fmt: 'decimal', text: `%${ilvl + 1}.` };
    if (lvl.fmt === 'bullet') return '';
    return lvl.text.replace(/%(\d)/g, (_, d) => {
      const l = Number(d) - 1;
      return formatNumber(count[l] ?? startOf(l), levels[l]?.fmt || 'decimal');
    }).trim();
  };

  const body = doc.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] || doc;
  const lines = [];
  for (const block of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const xml = block[0];
    if (xml.startsWith('<w:tbl>')) {
      for (const row of xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        const cells = [...row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)]
          .map(c => [...c[1].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(p => paragraphText(p[0]).trim()).filter(Boolean).join(' '))
          .filter(Boolean);
        if (cells.length) lines.push(cells.join(' | '));
      }
      continue;
    }
    const pPr = xml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || '';
    const numPr = pPr.match(/<w:numPr>[\s\S]*?<\/w:numPr>/)?.[0] || styleNumbering[attr(pPr, 'w:pStyle')] || '';
    const text = paragraphText(xml);
    const prefix = numPr ? label(numPr) : '';
    const parts = text.split('\n');
    parts[0] = prefix ? `${prefix} ${parts[0].trim()}` : parts[0];
    for (const part of parts) lines.push(part.replace(/\s+/g, ' ').trim());
  }
  return lines;
}

// ── PDF ──

export async function pdfLines(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  });
  let pdf;
  try {
    pdf = await loading.promise;
  } catch (err) {
    if (/password/i.test(err?.message || '')) throw new PaperError('This PDF is locked with a password. Upload a copy without the password, or the Word file.');
    throw new PaperError('This PDF could not be opened. It may be damaged — try exporting it again, or upload the Word file.');
  }
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    const words = items
      .filter(i => i.str !== undefined && i.str.trim() !== '')
      .map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || 10 }))
      .sort((a, b) => (Math.abs(b.y - a.y) > Math.min(a.h, b.h) * 0.5 ? b.y - a.y : a.x - b.x));
    let line = null;
    for (const w of words) {
      if (line && Math.abs(line.y - w.y) <= Math.min(line.h, w.h) * 0.5) {
        const gap = w.x - line.end;
        line.text += (gap > w.h * 0.15 && !line.text.endsWith(' ') && !w.str.startsWith(' ') ? ' ' : '') + w.str;
        line.end = w.x + w.w;
      } else {
        if (line) lines.push(line.text.replace(/\s+/g, ' ').trim());
        line = { y: w.y, h: w.h, text: w.str, end: w.x + w.w };
      }
    }
    if (line) lines.push(line.text.replace(/\s+/g, ' ').trim());
    page.cleanup();
  }
  await loading.destroy();
  if (!lines.some(l => /[a-z]{3}/i.test(l))) {
    throw new PaperError('This PDF has no text in it — it is probably a scanned picture of the paper. Upload the Word file instead, or a PDF saved from Word.');
  }
  return lines;
}
