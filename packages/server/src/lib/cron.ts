/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week),
 * evaluated in UTC.
 *
 * Supports `*`, lists (`1,15`), ranges (`1-5`), steps (`*\/10`, `0-30/5`),
 * month and weekday names, and the usual `@hourly`-style aliases. When both
 * day-of-month and day-of-week are restricted, a day matches if either does
 * (the classic Vixie cron rule).
 */

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

export class CronError extends Error {
  override name = 'CronError';
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseValue(token: string, min: number, names: string[] | null): number {
  const lower = token.toLowerCase();
  if (names !== null) {
    const index = names.indexOf(lower);
    if (index !== -1) return index + min;
  }
  if (!/^\d+$/.test(token)) throw new CronError(`Invalid value "${token}"`);
  return Number(token);
}

function parseField(field: string, min: number, max: number, names: string[] | null): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part.length === 0) throw new CronError('Empty list item');
    const [rangePart, stepPart] = part.split('/') as [string, string | undefined];
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Invalid step "${stepPart}"`);
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-') as [string, string];
      start = parseValue(a, min, names);
      end = parseValue(b, min, names);
    } else {
      start = parseValue(rangePart, min, names);
      end = stepPart === undefined ? start : max;
    }
    if (start < min || end > max || start > end) throw new CronError(`Value out of range in "${part}" (allowed ${min}-${max})`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronSchedule {
  const normalized = ALIASES[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) throw new CronError('A schedule needs exactly five fields: minute hour day month weekday');
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = parseField(weekday, 0, 7, WEEKDAYS);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0); // both 0 and 7 mean Sunday
  }
  return {
    minutes: parseField(minute, 0, 59, null),
    hours: parseField(hour, 0, 23, null),
    days: parseField(day, 1, 31, null),
    months: parseField(month, 1, 12, MONTHS),
    weekdays,
    dayRestricted: day !== '*',
    weekdayRestricted: weekday !== '*',
  };
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const dom = schedule.days.has(date.getUTCDate());
  const dow = schedule.weekdays.has(date.getUTCDay());
  if (schedule.dayRestricted && schedule.weekdayRestricted) return dom || dow;
  if (schedule.dayRestricted) return dom;
  if (schedule.weekdayRestricted) return dow;
  return true;
}

/** The first matching minute strictly after `from`. */
export function nextRun(schedule: CronSchedule, from: Date): Date {
  const date = new Date(from.getTime());
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(date.getUTCMinutes() + 1);
  // Bounded search: a valid schedule always matches within ~4 years (Feb 29 + weekday).
  for (let guard = 0; guard < 2_200_000; guard += 1) {
    if (!schedule.months.has(date.getUTCMonth() + 1)) {
      date.setUTCMonth(date.getUTCMonth() + 1, 1);
      date.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(schedule, date)) {
      date.setUTCDate(date.getUTCDate() + 1);
      date.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(date.getUTCHours())) {
      date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(date.getUTCMinutes())) {
      date.setUTCMinutes(date.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return date;
  }
  throw new CronError('Schedule never matches');
}

/** Validate an expression and return its next run, or throw a {@link CronError}. */
export function nextRunFor(expression: string, from: Date = new Date()): Date {
  return nextRun(parseCron(expression), from);
}
