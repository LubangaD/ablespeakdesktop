# AbleSpeak Desktop — Accessible Voice Command Center

> A fully accessible, voice-native desktop command center for users with motor disabilities. AbleSpeak gives you hands-free control of your computer through natural voice commands, powered by AI.

![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## Table of Contents

- [What is AbleSpeak?](#what-is-ablespeak)
- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running the Desktop App](#running-the-desktop-app)
- [Loading the Chrome Extension](#loading-the-chrome-extension)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Accessibility](#accessibility)
- [License](#license)

---

## What is AbleSpeak?

AbleSpeak is a standalone desktop application that acts as an **AI-powered voice command center**. It combines:

- An **Electron desktop app** with a full dashboard UI
- A **backend gateway server** with AI agent capabilities (supports Gemini, OpenAI, Anthropic, Groq)
- A **Chrome browser extension** that lets AbleSpeak control your browser tabs, navigate pages, click elements, and fill forms — all by voice

AbleSpeak is built for people who **cannot type**. Every button, every interaction, every design decision puts accessibility first.

---

## Features

| Feature | Description |
|---------|-------------|
| 🎙️ **Voice Chat** | Speak naturally to your computer — AbleSpeak understands and executes commands |
| 🧠 **AI Agent** | Multi-provider LLM support (Gemini, OpenAI, Anthropic, Groq) with tool execution |
| 🌐 **Browser Control** | Open tabs, navigate URLs, click elements, fill forms, scroll — all hands-free |
| 💻 **System Control** | Launch apps, type text, press keys, manage windows via voice |
| 📊 **Live Dashboard** | Real-time pipeline health, command history, latency metrics, and system info |
| 🔧 **Tool Browser** | Explore all available voice commands organized by category |
| 📋 **Prompt Editor** | View and switch between different AI prompt configurations |
| 📜 **Log Viewer** | Real-time server log stream with health alerts |
| ⚙️ **Settings** | Configure AI providers, models, and connection settings from the UI |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              AbleSpeak Desktop (Electron)        │
│  ┌───────────────────────────────────────────┐  │
│  │         Dashboard UI (React + Vite)        │  │
│  │  Dashboard · Chat · Tools · Logs · etc.    │  │
│  └──────────────────┬────────────────────────┘  │
│                     │ WebSocket                  │
│  ┌──────────────────▼────────────────────────┐  │
│  │        Gateway Server (Express :3001)      │  │
│  │  AI Engine · Tool Registry · WS Hub        │  │
│  │  SQLite DB · Log Tailer · System Tools     │  │
│  └──────────────────┬────────────────────────┘  │
└─────────────────────┼───────────────────────────┘
                      │ WebSocket
        ┌─────────────▼──────────────┐
        │  Chrome Extension          │
        │  (chrome-integration-master)│
        │  Browser control & context │
        └────────────────────────────┘
```

---

## Prerequisites

- **Node.js 18+** — [Download](https://nodejs.org/)
- **Google Chrome** — for the browser extension
- **An LLM API Key** — at least one of:
  - [Google Gemini](https://aistudio.google.com/apikey) (recommended)
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/)
  - [Groq](https://console.groq.com/)

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/LubangaD/ablespeakdesktop.git
cd ablespeakdesktop
```

### 2. Install server dependencies

```bash
cd server
npm install
```

### 3. Configure your API key

Copy the example environment file and add your API key:

```bash
cp .env.example .env
```

Edit `server/.env` and set at least one API key:

```env
# Choose your LLM provider
LLM_PROVIDER=gemini
LLM_MODEL=gemini-2.0-flash

# Set your API key
GEMINI_API_KEY=your-api-key-here

# Server settings
GATEWAY_PORT=3001
VOQAL_HOME=C:\Users\YourUsername\.voqal
DB_PATH=./data/ablespeak.db
NODE_ENV=development
```

### 4. Build the dashboard

```bash
cd ../dashboard
npm install
npx vite build
```

### 5. Go back to server directory

```bash
cd ../server
```

---

## Running the Desktop App

### Option A: Desktop App (Electron) — Recommended

From the `server/` directory:

```bash
npm run desktop
```

This launches AbleSpeak as a native desktop window with:
- The gateway server running on `http://localhost:3001`
- The dashboard loaded in an Electron window
- System tray icon for quick access
- Microphone permissions auto-granted

### Option B: Development Mode (Browser)

Run the server and dashboard separately for development:

**Terminal 1 — Start the gateway server:**
```bash
cd server
npm start
```

**Terminal 2 — Start the dashboard dev server:**
```bash
cd dashboard
npx vite
```

Then open `http://localhost:5173` in Chrome.

### Option C: Docker

```bash
docker compose up -d
# Open http://localhost:3001
```

---

## Loading the Chrome Extension

The **`chrome-integration-master/`** folder contains a Chrome extension that enables AbleSpeak to control your browser (navigate pages, click elements, fill forms, read page content, etc.).

### How to install it:

1. Open **Google Chrome**
2. Go to `chrome://extensions` in the address bar
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **"Load unpacked"**
5. Select the **`chrome-integration-master/`** folder from this repository
6. The extension icon will appear in your toolbar

### How it works:

- Once loaded, the extension automatically connects to the AbleSpeak gateway at `ws://localhost:3001/ws/extension`
- The extension icon shows the connection status:
  - 🟢 **Green** — Connected to AbleSpeak
  - 🟡 **Yellow** — Connecting...
  - 🔴 **Red** — Disconnected
- Click the extension icon to enable/disable it
- The dashboard will show **"Chrome: Available"** under Integrations when connected

### What it enables:

| Voice Command Example | What it does |
|----------------------|--------------|
| "Open YouTube" | Opens youtube.com in a new tab |
| "Go to my email" | Navigates to Gmail |
| "Click the search button" | Clicks the specified element |
| "Scroll down" | Scrolls the active page |
| "Fill in my name as John" | Types into form fields |
| "Read this page" | Extracts and reads page content |
| "Switch to the second tab" | Switches between browser tabs |

---

## Configuration

### Environment Variables (`server/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `gemini` | AI provider: `gemini`, `openai`, `anthropic`, `groq` |
| `LLM_MODEL` | `gemini-2.0-flash` | Model to use for the selected provider |
| `LLM_TEMPERATURE` | `0.7` | Response creativity (0.0 = deterministic, 1.0 = creative) |
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `GROQ_API_KEY` | — | Groq API key |
| `GATEWAY_PORT` | `3001` | Port for the gateway server |
| `VOQAL_HOME` | `~/.voqal` | Path to Voqal configuration directory |
| `DB_PATH` | `./data/ablespeak.db` | Path to the SQLite database |
| `NODE_ENV` | `development` | Environment mode |

---

## Project Structure

```
ablespeakdesktop/
├── server/                          # Backend + Electron shell
│   ├── electron-main.cjs            # Electron main process
│   ├── package.json                 # Server dependencies & scripts
│   ├── .env                         # API keys & config (git-ignored)
│   ├── data/                        # SQLite database storage
│   └── src/
│       ├── index.js                 # Express server entry point
│       ├── ai-engine.js             # Multi-provider LLM integration
│       ├── tool-registry.js         # Voice command tool definitions
│       ├── system-tools.js          # OS-level tools (launch apps, type, etc.)
│       ├── system-info.js           # Computer info & running apps
│       ├── ws-proxy.js              # WebSocket hub (dashboard + extension)
│       ├── db.js                    # SQLite database (sql.js)
│       ├── voice-handler.js         # Voice input processing
│       ├── log-tailer.js            # Voqal log file watcher
│       ├── library-scanner.js       # Tool/prompt library scanner
│       └── routes/
│           └── api.js               # REST API endpoints
│
├── dashboard/                       # Frontend UI (React + Vite)
│   ├── index.html                   # HTML entry point
│   ├── package.json                 # Dashboard dependencies
│   ├── vite.config.js               # Vite configuration
│   ├── tsconfig.json                # TypeScript config
│   └── src/
│       ├── main.jsx                 # React entry point
│       ├── App.jsx                  # Root component with routing
│       ├── index.css                # Global styles
│       ├── pages/
│       │   ├── Dashboard.jsx        # Main dashboard with metrics
│       │   ├── Chat.jsx             # Voice chat interface
│       │   ├── Prompt.jsx           # Prompt editor & switcher
│       │   ├── Tools.jsx            # Tool browser by category
│       │   ├── Commands.jsx         # Command history viewer
│       │   ├── Context.jsx          # Live context explorer
│       │   ├── Logs.jsx             # Real-time log viewer
│       │   └── Settings.jsx         # Configuration UI
│       ├── hooks/
│       │   └── useWebSocket.js      # WebSocket connection hook
│       └── lib/
│           └── api.js               # REST API client
│
├── chrome-integration-master/       # Chrome Extension (load into browser)
│   ├── manifest.json                # Extension manifest (Manifest V3)
│   ├── service-worker.js            # Background script with WS connection
│   ├── sandbox.html                 # Sandboxed execution environment
│   ├── scripts/
│   │   └── content.js               # Content script for page interaction
│   ├── icons/                       # Extension status icons
│   └── images/                      # Extension icons (16/32/48/128px)
│
├── partners/                        # Partner logos and assets
├── docker-compose.yml               # Docker orchestration
├── Dockerfile                       # Multi-stage Docker build
├── .env.example                     # Example environment config
├── .gitignore                       # Git ignore rules
└── README.md                        # This file
```

---

## API Reference

The gateway server exposes these REST endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Pipeline health status & alerts |
| GET | `/api/status` | Connection status (extension, WebSocket) |
| GET | `/api/commands` | Command history |
| GET | `/api/commands/stats` | Command analytics & latency |
| GET | `/api/library` | Tool & prompt library |
| GET | `/api/library/:cat/:tool` | Single tool detail |
| GET | `/api/context` | Latest browser context snapshot |
| GET | `/api/logs` | Log events |
| GET | `/api/logs/health` | Health alert log |
| GET | `/api/config` | Sanitized server configuration |
| GET | `/api/system` | Computer info & visible applications |
| GET | `/api/ai/status` | Current LLM provider & model |
| GET | `/api/ai/providers` | Available AI providers |
| POST | `/api/ai/switch` | Switch AI provider/model |
| POST | `/api/ai/chat` | Send a chat message (REST fallback) |
| POST | `/api/ai/clear` | Clear conversation history |

### WebSocket Endpoints

| Endpoint | Description |
|----------|-------------|
| `ws://localhost:3001/ws/dashboard` | Dashboard real-time updates |
| `ws://localhost:3001/ws/extension` | Chrome extension communication |

---

## Accessibility

AbleSpeak is designed for users who **cannot type**. Every design decision follows this principle:

- ✅ **56px minimum touch targets** — all buttons and controls are large enough for switch access
- ✅ **Zero text inputs required** — all filters and controls are button-based
- ✅ **WCAG AAA contrast** — 7:1+ contrast ratio for all text
- ✅ **Voice-navigable** — every interactive element has a unique, speakable `aria-label`
- ✅ **Keyboard & switch device support** — full Tab/Enter navigation
- ✅ **Screen reader compatible** — proper ARIA landmarks and live regions
- ✅ **Reduced motion support** — respects `prefers-reduced-motion` media query
- ✅ **Skip navigation link** — jump straight to main content

---

## License

MIT — Built for accessibility. Built with ❤️.
