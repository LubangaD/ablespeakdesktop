# Tier 2 demonstration script

About 8 minutes. One presenter speaks to the computer; a second person
narrates. Everything is done by voice — keep hands off the keyboard and mouse
once the demo starts, because that is the point.

## The day before

1. Install from the current installer on the demo laptop
   ([INSTALL-FOR-TEACHERS.md](INSTALL-FOR-TEACHERS.md)). Use a headset
   microphone.
2. On the **Teacher** page, add a demo student ("Demo") and **Start their
   session**.
3. Under **Speech settings for Demo**:
   - Words: `Kisumu`, `photosynthesis`, the presenter's name
   - Routine: `start my homework` → `open word` / `open chrome` / `open youtube and search for photosynthesis`
   - Save.
4. Open Word with a blank document, and Outlook (or Gmail in Chrome) with one
   message from "John" in the inbox.
5. Run the evaluation on the demo laptop so you know what works there:
   `node tools/agent-eval/run.mjs` (plans only), then the tasks you will
   show with `--live --yes --only …`.
6. Rehearse twice, in the room, at the volume you will use.

## Just before

- Close everything that is not part of the demo. Turn off notifications.
- Say "Who am I?" — it should answer "This is Demo's session."
- Check the Chrome extension icon is green.

## The script

| # | Say | What the audience sees | Narration |
|---|---|---|---|
| 1 | "Switch to Word" | Word comes to the front. The overlay shows *Heard: "Switch to Word"* and *✓ Done*. | The overlay always shows what it heard and whether it worked — the student never has to guess. |
| 2 | "Dictate. My name is Demo and I study in Kisumu." Then keep talking: "Today we learned about photosynthesis." | Each sentence is typed when the speaker pauses, in order, with capitals and full stops. | Talk naturally; it types when you stop. The student's own words are spelled right. |
| 3 | "Select all." then "Bold." then "Stop dictation." | The text is selected and made bold; AbleSpeak says dictation is off. | Editing commands work in the middle of dictation. To run any other command without leaving it, start with the name: "AbleSpeak, open Chrome." |
| 4 | "Open my email and find the message from John" | The overlay shows the plan and each step; AbleSpeak reads John's message aloud. | This is Tier 2: AbleSpeak reads the screen through each app's own controls, plans the steps, and checks each one worked. |
| 5 | "Reply to John and send it" | It pauses: "Send this? … say yes." Say **"no"**. | Anything that can't be undone asks first. |
| 6 | "Start my homework" | Word, Chrome and a YouTube search open in turn. | A teacher set this routine up once for this student. |
| 7 | (Presenter) open the dashboard's **Teacher** page | "Who is using this computer", "How well AbleSpeak hears them", Demo's settings. | Every command is saved against the student, so a teacher sees real progress — and retries before and after a settings change. |

## If something goes wrong

- It did the wrong thing: say **"Undo that"** or **"No, I meant …"** — this is
  part of the story, so narrate it.
- A task is taking too long: say **"Stop"**. The overlay says how far it got.
- It stops hearing you: say **"Wake up"**, or click the microphone once.
- The browser does nothing: the extension has disconnected; reopen Chrome.

## Recording

Record the screen and the room audio together (Windows Game Bar, Win+G), so
the recording shows the voice and the result at the same time. Keep the
recording with the date and the laptop used; it is evidence for the
applications.
