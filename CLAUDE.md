# AbleSpeak — Tier 2

**AbleSpeak understands what is happening on your computer
and helps you control it through natural speech.**

---

## What this is

AbleSpeak Tier 2 is a Windows desktop application built for
people with motor and speech impairments — students with
cerebral palsy, muscular dystrophy, spinal cord injuries, and
limb differences — who cannot use a keyboard or mouse but can
speak.

It is not a bigger voice command list. It is a different kind
of system: one that inspects the screen semantically, plans
multi-step actions, verifies what happened, and recovers when
it is wrong — without the user ever needing to touch the mouse.

The bar is that operating a computer by voice feels as capable
as using hands.

---

## What makes it different from Tier 1

Tier 1 (shipped) is a Chrome extension. It controls the browser
tab by querying the DOM — deterministic, fast, and limited to
the web.

Outside the browser, there is no DOM. General voice tools fall
back to taking a screenshot, sending it to a vision model, and
guessing a click coordinate. That path costs a model call per
attempt and runs 2–8 seconds. More importantly, it guesses.

Tier 2 inverts this. The primary path is the **Windows UI
Automation tree** — control types, names, automation IDs, and
supported interaction patterns (`Invoke`, `Value`, `Scroll`,
`ExpandCollapse`, `SelectionItem`). Deterministic. Costs nothing
per query. Returns in tens of milliseconds. Vision grounding
exists as a declared fallback for canvas-drawn and inaccessible
UI — not as the default.

| | Tier 1 | Tier 2 |
|---|---|---|
| Scope | Browser tab | Whole Windows OS |
| Screen model | DOM | UI Automation tree |
| Interaction | Command → action | Intent → plan → act → verify → recover |
| Failure | Command misses, user retries | System notices, explains, re-plans |
| Example | "Click the blue button" | "Open my email and find the message from John" |

---

## The user

A student who cannot use a keyboard or mouse. Can speak —
often with atypical prosody, reduced volume, or non-standard
articulation. When something goes wrong, they cannot reach for
the mouse to fix it.

The product is designed backwards from that worst moment.

The secondary user is the teacher or interventionist who needs
to know whether the student is gaining independence, and needs
dated evidence for IEP and progress reviews. The teacher
dashboard is the student's evidence trail.

---

## What is built

Checked against the code on 2026-09-24.

