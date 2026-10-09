import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { dateTimeLocalToIso, dateTimeLocalValue, defaultFollowUpDue } from "./revenue.js";

/**
 * A new follow-up opens with Due already filled — the next working morning —
 * and what the box holds is sent as the instant the person meant, not as wall
 * time for the server to read in its own zone. Dates here are built in local
 * time, the way the browser builds them.
 */

describe("defaultFollowUpDue", () => {
  test("a weekday is followed up at 09:00 the next morning", () => {
    // Wednesday 7 October 2026, mid-afternoon.
    assert.equal(defaultFollowUpDue(new Date(2026, 9, 7, 15, 30)), "2026-10-08T09:00");
    // Monday, a minute before midnight: still Tuesday morning.
    assert.equal(defaultFollowUpDue(new Date(2026, 9, 5, 23, 59)), "2026-10-06T09:00");
    // Early on a Tuesday: tomorrow, not later today.
    assert.equal(defaultFollowUpDue(new Date(2026, 9, 6, 6, 0)), "2026-10-07T09:00");
  });

  test("Friday, Saturday and Sunday roll to Monday", () => {
    assert.equal(defaultFollowUpDue(new Date(2026, 9, 9, 16, 0)), "2026-10-12T09:00");
    assert.equal(defaultFollowUpDue(new Date(2026, 9, 10, 10, 0)), "2026-10-12T09:00");
    assert.equal(defaultFollowUpDue(new Date(2026, 9, 11, 10, 0)), "2026-10-12T09:00");
  });

  test("months and years roll over", () => {
    // Thursday 31 December 2026 → Friday 1 January 2027.
    assert.equal(defaultFollowUpDue(new Date(2026, 11, 31, 12, 0)), "2027-01-01T09:00");
    // Friday 30 October 2026 → Monday 2 November.
    assert.equal(defaultFollowUpDue(new Date(2026, 9, 30, 12, 0)), "2026-11-02T09:00");
  });

  test("what the box holds is a value a datetime-local input accepts", () => {
    assert.match(defaultFollowUpDue(), /^\d{4}-\d{2}-\d{2}T09:00$/);
  });
});

describe("dateTimeLocalValue", () => {
  test("pads every part to the input's own format", () => {
    assert.equal(dateTimeLocalValue(new Date(2026, 0, 5, 7, 4)), "2026-01-05T07:04");
    assert.equal(dateTimeLocalValue(new Date(2026, 10, 25, 18, 45)), "2026-11-25T18:45");
  });
});

describe("dateTimeLocalToIso", () => {
  test("an empty box is no date", () => {
    assert.equal(dateTimeLocalToIso(""), null);
  });

  test("wall time goes as the instant it means here", () => {
    assert.equal(dateTimeLocalToIso("2026-10-12T09:00"), new Date(2026, 9, 12, 9, 0).toISOString());
  });

  test("the default round-trips to 09:00 local time", () => {
    const iso = dateTimeLocalToIso(defaultFollowUpDue(new Date(2026, 9, 7, 15, 30)));
    assert.ok(iso);
    const due = new Date(iso);
    assert.equal(due.getHours(), 9);
    assert.equal(due.getMinutes(), 0);
    assert.equal(due.getDate(), 8);
  });

  test("a value that is not a date goes as typed, for the server to refuse by name", () => {
    assert.equal(dateTimeLocalToIso("next week"), "next week");
  });
});
