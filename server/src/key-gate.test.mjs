/**
 * The safety gate (ToolRegistry.executeTool) for keys that send or delete
 * only in some apps: it finds the app the keys would go to and the browser's
 * tab, asks first in Outlook, webmail and File Explorer, and asks anyway when
 * it can't tell where the key would land (test script SF-08, WRK-10).
 * Nothing is pressed for real and no window is read: the key tools and
 * registry.keyTarget are replaced.
 * Run with:  node --test src/key-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from './tool-registry.js';

function makeRegistry({ front = null, keyTarget } = {}) {
  const registry = new ToolRegistry();
  const pressed = [];
  registry.tools = registry.tools.map(tool => (['send_system_keys', 'press_key_combination'].includes(tool.name)
    ? { ...tool, execute: async (args) => { pressed.push({ tool: tool.name, args }); return { status: 'success' }; } }
    : tool));
  const seen = { lookups: 0 };
  registry.keyTarget = keyTarget || (async () => { seen.lookups++; return front; });
  return { registry, pressed, seen };
}

const hub = (tabUrl = null) => ({ _pendingConfirmation: null, browserContext: { activeTab: tabUrl ? { url: tabUrl } : null } });

test('Ctrl+Enter with Outlook in front asks first, and runs after "yes"', async () => {
  const { registry, pressed } = makeRegistry({ front: { process: 'outlook', title: 'Inbox - Outlook' } });
  const h = hub();
  const result = await registry.executeTool('send_system_keys', { keys: 'Ctrl+Enter' }, h);
  assert.equal(result.status, 'needs_confirmation');
  assert.match(result.prompt, /^Send this\?/);
  assert.deepEqual(pressed, []);
  assert.deepEqual(h._pendingConfirmation.args, { keys: 'Ctrl+Enter' }, 'the keys to press, nothing added');
  await registry.executeTool('send_system_keys', h._pendingConfirmation.args, h, { confirmed: true });
  assert.deepEqual(pressed, [{ tool: 'send_system_keys', args: { keys: 'Ctrl+Enter' } }]);
});

test('Ctrl+Enter with Word in front is pressed at once', async () => {
  const { registry, pressed } = makeRegistry({ front: { process: 'winword', title: 'Essay - Word' } });
  const h = hub();
  assert.equal((await registry.executeTool('send_system_keys', { keys: 'Ctrl+Enter' }, h)).status, 'success');
  assert.equal(pressed.length, 1);
  assert.equal(h._pendingConfirmation, null);
});

test('Delete asks first in File Explorer, not in Notepad', async () => {
  const explorer = makeRegistry({ front: { process: 'explorer', title: 'Documents' } });
  const asked = await explorer.registry.executeTool('send_system_keys', { keys: 'Delete' }, hub());
  assert.equal(asked.status, 'needs_confirmation');
  assert.match(asked.prompt, /^Delete this\?/);
  assert.deepEqual(explorer.pressed, []);
  const notepad = makeRegistry({ front: { process: 'notepad', title: 'notes.txt - Notepad' } });
  assert.equal((await notepad.registry.executeTool('send_system_keys', { keys: 'Delete' }, hub())).status, 'success');
  assert.deepEqual(notepad.pressed, [{ tool: 'send_system_keys', args: { keys: 'Delete' } }]);
});

test('Ctrl+Enter in Chrome asks first on Gmail, not in Google Docs', async () => {
  const { registry, pressed } = makeRegistry({ front: { process: 'chrome', title: 'Inbox - Gmail' } });
  const gmail = hub('https://mail.google.com/mail/u/0/#inbox');
  assert.equal((await registry.executeTool('send_system_keys', { keys: 'Ctrl+Enter' }, gmail)).status, 'needs_confirmation');
  assert.equal((await registry.executeTool('press_key_combination', { key: 'Enter', ctrl: true }, gmail)).status, 'needs_confirmation');
  const docs = hub('https://docs.google.com/document/d/1');
  assert.equal((await registry.executeTool('send_system_keys', { keys: 'Ctrl+Enter' }, docs)).status, 'success');
  assert.equal((await registry.executeTool('press_key_combination', { key: 'Enter', ctrl: true }, docs)).status, 'success');
  assert.equal(pressed.length, 2);
});

test('when the app in front can\'t be found, it asks anyway', async () => {
  const lookups = {
    'no window found': async () => null,
    'no process name': async () => ({ process: '', title: 'Something' }),
    'the lookup failed': async () => { throw new Error('PowerShell busy'); },
  };
  for (const [why, keyTarget] of Object.entries(lookups)) {
    const { registry, pressed } = makeRegistry({ keyTarget });
    assert.equal((await registry.executeTool('send_system_keys', { keys: 'Ctrl+Enter' }, hub())).status, 'needs_confirmation', why);
    assert.equal((await registry.executeTool('send_system_keys', { keys: 'Delete' }, hub())).status, 'needs_confirmation', why);
    assert.equal((await registry.executeTool('send_system_keys', { keys: 'Ctrl+D' }, null)).status, 'needs_confirmation', `${why}, no hub`);
    assert.deepEqual(pressed, [], why);
  }
});

test('a lookup that never answers asks anyway, without waiting for ever', async () => {
  const { registry, pressed } = makeRegistry({ keyTarget: () => new Promise(() => {}) });
  const started = Date.now();
  assert.equal((await registry.executeTool('send_system_keys', { keys: 'Alt+S' }, hub())).status, 'needs_confirmation');
  assert.ok(Date.now() - started < 4000, 'gave up on the lookup');
  assert.deepEqual(pressed, []);
});

test('other keys are pressed without looking up the app in front', async () => {
  const { registry, pressed, seen } = makeRegistry({ front: { process: 'outlook', title: 'Inbox - Outlook' } });
  for (const keys of ['Ctrl+C', 'Tab', 'Ctrl+Z']) {
    assert.equal((await registry.executeTool('send_system_keys', { keys }, hub())).status, 'success', keys);
  }
  assert.equal(seen.lookups, 0, 'no window lookup for an ordinary key');
  assert.equal(pressed.length, 3);
});

test('Enter looks at what is in front: it asks in a "replace?" box, and just presses elsewhere (24 Oct 2026)', async () => {
  const box = makeRegistry({ front: { process: 'notepad', title: 'Confirm Save As' } });
  const asked = await box.registry.executeTool('send_system_keys', { keys: 'Enter' }, hub());
  assert.equal(asked.status, 'needs_confirmation');
  assert.match(asked.prompt, /Replace the existing file/);
  assert.equal(box.pressed.length, 0);

  const notepad = makeRegistry({ front: { process: 'notepad', title: 'notes.txt - Notepad' } });
  assert.equal((await notepad.registry.executeTool('send_system_keys', { keys: 'Enter' }, hub())).status, 'success');
  assert.equal(notepad.seen.lookups, 1);
  assert.equal(notepad.pressed.length, 1);
});
