/**
 * Who is using this computer (AT-50).
 *
 * A teacher picks the student on the Teacher page. The choice is saved on the
 * device, so it survives an app restart, and each sitting is a session row
 * tied to that student. Every voice command records the student and session
 * directly, which is what the progress engine measures.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDeviceState, setDeviceState, getStudent, insertSession, endSession, closeAbandonedSessions } from './db.js';
import { localDateTime } from './local-time.js';

const ACTIVE_STUDENT_KEY = 'active_student_id';

let current = null; // { id, studentId, startedAt }

function beginSession(studentId) {
  if (current) endSession(current.id, localDateTime());
  current = { id: `session-${uuidv4()}`, studentId, startedAt: localDateTime() };
  insertSession({ id: current.id, started_at: current.startedAt, student_id: studentId });
  return current;
}

/** Start this run's session for the saved student, if there is one. */
export function startDeviceSession() {
  closeAbandonedSessions();
  const saved = Number(getDeviceState(ACTIVE_STUDENT_KEY));
  const student = Number.isInteger(saved) && saved > 0 ? getStudent(saved) : null;
  if (!student) setDeviceState(ACTIVE_STUDENT_KEY, null); // the student was removed
  beginSession(student?.id ?? null);
  return getActiveStudent();
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
