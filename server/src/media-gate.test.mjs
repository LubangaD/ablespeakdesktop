/**
 * While music or a video plays (ws-proxy.js, Windows' media sessions), the
 * mic hears the song: only phrases with the name are acted on, except
 * pausing, skipping and the volume. And a command that ends in failures says
 * one plain sentence, never the tools' own messages (ai-engine.js).
 * Run with:  node --test src/media-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsProxy, isMediaCommand } from './ws-proxy.js';
import { AIEngine } from './ai-engine.js';

function makeProxy({ playing = true } = {}) {
  const media = { playing, apps: playing ? ['Spotify'] : [] };
  const proxy = new WsProxy({ server: { on: () => {} }, aiEngine: null, mediaState: async () => media });
  proxy._heartbeatInterval?.unref?.();
  const broadcasts = [];
  proxy._broadcastDashboard = (msg) => broadcasts.push(msg);
  let nextText = '';
  proxy.voiceHandler.transcribe = async () => ({ text: nextText });
  const handled = [];
  proxy._handleUtterance = async (_ws, text) => { handled.push(text); };
  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  const say = async (text) => { nextText = text; await proxy._processVoiceAudio(ws, { audio: 'a'.repeat(5000), mimeType: 'audio/webm' }); };
  return { proxy, media, broadcasts, handled, sent, say };
}

test('with a video playing, commands still work without the name; its narration does not', async () => {
  const { handled, say } = makeProxy();
  await say('Search for Michael Jackson on YouTube');
  await say('Skip the ad');
  await say('Click skip the ad.');
  await say('Such for Michael Jackson'); // sounds like a search: corrected later, so it passes here
  await say('save you time of never having to retrain AI on your brand to work for');
  assert.deepEqual(handled, ['Search for Michael Jackson on YouTube', 'Skip the ad', 'Click skip the ad.', 'Such for Michael Jackson']);
});

test('with music playing, the song is not taken as a command', async () => {
  const { handled, sent, broadcasts, say } = makeProxy();
  await say('It singsed me a melody in');
  assert.deepEqual(handled, []);
  assert.deepEqual([sent.at(-1).type, sent.at(-1).reason], ['voice_no_speech', 'media']);
  assert.equal(broadcasts.filter(b => b.type === 'voice_transcription').length, 0, 'nothing appears on the voice bar');
});

test('with music playing, "AbleSpeak, scroll down" runs "scroll down"', async () => {
  const { handled, say } = makeProxy();
  await say('Able speak, scroll down.');
  assert.deepEqual(handled, ['scroll down.']);
});

test('with music playing, the name counts after the song\'s words too', async () => {
  const { handled, say } = makeProxy();
  await say('It sang me a melody in. AbleSpeak, open Word.');
  assert.deepEqual(handled, ['open Word.']);
});

test('with music playing, "next song" and "volume down" need no name', async () => {
  const { handled, say } = makeProxy();
  await say('Next song.');
  await say('volume down');
  assert.deepEqual(handled, ['Next song.', 'volume down']);
});

test('with music playing, just "AbleSpeak" answers "Yes?" and the next phrase needs no name', async () => {
  const { handled, broadcasts, say } = makeProxy();
  await say('AbleSpeak.');
  assert.equal(broadcasts.find(b => b.type === 'chat_assistant_message')?.text, 'Yes?');
  await say('open Word');
  assert.deepEqual(handled, ['open Word']);
});

test('with nothing playing, everything is heard as before', async () => {
  const { handled, say } = makeProxy({ playing: false });
  await say('scroll down');
  assert.deepEqual(handled, ['scroll down']);
});

test('the music stops: the next phrase is heard without the name', async () => {
  const { handled, media, say } = makeProxy();
  await say('what time is it in London');
  media.playing = false;
  await say('what time is it in London');
  assert.deepEqual(handled, ['what time is it in London'], 'a question needs the name only while music plays');
});

test('saying AbleSpeak\'s own words again is heard; its voice coming back is not', async () => {
  const { proxy, handled, sent } = makeProxy({ playing: false });
  proxy.voiceHandler.transcribe = async () => ({ text: 'Play the current song.' });
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  const clip = afterVoiceMs => ({ audio: 'a'.repeat(5000), mimeType: 'audio/webm', afterVoiceMs });
  proxy._lastTTSText = 'Would you like me to play the current song on Spotify?';
  proxy._lastTTSTime = Date.now();
  await proxy._processVoiceAudio(ws, clip(200));
  assert.deepEqual(handled, [], 'began right after AbleSpeak spoke: its voice');
  await proxy._processVoiceAudio(ws, clip(6000));
  assert.deepEqual(handled, ['Play the current song.'], 'began seconds later: the person');
});

test('a long stretch of its own answer is caught even when the voice bar lost track of the time', async () => {
  const { proxy, handled, sent } = makeProxy({ playing: false });
  const answer = 'Michael Jackson was an American singer, songwriter and dancer. Known as the king of pop, he is one of the most significant cultural figures of the 20th century. His contributions to music, dance and fashion along with his publicised personal life made him a global figure in popular music.';
  proxy._lastTTSText = answer;
  proxy._lastTTSTime = Date.now();
  proxy.voiceHandler.transcribe = async () => ({ text: 'His contributions to music,dance and fashion along with his publicised personal life made him a global figure in popular music.' });
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  await proxy._processVoiceAudio(ws, { audio: 'a'.repeat(5000), mimeType: 'audio/webm', afterVoiceMs: 6000 });
  assert.deepEqual(handled, [], 'not taken as a command');
  assert.equal(sent.at(-1).type, 'voice_no_speech');
});

test('what can be said over music without the name', () => {
  for (const said of ['pause', 'Pos', 'Pose the song.', 'stop the music', 'next', 'skip this one', 'turn it down', 'volume up', 'AbleSpeak, mute'])
    assert.equal(isMediaCommand(said), true, said);
  for (const said of ['I want you to stop', 'scroll down', 'It singsed me a melody in', 'pause and then play it again from the start please'])
    assert.equal(isMediaCommand(said), false, said);
});

test('a command that ended in failures says one plain sentence, never the tools\' messages', () => {
  const summary = AIEngine.prototype._summarizeToolResults.call(null, [
    { tool: 'system_media_control', result: { status: 'error', message: 'Sent the key to Spotify but nothing started playing. Use click_desktop_element with name:"Play", app_name:"spotify" to click the Play button directly.' } },
    { tool: 'click_desktop_element', result: { status: 'error', message: 'I couldn\'t find "Play" in Spotify Premium.' } },
    { tool: 'uia_query', result: { status: 'success', message: '(focused, value "xpui.app.spotify.com) 42.393288.4.7.1.5 ComboBox "What do you want to play?"' } },
  ]);
  assert.equal(summary, 'I couldn\'t find "Play" in Spotify Premium.');
});

test('a failure a later step got past is not said', () => {
  const summary = AIEngine.prototype._summarizeToolResults.call(null, [
    { tool: 'system_media_control', result: { status: 'error', message: 'Sent the key to Spotify but nothing started playing.' } },
    { tool: 'uia_query', result: { status: 'success', message: '42.393288.4.7.1.7533 Button "Play"' } },
    { tool: 'uia_act', result: { status: 'success', message: 'Clicked Play' } },
  ]);
  assert.equal(summary, 'Clicked Play');
});
