/**
 * A Routine's random schedule: so many Runs an hour, day, week, month, quarter
 * or year, at times nobody picked.
 *
 * It is written where a Routine's cron expression goes, in the same column and
 * the same API field, the way cron's own `@daily` is:
 *
 *   @random 3/week              three Runs a week, at any time
 *   @random 2/day 09:00-17:00   two Runs a day, between 9:00 and 17:00
 *   @random 1/day 22:00-06:00   one Run a day, overnight
 *
 * The hours are read on the same clock as the rest of a Routine's schedule, the
 * company's time zone. The window includes its start and stops at its end, and
 * an end earlier than its start runs past midnight.
 *
 * This module is only what the words mean, so that the server and the schedule
 * picker cannot read them differently. What times they come to is
 * `server/services/randomSchedule.ts`. Only Routines take one: Pipelines,
 * Revenue Signals and recurring invoices still validate as plain cron.
 */

export const RANDOM_PERIODS = ["hour", "day", "week", "month", "quarter", "year"] as const;
export type RandomPeriod = (typeof RANDOM_PERIODS)[number];

/** Minutes after midnight. `end` before `start` runs past midnight. */
export type RandomWindow = { start: number; end: number };

export type RandomSchedule = {
  /** How many Runs each period. */
  count: number;
  period: RandomPeriod;
  /** The hours a Run may land in, or null for any time. */
  window: RandomWindow | null;
};

/** The most Runs a period takes, however long it is. Each one is billed to a model. */
export const MAX_RANDOM_RUNS = 100;

/** What the API says when an expression starts `@random` and goes wrong after. */
export const RANDOM_SCHEDULE_USAGE =
  "A random schedule looks like `@random 3/week` or `@random 2/day 09:00-17:00`: how many Runs " +
  `(at most ${MAX_RANDOM_RUNS}, and no more than one a minute) per hour, day, week, month, ` +
  "quarter or year, and optionally the hours they may land in.";

const MINUTES_PER_DAY = 1_440;

/** The fewest days each period can have, so the limit holds in its shortest. */
const SHORTEST_DAYS: Record<Exclude<RandomPeriod, "hour">, number> = {
  day: 1,
  week: 7,
  month: 28,
  quarter: 90,
  year: 365,
};

const RANDOM_EXPRESSION = /^@random\s+(\d+)\/([a-z]+)(?:\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2}))?$/;

/** Whether an expression means to be a random schedule, valid or not. */
export function isRandomScheduleExpr(expr: string): boolean {
  return /^@random(\s|$)/i.test(expr.trim());
}

export function isRandomPeriod(value: unknown): value is RandomPeriod {
  return (RANDOM_PERIODS as readonly unknown[]).includes(value);
}

/** How many minutes of each day a window leaves open. */
function openMinutes(window: RandomWindow | null): number {
  if (!window) return MINUTES_PER_DAY;
  return (window.end - window.start + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * The most Runs a period can take with these hours. No more than one a minute
 * on average, because the heartbeat comes round every thirty seconds and two
 * Runs inside one pass would only collapse into a single catch-up.
 */
export function maxRandomRuns(period: RandomPeriod, window: RandomWindow | null): number {
  const open = openMinutes(window);
  const minutes = period === "hour" ? Math.min(60, open) : open * SHORTEST_DAYS[period];
  return Math.min(MAX_RANDOM_RUNS, minutes);
}

function minuteOfDay(hour: string, minute: string): number | null {
  const h = Number(hour);
  const m = Number(minute);
  return h <= 23 && m <= 59 ? h * 60 + m : null;
}

/**
 * Read a random schedule, or null when this is not a valid one. That includes
 * every plain cron expression, and a window that opens and closes at the same
 * minute, which could mean either all day or never.
 */
export function parseRandomSchedule(expr: string): RandomSchedule | null {
  const match = RANDOM_EXPRESSION.exec(expr.trim().toLowerCase());
  if (!match) return null;
  const [, count, period, fromHour, fromMinute, toHour, toMinute] = match;
  if (!isRandomPeriod(period)) return null;

  let window: RandomWindow | null = null;
  if (fromHour !== undefined) {
    const start = minuteOfDay(fromHour, fromMinute);
    const end = minuteOfDay(toHour, toMinute);
    if (start === null || end === null || start === end) return null;
    window = { start, end };
  }

  const runs = Number(count);
  if (runs < 1 || runs > maxRandomRuns(period, window)) return null;
  return { count: runs, period, window };
}

function clock(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** The expression {@link parseRandomSchedule} reads back as this schedule. */
export function formatRandomSchedule(schedule: RandomSchedule): string {
  const runs = `@random ${schedule.count}/${schedule.period}`;
  return schedule.window
    ? `${runs} ${clock(schedule.window.start)}-${clock(schedule.window.end)}`
    : runs;
}
