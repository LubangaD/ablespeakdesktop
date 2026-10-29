/**
 * The lines of an exam paper → its questions, without any AI: numbered
 * questions ("1.", "Question 2"), their parts ("(a)", "(i)"), multiple-choice
 * options ("A.", "(B)"), marks ("(2 marks)", "[3]") and sections.
 *
 * Papers vary, so the result is a draft: the teacher checks it, and can fix
 * any question, before a student takes the exam. `warnings` says what to check.
 */

const JUNK = [
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /^-?\s*\d{1,3}\s*-?$/,                        // a page number on its own
  /^(please\s+)?turn\s+over\.?$/i,
  /^(this paper consists of|candidates should check).*pages?/i,
  /^[\s._\-–—…|]{4,}$/,                          // writing lines: ".........", "_______"
  /^©/,
];

const MARKS = [
  /\(\s*(\d{1,3})\s*(?:marks?|mks?|mk)\s*\)/i,
  /\[\s*(\d{1,3})\s*(?:marks?|mks?|mk)?\s*\]/i,
  /\b(\d{1,3})\s*(?:marks|mks)\s*$/i,
];

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

/** "(2 marks)" out of the text, and the number. */
export function takeMarks(text) {
  for (const re of MARKS) {
    const m = text.match(re);
    if (m) return { text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/[.…_\s]{3,}$/, '').replace(/\s+/g, ' ').trim(), marks: Number(m[1]) };
  }
  return { text, marks: null };
}

const nextLetter = (letter, upper) => {
  const next = String.fromCharCode(letter ? letter.toLowerCase().charCodeAt(0) + 1 : 97);
  return upper ? next.toUpperCase() : next;
};

/**
 * Options written on one line: "Capital? A. Nairobi B. Mombasa C. Kisumu".
 * Only letters in order from A count, so "B. Sc" inside a sentence does not.
 */
export function splitInlineOptions(text) {
  const marker = /(^|\s)\(?([A-F])[.)]\s+/g;
  const hits = [];
  let expected = 'A';
  for (const m of text.matchAll(marker)) {
    if (m[2] !== expected) continue;
    hits.push({ letter: m[2], at: m.index + m[1].length, after: m.index + m[0].length });
    expected = nextLetter(expected, true);
  }
  if (hits.length < 2) return null;
  return {
    stem: text.slice(0, hits[0].at).trim(),
    options: hits.map((h, i) => ({ letter: h.letter, text: text.slice(h.after, hits[i + 1]?.at ?? text.length).trim() })),
  };
}

const clean = line => String(line ?? '').replace(/ /g, ' ').replace(/[.…_]{4,}/g, ' ').replace(/\s+/g, ' ').trim();

