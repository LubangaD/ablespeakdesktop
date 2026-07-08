# AbleSpeak — Tier 2 Gap Analysis

**Adoption & visibility gaps for a student without hands and for teachers monitoring progress.**

*Senior engineering review · Lens: MTSS/RTI **Tier 2** — targeted intervention with frequent progress monitoring and data-based decisions.*

---

## The Tier 2 bar

Tier 2 is not "give the student a tool." It is a targeted intervention that must produce, for an interventionist/teacher:

- a **baseline** and a **measurable goal** per student,
- **frequent progress-monitoring data** against that goal,
- **decision rules** (e.g. "4 points below the aim line → change the intervention"),
- **fidelity/dosage** evidence (was it used, how often, how long), and
- **shareable documentation** for reviews and IEPs.

This document evaluates AbleSpeak against that bar, grounded in the current build: a per-machine Electron app with a local SQLite `commands` store, a `students` table (id, name, `session_prefix`), and a `Teacher.jsx` analytics page. The skeleton is right; it measures activity, on one machine, with a guessed identity. That is the core problem.

Severity key: **Blocker** = the target user cannot succeed. **Major** = serious friction / missing Tier 2 requirement. **Minor** = polish.

---

## Part A — Why the student won't keep using it

### A1. It can't reliably hear *their* voice — the #1 adoption killer
The pipeline uses general-purpose cloud ASR (Gemini/Whisper). Students who qualify for Tier 2 assistive tech disproportionately have **atypical speech** — dysarthria, apraxia, low volume, atypical prosody. General ASR degrades sharply on exactly this population, and the noise/echo/hallucination filters discard low-confidence audio as "no speech" — silently rejecting the very students the tool exists for.
**Severity: Blocker.**
**Done looks like:** per-student speaker adaptation / custom vocabulary, a visible recognition-accuracy readout, and per-student tunable filter sensitivity so a quiet or atypical speaker isn't filtered out.

### A2. The student can't get in the door alone
Setup and recovery assume hands: install, load the unpacked Chrome extension, edit `.env`, click the mic overlay, grant permissions, relaunch after a crash. A student without hands cannot self-onboard or recover from a disconnect.
**Severity: Blocker.**
**Done looks like:** zero-hands launch (auto-start, wake-word arming, auto-reconnect); one-time setup performed by an adult; nothing in the daily loop that needs a mouse or keyboard.

### A3. Latency and effort cost drive abandonment
Multi-second round-trips plus any misrecognition make every retry a physical and cognitive cost. Effort/fatigue is the best-documented reason students abandon AAC and voice tools.
**Severity: Major.**
**Done looks like:** sub-2s response on common commands, always-visible progress state, and the undo/correction loop measurably cutting retries.

### A4. Nothing follows the student
Profiles, macros, and "memory" live in one machine's local SQLite. Change rooms or devices and the personalization is gone — so the student never builds a stable, trusted setup.
**Severity: Major.**
**Done looks like:** a portable per-student profile (vocabulary, macros, preferences) that travels across devices.

### A5. Cloud + classroom reality
Continuous audio and screenshots to a cloud model raise privacy and connectivity concerns; no offline path means a wifi outage kills the tool mid-lesson. Privacy mode helps, but the dependency remains.
**Severity: Major.**
**Done looks like:** graceful offline degradation for local/system commands, and clear, classroom-appropriate privacy controls.

### A6. The student's own feedback loop
Historically the overlay could stick on "processing" or drop commands with no signal (recently hardened). If a student can't tell whether they were heard, they lose trust fast.
**Severity: Major (now partially addressed).**
**Done looks like:** an always-truthful state — heard / working / done / failed — and an on-screen last-transcript so the student sees what was understood.

---

## Part B — Why the teacher has no real visibility

### B1. No cross-device view — the core Tier 2 failure
Everything is local SQLite on the student's machine, and `Teacher.jsx` reads *that machine's* database. A teacher with a caseload cannot see their class from their own device — they would have to physically open each laptop. Tier 2 requires an interventionist to monitor multiple students frequently and centrally.
**Severity: Blocker.**
**Done looks like:** a central roster + sync so a teacher sees every assigned student in one place, on their own device.

