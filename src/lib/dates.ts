// Date helpers. Calendar days are plain YYYY-MM-DD strings in local time.

const pad = (n: number) => String(n).padStart(2, '0');

export const toIsoDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromIsoDate = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (iso: string, n: number): string => {
  const d = fromIsoDate(iso);
  d.setDate(d.getDate() + n);
  return toIsoDate(d);
};

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The seven days (Monday first) of the week containing `now`. */
export function weekOf(now: Date): string[] {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(toIsoDate(monday), i));
}

/** "Mon 23" */
export const dayLabel = (iso: string): string => {
  const d = fromIsoDate(iso);
  return `${WD[d.getDay()]} ${d.getDate()}`;
};

/** "Monday, 23 November" */
export const longDate = (d: Date): string => `${WD_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;

/** "23 Nov 2026" */
export const shortDate = (d: Date): string => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;

/** "23 December 2026" */
export const fullDate = (d: Date): string => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

export const greeting = (d: Date): string => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 18 ? 'Good afternoon' : 'Good evening');

/** Compact timestamp: "Just now", "09:12", "Yesterday", "Fri", then a date. */
export function relTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000 && diff > -60_000) return 'Just now';
  const dayDiff = Math.round((fromIsoDate(toIsoDate(now)).getTime() - fromIsoDate(toIsoDate(d)).getTime()) / 86_400_000);
  if (dayDiff === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff > 1 && dayDiff < 7) return WD[d.getDay()];
  return shortDate(d);
}

/** "Today 03:00", "Yesterday 03:00", or a date. */
export function backupTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (Math.abs(now.getTime() - d.getTime()) < 60_000) return 'Just now';
  const dayDiff = Math.round((fromIsoDate(toIsoDate(now)).getTime() - fromIsoDate(toIsoDate(d)).getTime()) / 86_400_000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return dayDiff === 0 ? `Today ${hm}` : dayDiff === 1 ? `Yesterday ${hm}` : `${shortDate(d)} ${hm}`;
}

/** "Today", "Tomorrow", "Yesterday" or a short date for a task's due day; the older free-text label otherwise. */
export function dueLabel(t: { due: string; dueDate?: string | null }, now = new Date()): string {
  if (!t.dueDate) return t.due;
  const today = toIsoDate(now);
  if (t.dueDate === today) return 'Today';
  if (t.dueDate === addDays(today, 1)) return 'Tomorrow';
  if (t.dueDate === addDays(today, -1)) return 'Yesterday';
  const d = fromIsoDate(t.dueDate);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}
