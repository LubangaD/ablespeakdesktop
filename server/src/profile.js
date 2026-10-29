/**
 * The account profile (dashboard › Profile): the person's own details on
 * their AbleSpeak account, so they follow them to any computer they sign in
 * on. Details live in the account's user metadata (Supabase Auth); the photo
 * in a private Supabase Storage bucket, `avatars`, where each person can
 * reach only their own folder (SUPABASE_SETUP_SQL, run once by the owner).
 *
 * Analytics consent is kept here too. Nothing is sent to Google Analytics
 * until the person agrees; under 18, a parent or guardian must agree
 * (Kenya Data Protection Act 2019, s. 33).
 */
export const ROLES = ['student', 'teacher', 'parent', 'helper', 'developer'];
// Roles only the AbleSpeak team's accounts may give themselves (admin access,
// set in Supabase): their use is the team's testing, kept out of the real numbers
export const TEAM_ROLES = new Set(['developer']);
export const AGE_GROUPS = ['under_13', '13_17', '18_plus'];
export const COUNTRIES = ['Kenya', 'Uganda', 'Tanzania', 'Rwanda', 'Burundi', 'Ethiopia', 'Somalia', 'South Sudan', 'Nigeria', 'Ghana', 'South Africa', 'Other'];
export const KENYA_COUNTIES = [
  'Baringo', 'Bomet', 'Bungoma', 'Busia', 'Elgeyo-Marakwet', 'Embu', 'Garissa', 'Homa Bay', 'Isiolo', 'Kajiado',
  'Kakamega', 'Kericho', 'Kiambu', 'Kilifi', 'Kirinyaga', 'Kisii', 'Kisumu', 'Kitui', 'Kwale', 'Laikipia', 'Lamu',
  'Machakos', 'Makueni', 'Mandera', 'Marsabit', 'Meru', 'Migori', 'Mombasa', "Murang'a", 'Nairobi', 'Nakuru', 'Nandi',
  'Narok', 'Nyamira', 'Nyandarua', 'Nyeri', 'Samburu', 'Siaya', 'Taita-Taveta', 'Tana River', 'Tharaka-Nithi',
  'Trans-Nzoia', 'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot',
];
// What the Profile page offers, with the words it shows (one list, here)
export const PROFILE_OPTIONS = {
  roles: [['student', 'Student'], ['teacher', 'Teacher'], ['parent', 'Parent or guardian'], ['helper', 'Helper or carer'], ['developer', 'Developer (AbleSpeak team)']],
  ageGroups: [['under_13', 'Under 13'], ['13_17', '13 to 17'], ['18_plus', '18 or over']],
  countries: COUNTRIES,
  counties: KENYA_COUNTIES,
};
export const CONSENT_VERSION = 1;
export const MAX_PHOTO_BYTES = 512 * 1024;
const MAX_TEXT = { full_name: 80, school: 100 };

/** Under 18, a parent or guardian gives consent. */
export const isMinor = ageGroup => ageGroup === 'under_13' || ageGroup === '13_17';

/** The account's access, set by the project owner in Supabase (app_metadata.ablespeak_role). */
export const accessOf = user => (['admin', 'helper'].includes(user?.app_metadata?.ablespeak_role) ? user.app_metadata.ablespeak_role : null);

/** What the Profile page offers this account: the team's roles only to an admin account (or one that has one). */
export function optionsFor(access, currentRole = null) {
  const team = access === 'admin';
  return { ...PROFILE_OPTIONS, roles: PROFILE_OPTIONS.roles.filter(([role]) => team || !TEAM_ROLES.has(role) || role === currentRole) };
}

/**
 * Only the profile's own fields, checked: → { fields, errors }. A field left
 * out is left as it is; an empty one is cleared (null). `team`: an admin
 * account, which may take the team's roles (Developer).
 */
