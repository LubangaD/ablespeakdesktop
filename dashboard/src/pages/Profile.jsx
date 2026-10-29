/**
 * Profile — the person's own details on their AbleSpeak account (GET/PUT
 * /api/account/profile, server/src/profile.js): photo, name, school, role,
 * age group, where they are, and their choice about sharing usage with
 * Google Analytics (off until they agree; under 18, a parent or guardian).
 * Saved on the account, so it follows them to any computer they sign in on.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import Avatar from '../components/Avatar';
import { TITLE, SECTION, LABEL, MUTED, BODY, PAGE, CARD, PRIMARY, QUIET, DANGER, FIELD, FIELD_LABEL, DOT, INK } from '../lib/ui';

const RESULT_TONE = { success: 'ok', error: 'bad', warn: 'warn' };
const minor = ageGroup => ageGroup === 'under_13' || ageGroup === '13_17';

/** A picture made square and small (256 px JPEG): quick to save, and without the camera's details, such as where it was taken. */
async function squarePhoto(file, size = 256) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function Result({ result }) {
  return (
    <p role="status" aria-live="polite" className={result ? `text-[13px] leading-5 ${INK[RESULT_TONE[result.tone] || 'ok']}` : 'sr-only'}>
      {result?.text || ''}
    </p>
  );
}

function Card({ title, id, children, className = '' }) {
  return (
    <section aria-labelledby={id} className={`${CARD} p-6 flex flex-col gap-4 ${className}`}>
      <h2 id={id} className={SECTION}>{title}</h2>
      {children}
    </section>
  );
}

function PhotoCard({ profile, onSaved }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [setup, setSetup] = useState(null);

  const choose = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) return setResult({ tone: 'error', text: 'Choose a picture: a JPG, PNG or WebP file.' });
    setBusy(true);
    setResult(null);
    setSetup(null);
    try {
      onSaved(await api.saveAccountPhoto(await squarePhoto(file)));
      setResult({ tone: 'success', text: 'Photo saved.' });
    } catch (err) {
      setResult({ tone: 'error', text: err.message || 'The photo couldn’t be saved.' });
      if (err.body?.setup) setSetup(err.body.setup);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setResult(null);
    try {
      onSaved(await api.removeAccountPhoto());
      setResult({ tone: 'success', text: 'Photo removed.' });
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const copySetup = async () => {
    try { await navigator.clipboard.writeText(setup); setResult({ tone: 'success', text: 'Setup script copied.' }); } catch { /* the script is shown below to select */ }
  };

  return (
    <Card title="Photo" id="photo-heading">
      <div className="flex items-center gap-5">
        <Avatar photo={profile.photo} name={profile.full_name} email={profile.email} size={96} />
        <div className="flex flex-col gap-2 items-start">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={choose} tabIndex={-1} aria-hidden="true" />
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Saving…' : profile.photo.own ? 'Change photo' : 'Add a photo'}
          </button>
          {profile.photo.own && <button type="button" className={QUIET} disabled={busy} onClick={remove}>Remove photo</button>}
        </div>
      </div>
      <p className={MUTED}>
        Made small and square on this computer before it is saved. {profile.photo.google && !profile.photo.own ? 'Until you add one, your Google photo is shown.' : ''}
      </p>
      <Result result={result} />
      {setup && (
        <div className="rounded-lg bg-[var(--sunken)] border-l-2 border-[var(--accent-soft)] px-4 py-3 flex flex-col gap-2">
          <p className={BODY}>One-time setup, by whoever owns AbleSpeak’s Supabase project: open the project, go to <strong>SQL Editor</strong>, paste this script and press <strong>Run</strong>. Then add the photo again.</p>
          <button type="button" className={`${QUIET} self-start`} onClick={copySetup}>Copy the setup script</button>
          <details>
            <summary className={`${LABEL} cursor-pointer`}>Show the script</summary>
            <pre className="mt-2 text-[12px] leading-4 whitespace-pre-wrap break-all text-[var(--ink-body)]">{setup}</pre>
          </details>
        </div>
      )}
    </Card>
  );
}

function Select({ label, value, onChange, options, placeholder }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>{label}</label>
      <select id={id} value={value || ''} onChange={e => onChange(e.target.value || null)} className={FIELD}>
        <option value="">{placeholder}</option>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </div>
  );
}

