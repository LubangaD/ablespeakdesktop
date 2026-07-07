import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTranscript, isProtectedApplication, requiresConfirmation, parseConfirmationReply } from './safety.js';

// ── classifyTranscript ──

test('classifyTranscript: SILENCE → no_speech empty text', () => {
  const r = classifyTranscript('SILENCE');
  assert.equal(r.status, 'no_speech');
  assert.equal(r.text, '');
});

test('classifyTranscript: silence. → no_speech', () => {
  const r = classifyTranscript('silence.');
  assert.equal(r.status, 'no_speech');
  assert.equal(r.text, '');
});

test('classifyTranscript: silence! → no_speech', () => {
  const r = classifyTranscript('silence!');
  assert.equal(r.status, 'no_speech');
});

test('classifyTranscript: empty string → no_speech', () => {
  const r = classifyTranscript('');
  assert.equal(r.status, 'no_speech');
  assert.equal(r.text, '');
});

test('classifyTranscript: whitespace only → no_speech', () => {
  const r = classifyTranscript('   ');
  assert.equal(r.status, 'no_speech');
  assert.equal(r.text, '');
});

test('classifyTranscript: null → no_speech', () => {
  const r = classifyTranscript(null);
  assert.equal(r.status, 'no_speech');
  assert.equal(r.text, '');
});

test('classifyTranscript: undefined → no_speech', () => {
  const r = classifyTranscript(undefined);
  assert.equal(r.status, 'no_speech');
  assert.equal(r.text, '');
});

test('classifyTranscript: normal text → ok with trimmed text', () => {
  const r = classifyTranscript('  open YouTube  ');
  assert.equal(r.status, 'ok');
  assert.equal(r.text, 'open YouTube');
});

test('classifyTranscript: silence mid-sentence → ok', () => {
  const r = classifyTranscript('break the silence');
  assert.equal(r.status, 'ok');
  assert.equal(r.text, 'break the silence');
});

test('classifyTranscript: SILENCE case-insensitive', () => {
  assert.equal(classifyTranscript('SILENCE').status, 'no_speech');
  assert.equal(classifyTranscript('Silence').status, 'no_speech');
  assert.equal(classifyTranscript('silence').status, 'no_speech');
});

// ── isProtectedApplication ──

test('isProtectedApplication: chrome → true', () => {
  assert.equal(isProtectedApplication('chrome'), true);
});

test('isProtectedApplication: brave → true', () => {
  assert.equal(isProtectedApplication('brave'), true);
});

test('isProtectedApplication: edge → true', () => {
  assert.equal(isProtectedApplication('edge'), true);
});

test('isProtectedApplication: firefox → true', () => {
  assert.equal(isProtectedApplication('firefox'), true);
});

test('isProtectedApplication: safari → true', () => {
  assert.equal(isProtectedApplication('safari'), true);
});

test('isProtectedApplication: opera → true', () => {
  assert.equal(isProtectedApplication('opera'), true);
});

test('isProtectedApplication: Google Chrome mixed case → true', () => {
  assert.equal(isProtectedApplication('Google Chrome'), true);
});

test('isProtectedApplication: FIREFOX uppercase → true', () => {
  assert.equal(isProtectedApplication('FIREFOX'), true);
});

test('isProtectedApplication: Spotify → false', () => {
  assert.equal(isProtectedApplication('Spotify'), false);
});

test('isProtectedApplication: Notepad → false', () => {
  assert.equal(isProtectedApplication('Notepad'), false);
});

// ── requiresConfirmation ──

test('requiresConfirmation: close_application Spotify → required + exact prompt', () => {
  const r = requiresConfirmation('close_application', { app_name: 'Spotify' });
  assert.equal(r.required, true);
  assert.equal(r.prompt, 'Close Spotify — yes or no?');
});

test('requiresConfirmation: close_application Chrome → not required (browser)', () => {
  const r = requiresConfirmation('close_application', { app_name: 'Chrome' });
  assert.equal(r.required, false);
});

test('requiresConfirmation: close_application Firefox → not required (browser)', () => {
  const r = requiresConfirmation('close_application', { app_name: 'Firefox' });
  assert.equal(r.required, false);
});

test('requiresConfirmation: scroll → not required', () => {
  const r = requiresConfirmation('scroll', { direction: 'down' });
  assert.equal(r.required, false);
});

test('requiresConfirmation: open_url → not required', () => {
  const r = requiresConfirmation('open_url', { url: 'https://example.com' });
  assert.equal(r.required, false);
});

test('requiresConfirmation: send_system_keys Alt+F4 → required + prompt', () => {
  const r = requiresConfirmation('send_system_keys', { keys: 'Alt+F4' });
  assert.equal(r.required, true);
  assert.equal(r.prompt, 'Press alt+f4 — yes or no?');
});

