# AbleSpeak — the complete guide

*Everything AbleSpeak for Windows does and how to use it, as of 13 October 2026. Parts 1–3 are for the person using AbleSpeak. Part 4 is for helpers and teachers, Part 5 for admins, Part 6 for developers.*

AbleSpeak lets a person who cannot use a keyboard or mouse well control a whole Windows computer by speaking. They can open and switch apps, browse the web, click anything on screen, type and dictate, have pages and documents read aloud, sit an exam, and fix mistakes — all by voice.

It is built for people with motor, visual and speech impairments, in particular students. Because the person may not be able to reach for a mouse when something goes wrong, AbleSpeak is designed around that moment: it asks before anything risky, says out loud when something fails, and always has a spoken way to stop, undo or correct.

**Contents**

1. [The parts of AbleSpeak](#part-1--the-parts-of-ablespeak)
2. [Getting started](#part-2--getting-started)
3. [Using AbleSpeak by voice](#part-3--using-ablespeak-by-voice)
4. [For helpers and teachers](#part-4--for-helpers-and-teachers)
5. [For admins](#part-5--for-admins)
6. [For developers](#part-6--for-developers)
7. [Privacy](#privacy-what-is-stored-and-what-leaves-the-computer)
8. [If something goes wrong](#if-something-goes-wrong)
9. [What AbleSpeak cannot do yet](#what-ablespeak-cannot-do-yet)

---

# Part 1 — The parts of AbleSpeak

| Part | What it is |
|---|---|
| **The voice bar** | A small round microphone that stays on top of every app. It listens, shows what it heard, and opens into a short card for results, problems and questions. This is the part the person uses all day. |
| **The dashboard** | A window with AbleSpeak's pages: Home, My progress, Voice & words, Sign in, and extra pages for helpers and admins. |
| **The Chrome extension** | Lets AbleSpeak see and control web pages in Google Chrome. |
| **The tray icon** | The AbleSpeak icon near the clock. Right-click it for **Show AbleSpeak**, **Open in Browser**, **Show Chrome Extension Folder**, **Set admin PIN…**, **Admin pages without a PIN…** and **Quit**. |

AbleSpeak needs the **internet**: it uses online services to turn speech into text, to understand harder commands, to speak, and to sign in. Without internet it says "Voice control unavailable" and reconnects by itself when the connection returns.

---

# Part 2 — Getting started

## Setting up a computer

A teacher or helper sets a computer up once, in about 30 minutes: install AbleSpeak, add the Gemini key, allow the microphone, connect Chrome, and say who the user is. The steps are in [INSTALL-FOR-TEACHERS.md](INSTALL-FOR-TEACHERS.md). After that AbleSpeak starts by itself each day.

## Signing in

AbleSpeak opens on the **Sign in** page until someone is signed in. There are two ways:

- **Email code.** Give your email address. AbleSpeak emails a six-digit code; say or type it. There is no password.
- **Google.** Choose **Sign in with Google**; your browser opens, you sign in, and AbleSpeak comes back to the front.

**"Not now — keep using this computer only"** skips signing in until the next start, so a person is never locked out of their own computer when the internet is down.

The voice bar appears, and its microphone switches on, once someone has signed in or chosen "Not now".

## The first things to say

Speak naturally. There is no wake word in normal use; just say what you want.

- **"What can I do?"** — the Home page lists examples.
- **"Open Chrome"**, **"Scroll down"**, **"Go back"**.
- **"Stop"** — interrupts whatever AbleSpeak is doing or saying.
- **"Undo that"** — takes back the last action.

---

# Part 3 — Using AbleSpeak by voice

## How it listens

The voice bar listens all the time. It starts recording when you speak and stops after a short pause, then works out what you said. While AbleSpeak is speaking, its microphone is off, so it does not hear itself.

How sensitive it is, and how long a pause ends a command, are set for each person (see [Voice & words](#voice--words)).

### Where your speech is understood

Commands are understood **on the computer itself**, by a speech model made for Kenyan English and for speech that is hard for other systems to understand (CDLI's Whisper small, fine-tuned on non-standard speech). "Scroll down", "open Chrome", "stop" and "wake up" therefore run straight away, with no wait for the internet.

Everything else (questions, dictation and Swahili) goes to the online service, Google Gemini. When you are dictating and Gemini is slow or the internet is down, AbleSpeak types the words the computer heard instead.

Each person chooses one of three settings:

| Setting | What it does |
|---|---|
| **This computer first** (default) | Commands on the computer; everything else online. |
| **This computer only** | Speech never leaves the computer and works with no internet. English only. |
| **Online only** | Every phrase goes to Gemini, as before. |

Exams always use Gemini, as chosen for exam mode.

## What the voice bar shows

- A word and a colour for what it is doing: **Listening**, **Working**, **Dictating**, **Please confirm**, **Speaking**, **Asleep**, **Voice unavailable**, **Didn't work**, **Exam**. Never colour alone.
- What it heard, and what happened: "✓ Paused Spotify", "✓ Opening Michael Jackson on Wikipedia". Failures say what went wrong and what to try.
- **Yes / No** buttons when it asks a question, and **Stop dictation** while dictating. They do the same as saying the words.
- It is small by default, can be dragged by its grip to any edge, and remembers where you put it.
- **Ctrl+Shift+A** shows or hides it. The mic button turns the microphone off and on.

## Quick commands

These are recognised at once, without the AI. Natural variations usually work.

**Web pages (Chrome)**

| Say | What happens |
|---|---|
| "Scroll down" · "Scroll up" · "Page down" · "Page up" | Scrolls the page, or the panel that actually scrolls |
| "Go to the top" · "Go to the bottom" | Jumps to the start or end |
| "Go back" · "Go forward" | Browser history |
| "Reload" · "Refresh the page" | Reloads the tab |
| "New tab" · "Close this tab" | Tabs |
| "Search for …" · "Google …" · "Look up …" | Searches the web |
| "Search YouTube for …" · "Search for … on YouTube" | Searches YouTube |
| "Next" · "Previous" | Moves to the next or previous field or button |
| "Select …" · "Choose …" · "Check …" · "Uncheck …" | Picks an option, radio button or tick box |
| "Clear" · "Clear the search bar" | Empties the field |

**Apps and windows**

| Say | What happens |
|---|---|
| "Open Word" · "Open Spotify" | Opens the app |
| "Switch to Word" · "Go to Word" · "Bring Chrome to the front" | Brings an open app forward |
| "Minimize" · "Maximize" · "Full screen" · "Restore" | Changes the window |
| "Snap left" · "Snap right" | Puts the window on half the screen |
| "Close" · "Close the window" | Closes the window — AbleSpeak asks first |

**Music, video and volume**

| Say | What happens |
|---|---|
| "Pause" · "Play" · "Resume" | Pauses or plays what is playing |
| "Pause Spotify" · "Play music" | A named player |
| "Next song" · "Skip" · "Previous song" | Changes track |
| "Volume up" · "Louder" · "Volume down" · "Quieter" | System volume |
| "Mute" · "Unmute" · "Mute this tab" | Sound off and on |

**Keys**

| Say | What happens |
|---|---|
| "Enter" · "Escape" · "Tab" · "Space" | Presses the key |
| "Copy" · "Paste" · "Cut" · "Select all" · "Save" | The usual shortcuts |
| "Undo" · "Redo" | Ctrl+Z and Ctrl+Y |

**Emergency pause.** A short phrase with "pause", "stop", "mute", "quiet", "silence", "hush" or "shut up" pauses whatever is playing, in any app, before anything else is considered. It only ever pauses; it never starts music. AbleSpeak says what it paused.

## Anything else: just ask

What is not a quick command goes to the AI, which can see what is on your screen and act on it:

- **Clicking:** "Click the sign up button", "Click on the Wikipedia link", "Open the second result".
- **Opening things:** "Open my email", "Go to the BBC website".
- **Any Windows app:** "Click play in Spotify", "Set the zoom to 150 percent", "Open the File menu". AbleSpeak reads each app's buttons, menus, sliders and fields directly, so it does not have to guess where to click.
- **Word and Excel:** "What is in cell B4?", "Fix the spelling of this word".
- **Questions:** "What is the capital of Kenya?" — it answers out loud.
- **Reading:** "What's on my screen?", "Read this page", "Read this paragraph" — it reads the window you are using: a web page, a Word document or any other app.

Following a link says what is opening — "Opening Michael Jackson on Wikipedia" — never a web address.

## Tasks with several steps

Say the whole thing at once: **"Open my email and find the message from John"**, **"Open Notepad, type my name, then save it"**.

AbleSpeak makes a short plan, shows each step on the voice bar, and checks the screen after every step. If a step did not work it tries another way, at most twice. If it still cannot finish, it stops and says how far it got and why. Say **"Stop"** at any time to end the task.

## Typing by voice (dictation)

| To… | Say |
|---|---|
| Start typing | "Dictate" · "Start dictation" · "Start typing" |
| Start and type in one go | "Dictate, my name is Amina" |
| Type one thing | "Type this" — then say the words |
| Punctuate | "full stop" · "comma" · "question mark" · "new line" · "new paragraph" |
| Delete | "delete word" · "backspace" |
| Take back | "undo that" · "redo" |
| Format | "bold" · "italic" · "underline" · "select all" |
| Move | "next line" · "previous line" · "end of line" · "next paragraph" · "end of document" |
| Give a command without stopping | Start with the name: "AbleSpeak, open Chrome" |
| Stop typing | "Stop dictation" · "Command mode" |

Words are typed into the window you were in when dictation started; the voice bar keeps showing which. You can keep talking while earlier phrases are typed; nothing is lost and the order is kept. If typing fails, AbleSpeak says so out loud.

## Questions, undo and corrections

- **AbleSpeak asks before anything that cannot be undone**: deleting, sending, submitting, closing a window that may have unsaved work. Say **"yes"** to go ahead. Anything else cancels.
- **"Undo that"** (also "take that back", "that's wrong", "wrong one") reverses the last action.
- **"No, I meant …"** (also "actually …", "I said …") undoes it and does what you meant. If you correct the same thing twice, AbleSpeak learns it as your own shortcut.

## Sleep, hide and privacy

| Say | What happens |
|---|---|
| "Go to sleep" · "Stop listening" | AbleSpeak ignores everything until "Wake up" |
| "Wake up" · "I'm back" | Listening again |
| "Hide" · "Go away" | The voice bar disappears but keeps listening |
| "AbleSpeak" · "Come back" | The voice bar returns |
| "Privacy mode" · "Stop watching" | AbleSpeak stops looking at the screen; voice control carries on |
| "Vision on" · "Privacy off" | It may look at the screen again |
| "Who am I?" | Says whose session this is |

## Noisy places

In a busy room, other voices can be taken for yours. Three things help; the first two are set under [Voice & words](#voice--words):

- the **Noisy room** listening profile;
- **Say "AbleSpeak" first**: AbleSpeak only acts when you start with its name — "AbleSpeak, open Word" — and ignores other people, TV and music. Saying just "AbleSpeak" makes it listen for your next phrase;
- a headset microphone.

## The dashboard pages for everyone

### Home
What AbleSpeak is doing right now, key numbers, your recent commands and whether each worked, the listening settings, system status, and **What can I do?** with example commands.

### My progress
Your own commands and successes per day, and what you say most. You see only your own.

### Voice & words
How AbleSpeak listens to you and the words it knows:

- **Listening profile:** *Standard*, *Quiet voice* (for soft speakers) or *Noisy room*.
- **Say "AbleSpeak" first**, for noisy places.
- **Where speech is recognised:** *This computer first*, *This computer only* or *Online only* (see [Where your speech is understood](#where-your-speech-is-understood)).
- **The pause that ends a command** — longer for someone who speaks slowly.
- **Your own words:** names, subjects and places, so they are spelled right.
- **Shortcuts:** "my music" → "open Spotify". Ones AbleSpeak learned from your corrections are marked.
- **Routines:** a named list of steps — "Start my homework".
- **Save to a file / Load from a file**, to carry your settings to another computer.

### Sign in
Sign in, sign out, and see which account is signed in.

---

# Part 4 — For helpers and teachers

The **Helper** section of the menu opens for a signed-in account with the role *helper* or *admin*, or with the **helper PIN**.

## Users

- **Who is using this computer.** Add people by name and choose who is at the computer. AbleSpeak remembers after a restart.
- **How well AbleSpeak hears them:** how often they were understood, how often a command worked first time, retries, and what was set aside as background noise.
- **Their voice settings**, as on Voice & words.
- **Goals and progress:** set a goal with a starting point and a target, and see the aim line, the trend, phase changes and flags that say when a decision is due. These come from the person's own saved commands and give dated evidence for progress reviews.
- **Deleting a person** removes all their data from this computer.

## Exams

A student can sit an exam by voice. You add the paper (Word or PDF), check the questions, and start it for the student. AbleSpeak reads each question aloud and writes down the spoken answers exactly as said, with the AI assistant and every other tool switched off. Afterwards you download the completed script as a Word document, with a record of the whole sitting.

The full instructions are in [AbleSpeak-Exam-Guide.md](AbleSpeak-Exam-Guide.md). It is for practice and mock exams for now, not formal national exams.

---

# Part 5 — For admins

The **Admin** section opens for an account with the role *admin*, for an **admin Windows account**, or with the **admin PIN**.

| Page | What it is for |
|---|---|
| **Test console** | Type a command and see exactly what the same words would do if spoken — useful for trying things without a microphone |
| **Developer Hub** | The tools AbleSpeak has, the AI prompt, what it currently sees (context), and the logs |
| **Settings** | API keys and the AI provider and model, the helper PIN, the admin account, and whether this is a shared computer |

## Who can open what

| Tier | Pages | Opened by |
|---|---|---|
| **User** | Home, My progress, Voice & words, Sign in | everyone |
| **Helper** | Users, Exams | a helper account, or the helper PIN |
| **Admin** | Users, Exams, Test console, Developer Hub, Settings | an admin account, an admin Windows account, or the admin PIN |

- **The first admin PIN** can only be set from the tray icon (**Set admin PIN…**), so nobody can make themselves admin by voice. A PIN unlock lasts 15 minutes. Five wrong PINs lock unlocking for five minutes.
- **The helper PIN** is optional and is set by an admin in Settings. It cannot be the same as the admin PIN.
- **Admin pages without a PIN…** (tray icon, or Settings) lets one Windows account open every page on the admin's own computer. It is refused on shared computers and guest accounts.
- **Roles** (*helper*, *admin*) are set on the account by the AbleSpeak project owner, never by the user.

## Shared computers

Mark a lab computer as **shared** in Settings. Then nobody's profile opens by itself, and the last person's session never carries over to the next.

## API keys and the AI

- Speech is always turned into text by **Google Gemini**, so a Gemini key is required.
- Commands the AI handles can use **Gemini, OpenAI or Anthropic**; choose the provider and model in Settings.
- Keys are saved on this computer only, and Settings cannot be reached by voice.

---

# Part 6 — For developers

AbleSpeak is one Electron app. Inside it run the voice bar, the dashboard (React), a local gateway server (Node/Express on `localhost:3001`) and one long-lived PowerShell worker with compiled C# for Windows UI Automation. Chrome is driven through the extension over a local WebSocket.

**From speaking to action:** the voice bar records a clip → the gateway has Gemini transcribe it → noise and echo are filtered → it is routed in order: stop/sleep/wake, dictation, a pending yes/no, corrections and shortcuts, quick commands, multi-step tasks, then the AI with its tools → the reply is shown on the voice bar and spoken.

**Run from source** (Windows 10/11, Node 20+, Chrome):

```
cd server      && npm install     # then copy .env.example to .env and add GEMINI_API_KEY
cd ../dashboard && npm install && npm run build
cd ../server   && npm run desktop
```

Load the extension in `chrome://extensions` (Developer mode → Load unpacked → `chrome-integration-master/`).

**Tests:** `cd server && npm test` (495 tests). Dashboard: `cd dashboard && npm run build`.

**Where to read more**

| Topic | Document |
|---|---|
| How every part works, with diagrams | [AbleSpeak-Full-Computer-Nav-Design.md](AbleSpeak-Full-Computer-Nav-Design.md) |
| Exam mode: design, safeguards, what real exams need | [AbleSpeak-Exam-Mode.md](AbleSpeak-Exam-Mode.md) |
| Accounts and sync plan | [AbleSpeak-Tier2-Phase2-Accounts-Plan.md](AbleSpeak-Tier2-Phase2-Accounts-Plan.md) |
| Roadmap | [AbleSpeak-Tier2-Product-Roadmap.md](AbleSpeak-Tier2-Product-Roadmap.md) |
| The dashboard's look | [design/DESIGN.md](design/DESIGN.md) |
| Quick start and project layout | [../README.md](../README.md) |

---

# Privacy: what is stored and what leaves the computer

**Stored on this computer only:** each person's profile (listening settings, words, shortcuts, routines), every command with whether it worked, goals and progress, exam papers, answers, scripts and audit trails. Deleting a person removes all of it.

**What leaves the computer:**

| What | Where it goes | Why |
|---|---|---|
| Voice clips | Google Gemini | to turn speech into text |
| Harder commands, with what is on screen (names of buttons and links, and sometimes a screenshot) | the chosen AI provider | to work out what to do |
| What AbleSpeak says | Microsoft Edge text-to-speech | to speak |
| Sign-in | Supabase in the EU (and Google, if chosen) | accounts and roles |

- **Privacy mode** stops AbleSpeak looking at the screen.
- **During an exam** the AI is switched off; only the voice clips and the spoken text go out.
- The gateway only answers this computer. Other websites cannot reach it or get a role.
- Sign-in details are kept encrypted with Windows' own protection.

For children, get a parent's or guardian's consent before use, in line with your school's data protection policy.

---

# If something goes wrong

| What you see | What to do |
|---|---|
| The voice bar is not there | Press **Ctrl+Shift+A**, or right-click the tray icon → **Show AbleSpeak**. It stays hidden until someone signs in or chooses "Not now". |
| It does not hear you | Check the mic button is on. Say "wake up" in case it is asleep. Try the *Quiet voice* profile. |
| It acts on other people's voices | Use the *Noisy room* profile, switch on **Say "AbleSpeak" first**, or use a headset. |
| "Voice control unavailable" | The internet is down. AbleSpeak reconnects by itself. |
| "I can't control this webpage right now" | Check Chrome is open and the AbleSpeak extension is connected. Reload the page. |
| A click or command did the wrong thing | Say "undo that", or "no, I meant …". |
| It is slow | Most of the wait is speech recognition, about two seconds. Quick commands feel like about three seconds in all. |
| Music will not stop | Say "pause" or "stop". |
| Nothing works at all | Right-click the tray icon → **Quit**, then start AbleSpeak again. |

---

# What AbleSpeak cannot do yet

- **Work without the internet.** With no connection there is no voice control.
- **Be instant.** Even a simple command takes about three seconds, mostly recognition. Recognising quick commands on the computer itself is planned.
- **Press-to-talk** for very busy rooms is planned; today the Noisy room profile and "Say AbleSpeak first" are the tools.
- **Follow you between computers automatically.** Settings move as a file for now; syncing to the account is next.
- **Formal national exams.** Exam mode needs the internet and sends the voice to an online service. It is for practice and mock exams.
- **Read pictures and diagrams aloud** in exams.
- **Recognise severely unclear speech** well; this is a limit of today's speech recognition.
- **Anything but Windows and Chrome.** No Mac, no other browsers, no phone app yet.
- **Several Word windows at once:** dictation and spelling fixes can land in the wrong one.
