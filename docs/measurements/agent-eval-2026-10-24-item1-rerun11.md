# Task agent evaluation — 2026-10-24 (item1-rerun11)

Run 2026-10-24 01:48 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 2 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **1 of 2** |
| Check passed and AbleSpeak said it finished | **1 of 2** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **2** |
| Median time per task | **28 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| explorer-open-file | pass (done) | 0 | 19 s | I opened File Explorer, then navigated to Documents. Finally, I opened the file ablespeak- | window "ablespeak-eval.txt - Notepad" |
| notepad-save-as | fail (failed) | 2 | 28 s | I couldn't finish: That field cannot be changed. I did 3 of 5 steps. I took back the typin | eval-saved.txt not in Documents |

Sample size: 2 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun11.json`.
