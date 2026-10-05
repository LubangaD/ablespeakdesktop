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
