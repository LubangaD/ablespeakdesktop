# Phase 2: personal accounts, profile sync and accessible sign-in

*Draft plan, 3 October 2026. Step 1 is being built; the rest waits on the remaining decisions in section 7.*

> **Decisions made (3 October 2026)**
> - **Hosting:** data may be stored in the EU. Supabase, EU region.
> - **Consent:** a **signed consent form**, collected by the school or organisation and recorded in AbleSpeak. No guardian email or phone approval flow.
> - **Devices:** AbleSpeak runs on laptops and desktop computers only; there is no mobile app. Sign-in must therefore work **on the computer alone**. Phone QR approval moves to "optional later" (it needs only a phone browser, but learners can't be assumed to have phones).
>
> - **Sign-in method (changed 5 October 2026):** **email and a one-time code**, no password and no Google. The person or their helper gives an email address, Supabase emails a 6-digit code, and saying or typing it signs them in (`server/src/account.js`, `dashboard/src/pages/SignIn.jsx`). The first sign-in is done with a helper; after that the learner stays signed in (personal laptop) or a teacher signs them in (shared computer). Supabase project: "Computer- Control Ablespeak", West EU (Ireland). *(Was: Google accounts only, 3 October.)*
>
> Sections 2 and 5 below are updated to match. Where they still mention the phone, it's the optional route.

## Overview

Every person gets their own AbleSpeak account that lives in the cloud, so their settings, words, shortcuts and progress go with them to any computer, including school guest accounts that wipe local data. The desktop app keeps working offline from a local copy and catches up later. Sign-in uses a QR code the person approves on their phone, so nobody has to type a password on the computer.

## What the code does today

- **Identity.** `server/src/student-session.js` links a Windows account name to a local `students` row (`device_state` key `windows_user:<name>`). On a school guest account every learner is "Guest", so **all guests currently share one profile**. Phase 2 must fix this.
- **Where the server runs.** Inside the Electron main process (`server/electron-main.cjs`: `await import('./src/index.js')`), so Electron `safeStorage` can be reached from the server with no extra process. `index.js` picks the Windows user and calls `startDeviceSession`.
- **The profile is small.** One JSON blob per person in `student_profiles`: `listening`, `vocabulary` (max 100), `aliases` (max 50, some `learned: true`) and `macros` (max 20). `normaliseProfile` in `server/src/student-profile.js` already validates it; import and sync can reuse that.
- **Local history.** `commands`, `voice_turns` (contains transcripts), `sessions`, `correction_pairs`, `resolution_log`, `goals` and `progress_points` all have an integer `student_id`.
- **Deletion bug.** `deleteStudent` in `server/src/db.js` only deletes from `students`, `student_profiles` and `correction_pairs`, leaving the person's commands, voice turns, sessions, goals and progress points behind. Deleting an account must fix this.
- **Secrets.** The admin PIN hash is stored in `.env` (`server/src/admin-pin.js`). Sign-in tokens must **not** follow that pattern.
- **Local API.** Routes are protected by `localOnly`, but `cors()` is open, so any program on the PC can call the local API. Account routes must never return tokens.
- **Dashboard.** `dashboard/src/App.jsx` already separates personal pages (Home, My progress, Voice & words) from admin pages behind the PIN. A new "My account" page fits the personal side.

---

## 1. Backend recommendation

**Recommended: Supabase** (hosted Postgres database with built-in sign-in), in an EU region (London or Frankfurt).

Why:
- **Fits our data.** Our data is already tables in SQLite. Postgres is the same kind of database, so tables map nearly one-to-one, and Phase 3 reports for teachers, therapists and parents are plain SQL.
- **"Users see only their own data" is enforced by the database itself.** Row-level security means each person can read only their own rows, even if our app code has a bug. Phase 3 adds a "shared with" rule on top.
- **Sign-in providers.** Microsoft (school Microsoft 365 accounts), Google and email one-time codes are built in. Small server functions (Edge Functions) cover the QR approval step.
- **Exit route for data residency.** Supabase is open source and can be self-hosted. If Kenyan law or a ministry contract later requires data in Kenya, we can move without rewriting the app.
- **Cost.** The free tier is fine for development but pauses inactive projects, so production needs Pro at about US$25/month. That covers thousands of learners, because profiles are tiny.
- **Effort.** Low. The JavaScript client works in Node and accepts a custom token store, which we back with `safeStorage`.

Trade-offs:
- There is **no Africa region**, so data leaves Kenya. Sending sensitive data abroad needs a recorded legal basis (section 5).
- Offline sync is not built in, so we build a small sync layer ourselves. That is needed whichever backend we pick, because our local database is sql.js in Node and no vendor's offline cache works there.

**Runner-up: Firebase** (Firebase Auth + Firestore).
- Pros: generous free tier, Microsoft and Google sign-in, and a slightly easier QR hand-off. Google Cloud has a Johannesburg region (check that Firestore and Auth data can actually live there).
- Cons: Firestore's offline feature doesn't work in our Node/sql.js setup. A document database makes Phase 3 reports harder. Pay-per-read pricing is less predictable. No self-host exit route.

**Not recommended: our own Node service.** Cheapest in cash and could be hosted in Kenya, but a two-to-three-person team would own password handling, Microsoft/Google integration, token security, backups and breach response for minors' health data. That risk is too high right now.

---

## 2. Accessible sign-in

**Updated after the decisions above — sign-in on the computer alone:**
- **A learner's own laptop:** sign in once in the browser on that computer with Microsoft, Google or an email one-time code. AbleSpeak can drive the browser sign-in page by voice (it already opens pages and fills fields), so no typing is needed. After that they stay signed in; Windows' own sign-in protects the laptop.
- **A shared school computer:** a teacher signs the learner in. With the admin PIN, the teacher picks the learner from the school's list of accounts (the learner never types or says a password in front of classmates). The profile downloads from the cloud, and the learner is signed out automatically at the end (see 2b).
- **An email one-time code** is the fallback for learners without Microsoft or Google accounts; the code arrives in an inbox the teacher or learner can open.
- **Phone QR approval** (below) stays as an optional extra for people who do have a phone; it isn't required.

The original phone-first design follows, kept for the optional route.

**Originally proposed primary method: approve on your phone (QR code plus a short code).** Most people are already signed in to Google or Microsoft on their phone, so approving is one tap with no typing, and phones have their own voice and switch access. Signing in through a browser on the computer is the second option.

The QR flow is the same in every case:
1. The person says "sign in" (or clicks the big Sign in button).
2. The app shows a large QR code and a two-word code ("blue river"), and reads the code aloud.
3. They scan it with their phone. The phone opens our small sign-in page, where they sign in with Microsoft, Google or an email code. The first time, this creates the account.
4. The phone shows "Sign in on LAB-PC-07? Code: blue river" with a large "Yes, that's me" button.
5. The desktop, checking every 2 seconds, receives the session, loads the person's profile and says "Welcome back, Amina."

The request expires after 10 minutes and works once only. Matching the two-word code stops someone approving a request from a different screen.

### a) Personal laptop
1. On first launch the app opens on the Windows-linked local profile, exactly as Phase 1 does. Nothing breaks.
2. A gentle card says "Back up your settings and use them on any computer — Sign in", with the QR code first and "Sign in with Microsoft/Google in the browser" as a second button.
3. After sign-in the app asks: "Use the settings already on this computer for your account?" (yes/no, by voice or click). See section 4.
4. The person stays signed in. The token is encrypted with `safeStorage`, so only this Windows user can read it. They aren't asked again unless they sign out or remove the device from their account.
5. **Windows Hello: not in Phase 2.** On a personal laptop, Windows sign-in already proves who is there, and Electron has no built-in Windows Hello support. Revisit later as "lock my profile".

### b) School guest or shared computer
1. An admin marks the PC as shared once: Settings (behind the PIN) → "This is a shared computer". The app also assumes "shared" when the Windows name looks generic (Guest, Student, User, Lab…).
2. On a shared PC the app **doesn't** create a profile from the Windows name. It opens in "Guest — nothing is saved" mode with a big Sign in button.
3. The person signs in with the QR code. Their profile downloads in about a second and their words and shortcuts work straight away.
4. They're signed out automatically when they say "sign me out"; when nobody has spoken for 20 minutes (admin can change this), after a spoken 60-second warning; or when the app quits, the PC locks, or Windows signs out.
5. On sign-out the app first uploads anything not yet sent, then **wipes that person's local data** (profile cache, commands, voice turns, sessions, token). This happens even if the guest account would wipe it anyway, because many "shared" PCs are ordinary accounts that don't.
6. If the PC is offline and the person has never signed in on it, the app offers the Phase 1 "load my profile file" route; otherwise Guest mode, which still works with default settings.

### c) Someone who can't use a keyboard at all
- The whole flow is spoken: "sign in" shows the QR code and reads the code aloud; "sign me out" and yes/no work by voice; every step is read aloud.
- Approval happens on the phone with the phone's own accessibility (Android Voice Access, iOS Voice Control, switch access), usually one tap or one spoken "tap Yes".
- If they can't use a phone either: a **trusted helper** (a parent or guardian linked during consent) can approve sign-in requests from their own phone. This also suits minors. *Founder decision needed.*
- With no phone: the code can be entered at a short web address on any device, including by dictating with AbleSpeak on another PC. Printed "sign-in cards" are an open question.
- Never ask for a password to be dictated aloud on the PC: classmates would hear it.

---

## 3. What syncs, what stays local, conflicts, offline

| Data | Syncs? | Why |
|---|---|---|
| Listening settings, words, shortcuts, routines | **Yes** | The "profile follows the person" goal. Small. |
| Correction pairs ("heard X, meant Y") | Yes (small, counts only) | How shortcuts are learned; otherwise learning restarts on every PC. |
| Daily progress summaries (per day: commands, successes, average speed) | **Yes, numbers only** | So My progress shows all computers combined. |
| Raw command history and transcripts | **No, stays local** | Data minimisation: what the person said is very sensitive. |
| Sessions, app-usage log | No | Device diagnostics, not needed elsewhere. |
| Goals, progress points, decision flags | Not in Phase 2 | They belong to the Phase 3 teacher portal. |
| Screenshots or screen images | **Never** | Not stored; the sync code sends only an allowlist of fields. |
| API keys, admin PIN, `.env` | Never | They belong to the device, not the person. |

**Conflict rules** (one pure, easily tested function, `mergeProfile(base, local, remote)`):
- Each listening setting: the most recent change wins (each field keeps its own change time).
- Words: the lists are combined; a deleted word is remembered as "deleted at time T" so it doesn't come back.
- Shortcuts match by what is said ("my music"), routines by name; for each, the most recent change wins and deletes are remembered.
- After merging, apply the existing limits (100 words, 50 shortcuts, 20 routines); if over, keep the newest and tell the person.
- Daily summaries never conflict: each device writes only its own rows (person + device + date), and totals add them up.

**Offline behaviour**
- After the first sign-in on a device, everything works offline from the local copy.
- Changes go into a local "to send" queue, sent at app start, every 5 minutes, after any profile change, and at sign-out.
- A small status line shows "Saved to your account", "Will save when online" or "Not signed in — saved on this computer only".
- The first sign-in on a device needs internet.
- If a token expires while offline, the person keeps working and is asked to sign in again only once back online.

---

## 4. Data model changes and migration

**Key idea: a local `students` row becomes the local copy of one account.** Every existing table keeps its integer `student_id`, so commands, progress and goals need no rewiring. People without an account stay "on this computer only", which is today's behaviour.

**Local changes** (`server/src/db.js` `migrate()`, same add-column pattern):
- `students`: add `account_id TEXT UNIQUE` (empty = local only), `synced_at TEXT`, `is_temporary INTEGER` (signed in on a shared PC; wipe on sign-out).
- `student_profiles`: add `synced_profile TEXT` (last copy agreed with the cloud, the merge base), `item_times TEXT` (per-item change times and deletions), `rev INTEGER`.
- New `sync_outbox` (id, student_id, kind, payload, created_at, attempts, last_error).
- New `daily_summaries` (student_id, date, commands, successes, avg_ms; key student_id + date), filled from `commands` with the same counting rule as `getStudentProgress`.
- `device_state` keys: `device_id` (random, made once), `shared_computer` (0/1), `signed_in_account`.
- Tokens are **not** stored in the database; they go in an encrypted file (section 5).

**Cloud tables** (Supabase). Every table has `user_id` as owner; row-level security says "only the owner". Phase 3 adds "or someone the owner shared with".
- `profiles`: user_id, display_name, is_minor (yes/no only, no date of birth), sync_allowed (true once consent exists), created_at.
- `speech_profiles`: user_id, profile, item_times, rev, updated_at.
- `correction_pairs`: user_id, heard, meant, count, last_at.
- `daily_progress`: user_id, device_id, date, commands, successes, avg_ms.
- `devices`: id, user_id, label, kind (personal/shared), last_seen, revoked_at. The person can remove a device from My account.
- `link_requests`: hashed code, device label, expires_at, status, approved_user. Readable only by the server functions.
- `consents`: user_id, kind, policy_version, given_by (self or guardian), guardian contact, given_at, withdrawn_at.
- `account_events`: minimal audit trail (signed in, exported, deleted), no content.

**Migrating existing local profiles**
1. Existing users notice nothing until they sign in. Local-only keeps working.
2. On first sign-in only the **currently active** local profile is considered, never another person's on a shared PC. If the cloud account is empty: "Use the settings on this computer for your account?" Yes uploads them; No starts from cloud defaults and leaves the local profile unlinked. If both have data: merge with `mergeProfile` (nothing lost) and say what was added.
3. Command history stays local, attached through `student_id`. Its daily summaries are calculated and uploaded, so My progress keeps the person's past.
4. Profiles an admin made on the Users page show "Local only" or "Linked to an account". Linking needs the person to approve with their own QR sign-in; an admin can never link a profile on someone's behalf.
5. On shared PCs, Windows-name linking is switched off. On personal PCs it stays as the "before you sign in" profile.

---

## 5. Privacy, consent and security

**Legal frame** (Kenya Data Protection Act 2019; confirm with a lawyer):
- Health or disability data is "sensitive personal data"; a child is anyone under 18.
- Processing a child's data needs a parent or guardian's consent.
- High-risk processing calls for a Data Protection Impact Assessment (DPIA), and AbleSpeak likely needs to register with the Office of the Data Protection Commissioner (ODPC).
- Sending sensitive data outside Kenya needs the person's consent plus proof of proper safeguards (Supabase's Data Processing Agreement, EU region).

