# Task agent evaluation — 2026-10-23

Run 2026-10-23 22:28 with `node tools/agent-eval/run.mjs --live` on one machine: 20 tasks from `tools/agent-eval/tasks.json`, each run once.

| Measure | Result |
|---|---|
| Completion rate | **50%** (10 of 20) |
| Recovery rate | **47%** (8 of 17 tasks that needed a new plan) |
| Median time per task | 24 s |

| Task | Result | Re-plans | Time | What AbleSpeak said | Check |
|---|---|---|---|---|---|
| notepad-type | pass (done) | 1 | 14 s | I opened Notepad and typed "My name is Amina". | text found |
| notepad-two-lines | pass (done) | 1 | 25 s | I opened Notepad and typed "Line one". Then I typed "Line two" on a new line. | text found |
| notepad-replace | fail (failed) | 2 | 18 s | I couldn't finish: The text 'cat' is not selected in the document, as the document value i | missing dog |
| calculator-add | fail (failed) | 2 | 14 s | I couldn't finish: The display shows '21' instead of '1', indicating an unexpected result. | no control mentioning "42" |
| calculator-multiply | pass (done) | 1 | 17 s | I opened Calculator and multiplied 7 by 6. The answer is 42. | found Text "Display is 42" |
| calculator-scientific | pass (done) | 1 | 14 s | I opened the Calculator app and switched it to the scientific calculator. | found Button "Scientific notation" |
| explorer-downloads | fail (error) | 0 | 66 s | This operation was aborted | window "Home - File Explorer" |
| explorer-documents | pass (done) | 0 | 31 s | File Explorer is open to the Documents folder. | window "Documents - File Explorer" |
| explorer-search | fail (failed) | 2 | 34 s | I couldn't finish: The screen did not change, and the 'Search box' was not focused as expe | window "Documents - File Explorer" |
| settings-display | pass (failed) | 2 | 27 s | I couldn't finish: The page is already at the bottom.. I did 2 of 4 steps. | found Text "Monitors, brightness, night light, display profile" |
| settings-sound | pass (failed) | 2 | 23 s | I couldn't finish: That control does not support select. I did 2 of 3 steps. | found Text "Volume levels, output, input, sound devices" |
| settings-bluetooth | pass (done) | 0 | 10 s | I opened Settings and went to Bluetooth and devices. | found ListItem "Bluetooth & devices" |
| edge-search | fail (failed) | 2 | 10 s | I couldn't finish: I couldn't find an open window called "Edge".. I did 0 of 2 steps. | I couldn't find an open window for "msedge". |
| edge-maps | fail (failed) | 2 | 10 s | I couldn't finish: I couldn't find an open window called "Edge".. I did 0 of 3 steps. | I couldn't find an open window for "msedge". |
| chrome-wikipedia | pass (done) | 1 | 13 s | I opened Chrome, but I wasn't able to go to Wikipedia. | window "Wikipedia - Google Chrome" |
| chrome-youtube-search | pass (failed) | 2 | 25 s | I couldn't finish: The screen shows Google search results, not YouTube search results.. I  | window "photosynthesis - Google Search - Google Chrome" |
| chrome-new-tab | fail (failed) | 2 | 24 s | I couldn't finish: No new tab was opened, and the address bar still contains the previous  | window "photosynthesis - Google Search - Google Chrome" |
| word-type | fail (failed) | 2 | 41 s | I couldn't finish: The text 'Science homework' did not appear in the document, and no new  | missing Science homework |
| word-title-bold | fail (failed) | 2 | 43 s | I couldn't finish: Give a ref from uia_query or the control's name.. I did 4 of 6 steps. I | missing Title |
| notepad-close | fail (failed) | 2 | 30 s | I couldn't finish: The 'Document1 - Word' window is still visible, but a 'Save your change | still open: *notepad-check.txt - Notepad |

Sample size: 20 tasks, one run each, one computer. Raw data: `agent-eval-2026-10-23-baseline.json`.
