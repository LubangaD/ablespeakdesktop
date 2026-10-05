/**
 * Spoken app names → Windows programs, and picking the window a student means.
 *
 * Students say "my Word document" or "the spreadsheet", not "WINWORD", and
 * Gemini often hears "Word" as "one". Kept free of system calls so the
 * matching can be tested on its own.
 */

const APPS = [
  {
    // /w opens a blank document straight away. Without it Word lands on its
    // Start screen, and the student has to click the "Blank document" tile —
    // a surface we do not navigate.
    app: 'Word', processes: ['winword'], launch: 'start winword /w',
    names: /^(?:microsoft |ms )?(?:word|one)(?: documents?| docs?| files?)?$|^(?:documents?|docs?)$/,
  },
  {
    app: 'Excel', processes: ['excel'], launch: 'start excel',
    names: /^(?:microsoft |ms )?excel(?: sheets?| spreadsheets?| files?| workbooks?)?$|^(?:spreadsheets?|workbooks?)$/,
  },
  {
    app: 'PowerPoint', processes: ['powerpnt'], launch: 'start powerpnt',
    names: /^(?:microsoft |ms )?power ?point(?: slides?| presentations?| files?)?$|^(?:slides?|presentations?)$/,
  },
  {
    app: 'Outlook', processes: ['outlook', 'olk'], launch: 'start outlook',
    names: /^(?:microsoft |ms )?outlook$/,
  },
  { app: 'Notepad', processes: ['notepad'], launch: 'notepad', names: /^note ?pad$/ },
  {
    app: 'File Explorer', processes: ['explorer'], launch: 'explorer',
    names: /^(?:file explorer|files|folders?|explorer|windows explorer)$/,
  },
  { app: 'VS Code', processes: ['code'], launch: 'code', names: /^(?:vs ?code|visual studio code)$/ },
  { app: 'Teams', processes: ['ms-teams', 'teams'], launch: 'start msteams:', names: /^(?:microsoft |ms )?teams$/ },
];

// Words that surround an app name without being part of it.
const FILLER_RE = /\b(?:the|my|a|an|on|up|to|app|application|program|window)\b/g;

// Windows that are never what a student means by "bring X to the front".
const IGNORED_TITLES = /^(?:Program Manager|Windows Input Experience|AbleSpeak.*)$/i;

/**
 * Normalise a spoken app name and look it up.
 * Returns { query, app, processes, launch } — `app` is null for names we
 * don't know, which are then matched against window titles and processes.
 */
export function resolveAppName(spoken) {
  const query = String(spoken || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const known = APPS.find(entry => entry.names.test(query));
  return {
    query,
    app: known?.app || null,
    processes: known?.processes || [],
    launch: known?.launch || null,
  };
}

/**
 * Choose the window to bring forward. `windows` is in Windows' front-to-back
 * order, each { hwnd, process, title }. Returns the window or null.
 *
 * Known apps match by program, so "Word" never picks a browser tab whose
 * title happens to contain "word". Other names match a document or window
 * title first ("bring my essay to the front"), then a program name.
 */
export function pickWindow(windows, spoken) {
  const { query, processes } = resolveAppName(spoken);
  if (!query) return null;
  const candidates = windows.filter(w => w.title && !IGNORED_TITLES.test(w.title.trim()));
  const proc = w => String(w.process || '').toLowerCase();
  const title = w => w.title.toLowerCase();

  if (processes.length) {
    return candidates.find(w => processes.includes(proc(w))) || null;
  }

  const compact = query.replace(/[\s-]/g, '');
  const words = query.split(' ');
  return candidates.find(w => proc(w) === compact)
    || candidates.find(w => title(w).includes(query))
    || candidates.find(w => proc(w).includes(compact))
    || candidates.find(w => words.every(word => title(w).includes(word)))
    || null;
}

/**
 * A window title short enough to say aloud: "Essay - Word" → "Essay in Word",
 * "notepad - Read-Only - Last saved by user - Word" → "notepad in Word".
 */
export function spokenWindowName(title) {
  const parts = String(title || '').split(/\s+[-—–]\s+/).map(p => p.replace(/[‪-‮]/g, '').trim()).filter(Boolean);
  if (!parts.length) return '';
  const name = parts.length > 1 ? `${parts[0]} in ${parts[parts.length - 1]}` : parts[0];
  return name.length > 60 ? `${name.slice(0, 57)}...` : name;
}
