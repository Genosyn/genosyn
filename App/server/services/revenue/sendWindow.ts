/**
 * Send-window scheduling for outbound sequence steps.
 *
 * This module answers one question — *may a touch go out at this instant?* —
 * and one follow-up — *if not, when may it?* Everything here is pure: instants
 * in, instants out. The enrollment rows, the sending, and the rate limiting
 * live elsewhere, so the timezone arithmetic that decides whether a prospect
 * gets mailed at 3am can be tested exhaustively without a database.
 *
 * Three conventions, stated once so they are not re-litigated per function:
 *
 * - **Local time is resolved with `Intl`, never with manual offset math.**
 *   `formatToParts` on a zone-aware formatter is the only approach that is
 *   correct across DST, across zones with non-hour offsets (Asia/Kathmandu is
 *   +05:45), and across the political churn of the IANA database. A stored
 *   `utcOffsetMinutes` column would be wrong twice a year, silently.
 * - **Nothing here throws for bad data.** A sequence configured with a garbage
 *   timezone, an empty day list, or NaN hours is a sequence that never sends —
 *   it is not a reason to wedge the scheduler tick for every *other* sequence
 *   in the account. The one exception is {@link addStepDelay}, which throws on
 *   a non-finite delay because the alternative (clamping to zero) would mail
 *   somebody immediately, and sending early is worse than not sending.
 * - **Days are 0-6 with 0 = Sunday**, matching `Date#getUTCDay` and cron, so a
 *   window can be read off a cron spec without a translation table.
 */

export type SendWindow = {
  /** 0-6, 0 = Sunday. Empty means "never send" — see {@link isWithinSendWindow}. */
  days: number[];
  /** Local hour the window opens, inclusive. */
  startHour: number;
  /** Local hour the window closes, exclusive. May be < `startHour` to wrap midnight. */
  endHour: number;
  /** IANA zone name. Unknown values fall back to UTC rather than throwing. */
  timezone: string;
};

const SLOT_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `weekday: "short"` under the `en-US` locale, which we pin for determinism. */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Constructing an `Intl.DateTimeFormat` is expensive relative to using one, and
 * `nextWindowOpening` uses one up to 1345 times per call. The cache is keyed by
 * the raw timezone string (including bad ones, which map to the UTC fallback)
 * and is purely a memo — same input, same formatter, no observable state.
 */
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

/** Bounded so a table full of junk timezone strings cannot grow it forever. */
const FORMATTER_CACHE_LIMIT = 256;

function buildFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const key = timezone === "" ? "UTC" : timezone;
  const cached = FORMATTER_CACHE.get(key);
  if (cached !== undefined) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = buildFormatter(key);
  } catch {
    // RangeError: unknown IANA zone. UTC keeps the sequence sending on *some*
    // sane schedule instead of taking the whole tick down.
    formatter = buildFormatter("UTC");
  }
  if (FORMATTER_CACHE.size >= FORMATTER_CACHE_LIMIT) FORMATTER_CACHE.clear();
  FORMATTER_CACHE.set(key, formatter);
  return formatter;
}

type LocalTime = { day: number; hour: number };

/** Local weekday + hour, or null when the instant itself is unusable. */
function localTimeIn(date: Date, timezone: string): LocalTime | null {
  if (!Number.isFinite(date.getTime())) return null;

  let day = -1;
  let hour = -1;
  for (const part of formatterFor(timezone).formatToParts(date)) {
    if (part.type === "weekday") {
      day = WEEKDAY_INDEX[part.value] ?? -1;
    } else if (part.type === "hour") {
      hour = Number.parseInt(part.value, 10);
    }
  }
  if (day < 0 || !Number.isInteger(hour)) return null;
  // Some ICU builds render midnight as "24" under `hour12: false`.
  return { day, hour: hour % 24 };
}

/**
 * Whether `date` falls inside the window, judged in the window's own timezone.
 *
 * Two configurations deliberately mean "never send" rather than "always send":
 *
 * - **Empty `days`.** This is the supported way to freeze a sequence without
 *   deleting it or unenrolling anybody.
 * - **`startHour === endHour`.** Read literally this is a zero-width window,
 *   and read generously it is a 24-hour one. We take the literal reading: a UI
 *   that lets somebody set 9-9 by mis-clicking is far more common than a team
 *   that genuinely wants cold email going out around the clock, and the failure
 *   mode of the generous reading is mailing prospects at 3am. Callers who want
 *   all day should say `0`-`24`.
 *
 * When `startHour < endHour` the test is `startHour <= hour < endHour`. When
 * `startHour > endHour` the window wraps midnight and the test is
 * `hour >= startHour || hour < endHour`; note that the day check still applies
 * to the local day *of the instant*, so a `days: [1]` (Monday) 22:00-06:00
 * window only sends 22:00-23:59 — the early-morning half lands on Tuesday and
 * needs day 2 listed too. That is stated rather than silently patched, because
 * inferring the "intended" day would make the days array mean two things.
 *
 * Non-finite hours are rejected up front rather than left to the comparisons: a
 * NaN `endHour` would otherwise fail the `startHour < endHour` test, fall into
 * the midnight-wrap branch, and leave the window open from `startHour` to the
 * end of time. Out-of-range hours are merely compared numerically, so they
 * never match anything they should not. An Invalid Date returns false, and an
 * unknown timezone is resolved as UTC.
 */
