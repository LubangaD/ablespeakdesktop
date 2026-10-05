# AbleSpeak Desktop (Tier 2)

**Control a whole Windows computer by voice.** AbleSpeak lets a person who can't use a keyboard or mouse well open apps, browse the web, click anything on screen, dictate into Word, read pages aloud and fix mistakes — just by talking.

![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)

> **In depth:** [docs/AbleSpeak-Full-Computer-Nav-Design.md](docs/AbleSpeak-Full-Computer-Nav-Design.md) — how every part works, with diagrams.

---

## Contents

1. [What it does](#what-it-does)
2. [How it works](#how-it-works)
3. [Quick start](#quick-start)
4. [First run](#first-run)
5. [Things to say](#things-to-say)
6. [Configuration](#configuration)
7. [Project structure](#project-structure)
8. [Development](#development)
9. [Privacy and security](#privacy-and-security)
10. [Documentation](#documentation)
11. [Status and roadmap](#status-and-roadmap)

---

## What it does

| | |
|---|---|
| **Voice bar** | A small round mic that stays on top of every app. It listens, shows what it heard, and opens into a short card for results, problems, questions (Yes / No) and dictation (Stop). |
| **Desktop apps** | Opens, switches and closes apps; reads and presses any button, menu, slider or field through Windows UI Automation; understands Word and Excel (cells, spelling). |
| **The web** | Through a Chrome extension: opens sites, follows links by what you say ("open the Wikipedia link"), scrolls, plays and pauses video, reads the article on a page. |
| **Typing** | Dictation into the window you were in, plus spelling fixes in Word. |
| **Reading** | "What's on my screen" and "read this page" read the window you are actually using — a web page, a Word document or any other app. |
| **Safety** | Asks before anything risky (delete, send, close unsaved work); "pause" or "stop" silences any player instantly. |
| **Accounts** | Sign in with an email code or Google (Supabase, EU). Roles (`admin`, `helper`) come from the account. |
| **Dashboard** | Home ("What can I do?"), My progress, Voice & words, plus Helper and Admin pages. |

AbleSpeak is a **personal tool**: each person signs in and sees only their own progress. Helpers and admins get extra pages through their account role or a PIN.

---

## How it works

```
 You speak ──► Voice bar (Electron overlay)
                 │  records a clip when you stop talking
                 ▼
            Gateway server  (Node/Express, localhost:3001)
                 │  1. speech → text (Gemini)
                 │  2. "pause"/"stop"?  → pause any player
                 │  3. sleep, dictation, yes/no, quick commands → done instantly
                 │  4. anything else → AI engine (Gemini / OpenAI / Anthropic) + 56 tools
                 ▼
     ┌───────────┴────────────┬──────────────────────┐
 Chrome extension       PowerShell worker        Accounts
 (web pages)            (Windows UI Automation,  (Supabase Auth, EU)
                         Office, media, input)
                 │
                 ▼
            Reply ──► voice bar card + spoken answer (Edge TTS)
```

Everything runs in **one Electron process** on the person's computer: the voice bar, the dashboard window and the gateway server. Only speech recognition, the AI model, text-to-speech and sign-in use online services.

---

## Quick start

### Requirements

- **Windows 10 or 11** (the desktop control uses Windows UI Automation and PowerShell)
- **Node.js 20+** and npm
- **Google Chrome** (for web control)
- A **Google Gemini API key** (speech recognition always uses Gemini; the AI model can be Gemini, OpenAI or Anthropic)

### Install

```bash
git clone https://github.com/LubangaD/ablespeakdesktop.git
cd ablespeakdesktop

# Server + Electron app
cd server && npm install && cd ..

# Dashboard (built once; the server serves dashboard/dist)
cd dashboard && npm install && npm run build && cd ..
```

### Configure

Create `server/.env` (it is git-ignored — never commit it):

```ini
GEMINI_API_KEY=your-gemini-key

# Optional: another AI model for commands
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...

# Optional: accounts and sign-in (Supabase, EU)
# SUPABASE_URL=https://<project>.supabase.co
# SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

API keys can also be added later in the dashboard: **Settings → API keys**.

### Run

```bash
cd server
npm run desktop
```

The dashboard opens, and the voice bar appears once someone signs in (or chooses **Not now**).

### Load the Chrome extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `chrome-integration-master` folder.
3. After pulling changes to the extension, click its **↻ reload** button.

---

## First run

1. **Sign in** (or **Not now — keep using this computer only**). Sign-in needs the Supabase settings above; without them AbleSpeak works on this computer only.
2. **Admin access** — pick one:
   - **Admin PIN:** right-click the AbleSpeak tray icon → **Set admin PIN…** (the first PIN can only be set from the tray, never by voice).
   - **Your own computer:** tray → **Admin pages without a PIN…** opens every page for your Windows account.
   - **Your account:** give it the role in Supabase → SQL Editor:
     ```sql
     update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"ablespeak_role": "admin"}'::jsonb
     where email = 'you@example.com';
     ```
     Use `"helper"` for someone who only needs the Users page. The role is picked up at the next start or sign-in.
3. **Noisy room?** In **Voice & words**, set the listening profile to **Noisy room** so voices from outside are not taken as commands.

---

## Things to say

| To… | Say |
|---|---|
| Open an app | "Open Word", "Switch to Chrome", "Close Notepad" |
| Dictate | "Start dictation" … "Stop dictation" |
| Browse | "Open YouTube", "Open the first link", "Go back", "Scroll down" |
| Read | "What's on my screen?", "Read this page", "Read the next paragraph" |
| Media | "Pause", "Play", "Next song", "Volume down" |
| Control | "Click Settings", "Minimise this window", "Fix the spelling" |
| The voice bar | "Go to sleep" / "Wake up", "Hide" / "Come back", "Stop" |

---

## Configuration

All settings live in `server/.env` (in a packaged install: `%APPDATA%\AbleSpeak\.env`).

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Speech recognition (required) and the Gemini AI model |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Other AI models for commands (optional) |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_TEMPERATURE` | Which AI model handles commands (also set in Settings) |
| `VOICE_MODEL` | Gemini model for speech recognition (default `gemini-2.5-flash`) |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Accounts and sign-in. The publishable key is safe in apps; **never** put the secret key here |
| `GATEWAY_PORT` | Local server port (default `3001`) |
| `ABLESPEAK_TTS_VOICE` | Edge TTS voice for spoken replies |
| `ADMIN_PIN_HASH`, `HELPER_PIN_HASH` | Written by the app (scrypt hashes); delete a line to reset that PIN |

---

## Project structure

```
ablespeakdesktop/
├── server/                       Electron app + gateway server
│   ├── electron-main.cjs         Windows, tray, shortcut, speech output, when the voice bar shows
│   ├── overlay.html              The voice bar (round mic + state cards)
│   ├── overlay-messages.js       What the voice bar says, in plain words
│   ├── src/
│   │   ├── index.js              Server start-up and routes
│   │   ├── ws-proxy.js           Voice pipeline: what happens to something said
│   │   ├── voice-handler.js      Speech → text (Gemini)
│   │   ├── fast-commands.js      Instant commands, no AI
│   │   ├── ai-engine.js          AI prompt and tool loop
│   │   ├── tool-registry.js      The 56 tools
│   │   ├── system-tools.js       Windows input, apps, dictation, media (PowerShell worker)
│   │   ├── screen-model.js       Reading desktop apps (UI Automation)
│   │   ├── office-uia.js         Word and Excel details, spelling
│   │   ├── account.js            Sign-in (email code, Google), roles
│   │   ├── admin-pin.js          Admin and helper PINs, access tiers
│   │   ├── student-profile.js    Listening profiles, words, shortcuts
│   │   ├── db.js                 SQLite (sql.js) data
│   │   └── *.test.mjs            Tests (node --test)
│   └── data/                     Local database and sign-in (git-ignored)
├── dashboard/                    React + Vite + Tailwind dashboard
│   └── src/pages/                Home, SignIn, MyProgress, SpeechProfile, Students, Settings, …
├── chrome-integration-master/    Chrome extension (web control)
└── docs/                         Design, plans, guides
```

---

## Development

```bash
# Server tests (386 tests, including real UI Automation checks on Windows)
cd server && npm test

# Run only the gateway, without Electron
cd server && npm run dev

# Dashboard: live reload, check a page, build
cd dashboard && npm run dev
node scripts/check-page.mjs src/pages/Home.jsx
npm run build

# Windows installer
cd server && npm run build:win
```

- Logs from a desktop run: the terminal running `npm run desktop`. The voice bar's warnings and mic events appear as `[Overlay] …`.
- Project conventions for contributors and AI agents: [CLAUDE.md](CLAUDE.md).

---

## Privacy and security

- **Local first:** the gateway listens only on `localhost`; WebSockets check a token and the origin; account and admin routes refuse other websites.
- **Sign-in:** tokens stay on the server, encrypted with Windows' own protection (Electron `safeStorage`), never in `.env`, logs or the dashboard.
- **What leaves the computer:** voice clips (to Gemini for transcription), commands and screen summaries (to the chosen AI provider), spoken replies (Edge TTS), sign-in (Supabase, EU; Google if chosen). Nothing else.
- **Asks first** before consequential actions; voice can never open admin pages or set the first PIN.

---

## Documentation

| Document | What's in it |
|---|---|
| [Full Computer Nav design](docs/AbleSpeak-Full-Computer-Nav-Design.md) | Architecture, pipeline, access tiers, speed, known limits |
| [Phase 2 accounts plan](docs/AbleSpeak-Tier2-Phase2-Accounts-Plan.md) | Accounts, sync, consent and the decisions taken |
| [Product roadmap](docs/AbleSpeak-Tier2-Product-Roadmap.md) | Where Tier 2 is going |
| [User guide](docs/AbleSpeak-Guide.md) | Using AbleSpeak day to day |
| [Install for teachers](docs/INSTALL-FOR-TEACHERS.md) | Setting up a school computer |
| [Design system](docs/design/DESIGN.md) | Colours, type and screens |

---

## Status and roadmap

Working today: voice control of desktop apps and Chrome, dictation, reading, accounts with roles, the new voice bar.

Next:

- **Speed** — speech recognition is about 2 s of a ~3 s command; plan: on-computer recognition for quick commands, smaller clips, streaming.
- **Offline** — quick commands without internet.
- **Profile sync** to the account (Phase 2).
- **Press-to-talk** for busy rooms.
- Server-side role checks for the Users data routes; a Content-Security-Policy for the voice bar.

---

**License:** MIT — built for accessibility, with love in Nairobi, Kenya.
