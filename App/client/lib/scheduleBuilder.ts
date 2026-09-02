// The friendly schedule model behind every "when does this run?" control in
// the app — Routines, Revenue Signals, and Pipeline schedule triggers.
//
// The wire format stays exactly what it always was: a cron expression the
// server validates with `node-cron` and schedules with `cron-parser`. Nothing
// here changes what is stored. What changes is how we *ask*: a person picks
// "every weekday at 9:00 AM" and we compile that down, instead of making them
// author `0 9 * * 1-5` by hand.
//
// Three jobs, in dependency order:
//
//   1. `scheduleToCron` / `cronToSchedule` — the compiler and its inverse.
//      The inverse is partial on purpose: cron can express far more than the
//      picker offers, so anything the picker cannot draw returns `null` and
//      the UI falls back to its custom-expression escape hatch rather than
//      silently rewriting someone's schedule.
//   2. `describeSchedule` / `describeCronExpr` — plain English, in the app's
//      own voice ("Every weekday at 9:00 AM"), falling back to `cronstrue`
//      for expressions only the escape hatch can produce.
//   3. `previewRuns` / `nextRuns` — the next few fire times, so the field can
//      show what it is actually going to do instead of asking people to trust
//      a sentence, and can tell a schedule that never comes round apart from
//      one whose syntax the preview simply does not walk.
//
// Not to be confused with `lib/schedule.ts`, the recurring-invoice picker.
// That model carries an `intervalCount` that rides *alongside* the cron ("every
// 2 months"), which cron cannot express and only the invoice scheduler knows
// how to honour. This module compiles to cron and nothing else, because the
// schedulers it feeds read the cron and only the cron.

import { cronHuman } from "./cron";

export type ScheduleFrequency = "minutes" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";

/**
 * A schedule a person can draw with a handful of controls.
 *
 * Every field is always present, even the ones the current `frequency` does
 * not read. That is deliberate: switching from "weekly" to "monthly" and back
 * must not forget which weekday was picked, and a model with optional fields
 * makes that impossible without a second layer of remembered state.
 */
export type Schedule = {
  frequency: ScheduleFrequency;
  /** Multiplier for `minutes` (1–30) and `hourly` (1–12). Ignored otherwise. */
  every: number;
  /** Minute past the hour, 0–59. Read by every frequency except `minutes`. */
  minute: number;
  /** Hour of day, 0–23. Read by `daily`, `weekly`, `monthly`, `yearly`. */
  hour: number;
  /** Days of the week, 0 = Sunday … 6 = Saturday. Read by `weekly`. */
  weekdays: number[];
  /** Day of the month, 1–31. Read by `monthly` and `yearly`. */
  dayOfMonth: number;
  /** Month, 1 = January … 12 = December. Read by `yearly`. */
  month: number;
};

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const WEEKDAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The "every N minutes" choices. Only divisors of 60 — see `scheduleToCron`. */
export const MINUTE_STEPS = [1, 2, 5, 10, 15, 20, 30];

/** The "every N hours" choices. Only divisors of 24, for the same reason. */
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

const WEEKDAY_TOKENS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_TOKENS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const WEEKDAYS_MON_FRI = [1, 2, 3, 4, 5];

/**
 * The `@`-shorthands, expanded to the expression they stand for.
 *
 * Only the five both halves of the scheduler accept are here. `node-cron`
 * also validates `@annually` and `@midnight`, but `cron-parser` — which is
 * what actually computes a Routine's next run — throws on both, so the API
 * refuses them and the heartbeat could never fire one. Expanding them would
 * mean the picker drawing a friendly schedule for work that will never
 * happen, which is worse than sending them to the escape hatch unrecognised.
 */
const CRON_MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
};