**Consent — decided: a signed consent form.** The school or organisation collects a signed form (from the guardian for under-18s, from the learner if 18 or over) and an admin records it in AbleSpeak behind the PIN: who signed, their relationship to the learner, the date, the form version, and where the paper or scan is kept. Until a form is recorded, the account works on that computer only and nothing syncs. Withdrawing consent is recorded the same way and stops sync. The KISE "guide + consent" item is the first version of this form.

**Originally proposed consent flow** (on a phone sign-up page; superseded by the signed form above):
1. "Are you 18 or older?" Adults read a short plain-language notice (what syncs, where it's stored, that screenshots and recordings never leave the computer) and tick "I agree".
2. Under 18: the page asks for a parent's or guardian's phone or email; the guardian gets a link to approve. **Until approval, the account works on that computer only** (nothing is uploaded). The app stays fully usable while waiting.
3. Schools that collect paper consent (the KISE "guide + consent" item) need a school-assisted route. Phase 3 overlap; founder decision.
4. Consent records the policy version, so a changed policy can ask again. Withdrawing consent stops sync and offers deletion.

**Data minimisation:** no date of birth, diagnosis or disability type, audio, transcripts or screenshots go to the cloud. The display name is chosen by the person; their email stays with the sign-in provider. Words can include names of family and classmates, so they're sent only after consent and covered in the notice.

**Encryption:** all traffic uses TLS and Supabase encrypts stored data. End-to-end encryption isn't recommended for Phase 2 (lost-key recovery is hard for this group, and it would block the Phase 3 portal); revisit for words if the DPIA asks.

**Tokens on the device**
- A new `server/src/secure-store.js` encrypts the refresh token with Electron `safeStorage` (Windows DPAPI, tied to the Windows user), in a file under `app.getPath('userData')`.
- `electron-main.cjs` passes `safeStorage` to the server at startup. Without Electron (`npm start`), tokens stay in memory only and are never written in plain text.
- Tokens are never written to `.env`, logs, the database or any API response. The dashboard only calls local routes such as `/api/account/status`, `/api/account/sign-in/start` and `/api/account/sign-out`, all `localOnly`.
- On shared PCs, sign-out revokes the session on the server and deletes the token file.

**Other safeguards:** sign-in requests expire in 10 minutes and work once, the two-word code must match, and the phone page is rate-limited. Signing out other devices, removing a device and deleting the account all need a fresh phone approval, so someone at a shared PC can't do them.

**Export and deletion** (My account page):
- **Export:** one JSON file with the cloud profile, consents and progress plus this PC's local history (extends today's export file).
- **Delete:** phone approval first; then the cloud rows and the sign-in user are deleted, and every device wipes its local copy at next contact. Local deletion is fixed to remove **all** of the person's rows.
- **Inactivity:** accounts unused for 24 months are deleted after a warning (period to confirm).

