/**
 * Calendar days for the figures Finance leads its lists with.
 *
 * Two kinds of date meet in those figures, and they are read differently:
 *
 * - **A document's own dates are calendar days.** An invoice's issue and due
 *   dates, an estimate's valid-until and a payment's date are picked as days
 *   and stored as UTC midnight, and every Finance page prints them as that
 *   UTC date. So a document's day is its UTC date ({@link documentDay}), never
 *   the date its stored instant falls on somewhere: read on a California
 *   clock, an invoice due on the 24th would otherwise fall due on the 23rd.
 * - **Today, and the moments things happened, are days on the company's
 *   clock.** `Company.timezone` names it, empty for server time, the clock its
 *   Routines run on ({@link dayOf}). An invoice due on the 24th is due today
 *   all of the 24th there, and overdue from the 25th.
 *
 * Days are `YYYY-MM-DD` strings, so comparing two is comparing strings and
 * nothing here depends on the zone of the process that runs it.
 */

/** `YYYY-MM-DD`. */
export type CalendarDay = string;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function utcDay(date: Date): CalendarDay {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The calendar day a document's date was picked as: its UTC date. */
export function documentDay(value: Date | string): CalendarDay {
  return utcDay(value instanceof Date ? value : new Date(value));
}

const DAY_PARTS = { year: "numeric", month: "2-digit", day: "2-digit" } as const;

/**
 * Formatters for named zones, null for a name `Intl` can't read. Building one
 * costs far more than using it, and a list asks once a row. The runtime's own
 * clock is never kept: a process can be moved to another zone.
 */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string | null | undefined): Intl.DateTimeFormat | null {
  const zone = (timeZone ?? "").trim();
  if (!zone) return null;
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", { ...DAY_PARTS, timeZone: zone });
    } catch {
      formatter = null;
    }
    if (formatters.size >= 64) formatters.clear();
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** A zone `Intl` can read, or undefined for the runtime's own clock. */
function knownZone(timeZone: string | null | undefined): string | undefined {
  return zoneFormatter(timeZone) ? (timeZone ?? "").trim() : undefined;
}

/**
 * The day `instant` falls on in `timeZone`. An empty or unknown zone reads the
 * runtime's own clock: server time on the server, the viewer's in a browser.
 */
export function dayOf(instant: Date, timeZone?: string | null): CalendarDay {
  const formatter = zoneFormatter(timeZone) ?? new Intl.DateTimeFormat("en-US", DAY_PARTS);
  const parts = formatter.formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The IANA name of the clock {@link dayOf} reads for `timeZone`: "" resolves to the runtime's. */
export function clockName(timeZone?: string | null): string {
  return knownZone(timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

/** Midnight UTC at the start of `day`: where a document dated that day is stored. */
export function dayStart(day: CalendarDay): Date {
  const match = DAY.exec(day);
  if (!match) throw new Error(`Not a calendar day: ${day}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** `day` moved by `days` (negative goes back). */
export function addDays(day: CalendarDay, days: number): CalendarDay {
  return utcDay(new Date(dayStart(day).getTime() + days * DAY_MS));
}

/** Whole days from `from` to `to`: 1 from the 24th to the 25th, -1 back again. */
export function daysBetween(from: CalendarDay, to: CalendarDay): number {
  return Math.round((dayStart(to).getTime() - dayStart(from).getTime()) / DAY_MS);
}