export function isWithinSendWindow(date: Date, w: SendWindow): boolean {
  if (w.days.length === 0) return false;
  if (!Number.isFinite(w.startHour) || !Number.isFinite(w.endHour)) return false;
  if (w.startHour === w.endHour) return false;

  const local = localTimeIn(date, w.timezone);
  if (local === null) return false;
  if (!w.days.includes(local.day)) return false;

  if (w.startHour < w.endHour) {
    return local.hour >= w.startHour && local.hour < w.endHour;
  }
  return local.hour >= w.startHour || local.hour < w.endHour;
}

/**
 * Earliest instant at or after `from` that is inside the window, or null if the
 * window does not open within `maxDays`.
 *
 * If `from` is already inside we hand back the *same* Date, unrounded — a step
 * that is due now should go now, not at the top of the next quarter hour.
 *
 * Otherwise we walk forward in 15-minute slots rather than computing the
 * boundary directly. Direct computation means reconstructing a local wall-clock
 * time and converting it back to an instant, which is exactly the manual offset
 * arithmetic this module refuses to do — and it has no answer for the hour that
 * does not exist on a spring-forward morning. Scanning is dumb, correct across
 * every DST discontinuity, and bounded at 96 checks a day.
 *
 * Slots are aligned to the epoch, so the returned time is always on :00, :15,
 * :30 or :45 UTC. For the zones anybody actually mails into that is also a
 * local quarter hour. The explicit `>= from` guard exists for the historical
 * zones that are not (pre-1972 offsets include things like -00:44:30), where
 * flooring `from` to a slot could otherwise land before it.
 */
export function nextWindowOpening(from: Date, w: SendWindow, maxDays = 14): Date | null {
  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) return null;
  if (isWithinSendWindow(from, w)) return from;

  const deadlineMs = fromMs + maxDays * DAY_MS;
  const firstSlotMs = Math.floor(fromMs / SLOT_MS) * SLOT_MS;
  for (let ms = firstSlotMs; ms <= deadlineMs; ms += SLOT_MS) {
    const candidate = new Date(ms);
    if (ms >= fromMs && isWithinSendWindow(candidate, w)) return candidate;
  }
  return null;
}

/**
 * `from` plus a step delay, as plain millisecond arithmetic.
 *
 * Deliberately *not* calendar arithmetic: "3 days later" for a follow-up email
 * means 72 hours, and a caller who adds 3 calendar days across a DST boundary
 * gets a touch that drifts an hour earlier every spring. The window check is
 * what makes the result land at a civilised local hour; the delay itself only
 * needs to be a duration.
 *
 * Negative delays clamp to 0 (independently, so `-1` days and `+2` hours is two
 * hours, not one). Non-finite delays throw: they are a programmer error, and
 * the alternative of treating them as zero would fire the step immediately.
 */
export function addStepDelay(from: Date, delayDays: number, delayHours: number): Date {
  if (!Number.isFinite(delayDays)) {
    throw new Error("addStepDelay: delayDays must be finite");
  }
  if (!Number.isFinite(delayHours)) {
    throw new Error("addStepDelay: delayHours must be finite");
  }
  const days = Math.max(0, delayDays);
  const hours = Math.max(0, delayHours);
  return new Date(from.getTime() + days * DAY_MS + hours * 60 * 60 * 1000);
}

/**
 * When the next step of a sequence should fire, or null if the window will not
 * open in the next 14 days.
 *
 * The order of operations is the whole point: delay, then clamp to `now`, then
 * push into the window. Clamping *after* the window push would hand back a time
 * inside `now`'s past-or-present that is no longer window-checked, which is how
 * a scheduler that has been paused for a week wakes up and mails its entire
 * backlog at midnight. Clamping first means a backlog resumes at the next
 * legitimate opening instead.
 *
 * `previousSendAt` being an Invalid Date yields null rather than a throw — a
 * corrupt row should skip, not stall the tick.
 */
export function computeNextRunAt(
  previousSendAt: Date,
  step: { delayDays: number; delayHours: number },
  w: SendWindow,
  now: Date,
): Date | null {
  const target = addStepDelay(previousSendAt, step.delayDays, step.delayHours);
  const earliestMs = Math.max(target.getTime(), now.getTime());
  if (!Number.isFinite(earliestMs)) return null;
  return nextWindowOpening(new Date(earliestMs), w);
}

/**
 * The enrollments a tick should actually process, oldest due first.
 *
 * Oldest-first is fairness, not efficiency: sorted any other way, one contact
 * whose `nextRunAt` keeps getting pushed forward can starve behind a stream of
 * newer work forever. This mirrors routine dispatch for the same reason. Ties
 * break on `id` so a tick that runs twice on identical data selects the same
 * rows — flaky ordering here shows up as duplicate sends.
 *
 * A null `nextRunAt` is this module's representation of "not scheduled" — the
 * enrollment is paused, finished, or waiting on a reply — so it is excluded
 * rather than treated as due now. `remainingCap <= 0` (and NaN) returns empty,
 * which is what a caller that has burned its hourly send budget passes in.
 *
 * The input array is not mutated; callers hold onto their own ordering.
 */
export function selectDueEnrollments<T extends { id: string; nextRunAt: Date | null }>(
  enrollments: T[],
  now: Date,
  remainingCap: number,
): T[] {
  if (!(remainingCap > 0)) return [];
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];

  const due: { at: number; item: T }[] = [];
  for (const item of enrollments) {
    const at = item.nextRunAt;
    if (at === null || at === undefined) continue;
    const atMs = at.getTime();
    if (!Number.isFinite(atMs) || atMs > nowMs) continue;
    due.push({ at: atMs, item });
  }

  due.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.item.id === b.item.id) return 0;
    return a.item.id < b.item.id ? -1 : 1;
  });

  return due.slice(0, Math.floor(remainingCap)).map((entry) => entry.item);
}
