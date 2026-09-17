/**
 * Dates in this computer's time zone, in the same shape SQLite writes with
 * datetime('now','localtime'). Commands are stored in local time, so days
 * must be counted in local time too: in Nairobi, toISOString() puts anything
 * said before 3 a.m. on the previous day.
 */

const pad = n => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:MM:SS" in local time */
export function localDateTime(date = new Date()) {
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** "YYYY-MM-DD" in local time */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local calendar day `days` after an ISO day ("YYYY-MM-DD"). */
export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
}
