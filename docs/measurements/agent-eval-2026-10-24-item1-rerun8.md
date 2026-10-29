# Task agent evaluation — 2026-10-24 (item1-rerun8)

Run 2026-10-24 01:30 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 2 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **0 of 2** |
| Check passed and AbleSpeak said it finished | **0 of 2** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **4** |
| Median time per task | **73 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| explorer-open-file | fail (failed) | 2 | 73 s | I couldn't finish: The tool reported opening the file in a new window, but the screen show | window "Documents - File Explorer" |
| notepad-save-as | fail (failed) | 2 | 19 s | I couldn't finish: I couldn't bring "notepad-check.txt - Notepad" to the front.. I did 2 o | eval-saved.txt not in Documents |

Sample size: 2 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun8.json`.
