# The AbleSpeak Tier 2 screens

*The dashboard's ten screens, refreshed 13 October 2026. Open [`index.html`](index.html) for the contact sheet.*

These files are the UI spec. Each one ports to a React page, class for class, and
they are built so that the drift recorded in [`../DESIGN.md`](../DESIGN.md) — "the
six files were generated separately, so they differ from each other in places" —
cannot happen again: the frame is drawn once in `shell.js`, and the look is
defined once in `ablespeak-ui.css`.

```
index.html              the contact sheet
ablespeak-ui.css        the design system — one class per lib/ui.js export
shell.js                the sidebar and top bar, from one definition
01-home.html            /            → pages/Home.jsx
02-my-progress.html     /progress    → pages/MyProgress.jsx
03-voice-and-words.html /speech      → pages/SpeechProfile.jsx + components/StudentSpeech.jsx
04-sign-in.html         /sign-in     → pages/SignIn.jsx            (no frame)
05-users.html           /students    → pages/Students.jsx
06-exams.html           /exams       → pages/Exams.jsx
07-exam-screen.html     /exam        → pages/ExamScreen.jsx
08-test-console.html    /test        → pages/TestConsole.jsx
09-developer-hub.html   /developer   → pages/DeveloperHub.jsx + Tools/Prompt/Context/Logs.jsx
10-settings.html        /settings    → pages/Settings.jsx
```

Open any file directly — no build step. A small static server is needed for
`shell.js` to run (`python -m http.server 4178 --directory docs/design/ui`),
because a browser will not fetch a script from `file://`.

---

## Why these replace `../stitch/`

The six files in `../stitch/` were generated one screen at a time by Stitch, and
the app has moved past them. They are kept for history; they are no longer the spec.

| | `../stitch/` (Sep 2026) | here (13 Oct 2026) | the app today |
|---|---|---|---|
| Page | `#050D19` | `#0d1627` | `#0d1627` |
| Cards | `#102038` navy | `#141c28` grey-blue | `#141c28` |
| Sidebar | `#0A1628` | `#141c28` at 95% | `#141c28` at 95% |
| Text | `#EDF0F5` | `#dae3f4` | `#dae3f4` |
| Quiet text | `#94A3B8` cool | `#c9b8a5` warm | `#c9b8a5` |
| Headings | Space Grotesk | Roboto Flex | Roboto Flex (bundled) |
| Body | Inter | Roboto Flex | Roboto Flex (bundled) |
| Mono | JetBrains Mono | Roboto Mono | Roboto Mono (bundled) |
| Status | uppercase badges | a dot and a word, sentence case | a dot and a word |
| Screens | 6 | 10 | 10 routes |

**The app was already here.** Every page in `dashboard/src/pages/` reads its look
from `src/lib/ui.js`, and not one of them contains a navy value. The stitch
files, not the app, were the stale artefact. These files follow the app.

Four screens had never had a design file at all: **Exams**, **Exam screen**,
**My progress** and **Sign in**.

## What changed from the stitch screens

- **Named for what they are.** "Students" is **Users** and "Speech Profile" is
  **Voice & words**, following `AbleSpeak-Documentation.md` (13 Oct 2026).
  An adult learner is not a student, and a student should be able to read the
  menu and know what a page does.
- **One frame, three tiers.** The sidebar groups the sections under **User**,
  **Helper** and **Admin**, each saying whether it is open or which PIN opens it.
  Locked sections stay visible, so everyone can see how AbleSpeak is split up.
- **Settings borders are the real card border.** The stitch file asked for
  `border-white/12`, which its Tailwind build could not draw, so the screen fell
  back to Tailwind's default light grey and the app copied it. These files use
  `rgba(255,255,255,0.06)` like every other card.
- **The 1024px floor is kept**; phone and tablet layouts are still not applied,
  because the app runs in a desktop window.

## Porting a screen

Every class maps to one export in `dashboard/src/lib/ui.js`:

| class | constant | | class | constant |
|---|---|---|---|---|
| `as-title` | `TITLE` | | `as-btn` | `BUTTON` |
| `as-section` | `SECTION` | | `as-primary` | `PRIMARY` |
| `as-label` / `as-muted` | `LABEL` / `MUTED` | | `as-quiet` | `QUIET` |
| `as-body` | `BODY` | | `as-danger` | `DANGER` |
| `as-number` | `NUMBER` | | `as-small-quiet` | `SMALL_QUIET` |
| `as-page` | `PAGE` | | `as-row-action` | `ROW_ACTION` |
| `as-card` | `CARD` | | `as-field` | `FIELD` |
| `as-well` | `WELL` | | `as-dot as-ok` | `DOT.ok` |
| `as-table th` | `TH` | | `as-ok` | `INK.ok` |
| `as-table td` | `TD` | | `as-divider` | `DIVIDER` |

