# AbleSpeak Exams: a guide for teachers and invigilators

*How to run an exam by voice with AbleSpeak on a Windows computer. Written for teachers, invigilators and anyone supporting a student. Version of 13 October 2026.*

AbleSpeak lets a student who is blind, has low vision, or cannot use a keyboard or mouse sit an exam by speaking. You give AbleSpeak the exam paper. It reads each question aloud, the student says the answer, and AbleSpeak writes the answer down exactly as said. When the exam ends, you download the completed script as a Word document and mark it as usual.

During an exam, AbleSpeak's AI assistant, the web and every other tool are switched off. The student can only hear the questions, move between them and give answers.

> **Use it for classwork, practice papers and mock exams.** AbleSpeak needs the internet during an exam and sends the student's voice to an online service to be turned into text. That is not yet acceptable for formal national exams. See [Limits](#8-limits-you-should-know).

---

## 1. Before the first exam

You need:

- **A Windows computer with AbleSpeak installed and running**, with a working microphone and speakers or headphones. Headphones are best: they stop the microphone hearing AbleSpeak's own voice.
- **An internet connection** for the whole exam.
- **Access to the Exams page.** It is in the **Helper** section of AbleSpeak's menu. It opens for a signed-in helper or admin account, or with the helper or admin PIN.
- **The student added on the Users page**, so their name appears on the script.
- **A quiet room.** Other voices can be picked up as the student's.