---

## 6. Build order (each step ships on its own)

Effort assumes one developer who knows the codebase. Total about **7–9 weeks**.

| Step | What | Effort | Done when |
|---|---|---|---|
| 0 | Decisions + three spikes: Supabase project (EU); QR hand-off; Microsoft sign-in with a real school Microsoft 365 student account; Google Workspace for Education with an under-18 account | 2–3 days | A written yes/no for each spike, and section 7 answered |
| 1 | Shared-computer safety, local only: device id, "shared computer" setting and generic-name detection; Guest mode instead of a Windows-name profile; fix `deleteStudent` | 2–3 days | Two guests never share data; deleting a person leaves zero rows in all eight tables. Ships with no cloud and fixes today's guest problem |
| 2 | Secure token store (`secure-store.js`, `safeStorage` from `electron-main.cjs`) | 1 day | The token file doesn't contain the token text and can't be read by another Windows user |
| 3 | Cloud tables and security rules (`cloud/supabase/migrations/`) | 2–3 days | Automated tests show user A can't read or write user B's rows; anonymous users read nothing |
| 4 | Sign in through the browser on this computer (PKCE, callback to `127.0.0.1:3001`), My account page | 2–3 days | Microsoft and Google test accounts sign in, stay signed in after restart, and sign-out clears the token |
| 5 | Teacher-assisted sign-in on shared computers (admin PIN → pick the learner's account), voice-driven browser sign-in on personal laptops, "sign in" / "sign me out" voice commands. *(Phone QR approval: optional, later.)* | 3–4 days | A learner on a shared computer is signed in by a teacher without saying or typing any password; a learner on their own laptop signs in by voice alone |
| 6 | Consent: admin records a signed consent form (who signed, relationship, date, form version, where it's kept), `consents` table, sync gated on a recorded form | 2–3 days | An account uploads nothing until a signed form is recorded; withdrawal stops sync. **No sync for real users before this step** |
| 7 | Profile sync and offline: `account-sync.js` (pull, merge, push, outbox), `mergeProfile` | 4–5 days | Two PCs edited offline then reconnected keep both changes; pulling the network cable loses nothing |
| 8 | First-sign-in migration prompt and merge; link status on the Users page | 1–2 days | Empty-cloud, empty-local and both-have-data cases tested; another person's profile never offered |
| 9 | Progress across devices: `daily_summaries`, combined totals in My progress | 2–3 days | Two PCs' totals add up; a test proves no transcript or app name is uploaded |
| 10 | Shared-PC automatic sign-out: idle timer with spoken warning, "sign me out", lock/shutdown hooks, upload-then-wipe | 2 days | After sign-out the person's local rows count is zero |
| 11 | Export and delete account | 2 days | Export contains everything listed; deletion removes all cloud rows and the local copy follows |

Later or optional: trusted-helper approval, Windows Hello "lock my profile", sign-in cards.

**Testing:** unit tests in the existing `node --test` style for `mergeProfile`, the outbox, the secure store, shared-PC detection, delete-all-rows, summaries, and an outbound-payload allowlist (no image fields, no transcripts); a local Supabase running the row-level security tests and the sign-in hand-off end to end; hands-on checks of voice-only sign-in, the phone page with Android Voice Access and iOS Voice Control, and a full cycle on a real Windows guest account.

---

## 7. Risks and decisions

**Risks**
- **Learners without smartphones.** QR sign-in assumes one. Mitigation: trusted-helper approval, entering the code on any device, possibly sign-in cards.
- **Schools blocking sign-in.** Microsoft 365 and Google for Education often stop students using third-party apps, and Google restricts under-18 users by default. Mitigation: spikes in step 0, an email one-time code as fallback, and a one-page "how to allow AbleSpeak" guide for school IT.
- **Data leaving Kenya** without a recorded legal basis. Mitigation: consent wording, a signed Data Processing Agreement, a DPIA and ODPC registration before launch.
- **Screenshots and hosted AI.** Sync never touches screenshots, but the app already sends screen captures and audio to the AI provider. The privacy notice must be honest about that path, separately from sync (overlaps the open "no data" disclosure issue).
- **Other programs on the PC** can call the local API (open `cors()`). Account routes never return tokens; sign-out of other devices and deletion need phone approval.
- **Clock differences between PCs** can affect "most recent change wins". Mitigation: use the server's time when an upload is accepted.

**Decisions needed**
1. ~~Supabase in an EU region, accepting that data leaves Kenya for now?~~ **Decided: yes, EU.**
2. ~~Minors: guardian approval by phone or email link, school-collected paper consent, or both?~~ **Decided: a signed consent form.**
3. Can a guardian (trusted helper) approve sign-ins for a learner?
4. Printed sign-in cards for learners without phones: allow them? Convenient, but a lost card works like a key.
5. Idle sign-out time on shared PCs (suggested 20 minutes) and account inactivity deletion (suggested 24 months).
6. Should correction pairs and daily progress sync at all, or only settings, words, shortcuts and routines? Less is safer; more is more useful.
7. Is an email one-time code acceptable as a third sign-in method for learners without Microsoft or Google accounts?
8. Who owns the account in Phase 3: always the learner, with teachers and parents getting access the learner or guardian grants? (Recommended; this plan assumes it.)

## Success criteria
- [ ] A learner signs in on a school guest PC by voice plus phone in under 60 seconds, and their words and shortcuts work immediately.
- [ ] After sign-out on a shared PC, none of their data remains on it.
- [ ] Edits made offline on two PCs merge without losing anything.
- [ ] No screenshot, audio or transcript is ever uploaded (an automated test enforces this).
- [ ] A minor's data isn't uploaded before guardian consent.
- [ ] Each person can see, export and delete only their own data, and the database itself enforces this.
- [ ] Existing Phase 1 users lose nothing and are never forced to sign in.