So `<p class="as-muted as-mt-1">` becomes ``<p className={`${MUTED} mt-1`}>``.
Classes with no constant (`as-stat`, `as-notice`, `as-chip`, `as-tabs`,
`as-voicebar`, `as-bars`) are patterns a page builds from Tailwind directly, or
candidates to add to `lib/ui.js` if a second page needs them.

The shell is already built: `App.jsx` draws `HomeSidebar` and `HomeTopBar`, so a
port only writes the page's own `<main>` content.

## Rules these screens hold to

- **Status is never colour alone.** Always a dot or an icon *and* a word, in
  sentence case. A colour-blind reader and a screen-reader user get the same
  information as everyone else.
- **Numbers are the only large text.** One `as-title` per page; everything else
  is 13–16px. A teacher glancing at a screen should land on the number.
- **Every control is at least 44px tall**, 48px where a student presses it
  themselves, with 8–12px between adjacent targets — for an unsteady hand.
- **One accent per page.** Amber marks the single action the page is for.
- **A 3px amber focus ring on everything**, never removed.
- **Say what is not real.** Where a value has no source, the nearest real value
  is shown with a truthful label; where a page is not showing the live thing
  (the Prompt tab), it says so.
- **The dashboard never opens a microphone** and never runs a tool. It shows the
  voice state the server reports.
- **A chart is never the only route to its numbers** — each has a text
  alternative or a table.
- **Private values carry `data-private`**, so a screenshot can blur them before
  it is committed. `.as-hide-private` on `<body>` does that.

## Proposals, not done here

Design observations from the refresh that would change app behaviour. Written
down rather than applied.

1. **The exam screen keeps the sidebar.** `App.jsx` treats only `/sign-in` as
   bare, so during a sitting a candidate still sees the whole menu — including
   routes out of the exam. Exam mode locks the AI and every tool, but not the
   navigation. Treating `/exam` as bare while a sitting is active would match
   what exam mode is for. `07-exam-screen.html` draws the frame, as the app
   does today.
2. **Sign in shows one 12-character field.** This design draws six one-character
   boxes instead, which is easier to read back and to correct by voice. If that
   is ported, the `fieldset` reset added to `src/index.css` is what makes it fit.
3. **`as-stat`, `as-notice` and `as-chip` recur across screens** and could become
   `lib/ui.js` exports rather than being rebuilt per page.

## What was changed in the app

The port, 13 October 2026:

- **`App.jsx` — Exams had no menu icon.** `HOME_NAV_ICONS` had no `/exams`
  entry, so the Exams item rendered an empty icon span. Added `assignment`,
  and the map is now written one line per route with a note that every section
  needs one.
- **`App.jsx` — removed 185 lines of unreachable navy-era frame.** `TopBar`,
  `Sidebar`, `NavIcon`, `GatewayStatus` and `AdminLink` had **zero** JSX usages:
  the shell renders `HomeSidebar` and `HomeTopBar` instead. `clockText` called a
  `pad()` that is not defined anywhere in the file, so it would have thrown had
  it ever run. Their helpers (`DAYS`, `MONTHS`, `startTime`, `SENSITIVITY_LABEL`)
  and the now-unused SVG `icon:` arrays in `allSections` went with them.
  This removed the last navy values from `App.jsx`.
- **`App.jsx` — the skip link and shell ink** still used `#F5A623` / `#050D19` /
  `#EDF0F5`; they now use `lib/ui.js`'s `#f5a623` / `#3d2600` / `#dae3f4`.
- **`tailwind.config.js` — the named colours were the old navy palette.**
  `ink: '#EDF0F5'` in particular sat behind every page through
  `@apply text-ink` in `index.css`, disagreeing with the `#dae3f4` every page
  actually uses. All names now match `lib/ui.js`.
- **`index.css` — added a `fieldset` reset.** A fieldset defaults to
  `min-width: min-content` and refuses to shrink: a row of six code boxes blew
  out to 1,978px inside a 420px card while `04-sign-in.html` was being drawn.
  The app has no fieldset today, so this is prevention, not a live fix.

`npm run build` passes after all of the above.
