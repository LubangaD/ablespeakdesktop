# Setting up AbleSpeak on a student's computer

This guide is for the teacher or helper who sets AbleSpeak up. You do it
once, and it takes about 30 minutes. After that, AbleSpeak starts by itself
every day, and the student controls the computer by speaking. Nobody needs
to use the mouse in the daily routine.

## What you need

- A Windows 10 or Windows 11 computer with internet
- Google Chrome installed
- A microphone. A headset microphone works best in a noisy classroom.
- A Google account, to get a free AbleSpeak key (step 2)
- The AbleSpeak installer file, called `AbleSpeak Setup` followed by a
  version number. Your AbleSpeak contact sends you this file.

## Step 1 — Install AbleSpeak

1. Double-click the `AbleSpeak Setup` file.
2. If a blue box says **Windows protected your PC**, click **More info**, then
   **Run anyway**. If Windows asks "Do you want to allow this app to make
   changes?", click **Yes**.
3. Keep the suggested choices and click **Next** until you see **Install**.
   Click **Install**, then click **Finish**.
4. AbleSpeak opens. You will see:
   - a small dark panel with a microphone button near the bottom of the
     screen. This is **the overlay**, the only part the student uses.
   - a larger window called **AbleSpeak — Voice Command Center**. This is
     **the dashboard**, the part you use.
5. A message says AbleSpeak needs an API key. Click **Later** and go to
   step 2.

If the dashboard is closed, you can open it again. Right-click the AbleSpeak
icon near the clock (click the small arrow `^` to show hidden icons), then
choose **Show AbleSpeak**.

## Step 2 — Add the AbleSpeak key

AbleSpeak uses Google's Gemini service to understand speech. It needs a key,
which works like a password for that service.

1. In Chrome, go to **aistudio.google.com/apikey** and sign in with the
   Google account.
2. Click **Create API key**, then click **Copy**.
3. The first time only: right-click the AbleSpeak icon near the clock and
   choose **Set admin PIN…**. The dashboard opens and asks for a PIN of 4 to
   8 digits. Choose one only teachers know, type it twice and click **Save
   PIN and open**. (Setting the first PIN only works from the tray icon, so
   a student using the dashboard by voice can't set one.)
4. After that, open these pages with the small **Admin** link at the bottom
   of the dashboard's menu and the PIN. Settings and Developer Hub always
   need it, so students can't change the keys, even by voice. After 15
   minutes they lock again.
5. Under **API keys**, find **Google Gemini**. Paste the key into its box
   and click **Save key**.
5. Wait for the green message saying the key works. If it says the key was
   refused, copy it again from Google and paste it again.

## Step 3 — Let AbleSpeak use the microphone

1. Open the Windows **Start** menu and click **Settings**.
2. Go to **Privacy & security**, then **Microphone**.
3. Turn on **Microphone access**. Also turn on **Let desktop apps access
   your microphone**.
4. If the student uses a headset, plug it in. Then in **Settings → System →
   Sound**, choose it under **Input**.

## Step 4 — Connect Chrome

This lets the student browse the web by voice.

1. Right-click the AbleSpeak icon near the clock and choose **Show Chrome
   Extension Folder**. A folder opens. Click the bar at the top of that
   window that shows the folder's location, and copy the text (Ctrl+C).
2. Open Chrome. In the address bar, type `chrome://extensions` and press
   Enter.
3. Turn on **Developer mode**, top right.
4. Click **Load unpacked**. In the window that opens, click the location bar
   at the top, paste (Ctrl+V), press Enter, then click **Select Folder**.
5. **AbleSpeak Browser Integration** now appears in the list. Click the
   puzzle-piece icon next to Chrome's address bar, then the pin next to
   AbleSpeak, so its icon stays visible. The icon turns green when
   AbleSpeak is connected.
6. If Chrome ever asks whether to keep extensions in developer mode, choose
   to keep them.

## Step 5 — Tell AbleSpeak who the student is

AbleSpeak records each student's progress separately, so it needs to know
who is using this computer.

1. In the dashboard, click **Teacher** on the left.
2. Under **Who is using this computer**, type the student's first name or
   initials in **Add a student** and click **Add student**.
3. Choose the student in **Student at this computer** and click **Start
   their session**.

AbleSpeak remembers this choice, including after the computer restarts. You
only need to do it again when a different student uses the computer. The
overlay shows whose session it is, for example "Amina's session".

## Step 6 — Check it works

Sit the student in front of the computer, or try it yourself. The
microphone button pulses green while AbleSpeak is listening. Say each of
these, waiting for the result before saying the next:

| Say | What should happen |
|---|---|
| "Who am I?" | AbleSpeak says whose session it is |
| "Open Chrome" | Chrome comes to the front |
| "Scroll down" | The page in Chrome scrolls |
| "Dictation" | AbleSpeak says dictation is on. Open a document and speak a sentence: it is typed when you pause |
| "Stop dictation" | AbleSpeak goes back to commands |

After every command, the overlay shows what it heard ("Heard: …") and how
it ended:

- **✓ Done** — it worked
- **✗ Didn't work** — it did not work, and AbleSpeak says so out loud
- **Ignored** — it treated the sound as background talk

If all five work, setup is finished.

## The daily routine

- When the computer starts and someone signs in, AbleSpeak opens by itself
  and starts listening. The student does not need a keyboard, mouse or
  shortcut.
- The student can say **"Go to sleep"** to pause AbleSpeak (for example
  during a lesson) and **"Wake up"** to start again.
- **"Stop"** cancels whatever is happening. **"Undo that"** reverses the
  last action.
- Before anything that cannot be undone, such as closing a window,
  deleting or sending, AbleSpeak asks first. The student answers "yes" or
  "no".

**When an adult is needed:**

- **Signing in to Windows.** For a student who cannot type a password, set
  up **Windows Hello face sign-in** (Settings → Accounts → Sign-in options),
  if the computer has a suitable camera.
- **A different student** sits at the computer. Choose them on the Teacher
  page (step 5).
- **The overlay says "No student chosen"**, or shows the wrong name.

## If something goes wrong

| What you see | What to do |
|---|---|
| Nothing happens when the student speaks | Check the microphone button is pulsing green. If it is grey, click it once. Check step 3. |
| The overlay says "Ignored" a lot | AbleSpeak is hearing background talk. A headset microphone helps. |
| "Didn't work" for web pages | Check the AbleSpeak icon in Chrome is green. If not, close and reopen Chrome. |
| AbleSpeak does not speak or understand at all | Click **Admin** in the dashboard, enter the PIN, and check the Gemini key (step 2). |
| You forgot the admin PIN | Open AbleSpeak's `.env` file in Notepad (usually `%APPDATA%\AbleSpeak\.env`; paste that into the File Explorer address bar), delete the line that starts with `ADMIN_PIN_HASH=`, save, and restart AbleSpeak. Then set a new one with **Set admin PIN…** on the tray icon. |
| The overlay has disappeared | Say "Come back". Or press Ctrl+Shift+A. Or right-click the AbleSpeak icon near the clock and choose **Voice Overlay**. |
| The student's work is being recorded under the wrong name | Choose the right student on the Teacher page (step 5). |

## Privacy

- To understand speech, AbleSpeak sends each spoken command to Google's
  Gemini service. For commands it has to think about, it also sends a
  picture of the screen. The student can say **"Privacy mode"** to stop
  screen pictures being sent and **"Vision on"** to allow them again.
- Students' names and progress data stay on this computer. The Teacher page
  only opens on this computer itself.
- Before using AbleSpeak with a student under 18, get written consent from
  their parent or guardian, and the student's own agreement.
