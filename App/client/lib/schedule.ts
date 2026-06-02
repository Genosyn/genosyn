// Friendly recurrence model for recurring invoices.
//
// The backend stores a plain cron expression (interpreted in server-local
// time by `cron-parser` / `node-cron`). Cron is great for a machine and
// awful for a human, so this module is the bridge: the UI offers a simple
// "Every month on the 1st at 9am" picker, and we compile that down to a
// cron string on save / parse it back on edit. Nothing about the schedule
// is stored differently — only how we ask for it.

export type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

export type ScheduleParts = {
  frequency: Frequency;
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
    dayOfMonth: 1,
    weekday: 1,
    month: 1,
    hour: 9,
    minute: 0,
  };
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

/** Compile the friendly model down to a standard 5-field cron expression. */
export function partsToCron(p: ScheduleParts): string {
  const m = clampInt(p.minute, 0, 59, 0);
  const h = clampInt(p.hour, 0, 23, 9);
  const dom = clampInt(p.dayOfMonth, 1, 31, 1);
  switch (p.frequency) {
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

  if (dom === "*" && dow !== "*" && Number.isFinite(dowFirst)) {
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

/** Plain-English sentence for a friendly model, e.g. "The 1st of every month at 9:00 AM". */
export function describeParts(p: ScheduleParts): string {
  const at = ` at ${formatTime(clampInt(p.hour, 0, 23, 9), clampInt(p.minute, 0, 59, 0))}`;
  switch (p.frequency) {
    case "weekly":
      return `Every ${WEEKDAY_LABELS[clampInt(p.weekday, 0, 6, 1)]}${at}`;
    case "quarterly":
      return `The ${ordinal(clampInt(p.dayOfMonth, 1, 31, 1))} of Jan, Apr, Jul & Oct${at}`;
    case "yearly":
      return `Every ${MONTH_LABELS[clampInt(p.month, 1, 12, 1) - 1]} ${ordinal(clampInt(p.dayOfMonth, 1, 31, 1))}${at}`;
    case "monthly":
    default:
      return `The ${ordinal(clampInt(p.dayOfMonth, 1, 31, 1))} of every month${at}`;
  }
}

/** Plain-English sentence straight from a cron expression (list + detail views). */
export function describeCron(expr: string): string {
  return describeParts(cronToParts(expr));
}
