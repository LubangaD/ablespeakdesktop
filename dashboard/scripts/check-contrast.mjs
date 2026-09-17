// Checks WCAG contrast for the text and surface colours in src/index.css
// (DESIGN.md "High-Contrast Assistive Rules"). Run: npm run check:contrast
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
const tokens = Object.fromEntries(
  [...root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map(([, name, hex]) => [name, hex.toLowerCase()])
);

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const surfaces = ['canvas', 'surface-1', 'surface-2', 'surface-3'];
// [foreground, minimum ratio]. 4.5 is WCAG AA for body text; titles and body
// text are held to AAA (7) on the canvas, as DESIGN.md asks.
const checks = [
  ['text-title', 7], ['text-primary', 7], ['text-secondary', 4.5],
  ['accent', 4.5], ['teal', 4.5], ['success', 4.5], ['warning', 4.5], ['error', 4.5],
];
// Teal text is only used on the canvas and levels 1–2; on level 3 it is 4.2:1,
// so keep it off that surface (icons and borders there are fine at 3:1).
const notUsed = new Set(['teal on surface-3']);
const pairs = [
  ...surfaces.flatMap(bg => checks
    .filter(([fg]) => !notUsed.has(`${fg} on ${bg}`))
    .map(([fg, min]) => [fg, bg, min])),
  ['on-accent', 'accent', 4.5],    // text on a primary button
  ['on-accent', 'teal', 4.5],      // text on a selected chip
];

// The student overlay has its own colours (server/overlay.html): each state
// colour is used for words and outcome text on the panel, so it needs 4.5:1.
const overlay = readFileSync(new URL('../../server/overlay.html', import.meta.url), 'utf8');
const overlayRoot = overlay.match(/:root\s*\{([\s\S]*?)\n\s*\}/)[1];
for (const [, name, hex] of overlayRoot.matchAll(/--(state-[a-z]+):\s*(#[0-9a-f]{6})\b/gi)) {
  tokens[`overlay-${name}`] = hex.toLowerCase();
  pairs.push([`overlay-${name}`, 'surface-1', 4.5]);
}

let failed = 0;
for (const [fg, bg, min] of pairs) {
  if (!tokens[fg] || !tokens[bg]) {
    console.error(`missing token: --${!tokens[fg] ? fg : bg}`);
    failed++;
    continue;
  }
  const ratio = contrast(tokens[fg], tokens[bg]);
  const ok = ratio >= min;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} --${fg} on --${bg}: ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
}
if (failed) {
  console.error(`\n${failed} colour pair(s) below the minimum.`);
  process.exit(1);
}
console.log('\nAll colour pairs pass.');
