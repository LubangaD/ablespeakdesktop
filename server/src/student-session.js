/**
 * Who is using this computer (AT-50).
 *
 * The user is whoever is signed in to Windows: their own profile opens when
 * AbleSpeak starts (made on first use). An admin can still switch to another
 * saved profile. The choice is saved on the device, so it survives a restart,
 * and each sitting is a session row tied to that user. Every voice command
 * records the user and session directly, which is what progress measures.
 * (Code and data still say "student"; people see "user".)
 */
import { v4 as uuidv4 } from 'uuid';
import { getDeviceState, setDeviceState, getStudent, addStudent, insertSession, endSession, closeAbandonedSessions } from './db.js';
import { localDateTime } from './local-time.js';
import { isSharedComputer, isGuestAccountName } from './shared-computer.js';

const ACTIVE_STUDENT_KEY = 'active_student_id';

let current = null; // { id, studentId, startedAt }

function beginSession(studentId) {
  if (current) endSession(current.id, localDateTime());
  current = { id: `session-${uuidv4()}`, studentId, startedAt: localDateTime() };
  insertSession({ id: current.id, started_at: current.startedAt, student_id: studentId });
  return current;
}

/**
 * Start this run's session for the saved user, if there is one. Given the
 * Windows account (`windowsAccount`), a computer with nobody saved opens
 * straight into that person's own profile, made on first use: whoever is
 * signed in to Windows is the user, and nobody has to be chosen.
 *
 * Shared-computer safety (Phase 2 Step 1): on a device an admin has marked as
 * shared, Windows-name linking is switched off entirely — a lab PC's "amina.k"
 * account is still shared by whoever is at the keyboard today, so it must
 * never open or create a real profile. An earlier saved choice is also
 * cleared at the start of every run, so the previous learner's profile never
 * carries over to the next one; an admin can still choose someone for just
 * this run (setActiveStudent). A Windows account whose name is clearly
 * generic (Guest, Visitor, DefaultUser0…) is treated the same way even on an
 * unmarked, ordinary computer.
 */
export function startDeviceSession({ windowsAccount = null } = {}) {
  closeAbandonedSessions();
  const shared = isSharedComputer();
  if (shared) setDeviceState(ACTIVE_STUDENT_KEY, null); // never carry a learner over to the next sitting
  const saved = Number(getDeviceState(ACTIVE_STUDENT_KEY));
  let student = Number.isInteger(saved) && saved > 0 ? getStudent(saved) : null;
  const skipWindowsProfile = shared || isGuestAccountName(windowsAccount);
  if (!student && windowsAccount && !skipWindowsProfile) student = profileForWindowsUser(windowsAccount);
  setDeviceState(ACTIVE_STUDENT_KEY, student ? student.id : null); // null if the saved one was removed
  beginSession(student?.id ?? null);
  return getActiveStudent();
}

/** The profile linked to a Windows account, made (and linked) the first time. */
export function profileForWindowsUser(account) {
  const key = `windows_user:${String(account).toLowerCase()}`;
  const linked = Number(getDeviceState(key));
  const existing = Number.isInteger(linked) && linked > 0 ? getStudent(linked) : null;
  if (existing) return existing;
  const profile = addStudent({ name: displayNameFor(account) });
  setDeviceState(key, profile.id);
  return profile;
}

/** "amina.k" → "Amina K", "john_doe" → "John Doe": a Windows account name to show. */
export function displayNameFor(account) {
  const words = String(account || '').split(/[\s._-]+/).filter(Boolean);
  const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return name.slice(0, 40) || 'Me';
}

/** Close the current session (app quitting). */
export function endDeviceSession() {
  if (current) endSession(current.id, localDateTime());
  current = null;
}

/**
 * Switch who is using this computer; null means nobody in particular.
 * Always starts a new session, so two students' use never shares one.
 */
export function setActiveStudent(studentId) {
  const student = studentId == null ? null : getStudent(Number(studentId));
  if (studentId != null && !student) throw new Error('Student not found');
  setDeviceState(ACTIVE_STUDENT_KEY, student ? student.id : null);
  beginSession(student?.id ?? null);
  return getActiveStudent();
}

export function getActiveStudent() {
  const student = current?.studentId != null ? getStudent(current.studentId) : null;
  return {
    student: student ? { id: student.id, name: student.name } : null,
    sessionId: current?.id ?? null,
    startedAt: current?.startedAt ?? null,
  };
}

/** What every voice command is saved with. */
export function commandAttribution() {
  return { session_id: current?.id ?? null, student_id: current?.studentId ?? null };
}
