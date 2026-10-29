# Computer control: plan to fix what doesn't work yet

*24 October 2026, second version. What the app does, and what fails today. Based on the code and on four runs of the agent evaluation on 23 October (`docs/measurements/agent-eval-2026-10-23-comparison.md`). Sizes are for one engineer working on this full time.*

**The bar this plan aims at:** good enough to use **with a helper nearby**. That means 16 of 20 test tasks finish and say so, in each of three runs, with no false "done". Using it **alone** needs a higher bar, set after real people have used it.

## The problems, in order

| # | Problem | Size |
|---|---|---|
| 1 | The test isn't reliable enough to prove the fixes, and it takes an hour of someone's laptop per run | 3 days, plus a test laptop |
| 2 | It says "done" when it isn't, and single commands are never checked at all | 4–5 days |
| 3 | It acts in the wrong window, and acts when it should ask | 2–3 days |
| 4 | Apps break it in ways that repeat: typing before an app is ready, formatting without selecting, pressing a toggle twice, typing web addresses into pages | 5–6 days |
| 5 | Two known bugs in multi-step tasks: a confirmation mid-task drops the rest; the browser page is read once and goes stale | 2 days |
| 6 | Multi-step tasks are slow (about 20 s each) | 3–4 days |
| 7 | Single commands, what people say most, aren't measured | 2 days |
| 8 | We don't know whether it understands people with atypical speech, recorded or live | 1 week, once recordings exist |
| 9 | Starting up and recovering may need hands; no installer; speed on a low-spec laptop unknown | 4–5 days |
| 10 | What happens with no internet, or slow internet, is untested | 1–2 days |

**Total: 6–8 weeks**, not the 4–5 a straight sum gives. Every run so far has found a new kind of failure, and item 8 can't start until recordings exist.

---

### 1. A test we can trust

**What's wrong.**
- The test runs in your own Windows session, so the browser tasks change your open Chrome and Edge tabs.
- Notepad brings back tabs from earlier sessions.
- The checks are loose: "Brightness" also matches the System page.
- Every instruction is typed, not spoken.
- One run of 20 tasks moves by a task or two on its own, and each run takes 20 minutes of a laptop nobody can use meanwhile.
- All 20 tasks are in six apps. A fix that passes them may not hold elsewhere.

**Fix.**
1. **A dedicated test laptop** with its own Windows account, Chrome profile and extension, and Notepad set not to restore tabs. Runs are scheduled, not started by hand.
2. **Strict checks:** for example, the Display task checks the page title "Display"; the typing tasks check the document's text exactly.
3. **A spoken mode** that plays recorded clips instead of sending text.
4. **Three runs per version**, reporting the lowest, typical and highest result.
5. **Six tasks in apps not tested yet** (Excel, a PDF, Teams or Zoom, the file Save dialog, Paint, the Start menu), so fixes are checked as general rules, not as answers to the test.

**Fixed when:** a run touches nobody's own windows, three runs of the same version agree within one task, and the 26 tasks run on a schedule.

### 2. Saying "done" only when it's true — for every command

**What's wrong.**
- Multi-step tasks: 1 of 20 was reported done but wasn't in the last run, 2 of 20 the run before.
- **Single commands** (most of what people say) are never checked at all. The one-command loop says "done" as soon as a tool reports no error. A click that landed on nothing, or typing that went nowhere, is reported as success.
- Both judge from an AI reading a list of controls, with no ground truth.

