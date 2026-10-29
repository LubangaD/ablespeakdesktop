# AbleSpeak — Product Guide, Architecture & User Manual

**Hands-free computer control for students who cannot use a keyboard or mouse.**

*Version: September 2026 · Combined overview, technical architecture, and user guide.*

---

## Table of Contents

**Part 1 — Product Overview**
- [What AbleSpeak is](#what-ablespeak-is)
- [Who it is for](#who-it-is-for)
- [The problem it solves](#the-problem-it-solves)
- [What it can do](#what-it-can-do)
- [Design principles](#design-principles)

**Part 2 — How It Works (Architecture)**
- [System at a glance](#system-at-a-glance)
- [The three components](#the-three-components)
- [The voice pipeline](#the-voice-pipeline)
- [The safety layer](#the-safety-layer)
- [The tool catalog](#the-tool-catalog)
- [Privacy & security](#privacy--security)

**Part 3 — User Guide**
- [Setup in brief](#setup-in-brief)
- [Getting started](#getting-started)
- [Command reference](#command-reference)
- [What the overlay shows](#what-the-overlay-shows)
- [Dictation: typing by voice](#dictation-typing-by-voice)
- [Switching apps and documents](#switching-apps-and-documents)
- [Tasks with several steps](#tasks-with-several-steps)
- [Confirmations, undo, and corrections](#confirmations-undo-and-corrections)
- [Privacy mode](#privacy-mode)
- [For teachers: students, speech settings and progress](#for-teachers-students-speech-settings-and-progress)
- [Troubleshooting](#troubleshooting)

**Appendix**
- [Configuration reference](#configuration-reference)
- [Security notes for shared machines](#security-notes-for-shared-machines)

---

# Part 1 — Product Overview

## What AbleSpeak is

AbleSpeak is a desktop application that lets a person operate their computer and browse the web **entirely by voice**. It listens through a small floating microphone overlay, understands natural speech, and carries out the action — opening apps, navigating pages, clicking, scrolling, switching windows, and typing — so that someone who cannot use their hands can do the things a mouse-and-keyboard user takes for granted.

It is not a single feature bolted onto an operating system. It is a complete voice-native control layer made of three cooperating parts: a desktop app, a local AI gateway server, and a browser extension.

## Who it is for

AbleSpeak is built for students with limb differences or motor disabilities who cannot type or use a mouse, but who can speak. The goal is simple and demanding: hands-free control that feels as capable and trustworthy as using hands — close enough that the gap between intent and outcome effectively disappears.

Because the primary user cannot reach for a mouse to fix a mistake, the product is designed *backwards from the worst moment*: what happens when something goes wrong. Every important decision — confirmation, error feedback, undo, crash recovery — exists so that a wrong word never becomes an unrecoverable problem.

## The problem it solves

Mainstream dictation and voice-access tools tend to assume a user who can still take over manually — grab the mouse, hit Escape, retype a word. For someone who genuinely cannot, those tools leave gaps:

- An action runs on a misheard word, with no chance to stop it.
- A command fails silently, so the user waits and retries blindly.
- Voice navigation works on simple pages but quietly does nothing on the complex web apps students actually use.
- There is no fast way to say "no, not that — I meant this."

AbleSpeak closes those gaps by treating voice as the *only* input and engineering for it accordingly.

## What it can do

| Area | Examples |
|------|----------|
| **Browser control** | Open tabs, go to sites, click links and buttons, scroll, switch tabs, go back/forward, search, read the page aloud |
| **Desktop control** | Launch and switch between applications, minimize/maximize/snap windows, press keyboard shortcuts, control media and volume |
| **Typing by voice** | Dictation mode types speech directly into Word, Excel, or any text field, with spoken punctuation and editing commands. The student can keep talking while earlier phrases are typed |
| **Reading the screen** | Reads the controls of any Windows app through its accessibility information, and presses, types into, opens or scrolls them directly |
| **Tasks with several steps** | "Open my email and find the message from John" — AbleSpeak plans the steps, checks each one worked, and tries another way or stops and explains |
| **Safety & recovery** | Spoken confirmation before irreversible actions, audible failure feedback, "undo that" and "no, I meant…" correction |
| **Fits each student** | Microphone sensitivity, pause length, the student's own words, shortcuts and routines — and shortcuts learned from their corrections |
| **Progress evidence** | Every command is saved against the student using the computer, feeding goals, aim lines and trends on the Teacher page |
| **Privacy** | A one-word privacy mode that stops screen capture while keeping voice control; students' data stays on the computer |

## Design principles

1. **Work backwards from failure.** The hardest moments — a misrecognition, a wrong click, an app that steals focus — drive the design.
2. **Never act silently on a risky action.** Irreversible actions pause and ask.
3. **Never fake success.** If AbleSpeak cannot confirm something happened, it says so.
4. **Voice is the only hand.** There is always a spoken way to stop, undo, or correct.
5. **Dignity and privacy.** In a classroom or shared lab, the student controls what is seen and heard.

---

# Part 2 — How It Works (Architecture)

## System at a glance

```
┌──────────────────────────────────────────────────────────┐
│                 AbleSpeak Desktop (Electron)               │
│                                                            │
│   Floating mic overlay  ──┐        ┌── Dashboard UI        │
│   (the hands-free face)   │        │   (React, status)     │
│                           ▼        ▼                       │
│            ┌──────────────────────────────────┐            │
│            │   Gateway Server (Node, :3001)    │            │
│            │   • Voice pipeline (ws-proxy)      │           │
│            │   • AI engine (multi-provider)     │           │
│            │   • Tool registry + safety gate    │           │
│            │   • System tools (PowerShell/UIA)  │           │
│            │   • SQLite history                 │           │
│            └───────────────┬──────────────────┘            │
└────────────────────────────┼───────────────────────────────┘
                             │ WebSocket (loopback only)
                  ┌──────────▼───────────┐
                  │   Chrome Extension    │
                  │   page control +      │
                  │   context capture     │
                  └───────────────────────┘
```

## The three components

**1. The desktop app (Electron).** Hosts two windows: a small always-on-top **microphone overlay** that is the student's actual interface, and a **dashboard** showing connection health, command history, and settings. The overlay is deliberately *non-focusable* so it can never steal the text cursor from the app the student is typing into.

**2. The gateway server (Node, port 3001).** The brain. It receives speech, decides what to do, executes actions, and talks to the browser. Key modules:

- `ws-proxy.js` — the WebSocket hub and the heart of the voice pipeline. Routes every utterance, applies safety checks, and broadcasts results to the overlay/dashboard.
- `ai-engine.js` — multi-provider LLM integration (Gemini, OpenAI, Anthropic) with a tool-calling loop for commands that need reasoning.
- `tool-registry.js` — the catalog of every action AbleSpeak can take, and the single chokepoint where the safety gate runs.
- `system-tools.js` — OS-level actions on Windows via PowerShell and UI Automation (launch apps, type, manage windows, dictate into Word/Excel).
- `safety.js` — pure, unit-tested logic for classifying risky actions and filtering phantom transcripts.
- `voice-handler.js` — speech-to-text via Gemini, with hallucination filtering and the student's own vocabulary.
- `screen-model.js` — reads a window's controls through Windows UI Automation (compiled C# in `uia/`), and acts on them.
- `agent.js` — plans, acts, checks and recovers for instructions with several steps.
- `student-session.js`, `student-profile.js` — who is using the computer, and that student's speech settings, shortcuts and routines.

**3. The Chrome extension.** A content script and service worker that let AbleSpeak see and act on web pages: navigate, click elements, scroll the right container, read content, and report page context back to the server.

## The voice pipeline

Speech can reach the server two ways: as **pre-transcribed text** from the browser's built-in speech recognition (instant), or as **audio** transcribed by Gemini. Either way it flows through the same ordered stages, designed so that control phrases and risky actions are handled before anything executes:

1. **Transcription & noise filtering.** Audio is transcribed, then screened for hallucinations, music, repetition, and echo of AbleSpeak's own voice. With speech recognition on the computer (below), a clip that is a known command is acted on from the local words alone.
2. **Voice control.** "Stop," "cancel," "go to sleep," "wake up," and **privacy mode** are caught here and never reach the AI.
3. **Confirmation reply.** If an irreversible action is waiting for a yes/no, this utterance is treated as the answer.
4. **Reactive correction.** "Undo that" and "no, I meant…" are handled before normal command matching.
5. **Dictation mode.** If dictation is on, speech is typed into the target app instead of being run as a command.
6. **Fast path.** Common commands (scroll, back, open, window control, media, volume) match instantly by pattern — roughly 200ms, no AI round-trip.
7. **AI path.** Anything more complex goes to the LLM, which can see the page context (and, unless privacy mode is on, a screenshot) and call tools to fulfill the request.

This ordering is intentional: a student can always interrupt, confirm, or correct, no matter what else is happening.

### Real-time speech service (Modal)

The default way AbleSpeak hears speech (`listening.speechEngine` "auto", shown as "Real time").

**The service:**
- **Where:** `speech-server/stream_service.py`, deployed as `ablespeak-stream` on Modal, workspace `lubangad`.
- **Hardware and region:** one A10G GPU (L4 if none is free), in `region="eu"` / `routing_region="eu-west"`.
- **Models:** two CDLI Whisper models, converted to CTranslate2 and kept in the volume `ablespeak-stream-models`:
  - **small** gives the live words about every 0.5 s (about 60 ms of GPU each);
  - **large-v3** gives the final words (WER 0.14 on Kenyan English non-standard speech, about 200 ms).
- **Sleeping:** it sleeps when nobody is connected (`min_containers=0`, `scaledown_window=300`, `max_containers=2`).
- **Access key:** the Modal secret `ablespeak-stream`, matching `ABLESPEAK_ASR_TOKEN` in the device `.env`. The key is never in the installer.

**The connection** (`server/src/remote-asr.js`):
- The gateway keeps one WebSocket to `ABLESPEAK_ASR_URL`.
- **Wake on launch:** it opens when the app starts, which wakes the service. That took 15–20 s in tests and can take up to a minute.
- **Sleep:** after 10 minutes without speech it closes, so the service can sleep. The next phrase opens it again.
- **Health:** heartbeats every 15 s, and reconnects after 1, 2, 4, 8, 16 and 30 s. A refused key is retried every 5 minutes.

**The audio path:**
1. The voice bar streams 16 kHz PCM16 over the gateway WebSocket from the moment speech is detected, including half a second before it (`voice_stream_start`, `voice_chunk`).
2. The gateway forwards it, and sends the live words back as `voice_partial`. The voice bar shows them without announcing them; the transcript line's `aria-live` is off until the final words.
3. At the end of the recording the voice bar sends `voice_stream_end` first, so the final words start on the GPU, and then the clip with `streamUtt`.
4. `_transcribeClip` uses the service's final words. If they don't arrive within 3 s (6 s in dictation), the clip is heard another way (the engine on the computer if installed, otherwise Gemini).
5. The real-time check at the first short pause (`voice_peek`) asks the service for the words so far (`peek`) without ending the phrase.

**Exams** keep Gemini's word-for-word transcription.

**Measured on 15 Oct 2026, from Nairobi:**
- **Final words:** 0.5–1.1 s after the end of speech. Most of that is network (round trip 0.25–1.1 s); the GPU itself takes 0.16–0.27 s.
- **Example:** "scroll down" was carried out 0.7 s after the end of speech.

**Tools:**
- `speech-server/bench_stream.py` converts and benchmarks the models.
- `latency_probe.py` and `probe-latency.mjs` measure the network.
- `stream-test.mjs` streams test clips to the service.

### Speech recognition on the computer (optional offline pack)

The installer no longer includes it (283 MB). In development it is used when `server/vendor/local-asr` is present.

`server/src/local-asr.js` keeps whisper.cpp's `whisper-server.exe` running with CDLI's Whisper small model (`cdli/whisper-small_finetuned_kenyan_english_nonstandard_speech_v1.0`, Kenyan English and non-standard speech). The overlay records each clip twice, as compressed audio for Gemini and as a 16 kHz WAV for the local engine. It only records the WAV while the gateway reports `localSpeech: true` in `listening_settings`.

`WsProxy._transcribeClip` decides which words to use, according to the person's `listening.speechEngine`:

- **auto** (the default):
  - The local words are checked first. If they are a known command (`_isKnownCommand`: a quick command, shortcut, routine, stop, sleep, wake phrase, or yes/no to a pending question), they run at once and Gemini is not called. This also keeps the Gemini rate limit (12 a minute, 3 s apart) free for what needs it.
  - Otherwise Gemini decides.
  - In dictation, if Gemini fails or takes longer than 8 s, the local words are typed instead.
  - Outside dictation, local words that aren't a known command are never used. Anything else goes to the AI, which needs the internet anyway, and the local transcript of room talk must not run as a command.
  - In dictation, both run at once.
- **local:** only the computer; the internet is never used for speech. If the engine isn't ready, the voice bar says so (`voice_error` `local_failed`) instead of going online.
- **online:** only Gemini, as before.

Exams always use Gemini (`_examVoice`). In **auto**, until the engine has loaded, or if it is missing, everything goes to Gemini as before.

**Real time** (`voice_peek`, `WsProxy._onVoicePeek`):
- **The early check:** at the first short pause after speech (40% of the person's own pause, at least 0.5 s), the voice bar sends the words so far as a WAV.
- **When they are a complete command:** the gateway runs them at once and answers `voice_peek_result {taken: true}`, and the voice bar drops the rest of the clip. A complete command is one that can't be the start of a longer one (`EARLY_TOOLS`: scroll, back, forward, tabs, zoom, volume, window and media keys, opening an app, plus stop, sleep, wake, and yes/no to a question).
- **Otherwise:** the clip carries on and is sent as usual after the full pause. Commands that take free words ("search for…", "switch to…", "type…") and words that can begin something longer ("close", "play", the name alone) always wait for it.
- **Measured** on 15 Oct 2026: "scroll down" carried out about 0.8 s after the pause began, instead of about 3 s.

**Never deaf:** the voice bar checks every second that it is listening, and restarts within about 2 s if not (it used to check every 15 s, which left it deaf after each scroll). Opening the microphone is given 5 s. When a start is skipped, the reason is written to the app log.

**Keeping the engine up** (`LocalAsr`):
- **Restarts:** if the engine stops, it restarts after 2, 4 and 6 s, then once a minute. A crash after a minute of good running starts the count again.
- **Hangs:** two clips in a row with no answer count as a hung engine, which is restarted.
- **Queue:** clips are sent one at a time, and a clip that waited more than 8 s for its turn is skipped.
- **Audio window:** each clip is decoded with an audio window of its own length, rounded up to a multiple of 256 (512 at least, 1500 at most). Other sizes made clips of 9–28 s come back wrong.
- **Status:** `GET /api/health` reports `speechOnComputer` (`ready`, `starting`, `failed`, `missing` or `off`), and the Speech settings show it under "Where speech is recognised".

**Files:**
- Development: the files live in `server/vendor/local-asr/`, which git ignores.
- Installed app: they go to `resources/local-asr/` (see `extraResources` in `server/package.json`).
- Contents: `engine/arm64/Release/` and `engine/x64/Release/` (whisper.cpp release b5454; the Arm build runs natively on Snapdragon laptops), and `cdli-small/ggml-model*.bin`.

**Rebuilding the model file:** `node tools/convert-whisper-to-ggml.mjs <model folder> mel_filters.npz <out.bin>`. This converts the Hugging Face `model.safetensors`, `config.json` and `vocab.json` into the single file whisper.cpp loads, without PyTorch. Then `whisper-quantize.exe <in> <out> q8_0` makes the smaller 8-bit copy.

## The safety layer

This is what makes AbleSpeak safe for someone who cannot grab a mouse. It lives mostly in `safety.js` (pure, testable functions) and is wired through the pipeline.

**Confirmation gate.** Every action runs through one chokepoint (`executeTool`). Before an *irreversible* action runs — closing an application (which may lose unsaved work), permanently deleting, or sending/submitting/posting — AbleSpeak stops and asks out loud: *"Close this window? Say yes to confirm, or anything else to cancel."* Only a clear "yes" proceeds; anything else cancels, which is the safe default. Reversible actions (closing a browser tab, scrolling, clicking, copy) are deliberately **not** gated, to keep everyday use fast.

**Audible failure.** A failed command is never silent. Even commands that normally run quietly will speak up if they fail, so the student never waits and retries blindly.

**No fabricated success.** If the browser extension goes quiet, the server reports an explicit error — it never claims an unverified action succeeded.

**Hallucination detection.** A single, tested filter catches phantom transcripts (known filler phrases, over-long song-lyric blocks, repetitive noise, and echoes of AbleSpeak's own text-to-speech) so the system doesn't act on things the student never said.

**Reactive correction.** Right after a mistake — the moment the student notices — "undo that" reverses the last action (browser back for navigation, otherwise Ctrl+Z), and "no, I meant <X>" undoes and then runs the corrected command.

**Crash recovery.** Both the dashboard and the floating overlay automatically reload if their process dies, so the student's interface comes back without anyone needing to touch the machine.

## The tool catalog

Tools are grouped roughly as:

- **Browser:** open/close/switch tabs, navigate, click, scroll (with smart container detection), read page, search, fill forms.
- **System:** launch and focus apps, type text, press key combinations, media and volume control.
- **Window management:** minimize, maximize, restore, snap left/right.
- **Dictation:** type speech, plus in-line editing (new line, delete word, bold, undo, select all, navigate by line/paragraph).

The AI selects tools when reasoning is needed; the fast path maps common phrases straight to tools for speed.

## Privacy & security

The control plane is **loopback-only** (never reachable over the network) and **origin-locked** (a malicious website cannot open a connection to drive the computer). An optional shared-secret token adds another layer on shared machines. **Privacy mode** stops all screen capture on command while keeping voice control alive — important in classrooms where the screen may show other students' work.

---

# Part 3 — User Guide

## Setup in brief

Setting up a student's computer from the installer: follow
[INSTALL-FOR-TEACHERS.md](INSTALL-FOR-TEACHERS.md). It is written for a
teacher, not a developer.

Running from source: full steps are in the project `README.md`. In short:

1. Install Node.js 18+ and Google Chrome.
2. In `server/`, run `npm install`, copy `.env.example` to `.env`, and add at least one AI API key (Gemini recommended).
3. Build the dashboard: in `dashboard/`, run `npm install` then `npx vite build`.
4. Start the app: in `server/`, run `npm run desktop`.
5. Load the Chrome extension: go to `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `chrome-integration-master/` folder. The extension icon turns green when connected.

## Getting started

When AbleSpeak is running you'll see a small microphone overlay near the bottom of the screen. Speak naturally. You don't need wake words for normal commands — just say what you want.

A few foundational commands:

- **"Stop"** or **"Cancel"** — interrupt whatever is happening.
- **"Go to sleep"** — AbleSpeak stops acting on commands until you say **"Wake up."**
- **"Undo that"** — reverse the last action.

## Command reference

These phrases match the instant fast path. Natural variations generally work too; anything not listed is understood by the AI.

**Navigation & browsing**

| Say | Result |
|-----|--------|
| "Scroll down" / "Scroll up" / "Page down" | Scroll the right part of the page |
| "Go to the top" / "Go to the bottom" | Jump to start/end |
| "Go back" / "Go forward" | Browser history |
| "Reload" / "Refresh the page" | Reload the tab |
| "New tab" | Open a blank tab |
| "Close this tab" | Close the current tab (reopenable) |
| "Search for <query>" / "Google <query>" | Search in place |
| "Open <site>" / "Go to my email" | Open or navigate (AI) |
| "Click the <thing>" | Click an element (AI, with disambiguation) |

**Windows & apps**

| Say | Result |
|-----|--------|
| "Switch to <app>" / "Bring Chrome to the front" | Focus an application |
| "Minimize" / "Maximize" / "Full screen" | Window state |
| "Restore" | Un-maximize |
| "Snap left" / "Snap right" | Tile the window to half the screen |

**Media, volume & keys**

| Say | Result |
|-----|--------|
| "Pause" / "Play" / "Next song" | Media control |
| "Volume up" / "Volume down" / "Mute" | System volume |
| "Enter" / "Escape" / "Tab" / "Space" | Key presses |
| "Copy" / "Paste" / "Cut" / "Select all" / "Save" | Shortcuts |

**Sessions**

| Say | Result |
|-----|--------|
| "Stop" / "Cancel" | Interrupt the current action |
| "Go to sleep" → "Wake up" | Pause and resume listening |

## What the overlay shows

Above the microphone, the overlay always shows the last command:

- **Heard: "…"** — what AbleSpeak took the student to say.
- The result underneath: **Working…**, then **✓ Done**, **✗ Didn't work** (also said aloud, with the reason), or **Ignored** when the sound was treated as background talk.
- During a task with several steps: **Step 2 of 4: …**, and **Waiting — say yes or no** when it needs a confirmation.
- The top line shows whose session it is, for example "Amina's session". Say **"Who am I?"** to hear it.

## Dictation: typing by voice

To type into a document or text field:

- Say **"Dictate"** (or "start typing") to turn on dictation mode. You can also say **"Dictate, my name is Amina"** or **"My name is Amina. Dictate."** to switch on and type at once — capital letters and full stops are kept.
- Speak normally. Each pause (about two seconds, or longer if set for the student) ends a phrase, and the phrase is typed. The student can keep talking while it types; nothing said in the meantime is lost, and phrases are typed in order.
- Say punctuation by name — "period," "comma," "question mark," "new line," "new paragraph."
- Editing by voice while dictating: "delete word," "new line," "bold," "italic," "select all," "undo that," "next line," "end of document," and similar.
- To give a command without leaving dictation, start with the name: **"AbleSpeak, open Chrome."** A sentence like "AbleSpeak is great" is still typed.
- If AbleSpeak asks a question during dictation, "yes" or "no" answers it; anything else is typed and the question is dropped.
- Say **"Stop dictation"** (or "command mode") to return to normal commands.

To type one piece of text without dictation mode, say **"Type this"**. AbleSpeak asks for the words, and the next thing said is typed. On the Chat page, **"Type this: <text>"** types the text straight away, exactly as written.

## Switching apps and documents

- **"Switch to Word"**, **"Go to Word"**, **"Bring my Word document to the front"** — everyday names work: "Word document", "my spreadsheet", "the presentation", "file explorer".
- **"Bring my essay to the front"** — an open document can be found by its title.
- If the app is not open, AbleSpeak says so and suggests "open Word".

## Tasks with several steps

Say the whole thing at once: **"Open my email and find the message from John"**, **"Open Notepad, type my name, then save it"**.

- AbleSpeak makes a short plan and shows each step on the overlay.
- After every step it reads the screen again to check the step worked. If it did not, it tries a different way (at most twice). If it still cannot finish, it takes back any typing it did, stops, and says how far it got and why.
- Before anything that cannot be undone — deleting, sending, closing a window — it stops and asks. "Yes" carries on; anything else stops the task.
- Say **"Stop"** at any time to end the task. Typing already done is kept.
- A **routine** is a task with a name, set up by a teacher (see below): **"Start my homework"** runs its steps in order.

Dictation types into the app that was in use when it started. In Microsoft Word and Excel it types at the cursor through their automation interfaces. In any other app it pastes, then puts back what was on the clipboard.

## Confirmations, undo, and corrections

**Confirmations.** Before anything irreversible — closing an app with possible unsaved work, deleting permanently, or sending/submitting — AbleSpeak asks first. Reply **"yes"** (or "confirm," "go ahead," "do it") to proceed. Say anything else, or nothing, to cancel. Everyday reversible actions are not interrupted.

**Undo.** Say **"Undo that"** (also "take that back," "that's wrong," "wrong one") right after an action to reverse it.

**Corrections.** Say **"No, I meant <X>"** (also "actually <X>," "I wanted <X>") and AbleSpeak undoes the previous action and then does what you actually meant.

## For teachers: students, speech settings and progress

Everything here is on the dashboard's **Teacher** page, and only opens on the computer itself.

- **Trying things without a microphone.** Type on the **Chat** page. A typed command does exactly what the same words said aloud would do: quick commands, dictation, routines, tasks and questions. It acts on the app you used before the dashboard, not on the dashboard. The reply is spoken by the overlay, in the same voice as always.
- **Who is using this computer.** Add students by first name or initials and choose who is at the computer. AbleSpeak remembers the choice after a restart; choose again only when a different student sits down. Commands from the dashboard's Chat page never count toward a student's progress.
- **How well AbleSpeak hears them.** For the last 7 days: how often they were understood, how often a command worked first time, how many retries, and the words set aside as background talk (if those were the student, try "Quiet voice"). It also compares retries per command before and after the last change to their speech settings.
- **Speech settings.** Microphone sensitivity (standard, quiet voice, noisy room), the pause that ends a command, the student's own words (names, subjects, places), their shortcuts ("my music" → "open spotify") and routines. Shortcuts marked **learned** were added by AbleSpeak after the student corrected the same thing twice with "no, I meant …".
- **Another computer.** "Save to a file" and "Load from a file" carry a student's settings to a different computer.
- **Goals and progress.** Goals, aim lines, trends and decision flags come from the student's own saved commands.

Setting up a new computer: see [INSTALL-FOR-TEACHERS.md](INSTALL-FOR-TEACHERS.md).

## Privacy mode

In a shared or classroom setting you may not want the screen captured. Say **"Privacy mode"** (also "stop watching," "vision off," "eyes off") and AbleSpeak stops capturing the screen while continuing to listen and act on voice. Say **"Vision on"** (also "privacy off," "you can look") to resume.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Overlay shows text but nothing types | Make sure you're in **dictation mode** ("dictate") and the target app's cursor is in a text field. |
| "Scroll down" does nothing on a web app | The extension must be connected (green icon). The scroll now targets inner panels on sites like Gmail/Docs automatically. |
| A command failed | AbleSpeak will say so out loud; try rephrasing or check that the Chrome extension is connected. |
| It heard something you didn't say | Phantom/noise transcripts are filtered; if one slips through, say "Stop," then "Undo that." |
| Extension icon is red | The server isn't running or the page needs a reload; restart `npm run desktop`. |

---

# Appendix

## Configuration reference

Key settings live in `server/.env`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER` | `gemini` | AI provider: gemini, openai, anthropic |
| `LLM_MODEL` | `gemini-2.0-flash` | Model for the chosen provider |
| `GEMINI_API_KEY` (etc.) | — | API key for the chosen provider |
| `GATEWAY_PORT` | `3001` | Server port |
| `ABLESPEAK_WS_TOKEN` | — | Optional shared secret for the control plane |
| `ABLESPEAK_EXT_ID` | — | Optional: pin to a specific extension ID |

## Security notes for shared machines

The WebSocket control plane is locked down at three levels:

1. **Loopback only** — connections from anywhere but the local machine are refused, so nothing on the network can drive the computer.
2. **Origin lock** — only the local dashboard/overlay and the AbleSpeak extension may connect; a malicious web page cannot.
3. **Optional token** — set `ABLESPEAK_WS_TOKEN` on a shared/lab machine and configure it in the dashboard and extension for an additional pairing secret.

Combined with **privacy mode**, this lets AbleSpeak be used in classrooms and shared labs without exposing the control plane or the screen.

---

*Built for accessibility — so a student's voice can do everything their hands would.*
