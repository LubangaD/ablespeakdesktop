# Task agent evaluation — 2026-10-24 (item1-rerun2)

Run 2026-10-24 00:54 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 5 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **2 of 5** |
| Check passed and AbleSpeak said it finished | **2 of 5** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **6** |
| Median time per task | **26 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| explorer-open-file | fail (failed) | 2 | 26 s | I couldn't finish: The step intended to open the 'Documents' folder in File Explorer, but  | I couldn't find an open window for "notepad". |
| explorer-open-pdf | fail (failed) | 2 | 28 s | I couldn't finish: The step intended to open 'Documents' in File Explorer, but instead, a  | window "Document6 - Word" |
| notepad-save-as | fail (failed) | 2 | 33 s | I couldn't finish: The Alt+F key combination should have opened the 'File' menu in Notepad | eval-saved.txt not in Documents |
| spotify-search | pass (done) | 0 | 19 s | I opened Spotify and searched for Sauti Sol. | found DataItem "sauti sol songs" |
| start-menu-calculator | pass (done) | 0 | 6 s | I opened Calculator. | window "Calculator" |

Sample size: 5 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun2.json`.
