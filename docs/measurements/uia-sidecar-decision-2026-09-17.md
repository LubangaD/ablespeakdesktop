# Stage 2 decision: no separate UI Automation sidecar — 17 September 2026

**Decision:** keep reading windows through the persistent PowerShell worker
running compiled C# (`src/uia/screen-model-cs.js`). Do not build a separate
native (COM, "UIA3") sidecar.

## Why

The roadmap said to decide the Stage 2 architecture with a number
(`uia-latency-2026-09-17.md`). That measurement put Word at 378 ms p50,
over the 200 ms line, and Chrome and Edge well under it.

The obvious fix for a slow read is the newer COM interface (UIA3), which is
generally faster than the .NET client used now. We measured it on the same
windows, on the same machine, in the same sitting (4 reads each, full
property set, whole control tree in one cached request):

| Window | Current reader (ms) | UIA3 (ms) | Controls |
|---|---|---|---|
| Edge | 120, 39, 36, 33 | 67, 30, 30, 28 | ~170 |
| Antigravity IDE (Electron) | 168, 176, 189, 235 | 215, 189, 253, 219 | ~365 |
| Antigravity IDE, second window | 257, 264, 274, 215 | 273, 265, 237, 290 | ~315 |
| Brave | 45, 59, 41, 54 | 104, 96, 46, 44 | ~85 |
| Granola | 15, 11, 15, 14 | 154, 22, 13, 41 | 14 |

Measured with a throwaway probe (an interop assembly generated from
`UIAutomationCore.dll`). Word was closed at the time; Spotify was minimized
and is left out. Sample: 5 windows × 4 reads, one machine
(Snapdragon X, Windows 11, 16 GB).

UIA3 is not faster here. The time goes into each app building its answer,
not into the client library, so a new sidecar would add a second native
component to ship and maintain without making Word quicker.

## What keeps slow apps usable instead

- Reads are cached and reused until the window changes or AbleSpeak acts.
- The persistent worker already removed the per-call PowerShell start
  (a trivial command round-trips in 3–8 ms).
- Reading the whole tree in one cached request, skipping off-screen
  branches, already cut Spotify from ~300 ms to ~210 ms.
- For the agent, a slow read only costs one step's check; reads longer than
  1.5 s are dropped from the prompt rather than waited for.

## Revisit if

- Word stays above ~400 ms in live use and students notice the wait.
  Then try reading only the part of the window around the focused control,
  rather than a different client library.
- A target app turns out to answer the COM interface but not the .NET one.
