/**
 * The account profile (profile.js, account.js) and usage analytics in Google
 * Analytics (analytics.js): details checked and saved on the account, the
 * photo in the account's private folder, consent first (a parent or guardian
 * under 18), and nothing personal ever sent to GA.
 * Run with:  node --test src/profile-analytics.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanProfile, cleanConsent, analyticsAllowed, photoFromDataUrl, profileOf, optionsFor, SUPABASE_SETUP_SQL } from './profile.js';
import { createAccount, createSecureStore } from './account.js';
import { createAnalytics, featureOf } from './analytics.js';

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')}`;

test('profile details are checked: lists, lengths, counties only in Kenya', () => {
  assert.deepEqual(cleanProfile({ full_name: '  Amina   Otieno ', role: 'student', age_group: '13_17', country: 'Kenya', county: 'Kisumu', school: 'Thika School for the Blind' }).fields,
    { full_name: 'Amina Otieno', school: 'Thika School for the Blind', role: 'student', age_group: '13_17', country: 'Kenya', county: 'Kisumu' });
  assert.match(cleanProfile({ role: 'hacker' }).errors[0], /Choose a role/);
  assert.match(cleanProfile({ full_name: 'x'.repeat(81) }).errors[0], /at most 80/);
  assert.equal(cleanProfile({ country: 'Uganda', county: 'Kisumu' }).fields.county, null);
  assert.deepEqual(cleanProfile({ school: '' }).fields, { school: null }, 'empty clears it');
  assert.deepEqual(cleanProfile({ email: 'x@y.z', avatar_path: 'other/avatar' }).fields, {}, 'only the profile’s own fields');
});

test('Developer is only for the AbleSpeak team’s (admin) accounts, and only offered to them', () => {
  assert.match(cleanProfile({ role: 'developer' }).errors[0], /only for the AbleSpeak team/);
  assert.deepEqual(cleanProfile({ role: 'developer' }, { team: true }).fields, { role: 'developer' });
  const roles = access => optionsFor(access).roles.map(([role]) => role);
  assert.ok(roles('admin').includes('developer'));
  assert.ok(!roles('helper').includes('developer') && !roles(null).includes('developer'));
  assert.ok(optionsFor(null, 'developer').roles.some(([role]) => role === 'developer'), 'a role already held still shows');
  assert.equal(profileOf({ app_metadata: { ablespeak_role: 'admin', provider: 'google' } }).access, 'admin');
  assert.equal(profileOf({ app_metadata: { ablespeak_role: 'owner' } }).access, null, 'only the known access levels');
});

test('analytics consent: an age group first, and a parent or guardian under 18', () => {
  assert.match(cleanConsent({ analytics: true }, null).error, /age group first/);
  assert.match(cleanConsent({ analytics: true }, '13_17').error, /parent or guardian/);
  const minor = cleanConsent({ analytics: true, guardian: true }, 'under_13', new Date('2026-10-19T10:00:00Z')).consent;
  assert.deepEqual(minor, { analytics: true, by: 'guardian', at: '2026-10-19T10:00:00.000Z', version: 1 });
  assert.equal(cleanConsent({ analytics: true }, '18_plus').consent.by, 'self');
  assert.equal(cleanConsent({ analytics: false }, null).consent.analytics, false, 'saying no needs nothing');
  assert.equal(analyticsAllowed({ age_group: '18_plus', analytics_consent: { analytics: true, by: 'self', version: 1 } }), true);
  assert.equal(analyticsAllowed({ age_group: '13_17', analytics_consent: { analytics: true, by: 'self', version: 1 } }), false, 'became a minor: a guardian must agree');
  assert.equal(analyticsAllowed({ age_group: '18_plus', analytics_consent: { analytics: true, by: 'self', version: 0 } }), false, 'an older consent asks again');
  assert.equal(analyticsAllowed({}), false, 'off until asked');
});

test('only real, small pictures are accepted as photos', () => {
  assert.equal(photoFromDataUrl(JPEG).type, 'image/jpeg');
  assert.match(photoFromDataUrl('data:image/png;base64,aGVsbG8=').error, /isn’t a picture/);
  assert.match(photoFromDataUrl('data:text/html;base64,PGI+').error, /JPG, PNG or WebP/);
  assert.match(photoFromDataUrl(`data:image/jpeg;base64,${Buffer.alloc(600 * 1024, 0xff).toString('base64')}`).error, /too big/);
  assert.match(SUPABASE_SETUP_SQL, /\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
  assert.deepEqual(profileOf({ id: 'u1', email: 'a@b.c', user_metadata: { picture: 'https://g/p.jpg' } }).photo, { own: false, version: null, google: 'https://g/p.jpg' });
});

/** An account signed in against a fake Supabase that records each request. */
async function signedInAccount(handlers = {}, now = Date.now) {
  const calls = [];
  let meta = { full_name: 'Amina' };
  const fetchImpl = async (url, options = {}) => {
    const path = url.replace('https://project.supabase.co', '');
    const body = options.body && !Buffer.isBuffer(options.body) ? JSON.parse(options.body) : options.body;
    calls.push({ path, method: options.method || 'GET', headers: options.headers || {}, body });
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data, arrayBuffer: async () => data, headers: new Map([['content-type', 'image/jpeg']]) });
    for (const [pattern, handler] of Object.entries(handlers)) if (path.startsWith(pattern)) return handler({ path, options, body, reply });
    if (path.startsWith('/auth/v1/verify')) return reply(200, { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600, user: { id: 'user-1', email: 'amina@example.com', user_metadata: meta } });
    if (path === '/auth/v1/user' && options.method === 'PUT') { meta = { ...meta, ...body.data }; return reply(200, { id: 'user-1', email: 'amina@example.com', user_metadata: meta }); }
    if (path === '/auth/v1/user') return reply(200, { id: 'user-1', email: 'amina@example.com', user_metadata: meta });
    if (path.startsWith('/storage/v1/object/avatars/')) return reply(200, { Key: 'avatars/user-1/avatar' });
    return reply(404, {});
  };
  const account = createAccount({ url: 'https://project.supabase.co', key: 'publishable', store: createSecureStore('x', { loadSafeStorage: async () => null }), fetchImpl, now });
  await account.verifyCode('amina@example.com', '123456');
  return { account, calls };
}

