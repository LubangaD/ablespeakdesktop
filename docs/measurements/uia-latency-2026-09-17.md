# UI Automation latency and coverage — 2026-09-17

Measured 2026-09-17 00:38:10 with `node tools/uia-bench.mjs` on one machine:
Snapdragon(R) X 10-core X1P64100 @ 3.40 GHz, 10 threads, 16 GB RAM, Windows 10.0.26200, Node v24.20.0 (arm64).

Each app was read 7 times after one warm-up read, with the screen model
(`src/screen-model.js`: the persistent PowerShell worker running compiled C#
with a UI Automation cache request, up to 400 controls). "Old scan" is the
earlier PowerShell loop (`list_desktop_elements`, capped at 60 controls),
median of 3.

**Decision line: 200 ms per read.** The slowest app took 470 ms at p95, over the 200 ms line. Reads should stay cached and be refreshed only on window change, and a native sidecar should be scoped for the slow apps.

| App | Read p50 / p95 (ms) | Old scan p50 (ms, controls) | Controls | With actions | Unnamed with actions | Invoke / Value / Toggle / Expand / Select | Scroll / Text | Verdict |
|---|---|---|---|---|---|---|---|---|
| Word | 378 / 470 | 427 (60) | 177 | 140 | 3 | 61 / 25 / 29 / 43 / 17 | 5 / 7 | Tree usable |
| Chrome | 66 / 76 | 109 (49) | 81 | 81 | 27 | 13 / 2 / 0 / 14 / 20 | 1 / 1 | Tree usable |
| Edge | 58 / 74 | 125 (37) | 60 | 60 | 20 | 7 / 1 / 0 / 10 / 20 | 0 / 1 | Tree usable |
| File Explorer | could not read: minimized — restore it and run again | | | | | | | |
| Zoom | not open | | | | | | | |
| WhatsApp | not open | | | | | | | |
| Spotify | 210 / 217 | 368 (failed) | 278 | 278 | 98 | 163 / 34 / 11 / 5 / 28 | 5 / 16 | Tree usable |
| Notepad | not open | | | | | | | |

- Worker start-up (once per app launch): 882 ms
- Listing open windows (once per command): 27 ms
- Sample size: 4 apps × 7 reads, one machine, one sitting.
- Not measured because they were not open: Zoom, WhatsApp. Open them and run the script again.

Raw numbers: `uia-latency-2026-09-17.json`.
