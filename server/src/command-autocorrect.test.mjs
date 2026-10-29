/**
 * Command autocorrect (command-autocorrect.js) and dictation autocorrect
 * (ws-proxy.js _cleanDictation): what was misheard, corrected the way the
 * person meant it, and nothing else touched.
 * Run with:  node --test src/command-autocorrect.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autocorrectCommand, soundOf } from './command-autocorrect.js';
import { WsProxy } from './ws-proxy.js';
import { normaliseProfile } from './student-profile.js';

test('a phrase that sounds like a command becomes that command', () => {
  const fixed = said => autocorrectCommand(said)?.phrase ?? null;
  assert.equal(fixed('Pose the song'), 'pause the song');
  assert.equal(fixed('close this tub'), 'close this tab');
  assert.equal(fixed('next sung'), 'next song');
  assert.equal(fixed('scroll dawn'), 'scroll down');
  assert.equal(fixed('open ward'), 'open word');
  assert.equal(fixed('AbleSpeak, voluum up'), 'volume up');
});

test('questions, song lyrics and other talk are left alone', () => {
  for (const said of ['What is the weather', 'Can you tell me who Michael Jackson is', 'I wonder if you remember',
    'there is so many', 'This is not a picture fun', 'Next week, next week', 'I', 'the'])
    assert.equal(autocorrectCommand(said), null, said);
});

test('two different commands sounding alike: not guessed', () => {
  assert.equal(autocorrectCommand('play the song'), null, 'not turned into "pause the song"');
});

test('only commands that work on this page are suggested, and each says what it does', () => {
  const youtube = { activeUrl: 'https://www.youtube.com/watch?v=abc' };
  assert.equal(autocorrectCommand('nex video'), null, 'not on YouTube: "next video" can’t run here');
  assert.equal(autocorrectCommand('nex video', youtube)?.phrase, 'next video');
  assert.deepEqual(autocorrectCommand('nex video', youtube).action, { tool: 'youtube_next_video', args: {} });
  assert.deepEqual(autocorrectCommand('scroll town').action, { tool: 'scroll', args: { direction: 'down' } });
  assert.equal(autocorrectCommand('such for michael jackson').action.tool, 'search_web');
});

test('the same tool the other way is a different command: a near tie between them is not guessed', () => {
  // "start dictation" / "stop dictation" and "scroll down again" / "scroll up again"
  // are each one tool doing opposite things: between them, the AI decides
  for (const between of ['stat dictation', 'scroll dap again']) {
    const tie = autocorrectCommand(between);
    assert.equal(tie, null, `"${between}" guessed as "${tie?.phrase}"`);
  }
  assert.equal(autocorrectCommand('sturt dictation')?.phrase, 'start dictation', 'clearly one of them: still corrected');
  assert.equal(autocorrectCommand('stup dictation')?.phrase, 'stop dictation');
  // Words that mean the same action are never a tie: "pause the song" / "pause the music" do the same
  assert.equal(autocorrectCommand('pose the sung')?.phrase, 'pause the song');
});

test('sounds, not spelling: voiced and voiceless alike', () => {
  assert.equal(soundOf('pause'), soundOf('pose'));
  assert.equal(soundOf('tab'), soundOf('tub'));
  assert.equal(soundOf('down'), soundOf('dawn'));
  assert.notEqual(soundOf('song'), soundOf('week'));
});

test('a misheard command runs as the command, and the voice bar shows what was understood', async () => {
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null });
  proxy._heartbeatInterval?.unref?.();
  const ran = [];
  const shown = [];
  proxy.aiEngine = {
    toolRegistry: { executeTool: async (name, args) => { ran.push([name, args]); return { status: 'success' }; } },
    processChat: async () => { ran.push(['ai']); return { text: '', toolCalls: null }; },
  };
  proxy._broadcastDashboard = msg => { if (msg.type === 'voice_transcription') shown.push(msg); };
  await proxy._handleUtterance({ send: () => {} }, 'close this tub');
  assert.equal(ran[0][0], 'close_tab');
  assert.equal(ran.length, 1, 'no AI call');
  assert.deepEqual([shown[0].text, shown[0].heard], ['close this tab', 'close this tub']);
});

function dictationProxy(listening = {}) {
  const profile = normaliseProfile({ listening, vocabulary: ['AbleSpeak'] }).profile;
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null, profile: () => profile });
  proxy._heartbeatInterval?.unref?.();
  const asked = [];
  proxy.aiEngine = {
    cleanDictation: async (heard, opts) => { asked.push({ heard, ...opts }); return { text: 'The AbleSpeak demo went well.', changed: true, ms: 600 }; },
  };
  return { proxy, asked };
}

test('dictation is autocorrected, with the person\'s words and what came before', async () => {
  const { proxy, asked } = dictationProxy();
  proxy._dictationTyped = 'Yesterday we visited KISE. ';
  assert.equal(await proxy._cleanDictation('the a bull speak demo went well'), 'The AbleSpeak demo went well.');
  assert.equal(asked[0].before, 'Yesterday we visited KISE. ');
  assert.deepEqual(asked[0].vocabulary, ['AbleSpeak']);
});

test('switched off, in an exam, or a very short phrase: typed as heard', async () => {
  const off = dictationProxy({ cleanUpDictation: false });
  assert.equal(await off.proxy._cleanDictation('the a bull speak demo'), 'the a bull speak demo');
  const exam = dictationProxy();
  exam.proxy.examSession = { active: true };
  assert.equal(await exam.proxy._cleanDictation('the a bull speak demo'), 'the a bull speak demo');
  const short = dictationProxy();
  assert.equal(await short.proxy._cleanDictation('hello there'), 'hello there');
  assert.equal(off.asked.length + exam.asked.length + short.asked.length, 0, 'Gemini never asked');
});
