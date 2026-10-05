/**
 * Tests for building grounding cases from a screen read.
 * Run with: node --test tools/grounding-eval/cases-from-screen.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { casesFromScreen, visiblePart } from './lib/cases-from-screen.mjs';

const el = (type, name, rect, extra = {}) => ({ ref: name, type, name, rect, actions: ['invoke'], ...extra });

test('named controls become cases with boxes relative to the image', () => {
  const model = {
    app: 'WINWORD',
    elements: [
      el('Button', 'Save', [110, 60, 30, 20]),
      el('TabItem', 'Insert', [200, 40, 50, 20]),
      el('Text', 'Page 1', [300, 300, 60, 20]),          // not something you click
      el('Button', 'Close', [100, 50, 4, 4]),            // too small
      el('Button', 'Bold', [110, 60, 30, 20], { enabled: false }),
    ],
  };
  const cases = casesFromScreen(model, [100, 30, 800, 600], { image: 'images/w.png', prefix: 'word' });
  assert.deepEqual(cases, [
    { id: 'word-1', image: 'images/w.png', instruction: 'click the Save button', category: 'desktop', box: [10, 30, 30, 20], source: 'uia', app: 'WINWORD' },
    { id: 'word-2', image: 'images/w.png', instruction: 'click the Insert tab', category: 'desktop', box: [100, 10, 50, 20], source: 'uia', app: 'WINWORD' },
  ]);
});

test('ambiguous names, off-image and hidden controls are left out', () => {
  const model = {
    app: 'chrome',
    elements: [
      el('Hyperlink', 'More', [10, 10, 40, 20]),
      el('Hyperlink', 'more', [10, 50, 40, 20]),          // same name twice
      el('Hyperlink', 'Wikipedia', [900, 10, 80, 20]),    // outside the image
      el('Hyperlink', 'News', [10, 500, 40, 20]),         // under the overlay
      el('Hyperlink', 'Images', [10, 90, 50, 20]),
    ],
  };
  const cases = casesFromScreen(model, [0, 0, 800, 600], { image: 'i.png', prefix: 'c', covered: [0, 480, 400, 120] });
  assert.deepEqual(cases.map(c => c.instruction), ['click the Images link']);
  assert.equal(cases[0].category, 'web');
});

test('at most `max` cases, spread across the window', () => {
  const model = { app: 'x', elements: Array.from({ length: 30 }, (_, i) => el('Button', `B${i}`, [0, i * 20, 50, 15])) };
  const cases = casesFromScreen(model, [0, 0, 100, 1000], { image: 'i.png', prefix: 'x', max: 5 });
  assert.deepEqual(cases.map(c => c.instruction), ['click the B0 button', 'click the B6 button', 'click the B12 button', 'click the B18 button', 'click the B24 button']);
});

test('a maximized window is cropped to the screen', () => {
  assert.deepEqual(visiblePart([-11, -11, 2326, 1558], [0, 0, 2304, 1536]), [0, 0, 2304, 1536]);
  assert.equal(visiblePart([3000, 0, 100, 100], [0, 0, 2304, 1536]), null);
});
