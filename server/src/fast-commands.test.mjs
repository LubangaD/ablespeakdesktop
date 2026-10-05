/**
 * Tests for spoken searches: where "search for X" goes, and what is searched.
 * Run with: node --test src/fast-commands.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFastCommand } from './fast-commands.js';

test('a search from a new tab or an ordinary page is a new Google search', () => {
  for (const activeUrl of ['about:blank', 'chrome://newtab/', 'https://mail.google.com/mail/u/0/#inbox', '']) {
    assert.deepEqual(
      matchFastCommand('search for Michael Jackson', { activeUrl }),
      { tool: 'search_web', args: { query: 'michael jackson' }, silent: true },
      activeUrl || '(unknown tab)',
    );
  }
});

test('on a search page, a search happens again in its own search bar', () => {
  for (const activeUrl of [
    'https://www.google.com/search?q=cats',
    'https://www.youtube.com/results?search_query=cats',
    'https://en.wikipedia.org/wiki/Cat',
    'https://www.bing.com/search?q=cats',
  ]) {
    assert.equal(matchFastCommand('look up dogs', { activeUrl }).tool, 'search_in_page', activeUrl);
  }
});

test('where to search is not part of what is searched for', () => {
  assert.equal(matchFastCommand('search for Michael Jackson on Chrome').args.query, 'michael jackson');
  assert.equal(matchFastCommand('search the web for rain in Nairobi').args.query, 'rain in nairobi');
  assert.equal(matchFastCommand('google Kenya Airways online').args.query, 'kenya airways');
});

test('a YouTube search goes to YouTube', () => {
  assert.deepEqual(matchFastCommand('search for Thriller on YouTube'), { tool: 'search_youtube', args: { query: 'thriller' }, silent: true });
  assert.deepEqual(matchFastCommand('search YouTube for Sauti Sol'), { tool: 'search_youtube', args: { query: 'sauti sol' }, silent: true });
});

// ── Dictation: the many ways people ask for it ──

const startsDictation = said => {
  const r = matchFastCommand(said);
  return r?.tool === 'dictation_mode' && r.args.enabled === true;
};

test('every everyday way of asking to dictate starts dictation', () => {
  for (const said of [
    'start dictation', 'Start dictating.', 'st start dictating', 'starts typing', 'Begin dictation',
    "let's start writing", 'turn on dictation', 'Dictate', 'Dictate.', 'dictation mode',
    'Write this sentence', 'Write these sentences.', 'write this down', 'write the following',
    'Type this', 'type what I say', 'type as I speak', 'Can you type for me?', 'will you take dictation',
    'I want to dictate', 'Let me dictate.', 'I would like to write', 'take a note', 'take notes', 'note this down', 'voice typing',
  ]) assert.ok(startsDictation(said), said);
});

test('asking with the words already said starts dictation and types them', () => {
  const typed = said => matchFastCommand(said)?.args?.initialText;
  assert.equal(typed('start typing. My name is Derek Lubanga and I am excited'), 'My name is Derek Lubanga and I am excited');
  assert.equal(typed('Write this: My name is Derek Lubanga.'), 'My name is Derek Lubanga.');
  assert.equal(typed('Type the following, I love AbleSpeak.'), 'I love AbleSpeak.');
  assert.equal(typed('Write this sentence. The meeting is at noon.'), 'The meeting is at noon.');
  assert.equal(typed('Take a note: buy milk'), 'buy milk');
  assert.equal(typed('write down call mum tomorrow'), 'call mum tomorrow');
  assert.equal(typed('dictate My name is Derek.'), 'My name is Derek.');
});

test('stopping dictation, in several words', () => {
  for (const said of ['stop dictation', 'Stop dictating.', 'stop typing', 'stop writing', 'finish dictation', 'turn off dictation', 'done dictating']) {
    const r = matchFastCommand(said);
    assert.ok(r?.tool === 'dictation_mode' && r.args.enabled === false, said);
  }
});

test('ordinary typing and writing requests are not dictation', () => {
  for (const said of ['type hello', 'write an email to John', 'open Word', 'I was able to write it']) {
    assert.ok(!startsDictation(said), said);
  }
});
