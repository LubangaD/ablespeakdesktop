# AbleSpeak Full Computer Control — End-to-End Test Script

*For testers of the AbleSpeak Tier 2 Windows app. It walks through a whole day, from switching the laptop on to signing out. It is written twice over: once as a **student** and once as **someone at work**. Written 17 October 2026, against the code on `main` (uncommitted work included).*

AbleSpeak's promise is that a person who cannot use a keyboard or mouse can run a whole Windows computer by voice. This script checks that promise the way a real user would meet it: through ordinary tasks, in ordinary rooms, with no hands.

---

## Contents

0. [How to use this script](#0-how-to-use-this-script)
1. [The two people we are testing as](#1-the-two-people-we-are-testing-as)
2. [Before testing: setup](#2-before-testing-setup)
3. [Part A — Morning: switching on and getting in](#part-a--morning-switching-on-and-getting-in)
4. [Part B — The voice toolkit, command by command](#part-b--the-voice-toolkit-command-by-command)
5. [Part C — A school day (Amina)](#part-c--a-school-day-amina)
6. [Part D — A working day (Brian)](#part-d--a-working-day-brian)
7. [Part E — Exams](#part-e--exams)
8. [Part F — Being heard in real rooms](#part-f--being-heard-in-real-rooms)
9. [Part G — When things go wrong](#part-g--when-things-go-wrong)
10. [Part H — The helper and admin side](#part-h--the-helper-and-admin-side)
11. [Part I — End of the day](#part-i--end-of-the-day)
12. [Recording results](#recording-results)
13. [Watch-for list: likely bugs found by reading the code](#watch-for-list-likely-bugs-found-by-reading-the-code)
14. [Known limits: not bugs today](#known-limits-not-bugs-today)
15. [Appendix — phrase rules, timings and file locations](#appendix--phrase-rules-timings-and-file-locations)

---

## 0. How to use this script

### Who is in the room

| Role | Does |
|---|---|
| **Speaker** | Plays the person (Amina or Brian). Speaks every command. **Keeps hands off the keyboard and mouse** from Part A step ST-07 onwards, unless a row says "helper". |
| **Recorder** | Watches the voice bar and the screen, times each command, and fills in the results sheet. Never helps the speaker unless something is stuck; when they do, it is logged as an **Assist**. |
| **Helper** (optional, can be the recorder) | Does the setup in section 2 and the helper rows (sign-in, PINs, exam setup). These rows are allowed hands. |

**The hands-off rule is the test.** If the recorder has to touch the computer to get the speaker out of a problem, write **Assist** and say what was done. A run with no assists is the goal; every assist is a gap in the product.

### Result codes

| Code | Meaning |
|---|---|
| **P** | Pass — did the right thing the first time. |
| **R***n* | Pass after *n* retries (e.g. R2). Say what changed on the retry (louder, different words). |
| **F** | Fail — nothing happened, or an honest failure message where success was expected. |
| **W** | **Wrong action** — AbleSpeak did something the speaker didn't ask for. Always a bug, and the most serious kind. |
| **A** | Assist — a human had to touch the computer. |
| **B** | Blocked — the test could not be run (say why). |
| **K** | Known limit — matches [Known limits](#known-limits-not-bugs-today). |

For questions and AI-handled commands, an **honest "I can't"** is better than a wrong answer: score a correct result **P**, an honest refusal **F**, and a made-up or wrong answer **W**.

### What to write down for every row

- **What was said**, word for word (the speaker may change the wording; write what was really said).
- **What the bar showed** after "Heard: …" (see ST-09: the bar must be expanded to show it).
- **What happened** on screen, and **what AbleSpeak said** out loud.
- **Time** from the end of the speaker's sentence to the action: under 1 s, 1–3 s, 3–6 s, or over 6 s. A phone stopwatch is enough.

### Severity for bugs

| Severity | Meaning | Examples |
|---|---|---|
| **S1 — Unsafe** | Data lost or something sent or deleted without a "yes"; acting on someone else's voice in a way that does harm; the speaker is locked out with no spoken way back. | A window closes after "cancel"; an email goes without a question. |
| **S2 — Blocks the task** | No spoken way to finish the task; needs an assist. | Can't get past a dialog by voice. |
| **S3 — Works with effort** | Needs retries, odd wording, or a workaround. | Must say "scroll down" three times. |
| **S4 — Polish** | Wording, timing, display. | Says "Done: create_tab". |

### ⚠ Watch-for notes

Rows marked **⚠ Watch** come from reading the code (17 Oct 2026). They have **not** been confirmed on a real machine. For each one, record what really happens: **Confirmed** (the problem is real) or **Not seen**. The full list is in [Watch-for list](#watch-for-list-likely-bugs-found-by-reading-the-code).

### Evidence

- Record the screen and room sound together with **Win+G** (Xbox Game Bar), so the recording shows the voice and the result at the same time. Name the file with the date, tester and persona.
- Keep the app log. From source, it is the terminal running `npm run desktop`. On an installed build, open **Developer Hub → Logs** (admin) *before* the run starts, because it only shows lines while it is open.
- At the end of a run, export **Home → Recent commands → Export** (JSON) and attach it to the results.

---

## 1. The two people we are testing as

Speak as yourself: your own voice and accent are part of the test. The personas decide *what* you do, not how you sound. If a tester has a speech or motor impairment and agrees to it, that is the most valuable test of all; note it in the session header.

### Persona A — Amina, a student

> I'm Amina, 16, in Form 3. I have cerebral palsy, which affects both my hands, so I can't type or use a mouse. My speech is clear but slow, and on a tired day it is soft. I use AbleSpeak in the school computer lab, which is shared and noisy, and on my own laptop at home.
>
> Today I need to research photosynthesis for biology, write my essay in Word, put my group's marks into Excel, make two slides, watch a YouTube lesson, and sit a mock biology exam. I like music while I work. When something goes wrong, I can't grab the mouse to fix it: I need to be able to stop it, undo it, or say what I meant.

### Persona B — Brian, a programme officer at work

> I'm Brian, 32, a programme officer at an NGO. A spinal cord injury (C6) left me with very little hand function. My speech is normal. I work in an open-plan office with colleagues talking and phones ringing, on my own work laptop.
>
> Today I need to read and answer email, write a letter to a donor in Word, update the budget in Excel, find files on my computer, fill in a form on a website, change some Windows settings, and keep my screen private when someone walks past. I can't afford for AbleSpeak to send an email or delete a file I didn't mean to.

---

## 2. Before testing: setup

The helper does this with hands. Tick each item.

### 2.1 The build

- [ ] Write down which build is being tested: **from source** (`git log -1` on `main`, plus "uncommitted changes" if any) or an **installer** (file name and date).
- [ ] ⚠ The installer in `server/dist-electron/` is dated **17 September 2026**. It is older than sign-in, exams and the new voice bar. To test those, either run from source (`cd server && npm run desktop`) or rebuild the installer first (`cd dashboard && npm run build`, then `cd server && npm run build:win`).
- [ ] The offline speech pack (speech recognition on the computer) is **not** in the installer. On an installed build, "This computer only" will not work. Note which speech engine is available.

### 2.2 The computer

- [ ] Windows 10 or 11 laptop, plugged in. Write down the model and Windows version.
- [ ] A **headset microphone**, plus the laptop's own microphone for Part F.
- [ ] Internet that can be switched off on demand (Wi-Fi toggle) for the offline tests.
- [ ] Windows **Settings → Privacy & security → Microphone**: allowed for desktop apps.
- [ ] Notifications off (Do not disturb), and Windows Voice Access and any other voice tool closed.
- [ ] Installed: **Google Chrome**, **Word**, **Excel**, **PowerPoint**, **Notepad**, **Calculator**, **Spotify** (desktop app, signed in), **Outlook** or Gmail in Chrome, **Microsoft Teams** (optional), **Microsoft Edge**.

### 2.3 Chrome and the AbleSpeak extension

- [ ] In Chrome, go to `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the extension folder (tray icon → **Show Chrome Extension Folder**). It is called **AbleSpeak Browser Integration**.
- [ ] **Click the extension's icon once** in Chrome's toolbar. A freshly loaded extension is **off** until it is clicked. The icon changes from the "disabled" picture to "connecting" and then "active".
- [ ] AbleSpeak's Home page shows **Chrome extension: Connected · <tab title>**.
- [ ] After any change to the extension's files, reload it in `chrome://extensions`.

### 2.4 Test files and accounts

Make a folder **Documents\AbleSpeak Test** containing:

| File | Contents |
|---|---|
| `Biology essay.docx` | A heading and three paragraphs. Include the deliberate mistakes **"recieve"** and **"enviroment"**. |
| `Group marks.xlsx` | Names in column A, marks in column B (rows 2–6), and `=SUM(B2:B6)` in B7. |
| `Budget 2026.xlsx` | A small budget table with a total formula. |
| `Letter to donor.docx` | Empty. |
| `Delete me.txt` | Any text. Used for the delete test. |
| `Report.pdf` | Any PDF. |

- [ ] An email in the inbox **from "John"** (send one from another account), with a short message.
- [ ] A **test email address you own**, for the send test. **Only ever send to yourself.**
- [ ] A **Spotify playlist** with songs that have lyrics, ideally one with "stop" or "don't stop" in the words.
- [ ] A **mock exam paper** (.docx) with numbered questions: two multiple choice (A–D), one short answer, one longer answer, and one maths question. Time allowed: 10 minutes. Save a second copy to use with a 2-minute limit.
- [ ] A safe web form for form tests: **https://httpbin.org/forms/post** (a pizza order form that sends nothing anywhere real).

### 2.5 AbleSpeak settings

- [ ] **Gemini key**: tray icon → **Set admin PIN…** first (choose a 4–8 digit PIN), then **Settings → API keys**, paste the key, **Save key**. Expected: "Saved. Google Gemini accepted the key."
- [ ] **Voice & words** for the test user:
  - Listening profile: **Standard**. Pause that ends a command: **1.5 s**. "Say “AbleSpeak” first": **off**. Where speech is recognised: **Real time (recommended)**.
  - Your own words: `Kisumu`, `photosynthesis`, `osmosis`, `Mombasa`, the speaker's own name.
  - Shortcut: `my music` → `open spotify`.
  - Routine **start my homework**: `open word` / `open chrome` / `search youtube for photosynthesis`.
  - Routine **start my day**: `open outlook` / `open excel` / `open chrome`.
  - Press **Save speech settings**.
- [ ] Note the settings in the session header (section 12).

---

## Part A — Morning: switching on and getting in

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| ST-01 | Switch the laptop on and sign in to Windows. | **Installed build:** AbleSpeak starts by itself and its icon appears near the clock. **From source:** run `npm run desktop`. The dashboard window **"AbleSpeak — Voice Command Center"** opens within about 5 s. | |
| ST-02 | Look at the screen. | If sign-in is set up and nobody is signed in, the dashboard opens on **Sign in** and the **voice bar is not shown yet**. If sign-in isn't set up, the page says "Sign-in isn’t set up on this computer yet. You can keep using AbleSpeak here." and the voice bar appears. | |
| ST-03 | **Speaker, hands off:** try to get past Sign in using only your voice. | Record whether it is possible. Expected today: **not possible**, because the voice bar waits for sign-in or "Not now". A helper must click. ⚠ Accessibility gap: log it as **A** with severity S2, then carry on. | |
| ST-04 | **Helper:** type an email address, press **Email me a code**, then type the 6-digit code from the email. | "We sent a code to … It can take a minute to arrive." Then "You’re signed in" with the email. The voice bar appears within about 2–5 s. *Note:* the built-in email only reaches project team members, a few messages an hour. | |
| ST-05 | **Helper:** try a wrong code, then an email without "@". | "That code didn’t work, or it has expired. Check it, or ask for a new one." / "That doesn’t look like an email address. Check it and try again." | |
| ST-06 | **Helper** (optional): **Sign in with Google**, then on a second try press Cancel. | The browser opens; after signing in the tab says **"You’re signed in"** and AbleSpeak comes to the front. Cancel: "Google sign-in was cancelled, so nobody was signed in." | |
| ST-07 | **Helper** (alternative to ST-04): **Not now — keep using this computer only**. | The voice bar appears and starts listening. Sign in shows again at the next start. **From here on, the speaker's hands stay off.** | |
| ST-08 | Find the voice bar. | A small round microphone, bottom centre just above the taskbar (or wherever it was left last time). **Green and gently pulsing** = Listening. | |
| ST-09 | **Recorder:** click the small arrow (**Show more**) on the bar once. | The bar opens into a card: "<Name>'s session", a mode word, "Heard: …" and the result. It stays open, even after restarts. **Keep it open for the whole run**: the compact bar hides "Heard" and "Ignored". | |
| ST-10 | Say **"Who am I?"** | Spoken: **"This is <Name>'s session."** The name comes from the Windows account ("amina.k" → "Amina K"). ⚠ Watch: with nobody chosen it says "…on the Teacher page", but that page is now called **Users**. | |
| ST-11 | Look at **Home** (recorder). | "Hi, <first name>"; **What can I do?** tiles; **Chrome extension: Connected**; **System status: All working**. | |
| ST-12 | Open a long web page in Chrome (helper may do this once), then say **"Scroll down"**. | The page scrolls. With the real-time engine, under about 1 s after you finish speaking; online only, about 3 s. | |

---

## Part B — The voice toolkit, command by command

Run Part B once in a quiet room, with the headset. It checks each control on its own, so that Parts C and D can test real work.

### B1 — The voice bar itself

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| VB-01 | **Recorder:** click the mic. Speaker says "scroll down". Click the mic again. | Mic off: grey, **"Mic off"**, "Click the mic to start", and nothing happens to "scroll down". Clicked again: green, listening. | |
| VB-02 | **Recorder:** press **Ctrl+Shift+A** twice. | First press hides the bar; second shows it and it listens again. ⚠ Watch: hiding with the shortcut also turns the mic off, so the speaker **cannot** bring it back by voice. Try "come back" while it is hidden this way and record. | |
| VB-03 | **Recorder:** drag the bar by its grip to the right edge, then restart AbleSpeak (tray → Quit, then start it). | It snaps to the edge when dropped close to it, and comes back in the same place after the restart. | |
| VB-04 | Ask **"Explain photosynthesis"**. While it speaks, the recorder clicks the **red square** on the bar. | The speech stops at once and the bar shows **"Stopped"**. The mic stays on. | |
| VB-05 | Ask the same question; while it speaks, press **Ctrl+Shift+A**. | ⚠ Watch: the speech may carry on while the bar hides and the mic goes off. Record. | |
| VB-06 | Say **"Scroll down"** five times in a row, with a few seconds between. Then stay silent for 2 minutes and say it again. | Every one works. The bar never gets stuck showing "Listening" while not hearing ("never deaf"). | |
| VB-07 | Say something meaningless, such as **"Purple elephant sideways"**. | An honest spoken reply (it didn't understand, or it can't do it). Nothing happens on screen. **W** if it acts. | |

### B2 — Stop, sleep, wake, hide, privacy

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| CT-01 | **"Go to sleep"** | Spoken: "Going to sleep. Say wake up when you need me." The bar turns into a grey moon: **Asleep**. | |
| CT-02 | While asleep: **"Open Notepad"**, **"Scroll down"**, and talk normally for 30 s. | Nothing happens and nothing is shown. | |
| CT-03 | While asleep: **"I need to wake up early tomorrow"**. | Stays asleep (a wake word inside a sentence doesn't count). | |
| CT-04 | **"Wake up"**. Repeat the sleep/wake cycle with **"I'm back"** and with just **"AbleSpeak"**. | "I'm listening." The bar is green again. | |
| CT-05 | **"Sleep"** (one word). | Asleep, as CT-01. Wake it again. | |
| CT-06 | **"Stop listening"**, then **"Pause listening"**, then **"Hush"**. | The guide says each of these puts AbleSpeak to sleep. ⚠ Watch: the emergency media pause catches short phrases with "stop", "pause" or "hush" first. Expect "**Nothing is playing.**" and AbleSpeak staying awake. Record which happens for each. | |
| CT-07 | **"Hide"**. Then, separately, **"Go away"**, **"Dismiss"** and **"Close"**. | Spoken: "Okay. Say AbleSpeak, or come back, any time." The bar disappears, **but it still listens**. | |
| CT-08 | While hidden: **"Come back"** (and on another try, **"AbleSpeak"**). | "I'm here." The bar comes back. | |
| CT-09 | **"Privacy mode"** | Expected: spoken "Privacy mode on. I have stopped looking at your screen, but I am still listening." The dashboard's top bar shows **Privacy mode**. ⚠ Watch: the voice bar has no handler for this message. It may say nothing and show "Working…" for up to 60 s. Record what is heard and shown. | |
| CT-10 | In privacy mode: **"Open Notepad"**, **"Volume down"**, then **"Click the File menu"** (in Notepad). | Commands that don't need to see the screen still work. Ones that need to see it may fail honestly; that is a pass here. | |
| CT-11 | **"Vision on"** (also try **"Privacy off"**). | Expected: "Privacy mode off. I can see the screen again." ⚠ Same watch as CT-09. | |
| CT-12 | **"Stop watching"**, **"Stop looking"**. | Should turn privacy on. ⚠ Watch: these contain "stop", so the media pause may catch them first ("Nothing is playing."). | |
| CT-13 | Ask **"Tell me about the history of Kenya"**. (a) While the bar shows **Working…**, say **"Cancel"**. (b) Ask again, and while it is **speaking**, say **"Cancel"**. Repeat both with **"Never mind"** and **"Stop"**. | A person with no hands needs a spoken way to cut off a long answer: the answer should stop and the bar show **"Stopped"**. ⚠ Watch: the mic is muted while AbleSpeak speaks, and a new phrase while it is working may get "Still working…", so voice may not be able to stop it at all (only the red square, VB-04). "Stop" may also say "Nothing is playing." Record (a) and (b) separately. | |
| CT-14 | Just **"AbleSpeak"**, then within 8 s **"open Calculator"**. | "Yes?" Then Calculator opens. | |

### B3 — Opening and switching apps

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| AP-01 | **"Open Notepad"** | Notepad opens; a short spoken confirmation such as "Opened notepad". | |
| AP-02 | **"Open Word"** | Word opens on a **blank document**, not its Start screen. | |
| AP-03 | **"Open Excel"** | A **blank workbook**, not the Start screen. (The log shows "[Office] Excel Start screen turned off" or "already off" at start-up.) | |
| AP-04 | **"Open PowerPoint"** | A **blank presentation**. | |
| AP-05 | **"Open Calculator"**, **"Open Paint"**, **"Open File Explorer"**, **"Open Task Manager"**, **"Open Spotify"**, **"Open Outlook"**, **"Open Teams"**, **"Open the snipping tool"** | Each one opens. | |
| AP-06 | **"Open my spreadsheet"**, **"Open my Word document"**, **"Launch the calculator"** | Excel, Word and Calculator open (everyday names work). | |
| AP-07 | **"Open settings"** | Windows Settings opens (through the AI, so a little slower). | |
| AP-08 | Close Chrome (helper), then say **"Open Chrome"**. | Users expect Chrome to open. ⚠ Watch: "open Chrome/Edge/Firefox" only brings an **already open** browser forward. Expect "I couldn't find an open window called “Chrome”." Also try **"Open the browser"** (it means Brave). Record. Open Chrome again afterwards (helper) for later tests. | |
| AP-09 | With Word, Chrome and Spotify open: **"Switch to Word"**, **"Go to Word"**, **"Bring Chrome to the front"**, **"Focus on Spotify"**, **"Bring up Notepad"** | Each app comes to the front. | |
| AP-10 | With `Biology essay.docx` open: **"Bring my essay to the front"** | The essay's Word window comes forward (found by its title). | |
| AP-11 | **"Switch to PowerPoint"** when PowerPoint is closed. | "PowerPoint isn't open. Say “open PowerPoint” to start it." | |
| AP-12 | **"What apps are open?"** | A spoken list of the open apps. | |
| AP-13 | **"Show me cats"** | Should search for or show cats, or say it can't. ⚠ Watch: it may be taken as "switch to a window called 'me cats'" and fail. | |

### B4 — Windows

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| WN-01 | With Notepad in front: **"Minimise this window"**, **"Switch to Notepad"**, **"Maximise"**, **"Restore"**, **"Snap left"**, **"Snap right"**, **"Full screen"** | Each acts on **Notepad**, never on AbleSpeak, and quietly. | |
| WN-02 | Type a line in Notepad (see DI-13), then **"Close Notepad"**. Answer **"No"**. | Spoken: "Close this window? Any unsaved work could be lost. Say “yes” to confirm, or anything else to cancel." The bar shows **Please confirm** with **Yes / No** buttons. After "No": "Okay, cancelled." Notepad stays. | |
| WN-03 | **"Close Notepad"** again, answer **"Yes"**. Notepad then asks whether to save: say **"Click Don't save"**. | Notepad closes after "yes", then the save dialog is handled by voice. | |
| WN-04 | With a window open: **"Quit"**, then on another try **"Close the window"**. | The same "Close this window?" question (Alt+F4). Answer "no". | |
| WN-05 | **"Close Chrome"** | AbleSpeak refuses to close the browser. It should suggest closing a tab instead, in plain words. ⚠ Watch: it may ask "Close this window?" first and only then refuse. | |

### B5 — The web in Chrome

Start on a long Wikipedia article in Chrome, with Chrome in front.

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| BR-01 | **"Scroll down"**, **"Scroll up"**, **"Scroll down three"**, **"Scroll down again"**, **"Scroll up a bit more"**, **"Page down"**, **"Page up"** | Each scrolls the right amount: one step, three steps, one more, and a full page for page down/up. | |
| BR-02 | **"Go to the bottom"**, then **"Scroll down"**, then **"Go to the top"** | Jumps to the end; at the end, "The page is already at the bottom."; jumps to the start. | |
| BR-03 | **"Search for photosynthesis"** | Google results for photosynthesis. | |
| BR-04 | On Wikipedia: **"Search for osmosis"** | Uses **Wikipedia's own** search box. | |
| BR-05 | **"Search YouTube for photosynthesis"** | YouTube results. | |
| BR-06 | On Google results: **"Open the Wikipedia link"**, then **"Go back"**, then **"Open the first result"** | Spoken: "Opening <page> on <site>." **Never** a web address. | |
| BR-07 | **"Go back"**, **"Go forward"**, **"Reload"** | History back and forward; the page reloads. | |
| BR-08 | **"New tab"** | A blank tab opens. ⚠ Watch: the spoken reply may be "**Done: create_tab**" (S4). | |
| BR-09 | **"Go to the BBC website"** (or "Open YouTube") | It opens in the **current** tab. | |
| BR-10 | Open three tabs (one of them YouTube, not the active one), then **"Which tabs are open?"**, then **"Switch to the YouTube tab"**, then **"Go to the YouTube tab"** | A spoken list; the YouTube tab becomes active. ⚠ Watch: "switch to … tab" is caught as "switch to an app called YouTube" and likely fails with "I couldn't find an open window called…". "Go to the YouTube tab" goes to the AI and should work. Record both. | |
| BR-11 | **"Close this tab"** | Closes the tab **without asking** (a tab can be reopened). | |
| BR-12 | **"Zoom in to 150 percent"**, then **"Make the page smaller"** | The page zoom changes. | |
| BR-13 | **"Duplicate this tab"**, **"Pin this tab"**, then **"Unpin this tab"** | Duplicate and pin work. ⚠ Watch: there is no way to unpin. Expect a failure or the wrong action. | |
| BR-14 | On a page with a search box: **"Next"**, **"Next"**, **"Previous"**, **"Clear the search bar"** | Focus moves between fields and buttons; the search box empties. | |
| BR-15 | **"Take a screenshot of this page"** | ⚠ Watch: the picture goes nowhere (not saved, not looked at). Record what the speaker hears. Known limit if nothing useful happens. | |
| BR-16 | **Switch to Word** (essay open), then say **"Scroll down"**, **"Enter"**, **"Escape"**, **"Space"**, **"Tab"**. | The user expects Word to scroll or get the key. ⚠ Watch: these quick commands always go to **Chrome** and bring Chrome to the front. Record (likely **W**, S3). Then try **"Scroll down in Word"** and **"Press enter in Word"**, which go through the AI and should act on Word. | |

### B6 — Clicking anything

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| CL-01 | On a page with a unique button (e.g. Wikipedia's **Log in**): **"Click Log in"** | It clicks that button. | |
| CL-02 | On a page with several links of the same name (e.g. many "edit" links on Wikipedia): **"Click edit"** | It should ask which one, or pick the sensible one. **W** if it clicks something unrelated. | |
| CL-03 | In Word: **"Click Bold"**, **"Select the Insert tab"**, **"Open the File menu"**, then **"Press escape in Word"** | Each control is pressed, selected or opened directly, without guessing a position; Escape closes the File menu. (A plain "Escape" goes to Chrome, see BR-16.) | |
| CL-04 | In Spotify: **"Click play"** | Spotify plays. | |
| CL-05 | In File Explorer (Documents\AbleSpeak Test): **"Open the file Biology essay"** | The file opens in Word (double-click by name). | |
| CL-06 | In File Explorer: **"Right-click Report"** | The right-click menu for Report.pdf opens. | |
| CL-07 | **"Click the purple elephant"** | "I couldn't find that on the screen. Try saying the words you can see on it." | |
| CL-08 | On httpbin's form: **"Choose Large"**, **"Check bacon"**, **"Check bacon"** again | Large is selected; Bacon is ticked. ⚠ Watch: the second "check bacon" **unticks** it (check works as a toggle). Also try **"Choose purple"** (no such option) and record whether anything is said. | |

### B7 — Keys and editing (outside dictation)

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| KY-01 | Notepad with two lines of text: **"Select all"**, **"Copy"**, **"Open Word"**, **"Paste"** | The Notepad text appears in Word. | |
| KY-02 | In Word: **"Undo"**, **"Redo"** | The paste is undone, then redone. (The spoken reply to "Undo" is "Okay, I undid that.") | |
| KY-03 | In Word: **"Select all"**, **"Cut"**, then **"Paste"** | Text is cut and pasted back. | |
| KY-04 | In Word: **"Save"** | Word's Save As dialog appears (new document). Say **"Press escape in Word"** to leave it. | |
| KY-05 | **"Press control S"**, **"Press F1"** (through the AI) | The keys reach the app in front. | |

### B8 — Music, video and volume

Play a song in Spotify for MV-01 to MV-08.

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| MV-01 | **"Pause"** | "Paused Spotify." | |
| MV-02 | **"Resume Spotify"** (or **"Play the current song on Spotify"**) | Spotify plays again, without typing a space into Spotify's search box. | |
| MV-03 | **"Next song"**, **"Skip"**, **"Previous song"** | The track changes. | |
| MV-04 | With Spotify **and** a YouTube video playing: **"Pause Spotify"** | ⚠ Watch: it pauses **everything** that plays, not only Spotify. Record. | |
| MV-05 | Spotify playing: **"Play"** (one word) | ⚠ Watch: a bare "play" toggles the **browser** video, not Spotify. Record. | |
| MV-06 | **"Volume up"**, **"Louder"**, **"Volume down"**, **"Turn it down"**, **"Set the volume to fifty"**, **"Volume 30 percent"** | The Windows volume changes each time; "fifty" lands at about 50%. | |
| MV-07 | **"Quieter"** | Should turn the volume down. ⚠ Watch: "quieter" starts with "quiet", which is a stop word, so it may be taken as **cancel**. | |
| MV-08 | Sound on: **"Mute"**. Then, with sound **on**, **"Unmute"**. | Expected: mute, then sound stays on. ⚠ Watch: spoken "mute" pauses the music instead of muting; "unmute" presses the same toggle key, so it can **mute**. Record both. | |
| MV-09 | **Music gate.** Spotify playing (with lyrics). Say **"Scroll down"** without the name. | Ignored; the expanded bar shows "**Music is playing — start with “AbleSpeak”**". | |
| MV-10 | Music playing: **"AbleSpeak, scroll down"** | Chrome scrolls. | |
| MV-11 | Music playing: **"Pause"** and **"Next song"** without the name | Both work (media commands pass the gate). | |
| MV-12 | Leave a song with lyrics playing for 5 minutes, near the mic, without speaking. | **Nothing happens.** Count any action taken from the lyrics (each one is **W**). ⚠ Watch: a short lyric line with "stop", "pause" or "quiet" may pause the song by itself. | |
| MV-13 | On a YouTube video: **"Pause the video"**, **"Play"**, **"Skip ahead 30 seconds"**, **"Set the video speed to 1.5"**, **"Video volume 50"** | Each works on the video. If YouTube refuses to start playing: "The video wouldn't start. Try “click play”." | |
| MV-14 | **"Play Finale by Bien"** (no app named) | A YouTube search, then that video opens and plays. | |
| MV-15 | **"Play Sunflower on Spotify"** | Spotify finds and plays the song (through the AI). Record how many steps it took. | |

### B9 — Reading the screen and asking questions

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| RD-01 | On a Wikipedia article: **"Read this page"**, then **"Summarise this page"** | A spoken summary in 2–4 sentences about the right article. | |
| RD-02 | In Word (essay): **"Read this paragraph"**, **"Read the whole document"**, then select a sentence and **"Read what I selected"** | Reads the right text from Word, not from the browser. | |
| RD-03 | Windows Settings in front: **"What's on my screen?"** | Describes the window from its buttons and text. | |
| RD-04 | With Word's Save As dialog open: **"What does this dialog say?"** | Reads the dialog. | |
| RD-05 | **"What is the capital of Kenya?"**, **"Explain osmosis"** | Answers out loud in a few sentences **without** opening a search page. | |
| RD-06 | **"What's the weather in Nairobi today?"** | Searches the web and **says** the answer (not just a results page). | |
| RD-07 | **"What time is it?"** | The correct time. | |
| RD-08 | Excel, `Group marks.xlsx`, with **B7** selected: **"What's the formula in this cell?"** | "=SUM(B2:B6)" or the same in words. Then **"What is in cell B4?"** without selecting it: the right value, or an honest "I can't". **W** if it gives a wrong number. | |
| RD-09 | Word, cursor on "recieve": **"What are the suggestions?"**, then **"Use the second suggestion"**, then undo, then **"Fix that spelling"** | Lists the suggestions; "Changed “recieve” to “receive”." | |
| RD-10 | Word, anywhere: **"Fix the spelling of enviroment"** | Changed to "environment". | |
| RD-11 | Word in front: **"Set the zoom to 150 percent"** | **Word's** zoom changes to about 150%, not the browser's. | |

### B10 — Typing by voice

Use Notepad first, then Word, then a web text box.

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| DI-01 | Notepad in front: **"Start dictation"** | "Dictation mode on. Typing into <the Notepad window>." The bar turns amber: **Dictating…** | |
| DI-02 | **"My name is Amina comma and I live in Kisumu full stop"** | Typed: "My name is Amina, and I live in Kisumu." with capitals and the full stop. | |
| DI-03 | Say three sentences quickly, one after another, without waiting. | All three are typed, **in order**, nothing lost. | |
| DI-04 | **"New line"**, **"New paragraph"**, a sentence ending **"question mark"**, **"open quote"** … **"close quote"**, **"open parenthesis"** … **"close parenthesis"** | Each becomes the right character or break. | |
| DI-05 | **"Delete word"**, **"Backspace"**, **"Undo that"**, **"Redo"**, **"Select all"**, **"Next line"**, **"End of document"**, **"Start of document"** | Each edits or moves; nothing is typed as words. | |
| DI-06 | **"AbleSpeak, open Calculator"**, then **"AbleSpeak is great"** | Calculator opens and dictation stays on; "AbleSpeak is great" is **typed**. | |
| DI-07 | **"Stop dictation"** (another time: **"Command mode"**) | "Dictation mode off. Back to commands." | |
| DI-08 | Dictation on, then **"Stop typing"**, **"Finish dictation"**, **"Turn off dictation"**, **"I'm done dictating"** | A user expects each to end dictation. ⚠ Watch: only "stop dictation", "end dictation", "exit dictation" and "command mode" work while dictating; the others are likely **typed**. Record each. | |
| DI-09 | Dictation on, dictate the single words **"Sleep."**, then (after waking) **"Hide."** | Expected: typed. ⚠ Watch: AbleSpeak may go to sleep or hide instead. | |
| DI-10 | Dictation on: **"AbleSpeak, volume up"**, **"AbleSpeak, new tab"** | Expected: the commands run. ⚠ Watch: only certain first words count after the name ("open", "scroll", "click"…), so these may be **typed**. | |
| DI-11 | Dictation off: **"Dictate, my name is Amina"**, then later **"I love biology. Dictate."** | Dictation starts and the words are typed at once in both cases. | |
| DI-12 | In **Word**: start dictation, dictate a paragraph, **"Bold"**, **"Italic"**, **"Underline"**, **"Next paragraph"** | Typed at the cursor in Word; formatting toggles. | |
| DI-13 | Dictation off, Notepad in front: **"Type this"**, then **"Hello world"** | "What should I type? Say the words next." Then "Hello world" is typed once, and dictation stays off. | |
| DI-14 | **Clipboard check:** copy a word first, dictate a sentence in Notepad, stop dictation, then **"Paste"** | The originally copied word is pasted (dictation puts the clipboard back). | |
| DI-15 | In Chrome, put the cursor in Google's search box (**"Click the search box"**), then **"Start dictation"**, **"climate change in Kenya"**, **"Stop dictation"**, **"Enter"** | The words land in the search box and the search runs. ⚠ Watch: AbleSpeak's "Enter" in a web page is a simulated key, which pages often ignore; the search may not run. If not, try **"Click Google Search"**. Record. | |
| DI-16 | Dictate **"Visit google dot com"** and **"The Victorian period"** | ⚠ Watch: punctuation words are replaced anywhere: "google. com" and "Victorian." Record. | |
| DI-17 | Dictate **"I'll be right back"** | ⚠ Watch: this phrase is on the noise filter's list and may be dropped. | |
| DI-18 | Two Word documents open; dictate into the second. | ⚠ Watch (known limit): the text may land in the other Word window. | |
| DI-19 | Dictation off, Notepad in front: **"Type this hello world"** in one breath, with no pause. | Expected: "hello world" typed once. ⚠ Watch: speech has no colon, so this probably **turns dictation on** and types the words; dictation then stays on. Record, and say "stop dictation" if needed. | |

### B11 — Questions before risky actions, undo, and "I meant"

Only use test files and your own email address here.

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| SF-01 | **"Close Notepad"** → **"Yes"** | Closes (see WN-02/03). | |
| SF-02 | **"Close Notepad"** → silence for 30 s → **"Open Calculator"** | The question is cancelled ("Okay, cancelled."); Notepad stays. | |
| SF-03 | **"Close Notepad"** → the recorder presses **No** on the bar | Same as saying "no". | |
| SF-04 | Laptop speakers (no headset): **"Close Notepad"** and let the question be read aloud. | AbleSpeak does **not** take its own question as the answer; it waits for the speaker. | |
| SF-05 | ⚠ **S1 candidate.** Notepad open with throw-away text: **"Close Notepad"** → **"Cancel"** → then **"Okay, open Calculator"**. | Expected: "Cancel" cancels, and Notepad stays open. ⚠ Watch: "cancel", "abort" or "never mind" may stop speech but leave the question waiting; the next phrase starting with "okay" or "yes" would then **close the window**. Record exactly. | |
| SF-06 | Same as SF-05 but answer **"No, stop"**. | ⚠ Watch: may go to the media pause and leave the question waiting. | |
| SF-07 | In File Explorer, select `Delete me.txt` and say **"Click Delete"**. Answer **"No"**, then repeat and answer **"Yes"**. | "Delete this? This may not be reversible. Say “yes”…" No: kept. Yes: goes to the Recycle Bin. | |
| SF-08 | Restore the file (helper), select it, and say **"Press the delete key"**. | ⚠ Watch: the plain Delete key is **not** asked about (the file goes to the Recycle Bin without a question). Record whether a question was asked. | |
| SF-09 | httpbin form: fill in, then **"Click Submit order"**. Answer **"No"**, then repeat with **"Yes"**. | "Send this? It will go out and cannot be unsent…" No: nothing sent. Yes: the form is sent (httpbin shows the data). | |
| SF-10 | A link or button containing "send" as part of another word (e.g. "Sending preferences" in an email settings page, if available). | Clicked **without** a question (whole words only). | |
| SF-11 | Chrome: **"Go to Wikipedia"**, then **"Undo that"** | Browser goes back. "Okay, I undid that." | |
| SF-12 | Notepad: type a sentence (Type this), then **"Undo that"** | The typing is undone (Ctrl+Z). | |
| SF-13 | In Chrome: **"Scroll down"**, then **"Undo that"** | Expected: scrolls back, or nothing. ⚠ Watch: it sends **Ctrl+Z to the desktop app** and still says "Okay, I undid that." Check Word/Notepad for lost text. | |
| SF-14 | **"Open Word"**, then **"No, I meant open Excel"** | Word's action is undone as far as possible and Excel opens. | |
| SF-15 | Make the same correction a second time (SF-14 again). | Reply ends with "I'll remember that “open Word” means “open Excel”." Voice & words shows a **Learned** shortcut. **Remove it afterwards** (helper) so later tests aren't affected. | |
| SF-16 | **"Actually, open Notepad"**, **"I said hello"** | Both are taken as corrections. ⚠ Watch: "I said hello" undoes the last action, which the speaker may not want. Record. | |

### B12 — Tasks with several steps

Say each instruction as one sentence. The bar should show **Step 1 of N…** and each step. TK-01 to TK-20 are the 20 built-in evaluation tasks (`server/tools/agent-eval/tasks.json`); TK-21 to TK-24 are extra. Close the apps between tasks.

| ID | Say | Passes when | Result |
|---|---|---|---|
| TK-01 | "Open Notepad and type My name is Amina" | Notepad shows "My name is Amina". | |
| TK-02 | "Open Notepad, type Line one, then start a new line and type Line two" | Both lines, on separate lines. | |
| TK-03 | "Open Notepad, type cat, then select all and type dog" | Shows "dog", not "cat". | |
| TK-04 | "Open Calculator and work out 12 plus 30" | Calculator shows 42. | |
| TK-05 | "Open Calculator and multiply 7 by 6" | Calculator shows 42. | |
| TK-06 | "Open Calculator and then switch it to the scientific calculator" | Scientific mode. | |
| TK-07 | "Open File Explorer and go to the Downloads folder" | Explorer shows Downloads. | |
| TK-08 | "Open File Explorer and open the Documents folder" | Explorer shows Documents. | |
| TK-09 | "Open File Explorer, go to Documents and search for pdf" | A search for "pdf" in Documents. | |
| TK-10 | "Open Settings and go to the Display page" | Display page (Brightness visible). | |
| TK-11 | "Open Settings and then open the Sound settings" | Sound page (Volume visible). | |
| TK-12 | "Open Settings and go to Bluetooth and devices" | Bluetooth page. | |
| TK-13 | "Open Edge and search for Nairobi weather" | Edge shows results for Nairobi weather. | |
| TK-14 | "Open Edge, go to Google Maps and look up Kisumu" | Maps shows Kisumu. | |
| TK-15 | "Open Chrome and go to Wikipedia" | Chrome on Wikipedia. | |
| TK-16 | "Open YouTube in Chrome and search for photosynthesis" | YouTube results for photosynthesis. | |
| TK-17 | "Open a new tab in Chrome and go to bbc.com" | A BBC tab. | |
| TK-18 | "Open Word, start a blank document and type Science homework" | Word shows "Science homework". | |
| TK-19 | "Open Word, start a blank document, type Title and make it bold" | "Title" in bold. | |
| TK-20 | "Open Notepad, type draft note, and then close Notepad" | Asks before closing; after **"yes"**, Notepad is gone (answer its save dialog by voice if it appears). | |
| TK-21 | "Open my email and find the message from John" | The email opens and John's message is found (and read, if asked). | |
| TK-22 | Start TK-19 and say **"Stop"** half-way. | The task stops; it says how far it got. Typing already done is kept. | |
| TK-23 | Start TK-21 and, while it runs, say **"Scroll down"**. | "Still working on the task. Say “stop” to cancel it." | |
| TK-24 | "Open Notepad, change the font to Comic Sans and email it to John" | It does what it can, then **stops and explains** what it couldn't do. It must **not** send anything without asking. | |

### B13 — The person's own shortcuts, routines and dashboard pages

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| PR-01 | **"My music"** | Spotify opens (shortcut). | |
| PR-02 | **"Start my homework"** | Word, then Chrome, then a YouTube search for photosynthesis, in order. | |
| PR-03 | **"Show my progress"**, **"Open my words"**, **"Open voice settings"**, **"Go home"** | The dashboard shows My progress, then Voice & words, then Home. | |
| PR-04 | **"Open the test console"**, **"Show users"**, **"Open developer hub"** | Refused: "That page is for your teacher." ⚠ Watch: the spoken reply may be "**Done: answer_question**" instead (S4). | |
| PR-05 | **"Switch to OpenAI"**, then **"Use Claude for the AI"** | Refused unless an admin account is signed in (it is a teacher's setting). ⚠ Watch: "switch to OpenAI" is caught as "switch to an app called OpenAI" first, so expect "I couldn't find an open window called…". Record both. | |

---

## Part C — A school day (Amina)

Run this as one continuous session, as Amina, in a **classroom-like room** (other people talking quietly, or a radio on low). Hands off throughout, except helper rows. Where a step repeats a Part B check, its ID is given.

### C1 — In the computer lab (shared computer)

Setup by helper: **Settings → This computer → Shared computer: on**, restart AbleSpeak. On the Users page, add **Amina** and **Start their session**.

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| STU-01 | (helper) Restart AbleSpeak on the shared computer. | **Nobody's** profile opens by itself; the last person's session does not carry over. | |
| STU-02 | (helper) Users → choose Amina → **Start their session**. Then I say **"Who am I?"** | "This is Amina's session." | |
| STU-03 | The room is noisy. (helper) Voice & words → **Noisy room** and **Say “AbleSpeak” first: on** → Save. | "Saved. AbleSpeak listens this way now." | |
| STU-04 | Someone nearby says "open YouTube" loudly. | **Nothing happens.** The expanded bar may show "Ignored — it sounded like background talk." | |
| STU-05 | **"AbleSpeak, start my homework"** | The routine runs (PR-02). | |
| STU-06 | **"Scroll down"** (no name) | Ignored (name required). Then **"AbleSpeak"** → "Yes?" → **"scroll down"** works. | |

### C2 — Researching photosynthesis

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| STU-07 | **"AbleSpeak, search for photosynthesis"** | Google results. | |
| STU-08 | **"AbleSpeak, open the Wikipedia link"** | "Opening Photosynthesis on Wikipedia." | |
| STU-09 | **"AbleSpeak, summarise this page"** | A short spoken summary. | |
| STU-10 | **"AbleSpeak, scroll down three"**, **"AbleSpeak, go to the top"** | Scrolls, then jumps up. | |
| STU-11 | **"AbleSpeak, what is chlorophyll?"** | A short spoken answer, no new page. | |
| STU-12 | **"AbleSpeak, go to the YouTube tab"** (from the routine), **"AbleSpeak, open the first video"** | The YouTube tab is active and the first video plays. (Say "go to", not "switch to": see BR-10.) | |
| STU-13 | **"Pause"** (no name needed for media), **"AbleSpeak, skip ahead 30 seconds"**, **"AbleSpeak, play the video"** | Pauses, skips, plays. | |
| STU-14 | **"AbleSpeak, close this tab"** | Tab closes, no question. | |

(helper) Turn **Say “AbleSpeak” first** off and **Standard** back on for the rest of the day, unless the room stays noisy.

### C3 — Writing the essay in Word

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| STU-15 | **"Open File Explorer"**, then **"Open the Documents folder"**, **"Open AbleSpeak Test"**, **"Open the file Biology essay"** | The essay opens in Word. | |
| STU-16 | **"Press control end in Word"** | The cursor goes to the end of the essay. | |
| STU-17 | **"Start dictation"**, then: "Photosynthesis is how plants make food from sunlight full stop. It happens in the chloroplasts full stop. new paragraph" | Typed in Word with correct punctuation; **photosynthesis** and **chloroplasts** spelled right. | |
| STU-18 | Still dictating: **"Previous paragraph"**, **"Bold"** | The cursor moves up a paragraph and bold toggles; no words are typed. | |
| STU-19 | **"Stop dictation"** | Back to commands. | |
| STU-20 | Cursor on "recieve": **"Fix that spelling"**; then **"Fix the spelling of enviroment"** | Both corrected (RD-09, RD-10). | |
| STU-21 | **"Read this paragraph"** | Word's paragraph is read aloud. | |
| STU-22 | **"Set the zoom to 150 percent"** | Word's zoom changes. | |
| STU-23 | **"Save"** | Saved (no dialog, the file already exists). | |

### C4 — Group marks in Excel

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| STU-24 | **"Open the file Group marks"** (from File Explorer), or **"Switch to Excel"** if open. | The workbook is in front. | |
| STU-25 | **"Go to cell B4"** | The selection moves to B4 (through the AI: Name Box or arrow keys). | |
| STU-26 | **"Type this"** → (wait for "What should I type?") → **"85"**, then **"Press enter in Excel"** | B4 becomes 85; the total in B7 updates. Check no full stop was typed after 85. ⚠ A plain **"Enter"** goes to Chrome (BR-16). | |
| STU-27 | **"Go to cell B7"**, **"What's the formula in this cell?"** | "=SUM(B2:B6)". | |
| STU-28 | **"What is the total?"** | The right total, or an honest "I can't". **W** if wrong. | |
| STU-29 | **"Save"** | Saved. | |

### C5 — Two slides in PowerPoint

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| STU-30 | **"Open PowerPoint"** | A blank presentation. | |
| STU-31 | **"Click the title box"**, then **"Type this"** → **"Photosynthesis"** | The title says Photosynthesis. | |
| STU-32 | **"Click New Slide"** | A second slide is added. | |
| STU-33 | **"Click the title box"**, **"Start dictation"**, "How plants make food", **"Stop dictation"** | The second slide's title is typed. | |
| STU-34 | **"What's on this slide?"** | Known limit: AbleSpeak doesn't read PowerPoint's content specially; record what it says. | |

### C6 — Music while studying

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| STU-35 | **"My music"**, then **"Resume Spotify"** | Spotify opens and plays (PR-01, MV-02). | |
| STU-36 | While it plays, keep working: **"AbleSpeak, switch to Word"** | Word comes forward; the music keeps playing. | |
| STU-37 | **"Next song"**, **"Volume down"** | Both work without the name. | |
| STU-38 | Talk to a friend for a minute (about anything) while music plays. | Nothing happens (MV-09, MV-12). | |
| STU-39 | **"Pause"** | "Paused Spotify." | |

### C7 — A break and coming back

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| STU-40 | **"Go to sleep"** — chat with friends for 2 minutes. | Nothing happens during the chat. | |
| STU-41 | **"Wake up"** | "I'm listening." | |
| STU-42 | **"Hide"**, then a minute later **"Come back"** | The bar goes and returns. | |

### C8 — End of my school day

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| STU-43 | **"Switch to Word"**, **"Save"**, **"Quit"** → **"Yes"** | Word closes after the question. | |
| STU-44 | Close Excel and PowerPoint by voice the same way. If they ask to save, answer by voice ("Click Save" / "Click Don't save"). | All closed with no assist. | |
| STU-45 | **"Show my progress"** | My progress shows today's commands. | |
| STU-46 | (helper) Users → **End session**. Restart AbleSpeak. | On the shared computer nobody's profile opens; the next student starts clean. | |

---

## Part D — A working day (Brian)

Run as Brian, on a laptop that is **not** marked shared, in an **office-like room** (people talking, a phone ringing). Hands off except helper rows.

### D1 — Starting work

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-01 | (helper, once) Settings → **This computer → Shared computer: off**. Restart Windows. | AbleSpeak starts by itself (installed build) and opens **Brian's** profile, made from the Windows account. | |
| WRK-02 | **"Who am I?"** | "This is Brian's session." | |
| WRK-03 | **"Start my day"** | Outlook, Excel and Chrome open, in order. | |

### D2 — Email

Use Outlook, or Gmail in Chrome. **Only send to your own test address.**

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-04 | **"Open my email"** | The inbox opens (Gmail opens in Chrome; or say "Switch to Outlook"). | |
| WRK-05 | **"Find the message from John"** | John's email is found and opened. | |
| WRK-06 | **"Read this email"** | The message is read aloud. | |
| WRK-07 | **"Click Reply"**, then **"Start dictation"**, "Thank you John comma I will send the report on Friday full stop", **"Stop dictation"** | The reply is written. | |
| WRK-08 | **"Click Send"** → **"No"** | "Send this? It will go out and cannot be unsent…" → "Okay, cancelled." Nothing is sent. | |
| WRK-09 | Change the To address to your own test address (by voice: **"Click the To box"**, **"Select all"**, **"Type this"** → spell or say the address, e.g. "tester at gmail dot com"). Check the address on screen before going on. Then **"Click Send"** → **"Yes"**. | The email is sent to you only. Record how the address came out (spoken "at" and "dot" are a hard case). | |
| WRK-10 | ⚠ **S1 candidate.** Write a new draft to yourself and say **"Press control enter"** (Outlook's send shortcut). | Expected: a question first. ⚠ Watch: sending by keyboard shortcut is **not** asked about; the email may go at once. Record. | |
| WRK-11 | **"Delete this email"** (on a test email) | A "Delete this? …" question, then deleted after "yes". | |

### D3 — A letter in Word

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-12 | **"Open the file Letter to donor"** (via File Explorer), or **"Open Word"**. | Word, ready to type. | |
| WRK-13 | **"Start dictation"** and dictate a short letter: date, "Dear Ms Wanjiru comma", **"new paragraph"**, two sentences, **"new paragraph"**, "Yours sincerely comma", **"new line"**, "Brian". | Laid out as a letter; names and punctuation right. | |
| WRK-14 | Still dictating: **"AbleSpeak, save"** | Saved; dictation stays on. | |
| WRK-15 | **"Previous paragraph"**, then **"Stop dictation"**, then **"Set the zoom to 120 percent"** | The cursor moves; dictation ends; Word's zoom changes. | |
| WRK-16 | **"Read the whole document"** | The letter is read back. | |
| WRK-17 | **"Save"** | Saved. | |

### D4 — The budget in Excel

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-18 | **"Switch to Excel"**, **"Open the file Budget 2026"** | The budget is in front. | |
| WRK-19 | **"Go to the total cell"** (or name the cell), **"What's the formula in this cell?"** | The formula is read. | |
| WRK-20 | **"Go to cell C3"**, **"Type this"** → **"15000"**, **"Press enter in Excel"** | Value entered (check it is 15000, not "15,000." or "fifteen thousand"); totals update. | |
| WRK-21 | **"Save"** | Saved. | |

### D5 — Finding files

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-22 | **"Open File Explorer"**, **"Go to Documents"**, **"Search for pdf"** | Search results include Report.pdf. | |
| WRK-23 | **"Open the file Report"** | The PDF opens in its viewer. | |
| WRK-24 | **"Read this page"** (in the PDF viewer) | Reads the PDF if the viewer exposes its text; record what happens. | |
| WRK-25 | Back in Explorer: delete `Delete me.txt` by clicking **Delete** (SF-07). | Asks first. | |
| WRK-26 | **"Go to the Downloads folder"** | Downloads shows. | |

### D6 — A form on a website

Use **https://httpbin.org/forms/post**.

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-27 | **"Click the customer name box"**, **"Type this"** → **"Brian Otieno"** | Typed into that field. | |
| WRK-28 | **"Next"**, then **"Type this"** → **"0700 000 000"**. Then try the AI way: **"Type my email in the email box"**. | Focus moves to Telephone and the number is typed. ⚠ Watch: when the AI types into a web page it must know which field; if nothing is typed but it says it did, that is **W**. | |
| WRK-29 | **"Choose Medium"**, **"Check onion"**, **"Check mushroom"** | Medium selected; two toppings ticked. | |
| WRK-30 | **"Click the comments box"**, **"Start dictation"**, "Please ring the bell full stop", **"Stop dictation"** | Typed in Comments. | |
| WRK-31 | **"Click Submit order"** → **"Yes"** | Asks first; after yes, httpbin shows the data sent. | |

### D7 — Windows settings

⚠ If the headset is Bluetooth, skip the Bluetooth off step or use a wired headset.

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-32 | **"Open settings"**, **"Go to Bluetooth and devices"** | The Bluetooth page. | |
| WRK-33 | **"Turn Bluetooth off"**, **"Turn Bluetooth on"** | The switch changes each time. | |
| WRK-34 | **"Go to Display"**, **"Set the brightness to 70 percent"** | The brightness slider moves to about 70. | |
| WRK-35 | **"Go to Sound"**, **"What's my output device?"** | Reads the output device. | |
| WRK-36 | **"Turn on night light"** | Night light comes on (or an honest "I can't"). | |

### D8 — Meetings and calls (exploratory)

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-37 | **"Open Teams"**, **"Go to Calendar"** | Teams opens on its calendar. | |
| WRK-38 | In a test call with a colleague: **"Click mute"**, **"Click unmute"**, **"Turn camera off"** | Teams' own buttons are pressed. Record how reliable it is. ⚠ Remember: the spoken word "mute" alone triggers the music pause (MV-08), so use "click mute". | |
| WRK-39 | **"Click Leave"** | Leaves the call (record whether it asks first; "leave" is not on the question list). | |

### D9 — Privacy and other people in the office

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-40 | A colleague walks over: **"Privacy mode"** | AbleSpeak stops looking at the screen (CT-09). | |
| WRK-41 | The colleague talks to me for a minute, including phrases like "open the file" and "send it". | **Nothing happens.** Any action is **W** (S1 if it sends or deletes). If actions happen, retry with **Say “AbleSpeak” first** on. | |
| WRK-42 | **"Vision on"** | AbleSpeak may look again (CT-11). | |
| WRK-43 | A phone rings near the mic. | Nothing happens. | |

### D10 — Quick jobs

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-44 | **"Open Calculator and work out 15 percent of 24000"** | 3600. | |
| WRK-45 | **"What's 2500 times 12?"** | "30,000" spoken (answered directly). | |
| WRK-46 | **"Open Google Calendar"** | Calendar opens in Chrome. | |
| WRK-47 | **"Remind me at 3 pm to call John"** | Known limit: there are no reminders. AbleSpeak should say so honestly, not pretend. **W** if it claims a reminder was set. | |

### D11 — End of the working day

| ID | I do or say | What should happen | Result |
|---|---|---|---|
| WRK-48 | Close Word, Excel and Outlook by voice with "Quit" → "Yes" (answer save dialogs by voice). | All closed with no assist. | |
| WRK-49 | **"Go to sleep"** | Asleep while I pack up. | |
| WRK-50 | (helper) Sign in page → **Sign out**. | The voice bar hides within about 2 s. "You’re signed out. Your settings are still on this computer." | |

---

## Part E — Exams

Exam mode lets a student sit a practice exam by voice. AbleSpeak reads the questions and writes the spoken answers word for word; the AI and every other tool are switched off. It is for **practice and mock exams only**.

### E1 — The teacher prepares (helper)

| ID | Do | What should happen | Result |
|---|---|---|---|
| EX-01 | Unlock **Helper** or **Admin**, open **Exams**. | The Exams page. Without the PIN: locked. | |
| EX-02 | Save the mock paper into **Documents\AbleSpeak Exams**. | It appears by itself: "New from the exam folder — check its questions before a student sits it". **Start exam** is refused until it is checked. | |
| EX-03 | Upload the second copy with **Upload and check**. Also try a scanned (picture-only) PDF and a file over 20 MB. | Normal paper: read in. Scanned PDF and big file: refused with advice ("The file is too big (more than 20 MB)."). | |
| EX-04 | **Check questions**: check every question, set **time allowed** to 10 minutes, then **Checked — save**. | Saved; Start exam is now possible. | |
| EX-05 | Choose the student, **Start exam**. Then try to start another one. | The dashboard jumps to the **exam screen**; the voice bar shows **Exam** (teal). Spoken: "This is your exam: <title>. It has N questions… Say “help” at any time…", then question 1. Second start: "An exam is already running on this computer. Finish or stop it first." | |
| EX-06 | ⚠ On a second run, put AbleSpeak to sleep (or start dictation) **before** starting the exam. | Expected: the exam takes over. ⚠ Watch: the old state may not be cleared; the bar may still show Asleep or Dictating. Record whether answers still work. | |

### E2 — The student sits it (speaker, hands off)

| ID | Say | What should happen | Result |
|---|---|---|---|
| EX-07 | **"Help"** | The list of things to say. | |
| EX-08 | **"Read the question"**, **"Read the options"**, **"Slower"**, **"Normal speed"** | Re-reads; options read; speed changes ("Is this speed better?"). | |
| EX-09 | **"Answer B"** (multiple choice) | Answer B saved. | |
| EX-10 | **"Next"**, **"Previous"**, **"Go to question 3"**, **"Where am I?"**, **"How much time is left?"**, **"Unanswered questions"** | Moves and answers correctly. | |
| EX-11 | On the short question: **"Answer"** → "Osmosis is the movement of water across a membrane full stop" → **"Done"** | "Answering Question …" → "Written: Osmosis is the movement of water across a membrane." → "Answer saved for Question … Say next for the next question." | |
| EX-12 | **"Answer"** again, then **"Read my answer"**, **"Delete the last word"**, **"Undo"**, **"Delete the last sentence"**, **"Done"** | Each works and is read back. | |
| EX-13 | While answering, say one word on its own: **"Photosynthesis"**. Then **"Next question"**. | The single word is **written**; the two-word command moves on. | |
| EX-14 | While answering: **"Spell m i t o"**, then **"Spell the last word"** | "mito" is written; the letters are read back. | |
| EX-15 | On the maths question: **"Answer"**, **"Maths on"**, "x squared plus three equals twelve", **"Done"**, **"Maths off"** | Written as x² + 3 = 12 (or the same in symbols). | |
| EX-16 | **"Clear my answer"** → **"No"** | "Clear your whole answer…? Say yes or no." → "Okay, your answer is kept." | |
| EX-17 | AI locked: **"What is the capital of Kenya?"**, **"Open Chrome"**, **"Scroll down"** | None of these acts. Expected reply: "I did not understand that as a command. To write an answer, say “answer” first…" | |
| EX-18 | (recorder) Press a Home **"What can I do?"** tile, or type in the Test console, during the exam. | Refused: "An exam is running on this computer, so AbleSpeak only takes the student's spoken answers until it ends." | |

### E3 — The invigilator and problems

| ID | Do | What should happen | Result |
|---|---|---|---|
| EX-19 | (helper) **Pause**, wait 1 minute, **Carry on**. | "Your exam is paused. The clock has stopped." The clock doesn't move; then "Your exam carries on…" | |
| EX-20 | (helper) Switch Wi-Fi off; the student answers. | "I cannot hear answers right now, because the internet connection is down. Your answers so far are saved. Please tell your invigilator." Wi-Fi back on: answers work again. | |
| EX-21 | (helper) Tray → **Quit** in the middle of the exam, then start AbleSpeak. Exams → **Sittings and scripts** → **Carry on**. | "Welcome back. Your exam, <title>, carries on where you were." Earlier answers are there; time lost isn't counted. | |
| EX-22 | **"Finish exam"** → **"Yes"** | Says how many questions have no answer and asks; after a plain "yes" the exam ends. | |
| EX-23 | Run the 2-minute copy and let the time run out. | "1 minute left." then "Time is up. The exam has ended, and your answers are saved." | |
| EX-24 | Run it again and press **End exam** (confirm). | "Your invigilator has ended the exam. Your answers are saved." | |
| EX-25 | Exam screen: **A−** / **A+** | The text size changes and is remembered. | |

### E4 — After the exam (helper)

| ID | Do | What should happen | Result |
|---|---|---|---|
| EX-26 | Exams → **Sittings and scripts**. | One row per sitting, with status **Finished**, **Time ran out**, **Ended by invigilator** or **Not finished**. | |
| EX-27 | **Script (Word)** | `<title> - <student> - <date>.docx` in Downloads: a cover page, every question with the answer exactly as written, or "No answer given." | |
| EX-28 | **Audit trail** | A CSV of everything heard, written and said, with times; the script's cover page says whether the record is intact. | |
| EX-29 | Compare the script with what the student actually said (from the recording). | Answers are word for word. Count any word that differs: that is the exam transcription error rate. | |

---

## Part F — Being heard in real rooms

Use the same **10 test phrases** for each condition, and score how many of the 10 ran correctly:

> 1 "Scroll down" · 2 "Go back" · 3 "Open Notepad" · 4 "Switch to Word" · 5 "Volume up" · 6 "Next song" · 7 "Search for photosynthesis" · 8 "Minimise this window" · 9 "What time is it?" · 10 "Go to sleep" (then "Wake up")

| ID | Condition | Record | Result (x/10, wrong actions) |
|---|---|---|---|
| HR-01 | Quiet room, headset, **Standard** | Baseline. | |
| HR-02 | Quiet room, **laptop microphone**, speaker 50 cm away | Compare with HR-01. | |
| HR-03 | **Soft voice** (as on a tired day), Standard, then **Quiet voice** | Does Quiet voice catch what Standard missed? Does the bar say "Didn't catch that — try again a little louder"? | |
| HR-04 | **Noisy room** (classroom chatter or office), **Standard**, then **Noisy room** | Count actions taken on **other people's** speech (each is **W**). | |
| HR-05 | Noisy room with **Say “AbleSpeak” first** on (say the name before each phrase) | Wrong actions should drop to zero. Phrases without the name show "Ignored…". | |
| HR-06 | **Music** playing from the same laptop (MV-09 to MV-12) | Count false actions and false pauses. | |
| HR-07 | **Slow speech** with a pause in the middle of a phrase ("Search for … photosynthesis"), at pause **1.5 s**, then **3 s** | At 1.5 s the phrase may be cut; at 3 s it should be whole. Note any "Missed the last part — say it again". | |
| HR-08 | **Own words:** dictate "I live in Kisumu and study photosynthesis and osmosis" with the words in the profile, then with them removed | Spelled right with the words in the profile; compare without. | |
| HR-09 | **Kenyan names and Swahili/Sheng** in dictation: "Habari yako", "Nitakuja kesho", a few names | Record how they come out. | |
| HR-10 | **Laptop speakers**, AbleSpeak answering questions aloud | AbleSpeak never acts on its own voice. Then repeat one command three times quickly right after AbleSpeak speaks (e.g. "Play the current song on Spotify"): it must not be dropped as an echo. | |
| HR-11 | Stammer: **"St- start dictating"**, **"S- scroll down"** | Both still understood. | |
| HR-12 | Polite forms: **"Please scroll down"**, **"Can you open Notepad?"**, **"Okay, go back"** | Work, though slower (they go to the AI). | |
| HR-13 | **Speech engine:** Voice & words → **Where speech is recognised** → try **Real time**, **This computer only**, **Online service only**. Time "scroll down" and one dictated sentence in each. | Real time: about 1 s for commands. This computer only: works with no internet if the offline pack is installed; otherwise "Speech recognition on this computer isn’t ready…" Online only: about 3 s. | |
| HR-14 | **No internet** (Wi-Fi off) in Real time mode. | Spoken once: "Voice control is unavailable. AbleSpeak needs the internet right now. I’ll reconnect automatically." The bar shows **Voice unavailable**. Wi-Fi back on: it recovers **by itself** within a minute, with no assist. | |
| HR-15 | First command after AbleSpeak has been idle for **10+ minutes** (the speech service sleeps). | The first command may be slower (up to about 20 s while the service wakes); later ones are fast again. Record the time. | |

---

## Part G — When things go wrong

| ID | Do | What should happen | Result |
|---|---|---|---|
| RC-01 | Turn the extension **off** (click its icon), then **"Scroll down"**. | After about 3 s: "I can't control this webpage right now. Check that Chrome is open, then try again." (spoken and shown). | |
| RC-02 | Extension still off: **"Click Log in"** (an AI command). | "The Chrome extension is not connected, so I could not do that in the browser. Click the AbleSpeak extension icon in Chrome to reconnect it." ⚠ Watch: the bar may show "✓ Done" while saying this. | |
| RC-03 | Turn the extension back **on**, then **"Scroll down"**. | Works within about 2 s of reconnecting. | |
| RC-04 | Close Chrome completely in the middle of a long command ("Summarise this page"). | An honest message ("The browser disconnected before it answered…"), no crash; the next command works. | |
| RC-05 | Wi-Fi off in the middle of an AI command. | An honest network message ("Voice control is unavailable — no internet…" or "That took too long."). | |
| RC-06 | A Windows dialog in the way (e.g. Word's "Save changes?"). Say **"Click Save"**. | The dialog is answered by voice. | |
| RC-07 | Start dictation in Notepad, then make a notification or another window pop up (helper). Keep dictating. | Record where the words go. They should go to the window chosen when dictation started. | |
| RC-08 | Put the laptop to sleep (close the lid) and wake it. | Within a few seconds the bar is listening again and "Scroll down" works, with no assist. | |
| RC-09 | Speak one very long command (more than 8 seconds). | Either handled whole, or "Missed the last part — say it again". Never a half-command acted on wrongly. | |
| RC-10 | Tray → **Quit**, then start AbleSpeak again. | Profile, settings, words, shortcuts and the bar's position are all kept. | |
| RC-11 | Ask for something impossible: **"Print this document in colour on the office printer"** (no printer). | An honest explanation; nothing harmful. | |
| RC-12 | Straight after a failed command: **"Undo that"**, then **"No, I meant …"** with the right command. | Recovery works without an assist. | |

---

## Part H — The helper and admin side

| ID | Do (helper) | What should happen | Result |
|---|---|---|---|
| AD-01 | Open **Settings** with no PIN set. | "These pages are for teachers"; the first PIN can only be set from the tray (**Set admin PIN…**). | |
| AD-02 | Tray → **Set admin PIN…** → set a 4–8 digit PIN (try 3 digits first). | 3 digits: "The PIN must be 4 to 8 digits." Then saved and the admin pages open. | |
| AD-03 | **Lock now**, then enter a wrong PIN 5 times. | "That PIN is wrong." each time, then "Too many wrong PINs. Try again later." for 5 minutes. | |
| AD-04 | Unlock, wait 15 minutes. | The pages lock again. A dashboard reload also locks them. | |
| AD-05 | Settings → **Helper PIN**: try the admin PIN, then a different one. | "Choose a different PIN from the admin PIN." Then saved. The helper PIN opens **Users** and **Exams** only; Settings says "This page needs the admin PIN". | |
| AD-06 | **Users**: add "Test User", start their session, say "Who am I?", end the session, remove them. | Added; "This is Test User's session."; ended; removed. ⚠ Watch: the remove question says goals stay, but **all** their data is deleted. | |
| AD-07 | **Users** → a user's progress: create a goal, add a phase change. | The chart shows the aim line and trend. | |
| AD-08 | **Voice & words** → **Save to a file**, change a setting, **Load from a file**. | The saved settings come back. | |
| AD-09 | **Settings → API keys**: paste a wrong key, then the right one. | "…rejected this key (HTTP n). Check you copied all of it." Then "Saved. Google Gemini accepted the key." | |
| AD-10 | **Settings → Admin account** on a non-shared computer, then mark the computer shared and try again. | Works; then refused: "This computer is marked as shared, so no Windows account can open the admin pages without a PIN." | |
| AD-11 | **Test console**: type "scroll down", "open notepad", "start dictation", "stop dictating". | Each acts exactly as if spoken, on the app used before the dashboard, and is **not** counted in progress. | |
| AD-12 | **Developer Hub → Tools** | 56 tools listed. | |
| AD-13 | By voice (speaker): **"Open the developer hub"**, **"Show users"** | Voice never opens admin pages (PR-04). | |
| AD-14 | **My progress** and **Home → Recent commands** after the run. | The day's commands are there; the "worked" count roughly matches the results sheet. Export the JSON. | |

---

## Part I — End of the day

| ID | Do or say | What should happen | Result |
|---|---|---|---|
| END-01 | Save and close all apps by voice. | No assist needed; every close asks first. | |
| END-02 | **"Go to sleep"** | Asleep. | |
| END-03 | (helper) **Sign out** on the Sign in page. | The bar hides within about 2 s. Settings stay on the computer. | |
| END-04 | (helper) Tray → **Quit**. (Closing the dashboard window with X only hides it to the tray.) | AbleSpeak closes completely (no icon near the clock). | |
| END-05 | Sign out of Windows and back in (installed build). | AbleSpeak starts by itself. | |
| END-06 | (shared computer) The next person sits down. | Nobody's profile opens until a helper chooses one. | |

---

## Recording results

### Session header (one per run)

| Field | Value |
|---|---|
| Date and time | |
| Tester (speaker) / recorder | |
| Persona | Amina / Brian |
| Speaker's speech (typical / soft / impaired — with consent) | |
| Build (source commit, or installer file and date) | |
| Laptop model, Windows version | |
| Microphone (headset model / laptop mic) | |
| Room (quiet / classroom / office / music) | |
| Internet (Wi-Fi name, speed if known) | |
| Listening profile, pause, "Say AbleSpeak first", speech engine | |
| Chrome version, extension connected (yes/no) | |

### Results sheet

Copy this table into a spreadsheet; one row per thing said.

| ID | Said (word for word) | Bar "Heard" | What happened | Spoken reply | Time | Code | Retries | Assist? | Notes |
|---|---|---|---|---|---|---|---|---|---|
| ST-10 | Who am I? | Who am I? | — | This is Amina's session. | <1 s | P | 0 | No | |

### Numbers to work out after each run

| Measure | How | Suggested target for a release |
|---|---|---|
| **Command match rate** | rows scored P or R*n* ÷ all rows said | 90% or more for quick commands in a quiet room |
| **First-time success** | rows scored P ÷ all rows said | 80% or more |
| **Wrong-action rate** | rows scored W ÷ all rows said | 1% or less, and **zero S1** |
| **Recovery rate** | failures fixed by voice (undo, "I meant", retry) ÷ all failures | 90% or more |
| **Independence** | tasks finished with no assist ÷ all tasks | 100% after sign-in |
| **Speed** | median time for quick commands, and for AI commands | quick ≤ 1.5 s; AI ≤ 5 s |
| **Noise robustness** | wrong actions per 10 minutes of background talk or music | 0 with "Say AbleSpeak first" on |

The targets are suggestions for discussion, not agreed numbers.

### Bug report

```
Title:        <what went wrong, in one line>
ID / persona: <e.g. SF-05, Brian>
Severity:     S1 / S2 / S3 / S4
Build:        <commit or installer + date>
Steps:        1. … 2. … 3. …
Said:         "<exact words>"   Bar showed: "<Heard: …>"
Expected:     <from this script>
Actual:       <what happened, what was said>
Repeatable:   <n of m tries>
Evidence:     <recording file + time, log lines>
Watch-for:    <number from the list below, if it was one>
```

---

## Watch-for list: likely bugs found by reading the code

None of these has been confirmed on a real machine. Mark each **Confirmed** or **Not seen** after a run.

| # | What the code suggests | Test | Likely severity |
|---|---|---|---|
| 1 | A short spoken phrase (6 words or fewer) containing **stop, pause, mute, quiet, silence, hush** or **shut up** goes to the media pause first. So "stop listening", "pause listening" and "hush" don't put AbleSpeak to sleep, "stop watching" doesn't turn on privacy, and "mute" doesn't mute. Even "search for bus stop" pauses media. | CT-06, CT-12, CT-13, MV-08 | S3 |
| 2 | Answering a close/delete/send question with **"cancel"**, **"abort"**, **"never mind"** or **"no, stop"** may leave the question waiting; the next phrase starting with "okay" or "yes" then carries out the action. | SF-05, SF-06 | **S1** |
| 3 | Sending by keyboard shortcut (Ctrl+Enter in Outlook) and the plain Delete key are not asked about. | WRK-10, SF-08 | **S1** |
| 4 | Quick browser commands (**scroll, enter, escape, space, tab, next**) always go to Chrome and bring it forward, even when Word or Excel is in front. | BR-16, STU-26 | S3 |
| 5 | **"Open Chrome / Edge / Firefox"** only brings an open browser forward; it won't start one. "The browser" means Brave. | AP-08 | S2 |
| 6 | **Privacy mode on/off** is never spoken and the bar may show "Working…" for up to 60 s. | CT-09, CT-11 | S3 |
| 7 | **"Quieter"** is taken as cancel; **"unmute"** can mute. | MV-07, MV-08 | S3 |
| 8 | Some replies are raw: **"Done: create_tab"** for "new tab" and **"Done: answer_question"** for admin pages. | BR-08, PR-04 | S4 |
| 9 | While dictating, **"stop typing", "finish dictation", "turn off dictation", "I'm done dictating"** are typed; the single words **"sleep", "hide", "close"** act instead of being typed; "AbleSpeak, volume up" / "new tab" are typed. | DI-08 to DI-10 | S3 |
| 10 | **"Undo that"** after a scroll sends Ctrl+Z to the desktop app, and always says "Okay, I undid that." | SF-13 | S2 |
| 11 | **"Check X"** on a box that is already ticked unticks it; a form option that isn't found is not mentioned. | CL-08, WRK-29 | S3 |
| 12 | Browser **"type"** without a known field may type nothing but report success. | WRK-28 | S2 |
| 13 | **Hiding the bar with Ctrl+Shift+A** turns off the mic, so voice can't bring it back; pressing it while AbleSpeak speaks may not stop the speech. | VB-02, VB-05 | S2 |
| 14 | **Starting an exam** while asleep, dictating or waiting for a yes/no may not clear that state. | EX-06 | S3 |
| 15 | With the extension disconnected, an AI command's failure may show as **"✓ Done"**. | RC-02 | S4 |
| 16 | **Sign-in can't be done hands-free**: the voice bar waits until someone signs in or presses "Not now". | ST-03 | S2 |
| 17 | **"Pin this tab"** can't be undone by voice; **"Take a screenshot"** does nothing useful. | BR-13, BR-15 | S4 |
| 18 | Spoken punctuation is replaced anywhere: "google dot com" → "google. com". The phrase "I'll be right back" is dropped as noise. | DI-16, DI-17 | S3 |
| 19 | Stale wording: "Who am I?" with nobody chosen mentions the **Teacher** page; the remove-user question says goals stay. | ST-10, AD-06 | S4 |
| 20 | The **installer is from 17 September** and lacks sign-in, exams and the new voice bar; the offline speech pack isn't packaged. | 2.1 | — |
| 21 | **"Switch to the YouTube tab"** and **"Switch to OpenAI"** are caught as "switch to an app with that name" and fail; "go to the … tab" works through the AI. | BR-10, PR-05 | S3 |
| 22 | **"Enter", "Escape" and "Space" in a web page** are simulated keys that pages often ignore, so a search box may not submit. | DI-15 | S3 |
| 23 | **"Type this <words>"** said in one breath turns dictation on, because speech has no colon; only the two-step "Type this" → words types once. | DI-19 | S4 |
| 24 | **A long spoken answer can't be stopped by voice**: the mic is muted while AbleSpeak speaks, and a single AI command in progress answers "Still working…". Only the red stop square works. | CT-13 | S2 |

---

## Known limits: not bugs today

Score these **K**, but still write down how AbleSpeak tells the person (an honest message is required).

- **Internet is needed** for most things: speech recognition (unless the offline pack is installed), the AI, the usual speaking voice (it falls back to the Windows voice), and sign-in. Without it, voice control stops and says so.
- **Windows and Chrome only.** No Mac, no phone app. Web pages are controlled only in Chrome; Edge can be opened and searched through the desktop.
- **No file tools**: files are opened, moved or deleted only through File Explorer by voice.
- **No timers, alarms, reminders or calendar actions**; Google Calendar can be opened in Chrome.
- **No desktop screenshot**: AbleSpeak reads the screen through each app's controls, not pictures. Canvas-drawn apps and some games can't be read.
- **PowerPoint content** isn't read specially.
- **Push-to-talk** isn't built. In busy rooms, use *Noisy room* plus *Say "AbleSpeak" first* and a headset.
- **Settings don't follow the person** to another computer automatically; use Save/Load to a file.
- **Exams**: practice and mocks only. The voice goes online to Google Gemini, pictures and diagrams are not read, and maths covers common spoken forms only.
- **Several Word windows** at once: dictation and spelling fixes can land in the wrong one.
- **Email sign-in codes** only reach project team members until a proper email sender is set up.
- **Severely unclear speech** is recognised less well; keep a human scribe for exams.

---

## Appendix — phrase rules, timings and file locations

### How phrases are matched (helps predict results)

- **Order** AbleSpeak checks things in: exam → transcription → "Say AbleSpeak first" → music gate → **emergency media pause** → noise and echo filters → stop/sleep/wake/hide/privacy/"who am I" → dictation → a waiting yes/no → "type this" → undo and "I meant" → the person's shortcuts and routines → quick commands and click-by-name → multi-step task → the AI.
- **Quick commands** run without the AI, in about a second. They only match the plain form: "please", "can you" or "okay" **at the start** sends the phrase to the AI instead (slower but should still work). Trailing words like "please", "now", "for me", "on this page" are fine.
- **Multi-step tasks** start when one sentence has two or more different actions joined by "and", "then" or a comma, and is 5 words or longer.
- **"Click / press / tap <name>"** clicks straight away when exactly one thing on screen has that exact name; otherwise the AI decides.
- **Yes** counts if the answer **starts** with yes, yeah, yep, yup, confirm, do it, go ahead, proceed, okay, ok or sure. Anything else cancels.
- **"Type this"** works in two steps: say "Type this", wait for "What should I type?", then say the words (within 2 minutes). They are typed once, with spoken punctuation turned into marks.
- **"Switch to <app>"** is for apps. For a browser tab say **"Go to the <name> tab"**.
- **"Close"** on its own hides AbleSpeak's voice bar. To close a window say "quit", "close the window" or "close <app>".
- **"Next"** and **"Previous"** on their own move between fields on a web page, not songs. Say "next song".
- **"Play"** on its own toggles the browser video. Say "resume Spotify" for Spotify.

### Timing guide (measured 15 October 2026, Nairobi)

| What | Expected time after you stop speaking |
|---|---|
| Quick command, real-time engine ("scroll down") | about 0.7–1 s |
| Quick command, speech engine on the computer | about 0.35–0.5 s |
| Anything through Gemini speech recognition only | about 2.5–3 s |
| AI commands (clicks, questions, reading) | add about 1.5 s or more |
| First command after 10+ idle minutes | up to about 20 s (the speech service wakes up) |

### Where things are

| What | Development (from source) | Installed |
|---|---|---|
| Settings file (keys, PIN hashes) | `server\.env` | `%APPDATA%\AbleSpeak\.env` |
| Database (commands, profiles, progress, exams) | `server\data\ablespeak.db` | `%APPDATA%\AbleSpeak\data\ablespeak.db` |
| Sign-in (encrypted) | `account.bin` next to the database | same |
| App log | the terminal running `npm run desktop` | Developer Hub → Logs (only while open) |
| Exam papers folder | `Documents\AbleSpeak Exams` | same |
| Exam scripts and audit trails | `Downloads` | same |
| Voice bar position | `overlay-position.json` in the app's user-data folder | same |
| Chrome extension | `chrome-integration-master\` | tray → **Show Chrome Extension Folder** |

Useful log lines when checking a result: `[Voice] 🚨 Escape command` (the media pause caught a phrase), `[Voice] 🔇 … not for AbleSpeak` (music gate or name gate), `[Voice] ⚡ Real time` (acted at the first pause), `[Overlay] Failure shown as …` (what the person saw for a failure), `[Learn] Shadow` (a command AbleSpeak would have learned).

### Related documents

- [AbleSpeak-Documentation.md](AbleSpeak-Documentation.md) — the complete user guide.
- [AbleSpeak-Exam-Guide.md](AbleSpeak-Exam-Guide.md) — exams for teachers and invigilators.
- [INSTALL-FOR-TEACHERS.md](INSTALL-FOR-TEACHERS.md) — setting up a computer (some wording is out of date: "Teacher" is now "Users").
- [TIER2-DEMO.md](TIER2-DEMO.md) — the 8-minute demonstration.
- [AbleSpeak-Full-Computer-Nav-Design.md](AbleSpeak-Full-Computer-Nav-Design.md) — how it works inside.
