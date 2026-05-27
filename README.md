# AbleSpeak — Accessible Voice Command Center

> A fully accessible voice-native command center for users with motor disabilities, built on top of the [Voqal](https://voqal.dev) desktop agent.

## What is AbleSpeak?

AbleSpeak wraps the existing Voqal desktop agent and Chrome Integration extension into a unified, observable command center. It provides:

- **Real-time voice pipeline monitoring** — see if your Microphone, STT, LLM, TTS, and Extension are healthy
- **Command history** — browse and filter all voice commands processed
- **Tool browser** — explore all available voice commands by category
- **Context explorer** — see the live context Voqal uses to understand your computer
- **Log viewer** — real-time engine log stream with health alerts
- **Configuration display** — view your Voqal pipeline settings

### Accessibility Features

AbleSpeak is designed for users who **cannot type**. Every design decision follows this principle:

- ✅ **56px minimum touch targets** — all buttons and controls are large
- ✅ **Zero text inputs** — all filters are button-based
- ✅ **WCAG AAA contrast** — 7:1+ ratio for all text
- ✅ **Voice-navigable** — every element has a unique, speakable `aria-label`
- ✅ **Keyboard/switch device support** — full Tab/Enter navigation
- ✅ **Screen reader compatible** — proper ARIA landmarks and live regions
- ✅ **Reduced motion** — respects `prefers-reduced-motion`

## Architecture

```
[Voqal Desktop Agent] ←→ [AbleSpeak Gateway :3001] ←→ [Chrome Extension]
                                    ↓
                           [SQLite Database]
                           [Dashboard SPA]
```

The Gateway acts as a transparent WebSocket proxy between Voqal and the Chrome Extension, intercepting and logging all commands for observability.

## Quick Start

### Prerequisites

- [Voqal v2.2.0+](https://voqal.dev) running on your machine
- Node.js 18+
- Chrome browser with the integration extension loaded

### Development

```bash
# 1. Start the gateway
cd server
npm install
npm start

# 2. Start the dashboard (in a new terminal)
cd dashboard
npm install
npx vite

# 3. Open http://localhost:5173 in Chrome
```

### Production (Docker)

```bash
docker compose up -d
# Open http://localhost:3001
```

## Project Structure

```
├── server/                    # API Gateway (Node.js/Express)
│   └── src/
│       ├── index.js           # Entry point
│       ├── ws-proxy.js        # WebSocket relay
│       ├── db.js              # SQLite (sql.js)
│       ├── log-tailer.js      # voqal.log watcher
│       ├── library-scanner.js # Tool/context scanner
│       └── routes/api.js      # REST API
│
├── dashboard/                 # Web Dashboard (Vite + React)
│   └── src/
│       ├── pages/             # 6 accessible pages
│       ├── hooks/             # WebSocket + API hooks
│       └── lib/               # API client
│
├── service-worker.js          # Chrome Extension (enhanced)
├── manifest.json              # Extension manifest
├── Dockerfile                 # Multi-stage build
└── docker-compose.yml         # Container orchestration
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Pipeline health + alerts |
| GET | `/api/status` | Connection status |
| GET | `/api/commands` | Command history |
| GET | `/api/commands/stats` | Command analytics |
| GET | `/api/library` | Tool/context library |
| GET | `/api/library/:cat/:tool` | Single tool detail |
| GET | `/api/context` | Latest context snapshot |
| GET | `/api/logs` | Log events |
| GET | `/api/logs/health` | Health alerts |
| GET | `/api/config` | Sanitized Voqal config |

## Chrome Extension

The extension is enhanced to connect through the AbleSpeak gateway by default (`ws://localhost:3001/ws/extension`), falling back to direct Voqal (`ws://localhost:22171`) if the gateway isn't running.

To reload the extension after changes:
1. Go to `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" and select this directory
4. Click the extension icon to enable/disable

## License

Built for accessibility. Built with love.