function DetailsCard({ profile, options, onSaved }) {
  const [form, setForm] = useState(() => ({ ...profile }));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => { setForm({ ...profile }); }, [profile]);
  const set = key => value => setForm(f => ({ ...f, [key]: value, ...(key === 'country' && value !== 'Kenya' ? { county: null } : {}) }));
  const nameId = useId();
  const schoolId = useId();
  const emailId = useId();

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const { full_name, school, role, age_group, country, county } = form;
      onSaved(await api.saveAccountProfile({ full_name, school, role, age_group, country, county }));
      setResult({ tone: 'success', text: 'Saved to your account.' });
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Your details" id="details-heading">
      <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor={nameId} className={FIELD_LABEL}>Name</label>
          <input id={nameId} className={FIELD} value={form.full_name || ''} maxLength={80} autoComplete="name" onChange={e => set('full_name')(e.target.value)} />
        </div>
        <div>
          <label htmlFor={emailId} className={FIELD_LABEL}>Email</label>
          <input id={emailId} className={`${FIELD} opacity-80`} value={profile.email || ''} readOnly aria-describedby={`${emailId}-note`} />
          <p id={`${emailId}-note`} className={`${LABEL} mt-1`}>The email you sign in with.</p>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={schoolId} className={FIELD_LABEL}>School or organisation</label>
          <input id={schoolId} className={FIELD} value={form.school || ''} maxLength={100} autoComplete="organization" onChange={e => set('school')(e.target.value)} />
        </div>
        <Select label="Role" value={form.role} onChange={set('role')} options={options.roles} placeholder="Choose…" />
        <Select label="Age group" value={form.age_group} onChange={set('age_group')} options={options.ageGroups} placeholder="Choose…" />
        <Select label="Country" value={form.country} onChange={set('country')} options={options.countries.map(c => [c, c])} placeholder="Choose…" />
        {form.country === 'Kenya' && (
          <Select label="County" value={form.county} onChange={set('county')} options={options.counties.map(c => [c, c])} placeholder="Choose…" />
        )}
        <div className="sm:col-span-2 flex items-center gap-4">
          <button type="submit" className={PRIMARY} disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button>
          <Result result={result} />
        </div>
      </form>
    </Card>
  );
}

