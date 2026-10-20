import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isMonthKey,
  latestClosedMonth,
  ledgerDates,
  letterDueAt,
  monthAYearEarlier,
  monthContaining,
  monthLabel,
  nextMonth,
} from "./boardLetterPeriods.js";

const iso = (date: Date) => date.toISOString();

describe("the month a letter covers", () => {
  test("is bounded by local midnights on the first, on the company's clock", () => {
    const month = monthContaining(new Date("2026-10-20T12:00:00Z"), "America/Los_Angeles");
    assert.equal(month.month, "2026-10");
    // October starts in daylight time (UTC-7) and ends in it too: the change
    // back to standard time is on November 1 at 02:00, after midnight.
    assert.equal(iso(month.start), "2026-10-01T07:00:00.000Z");
    assert.equal(iso(month.end), "2026-11-01T07:00:00.000Z");
    assert.equal(month.ledgerFrom, "2026-10-01");
    assert.equal(month.ledgerTo, "2026-10-31");
  });

  test("follows daylight saving, so a month can be an hour shorter or longer", () => {
    const march = monthContaining(new Date("2026-03-15T12:00:00Z"), "Europe/Berlin");
    // Starts on CET (UTC+1), ends on CEST (UTC+2): 30 days and 23 hours.
    assert.equal(iso(march.start), "2026-02-28T23:00:00.000Z");
    assert.equal(iso(march.end), "2026-03-31T22:00:00.000Z");
    const hours = (march.end.getTime() - march.start.getTime()) / 3_600_000;
    assert.equal(hours, 31 * 24 - 1);
  });

  test("reads zones ahead of UTC on their own calendar", () => {
    // 2026-09-30T20:00Z is already October 1 in Auckland (UTC+13 in spring).
    const month = monthContaining(new Date("2026-09-30T20:00:00Z"), "Pacific/Auckland");
    assert.equal(month.month, "2026-10");
    assert.equal(iso(month.start), "2026-09-30T11:00:00.000Z");
  });

  test("puts a boundary instant in the month it begins, never in both", () => {
    const zone = "Asia/Kolkata";
    const september = monthContaining(new Date("2026-09-10T00:00:00Z"), zone);
    const atBoundary = monthContaining(september.end, zone);
    assert.equal(atBoundary.month, "2026-10");
    assert.equal(iso(atBoundary.start), iso(september.end));
    const justBefore = monthContaining(new Date(september.end.getTime() - 1), zone);
    assert.equal(justBefore.month, "2026-09");
  });

  test("tiles consecutive months with no gap or overlap", () => {
    const zone = "America/New_York";
    let month = monthContaining(new Date("2025-12-15T12:00:00Z"), zone);
    const seen: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const following = nextMonth(month, zone);
      assert.equal(iso(following.start), iso(month.end), `${month.month} → ${following.month}`);
      seen.push(month.month);
      month = following;
    }
    assert.deepEqual(seen.slice(0, 3), ["2025-12", "2026-01", "2026-02"]);
    assert.equal(seen.at(-1), "2027-01");
  });

  test("handles a zone whose clocks jump at midnight", () => {
    // Havana springs forward at 00:00 on its DST date, but the first of a
    // month still has a first instant, and months still tile.
    const zone = "America/Havana";
    const month = monthContaining(new Date("2026-10-20T12:00:00Z"), zone);
    assert.equal(month.month, "2026-10");
    assert.equal(iso(nextMonth(month, zone).start), iso(month.end));
  });

  test("uses the server's clock when the company has not picked a zone", () => {
    const month = monthContaining(new Date("2026-06-15T12:00:00Z"), "");
    assert.equal(month.month, "2026-06");
    const local = month.start;
    assert.equal(local.getDate(), 1);
    assert.equal(local.getHours(), 0);
    assert.equal(local.getMinutes(), 0);
  });
});

describe("the month a letter is owed for", () => {
  test("is the one that has most recently ended", () => {
    const month = latestClosedMonth(new Date("2026-10-20T12:00:00Z"), "UTC");
    assert.equal(month.month, "2026-09");
    assert.equal(iso(month.start), "2026-09-01T00:00:00.000Z");
    assert.equal(iso(month.end), "2026-10-01T00:00:00.000Z");
  });

  test("crosses the year", () => {
    const month = latestClosedMonth(new Date("2027-01-01T08:00:00Z"), "UTC");
    assert.equal(month.month, "2026-12");
    assert.equal(month.ledgerTo, "2026-12-31");
  });

  test("is still the previous month in a zone where the new one has not begun", () => {
    // 03:00 UTC on November 1 is still October 31 in Los Angeles.
    const month = latestClosedMonth(new Date("2026-11-01T03:00:00Z"), "America/Los_Angeles");
    assert.equal(month.month, "2026-09");
  });
});

describe("when a letter is due", () => {
  test("is 06:00 on the first of the next month, local time", () => {
    const zone = "America/Los_Angeles";
    const october = monthContaining(new Date("2026-10-20T12:00:00Z"), zone);
    // November 1 at 06:00 is after the 02:00 change back to PST (UTC-8).
    assert.equal(iso(letterDueAt(october, zone)), "2026-11-01T14:00:00.000Z");
  });

  test("is six hours after the month ends on a plain UTC clock", () => {
    const month = latestClosedMonth(new Date("2026-10-20T12:00:00Z"), "UTC");
    assert.equal(iso(letterDueAt(month, "UTC")), "2026-10-01T06:00:00.000Z");
  });
});

describe("month keys", () => {
  test("recognises only YYYY-MM", () => {
    assert.ok(isMonthKey("2026-09"));
    assert.ok(isMonthKey("1999-12"));
    for (const value of ["2026-9", "2026-13", "2026-00", "26-09", "2026-09-01", "", 202609, null]) {
      assert.equal(isMonthKey(value), false, String(value));
    }
  });

  test("give the calendar dates the ledger is read for", () => {
    assert.deepEqual(ledgerDates("2026-02"), { ledgerFrom: "2026-02-01", ledgerTo: "2026-02-28" });
    assert.deepEqual(ledgerDates("2028-02"), { ledgerFrom: "2028-02-01", ledgerTo: "2028-02-29" });
    assert.deepEqual(ledgerDates("2026-04"), { ledgerFrom: "2026-04-01", ledgerTo: "2026-04-30" });
    assert.throws(() => ledgerDates("September"));
  });

  test("name the same month a year earlier", () => {
    assert.equal(monthAYearEarlier("2026-09"), "2025-09");
    assert.equal(monthAYearEarlier("2026-01"), "2025-01");
  });

  test("read as a month and a year", () => {
    assert.equal(monthLabel("2026-09"), "September 2026");
    assert.equal(monthLabel("2027-01"), "January 2027");
    assert.equal(monthLabel("nonsense"), "nonsense");
  });
});
