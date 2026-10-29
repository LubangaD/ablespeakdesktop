# Task agent evaluation — 2026-10-24 (item1-rerun15)

Run 2026-10-24 02:04 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 1 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **0 of 1** |
| Check passed and AbleSpeak said it finished | **0 of 1** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **1** |
| Median time per task | **21 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| notepad-save-as | fail (stopped) | 1 | 21 s | Okay, I stopped the task. I did 2 of 3 steps. | eval-saved.txt not in Documents |

Sample size: 1 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun15.json`.
