# Task agent evaluation — 2026-10-24 (validate-checks)

Run 2026-10-24 00:32 with `node tools/agent-eval/run.mjs --live` on one machine, model gemini-2.5-flash: 9 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Check passed | **5 of 9** |
| Check passed and AbleSpeak said it finished | **5 of 9** |
| Said it finished but the check failed (false "done") | **0** |
| Re-plans in all | **12** |
| Median time per task | **19 s** |

| Task | Run 1 | Re-plans | Time | What AbleSpeak said (last run) | Check (last run) |
|---|---|---|---|---|---|
| settings-display | pass (done) | 0 | 14 s | I opened Settings and navigated to the Display page. | found Group "Brightness & colour" |
| settings-sound | pass (done) | 1 | 15 s | I opened Settings and then opened the Sound settings. | found Group "Choose where to play sound. Headphones selected. Apps might have their own settings." |
| settings-bluetooth | pass (done) | 1 | 19 s | I opened Settings and navigated to Bluetooth & devices. | found Button "Add device" |
| excel-type | pass (done) | 0 | 17 s | I opened Excel, started a blank workbook, and typed "Budget" in the first cell. | found DataItem "A1" |
| explorer-open-file | fail (failed) | 2 | 35 s | I couldn't finish: The tool reported success, but the screen did not change, and the scrol | I couldn't find an open window for "notepad". |
| explorer-open-pdf | fail (failed) | 2 | 21 s | I couldn't finish: No element named "ablespeak-eval.pdf" found. Use list_desktop_elements  | window "Documents - File Explorer" |
| notepad-save-as | fail (failed) | 2 | 29 s | I couldn't finish: The 'Save As' window did not appear; the screen content remained unchan | eval-saved.txt not in Documents |
| spotify-search | pass (done) | 2 | 22 s | I opened Spotify, but then I had trouble searching. | found ComboBox "What do you want to play?" |
| start-menu-calculator | fail (failed) | 2 | 19 s | I couldn't finish: The Start menu did not appear, and nothing visible changed on the scree | I couldn't find an open window for "calculator". |

Sample size: 9 tasks, 1 run each, one computer. Raw data: `agent-eval-2026-10-24-validate-checks.json`.