function PrivacyCard({ profile, onSaved }) {
  const [guardian, setGuardian] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const consent = profile.consent;
  const isMinor = minor(profile.age_group);
  const sharing = profile.analytics;

  const choose = async (analytics) => {
    setBusy(true);
    setResult(null);
    try {
      onSaved(await api.saveAccountConsent({ analytics, guardian }));
      setResult({ tone: 'success', text: analytics ? 'Thank you. Usage is shared from now on.' : 'Nothing is shared.' });
    } catch (err) {
      setResult({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const [tone, word] = sharing ? ['ok', 'Sharing usage'] : consent ? ['idle', 'Not sharing'] : ['warn', 'Not chosen yet'];
  return (
    <Card title="Help improve AbleSpeak" id="privacy-heading" className="lg:col-span-2">
      <div className="flex items-start justify-between gap-6">
        <p className={`${BODY} max-w-[720px]`}>
          AbleSpeak can count how it is used, in Google Analytics, so we can make it work better and show schools and
          funders that it helps. It is shared only if you agree, and you can stop at any time.
        </p>
        <span className={`inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap ${INK[tone]}`}>
          <span className={`w-2 h-2 rounded-full ${DOT[tone]}`} aria-hidden="true" />{word}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h3 className={`${LABEL} mb-1`}>What is shared</h3>
          <ul className={`${BODY} list-disc pl-5`}>
            <li>Your role, age group, county and school</li>
            <li>For each command: what kind it was, whether it worked, how long it took, which feature it used</li>
            <li>When AbleSpeak is opened</li>
          </ul>
        </div>
        <div>
          <h3 className={`${LABEL} mb-1`}>Never shared</h3>
          <ul className={`${BODY} list-disc pl-5`}>
            <li>Your name, email or photo</li>
            <li>What you say, type or dictate</li>
            <li>What is on your screen</li>
          </ul>
        </div>
      </div>
      {!profile.age_group && !sharing && <p className={`${MUTED}`}>Choose your age group in your details first, so AbleSpeak knows who needs to agree.</p>}
      {isMinor && !sharing && (
        <label className={`${BODY} flex items-center gap-3 min-h-[44px]`}>
          <input type="checkbox" checked={guardian} onChange={e => setGuardian(e.target.checked)} className="w-5 h-5 accent-[var(--accent)]" />
          I am this student’s parent or guardian, and I agree.
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {sharing ? (
          <button type="button" className={QUIET} disabled={busy} onClick={() => choose(false)}>Stop sharing</button>
        ) : (
          <>
            <button type="button" className={PRIMARY} disabled={busy || !profile.age_group || (isMinor && !guardian)} onClick={() => choose(true)}>Yes, share usage</button>
            {!consent && <button type="button" className={QUIET} disabled={busy} onClick={() => choose(false)}>No thanks</button>}
          </>
        )}
        <Result result={result} />
      </div>
      {consent?.at && (
        <p className={LABEL}>
          Your choice was saved on {new Date(consent.at).toLocaleDateString()}{consent.by === 'guardian' ? ', agreed by a parent or guardian' : ''}.
        </p>
      )}
    </Card>
  );
}

function AccountCard({ profile }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = async () => {
    await api.signOut().catch(() => {});
    await queryClient.invalidateQueries({ queryKey: ['account'] });
    navigate('/sign-in');
  };
  const how = profile.signedInWith === 'google' ? 'Google' : 'an emailed code';
  return (
    <Card title="Account" id="account-heading">
      <p className={BODY}>Signed in as <span className="text-[var(--ink)]">{profile.email}</span>, with {how}.</p>
      {profile.access && (
        // Set on the account in Supabase by AbleSpeak's owner, so it is shown, not chosen here
        <p className={BODY}>
          Access: <span className="text-[var(--ink)]">{profile.access === 'admin' ? 'Admin (AbleSpeak team): every page is open' : 'Helper: the Users page is open'}</span>
          <span className={MUTED}> · set on your account by AbleSpeak</span>
        </p>
      )}
      <button type="button" className={`${DANGER} self-start`} onClick={signOut}>Sign out</button>
    </Card>
  );
}

export default function Profile() {
  const queryClient = useQueryClient();
  const { data: account, isLoading: accountLoading } = useQuery({ queryKey: ['account'], queryFn: api.getAccountStatus, retry: false });
  const signedIn = !!account?.signedIn;
  const { data, isError, error, refetch } = useQuery({ queryKey: ['accountProfile'], queryFn: api.getAccountProfile, enabled: signedIn, retry: false });

  // A save answers with the new profile: show it at once, and the sidebar's picture and name too
  const saved = next => {
    queryClient.setQueryData(['accountProfile'], old => ({ ...next, options: old?.options }));
    queryClient.invalidateQueries({ queryKey: ['account'] });
  };

  let body;
  if (accountLoading) body = <p className={MUTED}>Loading…</p>;
  else if (!signedIn) {
    body = (
      <div className={`${CARD} p-6 flex flex-col gap-3 max-w-[560px]`}>
        <p className={BODY}>Sign in to your AbleSpeak account to set up your profile. It follows you to any computer you sign in on.</p>
        <Link to="/sign-in" className={`${PRIMARY} self-start`}>Sign in</Link>
      </div>
    );
  } else if (isError) {
    body = (
      <div className={`${CARD} p-6 flex flex-col gap-3 max-w-[560px]`} role="alert">
        <p className={INK.bad}>{error?.message || 'Your profile couldn’t be loaded.'}</p>
        <button type="button" className={`${QUIET} self-start`} onClick={() => refetch()}>Try again</button>
      </div>
    );
  } else if (!data) body = <p className={MUTED}>Loading your profile…</p>;
  else {
    body = (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div className="flex flex-col gap-6">
          <PhotoCard profile={data} onSaved={saved} />
          <AccountCard profile={data} />
        </div>
        <DetailsCard profile={data} options={data.options} onSaved={saved} />
        <PrivacyCard profile={data} onSaved={saved} />
      </div>
    );
  }

  return (
    <div className={PAGE}>
      <div className="max-w-[1100px] flex flex-col gap-8">
        <header>
          <h1 className={TITLE}>Profile</h1>
          <p className={`${MUTED} text-[14px] mt-1`}>Your details on your AbleSpeak account. They follow you to any computer you sign in on.</p>
        </header>
        {body}
      </div>
    </div>
  );
}