| Component | Status |
|---|---|
| Electron app + transparent overlay | Built |
| Gateway server (Express, :3001) | Built |
| Chrome bridge extension | Built |
| ASR (Gemini only) + hallucination filtering | Built — no Whisper / fine-tuned model wired in |
| Fast-command router (~40 patterns, 200–500ms) | Built |
| Multi-provider LLM tool-calling (Gemini / OpenAI / Anthropic) | Built |
| Safety layer | Built + tested |
| Screen model (`screen-model.js`, persistent C# UIA worker) | Built — separate native sidecar ruled out, see `docs/measurements/` |
| UIA pattern execution (`uia_act`) | Partial — failed actions, x/y clicks and scrolling still use the mouse |
| UIA resolution-rate log (`resolution_log`) | Built, no real data yet |
| Task agent (plan → act → check → re-plan, max 2 re-plans) | Partial — no whole-task end-state; undo covers typing only |
| Click-grounding A/B harness (Gemini vs MolmoWeb) | Built, never run |
| Agent eval harness (`tools/agent-eval`) | Built, never run |
| Progress-monitoring (KPI) engine — 45 tests, ~13 API routes, 4 tables | Built + committed, no real data yet |
| Teacher dashboard (goals, aim line, trend, decision flags) | Built |
| Student / teacher / admin split — simplified overlay; Developer Hub + Settings behind an admin PIN checked server-side (`admin-pin.js`), not reachable by voice | Built (2026-09-24) |
| Per-student speech settings (vocabulary bias, silence-filter presets) | Built |
| Portable profiles (JSON export/import) | Built |
| Learned aliases from corrections · routines (macros) | Built |

**Not yet built:** auth/roles (beyond the one admin PIN) · roster integration · CSV/PDF
export · cross-device sync (only a dangling stub in
`probe-computer.js`) · offline degradation (every clip needs
Gemini) · local ASR · push-to-talk / stale-clip dropping ·
per-student ASR model adaptation · vision grounding as a
runtime fallback (exists only in the eval harness).

**Measurements still owed:** click-grounding hit rate ·
agent eval results · ASR A/B command match rate (no
recordings collected yet). The UIA latency is measured
(`docs/measurements/uia-latency-2026-09-17.md`).

**Metrics not yet computed as defined:** command match rate,
first-time actions, recovery rate (see Key metrics).

---

## The build arc

### Stage 0 — Foundation (September 2026)
Solid technical base. KPI engine live. Two key numbers
written down: UIA tree-dump latency and grounding hit rate.
These two numbers decide the Stage 2 architecture before
Stage 2 is planned around them.
*Status: KPI engine committed; UIA latency measured; grounding
hit rate still owed.*

### Stage 1 — Intelligent Voice Control (October–November 2026)
The student is heard reliably — including on a bad day in a
noisy classroom. An ASR A/B study comparing fine-tuned vs
base model, measured by command match rate (not WER). Per-
student vocabulary biasing. Tunable silence filter per student
so no atypical speaker is silently discarded at default settings.

### Stage 2 — Accessibility Layer (November 2026 onwards)
AbleSpeak knows what is on screen without looking at pixels.
A persistent UIA sidecar. A screen model: focused window →
element tree → actionable elements with supported patterns.
Pattern-based execution replacing synthetic mouse movement.
A coverage matrix across the real apps students use at school.

### Stage 3 — AI Interaction Agent (2027)
Multi-step natural language instructions work. A planner
decomposes intent into a step sequence. After each step,
the system diffs the UI tree against the expected end-state
and re-plans on mismatch rather than retrying blindly.
Recovery is bounded, spoken aloud, and safe.

### Stage 4 — Personalisation (2027)
AbleSpeak fits this student and follows them to another
machine. Portable profiles. Learned aliases from corrections.
Workflow macros. Per-student ASR adaptation.
*Status: profiles (file export/import), learned aliases and
routines are built early; sync and ASR model adaptation remain.*

### Stage 5 — Validation and Deployment (continuous)
Measured evidence from independent pilots in real schools.
Independent task completion, first-time actions, and a
quality-of-life instrument chosen with research partners —
not invented here.

---

## Key metrics

| Metric | What it measures |
|---|---|
| Command match rate | Share of spoken commands that run the right action. The honest metric — WER is not. |
| UIA resolution rate | Share of targets resolved semantically vs pixel fallback. The Tier 2 signature. |
| Independent task completion | Tasks a student completes without adult intervention. |
| First-time actions | Things a student did independently for the first time. |
| Recovery rate | Failed actions recovered without adult help. |

---

## Architecture

```
Student speaks
      │
      ▼
[Overlay]  VAD · MediaRecorder · echo protection
      │
      ▼
[Gateway :3001]
      │
      ├─► [ASR]  Gemini today; fine-tuned Whisper planned
      │          + per-student vocabulary bias            ← Stage 1
      │
      ├─► [Fast router]  ~40 patterns, ~200ms, no LLM
      │
      └─► [Agent]                                          ← Stage 3
            │
            ├── reads ────► [Screen Model]                 ← Stage 2
            │                 UIA tree · patterns
            │                 vision grounding as fallback
            │
            ├── plans ────► step sequence + expected end-state
            │
            ├── acts ─────► UIA pattern / Chrome bridge / OS
            │
            ├── verifies ─► tree diff vs expectation
            │
            └── recovers ─► re-plan · undo · spoken explanation
      │
      ▼
[TTS]  spoken confirmation
      │
      ▼
[KPI engine]  probes · aim line · Theil–Sen trend · decision flags
```