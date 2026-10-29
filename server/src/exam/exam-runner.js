/**
 * Runs one student's exam by voice, with no AI anywhere in it: a fixed set
 * of spoken commands reads the paper and moves between questions, and while
 * the student is answering, their words are written down as they said them.
 *
 * The runner only decides; the host does the rest through callbacks:
 *   say(text, { rate })   speak to the student
 *   record(event)         add to the exam's audit trail
 *   save(snapshot)        keep the answers (after every change)
 *   finish(reason)        the exam is over ('finished' | 'time_up')
 *   stopSpeech()          stop what is being said
 */
import { answerItems, findItem } from './paper-parse.js';
import {
  spokenToText, appendToAnswer, dropLastWord, dropLastSentence, lastSentence,
  forSpeech, spellOut, lettersToWord, digits,
} from './spoken-text.js';
import { isNegative } from '../safety.js';

/** The whole reply is a yes — nothing more, nothing less. */
const STRICT_YES = /^(?:yes|yeah|yes please|yes i am sure|yes i'm sure|yes finish(?: the| my)?(?: exam)?|finish(?: the| my)? exam|yes clear(?: it| my answer)?|clear it)$/;

/** Reading speeds, slowest first, as Edge TTS rates. */
export const RATES = { slowest: '-45%', slower: '-25%', normal: '+0%', faster: '+20%' };
const RATE_ORDER = Object.keys(RATES);

const LETTER_NAMES = { a: 'A', ay: 'A', eh: 'A', b: 'B', be: 'B', bee: 'B', c: 'C', see: 'C', sea: 'C', si: 'C', d: 'D', dee: 'D', e: 'E', ee: 'E', f: 'F', ef: 'F', eff: 'F' };
const LETTER = `(${Object.keys(LETTER_NAMES).join('|')})`;

const PUNCTUATION_NAMES = { '.': 'full stop', ',': 'comma', '?': 'question mark', '!': 'exclamation mark', ':': 'colon', ';': 'semicolon', '(': 'open bracket', ')': 'close bracket', '“': 'open quote', '”': 'close quote', '-': 'hyphen' };

/** ".\n\n" → "full stop, new paragraph" — so marks on their own are heard. */
function punctuationNames(piece) {
  return piece.replace(/\n\n/g, '¶').split('')
    .map(c => (c === '¶' ? 'new paragraph' : c === '\n' ? 'new line' : PUNCTUATION_NAMES[c]))
    .filter(Boolean).join(', ');
}

/** Spoken words, ready to compare with a command. */
export function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:able ?speak|please|okay|ok|um|uh|erm)\s+)+/, '')
    .replace(/\s+please$/, '');
}

// ── The commands ──

