# Task agent evaluation — 2026-10-24 (item1-rerun6)

Run 2026-10-24 01:20 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 3 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **1 of 3** |
| Check passed and AbleSpeak said it finished | **1 of 3** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **4** |
| Median time per task | **27 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| explorer-open-file | fail (failed) | 2 | 58 s | I couldn't finish: The screen changed to a different application, and the expected file 'a | I couldn't find an open window for "notepad". |
| explorer-open-pdf | pass (done) | 0 | 15 s | I've opened File Explorer, navigated to Documents, and opened "ablespeak-eval.pdf" for you | window "ablespeak-eval.pdf and 11 more pages - Personal - Microsoft​ Edge" |
| notepad-save-as | fail (failed) | 2 | 27 s | I couldn't finish: The step intended to open 'Documents' within the 'Save as' dialog, but  | eval-saved.txt not in Documents |

Sample size: 3 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun6.json`.
