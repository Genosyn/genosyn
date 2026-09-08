import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkEntry } from "./api.js";
import {
  shiftWorkCalendarDate,
  workCalendarDate,
  workCalendarHours,
  workCalendarWindow,
} from "./workCalendar.js";

function inTimezone(timezone: string, run: () => void): void {
  const original = process.env.TZ;
  process.env.TZ = timezone;
  try {
    run();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

function entry(id: string, at: string, endedAt: string | null = null): WorkEntry {
  return {
    id,
    at,
    endedAt,
    kind: "effect",
    active: false,
    employee: { id: "employee", name: "Jamie", slug: "jamie", avatarKey: null },
    title: "Updated a note",
    subject: "Quarterly plan",
    detail: "Updated note",
    run: null,
    effects: [],
    effectCount: 0,
  };
}

test("the selected date follows the Member's local day on either side of UTC", () => {
  inTimezone("America/Los_Angeles", () => {
    assert.equal(workCalendarDate("2026-09-08T02:00:00.000Z"), "2026-09-07");
  });
  inTimezone("Asia/Tokyo", () => {
    assert.equal(workCalendarDate("2026-09-08T23:00:00.000Z"), "2026-09-09");
  });
});

test("date navigation crosses year and leap-day boundaries", () => {
  inTimezone("Europe/London", () => {
    assert.equal(shiftWorkCalendarDate("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftWorkCalendarDate("2024-02-28", 1), "2024-02-29");
    assert.equal(shiftWorkCalendarDate("2024-02-29", 1), "2024-03-01");
  });
});

test("the day window uses local midnight and a short DST day has 23 hours", () => {
  inTimezone("America/New_York", () => {
    assert.deepEqual(workCalendarWindow("2026-03-08"), {
      since: "2026-03-08T05:00:00.000Z",
      until: "2026-03-09T04:00:00.000Z",
    });
    assert.equal(shiftWorkCalendarDate("2026-03-09", -1), "2026-03-08");
    const hours = workCalendarHours("2026-03-08", []);
    assert.equal(hours.length, 23);
    assert.ok(hours.every((hour) => new Date(hour.at).getHours() !== 2));
    assert.equal(new Date(hours[0].at).getHours(), 0);
    assert.equal(new Date(hours.at(-1)!.at).getHours(), 23);
  });
});

test("a repeated DST hour keeps both occurrences, distinct labels and the right entries", () => {
  inTimezone("America/New_York", () => {
    assert.deepEqual(workCalendarWindow("2026-11-01"), {
      since: "2026-11-01T04:00:00.000Z",
      until: "2026-11-02T05:00:00.000Z",
    });
    assert.equal(shiftWorkCalendarDate("2026-11-01", 1), "2026-11-02");
    const hours = workCalendarHours("2026-11-01", [
      entry("standard", "2026-11-01T06:30:00.000Z"),
      entry("daylight", "2026-11-01T05:30:00.000Z"),
    ]);
    assert.equal(hours.length, 25);
    const repeated = hours.filter((hour) => new Date(hour.at).getHours() === 1);
    assert.equal(repeated.length, 2);
    assert.notEqual(repeated[0].key, repeated[1].key);
    assert.notEqual(repeated[0].label, repeated[1].label);
    assert.match(repeated[0].label, /GMT-4/);
    assert.match(repeated[1].label, /GMT-5/);
    assert.deepEqual(repeated.map((hour) => hour.entries.map(({ id }) => id)), [
      ["daylight"],
      ["standard"],
    ]);
  });
});

test("hours preserve all overlapping entries in chronological order without mutating the input", () => {
  inTimezone("UTC", () => {
    const entries = [
      entry("later", "2026-09-08T09:50:00.000Z", "2026-09-08T11:00:00.000Z"),
      entry("earlier", "2026-09-08T09:05:00.000Z", "2026-09-08T12:00:00.000Z"),
      ...Array.from({ length: 50 }, (_, i) =>
        entry(`overlap-${i}`, "2026-09-08T09:30:00.000Z", "2026-09-08T10:00:00.000Z"),
      ),
    ];
    const originalOrder = entries.map(({ id }) => id);
    const hours = workCalendarHours("2026-09-08", entries);
    assert.equal(hours.length, 24);
    assert.equal(hours[9].entries.length, entries.length);
    assert.equal(hours[9].entries[0].id, "earlier");
    assert.equal(hours[9].entries.at(-1)!.id, "later");
    assert.equal(hours.flatMap((hour) => hour.entries).length, entries.length);
    assert.deepEqual(entries.map(({ id }) => id), originalOrder);
  });
});

test("the selected day includes its start and excludes the next midnight and invalid timestamps", () => {
  inTimezone("Asia/Kolkata", () => {
    const hours = workCalendarHours("2026-09-08", [
      entry("previous", "2026-09-07T18:29:59.999Z"),
      entry("start", "2026-09-07T18:30:00.000Z"),
      entry("last", "2026-09-08T18:29:59.999Z"),
      entry("next", "2026-09-08T18:30:00.000Z"),
      entry("invalid", "invalid"),
    ]);
    assert.deepEqual(hours.flatMap((hour) => hour.entries.map(({ id }) => id)), ["start", "last"]);
    assert.equal(hours[0].entries[0].id, "start");
    assert.equal(hours[23].entries[0].id, "last");
  });
});

test("invalid date values cannot silently roll into another month", () => {
  assert.throws(() => workCalendarWindow("2026-02-30"), RangeError);
  assert.throws(() => workCalendarWindow(""), RangeError);
  assert.throws(() => workCalendarDate("invalid"), RangeError);
});