Let the student **practise first**. Run a short practice paper so they learn the commands before any exam that matters. Give them the list in [section 5](#5-what-the-student-can-say).

## 2. Prepare the paper

AbleSpeak reads Word documents (`.docx`) and PDFs saved from Word. A Word document works best.

It finds questions by their numbers, so a clearly numbered paper reads well:

| In the paper | AbleSpeak understands it as |
|---|---|
| `1.` `2.` `3.` or `Question 1` | questions |
| `(a)` `(b)` and `(i)` `(ii)` | parts and sub-parts of a question |
| `A.` `B.` `C.` `D.` | the choices of a multiple-choice question |
| `(2 marks)` `(2 mks)` `[2]` | the marks |
| `SECTION A`, `SECTION B` | sections |

Things to do before you add the paper:

- **Describe every picture, diagram, graph and map in words** inside the question. AbleSpeak cannot read pictures. If a picture cannot be described fairly, arrange a human reader for that question.
- **Number questions in order.** If each section starts again from 1, AbleSpeak calls them A1, A2, B1 and so on.
- **Do not upload a scanned paper.** A photo or scan of a page has no text in it. Use the original Word file.
- **Old `.doc` files** must be saved again as `.docx` (in Word: File → Save As → Word Document).
- **Tables** are read row by row. Simple tables work; complicated ones are better rewritten as sentences.
- **PDFs in two columns** can come out with lines mixed up. Use the Word file instead.

## 3. Add the paper and check it

### Add it

There are two ways. Use whichever is easier.

- **The exam folder.** Save or copy the paper into `Documents\AbleSpeak Exams`. Within a few seconds it appears on the Exams page under **Exam papers**. The **Open the folder** button on the Exams page takes you there.
- **Upload.** On the Exams page, under **Or upload a paper here**, choose the file, set the time allowed if there is one, and press **Upload and check**.

If AbleSpeak cannot read a file, it tells you why and what to do (for example, "this PDF is probably a scanned picture — upload the Word file").

### Check it

This step matters. What you see here is exactly what the student will hear.

1. On the paper's row, press **Check questions**.
2. Read the list at the top, if there is one. AbleSpeak points out things it is unsure of: a picture it cannot read, numbering that skips, a question with only one choice.
3. Read through every question. Fix any that were split wrongly, add descriptions for pictures, and correct marks or choices.
4. Set the **time allowed** in minutes, or leave it empty for no time limit. Include any extra time the student is entitled to.
5. Leave **Read answers back** ticked for a blind student. AbleSpeak then repeats each piece of the answer as it writes it. You may untick it for a student who can see the screen.
6. Press **Save changes** (or **Checked — save**).

A paper that came from the exam folder cannot be started until you have checked and saved it.

## 4. Start the exam

1. Seat the student at the computer with the microphone on. If the small AbleSpeak voice bar is not showing, press **Ctrl+Shift+A**.
2. On the Exams page, on the paper's row, choose the student and press **Start exam**.
3. The screen changes to the **exam screen**, and AbleSpeak says the name of the exam, how many questions there are, the time allowed, and reads question 1.

Only one exam can run on a computer at a time.

The exam screen shows the current question and the answer as it is written, in large print, with the time left. **A−** and **A+** at the bottom change the text size.

## 5. What the student can say

The student speaks, then waits for AbleSpeak to reply. While AbleSpeak is speaking it is not listening, so the student should let it finish.

### Hearing and moving

| To… | Say |
|---|---|
| Hear the question again | "read the question" or "repeat" |
| Hear the choices | "read the options" |
| Go on or back | "next" · "previous" |
| Jump to a question | "go to question 5" · "go to question 2 b" |
| First or last question | "first question" · "last question" |
| Slower or faster reading | "slower" · "faster" · "normal speed" |
| Know where you are | "where am I" |
| Know the time | "how much time is left" |
| Know what is unanswered | "unanswered questions" |
| Hear the instructions | "read the instructions" |
| Hear the commands | "help" |

### Answering

| To… | Say |
|---|---|
| Choose in multiple choice | "answer B" (or just "B") |
| Start a written answer | "answer" |
| Finish a written answer | "done" |
| Hear what is written | "read my answer" · "read the last sentence" |
| Remove a mistake | "delete the last word" · "delete the last sentence" |
| Take back the last change | "undo" |
| Start the answer again | "clear my answer" (AbleSpeak asks first) |
| Write a word letter by letter | "spell m, i, t, o" |
| Hear the spelling | "spell my answer" · "spell the last word" |
| Punctuation | "full stop" · "comma" · "question mark" · "new line" · "new paragraph" · "open bracket" · "close bracket" |
| Maths | "maths on", then "x squared plus three equals twelve" · "maths off" |

A written answer goes like this:

> **Student:** "Answer."
> **AbleSpeak:** "Answering Question 2, part a. Speak your answer. Say done when you have finished."
> **Student:** "Osmosis is the movement of water across a membrane full stop."
> **AbleSpeak:** "Written: Osmosis is the movement of water across a membrane."
> **Student:** "Done."
> **AbleSpeak:** "Answer saved for Question 2, part a. Say next for the next question."

Good to know:

- **Between "answer" and "done", everything is written**, in as many sentences as the student likes. They can pause between sentences.
- **A single word said on its own is always written** while answering. Commands there need more than one word, such as "read my answer". The exceptions are "done" and "undo".
- **AbleSpeak writes what was said, not what was meant.** It does not fix spelling, grammar or wording. If a word comes out wrong, the student deletes it and says it again, or spells it.
- **If AbleSpeak does not understand a clip**, it says "I did not catch that clearly. Please say it again." Nothing is dropped silently.

### Finishing

The student says **"finish exam"**. AbleSpeak says how many questions have no answer and asks whether to finish. Only a plain **"yes"** ends the exam. Anything else carries on.

## 6. During the exam: the invigilator

At the bottom of the exam screen:

- **Pause** stops the clock, for a break or an interruption. AbleSpeak tells the student the exam is paused. **Carry on** restarts it.
- **End exam** ends it now. The answers so far are kept. This cannot be undone.

AbleSpeak announces when 30, 15, 5 and 1 minutes are left. When the time runs out it ends the exam and tells the student their answers are saved.

Your role is the same as with a human reader or scribe: do not explain questions or prompt answers. You may describe a picture if that was arranged, and you may help if the equipment fails.

**If something goes wrong**

| What happened | What to do |
|---|---|
| The computer or AbleSpeak closed | Open AbleSpeak, go to Exams → **Sittings and scripts**, and press **Carry on** on the student's row. The answers are there, and the time lost is not counted. |
| The internet dropped | AbleSpeak says it cannot hear answers and that the answers so far are saved. Pause the exam, restore the connection, then carry on. |
| AbleSpeak keeps mishearing a word | The student can spell it: "spell" and the letters. |
| AbleSpeak does not respond | Check the microphone is on (the voice bar shows it). Press Ctrl+Shift+A if the voice bar is hidden. |
| AbleSpeak is reading and needs to stop | Click the red stop button on the voice bar. |
| The student is struggling with the commands | Pause, remind them of "help", and carry on. For a first exam, keep the command list beside you. |

## 7. After the exam: download the script

1. Go to the **Exams** page and scroll to **Sittings and scripts**. Each row is one student's sitting.
2. On the student's row, press **Script (Word)**. A Word document is saved to the Downloads folder, named after the exam, the student and the date.
3. Print or share it for marking as you would any script.

The script has:

- a cover page: the student, start and end times, how the exam ended, and how many questions were answered;
- a statement of how the script was produced, and a line for the invigilator's name and signature;
- every question, each followed by the student's answer exactly as it was written, or "No answer given."

**Audit trail**, next to it, downloads a record of the whole sitting: everything AbleSpeak heard, wrote and said, with the time of each. Keep it with the script. If anyone asks how an answer was produced, it shows what happened. The cover page says whether this record is intact.

The status column shows **Finished**, **Time ran out**, **Ended by invigilator** or **Not finished**.

## 8. Limits you should know

- **Not yet for formal national exams.** AbleSpeak needs the internet and sends the student's voice to an online service (Google Gemini) to be turned into text. Exam boards normally require no internet during an exam. A version that works offline is planned.
- **Consent.** Because a child's voice leaves the computer, get the consent of a parent or guardian before use, in line with your school's data protection policy.
- **Pictures and diagrams** are not read. Describe them in words or arrange a human reader.
- **Maths** covers common spoken forms only: plus, minus, times, divided by, equals, squared, cubed, square root, powers. Check with the maths teacher that it suits the paper.
- **Unclear or very quiet speech** is recognised less well. For students whose speech is hard to recognise, keep a human scribe available.
- **Accuracy is not perfect.** Read-back lets the student catch mistakes. Encourage them to use "read my answer" before moving on.
- **Windows only.**

## 9. Quick checklist

**Before**
- [ ] Paper is a Word document, numbered clearly, with pictures described in words
- [ ] Paper added, checked question by question, and saved
- [ ] Time allowed set, including any extra time
- [ ] Student is on the Users page and has practised the commands
- [ ] Microphone, headphones and internet working; room quiet
- [ ] Parent or guardian consent on file

**During**
- [ ] Start exam for the right student
- [ ] Pause for breaks; do not prompt or explain

**After**
- [ ] Download **Script (Word)** and **Audit trail**
- [ ] Sign the cover page

---

*For how exam mode is built, see [AbleSpeak-Exam-Mode.md](AbleSpeak-Exam-Mode.md).*