**Already done (23 Oct):** a final check of the whole task; checker rules (selected isn't opened, "unsure" is said out loud); the document's text used to check typing.

**Fix.**
1. **Code checks first, AI second.** Where a result can be checked in code, check it in code: text typed → the document's text contains it; a website opened → the tab's address; an app opened → its window title; a control toggled or selected → its state; a tab closed → it's gone. The AI judgement is used only when no code check applies. (ARTEMIS does this with "verify" lines in its plans.)
2. **The one-command loop checks too.** After a desktop action, re-read the window (the screen fingerprint from 23 Oct) and run the same code checks. If nothing changed, say "I pressed Send, but nothing changed", never "done".
3. **Check in the task's own window**, noted when the task starts, not whichever window is in front. In the remaining false "done", the agent typed into a second Word document and the test read the first.
4. **Never "done" after a step failed** unless a later step recovered it.

**Fixed when:** no false "done" in three runs of the 26 tasks, and none in the single-command test (item 7).

### 3. Acting in the right place, and asking when unsure

**What's wrong.**
- In the test runs, AbleSpeak typed "Notepad" into Chrome's page and pressed Close on Word instead of Notepad. The window it meant was not the one in front.
- Several failures were confident actions on the wrong control ("Memory add" for "Add"). Partial names now return the closest name to the AI (23 Oct), but the person is never asked.

**Fix.**
1. **Before typing, sending keys or clicking**, check that the window in front is the one the step is about. If not, bring it forward. If that fails, stop and say so. Never type into another app.
2. **Ask when unsure.** When two controls match a name about equally ("Save" and "Save as"), or none matches well, ask: "Did you mean Save or Save as?" The Yes/No buttons on the voice bar become answer buttons for this.
3. **Closing** names what it will close in its question ("Close notes.txt in Notepad?") and never closes a different app.

**Fixed when:** a test task with Chrome and Word open and in front at the start passes with nothing typed into, or closed in, the wrong app; and ambiguous names in the single-command test produce a question, not an action.

### 4. General rules for acting in apps

**What's wrong.** The Chrome, Word and Settings tasks fail (0 of 3, 0 of 2, 2 of 3), but each failure is an instance of a rule the agent doesn't follow, and the same rules will fail in apps we haven't tested.

| Seen in | The general rule |
|---|---|
| Word: typing straight after it opened was lost | **Wait until the app takes input** before typing: an editable control has keyboard focus (up to about 8 s after opening). If nowhere can take text, fail with "there is nowhere to type" rather than type into nothing. |
| Word: Bold pressed without selecting, then pressed again | **Select before formatting** existing text. **Check a toggle's state** before pressing it; never press one already in the wanted state. |
| Word: a second document opened via File → New | **Never open a new document, window or tab unless asked.** |
| Chrome: addresses typed into the page; Edge: into the page's search box | **One "go to address" tool** that picks the method: the extension's `open_url` in Chrome, else the address bar (Ctrl+L, type, Enter) in any browser. Typing into a page is never used for an address. |
| Chrome: the page opened in a window that wasn't in front | **The extension brings its window to the front** after opening a page (`chrome.windows.update(windowId, { focused: true })`). |
| Settings: "Sound" reached System, not Sound | **Use a direct link where one exists** (`ms-settings:sound`, a file path, a URL), else the menus. |

**Fix.** Put the rules in the planner's and step-chooser's instructions, and in the tools themselves where a tool can enforce them (typing, toggles, go-to-address). Then check the rules against the six new tasks in untested apps (item 1), not only against the tasks that found them.

**Deferred:** Edge beyond the address-bar rule. The extension runs in Chrome, and full Edge support is low value for now.

**Fixed when:** the Chrome, Word and Settings tasks pass in two runs in a row, **and** the six new tasks pass, which shows the rules hold beyond the apps that found them.

### 5. Two known bugs in multi-step tasks

**What's wrong.**
- **A confirmation mid-task drops the rest.** When a step needs a "yes" (closing, deleting, sending), the one-command loop counts the held action as done and carries on, and after "yes" only that one action runs; the rest of the chain is lost.
- **The browser page goes stale.** The agent reads the browser's tabs and page once when the task starts and uses that for every step, so later steps click things on a page that has gone.

**Fix.**
1. A held action pauses the whole task; after "yes" the task continues from that step; after "no" it stops and says what was and wasn't done.
2. Re-read the browser page before every browser step, as the one-command loop already does after navigation.

**Fixed when:** a task "open Chrome, go to BBC, then close the tab" (with the close confirmed) passes, and a unit test covers each bug.

### 6. Speed of multi-step tasks

**What's wrong.** A task takes about 20 s (median). Each step is two AI calls (choose, check), plus the plan, the final check and the summary: a three-step task is about nine calls. Someone waiting 20–40 s for "open Notepad and type my name" stops using it.

**Fix.**
1. Skip the AI check when a code check applies (item 2); most steps then need one AI call.
2. Use the quick command matcher for steps it knows (already done) and the lighter model for checks and summaries.
3. Reuse the screen read between the check of one step and the choice of the next, instead of reading twice.
4. Measure every task in Developer › Speed, by step.

**Fixed when:** a three-step task finishes in under 10 s on the test laptop and under 15 s on the low-spec laptop (item 9), with no loss in the completion rate.

### 7. Measure single commands

**What's wrong.** People mostly give single commands ("open Word", "click Send", "scroll down", "read this"), and today's test measures only multi-step tasks.

**Fix.**
- A second test set of about 40 single commands: open and close apps, click by name, scroll, read this, type, volume, play and pause, go back, close the tab, plus ten ambiguous or unclear ones that should produce a question (item 3).
- Sent through the same path as spoken words, checked by the code checks from item 2.
- Report the **command match rate**: the share of commands that ran the right action.

**Fixed when:** at least 95% of typed commands do the right thing, the unclear ones ask, and any command that fails has a ticket.

### 8. Atypical speech, recorded and live

**What's wrong.** Every test so far uses typed words. Nobody has measured how well AbleSpeak hears people with quiet, slow or unclear speech, and they are who it is for. The streaming speech server has never been tried with a real microphone.

**Fix.**
1. Volunteers record the 40 commands from item 7; the recordings are played through the speech path, and the command match rate is measured for each person.
2. For each person, compare the on-computer model with the larger model on our server, then tune their settings (sensitivity, their own words, names) and measure again.
3. Repeat with classroom or office noise behind the voices.
4. **Live sessions:** each person uses AbleSpeak for 20 minutes with a real microphone through the live speech path, and the commands that were missed or did the wrong thing are counted.

**Fixed when:** each person reaches the agreed bar (proposal: at least 8 in 10 of their everyday commands), recorded and live. **This is the longest pole: it can't start until recordings exist, and collecting them is outside this plan.**

### 9. Works without hands, can be installed, and is quick on an ordinary laptop

**What's wrong.**
- Starting and recovering without hands hasn't been tested on a clean laptop.
- 134 files are uncommitted, and the last commit was 5 October, so no installer exists for the current version.
- All testing so far was on one fast laptop. Speed on a typical school or office machine is unknown, including whether the on-computer speech model keeps up.

**Fix.**
1. **Hands-free script:** restart the laptop, put it to sleep, drop the Wi-Fi and kill the app. Each time, AbleSpeak must come back listening, with the Chrome extension connected, without anyone touching the computer.
2. Commit in reviewed, themed commits, tag the version, and build the installer.
3. Install it on a clean Windows 10 and a clean Windows 11 laptop, following `INSTALL-FOR-TEACHERS.md` exactly, and fix whatever confuses or fails.
4. **A low-spec laptop** (4 GB RAM, an older processor): measure the time from the end of speaking to the action for the item 7 commands. Where it is too slow, use the server speech model instead of the on-computer one.

**Fixed when:** the hands-free script passes on both clean laptops, and common single commands act within 2 seconds of the person finishing speaking on the low-spec laptop.

### 10. No internet, or slow internet

**What's wrong.** Nobody has tested what happens when the internet drops or crawls. The AI, the server speech model and the browser extension's AI steps all need it.

**Fix.**
1. **With the network cut:** commands the computer can do alone must still work (open apps, click by name, scroll, dictation through the on-computer model). Everything else gets one clear spoken sentence ("I need the internet for that"), never silence and never a raw error.
2. **With a slow network:** a command still waiting after a few seconds says it is still working, and "stop" cancels it.
3. When the network comes back, AbleSpeak carries on without a restart.

**Fixed when:** the single-command test is run with the network cut and on a slow network, and every command either works or gives the clear sentence.

---

## Order of work

| Weeks | Work |
|---|---|
| 1 | 1 (the test, the test laptop, the six new tasks), 5 (the two bugs) |
| 2–3 | 2 (code checks; "done" only when true, for every command), 3 (right window, ask when unsure) |
| 4–5 | 4 (the general rules, checked against the new tasks), 6 (speed) |
| 6 | 7 (single commands), 10 (no or slow internet), 9 (hands-free, installer, low-spec laptop) |
| 7–8 | 8 (atypical speech, once recordings exist); three full runs of everything |

Items 2 and 3 come before 4 because they are where a wrong action turns into a silent wrong result; the app rules in 4 then have something honest to be measured against.

## What "fixed" means, all together (the with-a-helper bar)

- [ ] At least 16 of 26 tasks finish and say so, in each of three scheduled runs
- [ ] No false "done" in three runs of tasks or of single commands
- [ ] The six new tasks in untested apps pass, so the rules are general
- [ ] Nothing is typed into, or closed in, the wrong app; unclear names produce a question
- [ ] A three-step task finishes in under 10 s
- [ ] At least 95% of single commands do the right thing
- [ ] Each person's commands meet the agreed bar, recorded and live
- [ ] The hands-free script passes on clean laptops; common commands act within 2 s on a low-spec one
- [ ] With no internet or slow internet, every command works or gives a clear sentence