test('requiresConfirmation: send_system_keys ALT + F4 (spaces) → required', () => {
  const r = requiresConfirmation('send_system_keys', { keys: 'ALT + F4' });
  assert.equal(r.required, true);
  assert.equal(r.prompt, 'Press alt+f4 — yes or no?');
});

test('requiresConfirmation: send_system_keys ctrl+w → required', () => {
  const r = requiresConfirmation('send_system_keys', { keys: 'Ctrl+W' });
  assert.equal(r.required, true);
});

test('requiresConfirmation: send_system_keys ctrl+shift+w → required', () => {
  const r = requiresConfirmation('send_system_keys', { keys: 'Ctrl+Shift+W' });
  assert.equal(r.required, true);
});

test('requiresConfirmation: send_system_keys ctrl+f4 → required', () => {
  const r = requiresConfirmation('send_system_keys', { keys: 'Ctrl+F4' });
  assert.equal(r.required, true);
});

test('requiresConfirmation: send_system_keys Ctrl+C → not required', () => {
  const r = requiresConfirmation('send_system_keys', { keys: 'Ctrl+C' });
  assert.equal(r.required, false);
});

test('requiresConfirmation: send_system_keys Ctrl+S → not required', () => {
  const r = requiresConfirmation('send_system_keys', { keys: 'Ctrl+S' });
  assert.equal(r.required, false);
});

// ── parseConfirmationReply ──

test('parseConfirmationReply: yes → yes', () => {
  assert.equal(parseConfirmationReply('yes'), 'yes');
});

test('parseConfirmationReply: yeah → yes', () => {
  assert.equal(parseConfirmationReply('yeah'), 'yes');
});

test('parseConfirmationReply: yep → yes', () => {
  assert.equal(parseConfirmationReply('yep'), 'yes');
});

test('parseConfirmationReply: yup → yes', () => {
  assert.equal(parseConfirmationReply('yup'), 'yes');
});

test('parseConfirmationReply: sure → yes', () => {
  assert.equal(parseConfirmationReply('sure'), 'yes');
});

test('parseConfirmationReply: confirm → yes', () => {
  assert.equal(parseConfirmationReply('confirm'), 'yes');
});

test('parseConfirmationReply: ok → yes', () => {
  assert.equal(parseConfirmationReply('ok'), 'yes');
});

test('parseConfirmationReply: okay → yes', () => {
  assert.equal(parseConfirmationReply('okay'), 'yes');
});

test('parseConfirmationReply: do it → yes', () => {
  assert.equal(parseConfirmationReply('do it'), 'yes');
});

test('parseConfirmationReply: go ahead → yes', () => {
  assert.equal(parseConfirmationReply('go ahead'), 'yes');
});

test('parseConfirmationReply: no → no', () => {
  assert.equal(parseConfirmationReply('no'), 'no');
});

test('parseConfirmationReply: nope → no', () => {
  assert.equal(parseConfirmationReply('nope'), 'no');
});

test('parseConfirmationReply: nah → no', () => {
  assert.equal(parseConfirmationReply('nah'), 'no');
});

test('parseConfirmationReply: cancel → no', () => {
  assert.equal(parseConfirmationReply('cancel'), 'no');
});

test('parseConfirmationReply: stop → no', () => {
  assert.equal(parseConfirmationReply('stop'), 'no');
});

test("parseConfirmationReply: don't → no", () => {
  assert.equal(parseConfirmationReply("don't"), 'no');
});

test('parseConfirmationReply: dont → no', () => {
  assert.equal(parseConfirmationReply('dont'), 'no');
});

test('parseConfirmationReply: never mind → no', () => {
  assert.equal(parseConfirmationReply('never mind'), 'no');
});

test('parseConfirmationReply: negative → no', () => {
  assert.equal(parseConfirmationReply('negative'), 'no');
});

test('parseConfirmationReply: yes no wait → unclear (both matched)', () => {
  assert.equal(parseConfirmationReply('yes no wait'), 'unclear');
});

test('parseConfirmationReply: banana → unclear (neither matched)', () => {
  assert.equal(parseConfirmationReply('banana'), 'unclear');
});

test('parseConfirmationReply: case insensitive YES → yes', () => {
  assert.equal(parseConfirmationReply('YES'), 'yes');
});

test('parseConfirmationReply: case insensitive NO → no', () => {
  assert.equal(parseConfirmationReply('NO'), 'no');
});

test('parseConfirmationReply: case insensitive Yeah → yes', () => {
  assert.equal(parseConfirmationReply('Yeah'), 'yes');
});

test('parseConfirmationReply: empty string → unclear', () => {
  assert.equal(parseConfirmationReply(''), 'unclear');
});