/** Resolve an `@`-shorthand; anything else is returned trimmed, unchanged. */
function expandMacro(expr: string): string {
  const trimmed = (expr ?? "").trim();
  return CRON_MACROS[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * The longest each month ever gets. February is 29 because a leap day is a
 * real, schedulable date — `0 9 29 2 *` fires every four years, which is
 * unusual but not impossible. February 30th is impossible, and cron-parser
 * says so by refusing to produce a next run at all, which the API turns into
 * "that cron expression cannot be scheduled".
 */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** How far the day-of-month control may go for a given month, 1-indexed. */
export function daysInMonth(month: number): number {
  return DAYS_IN_MONTH[clampInt(month, 1, 12, 1) - 1];
}

/** What a fresh Routine, Signal, or schedule trigger starts on. */
export function defaultSchedule(): Schedule {
  return {
    frequency: "weekly",
    every: 1,
    minute: 0,
    hour: 9,
    weekdays: [...WEEKDAYS_MON_FRI],
    dayOfMonth: 1,
    month: 1,
  };
}

/**
 * One-click starting points, offered as chips beside the picker. Stored as
 * schedules rather than cron strings so selecting one lands the person in the
 * friendly controls with everything already filled in.
 */
export const SCHEDULE_PRESETS: Array<{ label: string; schedule: Schedule }> = [
  {
    label: "Every weekday, 9:00 AM",
    schedule: { ...defaultSchedule(), frequency: "weekly", weekdays: [...WEEKDAYS_MON_FRI] },
  },
  { label: "Every day, 8:00 AM", schedule: { ...defaultSchedule(), frequency: "daily", hour: 8 } },
  {
    label: "Every Monday, 9:00 AM",
    schedule: { ...defaultSchedule(), frequency: "weekly", weekdays: [1] },
  },
  { label: "Every hour", schedule: { ...defaultSchedule(), frequency: "hourly", every: 1 } },
  {
    label: "1st of the month, 9:00 AM",
    schedule: { ...defaultSchedule(), frequency: "monthly", dayOfMonth: 1 },
  },
];

function clampInt(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < lo) return lo;
  if (rounded > hi) return hi;
  return rounded;
}

/**
 * Snap an arbitrary number to the nearest offered step, so a hand-written
 * seven-minute cadence still lands on a control the picker can draw.
 */
function nearestStep(value: number, steps: number[]): number {
  return steps.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best,
  );
}

/**
 * Force a schedule into the ranges its controls allow. Every entry point runs
 * this, so no caller can hand `scheduleToCron` an hour of 47 or an empty
 * weekday list and get an expression the server will reject.
 */
export function normalizeSchedule(input: Schedule): Schedule {
  const weekdays = Array.from(
    new Set(
      (Array.isArray(input.weekdays) ? input.weekdays : [])
        .filter((day) => Number.isFinite(day))
        .map((day) => clampInt(day, 0, 6, 1)),
    ),
  ).sort((a, b) => a - b);
  return {
    frequency: input.frequency,
    every:
      input.frequency === "minutes"
        ? nearestStep(clampInt(input.every, 1, 30, 1), MINUTE_STEPS)
        : input.frequency === "hourly"
          ? nearestStep(clampInt(input.every, 1, 12, 1), HOUR_STEPS)
          : 1,
    minute: clampInt(input.minute, 0, 59, 0),
    hour: clampInt(input.hour, 0, 23, 9),
    // An empty selection would compile to an expression that never fires, so
    // the picker's "no days chosen" state resolves to Monday rather than to a
    // schedule that silently does nothing.
    weekdays: weekdays.length > 0 ? weekdays : [1],
    // A monthly schedule may name the 31st — it simply skips the short
    // months. A *yearly* one names exactly one date, so February 31st is not
    // a schedule that runs rarely, it is a schedule that never runs, and the
    // API rejects it. Clamp rather than let the picker build one.
    dayOfMonth: clampInt(
      input.dayOfMonth,
      1,
      input.frequency === "yearly" ? daysInMonth(input.month) : 31,
      1,
    ),
    month: clampInt(input.month, 1, 12, 1),
  };
}

/**
 * Compile the friendly model to a standard 5-field cron expression.
 *
 * `every` becomes cron step syntax, which is why `MINUTE_STEPS` and
 * `HOUR_STEPS` only offer divisors of 60 and 24: a cron step restarts its
 * count at the top of each hour (or day), so a step of 7 would fire at :00,
 * :07 … :56 and then again at :00 — a seven-minute cadence with a
 * four-minute seam once an hour. Offering only clean divisors means the
 * sentence the picker shows is the schedule the server actually runs.
 */