const SAY_IT_AGAIN = /^(?:(?:read|repeat|say)(?: it| that| the question)?(?: again)?|say that again|pardon|come again|sorry what|what was the question)$/;
const READ_ANSWER = /^(?:(?:read|repeat)(?: back)? (?:my |the )?(?:whole )?answer|read (?:it )?back|what (?:did|have) i (?:write|written|say|said))$/;
const SPEED = {
  slower: /^(?:slower|slow down|speak slower|read slower|more slowly|speak more slowly)$/,
  faster: /^(?:faster|speed up|speak faster|read faster|more quickly)$/,
  normal: /^(?:normal speed|normal speaking speed|speak normally)$/,
};
const STOP_TALKING = /^(?:stop|quiet|be quiet|silence|stop talking|stop reading|shh+|hush)$/;
const TIME = /^(?:how much time(?: is| do i have)?(?: left)?|time left|how long (?:do i have|is left)|what time is it|time)$/;
const WHERE = /^(?:where am i|which question(?: am i on| is this)?|what question(?: is this| am i on)?)$/;
const UNANSWERED = /^(?:unanswered(?: questions)?|which questions (?:are left|have i not answered|haven't i answered|are unanswered|have no answer)|what (?:have i not|haven't i) answered|questions left|what is left)$/;
const HELP = /^(?:help|what can i say|commands|what are the commands|what do i say)$/;
const MATHS_ON = /^(?:maths?) (?:mode )?on$|^(?:start|turn on|use) maths?(?: mode)?$/;
const MATHS_OFF = /^(?:maths?) (?:mode )?off$|^(?:stop|turn off) maths?(?: mode)?$/;
const FINISH = /^(?:(?:finish|submit|end|hand in|complete)(?: the| my)? exam|i(?:'m| am) (?:done|finished) with the exam|i have finished the exam)$/;
const CLEAR = /^(?:clear|delete|erase|remove)(?: my| the)?(?: whole)? answer$/;
const END_ANSWER = /^(?:stop answer(?:ing)?|end(?: my| the)? answer|finish(?: my| the)? answer|done|i'?m done|that'?s (?:it|my answer|all)|stop writing|end of answer|save(?: my)? answer)$/;

export class ExamRunner {
  constructor({ paper, settings = {}, state = null, say, record, save, finish, stopSpeech = () => {}, now = () => Date.now() }) {
    this.paper = paper;
    this.items = answerItems(paper);
    this.settings = { timeLimitMin: null, readBack: true, ...settings };
    this._say = say;
    this._record = record || (() => {});
    this._save = save || (() => {});
    this._finish = finish || (() => {});
    this._stopSpeech = stopSpeech;
    this.now = now;

    const s = state || {};
    this.index = Math.min(Math.max(0, s.index || 0), Math.max(0, this.items.length - 1));
    this.answers = s.answers || {};
    this.rate = RATES[s.rate] ? s.rate : 'normal';
    this.maths = !!s.maths;
    this.startedAt = s.startedAt ?? null;
    this.pausedMs = s.pausedMs || 0;
    this.pausedAt = s.pausedAt ?? null;
    this.warned = new Set(s.warned || []);
    // browse | answering | confirm_finish | confirm_clear | finished — a student
    // who was answering when the app closed is still answering when it opens
    this.mode = s.finishedReason ? 'finished' : s.mode === 'answering' ? 'answering' : 'browse';
    this._lastBeat = 0;
    this.finishedReason = s.finishedReason || null;
    this.returnMode = 'browse';
    this.lastHeard = null;
    this.lastSaid = null;
    this.history = {}; // key → earlier versions of the answer, for "undo"
  }

  // ── Where we are ──

  get item() { return this.items[this.index]; }
  answerOf(key = this.item?.key) { return this.answers[key] || (this.answers[key] = { text: '', choice: null }); }
  unitOf(key = this.item?.key) {
    const found = findItem(this.paper, key);
    return found ? (found.part || found.question) : null;
  }
  isMultipleChoice(key = this.item?.key) { return !!this.unitOf(key)?.options?.length; }
  answered(key) {
    const a = this.answers[key];
    return !!(a && (a.choice || a.text?.trim()));
  }
  unansweredItems() { return this.items.filter(i => !this.answered(i.key)); }

  remainingMs() {
    if (!this.settings.timeLimitMin || this.startedAt == null) return null;
    const paused = this.pausedMs + (this.pausedAt ? this.now() - this.pausedAt : 0);
    return Math.max(0, this.settings.timeLimitMin * 60000 - (this.now() - this.startedAt - paused));
  }

  snapshot() {
    return {
      index: this.index,
      itemKey: this.item?.key || null,
      itemLabel: this.item?.label || null,
      total: this.items.length,
      mode: this.mode,
      answers: this.answers,
      rate: this.rate,
      maths: this.maths,
      startedAt: this.startedAt,
      pausedMs: this.pausedMs,
      pausedAt: this.pausedAt,
      warned: [...this.warned],
      remainingMs: this.remainingMs(),
      answeredCount: this.items.length - this.unansweredItems().length,
      lastHeard: this.lastHeard,
      lastSaid: this.lastSaid,
      finishedReason: this.finishedReason,
    };
  }

  // ── Speaking ──

  say(text, kind = 'say') {
    const spoken = String(text || '').replace(/\s+/g, ' ').trim();
    if (!spoken) return;
    this.lastSaid = spoken;
    this._say(spoken, { rate: RATES[this.rate] });
    this._record({ kind, item: this.item?.key || null, said: spoken });
  }

  /** "Question 2, part a. Define osmosis. 2 marks." — and the options, and what is answered. */
  itemSpeech(index = this.index, { withStem = true } = {}) {
    const item = this.items[index];
    if (!item) return '';
    const { question, part, intro } = findItem(this.paper, item.key);
    const unit = part || question;
    const parts = [`${item.label}.`];
    if (part && withStem && question.text) parts.push(forSpeech(question.text));
    if (intro?.text) parts.push(forSpeech(intro.text));
    if (unit.text) parts.push(forSpeech(unit.text));
    if (unit.marks) parts.push(`${unit.marks} ${unit.marks === 1 ? 'mark' : 'marks'}.`);
    if (unit.options?.length) parts.push(this.optionsSpeech(unit));
    if (unit.picture || (part && question.picture)) parts.push('This question has a picture or diagram that I cannot read. Ask your invigilator to describe it.');
    const a = this.answers[item.key];
    if (a?.choice) parts.push(`You chose ${a.choice}.`);
    else if (a?.text?.trim()) parts.push('You have written an answer. Say "read my answer" to hear it.');
    return parts.join(' ').replace(/([.?!])\s*\./g, '$1');
  }

  optionsSpeech(unit) {
    return unit.options.map(o => `Option ${o.letter}: ${forSpeech(o.text)}.`).join(' ').replace(/([.?!])\./g, '$1');
  }

  readItem() {
    this.say(this.itemSpeech(), 'read');
  }

  // ── Start, pause, time ──

  start({ resumed = false } = {}) {
    if (this.startedAt == null) this.startedAt = this.now();
    const intro = [];
    if (resumed) {
      intro.push(`Welcome back. Your exam, ${this.paper.title}, carries on where you were.`);
      if (this.pausedAt) intro.push('It is paused: please wait for your invigilator.');
      else if (this.mode === 'answering') intro.push(`You were answering ${this.item.label}: what you say is added to your answer. Say "done" when you have finished.`);
    } else {
      intro.push(`This is your exam: ${this.paper.title}. It has ${this.items.length} ${this.items.length === 1 ? 'question' : 'questions'} to answer.`);
      if (this.settings.timeLimitMin) intro.push(`You have ${this.minutesSpeech(this.settings.timeLimitMin * 60000)}.`);
      intro.push('Say "help" at any time to hear what you can say. Say "answer" when you are ready to answer a question.');
    }
    this._record({ kind: resumed ? 'resume' : 'start', item: this.item?.key || null });
    this.say(`${intro.join(' ')} ${this.itemSpeech()}`, 'read');
    this._save(this.snapshot());
  }

  pause() {
    if (this.pausedAt || this.mode === 'finished') return;
    this.pausedAt = this.now();
    this._record({ kind: 'pause', item: this.item?.key || null });
    this.say('Your exam is paused. The clock has stopped.');
    this._save(this.snapshot());
  }

  resume() {
    if (!this.pausedAt) return;
    this.pausedMs += this.now() - this.pausedAt;
    this.pausedAt = null;
    this._record({ kind: 'unpause', item: this.item?.key || null });
    this.say(`Your exam carries on. ${this.itemSpeech()}`, 'read');
    this._save(this.snapshot());
  }

  minutesSpeech(ms) {
    const minutes = Math.ceil(ms / 60000);
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60), m = minutes % 60;
      return `${h} ${h === 1 ? 'hour' : 'hours'}${m ? ` and ${m} ${m === 1 ? 'minute' : 'minutes'}` : ''}`;
    }
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }

  /** Called every few seconds: warnings as time runs out, and the end of the exam. */
  tick() {
    if (this.mode === 'finished' || this.pausedAt) return;
    // A heartbeat: if the app stops, a carried-on sitting knows when it stopped
    if (this.now() - this._lastBeat >= 30000) {
      this._lastBeat = this.now();
      this._save(this.snapshot());
    }
    const left = this.remainingMs();
    if (left === null) return;
    if (left <= 0) {
      this.say('Time is up. The exam has ended, and your answers are saved.');
      this.end('time_up');
      return;
    }
    for (const mins of [1, 5, 15, 30]) {
      if (left <= mins * 60000 && this.settings.timeLimitMin > mins && !this.warned.has(mins)) {
        // Only the most urgent warning is said, if several are due at once
        for (const m of [1, 5, 15, 30]) if (m >= mins) this.warned.add(m);
        this.say(`${mins} ${mins === 1 ? 'minute' : 'minutes'} left.`, 'time_warning');
        this._save(this.snapshot());
        break;
      }
    }
  }

  end(reason) {
    if (this.mode === 'finished') return;
    this.mode = 'finished';
    this.finishedReason = reason;
    this._record({ kind: 'finish', item: this.item?.key || null, detail: reason });
    this._save(this.snapshot());
    this._finish(reason);
  }

  // ── What the student said ──

  /** Something the student said. Returns what it was taken as. */
  handle(heard) {
    const text = String(heard || '').trim();
    if (!text) return { action: 'nothing' };
    this.tick(); // time that has run out ends the exam before anything more is written
    this.lastHeard = text;
    const n = normalise(text);
    const item = this.item?.key || null;
    // What was heard first, then what it did: the audit trail reads cause, then effect
    this._record({ kind: 'heard', item, heard: text });
    let result;
    if (this.mode === 'finished') {
      this.say('This exam has finished. Your teacher has your answers.');
      result = { action: 'finished' };
    } else if (this.pausedAt) {
      this.say('Your exam is paused. Please wait for your invigilator.');
      result = { action: 'paused' };
    } else if (this.mode === 'confirm_finish' || this.mode === 'confirm_clear') {
      result = this._confirm(text);
    } else if (this.mode === 'answering') {
      result = this._whileAnswering(text, n);
    } else {
      result = this._command(text, n);
    }
    this._record({ kind: 'result', item, detail: result.action, written: result.written ?? null });
    this._save(this.snapshot());
    return result;
  }

  _confirm(text) {
    const which = this.mode;
    // Only a plain yes: "okay, let me check one more thing" must not end the exam
    if (STRICT_YES.test(normalise(text))) {
      if (which === 'confirm_finish') {
        this.say('Your exam is finished, and your answers are saved. Well done.');
        this.end('finished');
        return { action: 'finish' };
      }
      this._remember();
      this.answerOf().text = '';
      this.answerOf().choice = null;
      this.mode = this.returnMode;
      this.say(`Your answer to ${this.item.label} is cleared.`);
      return { action: 'clear', written: '' };
    }
    this.mode = this.returnMode;
    this.say(which === 'confirm_finish' ? 'Okay, the exam carries on.' : 'Okay, your answer is kept.');
    return { action: isNegative(text) ? 'no' : 'cancel' };
  }

  /** The commands that work the same whether or not the student is answering. */
  _common(n) {
    if (STOP_TALKING.test(n)) { this._stopSpeech(); return { action: 'stop_speaking' }; }
    if (HELP.test(n)) { this.say(this.helpSpeech()); return { action: 'help' }; }
    for (const [rate, re] of Object.entries(SPEED)) {
      if (!re.test(n)) continue;
      const i = RATE_ORDER.indexOf(this.rate);
      if (rate === 'slower' && i === 0) { this.say('This is the slowest I can read.'); return { action: 'speed_slowest' }; }
      if (rate === 'faster' && i === RATE_ORDER.length - 1) { this.say('This is the fastest I can read.'); return { action: 'speed_fastest' }; }
      this.rate = rate === 'normal' ? 'normal' : RATE_ORDER[i + (rate === 'slower' ? -1 : 1)];
      this.say('Is this speed better?');
      return { action: `speed_${this.rate}` };
    }
    if (TIME.test(n)) {
      const left = this.remainingMs();
      this.say(left === null ? 'This exam has no time limit.' : `You have ${this.minutesSpeech(left)} left.`);
      return { action: 'time' };
    }
    if (WHERE.test(n)) {
      this.say(`You are on ${this.item.label}, number ${this.index + 1} of ${this.items.length}.${this.mode === 'answering' ? ' You are answering it.' : ''}`);
      return { action: 'where' };
    }
    if (UNANSWERED.test(n)) {
      const left = this.unansweredItems();
      this.say(left.length === 0 ? 'You have answered every question.'
        : `${left.length} not answered yet: ${left.map(i => i.label.replace(/^Question /, '')).join('; ')}.`);
      return { action: 'unanswered' };
    }
    if (MATHS_ON.test(n)) { this.maths = true; this.say('Maths mode is on. Say things like "x squared plus 3".'); return { action: 'maths_on' }; }
    if (MATHS_OFF.test(n)) { this.maths = false; this.say('Maths mode is off.'); return { action: 'maths_off' }; }
    if (READ_ANSWER.test(n)) {
      const a = this.answers[this.item.key];
      this.say(a?.choice ? `You chose ${a.choice}.` : a?.text?.trim() ? `Your answer: ${forSpeech(a.text)}` : 'You have not answered this question yet.');
      return { action: 'read_answer' };
    }
    const spell = n.match(/^spell (?:out )?(my answer|the answer|it|that|the last word|last word)$/);
    if (spell) {
      const a = this.answers[this.item.key]?.text?.trim() || '';
      const word = /answer/.test(spell[1]) ? a : (a.match(/(\S+)\s*$/)?.[1] || '').replace(/[.,;:?!”)]+$/, '');
      this.say(word ? spellOut(word) : 'There is nothing written to spell yet.');
      return { action: 'spell_answer' };
    }
    if (FINISH.test(n)) {
      this.returnMode = this.mode;
      const left = this.unansweredItems();
      this.mode = 'confirm_finish';
      this.say(`${left.length ? `You have ${left.length} ${left.length === 1 ? 'question' : 'questions'} with no answer. ` : 'You have answered every question. '}Do you want to finish your exam now? Say yes or no.`);
      return { action: 'confirm_finish' };
    }
    if (CLEAR.test(n)) {
      if (!this.answered(this.item.key)) { this.say('There is no answer to clear.'); return { action: 'clear_nothing' }; }
      this.returnMode = this.mode;
      this.mode = 'confirm_clear';
      this.say(`Clear your whole answer to ${this.item.label}? Say yes or no.`);
      return { action: 'confirm_clear' };
    }
    return null;
  }

  _command(text, n) {
    const common = this._common(n);
    if (common) return common;

    if (SAY_IT_AGAIN.test(n)) { this.readItem(); return { action: 'read' }; }
    if (/^(?:read|repeat|say)(?: the)? (?:options|choices|answers)(?: again)?$/.test(n)) {
      const unit = this.unitOf();
      this.say(unit.options?.length ? this.optionsSpeech(unit) : 'This question has no options. Say "answer" to write your answer.');
      return { action: 'read_options' };
    }
    const optionRead = n.match(new RegExp(`^read (?:option|choice) ${LETTER}$`));
    if (optionRead) {
      const o = this.unitOf().options?.find(x => x.letter === LETTER_NAMES[optionRead[1]]);
      this.say(o ? `Option ${o.letter}: ${forSpeech(o.text)}` : `There is no option ${LETTER_NAMES[optionRead[1]]}.`);
      return { action: 'read_option' };
    }
    if (/^read(?: the)? instructions$/.test(n)) {
      this.say(this.paper.instructions?.length ? forSpeech(this.paper.instructions.join('. ')) : 'This paper has no instructions.');
      return { action: 'instructions' };
    }
    if (/^(?:next|next question|go on|continue|move on|go forward|go to the next question)$/.test(n)) return this._move(this.index + 1);
    if (/^(?:previous|previous question|back|go back|go back one|the question before)$/.test(n)) return this._move(this.index - 1);
    if (/^(?:first question|go to the first question)$/.test(n)) return this._move(0);
    if (/^(?:last question|go to the last question|final question)$/.test(n)) return this._move(this.items.length - 1);

    const goTo = n.match(/^(?:go to |take me to |jump to |open )?(?:question|number) (.+)$/);
    if (goTo) {
      const target = this.findTarget(goTo[1]);
      if (target === null) { this.say(`I could not find question ${goTo[1]}. Say "how many questions" to hear how many there are.`); return { action: 'not_found' }; }
      return this._move(target);
    }
    if (/^how many questions/.test(n)) {
      this.say(`There are ${this.items.length} questions to answer. You are on number ${this.index + 1}.`);
      return { action: 'count' };
    }

    // A choice: "answer B", "option C", or the letter on its own
    if (this.isMultipleChoice()) {
      const choice = n.match(new RegExp(`^(?:(?:my )?answer(?: is)?|option|choice|choose|select|pick|i choose|i pick|i think it'?s|the answer is|it'?s|it is|letter) ${LETTER}$`)) || n.match(new RegExp(`^${LETTER}$`));
      if (choice) return this._choose(LETTER_NAMES[choice[1]]);
      if (/^(?:answer|start answer|my answer)$/.test(n)) {
        this.say('Say "answer" and a letter, for example "answer B".');
        return { action: 'choice_needed' };
      }
    }

    // Start answering: "answer", or "my answer is …" straight away
    if (/^(?:answer|start answer(?:ing)?|begin(?: my)? answer|write|start writing|write(?: my)? answer|answer (?:this|the question|this question))$/.test(n)) {
      return this._startAnswering();
    }
    const direct = text.match(/^\s*(?:my answer is|the answer is|answer|write)\s*[:,-]?\s+(.+)$/i);
    if (direct && !this.isMultipleChoice()) {
      this._startAnswering({ quiet: true });
      return this._write(direct[1]);
    }

    this.say('I did not understand that as a command. To write an answer, say "answer" first. Say "help" to hear the commands.', 'not_understood');
    return { action: 'not_understood' };
  }

  _whileAnswering(text, n) {
    if (END_ANSWER.test(n)) {
      this.mode = 'browse';
      const a = this.answers[this.item.key];
      this.say(a?.text?.trim() ? `Answer saved for ${this.item.label}. Say "next" for the next question.` : `You have not written anything for ${this.item.label}.`);
      return { action: 'end_answer' };
    }
    // Leaving the question ends answering — only if the move happens
    const leave = index => {
      const moved = this._move(index);
      if (moved.action === 'move') this.mode = 'browse';
      return moved;
    };
    if (/^(?:next|next question)$/.test(n)) return leave(this.index + 1);
    if (/^(?:previous|previous question)$/.test(n)) return leave(this.index - 1);
    if (/^(?:read|repeat)(?: the)? question(?: again)?$/.test(n)) { this.readItem(); return { action: 'read' }; }
    if (/^read(?: the)? last sentence$/.test(n)) {
      const s = lastSentence(this.answerOf().text);
      this.say(s ? forSpeech(s) : 'Nothing is written yet.');
      return { action: 'read_last_sentence' };
    }
    if (/^(?:delete|remove|erase)(?: the)? last word$/.test(n)) return this._edit(dropLastWord, 'delete_word', 'Last word deleted.');
    if (/^(?:(?:delete|remove|erase)(?: the)? last sentence|scratch that)$/.test(n)) return this._edit(dropLastSentence, 'delete_sentence', 'Last sentence deleted.');
    if (/^undo(?: that)?$/.test(n)) {
      const earlier = this.history[this.item.key]?.pop();
      if (earlier === undefined) { this.say('There is nothing to undo.'); return { action: 'undo_nothing' }; }
      this.answerOf().text = earlier;
      this.say('Undone.');
      return { action: 'undo', written: earlier };
    }
    // One word on its own is an answer here ("Time", "Help", "Quiet" can all
    // be answers); commands while answering take more than one word.
    if (n.includes(' ')) {
      const common = this._common(n);
      if (common) return common;
    }

    // "spell m i t o" writes a word letter by letter; "spelling mistakes are common" is just words
    const spelled = n.match(/^spell(?: out)? (.+)$/);
    const word = spelled && lettersToWord(spelled[1]);
    if (word) return this._write(word, { spelled: true });
    return this._write(text);
  }

  // ── Doing ──

  _move(index) {
    if (index < 0) { this.say('This is the first question.'); return { action: 'at_start' }; }
    if (index >= this.items.length) {
      const left = this.unansweredItems().length;
      this.say(`That was the last question. ${left ? `${left} ${left === 1 ? 'question has' : 'questions have'} no answer yet. Say "unanswered questions" to hear which.` : 'You have answered every question.'} Say "finish exam" when you are ready to finish.`);
      return { action: 'at_end' };
    }
    const sameQuestion = this.items[index].number === this.item?.number && index !== this.index;
    this.index = index;
    this.say(this.itemSpeech(index, { withStem: !sameQuestion }), 'read');
    return { action: 'move', to: this.item.key };
  }

  /**
   * Which item a spoken target means: "3", "three", "2 b", "two part b",
   * "2b", "4 i", "4 roman two", "b 1" (sections numbered B1, B2…).
   * A question with parts means its first part. null if there is none.
   */
  findTarget(spoken) {
    const ROMAN = { one: 'i', two: 'ii', three: 'iii', four: 'iv', five: 'v', 1: 'i', 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v' };
    const said = digits(String(spoken).toLowerCase()
      .replace(/\bpart\b/g, ' ')
      .replace(/\broman (?:numeral )?(\w+)/g, (_, w) => ` ${ROMAN[w] || w}`));
    const compact = said.replace(/[^a-z0-9]/g, '');
    if (!compact) return null;
    const plain = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let index = this.items.findIndex(i => plain(`${i.number}${i.part || ''}`) === compact);
    if (index === -1) index = this.items.findIndex(i => plain(i.number) === compact);
    return index === -1 ? null : index;
  }

  _choose(letter) {
    const unit = this.unitOf();
    const option = unit.options.find(o => o.letter === letter);
    if (!option) {
      this.say(`There is no option ${letter}. The options are ${unit.options.map(o => o.letter).join(', ')}.`);
      return { action: 'no_such_option' };
    }
    this.answerOf().choice = letter;
    this.say(`You chose ${letter}: ${forSpeech(option.text)}. Say "next" for the next question.`);
    return { action: 'choose', written: letter };
  }

  _startAnswering({ quiet = false } = {}) {
    this.mode = 'answering';
    if (!quiet) {
      const has = this.answerOf().text.trim();
      this.say(`Answering ${this.item.label}. ${has ? 'What you say is added to your answer.' : 'Speak your answer.'} Say "done" when you have finished.`);
    }
    return { action: 'start_answer' };
  }

  _remember() {
    const key = this.item.key;
    (this.history[key] || (this.history[key] = [])).push(this.answerOf().text);
  }

  _write(spoken, { spelled = false } = {}) {
    const piece = spelled ? spoken : spokenToText(spoken, { maths: this.maths });
    if (!piece) return { action: 'nothing' };
    this._remember();
    const a = this.answerOf();
    a.text = appendToAnswer(a.text, piece, { capitalise: !this.maths && !spelled });
    if (this.settings.readBack) {
      this.say(spelled ? `Written: ${piece}, spelled ${spellOut(piece)}.`
        : /[a-z0-9]/i.test(piece) ? `Written: ${forSpeech(piece)}`
          : `Written: ${punctuationNames(piece)}.`, 'read_back');
    }
    return { action: 'write', written: piece };
  }

  _edit(change, action, said) {
    const a = this.answerOf();
    if (!a.text.trim()) { this.say('Nothing is written yet.'); return { action: `${action}_nothing` }; }
    this._remember();
    a.text = change(a.text);
    this.say(said);
    return { action, written: a.text };
  }

  helpSpeech() {
    if (this.mode === 'answering') {
      return 'While you answer, everything you say is written down. You can say: done, when you have finished. '
        + 'Read my answer. Read the last sentence. Delete the last word. Delete the last sentence. Undo. '
        + 'Spell, then the letters, to write a word letter by letter. Say full stop, comma, question mark or new paragraph for punctuation. '
        + 'Maths on, for maths. Read the question. Next question.';
    }
    return 'You can say: read the question. Read the options. Next. Previous. Go to question 5. '
      + 'Answer, to start writing your answer, or answer and a letter, like answer B. Read my answer. Spell my answer. '
      + 'Slower, or faster. How much time is left. Where am I. Unanswered questions. Finish exam.';
  }
}
