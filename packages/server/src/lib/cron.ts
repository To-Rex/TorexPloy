/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week),
 * evaluated on the wall clock of a time zone (UTC when none is given).
 *
 * Supports `*`, lists (`1,15`), ranges (`1-5`), steps (`*\/10`, `0-30/5`),
 * month and weekday names, and the usual `@hourly`-style aliases. When both
 * day-of-month and day-of-week are restricted, a day matches if either does
 * (the classic Vixie cron rule).
 *
 * Daylight-saving changes follow Vixie cron too. A fixed-time job (`30 2 * * *`)
 * whose minute falls into a spring-forward gap runs at the first minute after
 * the gap, and runs once — not twice — in the hour a fall-back repeats. A job
 * with `*` in its minute or hour field keeps its rhythm instead: it runs at
 * every real minute that matches, through both kinds of change.
 */

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
  /** The minute or hour field starts with `*`: the job runs by elapsed time through DST changes (Vixie cron's "wild" jobs). */
  frequent: boolean;
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

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

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
    frequent: minute.startsWith('*') || hour.startsWith('*'),
  };
}

function dayMatches(schedule: CronSchedule, day: number, weekday: number): boolean {
  const dom = schedule.days.has(day);
  const dow = schedule.weekdays.has(weekday);
  if (schedule.dayRestricted && schedule.weekdayRestricted) return dom || dow;
  if (schedule.dayRestricted) return dom;
  if (schedule.weekdayRestricted) return dow;
  return true;
}

/** The first matching minute strictly after `from`, in UTC. */
function nextRunUtc(schedule: CronSchedule, from: Date): Date {
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
    if (!dayMatches(schedule, date.getUTCDate(), date.getUTCDay())) {
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

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

interface WallClock {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        weekday: 'short',
      });
    } catch {
      throw new CronError(`Unknown time zone "${timeZone}"`);
    }
    formatters.set(timeZone, format);
  }
  return format;
}

/** What a clock on the wall in `timeZone` shows at an instant. */
function wallClock(ms: number, timeZone: string): WallClock {
  const wall: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, weekday: 0 };
  for (const part of formatter(timeZone).formatToParts(ms)) {
    switch (part.type) {
      case 'year':
        wall.year = Number(part.value);
        break;
      case 'month':
        wall.month = Number(part.value);
        break;
      case 'day':
        wall.day = Number(part.value);
        break;
      case 'hour':
        wall.hour = Number(part.value) % 24;
        break;
      case 'minute':
        wall.minute = Number(part.value);
        break;
      case 'second':
        wall.second = Number(part.value);
        break;
      case 'weekday':
        wall.weekday = WEEKDAY_INDEX[part.value] ?? 0;
        break;
      default:
        break;
    }
  }
  return wall;
}

/** The wall clock read as if it were UTC: a point on the zone's own timeline, where the cron fields live. */
function naive(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  return naive(wallClock(ms, timeZone)) - ms;
}

/** Whether the schedule matches a wall-clock minute (a naive timestamp). */
function matchesAt(schedule: CronSchedule, ms: number): boolean {
  const date = new Date(ms);
  return (
    schedule.months.has(date.getUTCMonth() + 1) &&
    dayMatches(schedule, date.getUTCDate(), date.getUTCDay()) &&
    schedule.hours.has(date.getUTCHours()) &&
    schedule.minutes.has(date.getUTCMinutes())
  );
}

/** Whether any wall-clock minute in `[from, to)` matches: the minutes a spring-forward gap swallowed. */
function matchesBetween(schedule: CronSchedule, from: number, to: number): boolean {
  // Gaps are an hour or two; the bound only guards against a zone doing something unheard of.
  for (let ms = from, count = 0; ms < to && count < 24 * 60; ms += MINUTE, count += 1) if (matchesAt(schedule, ms)) return true;
  return false;
}

/**
 * The earliest instant after `after` at which the zone shows the wall clock
 * `target` — or, when a gap swallowed that wall clock, the first instant after
 * the gap. Always strictly later than `after`, so a search can jump ahead by
 * hours or months and never stall.
 */
function instantFor(target: number, timeZone: string, after: number): number {
  let best = Infinity;
  const offsets = new Set<number>();
  // A change within a day of the target shows up as two different offsets among the probes; `target - offset` is then
  // the instant for each side of it, and the earlier one that still shows the target (or later) is the first occurrence.
  for (const probe of [target - DAY, target, target + DAY]) {
    const offset = offsetAt(probe, timeZone);
    if (offsets.has(offset)) continue;
    offsets.add(offset);
    const candidate = target - offset;
    if (candidate > after && candidate < best && naive(wallClock(candidate, timeZone)) >= target) best = candidate;
  }
  return best === Infinity ? after + MINUTE : best;
}

/** The first matching minute strictly after `from`, on the wall clock of `timeZone`. */
function nextRunInZone(schedule: CronSchedule, from: Date, timeZone: string): Date {
  const fixed = !schedule.frequent;
  let t = Math.floor(from.getTime() / MINUTE) * MINUTE;
  let wall = wallClock(t, timeZone);
  let step = true; // the first move is one minute forward, so the result is strictly after `from`
  for (let guard = 0; guard < 2_200_000; guard += 1) {
    if (step) {
      step = false;
      const next = t + MINUTE;
      const nextWall = wallClock(next, timeZone);
      const shift = naive(nextWall) - next - (naive(wall) - t);
      if (shift < 0 && fixed) {
        // Fall back: the wall minutes from `nextWall` on were shown once already; skip them so the job cannot run twice.
        t = next - shift;
        wall = wallClock(t, timeZone);
        continue;
      }
      if (shift > 0 && fixed && matchesBetween(schedule, naive(wall) + MINUTE, naive(nextWall))) {
        // Spring forward: the job was due in minutes that never happened; it runs at the first minute after the gap.
        return new Date(next);
      }
      t = next;
      wall = nextWall;
    }
    let target: number;
    if (!schedule.months.has(wall.month)) target = Date.UTC(wall.year, wall.month, 1);
    else if (!dayMatches(schedule, wall.day, wall.weekday)) target = Date.UTC(wall.year, wall.month - 1, wall.day + 1);
    else if (!schedule.hours.has(wall.hour)) target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour + 1);
    else if (!schedule.minutes.has(wall.minute)) {
      step = true;
      continue;
    } else return new Date(t);
    t = instantFor(target, timeZone, t);
    wall = wallClock(t, timeZone);
    // Landing past the target means a gap swallowed it; a fixed-time job due inside the gap runs right after it.
    if (fixed && naive(wall) > target && matchesBetween(schedule, target, naive(wall))) return new Date(t);
  }
  throw new CronError('Schedule never matches');
}

/** The first matching minute strictly after `from`, on the wall clock of `timeZone` (UTC when omitted). */
export function nextRun(schedule: CronSchedule, from: Date, timeZone = 'UTC'): Date {
  return timeZone === 'UTC' ? nextRunUtc(schedule, from) : nextRunInZone(schedule, from, timeZone);
}

/** Validate an expression and return its next run, or throw a {@link CronError}. */
export function nextRunFor(expression: string, from: Date = new Date(), timeZone = 'UTC'): Date {
  return nextRun(parseCron(expression), from, timeZone);
}