export function scheduleToCron(input: Schedule): string {
  const s = normalizeSchedule(input);
  switch (s.frequency) {
    case "minutes":
      return `${s.every === 1 ? "*" : `*/${s.every}`} * * * *`;
    case "hourly":
      return `${s.minute} ${s.every === 1 ? "*" : `*/${s.every}`} * * *`;
    case "weekly":
      return `${s.minute} ${s.hour} * * ${s.weekdays.join(",")}`;
    case "monthly":
      return `${s.minute} ${s.hour} ${s.dayOfMonth} * *`;
    case "yearly":
      return `${s.minute} ${s.hour} ${s.dayOfMonth} ${s.month} *`;
    case "daily":
    default:
      return `${s.minute} ${s.hour} * * *`;
  }
}

/** A plain integer field, or NaN. Accepts `MON` / `JAN` style names too. */
function fieldNumber(field: string, names: string[], offset: number): number {
  const token = field.trim().toLowerCase();
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  const named = names.indexOf(token.slice(0, 3));
  return named === -1 ? NaN : named + offset;
}

/**
 * The step count of a wildcard field: a bare `*` is 1, a step field is its
 * divisor. Anything else — a number, a list, a range — returns null.
 */
function stepOf(field: string): number | null {
  const token = field.trim();
  if (token === "*") return 1;
  const match = /^\*\/(\d+)$/.exec(token);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return n >= 1 ? n : null;
}

/**
 * Expand a day-of-week field into the days it names. Handles the three shapes
 * a picker-authored expression can carry plus the ones people hand-write:
 * `1-5`, `1,3,5`, `MON-FRI`, and any mix of them. Returns null on step syntax
 * or anything unparseable, which sends the caller to the escape hatch.
 */
function expandWeekdays(field: string): number[] | null {
  const token = field.trim();
  if (token === "*" || token === "") return null;
  const days = new Set<number>();
  for (const part of token.split(",")) {
    const range = part.split("-");
    if (range.length === 1) {
      const day = fieldNumber(range[0], WEEKDAY_TOKENS, 0);
      if (!Number.isFinite(day) || day < 0 || day > 7) return null;
      // Cron accepts 7 as a second spelling of Sunday.
      days.add(day === 7 ? 0 : day);
      continue;
    }
    if (range.length !== 2) return null;
    const from = fieldNumber(range[0], WEEKDAY_TOKENS, 0);
    const to = fieldNumber(range[1], WEEKDAY_TOKENS, 0);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (from < 0 || from > 7 || to < 0 || to > 7 || from > to) return null;
    for (let day = from; day <= to; day += 1) days.add(day === 7 ? 0 : day);
  }
  return days.size > 0 ? Array.from(days).sort((a, b) => a - b) : null;
}

/**
 * Best-effort parse of a cron expression back into the friendly model, so an
 * existing schedule opens in the picker rather than in the escape hatch.
 *
 * Returns `null` for anything the picker cannot faithfully redraw — six-field
 * second-granularity expressions, hour lists, day-of-month steps, a
 * day-of-month and a day-of-week together. That `null` is the whole contract:
 * a partial parse would let the picker re-emit a *different* schedule than the
 * one it was handed, quietly changing when someone's work runs.
 */
