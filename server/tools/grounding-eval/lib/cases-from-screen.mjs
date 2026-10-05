/**
 * Ground-truth click cases from a screen read (Stage 0 grounding baseline).
 *
 * For apps that expose their controls, the screen model already knows each
 * control's name and box, so "click the Save button" needs no hand
 * labelling. These cases measure how well a vision model finds controls the
 * tree also knows — the tree-less apps still need annotator.html.
 */

const TYPE_WORDS = {
  Button: 'button',
  SplitButton: 'button',
  Hyperlink: 'link',
  TabItem: 'tab',
  MenuItem: 'menu item',
  CheckBox: 'checkbox',
  RadioButton: 'option',
  ListItem: 'item',
  TreeItem: 'item',
  ComboBox: 'dropdown',
  Edit: 'box',
  Slider: 'slider',
};

const BROWSERS = new Set(['chrome', 'msedge', 'brave', 'firefox', 'opera']);

const inside = ([x, y, w, h], [cx, cy, cw, ch]) => x >= cx && y >= cy && x + w <= cx + cw && y + h <= cy + ch;
const overlaps = ([x, y, w, h], [ox, oy, ow, oh]) => x < ox + ow && ox < x + w && y < oy + oh && oy < y + h;

/**
 * Pick up to `max` controls spread across the window and turn them into
 * cases with boxes relative to the captured image.
 *
 * @param {object} model       getScreenModel() result
 * @param {number[]} capture   [x, y, w, h] of the captured image on screen
 * @param {object} options     { image, prefix, max, covered } — `covered` is a
 *                             screen box hidden by another window (the overlay)
 */
export function casesFromScreen(model, capture, { image, prefix, max = 15, covered = null } = {}) {
  const usable = model.elements.filter(e =>
    TYPE_WORDS[e.type]
    && e.enabled !== false
    && e.name && e.name.trim().length > 0 && e.name.length <= 40
    && e.rect[2] >= 8 && e.rect[3] >= 8
    && inside(e.rect, capture)
    && !(covered && overlaps(e.rect, covered)));

  // A name that appears twice can't be one right answer.
  const seen = new Map();
  for (const e of usable) {
    const key = e.name.trim().toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const unique = usable.filter(e => seen.get(e.name.trim().toLowerCase()) === 1);

  const step = Math.max(1, unique.length / max);
  const picked = [];
  for (let i = 0; i < unique.length && picked.length < max; i += step) picked.push(unique[Math.floor(i)]);

  const category = BROWSERS.has(String(model.app).toLowerCase()) ? 'web' : 'desktop';
  return picked.map((e, i) => ({
    id: `${prefix}-${i + 1}`,
    image,
    instruction: `click the ${e.name.trim()} ${TYPE_WORDS[e.type]}`,
    category,
    box: [e.rect[0] - capture[0], e.rect[1] - capture[1], e.rect[2], e.rect[3]],
    source: 'uia',
    app: model.app,
  }));
}

/** The part of a window that is on screen. */
export function visiblePart([x, y, w, h], [sx, sy, sw, sh]) {
  const left = Math.max(x, sx);
  const top = Math.max(y, sy);
  const right = Math.min(x + w, sx + sw);
  const bottom = Math.min(y + h, sy + sh);
  return right > left && bottom > top ? [left, top, right - left, bottom - top] : null;
}
