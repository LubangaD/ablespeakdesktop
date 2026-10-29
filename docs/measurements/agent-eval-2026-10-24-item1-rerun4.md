# Task agent evaluation — 2026-10-24 (item1-rerun4)

Run 2026-10-24 01:08 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 3 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **0 of 3** |
| Check passed and AbleSpeak said it finished | **0 of 3** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **6** |
| Median time per task | **39 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| explorer-open-file | fail (failed) | 2 | 47 s | I couldn't finish: No element named "ablespeak-eval.txt" found. Use list_desktop_elements  | I couldn't find an open window for "notepad". |
| explorer-open-pdf | fail (failed) | 2 | 32 s | I couldn't finish: The screen did not change after the scroll down action, indicating the  | window "Documents - File Explorer" |
| notepad-save-as | fail (failed) | 2 | 39 s | I couldn't finish: The tool could not find the 'File name:' text box, and nothing changed  | eval-saved.txt not in Documents |

Sample size: 3 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun4.json`.
