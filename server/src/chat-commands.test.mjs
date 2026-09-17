/**
 * Tests for commands typed on the Chat page: they take the same route as
 * speech, "type this" types the words exactly, and the typing lands in the
 * student's app rather than in AbleSpeak's own windows.
 * Run with: node --test src/chat-commands.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WsProxy, parseTypeRequest } from './ws-proxy.js';
import { isOwnWindow, pickUserWindow, stopSystemTools } from './system-tools.js';

// Starting dictation reads the open windows through the PowerShell worker.
after(() => stopSystemTools());

const PARAGRAPH = 'The legend no longer covers the lines. Shorter line names: Issued, Expired, Attempts. The axis reads "Cumulative count" (one at the 9999-12-31 placeholder); the Expired total is unchanged.';

function makeProxy() {
  const proxy = new WsProxy({
    server: { on: () => {} },
    aiEngine: null,
    attribution: () => ({ session_id: 'session-1', student_id: 'student-1' }),
  });
  proxy._heartbeatInterval?.unref?.();
  const broadcasts = [];
  proxy._broadcastDashboard = (msg) => broadcasts.push(msg);

  const tools = [];
  const chats = [];
  proxy.aiEngine = {
    toolRegistry: {
      executeTool: async (tool, args) => {
        tools.push({ tool, args, student: proxy._voiceAttribution().student_id });
        return tool === 'system_type_text'
          ? { status: 'success', text: args.text, window: 'Document1 - Word' }
          : { status: 'success', message: `ran ${tool}` };
      },
    },
    processChat: async (text) => {
      chats.push(text);
      return { text: 'An answer.', toolCalls: [], provider: 'gemini', model: 'test', latency: 1 };
    },
  };

  const records = [];
  proxy._recordVoiceCommand = (record) => records.push({ ...record, student: proxy._voiceAttribution().student_id });

  const typedByDictation = [];
  proxy._dictateAndReport = async (text) => { typedByDictation.push(text); return null; };

  const ws = { send: () => {} };
  const chat = (text) => proxy._onChatCommand(ws, { type: 'chat_command', text });
  const replies = () => broadcasts.filter(m => m.type === 'chat_assistant_message');
  return { proxy, broadcasts, tools, chats, records, typedByDictation, chat, replies };
}

// ── "Type this" ────────────────────────────────────────────────────────────

test('"type this" with the words attached gives the words exactly', () => {
  assert.deepEqual(parseTypeRequest(`Type this: ${PARAGRAPH}`), { text: PARAGRAPH });
  assert.deepEqual(parseTypeRequest(`type the following\n${PARAGRAPH}\n`), { text: PARAGRAPH });
  assert.deepEqual(parseTypeRequest('Type: hello, world'), { text: 'hello, world' });
  assert.deepEqual(parseTypeRequest('please write this:\nLine one\nLine two'), { text: 'Line one\nLine two' });
});

test('a bare "type this" asks for the words', () => {
  for (const said of ['Type this', 'type this.', 'Type', 'can you type something for me?', 'write the following:', 'Please type this out']) {
    assert.deepEqual(parseTypeRequest(said), { ask: true }, said);
  }
});

test('other sentences with "type" are left to the other commands', () => {
  for (const said of ['type hello world in Notepad', 'what type of file is this', 'open Word and type my name', 'Typed it', PARAGRAPH]) {
    assert.equal(parseTypeRequest(said), null, said);
  }
});

test('"Type this", then the text in the next message, types the text as it was sent', async () => {
  const { chat, tools, chats, replies } = makeProxy();
  await chat('Type this');
  assert.equal(replies().at(-1).text, 'What should I type? Send the words next.');
  assert.equal(tools.length, 0);

  await chat(PARAGRAPH);
  assert.deepEqual(tools.map(t => [t.tool, t.args.text]), [['system_type_text', PARAGRAPH]]);
  assert.equal(chats.length, 0, 'the AI is not asked about the text');
  const reply = replies().at(-1);
  assert.equal(reply.text, `Typed ${PARAGRAPH.split(/\s+/).length} words into Document1 - Word.`);
  assert.equal(reply.silent, true, 'the paragraph is not read aloud');
  assert.equal(reply.error, false);
});

test('only the message right after "type this" is typed', async () => {
  const { chat, tools, chats } = makeProxy();
  await chat('Type this');
  await chat('hello there');
  await chat('what time is it');
  assert.deepEqual(tools.map(t => t.args.text), ['hello there']);
  assert.deepEqual(chats, ['what time is it']);
});

test('"stop" after "type this" cancels it', async () => {
  const { chat, tools } = makeProxy();
  await chat('Type this');
  await chat('stop');
  await chat('what time is it');
  assert.equal(tools.length, 0);
});

test('"type this: …" types at once', async () => {
  const { chat, tools } = makeProxy();
  await chat(`Type this: ${PARAGRAPH}`);
  assert.deepEqual(tools.map(t => t.args.text), [PARAGRAPH]);
});

test('a failed typing is reported, and spoken', async () => {
  const { proxy, chat, replies } = makeProxy();
  proxy.aiEngine.toolRegistry.executeTool = async () => ({ status: 'error', message: 'There is no app open to type into.' });
  await chat('Type this: hello');
  const reply = replies().at(-1);
  assert.equal(reply.error, true);
  assert.equal(reply.silent, false);
  assert.match(reply.text, /no app open/);
});

// ── The same route as speech ───────────────────────────────────────────────

test('a typed quick command runs without the AI', async () => {
  const { chat, tools, chats } = makeProxy();
  await chat('scroll down');
  assert.equal(tools.length, 1);
  assert.equal(chats.length, 0);
});

test('typed commands never count as the student\'s', async () => {
  const { chat, tools, records, proxy } = makeProxy();
  await chat('scroll down');
  await chat('Type this: hi');
  assert.deepEqual(tools.map(t => t.student), [null, null]);
  assert.deepEqual(records.map(r => r.student), [null, null]);
  assert.equal(records[1].payload.source, 'chat');
  // Speech from the overlay still does.
  proxy._turnSource = 'overlay';
  assert.equal(proxy._voiceAttribution().student_id, 'student-1');
});

test('typed text in dictation is typed as it is, and "stop dictation" ends it', async () => {
  const { chat, proxy, typedByDictation } = makeProxy();
  await chat('start dictation');
  assert.equal(proxy._dictationMode, true);
  await chat('The dash and the full stop stay words, comma.');
  assert.deepEqual(typedByDictation, ['The dash and the full stop stay words, comma.']);
  await chat('stop dictation');
  assert.equal(proxy._dictationMode, false);
});

test('while asleep, a typed command is told why nothing happened', async () => {
  const { chat, tools, replies, proxy } = makeProxy();
  await chat('go to sleep');
  assert.equal(proxy._sleeping, true);
  await chat('scroll down');
  assert.equal(tools.length, 0);
  assert.match(replies().at(-1).text, /asleep/);
  await chat('wake up');
  assert.equal(proxy._sleeping, false);
});

test('a typed command waits for the voice command in progress, then runs', async () => {
  const { chat, tools, proxy } = makeProxy();
  const voiceTurn = proxy._beginVoiceTurn();
  const pending = chat('scroll down');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tools.length, 0);
  proxy._endVoiceTurn(voiceTurn);
  await pending;
  assert.equal(tools.length, 1);
  assert.equal(proxy._voiceProcessing, false);
});

test('"stop" typed during a task stops it; anything else is told to wait', async () => {
  const { chat, replies, proxy } = makeProxy();
  proxy._agentRunning = true;
  await chat('open Word');
  assert.match(replies().at(-1).text, /Still working/);
  assert.equal(proxy._agentCancelled, false);
  await chat('stop');
  assert.equal(proxy._agentCancelled, true);
});

// ── Which window gets the typing ───────────────────────────────────────────

const WINDOWS = [
  { hwnd: '10', pid: '500', title: 'AbleSpeak — Voice Command Center' },
  { hwnd: '11', pid: '500', title: 'AbleSpeak Overlay' },
  { hwnd: '12', pid: '900', title: 'Program Manager' },
  { hwnd: '13', pid: '700', title: 'Document1 - Word' },
  { hwnd: '14', pid: '800', title: 'Inbox - Outlook' },
];

test('AbleSpeak\'s own windows are never where typing goes', () => {
  assert.equal(isOwnWindow(WINDOWS[0], 500), true);
  assert.equal(isOwnWindow({ hwnd: '20', pid: '500', title: 'AbleSpeak needs an API key' }, 500), true);
  assert.equal(isOwnWindow({ hwnd: '21', pid: '600', title: 'AbleSpeak — Voice Command Center - Google Chrome' }, 500), true);
  assert.equal(isOwnWindow(WINDOWS[3], 500), false);
  // A student's own file named after the app is still theirs.
  assert.equal(isOwnWindow({ hwnd: '22', pid: '700', title: 'AbleSpeak notes.docx - Word' }, 500), false);
});

test('the app used last is the first window behind AbleSpeak', () => {
  assert.equal(pickUserWindow(WINDOWS, 500).title, 'Document1 - Word');
  assert.equal(pickUserWindow(WINDOWS.slice(0, 3), 500), null);
});
