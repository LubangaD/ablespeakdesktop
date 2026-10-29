/**
 * Sitting an exam by voice: the paper is read, answers are written exactly as
 * said, and nothing a student says is ever taken for something else.
 * Run with:  node --test src/exam/exam-runner.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaper } from './paper-parse.js';
import { ExamRunner, normalise } from './exam-runner.js';
import {
  spokenToText, appendToAnswer, dropLastWord, dropLastSentence, lastSentence, forSpeech, spellOut, lettersToWord, wordsToNumber,
} from './spoken-text.js';

const PAPER = parsePaper([
  'Biology Test',
  'Answer all questions.',
  '1. Name the organelle responsible for respiration. (1 mark)',
  '2. (a) Define osmosis. (2 marks)',
  '(b) State two differences between plant and animal cells. (4 marks)',
  '3. Which of these is a mammal? A. Shark B. Whale C. Frog D. Snake',
]);

function sit({ settings = {}, state = null, clock = { t: 1_000_000 } } = {}) {
  const said = [];
  const events = [];
  const saves = [];
  const ended = [];
  let stopped = 0;
  const runner = new ExamRunner({
    paper: PAPER, settings, state, now: () => clock.t,
    say: (text, opts) => said.push({ text, ...opts }),
    record: e => events.push(e),
    save: s => saves.push(s),
    finish: reason => ended.push(reason),
    stopSpeech: () => { stopped += 1; },
  });
  const last = () => said[said.length - 1]?.text || '';
  return { runner, said, events, saves, ended, last, clock, stopped: () => stopped };
}

// ── What is said becomes what is written ──

test('spoken punctuation becomes marks; nothing else changes', () => {
  assert.equal(spokenToText('the cell wall comma made of cellulose full stop'), 'the cell wall, made of cellulose.');
  assert.equal(spokenToText('first point new paragraph second point'), 'first point\n\nsecond point');
  assert.equal(spokenToText('Osmosis is movement, comma, of water'), 'Osmosis is movement, of water');
  assert.equal(spokenToText('I dont no the answer'), 'I dont no the answer', 'spelling and grammar are the student\'s own');
});

test('maths mode: spoken maths becomes symbols', () => {
  assert.equal(spokenToText('x squared plus three x minus four equals zero', { maths: true }), 'x² + 3 x − 4 = 0');
  assert.equal(spokenToText('two point five times four', { maths: true }), '2.5 × 4');
  assert.equal(spokenToText('square root of sixteen is greater than three', { maths: true }), '√16 > 3');
  assert.equal(spokenToText('the price went down by two', { maths: false }), 'the price went down by two');
  assert.equal(forSpeech('x² + 3 = √16'), 'x squared + 3 = square root of 16');
});

test('answers grow, and lose their last word or sentence, as asked', () => {
  let a = appendToAnswer('', 'osmosis is movement of water.');
  assert.equal(a, 'Osmosis is movement of water.');
  a = appendToAnswer(a, 'it needs a membrane');
  assert.equal(a, 'Osmosis is movement of water. It needs a membrane');
  assert.equal(appendToAnswer('Water', ','), 'Water,');
  assert.equal(dropLastWord(a), 'Osmosis is movement of water. It needs a');
  assert.equal(dropLastSentence(a), 'Osmosis is movement of water.');
  assert.equal(lastSentence(a), 'It needs a membrane');
  assert.equal(dropLastSentence('Only one sentence.'), '');
});

test('spelling, letters and numbers as spoken', () => {
  assert.equal(spellOut('Osmosis'), 'capital O, s, m, o, s, i, s');
  assert.equal(lettersToWord('m i t o'), 'mito');
  assert.equal(lettersToWord('em eye tee oh'), 'mito');
  assert.equal(lettersToWord('capital k e n y a'), 'Kenya');
  assert.equal(lettersToWord('mitochondria is'), null);
  assert.equal(wordsToNumber('twenty one'), 21);
  assert.equal(wordsToNumber('a hundred and five'), 105);
  assert.equal(wordsToNumber('banana'), null);
  assert.equal(normalise('AbleSpeak, please Next question.'), 'next question');
});

// ── The exam ──

test('the exam starts by saying what it is, the time allowed, how to get help, and question 1', () => {
  const { runner, last } = sit({ settings: { timeLimitMin: 30 } });
  runner.start();
  assert.match(last(), /This is your exam: Biology Test\. It has 4 questions/);
  assert.match(last(), /You have 30 minutes/);
  assert.match(last(), /Say "help"/);
  assert.match(last(), /Question 1\. Name the organelle responsible for respiration\. 1 mark\./);
});

test('a written answer: "answer", the words, "done" — written exactly, read back', () => {
  const { runner, last } = sit();
  runner.start();
  assert.equal(runner.handle('Answer.').action, 'start_answer');
  const r = runner.handle('mitochondria full stop');
  assert.deepEqual(r, { action: 'write', written: 'mitochondria.' });
  assert.equal(last(), 'Written: mitochondria.');
  runner.handle('done');
  assert.equal(runner.answers['1'].text, 'Mitochondria.');
  assert.match(last(), /Answer saved for Question 1/);
});

test('while answering, words that look like commands inside a sentence are written, not obeyed', () => {
  const { runner } = sit();
  runner.start();
  runner.handle('answer');
  runner.handle('the next question is about cells');
  runner.handle('I said help the plant grow');
  runner.handle('stop the water');
  assert.equal(runner.answers['1'].text, 'The next question is about cells I said help the plant grow stop the water');
  assert.equal(runner.mode, 'answering');
});

test('editing an answer: delete last word or sentence, undo, read it back', () => {
  const { runner, last } = sit();
  runner.start();
  runner.handle('answer');
  runner.handle('Osmosis is the movement of water full stop');
  runner.handle('it goes from dilute to concentrated');
  runner.handle('delete the last word');
  assert.equal(runner.answers['1'].text, 'Osmosis is the movement of water. It goes from dilute to');
  runner.handle('undo');
  assert.equal(runner.answers['1'].text, 'Osmosis is the movement of water. It goes from dilute to concentrated');
  runner.handle('delete last sentence');
  assert.equal(runner.answers['1'].text, 'Osmosis is the movement of water.');
  runner.handle('read my answer');
  assert.equal(last(), 'Your answer: Osmosis is the movement of water.');
});

test('a word spelled letter by letter is written as spelled', () => {
  const { runner, last } = sit();
  runner.start();
  runner.handle('answer');
  runner.handle('spell m i t o c h o n d r i a');
  assert.equal(runner.answers['1'].text, 'mitochondria');
  assert.match(last(), /^Written: mitochondria, spelled m, i, t/);
});

test('multiple choice: "answer B", the letter alone, or its name ("dee")', () => {
  const { runner, last } = sit();
  runner.start();
  runner.handle('go to question three');
  assert.match(last(), /Question 3\. Which of these is a mammal\? Option A: Shark\. Option B: Whale\./);
  assert.deepEqual(runner.handle('answer B'), { action: 'choose', written: 'B' });
  assert.match(last(), /You chose B: Whale/);
  runner.handle('Dee.');
  assert.equal(runner.answers['3'].choice, 'D');
  assert.equal(runner.handle('option F').action, 'no_such_option');
  assert.equal(runner.answers['3'].choice, 'D', 'a choice that is not there changes nothing');
  assert.equal(runner.handle('answer').action, 'choice_needed');
});

test('moving: next, previous, "go to question 2 b", first and last; the end says what is left', () => {
  const { runner, last } = sit();
  runner.start();
  runner.handle('next');
  assert.match(last(), /^Question 2, part a\. Define osmosis\. 2 marks\.$/);
  runner.handle('next');
  assert.match(last(), /^Question 2, part b\. State two/, 'the stem is not repeated within the same question');
  runner.handle('previous question');
  assert.equal(runner.item.key, '2a');
  runner.handle('go to question 2 b');
  assert.equal(runner.item.key, '2b');
  runner.handle('question two part a');
  assert.equal(runner.item.key, '2a');
  runner.handle('last question');
  runner.handle('next');
  assert.match(last(), /That was the last question\. 4 questions have no answer yet/);
  runner.handle('first question');
  runner.handle('back');
  assert.equal(last(), 'This is the first question.');
  assert.equal(runner.handle('go to question 9').action, 'not_found');
});

test('anything that is not a command is never written while not answering, and is said not to be understood', () => {
  const { runner, last } = sit();
  runner.start();
  const r = runner.handle('mitochondria');
  assert.equal(r.action, 'not_understood');
  assert.equal(runner.answered('1'), false);
  assert.match(last(), /To write an answer, say "answer" first/);
});

test('"my answer is …" starts and writes in one go', () => {
  const { runner } = sit();
  runner.start();
  runner.handle('My answer is the mitochondria.');
  assert.equal(runner.answers['1'].text, 'The mitochondria.');
  assert.equal(runner.mode, 'answering');
});

test('finishing asks first; anything but yes carries on', () => {
  const { runner, ended, last } = sit();
  runner.start();
  runner.handle('finish exam');
  assert.match(last(), /You have 4 questions with no answer\. Do you want to finish/);
  runner.handle('next');
  assert.equal(runner.mode, 'browse');
  assert.deepEqual(ended, []);
  runner.handle('submit the exam');
  runner.handle('yes');
  assert.deepEqual(ended, ['finished']);
  assert.equal(runner.handle('next').action, 'finished');
});

test('clearing an answer asks first', () => {
  const { runner } = sit();
  runner.start();
  runner.handle('answer');
  runner.handle('wrong answer');
  runner.handle('clear my answer');
  runner.handle('no');
  assert.equal(runner.answers['1'].text, 'Wrong answer');
  runner.handle('clear my answer');
  runner.handle('yes');
  assert.equal(runner.answers['1'].text, '');
  assert.equal(runner.mode, 'answering', 'back to answering, where the student was');
});

test('reading speed: slower and faster, within limits', () => {
  const { runner, said } = sit();
  runner.start();
  runner.handle('slower');
  runner.handle('slower');
  assert.equal(runner.handle('slower').action, 'speed_slowest');
  assert.equal(said[said.length - 1].rate, '-45%');
  runner.handle('normal speed');
  assert.equal(runner.rate, 'normal');
});

test('time: warnings as it runs out, a pause stops the clock, and the exam ends when time is up', () => {
  const clock = { t: 0 };
  const { runner, ended, last } = sit({ settings: { timeLimitMin: 20 }, clock });
  runner.start();
  clock.t = 6 * 60000;
  runner.tick();
  assert.equal(last(), '15 minutes left.');
  runner.pause();
  clock.t = 60 * 60000; // a long break
  runner.tick();
  assert.deepEqual(ended, []);
  assert.equal(runner.handle('next').action, 'paused');
  runner.resume();
  runner.handle('how much time is left');
  assert.equal(last(), 'You have 14 minutes left.');
  clock.t += 10 * 60000;
  runner.tick();
  assert.equal(last(), '5 minutes left.');
  clock.t += 5 * 60000;
  runner.tick();
  assert.deepEqual(ended, ['time_up']);
});

test('every turn is recorded and saved: what was heard, what it did, what was written', () => {
  const { runner, events, saves } = sit();
  runner.start();
  runner.handle('answer');
  runner.handle('mitochondria');
  // What was heard comes first, then what it did
  const turns = events.filter(e => e.kind === 'heard' || e.kind === 'result')
    .map(e => (e.kind === 'heard' ? ['heard', e.heard] : ['result', e.detail, e.written]));
  assert.deepEqual(turns, [['heard', 'answer'], ['result', 'start_answer', null], ['heard', 'mitochondria'], ['result', 'write', 'mitochondria']]);
  assert.ok(events.some(e => e.kind === 'read_back' && e.said === 'Written: mitochondria'));
  assert.equal(saves[saves.length - 1].answers['1'].text, 'Mitochondria');
});

test('a sitting carries on from its saved state', () => {
  const first = sit();
  first.runner.start();
  first.runner.handle('next');
  first.runner.handle('answer');
  first.runner.handle('water moves across a membrane');
  const state = first.saves[first.saves.length - 1];
  const again = sit({ state });
  again.runner.start({ resumed: true });
  assert.equal(again.runner.item.key, '2a');
  assert.match(again.last(), /^Welcome back/);
  assert.equal(again.runner.answers['2a'].text, 'Water moves across a membrane');
});

test('"stop" stops the reading, and "help" says the commands for where the student is', () => {
  const { runner, last, stopped } = sit();
  runner.start();
  runner.handle('stop');
  assert.equal(stopped(), 1);
  runner.handle('help');
  assert.match(last(), /Go to question 5/);
  runner.handle('answer');
  runner.handle('what can I say');
  assert.match(last(), /everything you say is written down/);
});
