# Task agent evaluation — 2026-10-24 (item1-rerun18)

Run 2026-10-24 02:12 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 1 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **1 of 1** |
| Check passed and AbleSpeak said it finished | **1 of 1** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **0** |
| Median time per task | **27 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| notepad-save-as | pass (done) | 0 | 27 s | I opened Notepad, typed "hello there", and saved the document as eval-saved.txt in Documen | eval-saved.txt saved |

Sample size: 1 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun18.json`.
