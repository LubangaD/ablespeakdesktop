# Task agent evaluation — 2026-10-24 (item1-rerun17)

Run 2026-10-24 02:09 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 1 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **0 of 1** |
| Check passed and AbleSpeak said it finished | **0 of 1** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **2** |
| Median time per task | **34 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| notepad-save-as | fail (failed) | 2 | 34 s | I couldn't finish: I couldn't find the file name box in the Save As dialog: That control d | eval-saved.txt not in Documents |

Sample size: 1 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun17.json`.
