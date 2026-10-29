# Task agent evaluation — 2026-10-24 (item1-rerun)

Run 2026-10-24 00:46 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 5 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **0 of 5** |
| Check passed and AbleSpeak said it finished | **0 of 5** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **10** |
| Median time per task | **25 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| explorer-open-file | fail (failed) | 2 | 28 s | I couldn't finish: The Start menu did not appear, and nothing visible changed on the scree | I couldn't find an open window for "notepad". |
| explorer-open-pdf | fail (failed) | 2 | 26 s | I couldn't finish: The Start menu did not open, and nothing visible changed on the screen. | window "ablespeak - Antigravity IDE - Google/artemis repository" |
| notepad-save-as | fail (failed) | 2 | 25 s | I couldn't finish: Pressing the Windows key should open the Start menu, but the screen did | eval-saved.txt not in Documents |
| spotify-search | fail (failed) | 2 | 25 s | I couldn't finish: The Start menu did not open, and nothing visible changed on the screen. | "Spotify Premium" is minimized. Bring it to the front first. |
| start-menu-calculator | fail (failed) | 2 | 24 s | I couldn't finish: The Start menu did not open, and nothing visible changed on the screen  | I couldn't find an open window for "calculator". |

Sample size: 5 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun.json`.
