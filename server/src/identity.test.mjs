import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, matchStudentName, parseRosterCsv } from './identity.js';

// ── normalizeName ──

test('normalizeName: trims whitespace', () => {
  assert.equal(normalizeName('  Alice  '), 'alice');
});

test('normalizeName: lowercases', () => {
  assert.equal(normalizeName('ALICE'), 'alice');
});

test('normalizeName: collapses internal whitespace', () => {
  assert.equal(normalizeName('Alice   Brown'), 'alice brown');
});

test('normalizeName: strips punctuation', () => {
  assert.equal(normalizeName("Smith, Jr."), 'smith jr');
});

test('normalizeName: apostrophe stripped', () => {
  assert.equal(normalizeName("O'Brien"), 'obrien');
});

test('normalizeName: empty string', () => {
  assert.equal(normalizeName(''), '');
});

test('normalizeName: null-like input returns empty', () => {
  assert.equal(normalizeName(null), '');
});

// ── matchStudentName ──

const students = [
  { id: 's1', display_name: 'Alice Brown' },
  { id: 's2', display_name: 'Bob Smith' },
  { id: 's3', display_name: 'Carlos Rivera' },
];

test('matchStudentName: exact match returns 1.0', () => {
  const r = matchStudentName('Alice Brown', students);
  assert.equal(r.student?.id, 's1');
  assert.equal(r.confidence, 1.0);
});

test('matchStudentName: case-insensitive exact match', () => {
  const r = matchStudentName('alice brown', students);
  assert.equal(r.student?.id, 's1');
  assert.equal(r.confidence, 1.0);
});

test('matchStudentName: punctuation variant exact match', () => {
  const r = matchStudentName('Alice, Brown.', students);
  assert.equal(r.student?.id, 's1');
  assert.equal(r.confidence, 1.0);
});

test('matchStudentName: unique first name returns 0.8', () => {
  const r = matchStudentName('Alice', students);
  assert.equal(r.student?.id, 's1');
  assert.equal(r.confidence, 0.8);
});

test('matchStudentName: unique first name Bob returns 0.8', () => {
  const r = matchStudentName('Bob', students);
  assert.equal(r.student?.id, 's2');
  assert.equal(r.confidence, 0.8);
});

test('matchStudentName: gibberish → null student', () => {
  const r = matchStudentName('xyzqwerty', students);
  assert.equal(r.student, null);
  assert.equal(r.confidence, 0);
});

test('matchStudentName: empty transcript → null', () => {
  const r = matchStudentName('', students);
  assert.equal(r.student, null);
});

test('matchStudentName: empty students array → null', () => {
  const r = matchStudentName('Alice', []);
  assert.equal(r.student, null);
  assert.equal(r.confidence, 0);
});

test('matchStudentName: Levenshtein near-match above threshold', () => {
  // "Allice" is close to "Alice Brown" but let's use Carlos for unique test
  const r = matchStudentName('Carlos', students);
  assert.equal(r.student?.id, 's3');
  assert.equal(r.confidence, 0.8); // unique first name
});

// Ambiguous two-Erics case
const twoErics = [
  { id: 'e1', display_name: 'Eric Brown' },
  { id: 'e2', display_name: 'Eric Smith' },
];

test('matchStudentName: ambiguous two-Erics tie → null', () => {
  const r = matchStudentName('Eric', twoErics);
  assert.equal(r.student, null);
  assert.equal(r.confidence, 0);
});

test('matchStudentName: two Erics — full name resolves unambiguously', () => {
  const r = matchStudentName('Eric Brown', twoErics);
  assert.equal(r.student?.id, 'e1');
  assert.equal(r.confidence, 1.0);
});

// Levenshtein tie — two equally-distant names
const tieStudents = [
  { id: 't1', display_name: 'abc' },
  { id: 't2', display_name: 'xyz' },
];

test('matchStudentName: Levenshtein tie → null (ambiguous)', () => {
  // "mmm" equidistant from "abc" and "xyz"
  const r = matchStudentName('mmm', tieStudents);
  assert.equal(r.student, null);
});

// ── parseRosterCsv ──

test('parseRosterCsv: empty string returns empty results', () => {
  const r = parseRosterCsv('');
  assert.deepEqual(r.students, []);
  assert.deepEqual(r.errors, []);
});

test('parseRosterCsv: simple two-row no header', () => {
  const r = parseRosterCsv('Alice Brown,EXT-001\nBob Smith,EXT-002');
  assert.equal(r.students.length, 2);
  assert.equal(r.students[0].display_name, 'Alice Brown');
  assert.equal(r.students[0].external_ref, 'EXT-001');
  assert.equal(r.students[1].display_name, 'Bob Smith');
  assert.equal(r.errors.length, 0);
});

test('parseRosterCsv: with header row', () => {
  const r = parseRosterCsv('display_name,external_ref\nAlice Brown,EXT-001');
  assert.equal(r.students.length, 1);
  assert.equal(r.students[0].display_name, 'Alice Brown');
});

test('parseRosterCsv: skips blank lines', () => {
  const r = parseRosterCsv('Alice Brown,EXT-001\n\nBob Smith,EXT-002\n');
  assert.equal(r.students.length, 2);
  assert.equal(r.errors.length, 0);
});

test('parseRosterCsv: quoted cell containing comma', () => {
  const r = parseRosterCsv('"Smith, Jr",EXT-003');
  assert.equal(r.students.length, 1);
  assert.equal(r.students[0].display_name, 'Smith, Jr');
  assert.equal(r.students[0].external_ref, 'EXT-003');
});

test('parseRosterCsv: empty display_name flagged as error', () => {
  const r = parseRosterCsv(',EXT-004\nBob Smith,EXT-002');
  assert.equal(r.students.length, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 1);
  assert.ok(r.errors[0].reason.includes('display_name'));
});

test('parseRosterCsv: external_ref is optional', () => {
  const r = parseRosterCsv('Alice Brown');
  assert.equal(r.students.length, 1);
  assert.equal(r.students[0].display_name, 'Alice Brown');
  assert.equal(r.students[0].external_ref, null);
});

test('parseRosterCsv: trims cell whitespace', () => {
  const r = parseRosterCsv('  Alice Brown  ,  EXT-001  ');
  assert.equal(r.students[0].display_name, 'Alice Brown');
  assert.equal(r.students[0].external_ref, 'EXT-001');
});

test('parseRosterCsv: bad row does not block good rows', () => {
  const r = parseRosterCsv('Alice Brown,EXT-001\n,EXT-BAD\nCarlos Rivera,EXT-003');
  assert.equal(r.students.length, 2);
  assert.equal(r.errors.length, 1);
});

test('parseRosterCsv: header with extra whitespace detected', () => {
  const r = parseRosterCsv('display_name , external_ref\nAlice Brown,EXT-001');
  assert.equal(r.students.length, 1);
  assert.equal(r.students[0].display_name, 'Alice Brown');
});
