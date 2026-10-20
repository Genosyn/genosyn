import parser from "cron-parser";

import { cronZoneOptions } from "./cronMath.js";

/**
 * Which month a letter to the board covers, and when it is due.
 *
 * A letter covers one calendar month on the company's own clock
 * (`Company.timezone`, empty for server time — the same clock its Routines
 * run on). The month is the half-open interval between two local midnights
 * on the first, so consecutive months tile time exactly: a Run that finished
 * at 23:59 on the 31st belongs to that month, one at 00:00 on the 1st to the
 * next, and none to both.
 *
 * The boundaries come from `cron-parser` reading `0 0 1 * *` in the zone,
 * which is the engine that already fires every Routine on that clock, so the
 * two can never disagree about when a month ends, daylight saving included.
 *
 * Ledger figures use the month's calendar dates instead (`ledgerFrom` …
 * `ledgerTo`): a journal entry carries a date, not an instant, and Finance →
 * Reports filters by date. Reading the same dates is what lets every money
 * figure in a letter match the report the board can open for that month.
 */

/** Local midnight on the first: the boundary between two months. */
const MONTH_BOUNDARY = "0 0 1 * *";

/** A letter is written at 06:00 on the first, once overnight work has landed. */
const LETTER_DUE = "0 6 1 * *";

export type LetterMonth = {
  /** `YYYY-MM`, the month on the company's clock. */
  month: string;
  /** Local midnight on the first, inclusive. */
  start: Date;
  /** Local midnight on the first of the next month, exclusive. */
  end: Date;
  /** First calendar date of the month, `YYYY-MM-DD`, for ledger reads. */
  ledgerFrom: string;
  /** Last calendar date of the month, `YYYY-MM-DD`, for ledger reads. */
  ledgerTo: string;
};

function boundaryBefore(instant: Date, timeZone: string): Date {
  return parser
    .parseExpression(MONTH_BOUNDARY, { currentDate: instant, ...cronZoneOptions(timeZone) })
    .prev()
    .toDate();
}

function boundaryAfter(instant: Date, timeZone: string): Date {
  return parser
    .parseExpression(MONTH_BOUNDARY, { currentDate: instant, ...cronZoneOptions(timeZone) })
    .next()
    .toDate();
}

/** `YYYY-MM` of an instant, read on the zone's calendar ("" is server time). */
function localMonthKey(instant: Date, timeZone: string): string {
  const zone = cronZoneOptions(timeZone).tz;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

function monthFromStart(start: Date, timeZone: string): LetterMonth {
  const end = boundaryAfter(start, timeZone);
  const month = localMonthKey(start, timeZone);
  const { ledgerFrom, ledgerTo } = ledgerDates(month);
  return { month, start, end, ledgerFrom, ledgerTo };
}

/** The month on the company's clock that contains `instant`. */
export function monthContaining(instant: Date, timeZone: string): LetterMonth {
  // `prev()` is strictly before its current date, so a boundary instant itself
  // would otherwise land in the month it ends rather than the one it begins.
  const start = boundaryBefore(new Date(instant.getTime() + 1), timeZone);
  return monthFromStart(start, timeZone);
}

/** The most recent month that has ended by `now`: the one a letter is owed for. */
export function latestClosedMonth(now: Date, timeZone: string): LetterMonth {
  const current = monthContaining(now, timeZone);
  return monthFromStart(boundaryBefore(current.start, timeZone), timeZone);
}

/** The month after `month`, on the same clock. */
export function nextMonth(month: LetterMonth, timeZone: string): LetterMonth {
  return monthFromStart(month.end, timeZone);
}

/**
 * When the letter for `month` is due: 06:00 on the first of the following
 * month, local time. A few hours past midnight on purpose, so a Routine that
 * closes the books just after the month ends lands before the letter reads them.
 */
export function letterDueAt(month: LetterMonth, timeZone: string): Date {
  return parser
    .parseExpression(LETTER_DUE, {
      currentDate: new Date(month.end.getTime() - 1),
      ...cronZoneOptions(timeZone),
    })
    .next()
    .toDate();
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Whether a string is a `YYYY-MM` month key. */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY.test(value);
}

/** The first and last calendar dates of a `YYYY-MM` month. */
export function ledgerDates(month: string): { ledgerFrom: string; ledgerTo: string } {
  const match = MONTH_KEY.exec(month);
  if (!match) throw new Error(`Not a month: ${month}`);
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const lastDay = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  return {
    ledgerFrom: `${match[1]}-${match[2]}-01`,
    ledgerTo: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** `2026-09` → `2025-09`: the same month a year earlier. */
export function monthAYearEarlier(month: string): string {
  const match = MONTH_KEY.exec(month);
  if (!match) throw new Error(`Not a month: ${month}`);
  return `${String(Number(match[1]) - 1).padStart(4, "0")}-${match[2]}`;
}

/** `2026-09` → `September 2026`. */
export function monthLabel(month: string): string {
  const match = MONTH_KEY.exec(month);
  if (!match) return month;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