export function parsePaper(rawLines) {
  const preamble = [];
  const questions = [];
  const warnings = [];
  let section = null;
  let q = null;       // the question being read
  let part = null;    // its part being read
  let target = null;  // what a continuation line belongs to: { obj, key }
  let lastNumber = 0; // the last question number, as printed
  let sectioned = false; // each section numbers from 1: questions are A1, B1, …

  const unit = () => part || q;
  const addText = (obj, key, text) => { obj[key] = obj[key] ? `${obj[key]} ${text}` : text; };
  const setMarks = (obj, marks) => { if (marks !== null && obj && obj.marks == null) obj.marks = marks; };
  const notePicture = text => {
    if (!/\[picture\]/.test(text)) return text;
    if (unit()) unit().picture = true;
    return text.replace(/\s*\[picture\]\s*/g, ' ').trim();
  };

  /** The body of a question or part: may hold marks, or options on the same line. */
  const fill = (obj, text) => {
    const inline = splitInlineOptions(text);
    if (inline) {
      const stem = takeMarks(inline.stem);
      addText(obj, 'text', stem.text);
      setMarks(obj, stem.marks);
      for (const o of inline.options) {
        const t = takeMarks(o.text);
        obj.options.push({ letter: o.letter, text: t.text });
        setMarks(obj, t.marks);
      }
      target = { obj: obj.options[obj.options.length - 1], key: 'text' };
      return;
    }
    const t = takeMarks(text);
    if (t.text) addText(obj, 'text', t.text);
    setMarks(obj, t.marks);
    target = { obj, key: 'text' };
  };

  const startPart = (label, rest) => {
    part = { label, text: '', marks: null, options: [], picture: false };
    q.parts.push(part);
    fill(part, notePicture(rest));
  };

  for (const raw of rawLines) {
    let line = clean(raw);
    if (!line || JUNK.some(re => re.test(line))) continue;

    // A section heading: "SECTION B", "Section B (60 marks)", "SECTION B: Answer any two" —
    // not a sentence that happens to start with the word ("Section 3 of the constitution says…")
    const sec = line.match(/^section\s+([a-h]|[ivx]{1,4}|\d{1,2})\b\s*(.*)$/i);
    if (sec && (!sec[2] || /^[(:.\-–—]/.test(sec[2]) || sec[2] === sec[2].toUpperCase())) {
      section = sec[1].toUpperCase();
      q = null; part = null;
      target = { obj: { text: '' }, key: 'text' }; // a section's instructions are not a question's
      continue;
    }

    // A question: "1.", "1)", "Question 1", "Q1." — numbered in order, so a
    // year or a number in the text ("2. 2014 was…") is not taken for one.
    const qm = line.match(/^(?:question|qn|q)\s*\.?\s*(\d{1,3})\b[\s.:)\-–]*(.*)$/i) || line.match(/^(\d{1,3})\s*[.)](?:\s+|(?=\())(.*)$/);
    if (qm) {
      const n = Number(qm[1]);
      const last = lastNumber;
      const sectionStart = section !== null && q === null; // straight after a section heading
      // Each section numbering from 1 again: the questions become A1, A2, B1, …
      const restart = n === 1 && sectionStart && questions.length > 0;
      // A number skipped by mistake ("1, 2, 4"): still a question, and the teacher is told
      const skipped = n > last + 1 && (n <= last + 3 || sectionStart);
      if (n === last + 1 || questions.length === 0 || restart || skipped) {
        if (restart) {
          sectioned = true;
          for (const earlier of questions) if (earlier.section && /^\d+$/.test(earlier.number)) earlier.number = `${earlier.section}${earlier.number}`;
        }
        if (skipped) warnings.push(`The numbering jumps from ${last} to ${n} — check that no question is missing.`);
        if (questions.length === 0 && n !== 1) warnings.push(`The first question is numbered ${n} — check that none is missing before it.`);
        lastNumber = n;
        q = { number: sectioned && section ? `${section}${n}` : String(n), section, text: '', marks: null, options: [], parts: [], picture: false };
        questions.push(q);
        part = null;
        const rest = notePicture(qm[2]);
        const inlinePart = rest.match(/^\(a\)\s*(.*)$/);
        if (inlinePart) startPart('a', inlinePart[1]);
        else fill(q, rest);
        continue;
      }
      if (q) warnings.push(`In question ${q.number}, the line "${line.slice(0, 50)}" starts with a number but was kept as part of it. If it is a new question, fix the numbering.`);
    }

    if (q) {
      line = notePicture(line);
      if (!line) continue;

      // A part: "(a)", "a)", "b." — the next letter in order
      const pm = line.match(/^\(([a-h])\)\s*(.*)$/) || line.match(/^([a-h])[).]\s+(.*)$/);
      const lastLetter = [...q.parts].reverse().find(p => /^[a-h]/.test(p.label))?.label[0];
      if (pm && pm[1] === nextLetter(lastLetter, false)) {
        startPart(pm[1], pm[2]);
        continue;
      }

      // A sub-part: "(i)", "ii)" — belongs to the part above it
      const rm = line.match(/^\(([ivx]{1,4})\)\s*(.*)$/i) || line.match(/^([ivx]{1,4})[).]\s+(.*)$/i);
      if (rm && ROMAN.includes(rm[1].toLowerCase())) {
        const parent = part ? part.label.replace(/\(.*$/, '') : '';
        // "(a) Name two…" followed by "(i)": the part's own words are its stem
        if (part && !part.label.includes('(') && !part.options.length) {
          part.stem = true;
        }
        startPart(`${parent}(${rm[1].toLowerCase()})`, rm[2]);
        continue;
      }

      // An option: "A. Nairobi", "(B) Mombasa" — the next letter in order
      const host = unit();
      const lastOption = host.options[host.options.length - 1]?.letter;
      const inline = splitInlineOptions(line);
      if (inline && !inline.stem && inline.options[0].letter === nextLetter(lastOption, true)) {
        for (const o of inline.options) host.options.push({ letter: o.letter, text: takeMarks(o.text).text });
        target = { obj: host.options[host.options.length - 1], key: 'text' };
        continue;
      }
      const om = line.match(/^\(?([A-F])[.)]\s+(.*)$/);
      if (om && om[1] === nextLetter(lastOption, true)) {
        const t = takeMarks(om[2]);
        host.options.push({ letter: om[1], text: t.text });
        setMarks(host, t.marks);
        target = { obj: host.options[host.options.length - 1], key: 'text' };
        continue;
      }

      // Anything else carries on what came before: more of the question, part or option.
      const t = takeMarks(line);
      if (t.text) addText(target?.obj || host, target?.key || 'text', t.text);
      setMarks(host, t.marks);
      continue;
    }

    if (target) continue; // a section's own instructions
    preamble.push(line);
  }

  // A part whose words only introduce its sub-parts is read, not answered
  for (const question of questions) {
    question.parts = question.parts.map(p => {
      if (!p.stem) return p;
      const { stem, ...rest } = p;
      return { ...rest, introOnly: true };
    });
  }

  for (const question of questions) {
    for (const u of [question, ...question.parts]) {
      const where = `Question ${question.number}${u === question ? '' : ` (${u.label})`}`;
      if (u.options.length === 1) warnings.push(`${where} has only one option — check its answer choices.`);
      if (u.picture) warnings.push(`${where} has a picture or diagram. AbleSpeak cannot read pictures aloud: describe it in the question's words, or arrange a human reader.`);
    }
    if (!question.text && question.parts.length === 0) warnings.push(`Question ${question.number} has no words — check it.`);
  }
  if (questions.length === 0) warnings.push('No numbered questions were found. Questions need numbers like "1." or "Question 1".');

  return {
    title: preamble[0] || 'Exam',
    instructions: preamble.slice(1),
    questions,
    warnings,
  };
}

