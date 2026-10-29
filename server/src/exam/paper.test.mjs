/**
 * Exam papers in: Word and PDF files become lines, and lines become questions.
 * Run with:  node --test src/exam/paper.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, LevelFormat, Table, TableRow, TableCell } from 'docx';
import { parsePaper, answerItems, findItem, splitInlineOptions, takeMarks } from './paper-parse.js';
import { paperLines, PaperError } from './paper-import.js';

const KCSE = [
  'KENYA CERTIFICATE OF SECONDARY EDUCATION',
  'Biology Paper 1',
  'Answer all the questions.',
  '',
  'SECTION A (40 marks)',
  'Answer all questions in this section.',
  '1. Name the organelle responsible for respiration. (1 mark)',
  '.................................................',
  '2. (a) Define osmosis. (2 marks)',
  '(b) State two differences between',
  'plant and animal cells. (4 marks)',
  '3. Which of these is a mammal? A. Shark B. Whale C. Frog D. Snake',
  '4. Name two parts of a flower',
  '(i) male part (1 mark)',
  '(ii) female part (1 mark)',
  'Page 2 of 5',
  '5. In 2014. the population was 40 million. Explain [3]',
  '6. Which blood vessel carries blood away from the heart?',
  'A. Vein',
  'B. Artery',
  'C. Capillary',
  'D. Venule',
];

test('a KCSE-style paper: title, instructions, sections, questions, parts, options and marks', () => {
  const p = parsePaper(KCSE);
  assert.equal(p.title, 'KENYA CERTIFICATE OF SECONDARY EDUCATION');
  assert.deepEqual(p.instructions, ['Biology Paper 1', 'Answer all the questions.']);
  assert.equal(p.questions.length, 6);
  assert.equal(p.questions[0].section, 'A');
  assert.equal(p.questions[0].text, 'Name the organelle responsible for respiration.');
  assert.equal(p.questions[0].marks, 1);
  assert.deepEqual(p.questions[1].parts.map(x => [x.label, x.text, x.marks]), [
    ['a', 'Define osmosis.', 2],
    ['b', 'State two differences between plant and animal cells.', 4],
  ]);
  assert.deepEqual(p.questions[2].options.map(o => o.letter + o.text), ['AShark', 'BWhale', 'CFrog', 'DSnake']);
  assert.deepEqual(p.questions[3].parts.map(x => x.label), ['(i)', '(ii)']);
  assert.equal(p.questions[4].text, 'In 2014. the population was 40 million. Explain', 'a number inside the text is not a new question');
  assert.equal(p.questions[4].marks, 3);
  assert.equal(p.questions[5].options.length, 4);
  assert.deepEqual(p.warnings, []);
});

test('the answer items: a question, or each of its parts', () => {
  const items = answerItems(parsePaper(KCSE));
  assert.deepEqual(items.map(i => i.key), ['1', '2a', '2b', '3', '4(i)', '4(ii)', '5', '6']);
  assert.equal(items[1].label, 'Question 2, part a');
  assert.equal(items[4].label, 'Question 4, part i');
});

test('a part that only introduces its sub-parts is read with them, not answered', () => {
  const p = parsePaper(['1. (a) Name two gases in air.', '(i) The most common one', '(ii) The one we breathe in', '(b) Define diffusion.']);
  assert.deepEqual(answerItems(p).map(i => i.key), ['1a(i)', '1a(ii)', '1b']);
  assert.equal(findItem(p, '1a(ii)').intro.text, 'Name two gases in air.');
});

test('"Question 1" headings, and numbering that skips is not a new question', () => {
  const p = parsePaper(['Question 1', 'Explain photosynthesis.', '7. people were counted', 'Question 2: What is a cell?']);
  assert.equal(p.questions.length, 2);
  assert.equal(p.questions[0].text, 'Explain photosynthesis. 7. people were counted');
  assert.equal(p.questions[1].text, 'What is a cell?');
});

test('options in order only: "B. Sc" in a sentence is not an option', () => {
  assert.equal(splitInlineOptions('She has a B. Sc degree'), null);
  assert.deepEqual(splitInlineOptions('Pick one (A) red (B) blue').options, [{ letter: 'A', text: 'red' }, { letter: 'B', text: 'blue' }]);
});

test('marks are found in the forms papers use', () => {
  assert.deepEqual(takeMarks('Define osmosis. (2 marks)'), { text: 'Define osmosis.', marks: 2 });
  assert.deepEqual(takeMarks('Define osmosis (2mks)'), { text: 'Define osmosis', marks: 2 });
  assert.deepEqual(takeMarks('Explain. [3]'), { text: 'Explain.', marks: 3 });
  assert.deepEqual(takeMarks('No marks here'), { text: 'No marks here', marks: null });
});

test('what a teacher must check is listed: pictures, one option, no questions', () => {
  const p = parsePaper(['1. Look at the diagram [picture] and name part X.', '2. Choose: A. only one']);
  assert.ok(p.questions[0].picture);
  assert.match(p.warnings.join(' '), /picture or diagram/);
  assert.equal(p.questions[0].text, 'Look at the diagram and name part X.');
  assert.match(parsePaper(['Just some notes', 'with no numbers']).warnings[0], /No numbered questions/);
});

// ── Word ──

async function wordPaper() {
  const doc = new Document({
    numbering: {
      config: [
        { reference: 'questions', levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.' },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: '(%2)' },
        ] },
        { reference: 'options', levels: [{ level: 0, format: LevelFormat.UPPER_LETTER, text: '%1.' }] },
      ],
    },
    sections: [{ children: [
      new Paragraph('Chemistry Test'),
      new Paragraph({ text: 'What is the formula of water?', numbering: { reference: 'questions', level: 0 } }),
      new Paragraph({ text: 'H2O', numbering: { reference: 'options', level: 0, instance: 1 } }),
      new Paragraph({ text: 'CO2', numbering: { reference: 'options', level: 0, instance: 1 } }),
      new Paragraph({ text: 'Answer these. (4 marks)', numbering: { reference: 'questions', level: 0 } }),
      new Paragraph({ text: 'Define an atom.', numbering: { reference: 'questions', level: 1 } }),
      new Paragraph({ text: 'Define a molecule.', numbering: { reference: 'questions', level: 1 } }),
      new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Element')] }), new TableCell({ children: [new Paragraph('Symbol')] })] })] }),
      new Paragraph({ text: 'Name the gas & its use.', numbering: { reference: 'questions', level: 0 } }),
    ] }],
  });
  return Packer.toBuffer(doc);
}

test('a Word file keeps its own numbering: 1., (a), A. — and its tables', async () => {
  const lines = (await paperLines(await wordPaper(), 'chemistry.docx')).filter(Boolean);
  assert.deepEqual(lines, [
    'Chemistry Test',
    '1. What is the formula of water?',
    'A. H2O',
    'B. CO2',
    '2. Answer these. (4 marks)',
    '(a) Define an atom.',
    '(b) Define a molecule.',
    'Element | Symbol',
    '3. Name the gas & its use.',
  ]);
  const p = parsePaper(lines);
  assert.equal(p.questions.length, 3);
  assert.equal(p.questions[0].options.length, 2);
  assert.deepEqual(p.questions[1].parts.map(x => x.label), ['a', 'b']);
});

// ── PDF ──

function pdfWith(lines) {
  const esc = s => s.replace(/[()\\]/g, '\\$&');
  const content = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map(l => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

test('a PDF with text gives its lines in reading order', async () => {
  const lines = await paperLines(pdfWith(['Maths Quiz', '1. What is 2 + 2? (1 mark)', '2. Name a prime number.']), 'quiz.pdf');
  assert.deepEqual(lines, ['Maths Quiz', '1. What is 2 + 2? (1 mark)', '2. Name a prime number.']);
  assert.equal(parsePaper(lines).questions.length, 2);
});

test('a scanned PDF (no text) and an old .doc are refused with what to do instead', async () => {
  await assert.rejects(paperLines(pdfWith([]), 'scan.pdf'), err => err instanceof PaperError && /scanned/.test(err.message));
  await assert.rejects(paperLines(Buffer.from('x'), 'old.doc'), err => err instanceof PaperError && /Save As/.test(err.message));
  await assert.rejects(paperLines(Buffer.from('not a zip'), 'broken.docx'), err => err instanceof PaperError);
});
