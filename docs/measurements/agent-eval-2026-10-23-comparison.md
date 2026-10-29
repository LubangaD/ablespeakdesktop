# Task agent: four runs on 23 Oct 2026

Four runs of `tools/agent-eval` (20 tasks, one run each, one computer, Gemini 2.5 Flash, the Chrome extension connected). Raw data: `agent-eval-2026-10-23-{baseline,after,fixes,fixes2}.json`.

| Measure | Baseline | After (ARTEMIS ideas) | Fixes, round 1 | Fixes, round 2 |
|---|---|---|---|---|
| Check passed | 10 | 10 | 9 | **13** |
| Check passed **and** AbleSpeak said it finished | 7 | 8 | 7 | **12** |
| Said it finished but the check failed | 0 | 1 | 2 | 1 |
| Re-plans in all | 29 | 25 | 25 | 29 |
| Median time per task | 24 s | 17 s | 21 s | 20 s |

By app, passed and said so (baseline → round 2): Notepad 2 → 3 of 3, Calculator 2 → 3 of 3, File Explorer 1 → 3 of 3, Settings 1 → 2 of 3, Edge 0 → 1 of 2, Chrome 1 → 0 of 3, Word 0 → 0 of 2.

## What changed

**After (ARTEMIS ideas; `llm-reliability.js`, `screen-change.js`).**
- The task agent waits for the screen to settle before checking a step.
- Plans and checks run at temperature 0, and a reply that isn't JSON is asked for once more.
- A busy or timed-out model moves to a backup model.
- Windows whose title starts with "AbleSpeak" are no longer ignored.

**Round 1.**
- **Step checker:** judges a step by its purpose; selected is not opened; it may say "unsure" rather than "failed".
- **Final check:** looks at the whole task before saying "done", and re-plans if it isn't finished.
- **Name matching:** a name found only inside another ("add" in "Memory add") is not pressed, and the AI is told the closest name.
- **Unsupported action:** a control asked to be pressed in a way it doesn't support is pressed the way it does.
- **Opening apps:** a newly opened app's window is brought to the front.
- **Microphone:** speech is ignored while the evaluation runs.

**Round 2.**
- **Tools fit the window in front.** No web-page tools in a desktop app, and no extension tools in Edge. "Press Enter" in Notepad had gone to Chrome and got no answer.
- **Typing is checked against the document's own text.** Word's page isn't in the window's controls, so "unsure" had counted as done.
- **"Unsure" is said out loud.** A task whose end result couldn't be checked now says so.
- **Digit names.** Calculator's "7" finds the "Seven" key.

**After round 2 (not yet measured).** During the evaluation the extension's browser wasn't brought forward after a browser action. Normal use does bring it forward. So the agent opened Wikipedia in the extension's tab, then read a different Chrome window and judged it failed. All three Chrome tasks in round 2 failed this way.

## Reading the numbers
One run each of 20 tasks, so a difference of one or two tasks is within run-to-run variation. Round 2's gain is larger than that, and it comes from the desktop apps, where the causes were found and fixed by name.

The backup model was never needed in these runs, so it is tested by unit tests only. The same applies to the one-command loop's screen notes.

## Still open
- **Word:** typing right after Word opens can go nowhere. In word-type the agent then made a second document and typed there; the test reads the first document, which is the one false "done". "Make it bold" pressed Bold before selecting the text, then pressed it again and turned bold off. The final check caught that, and the task says it failed.
- **Edge maps:** "go to Google Maps" in Edge typed into the page's search box instead of the address bar.
- **Settings Sound:** reached the System page but not Sound.
- **The test itself:**
  - Browser tasks use the person's own open Chrome and Edge windows.
  - Notepad restores tabs from earlier sessions.
  - The checks are loose: "Brightness" also matches the System page.

## 24 October: the test made trustworthy (fix plan, item 1), and what it found

