import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addDays,
  clockName,
  dayOf,
  dayStart,
  daysBetween,
  documentDay,
} from "../../shared/documentDays.js";

/**
 * Finance's figures read a document's dates as the calendar days they were
 * picked as, and today as the date on the company's clock
 * (`shared/documentDays.ts`, shared by the server's figures and the lists).
 */

describe("documentDay", () => {
  test("is the UTC date a document's date was stored on, whatever the reader's clock", () => {
    assert.equal(documentDay(new Date("2026-10-24T00:00:00.000Z")), "2026-10-24");
    assert.equal(documentDay("2026-10-24T00:00:00.000Z"), "2026-10-24");
    // A date stored with a time — an AI Employee's issue date of "now" — keeps
    // the UTC date every Finance page prints for it.
    assert.equal(documentDay("2026-10-24T23:59:59.999Z"), "2026-10-24");
    assert.equal(documentDay("2026-02-28T12:00:00.000Z"), "2026-02-28");
  });
});

describe("dayOf", () => {
  test("is the date an instant falls on in a time zone", () => {
    const evening = new Date("2026-10-24T20:00:00.000Z");
    assert.equal(dayOf(evening, "UTC"), "2026-10-24");
    assert.equal(dayOf(evening, "Asia/Singapore"), "2026-10-25");
    assert.equal(dayOf(evening, "America/Los_Angeles"), "2026-10-24");
    assert.equal(dayOf(new Date("2026-10-25T06:30:00.000Z"), "America/Los_Angeles"), "2026-10-24");
    assert.equal(dayOf(new Date("2026-10-24T10:30:00.000Z"), "Pacific/Kiritimati"), "2026-10-25");
  });

  test("follows daylight saving: midnight moves with the clocks", () => {
    // California falls back on 1 November 2026; 07:30 UTC is 00:30 PDT that day.
    assert.equal(dayOf(new Date("2026-11-01T07:30:00.000Z"), "America/Los_Angeles"), "2026-11-01");
    // A day later the same 07:30 UTC is 23:30 PST on the 1st.
    assert.equal(dayOf(new Date("2026-11-02T07:30:00.000Z"), "America/Los_Angeles"), "2026-11-01");
  });

  test("reads the runtime's own clock for an empty or unknown zone", () => {
    const instant = new Date("2026-10-24T12:00:00.000Z");
    const own = dayOf(instant);
    assert.equal(dayOf(instant, ""), own);
    assert.equal(dayOf(instant, "Not/AZone"), own);
    assert.equal(clockName(""), Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(clockName("Europe/Berlin"), "Europe/Berlin");
    assert.equal(clockName("Not/AZone"), Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("day arithmetic", () => {
  test("moves across months, years and leap days", () => {
    assert.equal(addDays("2026-10-24", 30), "2026-11-23");
    assert.equal(addDays("2026-10-24", -29), "2026-09-25");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });

  test("counts whole days between two dates, negative going back", () => {
    assert.equal(daysBetween("2026-10-24", "2026-10-25"), 1);
    assert.equal(daysBetween("2026-10-25", "2026-10-24"), -1);
    assert.equal(daysBetween("2026-07-26", "2026-10-24"), 90);
    assert.equal(daysBetween("2026-10-24", "2026-10-24"), 0);
    // Daylight saving never makes a day 23 or 25 hours long here.
    assert.equal(daysBetween("2026-10-31", "2026-11-02"), 2);
  });

  test("puts a day at midnight UTC, where a document dated that day is stored", () => {
    assert.equal(dayStart("2026-10-24").toISOString(), "2026-10-24T00:00:00.000Z");
    assert.throws(() => dayStart("24/10/2026"), /Not a calendar day/);
  });
});