test('the profile is saved on the account with its own token, and the photo in its own folder', async () => {
  const { account, calls } = await signedInAccount();
  const saved = await account.saveProfile({ full_name: 'Amina Otieno', role: 'student', age_group: '13_17', country: 'Kenya', county: 'Nairobi' });
  assert.equal(saved.full_name, 'Amina Otieno');
  const put = calls.find(c => c.path === '/auth/v1/user' && c.method === 'PUT');
  assert.equal(put.headers.Authorization, 'Bearer ACCESS');
  assert.deepEqual(put.body, { data: { full_name: 'Amina Otieno', role: 'student', age_group: '13_17', country: 'Kenya', county: 'Nairobi' } });
  await assert.rejects(account.saveProfile({ role: 'pirate' }), /Choose a role/);

  const withPhoto = await account.savePhoto(JPEG);
  const upload = calls.find(c => c.path === '/storage/v1/object/avatars/user-1/avatar');
  assert.equal(upload.method, 'POST');
  assert.equal(upload.headers['Content-Type'], 'image/jpeg');
  assert.equal(upload.headers['x-upsert'], 'true');
  assert.equal(withPhoto.photo.own, true);
  assert.equal((await account.status()).user.name, 'Amina Otieno', 'the sidebar knows the name without asking Supabase');

  await assert.rejects(account.saveConsent({ analytics: true }), /parent or guardian/);
  const agreed = await account.saveConsent({ analytics: true, guardian: true });
  assert.equal(agreed.analytics, true);
  assert.equal(account.identity().userId, 'user-1');
});

test('two requests needing a fresh token at once renew it once, and nobody is signed out', async () => {
  let renewals = 0;
  let clock = 1_000_000;
  const used = new Set();
  const { account } = await signedInAccount({
    '/auth/v1/token': ({ body, reply }) => {
      renewals++;
      // Supabase: each refresh token works once; a second use is refused
      if (used.has(body.refresh_token)) return reply(400, { error_code: 'refresh_token_already_used' });
      used.add(body.refresh_token);
      return reply(200, { access_token: `ACCESS${renewals}`, refresh_token: `REFRESH${renewals}`, expires_in: 3600, user: { id: 'user-1', email: 'amina@example.com', user_metadata: {} } });
    },
  }, () => clock);
  clock += 2 * 3600 * 1000; // the access token has expired
  const [a, b] = await Promise.all([account.profile(), account.profile()]);
  assert.equal(renewals, 1, 'one renewal for both');
  assert.ok(a && b);
  assert.equal((await account.status()).signedIn, true);
});

