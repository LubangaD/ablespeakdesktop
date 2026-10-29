/**
 * Per-app profiles (the Voqal library's idea): Gmail and Notepad with their
 * own rules and what they show, YouTube's sponsor parts (SponsorBlock) and
 * moving in a video, Notepad's text rewritten and put back by "undo that".
 * Run with:  node --test src/app-profiles.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describeProfiles } from './app-profiles.js';
import { sponsorSegments, segmentToSkip, nextSegment, clearSponsorCache } from './sponsorblock.js';
import { setDocumentText, isTextApp } from './document-text.js';
import { ToolRegistry } from './tool-registry.js';
import { WsProxy } from './ws-proxy.js';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('sponsor parts are looked up by a hash prefix, never the video id, and only skippable ones kept', async () => {
  clearSponsorCache();
  const asked = [];
  const fetchImpl = async url => {
    asked.push(url);
    return json(200, [
      { videoID: 'otherVideo1', segments: [{ category: 'sponsor', segment: [1, 2] }] },
      { videoID: 'abcdefghijk', segments: [
        { category: 'selfpromo', segment: [300.4, 330.6], actionType: 'skip' },
        { category: 'sponsor', segment: [65, 130.2] },
        { category: 'sponsor', segment: [10, 12], actionType: 'mute' },
        { category: 'music_offtopic', segment: [0, 5] },
      ] },
    ]);
  };
  const segments = await sponsorSegments('abcdefghijk', { fetchImpl });
  assert.deepEqual(segments, [{ category: 'sponsor', start: 65, end: 130 }, { category: 'selfpromo', start: 300, end: 331 }]);
  const prefix = createHash('sha256').update('abcdefghijk').digest('hex').slice(0, 4);
  assert.match(asked[0], new RegExp(`/api/skipSegments/${prefix}\\?`));
  assert.ok(!asked[0].includes('abcdefghijk'), 'the video id itself is never sent');
  await sponsorSegments('abcdefghijk', { fetchImpl });
  assert.equal(asked.length, 1, 'kept for 10 minutes');
  assert.deepEqual(await sponsorSegments('nothingHere', { fetchImpl: async () => json(404, null) }), []);
  assert.deepEqual(await sponsorSegments('brokenVideo', { fetchImpl: async () => { throw new Error('offline'); } }), []);
  assert.deepEqual(await sponsorSegments('bad id!'), [], 'not a video id: not asked');
  assert.equal(segmentToSkip(segments, 70).end, 130, 'inside one');
  assert.equal(segmentToSkip(segments, 62).start, 65, 'one starting in a moment');
  assert.equal(segmentToSkip(segments, 200), null);
  assert.equal(nextSegment(segments, 200).start, 300);
});

test('"skip the sponsor" jumps to the end of the part playing, or says when the next one is', async () => {
  clearSponsorCache();
  await sponsorSegments('abcdefghijk', { fetchImpl: async () => json(200, [{ videoID: 'abcdefghijk', segments: [{ category: 'sponsor', segment: [65, 130] }] }]) });
  const tools = new ToolRegistry();
  let at = 70;
  const sent = [];
  const hub = {
    sendToolToExtension: async (type, payload) => {
      sent.push(payload);
      if (payload.action === 'state') return { status: 'success', page: 'watch', videoId: 'abcdefghijk', currentTime: at };
      return { status: 'success', at: payload.to };
    },
  };
  const skipped = await tools.executeTool('youtube_skip_sponsor', {}, hub);
  assert.equal(skipped.message, 'Skipped the sponsor.');
  assert.deepEqual(sent.at(-1), { action: 'seek', to: 130 });
  at = 20;
  assert.equal((await tools.executeTool('youtube_skip_sponsor', {}, hub)).message, 'There’s no sponsor right now. The next one is at 1:05.');
  await tools.executeTool('youtube_seek', { seconds: -10 }, hub);
  assert.deepEqual(sent.at(-1), { action: 'seek', by: -10 });
  await tools.executeTool('youtube_seek', { to: 0 }, hub);
  assert.deepEqual(sent.at(-1), { action: 'seek', to: 0 });
});

test('the AI sees Gmail: its rules, the inbox with ids, or the open email', () => {
  const inbox = describeProfiles({
    gmail: {
      status: 'success', view: 'inbox', unread: 1, account: { name: 'Test Student', email: 'student@example.com' },
      emails: [
        { id: ':r1', from: 'Ms Wanjiku', subject: 'Exam timetable', date: 'Fri, Oct 17', snippet: 'The timetable is attached', unread: true },
        { id: ':r3', from: 'Coach Otieno', subject: 'Practice', unread: false },
      ],
    },
  }).join('\n');
  assert.match(inbox, /## Gmail — the student is in Gmail \(Test Student, student@example\.com\)/);
  assert.match(inbox, /Never press Send unless the student says to send it/);
  assert.match(inbox, /Inbox — 1 unread of 2 on screen/);
  assert.match(inbox, /1\. UNREAD — Ms Wanjiku: "Exam timetable" \(Fri, Oct 17\) — The timetable is attached \| id: :r1/);
  const open = describeProfiles({
    gmail: { status: 'success', view: 'email', email: { subject: 'Exam timetable', messages: [{ from: 'Ms Wanjiku', fromEmail: 'w@school.example', text: 'Exams start Monday.' }] } },
  }).join('\n');
  assert.match(open, /The open email: "Exam timetable"/);
  assert.match(open, /From Ms Wanjiku <w@school\.example>:\nExams start Monday\./);
  assert.deepEqual(describeProfiles({}), [], 'nothing when not in these apps');
});

test('the AI sees Notepad’s text with its rules, and YouTube’s sponsor parts', () => {
  const notes = describeProfiles({ screenModel: { app: 'Notepad', document: { text: 'My essay about Nairobi.', chars: 23 } } }).join('\n');
  assert.match(notes, /## Notepad — its text now \(23 characters\)/);
  assert.match(notes, /set_document_text with the whole new text/);
  assert.match(notes, /"""\nMy essay about Nairobi\.\n"""/);
  assert.match(describeProfiles({ screenModel: { document: { text: '', chars: 0 } } }).join('\n'), /\(Notepad is empty\)/);
  const yt = describeProfiles({
    youtube: { status: 'success', page: 'watch', title: 'Thriller', currentTime: 70, duration: 600, sponsors: [{ category: 'sponsor', start: 65, end: 130 }], videos: [] },
  }).join('\n');
  assert.match(yt, /Sponsor parts viewers marked \(SponsorBlock\): sponsor 1:05–2:10\. "Skip the sponsor": youtube_skip_sponsor\./);
  assert.match(yt, /youtube_seek/);
});

test('Notepad’s text is replaced only in Notepad, keeping the old text for "undo that"', async () => {
  assert.ok(isTextApp('Notepad') && isTextApp('notepad.exe') && !isTextApp('WINWORD'));
  const doc = { ref: '1.2', type: 'Document', actions: ['read_text', 'set_value'] };
  const calls = [];
  const act = async args => { calls.push(args); return args.action === 'read_text' ? { status: 'success', text: 'old text' } : { status: 'success' }; };
  const notepad = { status: 'success', app: 'Notepad', window: 'notes - Notepad', elements: [doc] };
  const done = await setDocumentText('new text', { act, model: notepad });
  assert.equal(done.status, 'success');
  assert.deepEqual(done.undo, { tool: 'set_document_text', args: { text: 'old text' } });
  assert.deepEqual(calls.at(-1), { ref: '1.2', action: 'set_value', value: 'new text', log: false });
  const word = await setDocumentText('x', { act, model: { ...notepad, app: 'WINWORD', window: 'Essay - Word' } });
  assert.match(word.message, /only rewrite the text in Notepad, and Essay - Word is in front/);
  const readOnly = await setDocumentText('x', { act, model: { ...notepad, elements: [{ ...doc, actions: ['read_text'] }] } });
  assert.equal(readOnly.status, 'error');
});

test('"undo that" after an AI edit puts the old text back, and a second undo goes further back', async () => {
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null });
  proxy._heartbeatInterval?.unref?.();
  const ran = [];
  proxy.aiEngine = { toolRegistry: { executeTool: async (tool, args) => { ran.push([tool, args]); return { status: 'success' }; } } };
  proxy._autoFocusBrowser = () => {};
  proxy._recordAction({ tool: 'open_url', args: {}, result: { status: 'success' } });
  proxy._recordAction({ tool: 'set_document_text', args: { text: 'new' }, result: { status: 'success', undo: { tool: 'set_document_text', args: { text: 'old' } } } });
  assert.equal(await proxy._undoLast(), true);
  assert.deepEqual(ran.at(-1), ['set_document_text', { text: 'old' }]);
  await proxy._undoLast();
  assert.deepEqual(ran.at(-1), ['go_back', {}], 'then the page before');
});

test('Gmail is read for the AI only in Gmail, never in privacy mode, and its tools only there', async () => {
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null });
  proxy._heartbeatInterval?.unref?.();
  proxy.extensionClients.add({});
  const asked = [];
  proxy.sendToolToExtension = async (type, payload) => { asked.push([type, payload.action]); return { status: 'success', view: 'inbox', emails: [] }; };
  const gmail = { url: 'https://mail.google.com/mail/u/0/#inbox' };
  assert.equal((await proxy._gmailContext(gmail)).view, 'inbox');
  assert.equal(await proxy._gmailContext({ url: 'https://www.google.com/' }), null);
  proxy._privacyMode = true;
  assert.equal(await proxy._gmailContext(gmail), null);
  assert.deepEqual(asked, [['gmail', 'state']]);
  const names = ctx => new ToolRegistry().getToolsForContext(ctx, 'read my email').map(t => t.name);
  assert.ok(names({ activeTab: gmail }).includes('gmail_open_email'));
  assert.ok(!names({ activeTab: { url: 'https://www.google.com/' } }).includes('gmail_open_email'));
  assert.ok(names({ screenModel: { app: 'Notepad' } }).includes('set_document_text'));
  assert.ok(!names({ screenModel: { app: 'WINWORD' } }).includes('set_document_text'));
});
