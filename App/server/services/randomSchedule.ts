import { createHash } from "node:crypto";
import type { RandomPeriod, RandomSchedule, RandomWindow } from "../../shared/randomSchedule.js";
import { isValidTimeZone } from "../lib/timeZone.js";

/**
 * When a random schedule fires.
 *
 * Worked out, never rolled. `nextRunAt` is all the scheduler keeps, and it is
 * worked out again from the schedule all the time: by the heartbeat when a slot
 * comes due, by a Run as it finishes (`touchRoutine`), by every save of the
 * Routine's settings, by a change of company time zone, by a restore. If each
 * of those rolled dice, each would move the next Run, and a Routine could lose a
 * Run or gain one. So a Routine's times are a pure function of its schedule, its
 * id and the period they fall in, and asking twice gives the same answer. The id
 * is what keeps two Routines on the same schedule from firing together.
 *
 * Each period is cut into one equal share per Run, and each Run lands somewhere
 * inside its own share. That makes "3 times a week" exactly three in every
 * calendar week, and never all three on one afternoon, while still landing on no
 * day or hour anyone could predict.
 *
 * Everything is reckoned in wall-clock minutes since 1970 on the schedule's own
 * clock, where a day is always 1,440 minutes, and turned into an instant only at
 * the end. A week runs Monday to Sunday; a quarter starts in January, April, July
 * or October.
 */

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1_440;
const DAY_MS = DAY_MINUTES * MINUTE_MS;

/**
 * How much of each share is kept clear at both ends, as a part of it and at most
 * an hour. This is what stops the last Run of one share landing a minute before
 * the first of the next: two Runs are at least twice this far apart, unless
 * daylight saving moves one of them. Only capped so that a long period does not
 * lose whole weeks at its edges.
 */
const EDGE_SHARE = 0.05;
const MAX_EDGE_SECONDS = 3_600;

/**
 * How many periods to look through for the next Run. Only an hourly schedule
 * with a window ever finds one empty, and the window comes round within a day.
 */
const MAX_PERIODS_SEARCHED = 32;

/** A stretch of wall-clock time, in minutes since 1970 on that clock. */
type Span = { start: number; end: number };

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** How far ahead of UTC a zone's wall clock is at this instant, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  let formatter = FORMATTERS.get(zone);
  if (!formatter) {
    // `h23` rather than `hour12: false`: some engines print midnight as "24"
    // under the latter, which would put a Run on the wrong side of the day.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    FORMATTERS.set(zone, formatter);
  }
  const wall = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter.formatToParts(instant)) {
    if (part.type in wall) wall[part.type as keyof typeof wall] = Number(part.value);
  }
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) -
    Math.floor(instant / 1_000) * 1_000
  );
}

/**
 * The instant a wall clock reads `wall` (milliseconds since 1970 on that clock).
 *
 * Always answers, so daylight saving never costs a schedule a Run. A time the
 * clocks skipped lands the same distance after the skip, and a time they repeat
 * lands on the first of the two, which is what `Date` does with a local time.
 */
function instantAt(wall: number, zone: string): number {
  const before = offsetAt(wall - DAY_MS, zone);
  const after = offsetAt(wall + DAY_MS, zone);
  if (before === after) return wall - before;
  const readsRight = [wall - before, wall - after].filter(
    (candidate) => candidate + offsetAt(candidate, zone) === wall,
  );
  return readsRight.length > 0 ? Math.min(...readsRight) : wall - before;
}

function wallMinuteAt(instant: number, zone: string): number {
  return Math.floor((instant + offsetAt(instant, zone)) / MINUTE_MS);
}

/** The period this wall-clock minute falls in. */
function periodAround(period: RandomPeriod, minute: number): Span {
  if (period === "hour") {
    const start = Math.floor(minute / 60) * 60;
    return { start, end: start + 60 };
  }
  const day = Math.floor(minute / DAY_MINUTES);
  if (period === "day") return { start: day * DAY_MINUTES, end: (day + 1) * DAY_MINUTES };
  if (period === "week") {
    // 1 January 1970 was a Thursday, so Mondays fall three days short of a
    // multiple of seven.
    const monday = Math.floor((day + 3) / 7) * 7 - 3;
    return { start: monday * DAY_MINUTES, end: (monday + 7) * DAY_MINUTES };
  }
  const date = new Date(minute * MINUTE_MS);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const [first, months] =
    period === "month" ? [month, 1] : period === "quarter" ? [month - (month % 3), 3] : [0, 12];
  return {
    start: Date.UTC(year, first, 1) / MINUTE_MS,
    end: Date.UTC(year, first + months, 1) / MINUTE_MS,
  };
}

