/**
 * The text of a plain-text document in front (Notepad), read and replaced
 * through Windows accessibility, after the Voqal library's notepad profile:
 * the AI sees the text and edits it as asked ("make the second sentence
 * shorter"), and "undo that" puts the old text back.
 */
import { getScreenModel, findDocument, actOnElement } from './screen-model.js';

// Apps whose whole document the AI may read and rewrite (process names)
export const TEXT_APPS = new Set(['notepad']);
// As much of the text as goes to the AI with each command
export const MAX_DOCUMENT_CHARS = 6000;

/** "Notepad", "notepad.exe" → true. */
export function isTextApp(app) {
  return TEXT_APPS.has(String(app || '').toLowerCase().replace(/\.exe$/, ''));
}

/** The whole text of the document in the window in front, or null. */
export async function readDocumentText() {
  const read = await actOnElement({ action: 'read_text', value: 'all', log: false });
  return read?.status === 'success' ? { text: String(read.text ?? ''), window: read.window } : null;
}

/**
 * Replace the whole text of the document in front (Notepad only). The result
 * carries how to put the old text back (`undo`), for "undo that".
 */
export async function setDocumentText(text, { act = actOnElement, model = null } = {}) {
  const screen = model || await getScreenModel({ restore: true, maxElements: 400 });
  if (screen.status !== 'success') return screen;
  if (!isTextApp(screen.app)) {
    return { status: 'error', message: `I can only rewrite the text in Notepad, and ${screen.window} is in front.` };
  }
  const document = findDocument(screen);
  if (!document) return { status: 'error', message: `There is no document in ${screen.window}.` };
  if (!document.actions.includes('set_value')) {
    return { status: 'error', message: `The text in ${screen.window} can't be changed this way. Try dictation instead.` };
  }
  const before = await act({ ref: document.ref, action: 'read_text', value: 'all', log: false });
  const set = await act({ ref: document.ref, action: 'set_value', value: String(text ?? ''), log: false });
  if (set?.status !== 'success') return set;
  return {
    status: 'success',
    message: 'Changed the text.',
    ...(before?.status === 'success' ? { undo: { tool: 'set_document_text', args: { text: String(before.text ?? '') } } } : {}),
  };
}