test('photos not set up in Supabase yet: the owner is given the setup to run', async () => {
  const { account } = await signedInAccount({
    '/storage/v1/object/avatars/': ({ reply }) => reply(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }),
  });
  await assert.rejects(account.savePhoto(JPEG), err => err.status === 409 && /aren’t set up/.test(err.message) && err.extra.setup === SUPABASE_SETUP_SQL);
});

function analyticsFor(meta, { keys = true } = {}) {
  const sent = [];
  const analytics = createAnalytics({
    identity: () => ({ userId: 'user-1', meta: meta() }),
    clientId: () => 'install-1',
    appVersion: '1.0.0',
    measurementId: () => (keys ? 'G-TEST1234' : ''),
    apiSecret: () => (keys ? 'secret_123456' : ''),
    fetchImpl: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 204 }; },
    now: () => 1792400000000,
    flushMs: 60000,
  });
  return { analytics, sent };
}

test('the team’s own use is marked as internal traffic, so GA can leave it out', async () => {
  const meta = { role: 'developer', age_group: '18_plus', analytics_consent: { analytics: true, by: 'self', version: 1 } };
  const { analytics } = analyticsFor(() => meta);
  analytics.track('app_open');
  const body = await analytics.flush();
  assert.equal(body.events[0].params.traffic_type, 'internal');
  assert.deepEqual(body.user_properties.role, { value: 'developer' });
});

test('nothing reaches Google Analytics without consent, or without its keys', async () => {
  let meta = { age_group: '18_plus' };
  const { analytics, sent } = analyticsFor(() => meta);
  assert.equal(analytics.track('app_open'), false);
  meta = { age_group: '18_plus', analytics_consent: { analytics: true, by: 'self', version: 1 } };
  const noKeys = analyticsFor(() => meta, { keys: false });
  assert.equal(noKeys.analytics.track('app_open'), false);
  assert.equal(analytics.track('app_open'), true);
  meta = { age_group: '18_plus', analytics_consent: { analytics: false, by: null, version: 1 } };
  assert.equal(await analytics.flush(), null, 'withdrawn before sending: dropped');
  assert.equal(sent.length, 0);
});

test('what GA receives: ids, categories and timings — never a name, an email or the words said', async () => {
  const meta = { full_name: 'Amina Otieno', role: 'student', age_group: '13_17', county: 'Nairobi', country: 'Kenya', school: 'Thika School for the Blind', analytics_consent: { analytics: true, by: 'guardian', version: 1 } };
  const { analytics, sent } = analyticsFor(() => meta);
  analytics.track('app_open');
  assert.equal(analytics.turn({ outcome: 'command', tool: 'web_answer', transcript: 'who is derrick lubanga', failed: false }, { path: 'quick', totalMs: 1600, hearEngine: 'remote' }), true);
  assert.equal(analytics.turn({ outcome: 'filtered', transcript: 'room talk' }, { path: 'filtered' }), false, 'noise is not a use');
  const body = await analytics.flush();
  assert.match(sent[0].url, /^https:\/\/www\.google-analytics\.com\/mp\/collect\?measurement_id=G-TEST1234&api_secret=secret_123456$/);
  assert.equal(body.client_id, 'install-1');
  assert.equal(body.user_id, 'user-1');
  assert.deepEqual(body.user_properties, {
    role: { value: 'student' }, age_group: { value: '13_17' }, country: { value: 'Kenya' }, county: { value: 'Nairobi' },
    school: { value: 'Thika School for the Blind' }, app_version: { value: '1.0.0' },
  });
  assert.deepEqual(body.events.map(e => e.name), ['app_open', 'voice_command']);
  const command = body.events[1].params;
  assert.deepEqual({ way: command.way, ok: command.ok, duration_ms: command.duration_ms, hearing: command.hearing, feature: command.feature },
    { way: 'quick', ok: 1, duration_ms: 1600, hearing: 'remote', feature: 'web_answer' });
  assert.ok(command.session_id && command.engagement_time_msec > 0, 'GA counts sessions and active users from these');
  const everything = JSON.stringify(sent);
  for (const personal of ['Amina', 'amina@', 'derrick', 'room talk']) assert.ok(!everything.toLowerCase().includes(personal.toLowerCase()), `"${personal}" never sent`);
  assert.ok(body.events.every(e => !('traffic_type' in e.params)), 'a student’s use is real use');
  assert.equal(featureOf('search_youtube, youtube_play_result'), 'youtube');
  assert.equal(featureOf('gmail_open_email'), 'gmail');
  assert.equal(featureOf(''), 'none');
});