/** The parts of a period a window leaves open, in order. */
function openSpans(period: Span, window: RandomWindow | null): Span[] {
  if (!window) return [period];
  const daily =
    window.start < window.end
      ? [{ start: window.start, end: window.end }]
      : [
          { start: 0, end: window.end },
          { start: window.start, end: DAY_MINUTES },
        ];
  const spans: Span[] = [];
  const lastDay = Math.floor((period.end - 1) / DAY_MINUTES);
  for (let day = Math.floor(period.start / DAY_MINUTES); day <= lastDay; day += 1) {
    for (const open of daily) {
      const start = Math.max(period.start, day * DAY_MINUTES + open.start);
      const end = Math.min(period.end, day * DAY_MINUTES + open.end);
      if (start < end) spans.push({ start, end });
    }
  }
  return spans;
}

/** Where in its share one Run lands, from 0 up to but not including 1. */
function fractionFor(seed: string, period: RandomPeriod, start: number, run: number): number {
  const digest = createHash("sha256").update(`${seed}:${period}:${start}:${run}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** Every Run in one period as an instant in milliseconds, earliest first. */
function runsIn(schedule: RandomSchedule, seed: string, period: Span, zone: string): number[] {
  const spans = openSpans(period, schedule.window);
  const openSeconds = spans.reduce((sum, span) => sum + (span.end - span.start) * 60, 0);
  if (openSeconds === 0) return [];

  const share = openSeconds / schedule.count;
  const edge = Math.min(share * EDGE_SHARE, MAX_EDGE_SECONDS);
  const runs: number[] = [];
  let current = 0;
  let secondsBefore = 0;
  for (let run = 0; run < schedule.count; run += 1) {
    const fraction = fractionFor(seed, schedule.period, period.start, run);
    const seconds = run * share + edge + fraction * (share - 2 * edge);
    // The offsets only ever grow, so the spans are walked once.
    for (;;) {
      const length = (spans[current].end - spans[current].start) * 60;
      if (seconds < secondsBefore + length || current === spans.length - 1) break;
      secondsBefore += length;
      current += 1;
    }
    const wall = spans[current].start * MINUTE_MS + Math.floor(seconds - secondsBefore) * 1_000;
    runs.push(instantAt(wall, zone));
  }
  // Daylight saving can move one Run past the next, so the order is not a given.
  return runs.sort((a, b) => a - b);
}

/**
 * The zone to reckon in: the one named, or the process's own for server time.
 * Read each time rather than kept, because the answer is the process's clock
 * right now, the same clock `cron-parser` reads when it is given no zone.
 */
function zoneOrServer(zone: string | undefined): string {
  if (zone) return zone;
  const server = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(server) ? server : "UTC";
}

/**
 * The first Run strictly after `from`. `seed` is what makes these times this
 * Routine's own (its id); `zone` is the IANA zone they are read in, or left out
 * for server time.
 */
export function nextRandomRun(
  schedule: RandomSchedule,
  seed: string,
  from: Date,
  zone?: string,
): Date | null {
  const clock = zoneOrServer(zone);
  const after = from.getTime();
  let period = periodAround(schedule.period, wallMinuteAt(after, clock));
  for (let searched = 0; searched < MAX_PERIODS_SEARCHED; searched += 1) {
    const next = runsIn(schedule, seed, period, clock).find((run) => run > after);
    if (next !== undefined) return new Date(next);
    period = periodAround(schedule.period, period.end);
  }
  return null;
}

/**
 * How many Runs fell strictly after `after` and at or before `until`, up to
 * `cap`, with the same meaning as `countMissedSlots` has for cron: how much work
 * a catch-up Run is standing in for.
 */
export function countRandomRuns(
  schedule: RandomSchedule,
  seed: string,
  after: Date,
  until: Date,
  cap: number,
  zone?: string,
): { count: number; capped: boolean } {
  const from = after.getTime();
  const to = until.getTime();
  if (to <= from || cap <= 0) return { count: 0, capped: false };
  const clock = zoneOrServer(zone);
  const lastMinute = wallMinuteAt(to, clock);
  let period = periodAround(schedule.period, wallMinuteAt(from, clock));
  let count = 0;
  while (period.start <= lastMinute) {
    for (const run of runsIn(schedule, seed, period, clock)) {
      if (run <= from || run > to) continue;
      count += 1;
      if (count === cap) return { count, capped: true };
    }
    period = periodAround(schedule.period, period.end);
  }
  return { count, capped: false };
}