export function cronToSchedule(expr: string): Schedule | null {
  const fields = expandMacro(expr).split(/\s+/).filter(Boolean);
  // Six fields means second granularity, which the picker does not offer.
  if (fields.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const base = defaultSchedule();
  const minuteStep = stepOf(minuteField);
  const hourStep = stepOf(hourField);
  const everythingElseIsWild = domField === "*" && monthField === "*" && dowField === "*";

  // "Every N minutes" — the only shape where the minute field is not a number.
  if (minuteStep !== null) {
    if (!everythingElseIsWild || hourStep !== 1) return null;
    if (!MINUTE_STEPS.includes(minuteStep)) return null;
    return { ...base, frequency: "minutes", every: minuteStep, weekdays: [...WEEKDAYS_MON_FRI] };
  }

  const minute = fieldNumber(minuteField, [], 0);
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  // "Every N hours at :MM".
  if (hourStep !== null) {
    if (!everythingElseIsWild) return null;
    if (!HOUR_STEPS.includes(hourStep)) return null;
    return { ...base, frequency: "hourly", every: hourStep, minute };
  }

  const hour = fieldNumber(hourField, [], 0);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;

  const withTime = { ...base, minute, hour };

  if (domField === "*" && monthField === "*" && dowField === "*") {
    return { ...withTime, frequency: "daily" };
  }

  // Day-of-week and day-of-month together is cron's OR clause — two schedules
  // in one field. The picker draws one schedule, so this goes to the hatch.
  if (domField === "*" && monthField === "*" && dowField !== "*") {
    const weekdays = expandWeekdays(dowField);
    return weekdays ? { ...withTime, frequency: "weekly", weekdays } : null;
  }

  if (dowField !== "*") return null;

  const dayOfMonth = fieldNumber(domField, [], 0);
  if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;

  if (monthField === "*") return { ...withTime, frequency: "monthly", dayOfMonth };

  const month = fieldNumber(monthField, MONTH_TOKENS, 1);
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  // A date that does not exist — `0 9 31 2 *` — is not something the controls
  // can draw without silently moving it, so it belongs in the escape hatch.
  if (dayOfMonth > daysInMonth(month)) return null;
  return { ...withTime, frequency: "yearly", dayOfMonth, month };
}

/** Whether the friendly picker can draw this expression at all. */
export function isFriendlyCron(expr: string): boolean {
  return cronToSchedule(expr) !== null;
}

/** "1st", "2nd", "3rd", "21st" … */
export function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const value = n % 100;
  return n + (suffixes[(value - 20) % 10] || suffixes[value] || suffixes[0]);
}

/** 12-hour clock, matching the rest of the app's time copy. */
export function formatTimeOfDay(hour: number, minute: number): string {
  const h = clampInt(hour, 0, 23, 0);
  const m = clampInt(minute, 0, 59, 0);
  const hour12 = ((h + 11) % 12) + 1;
  return `${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Value for an `<input type="time">` ("HH:MM"). */
export function timeInputValue(schedule: Schedule): string {
  const s = normalizeSchedule(schedule);
  return `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
}

/** Apply an `<input type="time">` value back onto a schedule. */
export function withTimeOfDay(schedule: Schedule, value: string): Schedule {
  const [rawHour, rawMinute] = (value || "").split(":");
  const hour = parseInt(rawHour, 10);
  const minute = parseInt(rawMinute, 10);
  return normalizeSchedule({
    ...schedule,
    hour: Number.isFinite(hour) ? hour : schedule.hour,
    minute: Number.isFinite(minute) ? minute : schedule.minute,
  });
}

/** "Mon, Wed & Fri" — the app's list voice, an ampersand before the last. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((day, i) => day === b[i]);
}

/** The weekday half of a weekly sentence: "weekday", "Monday", "Mon & Wed". */
export function describeWeekdays(weekdays: number[]): string {
  const days = normalizeSchedule({ ...defaultSchedule(), weekdays }).weekdays;
  if (days.length === 7) return "day";
  if (sameDays(days, WEEKDAYS_MON_FRI)) return "weekday";
  if (sameDays(days, [0, 6])) return "weekend day";
  if (days.length === 1) return WEEKDAY_NAMES[days[0]];
  return joinNames(days.map((day) => WEEKDAY_SHORT_NAMES[day]));
}

/**
 * Plain-English sentence for a schedule, e.g. "Every weekday at 9:00 AM".
 *
 * Deliberately not `cronstrue`'s phrasing. Its "At 03:15 PM, only on
 * Wednesday" is accurate and reads like a machine describing itself; this is
 * the sentence the person just built, said back to them the way they said it.
 */
