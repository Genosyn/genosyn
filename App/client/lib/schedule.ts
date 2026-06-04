// Friendly recurrence model for recurring invoices.
//
// The backend stores a plain cron expression (interpreted in server-local
// time by `cron-parser` / `node-cron`). Cron is great for a machine and
// awful for a human, so this module is the bridge: the UI offers a simple
// "Every month on the 1st at 9am" picker, and we compile that down to a
// cron string on save / parse it back on edit. Nothing about the schedule
// is stored differently — only how we ask for it.

export type Frequency =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly";

export type ScheduleParts = {
  frequency: Frequency;
  /** "Every N" multiplier on the frequency, ≥ 1. 1 = every day/week/month…;
   *  2 = every other; 3 = every third; and so on. Cron can't carry this, so
   *  it travels alongside the cron string and is enforced server-side. */
  intervalCount: number;
  /** Day of month, 1–31. Used by monthly / quarterly / yearly. */
  dayOfMonth: number;
  /** 0 = Sunday … 6 = Saturday. Used by weekly. */
  weekday: number;
  /** 1 = January … 12 = December. Used by yearly. */
  month: number;
  /** Hour of day, 0–23 (server-local). */
  hour: number;
  /** Minute of hour, 0–59 (server-local). */
  minute: number;
};

