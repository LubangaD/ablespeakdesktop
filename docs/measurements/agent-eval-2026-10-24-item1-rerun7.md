# Task agent evaluation — 2026-10-24 (item1-rerun7)

Run 2026-10-24 01:25 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 2 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **0 of 2** |
| Check passed and AbleSpeak said it finished | **0 of 2** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **4** |
| Median time per task | **84 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| explorer-open-file | fail (failed) | 2 | 84 s | I couldn't finish: The step intended to open 'ablespeak-eval.txt' in Notepad, but the scre | window "Documents - File Explorer" |
| notepad-save-as | fail (failed) | 2 | 38 s | I couldn't finish: The 'Save As' window did not appear, and nothing visible changed on the | eval-saved.txt not in Documents |

Sample size: 2 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-item1-rerun7.json`.