export function describeSchedule(input: Schedule): string {
  const s = normalizeSchedule(input);
  const at = ` at ${formatTimeOfDay(s.hour, s.minute)}`;
  switch (s.frequency) {
    case "minutes":
      return s.every === 1 ? "Every minute" : `Every ${s.every} minutes`;
    case "hourly": {
      const cadence = s.every === 1 ? "Every hour" : `Every ${s.every} hours`;
      return s.minute === 0
        ? `${cadence}, on the hour`
        : `${cadence}, at ${s.minute} past the hour`;
    }
    case "weekly":
      return `Every ${describeWeekdays(s.weekdays)}${at}`;
    case "monthly":
      return `The ${ordinal(s.dayOfMonth)} of every month${at}`;
    case "yearly":
      return `Every ${MONTH_NAMES[s.month - 1]} ${s.dayOfMonth}${at}`;
    case "daily":
    default:
      return `Every day${at}`;
  }
}

/**
 * Plain-English sentence straight from a cron expression — for list rows,
 * detail headers, and anywhere a stored schedule is shown rather than edited.
 *
 * Expressions the picker can draw get the app's own voice. Everything else —
 * a hand-written expression from the escape hatch, or one an AI Employee wrote
 * through the MCP tools — falls back to `cronstrue`, and then to the raw
 * expression. There is always a sentence; there is never an error here.
 */
export function describeCronExpr(expr: string): string {
  const schedule = cronToSchedule(expr);
  return schedule ? describeSchedule(schedule) : cronHuman(expr);
}

type CronFields = {
  seconds: Set<number>;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
};

/**
 * Expand one cron field into the set of values it matches. Handles the
 * wildcard, a single value, a range, any of those with a step divisor, comma
 * lists mixing them, and the three-letter names cron allows for months and
 * weekdays.
 */