// The months a quarterly schedule fires on: Jan, Apr, Jul, Oct.
const QUARTER_MONTHS = "1,4,7,10";

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const MONTH_LABELS = [
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

export function defaultScheduleParts(): ScheduleParts {
  return {
    frequency: "monthly",
    intervalCount: 1,
    dayOfMonth: 1,
    weekday: 1,
    month: 1,
    hour: 9,
    minute: 0,
  };
}

/** Clamp an "every N" count to the supported 1–99 range. */
export function clampIntervalCount(n: number): number {
  return clampInt(n, 1, 99, 1);
}

function clampInt(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

/** "1st", "2nd", "3rd", "21st", … */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Value for an `<input type="time">` ("HH:MM"). */
export function timeInputValue(p: ScheduleParts): string {
  const h = clampInt(p.hour, 0, 23, 9);
  const m = clampInt(p.minute, 0, 59, 0);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Apply a "HH:MM" string from a time input back onto the parts. */
export function withTime(p: ScheduleParts, value: string): ScheduleParts {
  const [h, m] = value.split(":");
  return {
    ...p,
    hour: clampInt(parseInt(h, 10), 0, 23, p.hour),
    minute: clampInt(parseInt(m, 10), 0, 59, p.minute),
  };
}

/**
 * Compile the friendly model down to a standard 5-field cron expression.
 *
 * The cron string encodes the *base* (every-occurrence) pattern only — the
 * time of day plus the day-of-week / day-of-month / month it lands on. The
 * "every N" multiplier (`intervalCount`) is deliberately NOT baked in: cron
 * step syntax can't faithfully express "every 2 weeks" or "every 5 months",
 * so the count rides alongside as its own field and the server skips to the
 * right occurrence. For `intervalCount === 1` this cron is the whole story.
 */
export function partsToCron(p: ScheduleParts): string {
  const m = clampInt(p.minute, 0, 59, 0);
  const h = clampInt(p.hour, 0, 23, 9);
  const dom = clampInt(p.dayOfMonth, 1, 31, 1);
  switch (p.frequency) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekly":
      return `${m} ${h} * * ${clampInt(p.weekday, 0, 6, 1)}`;
    case "quarterly":
      return `${m} ${h} ${dom} ${QUARTER_MONTHS} *`;
    case "yearly":
      return `${m} ${h} ${dom} ${clampInt(p.month, 1, 12, 1)} *`;
    case "monthly":
    default:
      return `${m} ${h} ${dom} * *`;
  }
}

/**
 * Best-effort parse of a cron expression back into the friendly model so
 * the edit form can pre-fill its controls. Recognizes the canonical shapes
 * `partsToCron` emits; anything else falls back to a sane monthly-on-the-1st
 * default while still preserving a plain-number time of day.
 *
 * The cron carries no "every N" count — callers that have one (the entity's
 * `intervalCount`) should overlay it onto the returned parts.
 */
export function cronToParts(expr: string): ScheduleParts {
  const out = defaultScheduleParts();
  const fields = (expr || "").trim().split(/\s+/);
  if (fields.length < 5) return out;
  const [min, hour, dom, mon, dow] = fields;
  const num = (s: string) => (/^\d+$/.test(s) ? parseInt(s, 10) : NaN);

  const m = num(min);
  if (Number.isFinite(m)) out.minute = clampInt(m, 0, 59, 0);
  const h = num(hour);
  if (Number.isFinite(h)) out.hour = clampInt(h, 0, 23, 9);

  const domNum = num(dom);
  const monNum = num(mon);
  const dowFirst = num(dow.split(",")[0]);

  if (dom === "*" && mon === "*" && dow === "*") {
    out.frequency = "daily";
  } else if (dom === "*" && dow !== "*" && Number.isFinite(dowFirst)) {
    out.frequency = "weekly";
    out.weekday = clampInt(dowFirst, 0, 6, 1);
  } else if (mon === QUARTER_MONTHS && Number.isFinite(domNum)) {
    out.frequency = "quarterly";
    out.dayOfMonth = clampInt(domNum, 1, 31, 1);
  } else if (mon !== "*" && Number.isFinite(monNum) && Number.isFinite(domNum)) {
    out.frequency = "yearly";
    out.month = clampInt(monNum, 1, 12, 1);
    out.dayOfMonth = clampInt(domNum, 1, 31, 1);
  } else if (Number.isFinite(domNum)) {
    out.frequency = "monthly";
    out.dayOfMonth = clampInt(domNum, 1, 31, 1);
  }
  return out;
}

function formatTime(hour: number, minute: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

/**
 * Plain-English sentence for a friendly model, e.g. "The 1st of every month
 * at 9:00 AM".
 *
 * For a count of 1 the wording stays exactly as it always was. For "every N"
 * schedules it switches to an explicit "Every N <units> on <when>" phrasing
 * ("Every 2 weeks on Monday at 9:00 AM").
 */
export function describeParts(p: ScheduleParts): string {
  const at = ` at ${formatTime(clampInt(p.hour, 0, 23, 9), clampInt(p.minute, 0, 59, 0))}`;
  const n = clampIntervalCount(p.intervalCount);
  const dom = ordinal(clampInt(p.dayOfMonth, 1, 31, 1));
  const weekday = WEEKDAY_LABELS[clampInt(p.weekday, 0, 6, 1)];
  const monthName = MONTH_LABELS[clampInt(p.month, 1, 12, 1) - 1];

  if (n > 1) {
    const unit = { daily: "day", weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" }[
      p.frequency
    ];
    const every = `Every ${n} ${unit}s`;
    switch (p.frequency) {
      case "daily":
        return `${every}${at}`;
      case "weekly":
        return `${every} on ${weekday}${at}`;
      case "yearly":
        return `${every} on ${monthName} ${dom}${at}`;
      case "monthly":
      case "quarterly":
      default:
        return `${every} on the ${dom}${at}`;
    }
  }

  switch (p.frequency) {
    case "daily":
      return `Every day${at}`;
    case "weekly":
      return `Every ${weekday}${at}`;
    case "quarterly":
      return `The ${dom} of Jan, Apr, Jul & Oct${at}`;
    case "yearly":
      return `Every ${monthName} ${dom}${at}`;
    case "monthly":
    default:
      return `The ${dom} of every month${at}`;
  }
}

/**
 * Plain-English sentence straight from a cron expression (list + detail
 * views). The cron carries no count, so pass the entity's `intervalCount`
 * separately; it defaults to 1 for plain schedules.
 */
export function describeCron(expr: string, intervalCount = 1): string {
  return describeParts({ ...cronToParts(expr), intervalCount });
}
