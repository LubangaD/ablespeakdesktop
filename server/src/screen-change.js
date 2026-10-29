/**
 * Did the screen change after the AI acted? After ARTEMIS's "screen is
 * unchanged since step N" and "closely resembles step N" hints (Google,
 * Apache-2.0). ARTEMIS compares screenshots; AbleSpeak compares the window's
 * controls and their state, which needs no picture and nothing leaves the
 * computer.
 */
import { createHash } from 'crypto';

/**
 * A short fingerprint of a window's controls and their state, or null if it
 * wasn't read. `ignoreFocus` leaves out which control has keyboard focus:
 * when a dialog opens, focus leaves the main window before the dialog is
 * listed, and that flicker alone must not count as the screen having changed
 * (a Save As dialog was judged "not opened" that way, 24 Oct 2026).
 */
export function screenFingerprint(screen, { ignoreFocus = false } = {}) {
  if (!Array.isArray(screen?.elements)) return null;
  const lines = screen.elements.map(e => [
    e.type, e.name, e.value ?? '', e.toggled ?? '', e.expanded ?? '',
    e.selected ? 1 : 0, ignoreFocus ? '' : (e.focused ? 1 : 0), e.range?.[0] ?? '',
  ].join('~'));
  return createHash('sha1').update([screen.window || '', ...lines].join('\n')).digest('hex').slice(0, 16);
}

/**
 * What to tell the AI after a round of actions. `seen` holds the screen's
 * fingerprint before each round of this command, oldest first; the last one
 * is the screen just before this round. Empty when the screen changed to
 * something new, or when either read failed.
 */
export function screenChangeNote(seen, after) {
  const before = seen[seen.length - 1];
  if (!before || !after) return '';
  if (after === before) {
    return 'Screen check: nothing on the screen changed after these actions (same window, same controls). Do not repeat them: try a different way, or tell the person in one short sentence what you could not do.';
  }
  const back = seen.slice(0, -1).indexOf(after);
  if (back !== -1) {
    return `Screen check: the screen is back to how it was before step ${back + 1} of this command, so those steps went in a circle. Do not repeat them: try a different way, or tell the person what you could not do.`;
  }
  return '';
}