function expandField(
  field: string,
  lo: number,
  hi: number,
  names: string[],
  offset: number,
): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.trim().split(",")) {
    const [spec, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : parseInt(stepText, 10);
    if (!Number.isFinite(step) || step < 1) return null;

    let from: number;
    let to: number;
    if (spec === "*" || spec === "") {
      from = lo;
      to = hi;
    } else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      from = fieldNumber(a, names, offset);
      to = fieldNumber(b, names, offset);
    } else {
      from = fieldNumber(spec, names, offset);
      // A bare `a/n` counts from `a` to the end of the range, per cron.
      to = stepText === undefined ? from : hi;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (from < lo || to > hi || from > to) return null;
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out.size > 0 ? out : null;
}

/** Parse a 5- or 6-field expression into matchable sets. Null if unparseable. */
function parseCronFields(expr: string): CronFields | null {
  const fields = expandMacro(expr).split(/\s+/).filter(Boolean);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const [secondField, minuteField, hourField, domField, monthField, dowField] =
    fields.length === 6 ? fields : ["0", ...fields];

  const seconds = expandField(secondField, 0, 59, [], 0);
  const minutes = expandField(minuteField, 0, 59, [], 0);
  const hours = expandField(hourField, 0, 23, [], 0);
  const daysOfMonth = expandField(domField, 1, 31, [], 0);
  const months = expandField(monthField, 1, 12, MONTH_TOKENS, 1);
  const rawDows = expandField(dowField, 0, 7, WEEKDAY_TOKENS, 0);
  if (!seconds || !minutes || !hours || !daysOfMonth || !months || !rawDows) return null;

  // Cron spells Sunday both 0 and 7; collapse before matching.
  const daysOfWeek = new Set(Array.from(rawDows, (day) => (day === 7 ? 0 : day)));
  return {
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: domField.trim() !== "*",
    dowRestricted: dowField.trim() !== "*",
  };
}

function dayMatches(fields: CronFields, date: Date): boolean {
  if (!fields.months.has(date.getMonth() + 1)) return false;
  const domHit = fields.daysOfMonth.has(date.getDate());
  const dowHit = fields.daysOfWeek.has(date.getDay());
  // Cron's one genuine oddity: when *both* day fields are restricted they are
  // OR'd, not AND'd, so `0 9 13 * 5` is "the 13th, and also every Friday".
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/**
 * How far ahead `nextRuns` will look before giving up.
 *
 * Thirteen years, sized by the rarest schedule cron can express: `0 9 29 2 *`
 * fires only on a leap day, so three previews of it span twelve years from a
 * start just after one. Days are the loop unit and each one costs a `Date`
 * construction and a few set lookups, so even the pathological case that
 * never matches at all walks the whole range in a couple of milliseconds.
 */
const MAX_SCAN_DAYS = 366 * 13;

/**
 * The next `count` times an expression fires, strictly after `from`. Use
 * `previewRuns` when you need to know why the list came back empty.
 */
export function nextRuns(expr: string, from: Date, count = 3): Date[] {
  return previewRuns(expr, from, count).runs;
}

/**
 * `nextRuns`, plus whether the preview is *able* to speak about this
 * expression at all.
 *
 * The distinction is the whole point. An empty list means two very different
 * things: "this expression names a date that never comes" — `0 9 30 2 *`,
 * February 30th — which is a schedule someone needs telling about, and "this
 * uses syntax the preview does not implement" — cron's `L`, `#` and `W`
 * modifiers, which `node-cron` and `cron-parser` both honour and which fire
 * perfectly well. Warning on the second would cry wolf about working
 * schedules, so callers get `supported` and warn only when it is true.
 *
 * Days are scanned one at a time and only matching days pay for an
 * hour/minute walk, so a once-a-year expression costs a few hundred cheap
 * date comparisons rather than half a million minute ticks.
 *
 * A note on time zones, because the answer is not "it depends". A cron field
 * is a wall-clock number and the scheduler reads it in the *server's* local
 * time. This builds each candidate from local components and formats it in
 * the same zone, so the numbers it prints are exactly those wall-clock
 * numbers — which is why the field labels the preview "server time" rather
 * than the viewer's. The one thing that does come from the browser is `from`:
 * on an install whose server sits many hours away, the *first* run listed can
 * be one occurrence out. Local `Date` construction also means an hour a
 * spring-forward skipped is skipped here too, rather than reported as the
 * hour the clock jumped to.
 */
export function previewRuns(
  expr: string,
  from: Date,
  count = 3,
): { supported: boolean; runs: Date[] } {
  const fields = parseCronFields(expr);
  if (!fields) return { supported: false, runs: [] };
  if (count <= 0) return { supported: true, runs: [] };

  const out: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setMilliseconds(0);
  cursor.setSeconds(cursor.getSeconds() + 1);

  const startDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
  const seconds = Array.from(fields.seconds).sort((a, b) => a - b);
  const minutes = Array.from(fields.minutes).sort((a, b) => a - b);
  const hours = Array.from(fields.hours).sort((a, b) => a - b);

  for (let dayOffset = 0; dayOffset < MAX_SCAN_DAYS && out.length < count; dayOffset += 1) {
    const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + dayOffset);
    if (!dayMatches(fields, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        for (const second of seconds) {
          const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, second);
          // Skipping a nonexistent local time (spring-forward) rather than
          // reporting the hour the clock jumped to.
          if (candidate.getHours() !== hour) continue;
          if (candidate.getTime() < cursor.getTime()) continue;
          out.push(candidate);
          if (out.length >= count) return { supported: true, runs: out };
        }
      }
    }
  }
  return { supported: true, runs: out };
}

/**
 * "Mon 2 Sep, 9:00 AM" — compact enough for a hint line under a field.
 *
 * The year appears only when the run is not in `reference`'s year, because a
 * yearly schedule previews as three of the same date and reads as a bug
 * without it ("20 Aug · 20 Aug · 20 Aug"). Weekday, day and month follow the
 * viewer's locale; the clock does not, because `describeSchedule` one line
 * above says "3:15 PM" and the two must not disagree about the same schedule.
 */
export function formatRunTime(date: Date, reference: Date = new Date()): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: date.getFullYear() === reference.getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
