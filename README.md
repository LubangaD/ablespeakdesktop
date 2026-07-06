# AbleSpeak Desktop — Accessible Voice Command Center

> A fully accessible, AI-powered voice command center for students with motor disabilities. AbleSpeak gives complete hands-free control of the computer and browser through natural voice commands.

![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## Table of Contents

- [What is AbleSpeak Desktop?](#what-is-ablespeak-desktop)
- [How It Works — Full Pipeline](#how-it-works--full-pipeline)
- [Architecture](#architecture)
- [Component Deep Dive](#component-deep-dive)
- [Voice Command Flow](#voice-command-flow)
- [Features](#features)
- [Prerequisites & Installation](#prerequisites--installation)
- [Running the App](#running-the-app)
- [Loading the Chrome Extension](#loading-the-chrome-extension)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Accessibility](#accessibility)
- [Development Guide](#development-guide)
- [License](#license)

---

## What is AbleSpeak Desktop?

AbleSpeak Desktop is a standalone Windows/Mac application that acts as an **AI-powered voice command center**. It is purpose-built for students with motor impairments (cerebral palsy, muscular dystrophy, spinal cord injuries) who cannot use a keyboard or mouse.

The application has three components that work together:

1. **Transparent Voice Overlay** — a borderless, always-on-top window that the student talks to. This is the *only* interface the student uses. It shows their speech as they talk and responds in real time.
2. **Gateway Server** — an Express backend that receives voice audio, transcribes it via Gemini, routes it through an AI agent, and executes the resulting tool calls (browser actions, system control, etc.).
3. **Chrome Browser Extension** — a bridge that lets the gateway server control the student's Chrome browser (open tabs, click elements, fill forms, scroll pages, navigate back/forward).

> **Key design constraint**: The student never sees or touches the dashboard. The dashboard and its Chat microphone are for developers and support staff to monitor, test, and debug. The transparent overlay is the student's only control surface.

---

## How It Works — Full Pipeline

Here is the complete path from a spoken word to an action on screen:

```
Student speaks
    │
    ▼
[Overlay] — MediaRecorder captures audio chunks (500ms–8s)
    │         Voice Activity Detection with amplitude threshold
    │         Echo protection: mic pauses while TTS plays
    │
    ▼ WebSocket voice_audio event
[Gateway Server :3001]
    │
    ▼
[VoiceHandler] — Sends audio to Gemini API (audio→text)
    │             Applies SILENCE-marker hallucination filter
    │             Returns clean transcript or 'no_speech'
    │
    ▼
[Fast Command Router] — Pattern-matches transcript against ~40 common commands
    │   HIT  → Executes tool call immediately (~200ms, no LLM)
    │   MISS ↓
    ▼
[AI Engine] — Sends transcript to LLM (Gemini / OpenAI / Anthropic / Groq)
    │          LLM selects a tool and returns tool_call JSON
    │          Retry with exponential backoff on errors
    │
    ▼
[Tool Registry / System Tools] — Tool execution
    │
    ├── Browser tool (e.g. scroll, click, open_url)
    │       └─► WebSocket command to Chrome Extension
    │                └─► content.js executes on active tab
    │
    └── System tool (e.g. type_text, press_key, launch_app)
            └─► Electron IPC → main process → OS API
    │
    ▼
[TTS Response] — Spoken confirmation back to overlay
    │             Overlay pauses mic during playback
    │             2500ms cooldown before mic resumes
    │
    ▼
Student hears result, cycle repeats
```

**Latency targets:**
- Fast command (no LLM): ~200–500ms end-to-end
- LLM command: ~2–8 seconds depending on model
- TTS to mic resume: ~2500ms after speech ends

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AbleSpeak Desktop (Electron)                     │
│                                                                     │
│  ┌───────────────────────────────────┐  ┌────────────────────────┐ │
│  │  Transparent Overlay Window       │  │  Dashboard Window      │ │
│  │  overlay.html (always-on-top)     │  │  React + Vite SPA      │ │
│  │  • Student's ONLY interface       │  │  • Dev/support only    │ │
│  │  • Voice Activity Detection       │  │  • Chat, Logs, Tools   │ │
│  │  • MediaRecorder (mic capture)    │  │  • Metrics, Settings   │ │
│  │  • AudioContext (reused, not      │  │                        │ │
│  │    recreated per recording)       │  └───────────┬────────────┘ │
│  │  • TTS echo protection            │              │ WebSocket     │
│  └──────────────┬────────────────────┘              │               │
│                 │ WebSocket (voice_audio)            │               │
│  ┌──────────────▼────────────────────────────────────▼────────────┐ │
│  │             Gateway Server (Express — port 3001)               │ │
│  │                                                                 │ │
│  │  ┌────────────────┐  ┌─────────────────┐  ┌────────────────┐  │ │
│  │  │  VoiceHandler  │  │  Fast Commands  │  │   AI Engine    │  │ │
│  │  │  Gemini STT    │  │  ~40 patterns   │  │  Multi-LLM     │  │ │
│  │  │  Hallucination │  │  ~200ms latency │  │  Tool calling  │  │ │
│  │  │  filter        │  │  No LLM needed  │  │  Retry logic   │  │ │
│  │  └────────┬───────┘  └────────┬────────┘  └───────┬────────┘  │ │
│  │           └──────────────┬────┘                    │           │ │
│  │                          ▼                         │           │ │
│  │             ┌────────────────────────┐             │           │ │
│  │             │   Tool Registry /      │◄────────────┘           │ │
│  │             │   System Tools         │                          │ │
│  │             └──────────┬─────────────┘                          │ │
│  │                        │                                        │ │
│  │             ┌──────────▼──────────┐                            │ │
│  │             │   WS Hub (ws-proxy) │                            │ │
│  │             │  /ws/dashboard      │                            │ │
│  │             │  /ws/extension      │                            │ │
│  │             └──────────┬──────────┘                            │ │
│  │                        │                                        │ │
│  │  ┌─────────────────────┤                                        │ │
│  │  │  SQLite DB · Log    │                                        │ │
│  │  │  Tailer · Safety    │                                        │ │
│  │  └─────────────────────┘                                        │ │
│  └──────────────────────────────────────────────────────────────── ┘ │
└──────────────────────────────────────┬──────────────────────────────┘
                                       │ WebSocket /ws/extension
                              ┌────────▼────────────────┐
                              │  Chrome Extension        │
                              │  chrome-integration-     │
                              │  master                  │
                              │                          │
                              │  service-worker.js:      │
                              │  • Persistent WS         │
                              │  • chrome.alarms         │
                              │    heartbeat (1 min)     │
                              │  • Keeps context fresh   │
                              │                          │
                              │  content.js:             │
                              │  • Executes DOM actions  │
                              │  • Pushes page context   │
                              │    (viewport elements,   │
                              │    URL, title, scroll)   │
                              └──────────────────────────┘
```

---

## Component Deep Dive

### Transparent Overlay (`server/overlay.html`)

The overlay is an Electron `BrowserWindow` with `transparent: true`, `frame: false`, `alwaysOnTop: true`. It is the student's only interface.

**Voice Activity Detection:**
- A continuous `analyser` node on the `AudioContext` monitors amplitude every 50ms
- `SILENCE_THRESHOLD = 15` — below this, the mic considers input as silence
- `SPEECH_THRESHOLD = 45` — above this, speech is detected and recording begins (or continues)
- `MIN_RECORD_MS = 600` — minimum utterance length to avoid noise bursts
- `MAX_RECORD_MS = 8000` — hard cap to prevent runaway recordings
- `SILENCE_DURATION = 1500` — after this much silence, the current recording is finalized and sent

**AudioContext Reuse (Fix #7):**
The overlay reuses a single `AudioContext` across all recording sessions rather than creating a new one per recording. Chrome limits the rate at which new audio contexts can be created; repeatedly creating them caused the overlay to stop working after ~3 commands. The fix: lazy-init on first use, resume if suspended, and `disconnect()` the `MediaStreamSource` (not `close()` the context) when a recording ends.

```js
// On each new recording session:
if (!audioCtx || audioCtx.state === 'closed') {
  audioCtx = new AudioContext();
} else if (audioCtx.state === 'suspended') {
  audioCtx.resume();
}
```

**Echo Protection:**
When the gateway sends a `voice_tts` message (TTS about to play), the overlay stops the mic. It restarts only after TTS finishes plus a `TTS_COOLDOWN_MS = 2500` delay. This prevents AbleSpeak from hearing its own voice and processing it as a command.

**Automatic Recovery:**
A 15-second watchdog timer checks whether the overlay has been stuck in "processing" or "idle" states too long. If it detects a stall, it resets the recording state and restarts the mic.

---

### Gateway Server (`server/src/`)

The gateway is an Express server on port 3001. It wires together all back-end components.

**VoiceHandler (`voice-handler.js`):**
Sends raw audio to the Gemini Audio API (or a configured STT endpoint). Before returning the transcript, it applies a **SILENCE hallucination filter**:

Gemini sometimes returns phantom transcripts like `"SILENCE\n[20 words of filler]\nSILENCE"` when given silence or near-silence. The filter:
1. Checks for `\bsilence\b` in the raw transcript
2. Strips leading/trailing SILENCE markers
3. If the remaining text is more than 8 words AND the original had a SILENCE marker, it's classified as hallucinated and returns `no_speech` instead

This prevents the system from acting on phantom speech during quiet moments.

**Fast Command Router (`fast-commands.js`):**
Before sending a transcript to the LLM, the router pattern-matches it against ~40 common commands (scroll, go back, open tab, volume up, etc.). Matches execute in ~200ms — no LLM call, no latency. Gemini transcription adds punctuation and filler words; the router's `cleanTranscription()` strips these before matching.

Silent commands (scroll, go_back, click_element, etc.) execute without a TTS confirmation, so the mic can resume immediately.

**AI Engine (`ai-engine.js`):**
For transcripts that don't match a fast command, the engine calls the configured LLM with the transcript and the available tool definitions. The LLM returns a `tool_call` JSON object. Supports Gemini, OpenAI, Anthropic, and Groq — switchable at runtime from the Settings page.

**WebSocket Hub (`ws-proxy.js`):**
All real-time communication flows through `ws-proxy.js`. It manages two WebSocket namespaces:
- `/ws/dashboard` — used by the React dashboard and the overlay
- `/ws/extension` — used by the Chrome browser extension

The hub routes browser tool calls to the extension, dashboard events to connected clients, and voice audio from the overlay to `VoiceHandler`.

**Dictation Mode:**
When the student says "dictate", the WS proxy enters dictation mode. In this mode, all transcripts are forwarded directly to the browser as typed text — no command matching, no LLM. Say "stop dictating" to exit. The interrupt regex check (`stop|cancel|abort...`) is guarded by `!this._dictationMode` so it doesn't fire mid-dictation when the student says "stop [word]" within their dictated text.

---

### Chrome Browser Extension (`chrome-integration-master/`)

The extension is a Chrome MV3 extension that acts as a bridge between the gateway server and the browser.

**Service Worker (`service-worker.js`):**
The service worker maintains a persistent WebSocket connection to `ws://localhost:3001/ws/extension`. MV3 service workers suspend after ~30 seconds of idle — killing the WebSocket and a 1-second context-push timer. AbleSpeak works around this with a `chrome.alarms` heartbeat:

```js
const HEARTBEAT_ALARM = 'ablespeak-heartbeat';
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  // Reopen WebSocket if it has been dropped
  if (enabled && (!webSocket || webSocket.readyState !== WebSocket.OPEN)) {
    startReconnectionLoop();
  }
});
```

`chrome.alarms` survive service worker suspension, unlike `setInterval`/`setTimeout`. This keeps the bridge alive indefinitely.

**Context Pushing:**
The service worker pushes a `browser_context` snapshot to the gateway every second while active. The snapshot includes:
- `url` — the active tab's URL
- `title` — page title
- `viewportElements` — all visible, interactable elements (buttons, links, inputs, selects) with their text, type, and bounding rect

The gateway caches this context. When the LLM wants to `click_element "Submit"`, it searches the cached `viewportElements` for a fuzzy-match. Fresh context prevents stale-context bugs where the LLM tries to click elements that have scrolled off-screen or navigated away.

**Content Script (`scripts/content.js`):**
Injected into every page. Executes the actual DOM actions when the service worker forwards a tool command:
- `click_element` — fuzzy-matches element text and fires a click
- `type_text` — dispatches keyboard events into the focused element
- `scroll` — calls `window.scrollBy()`
- `get_page_content` — returns all visible text for the LLM to read
- `press_key_combination` — fires `KeyboardEvent` for Ctrl+C, Ctrl+V, etc.

---

### Dashboard (`dashboard/src/pages/`)

The dashboard is a React SPA served from `http://localhost:3001`. It is for developers and support staff only — not the student.

| Page | Purpose |
|------|---------|
| **Dashboard** | Pipeline health, connection status (Chrome, WebSocket, AI), alert log |
| **Chat** | Text/voice interface to test commands directly without the overlay |
| **Commands** | Full history of every command: transcript, tool called, latency, success/fail |
| **Tools** | Browse all available voice tools organized by category |
| **Context** | Live view of what AbleSpeak currently sees in the browser (viewport elements, URL) |
| **Logs** | Real-time server log stream (INFO/WARN/ERROR filter tabs, auto-scroll, pause) |
| **Prompt** | View and switch between different AI system prompt configurations |
| **Settings** | Switch AI provider/model, view API configuration |

---

## Voice Command Flow

### Example: "Go back"

1. Student says "go back" near the overlay mic
2. Overlay detects amplitude above `SPEECH_THRESHOLD`, starts recording
3. Student stops talking; 1500ms of silence triggers recording end
4. Overlay sends `voice_audio` WebSocket event with the audio blob to the gateway
5. VoiceHandler sends audio to Gemini → returns `"go back."`
6. Hallucination filter: no SILENCE markers, passes through
7. Fast command router: `cleanTranscription("go back.")` → `"go back"` → matches `go_back` pattern
8. Tool executed: extension service worker receives `{type: "go_back"}` → calls `chrome.tabs.goBack()`
9. Browser navigates back
10. No TTS for silent commands; mic restarts immediately

**Latency: ~200–500ms**

### Example: "Click the submit button"

1. Student says "click the submit button"
2. Same recording → Gemini → `"Click the submit button."`
3. Fast command router: no match (element names are dynamic, not pre-patterned)
4. AI Engine: sends to LLM with tool definitions and current `viewportElements`
5. LLM returns `{tool: "click_element", args: {query: "submit button"}}`
6. Tool registry: fuzzy-matches "submit button" against `viewportElements` text
7. Match found → extension service worker forwards click command to content.js
8. content.js clicks the element
9. TTS: "Clicked submit" (mic pauses, resumes after 2500ms)

**Latency: ~3–8 seconds**

---

## Features

| Feature | Description |
|---------|-------------|
| **Voice Overlay** | Transparent always-on-top window — the student's only interface |
| **Voice Activity Detection** | Amplitude-based start/stop; never requires button press |
| **Echo Protection** | Mic pauses during TTS + 2500ms cooldown |
| **Fast Commands** | ~40 common commands execute at ~200ms without LLM |
| **AI Agent** | Multi-provider LLM (Gemini, OpenAI, Anthropic, Groq) with tool calling |
| **Browser Control** | Open tabs, navigate, click, scroll, fill forms, go back/forward |
| **System Control** | Launch apps, type text, press keys, manage windows |
| **Dictation Mode** | Say "dictate" — everything spoken is typed at the cursor |
| **Hallucination Filter** | Drops SILENCE-wrapped phantom Gemini transcripts |
| **AudioContext Reuse** | Single persistent context prevents Chrome's context-creation rate limit |
| **Alarms Heartbeat** | `chrome.alarms` keeps the extension bridge alive despite MV3 suspension |
| **Live Dashboard** | Real-time health, command history, latency metrics |
| **Log Viewer** | Server log stream with INFO/WARN/ERROR filtering |
| **Multi-LLM** | Switch provider/model at runtime from the Settings page |
| **Safety Layer** | `safety.js` guards against harmful command sequences |

---

## Prerequisites & Installation

### Requirements

- **Node.js 18+** — [nodejs.org](https://nodejs.org/)
- **Google Chrome** — for the browser extension
- **LLM API Key** — at least one of:
  - [Google Gemini](https://aistudio.google.com/apikey) (recommended — also used for STT)
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/)
  - [Groq](https://console.groq.com/)

### Install

```bash
git clone https://github.com/LubangaD/ablespeakdesktop.git
cd ablespeakdesktop
```

**Install server dependencies:**
```bash
cd server
npm install
```

**Configure API key:**
```bash
cp .env.example .env
```

Edit `server/.env`:
```env
LLM_PROVIDER=gemini
LLM_MODEL=gemini-2.0-flash
GEMINI_API_KEY=your-key-here
GATEWAY_PORT=3001
DB_PATH=./data/ablespeak.db
NODE_ENV=development
```

**Build the dashboard:**
```bash
cd ../dashboard
npm install
npx vite build
cd ../server
```

---

## Running the App

### Electron Desktop App (Recommended)

```bash
cd server
npm run desktop
```

This launches:
- The gateway server on `http://localhost:3001`
- The dashboard in an Electron window
- The transparent overlay (press **Ctrl+Shift+O** or click the tray icon to show/hide)
- System tray icon with quick controls

> **Important:** Always launch via `npm run desktop`, not by calling `electron` directly. The `ELECTRON_RUN_AS_NODE` environment variable (set in some terminals) causes Electron to behave like plain Node, breaking the `app` object. The npm script handles this correctly.

### Development Mode (Browser)

**Terminal 1:**
```bash
cd server
npm start
```

**Terminal 2:**
```bash
cd dashboard
npx vite
```

Open `http://localhost:5173` in Chrome.

### Docker

```bash
docker compose up -d
# Open http://localhost:3001
```

---

## Loading the Chrome Extension

The extension at `chrome-integration-master/` is required for all browser control commands.

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `chrome-integration-master/` folder
5. The extension connects automatically to `ws://localhost:3001/ws/extension`

**Connection status indicator:**
- Green badge — connected to AbleSpeak gateway
- Yellow badge — connecting/reconnecting
- Red badge — disconnected (gateway not running)

The extension maintains this connection via a `chrome.alarms` heartbeat that fires every 60 seconds to check and reopen the WebSocket if it has been dropped by the browser's MV3 service worker suspension.

---

## Configuration

### Environment Variables (`server/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `gemini` | AI provider: `gemini`, `openai`, `anthropic`, `groq` |
| `LLM_MODEL` | `gemini-2.0-flash` | Model name for the selected provider |
| `LLM_TEMPERATURE` | `0.7` | Response creativity (0 = deterministic) |
| `GEMINI_API_KEY` | — | Google Gemini API key (also used for STT) |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `GROQ_API_KEY` | — | Groq API key |
| `GATEWAY_PORT` | `3001` | Gateway server port |
| `VOQAL_HOME` | `~/.voqal` | Voqal configuration directory |
| `DB_PATH` | `./data/ablespeak.db` | SQLite database path |
| `NODE_ENV` | `development` | Environment mode |

---

## Project Structure

```
ablespeakdesktop/
│
├── server/                              # Electron shell + Express gateway
│   ├── electron-main.cjs               # Electron main process
│   │                                   #  • Creates dashboard + overlay windows
│   │                                   #  • System tray, global shortcuts
│   │                                   #  • EADDRINUSE guard (duplicate instance)
│   │                                   #  • IPC handlers (mic, TTS, overlay toggle)
│   ├── overlay.html                    # Transparent overlay — student's primary UI
│   │                                   #  • Voice Activity Detection (amplitude)
│   │                                   #  • MediaRecorder + AudioContext (reused)
│   │                                   #  • Echo protection (TTS cooldown)
│   │                                   #  • Watchdog recovery timer
│   ├── overlay-preload.cjs             # Overlay preload: exposes IPC to renderer
│   ├── overlay-wake.cjs                # Wake-word preload (experimental)
│   ├── wake-preload.cjs                # Wake-word main preload
│   ├── package.json                    # npm scripts: start, desktop, build:win
│   ├── data/                           # SQLite database (command history)
│   └── src/
│       ├── index.js                    # Express server entry point
│       ├── ai-engine.js                # Multi-provider LLM integration
│       │                               #  • Tool call parsing + retry
│       │                               #  • Provider switching at runtime
│       ├── fast-commands.js            # ~40 pre-LLM command patterns
│       │                               #  • ~200ms execution path
│       │                               #  • Silent vs. confirmed commands
│       ├── voice-handler.js            # Gemini STT + hallucination filter
│       │                               #  • SILENCE-marker phantom transcript filter
│       ├── ws-proxy.js                 # WebSocket hub
│       │                               #  • /ws/dashboard (overlay + dashboard)
│       │                               #  • /ws/extension (Chrome bridge)
│       │                               #  • Dictation mode
│       │                               #  • Safety checks
│       ├── tool-registry.js            # Browser tool definitions + Chrome dispatch
│       ├── system-tools.js             # OS tools: type, press keys, launch apps
│       ├── system-info.js              # Running apps, active window info
│       ├── safety.js                   # Command safety filtering
│       ├── db.js                       # SQLite (sql.js) — command history
│       ├── log-tailer.js               # Server log watcher for dashboard
│       ├── library-scanner.js          # Tool/prompt library scanner
│       ├── edge-tts.cjs                # Edge TTS integration (alternative TTS)
│       ├── tools/                      # Extended tool definitions
│       └── routes/
│           └── api.js                  # REST API endpoints
│
├── dashboard/                          # Developer dashboard (React + Vite)
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx                     # Root component + routing
│       ├── index.css                   # Global styles (dark theme)
│       ├── pages/
│       │   ├── Dashboard.jsx           # Pipeline health + alert log
│       │   ├── Chat.jsx                # Voice/text chat for testing
│       │   │                           #  • AudioContext reuse (Fix #7)
│       │   ├── Commands.jsx            # Full command history
│       │   ├── Tools.jsx               # Tool browser by category
│       │   ├── Context.jsx             # Live browser context viewer
│       │   ├── Logs.jsx                # Real-time log stream
│       │   │                           #  • INFO/WARN/ERROR filter tabs
│       │   │                           #  • Auto-scroll with pause toggle
│       │   │                           #  • Last 200 entries via WebSocket
│       │   ├── Prompt.jsx              # AI prompt editor + switcher
│       │   ├── Settings.jsx            # Provider/model configuration
│       │   └── Teacher.jsx             # (Upcoming teacher interface)
│       ├── hooks/
│       │   └── useWebSocket.js         # WS connection hook
│       └── lib/
│           └── api.js                  # REST API client
│
├── chrome-integration-master/          # Chrome MV3 browser bridge
│   ├── manifest.json                   # MV3 manifest — alarms permission
│   ├── service-worker.js               # Persistent WS + alarms heartbeat
│   │                                   #  • chrome.alarms every 60s
│   │                                   #  • Reconnects if suspended
│   │                                   #  • Pushes browser context (1s)
│   ├── sandbox.html                    # Sandboxed JS execution environment
│   ├── scripts/
│   │   └── content.js                  # DOM actions + context scraping
│   └── images/                         # Extension status icons
│
├── docs/                               # Documentation assets
├── partners/                           # Partner logos
├── docker-compose.yml                  # Docker orchestration
├── Dockerfile                          # Multi-stage Docker build
├── .env.example                        # Example environment config
└── README.md                           # This file
```

---

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Pipeline health status and alerts |
| GET | `/api/status` | Connection status (Chrome extension, WebSocket) |
| GET | `/api/commands` | Command history |
| GET | `/api/commands/stats` | Command analytics and average latency |
| GET | `/api/library` | Available tools and prompts |
| GET | `/api/library/:cat/:tool` | Single tool detail |
| GET | `/api/context` | Latest browser context snapshot (URL, viewport elements) |
| GET | `/api/logs` | Recent log events |
| GET | `/api/logs/health` | Health alert log |
| GET | `/api/config` | Sanitized server configuration |
| GET | `/api/system` | Computer info and visible applications |
| GET | `/api/ai/status` | Current LLM provider and model |
| GET | `/api/ai/providers` | Available AI providers |
| POST | `/api/ai/switch` | Switch AI provider or model at runtime |
| POST | `/api/ai/chat` | Send a chat message (REST fallback) |
| POST | `/api/ai/clear` | Clear conversation history |

### WebSocket Events

**Client → Server (voice):**
```json
{ "type": "voice_audio", "audio": "<base64 webm>" }
{ "type": "chat_message", "message": "scroll down" }
```

**Server → Client (overlay):**
```json
{ "type": "voice_transcript", "text": "scroll down" }
{ "type": "voice_tts", "message": "Scrolling down", "duration": 1200 }
{ "type": "voice_no_speech" }
{ "type": "voice_error", "error": "..." }
```

**Server → Chrome extension:**
```json
{ "type": "click_element", "query": "submit button" }
{ "type": "scroll", "direction": "down", "amount": 300 }
{ "type": "open_url", "url": "https://youtube.com" }
{ "type": "go_back" }
{ "type": "type_text", "text": "hello world" }
```

**Extension → Server (context):**
```json
{
  "type": "browser_context",
  "url": "https://example.com/page",
  "title": "Page Title",
  "viewportElements": [
    { "text": "Submit", "type": "button", "rect": {...} },
    { "text": "Search", "type": "input", "rect": {...} }
  ]
}
```

---

## Accessibility

AbleSpeak is built for users who **cannot type**. Every design decision serves this constraint.

- **Zero required input** — the student never needs to touch a keyboard, mouse, or trackpad
- **56px minimum touch targets** — all dashboard controls are large enough for switch access
- **WCAG AAA contrast** — 7:1+ contrast ratio for all text
- **Voice-navigable** — every interactive element has a unique, speakable `aria-label`
- **Screen reader compatible** — proper ARIA landmarks and `aria-live` regions
- **Reduced motion support** — respects `prefers-reduced-motion`
- **Keyboard and switch device support** — full Tab/Enter navigation on all controls
- **Skip navigation link** — jump straight to main content

---

## Development Guide

### Launching for development

```bash
# Kill any stray Electron instances holding port 3001
# (PowerShell): Get-Process -Name "AbleSpeak" | Stop-Process -Force

cd server
npm run desktop
```

### Rebuilding the Windows installer

```bash
cd server
npm run build:win
# Output: dist-electron/AbleSpeak Setup 1.0.0.exe
```

### Making changes to the overlay

1. Edit `server/overlay.html`
2. In the running Electron app, go to **View → Reload** (or Ctrl+R) in the overlay DevTools
3. The overlay is a renderer window — Electron hot-reloads it without restarting the server

### Making changes to the dashboard

1. Run `cd dashboard && npx vite` for a hot-reloading dev server on port 5173
2. The Electron window can be pointed at `http://localhost:5173` instead of the built files for dev

### Common issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `EADDRINUSE :3001` | Previous Electron instance still running in tray | PowerShell: `Stop-Process -Name "AbleSpeak" -Force` |
| Overlay stops after ~3 commands | AudioContext exhaustion (old code) | Fixed in current version: single context is reused |
| Extension shows stale page | MV3 service worker suspended | Fixed: chrome.alarms heartbeat reconnects every 60s |
| Dictation exits on "stop" mid-sentence | Interrupt regex matched before dictation check | Fixed: `!this._dictationMode` guard in ws-proxy.js |
| `require('electron')` returns a path string | `ELECTRON_RUN_AS_NODE=1` in environment | Launch via `npm run desktop`, not bare `electron` |

---

## License

MIT — Built for accessibility. Built with love in Nairobi, Kenya.
