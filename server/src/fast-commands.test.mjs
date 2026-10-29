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

test('"open Word", "launch Spotify" open the app at once, without the AI', () => {
  for (const [said, app] of [['open word', 'word'], ['launch spotify', 'spotify'], ['start the calculator', 'calculator'],
    ['open my word document', 'word document'], ['open excel app', 'excel'], ['run vs code', 'vs code']]) {
    const r = matchFastCommand(said);
    assert.equal(r?.tool, 'open_application', said);
    assert.equal(r.args.app_name, app, said);
    assert.equal(r.silent, false, `${said} is said aloud, as before`);
  }
});

test('"open" with anything AbleSpeak cannot open by name still goes to the AI', () => {
  for (const said of ['open my email', 'open the file menu', 'open the first link', 'open youtube', 'open settings']) {
    const r = matchFastCommand(said);
    assert.notEqual(r?.tool, 'open_application', said);
  }
  assert.equal(matchFastCommand('start dictation')?.tool, 'dictation_mode', 'dictation still starts');
});

test('the person\'s folders open by name, without the AI (24 Oct 2026)', () => {
  for (const said of ['open the downloads folder', 'open documents', 'open my pictures']) {
    assert.equal(matchFastCommand(said)?.tool, 'open_application', said);
  }
});

test('ordinary typing and writing requests are not dictation', () => {
  for (const said of ['type hello', 'write an email to John', 'open Word', 'I was able to write it']) {
    assert.ok(!startsDictation(said), said);
  }
});

test('speech recognition spellings: number words, joined words, quotes and hyphens', () => {
  assert.deepEqual(matchFastCommand('Scroll down three.').args, { direction: 'down', amount: '1200' }, 'three scrolls of 400 px');
  assert.deepEqual(matchFastCommand('Pagedown').args, { direction: 'down', amount: '800' });
  assert.equal(matchFastCommand('newtab').tool, 'create_tab');
  assert.deepEqual(matchFastCommand('Press "escape"').args, { key: 'Escape' });
  assert.deepEqual(matchFastCommand('press-escape').args, { key: 'Escape' });
});

test('spoken numbers: compound words, scroll counts and a volume level', async () => {
  const { spokenNumber } = await import('./fast-commands.js');
  assert.equal(spokenNumber('twenty five'), 25);
  assert.equal(spokenNumber('twenty-five'), 25);
  assert.equal(spokenNumber('a hundred'), 100);
  assert.equal(spokenNumber('seventeen'), 17);
  assert.equal(spokenNumber('one direction'), null);
  assert.equal(spokenNumber('twenty twenty'), null);
  assert.deepEqual(matchFastCommand('scroll down twenty five').args, { direction: 'down', amount: '8000' }, 'capped at 20 scrolls');
  assert.equal(matchFastCommand('scroll down a lot'), null);
  assert.deepEqual(matchFastCommand('Set the volume to fifty.').args, { action: 'set', value: 50 });
  assert.deepEqual(matchFastCommand('volume 30 percent').args, { action: 'set', value: 30 });
  assert.deepEqual(matchFastCommand('volume up').args, { action: 'up' });
  assert.equal(matchFastCommand('search for one direction').args.query, 'one direction');
});

test('"skip the ad" presses YouTube\'s own Skip; plain "skip" is still the next song', () => {
  for (const said of ['Skip the ad', 'Click skip the ad.', 'skip ads', 'click skip', 'close this ad'])
    assert.deepEqual(matchFastCommand(said)?.args, { action: 'skip_ad' }, said);
  assert.equal(matchFastCommand('skip').tool, 'system_media_control');
});

test('"minimise this tab" minimises the window in front', () => {
  assert.deepEqual(matchFastCommand('Minimise this tab').args, { action: 'minimize' });
});

test('"scroll down again" is one more scroll', () => {
  assert.deepEqual(matchFastCommand('Scroll down again,'), { tool: 'scroll', args: { direction: 'down' }, silent: true });
  assert.deepEqual(matchFastCommand('scroll up a bit more').args, { direction: 'up' });
  assert.equal(matchFastCommand('scroll down again and again'), null);
});

test('play and pause are sent as said, so "play" never pauses a song that is playing', () => {
  assert.deepEqual(matchFastCommand('Play the current song on Spotify.').args, { action: 'play', app_name: 'spotify' });
  assert.deepEqual(matchFastCommand('pause spotify').args, { action: 'pause', app_name: 'spotify' });
  assert.deepEqual(matchFastCommand('resume the media player').args, { action: 'play' });
  assert.deepEqual(matchFastCommand('stop playback').args, { action: 'pause' });
  assert.equal(matchFastCommand('play new religion on spotify'), null, 'a song by name goes to the AI');
});
