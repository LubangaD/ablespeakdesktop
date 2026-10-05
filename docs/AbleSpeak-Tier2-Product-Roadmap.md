# AbleSpeak — Tier 2 Product Roadmap

**From voice commands to an AI accessibility layer that understands the screen.**

*Version: 3 September 2026 · Engineering build plan · Tunga Innovation Ltd*

---

## How to read this document

Two horizons, deliberately kept apart:

- **Stage 0 is the next 30 days**, sized for one builder. It is a dated, checkable work plan.
- **Stages 1–5 are the product arc**, roughly twelve months, and they are *direction plus acceptance criteria*, not a staffed schedule. At current capacity (team of 3, one person on this build) the arc needs either a longer calendar or more hands. That tension is stated in [Team & skills required](#team--skills-required) rather than hidden in optimistic dates.

Everything marked **NEEDS INPUT** is blocked on the Laurie/Microsoft and inABLE conversations, which are **not present in this workspace** — see [Partnership inputs](#partnership-inputs--needs-input).

Evidence discipline follows the house standard (submission standard S6, adopted 30 Aug 2026): every number carries its date and sample size, and the stage is stated honestly. No figure in this document is aspirational unless labelled *target*.

---

## Product vision

> **AbleSpeak understands what is happening on your computer and helps you control it through natural speech.**

The user is a student who cannot use a keyboard or mouse but can speak. The bar is not "voice shortcuts" — it is that the gap between intent and outcome effectively disappears, so that operating a computer by voice feels as capable as using hands.

Tier 2 is the point where that stops being a bigger command list and becomes a different kind of system: one that **inspects the screen semantically**, **plans multi-step actions**, **verifies what happened**, and **recovers when it is wrong**.

---

## The Tier 1 → Tier 2 shift

| | Tier 1 (shipped) | Tier 2 (this roadmap) |
|---|---|---|
| Promise | "Helps you speak and interact with digital services." | "Understands what is happening on your computer and helps you control it." |
| Scope | Browser tab | Whole OS |
| Target resolution | DOM selectors | UI Automation tree, vision as fallback |
| Interaction | Command → action | Intent → plan → act → verify → recover |
| Failure mode | Command misses, user retries | System notices, explains, and re-plans |
| Example | "Click the blue button." | "Open my email and find the message from John." |

### The technical crux

Tier 1 resolves what to click by querying the DOM. That works in a browser tab and nowhere else. On a native Windows application there is no DOM, so the current fallback is: **screenshot → Gemini → "give me a click point"**. That path is probabilistic, costs a model call per attempt, and runs 2–8 seconds.

Tier 2 inverts the default. The primary path becomes the **Windows UI Automation tree** — control types, names, automation IDs, control patterns (`Invoke`, `Value`, `Scroll`, `ExpandCollapse`, `SelectionItem`) and bounding rectangles. It is deterministic, costs nothing per query, and returns in tens of milliseconds. Vision grounding is demoted to the fallback for canvas-drawn and inaccessible UI.

**That inversion is the single most important architectural decision in Tier 2.** Every other stage depends on it: personalisation needs stable element identity, the agent needs a state it can verify against, and error recovery needs to know whether the screen actually changed.

Critically, this is **not greenfield**. `server/src/system-tools.js:822` already does `Add-Type -AssemblyName UIAutomationClient` and, at line 978, "tries the accessibility Invoke action first (reliable, no mouse movement)" before falling back to synthetic mouse input. The beachhead exists. Stage 2 promotes it from a hidden fallback into the primary screen model.

---

## Where the build actually is today

Verified by reading the code on 3 Sep 2026, not from prior documentation.

### Tier 1 — shipped

- Chrome extension, 150+ voice commands (click / scroll / type / navigate — not dictation-only)
- Whisper fine-tuned on Kenyan / non-standard English speech
- 9 organic Chrome Web Store installs (as of 17 Aug 2026)
- KISE pilot: ~10 students to date
- Patent granted; codebase MIT

### Tier 2 desktop — in progress (`tier2/ablespeakdesktop`)

| Component | State | Evidence |
|---|---|---|
| Electron app + transparent overlay (student's only surface) | **Built** | `server/overlay.html`, `electron-main.cjs` |
| Gateway server (Express, :3001) | **Built** | `server/src/index.js` |
| Chrome bridge extension | **Built** | `chrome-integration-master/` |
| ASR + hallucination filtering | **Built** | `voice-handler.js:97–192` (SILENCE-marker filter, known-hallucination list) |
| Fast-command router (~40 patterns, no LLM) | **Built** | `fast-commands.js` — 200–500 ms path |
| Multi-provider LLM tool-calling | **Built** | `ai-engine.js` (Gemini / OpenAI / Anthropic) |
| Safety layer | **Built + tested** | `safety.js`, `safety.test.mjs` |
| **UI Automation hooks** | **Partial** | `system-tools.js:822–978` — UIA loaded, Invoke tried before mouse |
| Click-grounding A/B harness | **Built, not yet run on real data** | `server/tools/grounding-eval/` — Gemini vs MolmoWeb, hit rate / distance / latency |
| Progress-monitoring (KPI) engine | **Built, UNCOMMITTED** | `goals` / `progress_points` / `phase_changes` / `decision_flags` tables, `progress-rules.js` (Theil–Sen trend, aim line, decision rules), `probe-computer.js` scheduler, 13 API routes, 45 tests |
| Teacher dashboard | **Partial** | `Teacher.jsx` (851 lines), analytics summary only |

### Not built at all

Auth / roles · cross-device sync · roster integration · CSV/PDF export · per-student speech adaptation · offline degradation · portable profiles.

### Immediate risk

The entire KPI engine — 45 passing tests, four tables, a scheduler and thirteen endpoints — is **sitting in an uncommitted working tree** on top of `0117b03`. It is one `git checkout` from gone. This is Stage 0, day 1.

---

## Target users

**Primary — the student.** Limb difference or motor disability (cerebral palsy, muscular dystrophy, spinal cord injury). Cannot type or use a mouse. Can speak, often with atypical prosody, volume, or articulation. Cannot reach for a mouse to fix a mistake — which is why the product is designed backwards from the worst moment.

**Secondary — the teacher / interventionist.** Needs to know whether the tool is being used, whether the student is gaining independence, and needs dated evidence for IEP and progress reviews.

**Tertiary — the institution.** KISE and comparable special-education institutions in Kenya; procurement is a live tailwind under the Persons with Disabilities Act 2025.

**Adjacent, not yet in scope — blind and low-vision users.** `kb/past_answers.md` positions a voice-driven screen-reader extension as "a need identified with inABLE and Microsoft's accessibility team." Whether this enters as part of Stage 2's semantic layer or as a later Stage 6 is **NEEDS INPUT**.

---

## Core problems to solve

1. **The screen is opaque.** Outside the browser, AbleSpeak guesses at pixels. Everything ambitious is blocked on this.
2. **Speech the model wasn't built for.** General ASR degrades hardest on exactly the population the product exists for, and the noise filters silently discard quiet or atypical speech as "no speech."
3. **One command, one action.** There is no planner, so "find the message from John" cannot decompose into steps.
4. **Failure is a dead end.** When an action goes wrong the student cannot grab the mouse. Verification and recovery are product-critical, not polish.
5. **Nothing follows the student.** Profiles and macros live in one machine's SQLite.
6. **No measured evidence.** Maturity-gated awards and institutional sales both stall until Stage 2 evidence numbers exist.

---

## The six stages

| Stage | Focus | Main outcome | Indicative window |
|---|---|---|---|
| **0. Foundation** | Architecture + accessibility infrastructure | Solid Tier 2 technical base | Sep 2026 (30 days) |
| **1. Intelligent Voice Control** | Robust speech + command understanding | Users can control more of the computer | Oct–Nov 2026 |
| **2. Accessibility Layer** | Windows UI Automation | AbleSpeak understands what is on screen | Nov 2026 – Jan 2027 |
| **3. AI Interaction Agent** | LLM + UI context | Natural-language instructions | Jan–Mar 2027 |
| **4. Personalisation** | Per-user speech, commands, workflows | AbleSpeak adapts to each user | Mar–Apr 2027 |
| **5. Validation & Deployment** | Schools, users, accessibility partners | Evidence that Tier 2 works in the real world | Continuous; gates Nov 2026, Feb 2027, mid-2027 |

Stages 1 and 2 overlap deliberately: the ASR study is data-collection-bound and the UIA work is engineering-bound, so they do not contend for the same hours.

---

### Stage 0 — Foundation · the next 30 days

The only stage sized to actual current capacity. Everything here is verifiable.

**Week 1 — Secure the spine**

- Commit the KPI engine working tree. Nothing else happens first.
- Replace `session_prefix` string-matching with explicit student identity. Today attribution is a guess: a text prefix matched against `session_id`. On a shared machine the data is unattributable, which makes every downstream measure worthless.
- Confirm the probe scheduler runs clean across a restart (`startProbeScheduler`, boot + hourly).

**Week 2 — UIA spike**

- Promote `system-tools.js:822` into a first-class `uia_query` tool returning a structured element list (control type, name, automation ID, supported patterns, bounding rect).
- **Measure the latency of the current approach.** Each `Add-Type` + PowerShell spawn costs hundreds of milliseconds; if a full tree dump lands above ~200 ms the per-call model is dead and Stage 2 needs a persistent sidecar. Decide this with a number, in Week 2, before Stage 2 is planned around it.
- Coverage probe across 5 real target apps.

**Week 3 — Grounding baseline**

- Build a real dataset with `grounding-eval/annotator.html` from actual student screens.
- Run Gemini vs MolmoWeb. This produces the hit-rate number that decides whether serving a GPU grounding model is worth it — a decision currently being made on intuition.

**Week 4 — Recovery + reproducible install**

- Harden the failure path: every action reports heard / working / done / failed truthfully, with an on-screen last-transcript.
- One documented install that an adult can complete once, after which nothing in the daily loop needs a mouse.

**Stage 0 acceptance criteria**

- `npm test` green across `safety`, `progress-rules`, `probe-computer`.
- One student completes a defined 10-task list hands-free, start to finish, without an adult touching the machine.
- A teacher can open that student's goal, aim line, trend and any fired decision flags on the same machine.
- UIA tree-dump latency and grounding hit rate are both **known numbers**, written down.

---

### Stage 1 — Intelligent Voice Control

**Outcome:** the student is heard reliably, including on a bad day in a noisy classroom.

- **The ASR A/B study.** Already scoped as the next research proposal following RAEng feedback (28 Aug 2026): one hypothesis-testing question, leading with the novel element — the Kenyan-accent fine-tuned model. Protocol exists at `ablespeak/research/PROTOCOL.md`: 5–8 participants, ~30 min each.
- **The metric is command match rate, not WER.** From the protocol: *"scroll down"* misheard as *"scroll town"* is WER 0.5 and the command does not fire at all, while a fifteen-word sentence with two errors scores better and costs the user nothing. WER and usefulness come apart hardest exactly where these users live. This is a genuinely publishable framing — no existing evaluation reports it.
- **Per-student vocabulary biasing** — names, subjects, app names, the student's own command aliases.
- **Tunable filter sensitivity per student.** The `SILENCE` marker filter and known-hallucination list currently apply one global threshold; a quiet or atypical speaker gets discarded by the very filter meant to protect them.
- **Visible recognition-accuracy readout**, so degradation is observed rather than guessed at.

**Acceptance:** command match rate measured, with date and sample size, for fine-tuned vs base model; no student's speech silently discarded at default settings.

---

### Stage 2 — Accessibility Layer

**Outcome:** AbleSpeak knows what is on screen without looking at pixels.

- **A persistent UIA sidecar** (C#/COM host, or a native Node addon) rather than per-call PowerShell — gated on the Week 2 latency measurement.
- **A screen model**: focused window → element tree → actionable elements with their supported patterns. Cached, invalidated on focus and window change.
- **Pattern-based execution**: `Invoke` a button, `Value` a text field, `Scroll` a pane, `ExpandCollapse` a menu — instead of moving a synthetic mouse to a guessed coordinate.
- **A coverage matrix** across the real target set (Word, Chrome/Edge, File Explorer, Zoom, WhatsApp Web, the learning tools actually used at KISE), recording for each: elements exposed, patterns supported, fallback required.
- **Vision as declared fallback**, invoked only where the matrix says the tree is empty.

**Acceptance:** **UIA resolution rate** — the share of targets resolved semantically rather than by pixel grounding — measured per app. This is the signature Tier 2 metric; it is the number that says the product understands the screen.

**Risk:** apps with poor UIA exposure (Electron apps, canvas-rendered UI) may force vision fallback more often than hoped. The coverage matrix exists to find that out early rather than late.

---

### Stage 3 — AI Interaction Agent

**Outcome:** *"Open my email and find the message from John"* works.

The seven-step loop, mapped to components:

| Step | Component | Status |
|---|---|---|
| 1. Understand speech | `voice-handler.js` + Stage 1 | Built, improving |
| 2. Interpret intent | `ai-engine.js` | Built (single-step only) |
| 3. Inspect UI structure | Stage 2 screen model | **New** |
| 4. Identify controls | Semantic element selection | **New** |
| 5. Execute | `tool-registry.js` / `system-tools.js` | Built |
| 6. Confirm what happened | Post-action tree diff | **New** |
| 7. Recover | Re-plan + undo | **New** |

The three new pieces are steps 3, 6 and 7. Step 6 is the one usually skipped and the one that matters most here: after acting, re-read the tree and check the screen changed as predicted. Without it the agent cannot tell success from silent failure — and the student, who cannot look over and check, is the one who pays.

- **Planner:** decompose intent into a step sequence over the current element set, with a declared expected end-state per step.
- **Verification:** tree diff against expectation; mismatch triggers re-plan, not a blind retry.
- **Recovery:** bounded re-plan attempts, spoken explanation, undo where the action is reversible, and a safe stop where it is not.
- **Safety:** every destructive action stays behind the existing confirmation layer. An agent that plans multi-step actions raises the cost of a wrong plan, so `safety.js` gets extended, not bypassed.

**Acceptance:** a defined set of 20 multi-step natural-language tasks, with measured completion rate and recovery rate.

---

### Stage 4 — Personalisation

**Outcome:** AbleSpeak fits this student, and follows them to another machine.

- **Portable student profile** — vocabulary, aliases, macros, filter thresholds, speech adaptation — that travels across devices.
- **Learned aliases from corrections.** Every correction is a labelled training pair the product currently throws away.
- **Workflow macros:** "start my homework" → a named multi-step plan.
- **Per-student ASR adaptation**, building on Stage 1.

**Acceptance:** a student's setup restores on a second machine; measured reduction in retries per completed task.

---

### Stage 5 — Validation & Deployment

**Outcome:** evidence, not assertion. This stage is what converts "early stages of development" into "impact observed and measured."

The Evidence Pipeline already exists and should not be reinvented:

| Stage | What | Status (3 Sep 2026) |
|---|---|---|
| S1 | Expert evaluation | **Running** since 27 Aug 2026 |
| S2 | Partner survey + trusted testers | Not started |
| S3 | Independent pilot, ~20 users, ~6 months, with GDI Hub | Not started |

- **Registered measures:** independent task completion; `first_time_actions` — a log of things a participant did for the first time (Cathy Holloway's phrase); a QoL instrument to be chosen *with* GDI Hub, not invented here.
- **Ethics and consent are a gate, not paperwork.** Written consent per participant; for under-18s at KISE, guardian consent plus the student's own assent. Recordings are speech data from people with disabilities — among the most sensitive categories there is. Agree materials with GDI Hub first; this is the tracked S3 readiness item.
- **Partners:** inABLE (`INA`), Kilimanjaro Blind Trust (`KBT`), Strathmore (`STR`) — all currently `asked: null`, `responses: 0`.

**Dated external gates**

- **Early Nov 2026** — Zero Project Technology Forum applications open (they will email). For ICT solutions with proof of concept.
- **10–12 Feb 2027** — Technology Forum, Vienna.
- **First months of 2027** — `#ZeroCall28` expected. Per the standing rule: do not re-nominate for maturity-gated awards until S2 numbers exist.

---

## Technical architecture

```
Student speaks
     │
     ▼
[Overlay]  VAD · MediaRecorder · echo protection          ← student's only surface
     │  ws: voice_audio
     ▼
[Gateway :3001]
     │
     ├─► [ASR]  fine-tuned Whisper / Gemini
     │          + per-student vocabulary bias      ← Stage 1
     │
     ├─► [Fast router]  ~40 patterns, ~200 ms, no LLM
     │
     └─► [Agent]                                   ← Stage 3
              │
              ├── reads ──► [Screen Model]         ← Stage 2  ** the new layer **
              │               UIA tree · patterns · rects
              │               vision grounding as fallback
              │
              ├── plans ───► step sequence + expected end-state
              │
              ├── acts ────► [Tool Registry] ──► UIA pattern / Chrome bridge / OS
              │
              ├── verifies ► tree diff vs expectation
              │
              └── recovers ► re-plan · undo · spoken explanation
     │
     ▼
[TTS]  spoken confirmation
     │
     ▼
[KPI engine]  probes · aim line · Theil–Sen trend · decision flags   ← feeds Stage 5
```

The **Screen Model** is the load-bearing addition. Everything labelled Stage 3 reads from it.

---

## KPIs and success criteria

| Metric | Why it matters | Baseline |
|---|---|---|
| **Command match rate** | Share of spoken commands that would run the right action. The honest metric; WER is not. | To be measured, Stage 1 |
| **UIA resolution rate** | Share of targets resolved semantically vs pixel fallback. The Tier 2 signature. | To be measured, Stage 0 W2 |
| **Independent task completion** | Registered outcome measure; already in the KPI engine as `independence_rate` | Engine built |
| **Recovery rate** | Failed actions recovered without adult help | Stage 3 |
| **Time to action** | p50 / p95 | 200–500 ms fast path; 2–8 s LLM path |
| **Grounding hit rate** | Decides the MolmoWeb GPU investment | Harness built, unrun |
| **Dosage** | Sessions/week, active minutes — intervention fidelity | Sessions tracked, not reported |
| **`first_time_actions`** | Things a student did for the first time | Stage 5 |

The first two are the ones to lead with. Together they say: *we hear this student, and we understand their screen.*

---

## Dependencies

- **Everything ambitious depends on Stage 2.** Stages 3 and 4 are unbuildable without a semantic screen model.
- **Stage 2's design depends on one measurement** taken in Stage 0 Week 2 (UIA latency).
- **Stage 5's timeline depends on ethics/consent sign-off with GDI Hub**, which is not started and has external turnaround.
- **Stage 1's study depends on participant recruitment** through KISE, which depends on school calendars.
- **Zero Project and most award routes depend on S2 evidence existing** — a hard sequencing constraint, not a preference.

---

## Team & skills required

Current: Tunga Innovation Ltd, team of 3, pre-revenue, self-funded. One builder on this codebase.

| Need | For | Have? |
|---|---|---|
| Node / Electron / React | Stages 0–4 | Yes |
| **Windows native (C#, COM, UIA)** | Stage 2 sidecar | **Gap** |
| ML engineering (ASR fine-tune + eval) | Stage 1 | Partial |
| Research design / ethics | Stage 5 | Via GDI Hub — Maryam Bandukda offered a call (28 Aug 2026) |
| Accessibility QA with real users | All stages | Via KISE; inABLE **NEEDS INPUT** |

**The honest capacity statement:** six stages at one builder is a twelve-to-eighteen-month arc, not twelve months. The two levers are narrowing Stage 2's app coverage, or adding a Windows-native contractor for roughly a two-month engagement. Stage 2 is the correct place to spend the first outside money, because it is both the biggest technical unlock and the clearest skills gap.

---

## Partnership inputs — NEEDS INPUT

**The Laurie/Microsoft and inABLE material is not in this workspace.** Searched: every `.md`, `.txt`, `.yaml`, `.json` and source file across `ablespeak/`, `tier2/`, `website/` and `fundinagent/`. Zero hits for "Laurie". inABLE appears three times, all as network references, never as meeting content:

- `kb/research.yaml` — partner row: `asked: null`, `agreed: null`, `responses: 0`
- `kb/past_answers.md` — blind/low-vision screen reader as "a need identified with inABLE and Microsoft's accessibility team"
- `kb/recent_updates.md` (23 Aug 2026) — "inABLE/Microsoft accessibility contacts" listed as a UK partnership route

**What that input would actually change** — these four decisions are parked, not guessed:

1. **Scope of the semantic layer.** If the blind/low-vision screen reader is a near-term commitment, Stage 2's screen model must expose a full reading/navigation surface, not just an actionable-control surface. That is a materially larger Stage 2.
2. **ASR hosting and cost.** Microsoft engineering support or Azure credits would change whether the fine-tuned model is self-hosted, and therefore Stage 1's cost and latency profile.
3. **Stage 5 recruitment.** inABLE converting from `asked: null` to an agreed S2 partner would set the Stage 2 evidence timeline — currently the binding constraint on every maturity-gated funding route.
4. **Sequencing of a Stage 6.** Whether blind/low-vision is a separate rollout (the stated "each new niche a rollout, not a restart" pattern) or folds into Stage 2.

Send the notes, transcripts or recordings and these four get resolved into the plan directly.

---

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| **KPI engine uncommitted** | Loss of 45 tests, 4 tables, 13 endpoints | Commit in Stage 0, day 1 |
| PowerShell UIA latency too high | Stage 2 redesign mid-flight | Measure in Week 2, before planning Stage 2 |
| Poor UIA coverage on target apps | Vision fallback dominates; cost and latency stay high | Coverage matrix early; scope app list to what students actually use |
| Solo capacity vs six stages | Slip across every downstream stage | Stated openly above; Stage 2 contractor is the lever |
| Participant recruitment on school calendars | Stage 1 and 5 both slip | Sequence data collection to term dates |
| Evidence gate on funding | Maturity-gated routes stay closed | S2 is the unlock; do not nominate before it |

---

## Open questions

1. Windows-only for Stage 2, or does macOS (AXAPI) enter the arc?
2. Does the Chrome extension (Tier 1) stay a separate product, or become Tier 2's browser adapter?
3. Is there a target device spec at KISE? Classroom laptop performance bounds the sidecar and any local model.
4. Does the planned UK entity registration change where pilot data may be stored?

---

*Prepared as an engineering build plan. Stage 0 is committed work; Stages 1–5 are direction with acceptance criteria. Companion document: `AbleSpeak-Tier2-Gap-Analysis.md`.*