### B2. Student identity is a guess, not an account
Commands are attributed to a student only by matching a text `session_prefix` against `session_id`. There is no login, no roster, no reliable "who is speaking." On any shared device the data is effectively unattributable.
**Severity: Blocker.**
**Done looks like:** real student profiles with roster sync (SIS / Google Classroom), and a reliable, low-friction student-select on the device.

### B3. The metrics measure *usage*, not *progress*
The dashboard shows command counts, success rate, latency, and a 7-day bar. Tier 2 monitoring needs a **baseline**, a **goal/aim line**, a **trend line**, **phase-change markers**, and **decision rules**. Command volume does not tell a teacher whether the student is gaining **independence**.
**Severity: Blocker (for Tier 2).**
**Done looks like:** goal setting plus progress-monitoring charts of outcome measures (independence rate, task completion, prompts-to-complete over time) — not activity counts.

### B4. No alerting or live "what's happening"
Teachers aren't told when a student hasn't used the tool in a week, when failure rate spikes, when the mic/extension is down, or when a student is stuck right now. The silent failures fixed at the student layer never reach the teacher. Tier 2 depends on catching early signals.
**Severity: Major.**
**Done looks like:** digest + threshold alerts (non-use, error/abandonment spikes, tool-health down) delivered to the teacher.

### B5. No fidelity or dosage data
Tier 2 documentation asks "was the intervention delivered as intended — how often, how long?" Sessions are tracked but not reported as frequency/duration/consistency of real use.
**Severity: Major.**
**Done looks like:** per-student dosage reporting (sessions/week, minutes of active use, streaks/gaps).

### B6. No exportable evidence
The page markets "handy for IEP and progress reporting," but there is no export/PDF/CSV. Reviews and IEP meetings need a shareable, dated report.
**Severity: Major.**
**Done looks like:** one-click, dated progress-report export (PDF/CSV) per student.

### B7. No roles, consent, or retention model
No teacher-vs-student auth (a student can open the Teacher page), no FERPA/consent framing, and history is thin (~7 days) — Tier 2 decisions need weeks-to-months of longitudinal data.
**Severity: Major.**
**Done looks like:** role separation, a consent/retention policy, and longitudinal history sufficient for trend-based decisions.

---

## Part C — The one-line verdict

For the **student**, the make-or-break gap is **atypical-speech recognition** plus **hands-free onboarding**; without those, the target population literally cannot use the tool. For the **teacher**, the make-or-break gap is that the product is **single-device and usage-focused**, when Tier 2 demands **centralized, per-student, goal-referenced progress monitoring with alerts and exportable reports**. The `students` table and `Teacher.jsx` are the right skeleton — they are just measuring the wrong things, in the wrong place, for an unknown student.

---

## Part D — Prioritized path to Tier 2 readiness

| # | Change | Fixes | Priority |
|---|--------|-------|----------|
| 1 | Atypical-speech support: per-student vocabulary/adaptation + tunable filter sensitivity + accuracy readout | A1 | P0 (student blocker) |
| 2 | Hands-free onboarding: auto-start, wake-word arm, auto-reconnect; adult-run one-time setup | A2 | P0 (student blocker) |
| 3 | Real student identity: profiles + roster sync; reliable on-device student-select | B2 | P0 (visibility blocker) |
| 4 | Central sync + teacher cross-device dashboard | B1 | P0 (visibility blocker) |
| 5 | Progress-monitoring data model: baseline, goal/aim line, outcome measures (independence, completion), trend + phase markers, decision rules | B3 | P0 (Tier 2 core) |
| 6 | Alerts & digests: non-use, error spikes, tool-health, stuck-now | B4 | P1 |
| 7 | Fidelity/dosage reporting; longitudinal retention | B5, B7 | P1 |
| 8 | Exportable IEP/Tier 2 progress reports (PDF/CSV) | B6 | P1 |
| 9 | Portable student profiles across devices | A4 | P1 |
| 10 | Offline degradation + classroom privacy controls | A5 | P2 |
| 11 | Roles/consent/FERPA framing | B7 | P2 |

**Sequencing note:** items 3–5 are the spine — reliable identity, central sync, and a progress (not usage) data model. Alerts, fidelity, and export (6–8) are reporting layers built on that spine. The student blockers (1–2) run in parallel, because without them there is no data worth monitoring.

---

*Prepared as an engineering gap analysis. "Done looks like" statements are acceptance criteria, not designs — each warrants its own build plan.*
