/**
 * Uzbek date, relative-time and number formatting.
 *
 * Chromium ships without Uzbek CLDR data, so `Intl` renders "2026 M10 4" and
 * "yesterday" for `uz`. These formatters follow the CLDR Uzbek (Latin)
 * patterns ("4-okt, 2026, 14:05", "6 daqiqa oldin", "12 345,67") so the
 * primary language looks right in every browser.
 */

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const MONTHS_SHORT = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
const WEEKDAYS = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];

const pad = (value: number): string => String(value).padStart(2, '0');

/** The wall-clock fields of `date` in `timeZone` (the browser's zone when omitted). */
export function zonedParts(date: Date, timeZone?: string): { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number } {
  if (timeZone === undefined) {
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), weekday: date.getDay(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() };
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '0';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(read('year')),
    month: Number(read('month')) - 1,
    day: Number(read('day')),
    weekday: Math.max(0, weekdays.indexOf(read('weekday'))),
    hour: Number(read('hour')) % 24,
    minute: Number(read('minute')),
    second: Number(read('second')),
  };
}

export function formatUzDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  const d = zonedParts(date, options.timeZone);
  const hasDate = options.dateStyle !== undefined || options.day !== undefined || options.month !== undefined || options.year !== undefined;
  const hasTime = options.timeStyle !== undefined || options.hour !== undefined || options.minute !== undefined;
  const full = options.dateStyle === 'full' || options.dateStyle === 'long';
  const parts: string[] = [];

  if (hasDate) {
    const month = full || options.month === 'long' ? MONTHS[d.month]! : MONTHS_SHORT[d.month]!;
    const dayMonth = `${d.day}-${month}`;
    const withYear = options.dateStyle !== undefined || options.year !== undefined;
    if (options.dateStyle === 'full' || options.weekday !== undefined) parts.push(WEEKDAYS[d.weekday]!);
    parts.push(dayMonth);
    if (withYear) parts.push(String(d.year));
  }
  if (hasTime) {
    const seconds = options.timeStyle === 'medium' || options.timeStyle === 'long' || options.second !== undefined;
    parts.push(`${pad(d.hour)}:${pad(d.minute)}${seconds ? `:${pad(d.second)}` : ''}`);
  }
  return parts.join(', ');
}

const UNITS: Record<Intl.RelativeTimeFormatUnit, string> = {
  year: 'yil',
  years: 'yil',
  quarter: 'chorak',
  quarters: 'chorak',
  month: 'oy',
  months: 'oy',
  week: 'hafta',
  weeks: 'hafta',
  day: 'kun',
  days: 'kun',
  hour: 'soat',
  hours: 'soat',
  minute: 'daqiqa',
  minutes: 'daqiqa',
  second: 'soniya',
  seconds: 'soniya',
};

export function formatUzRelative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  if (unit === 'day' && value === -1) return 'kecha';
  if (unit === 'day' && value === 1) return 'ertaga';
  if (value === 0) return unit === 'day' ? 'bugun' : 'hozir';
  const amount = formatUzNumber(Math.abs(value));
  // Uzbek suffixes attach to the noun: "3 soatdan keyin" (future), "6 daqiqa oldin" (past).
  return value < 0 ? `${amount} ${UNITS[unit]} oldin` : `${amount} ${UNITS[unit]}dan keyin`;
}

/** Group with a non-breaking space and use a decimal comma, as CLDR prescribes for Uzbek. */
export function formatUzNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat('en-US', options)
    .formatToParts(value)
    .map((part) => (part.type === 'group' ? ' ' : part.type === 'decimal' ? ',' : part.value))
    .join('');
}