The task set grew to 26 (six tasks in apps not tested before: Excel, a file and a PDF opened from Explorer, Save As in Notepad, Spotify, the Start menu), the checks became strict (a control's type and a phrase only on the right page), `--runs 3` reports lowest, typical and highest, fixtures are rewritten each run, Word, Excel and Notepad are closed without saving, and Explorer windows a task opened are closed. The six new tasks ran one at a time until each passed (`agent-eval-2026-10-24-item1-rerun*.json`). They found eight general faults, all fixed:

| Fault | Fix |
|---|---|
| Keys and typing went to an untitled foreground window (so Ctrl+Shift+S only sometimes opened Save As) | An untitled foreground window is not the app; the app's own window is brought forward first |
| Dialogs (Save As, "Open with") were invisible to the agent: owned or untitled windows were skipped | A dialog in front is listed; an untitled one is listed by its class |
| "Open Documents" launched Word six times ("document" → Word) | Documents, Downloads, Desktop, Pictures, Music and Videos open in File Explorer |
| Files in Explorer could not be opened by name (extensions hidden; two files show the same name) | A file in a folder window is opened by its real path; Windows' "Open with" chooser is handled (text → Notepad, else ask) |
| The Windows key could not be pressed | A real key press; Win+letter shortcuts too |
| "File name:" typing went to the label (three controls share the name) | The kind of control that suits the action wins (typing wants a field, pressing wants a button) |
| A dialog that took focus before it was listed was judged "nothing changed" | Settling ignores focus flicker and waits up to 4 s |
| The agent answered Windows' "replace?" with Enter and overwrote a file | `save_document_as` drives the whole dialog and never replaces unless told; Enter in a "Confirm Save As" box asks first |

Also: the planner no longer opens apps through the Start menu (a regression I caused and removed the same day), a step waits up to 4 s for a dialog, and a file saved under a name is one tool call rather than a typed path.

### The whole set, run once (02:17)

`node tools/agent-eval/run.mjs --live --label item1-full` on this laptop, Gemini 2.5 Flash, the Chrome extension connected, one run. Raw data: `agent-eval-2026-10-24-item1-full.json`.

| Measure | 23 Oct, round 2 (20 tasks, loose checks) | 24 Oct, all 26 (strict checks) | 24 Oct, the same 20 tasks |
|---|---|---|---|
| Check passed | 13 | **17** | 11 |
| Check passed **and** AbleSpeak said it finished | 12 | **17** | 11 |
| Said it finished but the check failed | 1 | 1 | 1 |
| Re-plans in all | 29 | 23 | 23 |
| Median time per task | 20 s | 19 s | 19 s |

By app, passed and said so: Notepad 3 of 5, Calculator 3 of 4, File Explorer 5 of 5, Settings 3 of 3, Edge 1 of 2, Chrome 0 of 3, Word 0 of 2, Excel 1 of 1, Spotify 1 of 1. The six new tasks all passed first time with no re-plans. Settings Sound passed for the first time.

**Reading the numbers.** The 20 old tasks went from 12 to 11 under stricter checks, which is within run-to-run variation. Two of the three that passed yesterday and failed today (notepad-two-lines, notepad-close) started in a Notepad that had brought back the previous task's tab, a fault of the test on this laptop rather than of the agent (see below). The false "done" is still Word.

**What failed, and why.**

| Task | What happened | Where the fault is |
|---|---|---|
| notepad-two-lines | Notepad opened with "My name is Amina" from the first task. After Ctrl+A the agent put "Line one" in through the control's value, which left the caret at the start, so Enter and "Line two" went in front of "Line one". | Test (restored tab); agent (caret after setting a value) |
| calculator-add | "Type 12" through a control pressed only "One". After "12 +", pressing 3 shows "3" in the display and "12 +" in the expression line, which is right, but the step checker called it wrong, and that used up the last re-plan. | Agent (step checker; typing several digits) |
| calculator-scientific (passed) | The last step switched to Scientific, but the spoken summary said "it didn't work", reporting an earlier failed step as the outcome. | Agent (summary) |
| edge-maps | With Edge in front, open_url was called twice and went to Chrome (the extension's browser), which was then brought forward. The third try typed the address into Edge's bar without pressing Enter. The tool filter for a browser without the extension should have withheld open_url and did not. | Agent (tools in Edge) |
| chrome-wikipedia, chrome-youtube-search, chrome-new-tab | open_url reported success, but the tab in front still showed the old page when checked. The agent then typed into the address bar with the extension's typing tool, which only types into the page, and pressed Ctrl+L and Ctrl+T through it, which only sends key events to the page; none of these can work. The browser auto-focus added on 23 Oct did bring Chrome forward, but it was not enough. Why the tab did not change is not yet found: either the page took longer than the 6 s wait (and the "take back" at the end, which goes back a page, then undid a late load), or the extension acted on a tab other than the one read. Settle it by running chrome-wikipedia alone with the server console visible: the `[WsHub] ← Extension response` and `[Agent] Screen:` lines show what the extension did and which window was read. | Not known |
| word-type (false "done") | Word still loses the first keystrokes after opening (only "s" arrived). The agent's own reading of the document then saw "Science homework"; the test's reading of Word's window did not. The test looks for the first Document or Edit control among the first 400 controls of the window, which in Word may not be the page. Not yet settled whether the agent typed in the wrong place or the test read the wrong place. | Agent or test |
| word-title-bold | Lost keystrokes again ("s", then "sTitle"). After typing "Title" the agent could not see that Ctrl+A had selected it (Word's selection is not in the controls), gave up and undid its typing. | Agent (Word) |
| notepad-close | Notepad opened with "dog" from notepad-replace. Alt+F4 closed Notepad at once (with "open content from the previous session" Notepad does not ask to save), which finished the task, but the plan expected a "Don't save" button: the next step failed, "Switch to Notepad" reported it closed, and the re-plan opened Notepad again and typed again. Yesterday's run ended one step earlier ("Notepad isn't open", and the check passed). | Test (restored tab); agent (an app that is gone when the task was to close it means done) |

**What the run did to the browsers.** Edge: the active tab searched "Nairobi weather" (Back returns it) and ablespeak-eval.pdf opened in a new tab. Chrome: one new tab was opened and left; no page was changed.

**Faults of the test found by this run.**
- On this laptop Notepad is set to open the previous session's content, so closing Notepad between tasks keeps its tab, and the next Notepad task starts with the previous one's text. `--fresh-notepad` only clears before a run. On the test laptop Notepad is set to open a new window (README, step 5); here, Notepad's tab state needs clearing before each Notepad task as well.
- The Word text check (`/screen/text?app=word`) may read a control other than the page. Check what it returns with a known document open.

**Still open, in order.** Chrome (3 tasks, cause not known), Word (2 tasks: wait for focus after opening, and a way to see the selection), open_url withheld in Edge, the Calculator step checker, the caret after setting a control's value, "closed" counted as done, the summary reporting the last state, and the two test faults above.

