# AbleSpeak — Product Guide, Architecture & User Manual

**Hands-free computer control for students who cannot use a keyboard or mouse.**

*Version: June 2026 · Combined overview, technical architecture, and user guide.*

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
- [Dictation: typing by voice](#dictation-typing-by-voice)
- [Confirmations, undo, and corrections](#confirmations-undo-and-corrections)
- [Privacy mode](#privacy-mode)
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
| **Typing by voice** | Dictation mode types speech directly into Word, Excel, or any text field, with spoken punctuation and editing commands |
| **Safety & recovery** | Spoken confirmation before irreversible actions, audible failure feedback, "undo that" and "no, I meant…" correction |
| **Privacy** | A one-word privacy mode that stops screen capture while keeping voice control |

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
- `ai-engine.js` — multi-provider LLM integration (Gemini, OpenAI, Anthropic, Groq) with a tool-calling loop for commands that need reasoning.
- `tool-registry.js` — the catalog of every action AbleSpeak can take, and the single chokepoint where the safety gate runs.
- `system-tools.js` — OS-level actions on Windows via PowerShell and UI Automation (launch apps, type, manage windows, dictate into Word/Excel).
- `safety.js` — pure, unit-tested logic for classifying risky actions and filtering phantom transcripts.
- `voice-handler.js` — speech-to-text via Gemini, with hallucination filtering.

**3. The Chrome extension.** A content script and service worker that let AbleSpeak see and act on web pages: navigate, click elements, scroll the right container, read content, and report page context back to the server.

## The voice pipeline

Speech can reach the server two ways: as **pre-transcribed text** from the browser's built-in speech recognition (instant), or as **audio** transcribed by Gemini. Either way it flows through the same ordered stages, designed so that control phrases and risky actions are handled before anything executes:

1. **Transcription & noise filtering.** Audio is transcribed, then screened for hallucinations, music, repetition, and echo of AbleSpeak's own voice.
2. **Voice control.** "Stop," "cancel," "go to sleep," "wake up," and **privacy mode** are caught here and never reach the AI.
3. **Confirmation reply.** If an irreversible action is waiting for a yes/no, this utterance is treated as the answer.
4. **Reactive correction.** "Undo that" and "no, I meant…" are handled before normal command matching.
5. **Dictation mode.** If dictation is on, speech is typed into the target app instead of being run as a command.
6. **Fast path.** Common commands (scroll, back, open, window control, media, volume) match instantly by pattern — roughly 200ms, no AI round-trip.
7. **AI path.** Anything more complex goes to the LLM, which can see the page context (and, unless privacy mode is on, a screenshot) and call tools to fulfill the request.

This ordering is intentional: a student can always interrupt, confirm, or correct, no matter what else is happening.

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

Full installation steps are in the project `README.md`. In short:

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

## Dictation: typing by voice

To type into a document or text field:

- Say **"Dictate"** (or "start typing") to turn on dictation mode. You can also say **"Dictate <your text>"** to switch on and type at once.
- Speak normally. Say punctuation by name — "period," "comma," "question mark," "new line," "new paragraph."
- Editing by voice while dictating: "delete word," "new line," "bold," "italic," "select all," "undo that," "next line," "end of document," and similar.
- Say **"Stop dictation"** (or "command mode") to return to normal commands.

Dictation types directly at the cursor — into Microsoft Word and Excel through their automation interfaces, and into any other field as a fallback — without disturbing the cursor or your clipboard.

## Confirmations, undo, and corrections

**Confirmations.** Before anything irreversible — closing an app with possible unsaved work, deleting permanently, or sending/submitting — AbleSpeak asks first. Reply **"yes"** (or "confirm," "go ahead," "do it") to proceed. Say anything else, or nothing, to cancel. Everyday reversible actions are not interrupted.

**Undo.** Say **"Undo that"** (also "take that back," "that's wrong," "wrong one") right after an action to reverse it.

**Corrections.** Say **"No, I meant <X>"** (also "actually <X>," "I wanted <X>") and AbleSpeak undoes the previous action and then does what you actually meant.

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
| `LLM_PROVIDER` | `gemini` | AI provider: gemini, openai, anthropic, groq |
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