export function cleanProfile(input = {}, { team = false } = {}) {
  const fields = {};
  const errors = [];
  const text = (key, label) => {
    if (!(key in input)) return;
    const value = String(input[key] ?? '').replace(/\s+/g, ' ').trim();
    if (value.length > MAX_TEXT[key]) errors.push(`${label} can be at most ${MAX_TEXT[key]} characters.`);
    else fields[key] = value || null;
  };
  const choice = (key, allowed, label) => {
    if (!(key in input)) return;
    const value = input[key] == null || input[key] === '' ? null : String(input[key]);
    if (value !== null && !allowed.includes(value)) errors.push(`Choose ${label} from the list.`);
    else fields[key] = value;
  };
  text('full_name', 'Your name');
  text('school', 'School or organisation');
  choice('role', ROLES, 'a role');
  if (TEAM_ROLES.has(fields.role) && !team) {
    errors.push('Developer is only for the AbleSpeak team’s accounts.');
    delete fields.role;
  }
  choice('age_group', AGE_GROUPS, 'an age group');
  choice('country', COUNTRIES, 'a country');
  choice('county', KENYA_COUNTIES, 'a county');
  const country = 'country' in fields ? fields.country : input.country;
  if (fields.county && country && country !== 'Kenya') fields.county = null; // counties are Kenya's
  return { fields, errors };
}

/**
 * The person's choice about analytics: → { consent } or { error }.
 * Agreeing under 18 needs `guardian: true` (a parent or guardian agreed).
 */
export function cleanConsent({ analytics, guardian = false } = {}, ageGroup = null, now = new Date()) {
  const agreed = analytics === true;
  if (agreed && !ageGroup) return { error: 'Choose an age group first, so AbleSpeak knows who needs to agree.' };
  if (agreed && isMinor(ageGroup) && guardian !== true) return { error: 'Under 18, a parent or guardian needs to agree.' };
  return {
    consent: {
      analytics: agreed,
      by: agreed ? (isMinor(ageGroup) ? 'guardian' : 'self') : null,
      at: now.toISOString(),
      version: CONSENT_VERSION,
    },
  };
}

/** Whether usage may be sent to analytics for this account's details. */
export function analyticsAllowed(meta = {}) {
  const consent = meta.analytics_consent;
  if (consent?.analytics !== true || consent.version !== CONSENT_VERSION) return false;
  if (isMinor(meta.age_group)) return consent.by === 'guardian';
  return !!meta.age_group; // an age group must be known
}

/** A photo sent from the dashboard as a data: URL → { buffer, type } or { error }. */
export function photoFromDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) return { error: 'Choose a JPG, PNG or WebP picture.' };
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) return { error: 'That picture is empty.' };
  if (buffer.length > MAX_PHOTO_BYTES) return { error: 'That picture is too big. Choose a smaller one.' };
  const looksRight = {
    'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/png': b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/webp': b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  }[match[1]];
  if (!looksRight(buffer)) return { error: 'That file isn’t a picture AbleSpeak can use.' };
  return { buffer, type: match[1] };
}

/** The profile as the dashboard shows it, from the account's user record. */
export function profileOf(user = {}) {
  const meta = user.user_metadata || {};
  return {
    id: user.id || null,
    email: user.email || null,
    signedInWith: user.app_metadata?.provider || null,
    access: accessOf(user),
    full_name: meta.full_name || meta.name || '',
    school: meta.school || '',
    role: meta.role || null,
    age_group: meta.age_group || null,
    country: meta.country || null,
    county: meta.county || null,
    photo: {
      own: !!meta.avatar_path,
      version: meta.avatar_version || null,
      google: meta.avatar_url || meta.picture || null,
    },
    consent: meta.analytics_consent || null,
    analytics: analyticsAllowed(meta),
  };
}

// Pasted once into the Supabase project's SQL editor by its owner: a private
// bucket for profile photos, where each signed-in person can only read and
// write the folder named after their own account id.
export const SUPABASE_SETUP_SQL = `-- AbleSpeak profile photos (run once in Supabase > SQL Editor)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, ${MAX_PHOTO_BYTES}, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "AbleSpeak avatars: read own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "AbleSpeak avatars: add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "AbleSpeak avatars: replace own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "AbleSpeak avatars: remove own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
`;
