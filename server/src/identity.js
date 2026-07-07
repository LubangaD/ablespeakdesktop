/**
 * AbleSpeak Student Identity — pure logic, no I/O.
 * Used by the voice student picker and roster import.
 */

/** Compute Levenshtein edit distance between two strings. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
    for (let j = 1; j <= n; j++) dp[i][j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Lowercase, trim, collapse whitespace, strip punctuation. */
export function normalizeName(s) {
  if (s == null) return '';
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match a transcript against a student roster.
 * Returns { student, confidence } or { student: null, confidence: 0 }.
 *
 * Matching order:
 *   1. Exact normalized display_name → confidence 1.0
 *   2. Unique normalized first-token match → confidence 0.8
 *   3. Best normalized-Levenshtein candidate → confidence 1 - (dist / maxLen)
 *
 * Returns null student when best confidence < 0.5 OR two candidates tie
 * within 0.1 (ambiguous).
 */
export function matchStudentName(transcript, students) {
  if (!students || students.length === 0) return { student: null, confidence: 0 };
  const norm = normalizeName(transcript);
  if (!norm) return { student: null, confidence: 0 };

  // 1. Exact normalized match
  for (const student of students) {
    if (normalizeName(student.display_name) === norm) {
      return { student, confidence: 1.0 };
    }
  }

  // 2. Unique first-token (first name) match
  const firstToken = norm.split(' ')[0];
  if (firstToken) {
    const firstNameMatches = students.filter(
      s => normalizeName(s.display_name).split(' ')[0] === firstToken
    );
    if (firstNameMatches.length === 1) {
      return { student: firstNameMatches[0], confidence: 0.8 };
    }
  }

  // 3. Best normalized-Levenshtein candidate
  let best = null;
  let bestConf = 0;
  let secondBestConf = 0;

  for (const student of students) {
    const normName = normalizeName(student.display_name);
    const dist = levenshtein(norm, normName);
    const maxLen = Math.max(norm.length, normName.length);
    const conf = maxLen === 0 ? 1 : 1 - dist / maxLen;
    if (conf > bestConf) {
      secondBestConf = bestConf;
      bestConf = conf;
      best = student;
    } else if (conf > secondBestConf) {
      secondBestConf = conf;
    }
  }

  if (bestConf < 0.5) return { student: null, confidence: 0 };
  if (bestConf - secondBestConf < 0.1) return { student: null, confidence: 0 };
  return { student: best, confidence: bestConf };
}

/**
 * Parse a CSV roster string.
 * Accepts optional header "display_name,external_ref".
 * Returns { students: [{display_name, external_ref}], errors: [{line, reason}] }.
 * Handles quoted cells containing commas ("Smith, Jr" style).
 */
export function parseRosterCsv(text) {
  const students = [];
  const errors = [];
  if (!text) return { students, errors };

  const rawLines = text.split(/\r?\n/);
  let dataLines = rawLines;
  let lineOffset = 0;

  // Detect and skip header row (normalised comparison)
  const firstNorm = rawLines[0]?.trim().toLowerCase().replace(/\s/g, '').replace(/"/g, '');
  if (firstNorm === 'display_name,external_ref') {
    dataLines = rawLines.slice(1);
    lineOffset = 1;
  }

  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i];
    if (!line.trim()) continue; // skip blank lines

    const lineNum = i + 1 + lineOffset;
    const cells = parseCsvRow(line);
    const display_name = cells[0]?.trim() || '';
    const external_ref = cells[1]?.trim() || null;

    if (!display_name) {
      errors.push({ line: lineNum, reason: 'empty display_name' });
      continue;
    }

    students.push({ display_name, external_ref: external_ref || null });
  }

  return { students, errors };
}

/** Parse a single CSV row, handling double-quoted cells. */
function parseCsvRow(line) {
  const cells = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { cells.push(''); break; }
    if (line[i] === '"') {
      i++; // skip opening quote
      let cell = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { cell += line[i++]; }
      }
      cells.push(cell);
      if (i < line.length && line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { cells.push(line.slice(i)); break; }
      cells.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return cells;
}