/** How a part label is said: "a", "a, i". */
const spokenLabel = label => label.replace(/\((\w+)\)/, ', $1').replace(/^, /, '').trim();

/**
 * The things a student answers, in order: a question, or each part of it.
 * key: "3", "2a", "2a(i)". A part that only introduces its sub-parts is read
 * with them, not answered on its own.
 */
export function answerItems(paper) {
  const items = [];
  for (const q of paper.questions || []) {
    const parts = (q.parts || []).filter(p => !p.introOnly);
    if (!parts.length) {
      items.push({ key: q.number, number: q.number, part: null, label: `Question ${q.number}` });
      continue;
    }
    for (const p of parts) {
      items.push({ key: `${q.number}${p.label}`, number: q.number, part: p.label, label: `Question ${q.number}, part ${spokenLabel(p.label)}` });
    }
  }
  return items;
}

/** The question, its part, and the part above a sub-part, behind an item key. */
export function findItem(paper, key) {
  for (const q of paper.questions || []) {
    const parts = q.parts || [];
    if (!parts.some(p => !p.introOnly) && q.number === key) return { question: q, part: null, intro: null };
    for (const p of parts) {
      if (`${q.number}${p.label}` !== key) continue;
      const parentLabel = p.label.includes('(') ? p.label.replace(/\(.*$/, '') : null;
      const intro = parentLabel ? parts.find(x => x.label === parentLabel && x.introOnly) || null : null;
      return { question: q, part: p, intro };
    }
  }
  return null;
}
