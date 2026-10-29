# The agent evaluation: setting up the test laptop

The evaluation (`run.mjs`) opens apps, types, clicks and uses whatever Chrome and Edge windows are open. Run it on a laptop nobody is working on, in a Windows account made for it, so it never touches anyone's own windows and the results don't depend on what was open.

## One-time setup

1. **A Windows account for the test.** Create a local account called `ablespeak-eval` and sign in to it. Everything below is done in that account.
2. **Install AbleSpeak** from the installer, or run the dev app (`npm run desktop` in `server/`). Add the AI key in Settings.
3. **Chrome:** install Chrome, load the AbleSpeak extension (`chrome-integration-master/`) and leave Chrome open with one tab, so the extension is connected.
4. **Edge:** open it once and close its first-run pages.
5. **Notepad:** Settings (the gear in Notepad) → *When Notepad starts* → **Open a new window**, so it never brings back the previous test's tabs. On the test account, also run with `--fresh-notepad`, which forgets Notepad's unsaved tabs before each run.
6. **Word and Excel:** open each once, sign in, and close the Start screen so they open straight into a blank document (`INSTALL-FOR-TEACHERS.md`, step 6, for Excel).
7. **Spotify:** install it and sign in; the Spotify task is the weak-accessibility case and is expected to fail until that is fixed.
8. **Sleep and lock:** set the screen never to turn off or lock while the test account is signed in (Settings → System → Power), or the test clicks a lock screen.

## Running it

```
cd server
node tools/agent-eval/run.mjs --live --yes --runs 3 --label <version>
```

Three runs of the 26 tasks take about an hour. Results go to `docs/measurements/agent-eval-<date>-<version>.md` with the lowest, typical and highest result across runs.

## Running it on a schedule

In the test account, make a scheduled task that runs the three runs each night, after a `git pull` on the branch under test:

```
schtasks /create /tn "AbleSpeak agent eval" /sc daily /st 22:00 /tr "cmd /c cd /d D:\ablespeak\tier2\ablespeakdesktop\server && git pull && node tools\agent-eval\run.mjs --live --yes --runs 3 --label nightly > tools\agent-eval\last-run.log 2>&1"
```

AbleSpeak must already be running in that account (it starts with Windows once installed), and the account must stay signed in with the screen unlocked.

## What a live run does to the machine

- Opens and closes Notepad, Calculator, File Explorer, Settings, Word, Excel and Spotify; apps that were already open are left open.
- Uses the open Chrome and Edge windows for the browser tasks.
- Makes `ablespeak-eval.txt` and `ablespeak-eval.pdf` in Documents, and deletes `eval-saved.txt` there before each run.
- Word and Excel are asked to quit without saving, never killed, so they don't offer to recover a document next time.
- Speech from the room is ignored while a run is going (and for 30 s after each task).
