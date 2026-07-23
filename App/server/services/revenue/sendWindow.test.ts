import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addStepDelay,
  computeNextRunAt,
  isWithinSendWindow,
  nextWindowOpening,
  selectDueEnrollments,
  type SendWindow,
} from "./sendWindow.js";

const at = (iso: string): Date => new Date(iso);
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Mon-Fri 09:00-17:00, timezone supplied per test. */
const business = (timezone: string): SendWindow => ({
  days: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 17,
  timezone,
});

// Anchors used throughout. 2026-07-19 is a Sunday, so 07-20 is a Monday and
// 07-24 a Friday; every weekday below is derived from that one fact.
const MON = "2026-07-20";
const FRI = "2026-07-24";
const SAT = "2026-07-25";
const SUN = "2026-07-26";

// ───────────────────────── isWithinSendWindow ─────────────────────────

describe("isWithinSendWindow — plain daytime window", () => {
  const w = business("UTC");

  test("an instant in the middle of the window is inside", () => {
    assert.equal(isWithinSendWindow(at(`${MON}T12:00:00Z`), w), true);
  });

  test("startHour is inclusive", () => {
    assert.equal(isWithinSendWindow(at(`${MON}T09:00:00Z`), w), true);
    assert.equal(isWithinSendWindow(at(`${MON}T08:59:59Z`), w), false);
  });

  test("endHour is exclusive — 17:00 is already shut", () => {
    assert.equal(isWithinSendWindow(at(`${MON}T16:59:59Z`), w), true);
    assert.equal(isWithinSendWindow(at(`${MON}T17:00:00Z`), w), false);
  });

  test("midnight and the small hours are outside", () => {
    assert.equal(isWithinSendWindow(at(`${MON}T00:00:00Z`), w), false);
    assert.equal(isWithinSendWindow(at(`${MON}T03:00:00Z`), w), false);
  });

  test("weekends are skipped even at a perfectly reasonable hour", () => {
    assert.equal(isWithinSendWindow(at(`${SAT}T12:00:00Z`), w), false);
    assert.equal(isWithinSendWindow(at(`${SUN}T12:00:00Z`), w), false);
  });

  test("day 0 means Sunday, matching getUTCDay and cron", () => {
    // 2026-07-19 Sun … 2026-07-25 Sat, one single-day window each.
    const dates = [
      "2026-07-19", "2026-07-20", "2026-07-21", "2026-07-22",
      "2026-07-23", "2026-07-24", "2026-07-25",
    ];
    dates.forEach((date, index) => {
      const single: SendWindow = { days: [index], startHour: 9, endHour: 17, timezone: "UTC" };
      assert.equal(isWithinSendWindow(at(`${date}T12:00:00Z`), single), true, `${date} vs day ${index}`);
      const neighbour: SendWindow = { ...single, days: [(index + 1) % 7] };
      assert.equal(isWithinSendWindow(at(`${date}T12:00:00Z`), neighbour), false, `${date} vs day ${index + 1}`);
    });
  });
});

describe("isWithinSendWindow — degenerate configurations", () => {
  test("an empty day list never sends — the supported way to freeze a sequence", () => {
    const frozen: SendWindow = { days: [], startHour: 0, endHour: 24, timezone: "UTC" };
    assert.equal(isWithinSendWindow(at(`${MON}T12:00:00Z`), frozen), false);
    assert.equal(isWithinSendWindow(at(`${SAT}T03:00:00Z`), frozen), false);
  });

  test("startHour === endHour reads as never, not as around-the-clock", () => {
    const w: SendWindow = { days: [0, 1, 2, 3, 4, 5, 6], startHour: 9, endHour: 9, timezone: "UTC" };
    assert.equal(isWithinSendWindow(at(`${MON}T09:00:00Z`), w), false);
    assert.equal(isWithinSendWindow(at(`${MON}T09:30:00Z`), w), false);
    assert.equal(isWithinSendWindow(at(`${MON}T12:00:00Z`), w), false);
  });

  test("0-24 is how a caller actually asks for all day", () => {
    const w: SendWindow = { days: [1], startHour: 0, endHour: 24, timezone: "UTC" };
    for (const hour of [0, 6, 12, 23]) {
      const stamp = `${MON}T${String(hour).padStart(2, "0")}:00:00Z`;
      assert.equal(isWithinSendWindow(at(stamp), w), true, stamp);
    }
  });

  test("non-finite hours degrade to never rather than throwing", () => {
    // Regression: a NaN endHour fails the `start < end` test, so without an
    // explicit guard it falls into the midnight-wrap branch and leaves the
    // window open from startHour until the end of time.
    const cases: Pick<SendWindow, "startHour" | "endHour">[] = [
      { startHour: Number.NaN, endHour: 17 },
      { startHour: 9, endHour: Number.NaN },
      { startHour: Number.NaN, endHour: Number.NaN },
      { startHour: 9, endHour: Infinity },
      { startHour: -Infinity, endHour: 17 },
    ];
    for (const hours of cases) {
      const w: SendWindow = { days: [1], timezone: "UTC", ...hours };
      for (const hour of ["00", "09", "12", "23"]) {
        assert.equal(
          isWithinSendWindow(at(`${MON}T${hour}:00:00Z`), w),
          false,
          `${JSON.stringify(hours)} at ${hour}:00`,
        );
      }
    }
  });

  test("an Invalid Date is outside every window", () => {
    assert.equal(isWithinSendWindow(new Date(Number.NaN), business("UTC")), false);
    assert.equal(isWithinSendWindow(new Date("nonsense"), business("UTC")), false);
  });

  test("out-of-range day numbers simply never match", () => {
    const w: SendWindow = { days: [7, -1, 99], startHour: 9, endHour: 17, timezone: "UTC" };
    assert.equal(isWithinSendWindow(at(`${MON}T12:00:00Z`), w), false);
  });
});

describe("isWithinSendWindow — timezones", () => {
  test("the same instant is judged in the window's own zone", () => {
    const instant = at(`${MON}T12:00:00Z`); // 08:00 in New York, 12:00 in UTC
    assert.equal(isWithinSendWindow(instant, business("UTC")), true);
    assert.equal(isWithinSendWindow(instant, business("America/New_York")), false);
    assert.equal(isWithinSendWindow(at(`${MON}T13:00:00Z`), business("America/New_York")), true);
  });

  test("a zone whose offset is not a whole hour still resolves correctly", () => {
    // Asia/Kathmandu is +05:45, so 18:15Z is exactly Tuesday 00:00 local.
    const w: SendWindow = { days: [2], startHour: 0, endHour: 1, timezone: "Asia/Kathmandu" };
    assert.equal(isWithinSendWindow(at(`${MON}T18:15:00Z`), w), true);
    assert.equal(isWithinSendWindow(at(`${MON}T18:14:00Z`), w), false); // still Monday 23:59
  });

  test("a zone east of the date line can be a day ahead of UTC", () => {
    const w: SendWindow = { days: [2], startHour: 9, endHour: 17, timezone: "Pacific/Auckland" };
    // Monday 22:00Z is Tuesday morning in Auckland (+12 in July).
    assert.equal(isWithinSendWindow(at(`${MON}T22:00:00Z`), w), true);
  });

  test("an unknown timezone falls back to UTC instead of throwing", () => {
    const bogus: SendWindow = { ...business("Mars/Olympus_Mons") };
    assert.doesNotThrow(() => isWithinSendWindow(at(`${MON}T12:00:00Z`), bogus));
    // 12:00Z is inside a UTC 9-17 window but outside a New York one, so a true
    // here proves the fallback is UTC and not the host's local zone.
    assert.equal(isWithinSendWindow(at(`${MON}T12:00:00Z`), bogus), true);
    assert.equal(isWithinSendWindow(at(`${MON}T20:00:00Z`), bogus), false);
  });

  test("an empty timezone string is treated as UTC", () => {
    assert.equal(isWithinSendWindow(at(`${MON}T12:00:00Z`), business("")), true);
    assert.equal(isWithinSendWindow(at(`${MON}T02:00:00Z`), business("")), false);
  });
});

describe("isWithinSendWindow — windows that cross midnight", () => {
  const monOnly: SendWindow = { days: [1], startHour: 22, endHour: 6, timezone: "UTC" };
  const monTue: SendWindow = { ...monOnly, days: [1, 2] };

  test("the evening half is inside on the listed day", () => {
    assert.equal(isWithinSendWindow(at(`${MON}T22:00:00Z`), monOnly), true);
    assert.equal(isWithinSendWindow(at(`${MON}T23:59:00Z`), monOnly), true);
    assert.equal(isWithinSendWindow(at(`${MON}T21:59:00Z`), monOnly), false);
  });

  test("the early-morning half lands on the NEXT local day, as documented", () => {
    // Tuesday 05:00 is not covered by a Monday-only 22:00-06:00 window.
    assert.equal(isWithinSendWindow(at("2026-07-21T05:00:00Z"), monOnly), false);
    assert.equal(isWithinSendWindow(at("2026-07-21T05:00:00Z"), monTue), true);
  });

  test("listing the day also opens that day's own early morning", () => {
    // The flip side of the same rule: Monday 05:00 matches day 1 + hour < 6.
    assert.equal(isWithinSendWindow(at(`${MON}T05:00:00Z`), monOnly), true);
  });

  test("endHour stays exclusive across the wrap", () => {
    assert.equal(isWithinSendWindow(at("2026-07-21T05:59:00Z"), monTue), true);
    assert.equal(isWithinSendWindow(at("2026-07-21T06:00:00Z"), monTue), false);
  });

  test("the middle of the day is outside a night window", () => {
    assert.equal(isWithinSendWindow(at(`${MON}T12:00:00Z`), monTue), false);
  });
});

describe("isWithinSendWindow — DST transitions in America/New_York", () => {
  // Spring forward: 2026-03-08, 02:00 EST -> 03:00 EDT. Local hour 2 never
  // happens that day.
  const sundayEarly = (startHour: number, endHour: number): SendWindow => ({
    days: [0],
    startHour,
    endHour,
    timezone: "America/New_York",
  });

  test("spring forward: the 01:00 hour is real", () => {
    assert.equal(isWithinSendWindow(at("2026-03-08T06:30:00Z"), sundayEarly(1, 2)), true);
  });

  test("spring forward: the 02:00 hour does not exist and never matches", () => {
    const w = sundayEarly(2, 3);
    for (const stamp of [
      "2026-03-08T06:30:00Z", // 01:30 EST
      "2026-03-08T07:00:00Z", // 03:00 EDT — the clock jumped straight here
      "2026-03-08T07:30:00Z", // 03:30 EDT
    ]) {
      assert.equal(isWithinSendWindow(at(stamp), w), false, stamp);
    }
  });

  test("spring forward: 07:00Z is 03:00 local, not 02:00", () => {
    assert.equal(isWithinSendWindow(at("2026-03-08T07:00:00Z"), sundayEarly(3, 4)), true);
    assert.equal(isWithinSendWindow(at("2026-03-08T06:59:00Z"), sundayEarly(3, 4)), false);
  });

  test("fall back: the 01:00 hour happens twice and both instants are inside", () => {
    // 2026-11-01, 02:00 EDT -> 01:00 EST.
    const w: SendWindow = { days: [0], startHour: 1, endHour: 2, timezone: "America/New_York" };
    assert.equal(isWithinSendWindow(at("2026-11-01T05:30:00Z"), w), true); // 01:30 EDT
    assert.equal(isWithinSendWindow(at("2026-11-01T06:30:00Z"), w), true); // 01:30 EST
    assert.equal(isWithinSendWindow(at("2026-11-01T04:59:00Z"), w), false); // 00:59 EDT
    assert.equal(isWithinSendWindow(at("2026-11-01T07:00:00Z"), w), false); // 02:00 EST
  });

  test("a business window keeps the same LOCAL hours either side of a shift", () => {
    // 14:00Z is 09:00 EST in winter but 10:00 EDT in summer; 13:00Z is 09:00
    // EDT. Both are inside, which is the entire point of resolving locally.
    const w = business("America/New_York");
    assert.equal(isWithinSendWindow(at("2026-01-05T14:00:00Z"), w), true); // Mon, EST
    assert.equal(isWithinSendWindow(at("2026-01-05T13:00:00Z"), w), false); // 08:00 EST
    assert.equal(isWithinSendWindow(at("2026-07-06T13:00:00Z"), w), true); // Mon, EDT
  });
});

// ───────────────────────── nextWindowOpening ─────────────────────────

describe("nextWindowOpening", () => {
  const w = business("UTC");

  test("an instant already inside is returned unchanged, and by identity", () => {
    const from = at(`${MON}T12:07:33.500Z`);
    const result = nextWindowOpening(from, w);
    assert.equal(result, from);
  });

  test("before the window opens, it returns today's opening", () => {
    assert.equal(iso(nextWindowOpening(at(`${MON}T06:07:00Z`), w)), `${MON}T09:00:00.000Z`);
  });

  test("the result is snapped to the start of a 15-minute slot", () => {
    const result = nextWindowOpening(at(`${MON}T08:52:37.123Z`), w);
    assert.equal(iso(result), `${MON}T09:00:00.000Z`);
    assert.equal((result as Date).getTime() % (15 * 60 * 1000), 0);
  });

  test("a midnight-crossing window opens on the quarter hour too", () => {
    const night: SendWindow = { days: [1], startHour: 22, endHour: 6, timezone: "UTC" };
    assert.equal(iso(nextWindowOpening(at(`${MON}T21:52:00Z`), night)), `${MON}T22:00:00.000Z`);
  });

  test("after the window closes, it rolls to the next listed day", () => {
    assert.equal(
      iso(nextWindowOpening(at(`${MON}T18:00:00Z`), w)),
      "2026-07-21T09:00:00.000Z",
    );
  });

  test("Friday evening skips the weekend and lands on Monday", () => {
    assert.equal(
      iso(nextWindowOpening(at(`${FRI}T18:00:00Z`), w)),
      "2026-07-27T09:00:00.000Z",
    );
  });

  test("Saturday afternoon also lands on Monday morning", () => {
    assert.equal(
      iso(nextWindowOpening(at(`${SAT}T14:30:00Z`), w)),
      "2026-07-27T09:00:00.000Z",
    );
  });

  test("an empty day list finds nothing, ever", () => {
    const frozen: SendWindow = { days: [], startHour: 9, endHour: 17, timezone: "UTC" };
    assert.equal(nextWindowOpening(at(`${MON}T09:00:00Z`), frozen), null);
  });

  test("startHour === endHour finds nothing", () => {
    const zero: SendWindow = { days: [1], startHour: 9, endHour: 9, timezone: "UTC" };
    assert.equal(nextWindowOpening(at(`${MON}T00:00:00Z`), zero), null);
  });

  test("returns null when the window does not open inside maxDays", () => {
    const sundayOnly: SendWindow = { days: [0], startHour: 9, endHour: 17, timezone: "UTC" };
    assert.equal(nextWindowOpening(at(`${MON}T10:00:00Z`), sundayOnly, 3), null);
    assert.equal(
      iso(nextWindowOpening(at(`${MON}T10:00:00Z`), sundayOnly, 6)),
      `${SUN}T09:00:00.000Z`,
    );
  });

  test("maxDays of 0 still honours an instant that is already inside", () => {
    const from = at(`${MON}T12:00:00Z`);
    assert.equal(nextWindowOpening(from, w, 0), from);
    assert.equal(nextWindowOpening(at(`${MON}T08:00:00Z`), w, 0), null);
  });

  test("a negative or non-finite maxDays yields null rather than looping", () => {
    assert.equal(nextWindowOpening(at(`${MON}T08:00:00Z`), w, -5), null);
    assert.equal(nextWindowOpening(at(`${MON}T08:00:00Z`), w, Number.NaN), null);
  });

  test("an Invalid Date yields null", () => {
    assert.equal(nextWindowOpening(new Date(Number.NaN), w), null);
  });

  test("steps across a spring-forward gap without inventing 02:00", () => {
    const twoAm: SendWindow = { days: [0], startHour: 2, endHour: 3, timezone: "America/New_York" };
    // Sunday 2026-03-08 has no 02:00 local hour at all.
    assert.equal(nextWindowOpening(at("2026-03-08T05:00:00Z"), twoAm, 1), null);
    // The window is honoured again the following Sunday, at 02:00 EDT.
    assert.equal(
      iso(nextWindowOpening(at("2026-03-08T05:00:00Z"), twoAm, 8)),
      "2026-03-15T06:00:00.000Z",
    );
  });

  test("lands on the instant the clock jumps to when the window starts at 03:00", () => {
    const threeAm: SendWindow = { days: [0], startHour: 3, endHour: 4, timezone: "America/New_York" };
    assert.equal(
      iso(nextWindowOpening(at("2026-03-08T05:00:00Z"), threeAm, 1)),
      "2026-03-08T07:00:00.000Z",
    );
  });

  test("uses the FIRST of the two 01:00 hours on a fall-back morning", () => {
    const oneAm: SendWindow = { days: [0], startHour: 1, endHour: 2, timezone: "America/New_York" };
    assert.equal(
      iso(nextWindowOpening(at("2026-11-01T04:00:00Z"), oneAm, 1)),
      "2026-11-01T05:00:00.000Z",
    );
  });

  test("resolves a 45-minute-offset zone to the right quarter hour", () => {
    const w2: SendWindow = { days: [2], startHour: 0, endHour: 1, timezone: "Asia/Kathmandu" };
    assert.equal(iso(nextWindowOpening(at(`${MON}T12:00:00Z`), w2)), `${MON}T18:15:00.000Z`);
  });

  test("an unknown timezone schedules against UTC instead of failing", () => {
    const bogus = business("Not/AZone");
    assert.equal(
      iso(nextWindowOpening(at(`${MON}T06:00:00Z`), bogus)),
      `${MON}T09:00:00.000Z`,
    );
  });
});

// ─────────────────────────── addStepDelay ───────────────────────────

describe("addStepDelay", () => {
  const from = at(`${MON}T10:00:00Z`);

  test("adds days and hours together", () => {
    assert.equal(iso(addStepDelay(from, 2, 3)), "2026-07-22T13:00:00.000Z");
  });

  test("a zero delay is the same instant", () => {
    assert.equal(addStepDelay(from, 0, 0).getTime(), from.getTime());
  });

  test("hours alone can roll past midnight", () => {
    assert.equal(iso(addStepDelay(from, 0, 20)), "2026-07-21T06:00:00.000Z");
  });

  test("fractional delays are honoured — it is duration arithmetic", () => {
    assert.equal(iso(addStepDelay(from, 0.5, 0)), `${MON}T22:00:00.000Z`);
    assert.equal(iso(addStepDelay(from, 0, 0.25)), `${MON}T10:15:00.000Z`);
  });

  test("negative delays clamp to zero, each component independently", () => {
    assert.equal(addStepDelay(from, -3, 0).getTime(), from.getTime());
    assert.equal(addStepDelay(from, 0, -3).getTime(), from.getTime());
    assert.equal(addStepDelay(from, -5, -5).getTime(), from.getTime());
    assert.equal(iso(addStepDelay(from, -1, 2)), `${MON}T12:00:00.000Z`);
  });

  test("adds a fixed duration, not calendar days, across a DST boundary", () => {
    // 72 hours after Friday 10:00 EST on the spring-forward weekend is Monday
    // 11:00 EDT. A calendar-days implementation would say 10:00.
    assert.equal(iso(addStepDelay(at("2026-03-06T15:00:00Z"), 3, 0)), "2026-03-09T15:00:00.000Z");
  });

  test("throws on a non-finite delay — that is programmer error, not data", () => {
    assert.throws(() => addStepDelay(from, Number.NaN, 0));
    assert.throws(() => addStepDelay(from, 0, Number.NaN));
    assert.throws(() => addStepDelay(from, Infinity, 0));
    assert.throws(() => addStepDelay(from, 0, -Infinity));
  });

  test("does not mutate the input date", () => {
    const original = at(`${MON}T10:00:00Z`);
    addStepDelay(original, 5, 5);
    assert.equal(iso(original), `${MON}T10:00:00.000Z`);
  });
});

// ────────────────────────── computeNextRunAt ──────────────────────────

describe("computeNextRunAt", () => {
  const w = business("UTC");

  test("a delay that lands inside the window is used verbatim", () => {
    const result = computeNextRunAt(
      at(`${MON}T10:00:00Z`),
      { delayDays: 3, delayHours: 0 },
      w,
      at(`${MON}T10:00:00Z`),
    );
    assert.equal(iso(result), "2026-07-23T10:00:00.000Z");
  });

  test("a delay that lands at night is pushed to the next opening", () => {
    const result = computeNextRunAt(
      at(`${MON}T10:00:00Z`),
      { delayDays: 0, delayHours: 12 }, // 22:00 Monday
      w,
      at(`${MON}T10:00:00Z`),
    );
    assert.equal(iso(result), "2026-07-21T09:00:00.000Z");
  });

  test("a delay that lands on a weekend is pushed to Monday", () => {
    const result = computeNextRunAt(
      at(`${FRI}T16:00:00Z`),
      { delayDays: 1, delayHours: 0 }, // Saturday 16:00
      w,
      at(`${FRI}T16:00:00Z`),
    );
    assert.equal(iso(result), "2026-07-27T09:00:00.000Z");
  });

  test("never returns a time before `now`, even for a long-overdue step", () => {
    const result = computeNextRunAt(
      at("2026-06-01T10:00:00Z"),
      { delayDays: 1, delayHours: 0 },
      w,
      at(`${MON}T12:00:00Z`),
    );
    assert.equal(iso(result), `${MON}T12:00:00.000Z`);
  });

  test("a backlog resuming outside the window waits for the next opening", () => {
    // The clamp happens BEFORE the window push, so a scheduler that was down
    // over a weekend resumes Monday morning rather than firing on Saturday.
    const result = computeNextRunAt(
      at("2026-06-01T10:00:00Z"),
      { delayDays: 1, delayHours: 0 },
      w,
      at(`${SAT}T23:00:00Z`),
    );
    assert.equal(iso(result), "2026-07-27T09:00:00.000Z");
  });

  test("a negative delay is clamped, so the step is due immediately", () => {
    const result = computeNextRunAt(
      at(`${MON}T12:00:00Z`),
      { delayDays: -7, delayHours: -7 },
      w,
      at(`${MON}T12:00:00Z`),
    );
    assert.equal(iso(result), `${MON}T12:00:00.000Z`);
  });

  test("a frozen window yields null instead of a send time", () => {
    const frozen: SendWindow = { days: [], startHour: 9, endHour: 17, timezone: "UTC" };
    assert.equal(
      computeNextRunAt(at(`${MON}T10:00:00Z`), { delayDays: 1, delayHours: 0 }, frozen, at(`${MON}T10:00:00Z`)),
      null,
    );
  });

  test("a window that will not open for a month yields null", () => {
    const sundayOnly: SendWindow = { days: [0], startHour: 9, endHour: 10, timezone: "UTC" };
    const result = computeNextRunAt(
      at(`${MON}T10:00:00Z`),
      { delayDays: 0, delayHours: 1 },
      sundayOnly,
      at(`${MON}T10:00:00Z`),
    );
    // Within 14 days there IS a Sunday, so this one resolves.
    assert.equal(iso(result), `${SUN}T09:00:00.000Z`);
  });

  test("an Invalid previousSendAt skips the row rather than stalling the tick", () => {
    assert.equal(
      computeNextRunAt(new Date(Number.NaN), { delayDays: 1, delayHours: 0 }, w, at(`${MON}T10:00:00Z`)),
      null,
    );
  });

  test("an Invalid `now` also yields null", () => {
    assert.equal(
      computeNextRunAt(at(`${MON}T10:00:00Z`), { delayDays: 1, delayHours: 0 }, w, new Date(Number.NaN)),
      null,
    );
  });

  test("respects the sequence timezone, not UTC", () => {
    const ny = business("America/New_York");
    // 14:00Z on Monday is 10:00 EDT — fine in New York, fine in UTC too, so
    // use an instant that separates them: 22:00Z is 18:00 EDT, shut.
    const result = computeNextRunAt(
      at(`${MON}T10:00:00Z`),
      { delayDays: 0, delayHours: 12 }, // 22:00Z = 18:00 EDT
      ny,
      at(`${MON}T10:00:00Z`),
    );
    assert.equal(iso(result), "2026-07-21T13:00:00.000Z"); // Tue 09:00 EDT
  });
});

// ───────────────────────── selectDueEnrollments ─────────────────────────

type Enrollment = { id: string; nextRunAt: Date | null };

const enrollment = (id: string, isoStamp: string | null): Enrollment => ({
  id,
  nextRunAt: isoStamp === null ? null : at(isoStamp),
});

describe("selectDueEnrollments", () => {
  const now = at(`${MON}T12:00:00Z`);

  test("returns due enrollments oldest first — fairness, not insertion order", () => {
    const rows = [
      enrollment("c", `${MON}T11:00:00Z`),
      enrollment("a", `${MON}T09:00:00Z`),
      enrollment("b", `${MON}T10:00:00Z`),
    ];
    assert.deepEqual(selectDueEnrollments(rows, now, 10).map((r) => r.id), ["a", "b", "c"]);
  });

  test("truncating to the cap keeps the OLDEST, so nobody starves", () => {
    const rows = [
      enrollment("newest", `${MON}T11:59:00Z`),
      enrollment("oldest", `${MON}T01:00:00Z`),
      enrollment("middle", `${MON}T06:00:00Z`),
    ];
    assert.deepEqual(selectDueEnrollments(rows, now, 2).map((r) => r.id), ["oldest", "middle"]);
  });

  test("a cap of exactly the due count returns everything", () => {
    const rows = [enrollment("a", `${MON}T09:00:00Z`), enrollment("b", `${MON}T10:00:00Z`)];
    assert.equal(selectDueEnrollments(rows, now, 2).length, 2);
  });

  test("a fractional cap floors rather than rounding up", () => {
    const rows = [
      enrollment("a", `${MON}T09:00:00Z`),
      enrollment("b", `${MON}T10:00:00Z`),
      enrollment("c", `${MON}T11:00:00Z`),
    ];
    assert.deepEqual(selectDueEnrollments(rows, now, 2.9).map((r) => r.id), ["a", "b"]);
  });

  test("a cap of zero or less sends nothing — the budget is spent", () => {
    const rows = [enrollment("a", `${MON}T09:00:00Z`)];
    assert.deepEqual(selectDueEnrollments(rows, now, 0), []);
    assert.deepEqual(selectDueEnrollments(rows, now, -3), []);
    assert.deepEqual(selectDueEnrollments(rows, now, Number.NaN), []);
  });

  test("a null nextRunAt means not scheduled, not due now", () => {
    const rows = [enrollment("paused", null), enrollment("live", `${MON}T09:00:00Z`)];
    assert.deepEqual(selectDueEnrollments(rows, now, 10).map((r) => r.id), ["live"]);
  });

  test("future enrollments are excluded; exactly-now is included", () => {
    const rows = [
      enrollment("later", `${MON}T12:00:01Z`),
      enrollment("exactly", `${MON}T12:00:00Z`),
      enrollment("earlier", `${MON}T11:59:59Z`),
    ];
    assert.deepEqual(
      selectDueEnrollments(rows, now, 10).map((r) => r.id),
      ["earlier", "exactly"],
    );
  });

  test("an Invalid Date nextRunAt is excluded rather than sorted to the front", () => {
    const rows: Enrollment[] = [
      { id: "corrupt", nextRunAt: new Date(Number.NaN) },
      enrollment("good", `${MON}T09:00:00Z`),
    ];
    assert.deepEqual(selectDueEnrollments(rows, now, 10).map((r) => r.id), ["good"]);
  });

  test("an Invalid `now` selects nothing", () => {
    const rows = [enrollment("a", `${MON}T09:00:00Z`)];
    assert.deepEqual(selectDueEnrollments(rows, new Date(Number.NaN), 10), []);
  });

  test("ties break on id so two identical ticks pick the same rows", () => {
    const rows = [
      enrollment("zulu", `${MON}T09:00:00Z`),
      enrollment("alpha", `${MON}T09:00:00Z`),
      enrollment("mike", `${MON}T09:00:00Z`),
    ];
    assert.deepEqual(selectDueEnrollments(rows, now, 2).map((r) => r.id), ["alpha", "mike"]);
  });

  test("an empty list, and a list with nothing due, both return empty", () => {
    assert.deepEqual(selectDueEnrollments([], now, 10), []);
    assert.deepEqual(selectDueEnrollments([enrollment("a", `${MON}T18:00:00Z`)], now, 10), []);
  });

  test("does not mutate or reorder the caller's array", () => {
    const rows = [
      enrollment("c", `${MON}T11:00:00Z`),
      enrollment("a", `${MON}T09:00:00Z`),
    ];
    selectDueEnrollments(rows, now, 10);
    assert.deepEqual(rows.map((r) => r.id), ["c", "a"]);
  });

  test("carries the caller's own row shape through untouched", () => {
    type Row = { id: string; nextRunAt: Date | null; contactEmail: string };
    const rows: Row[] = [{ id: "x", nextRunAt: at(`${MON}T09:00:00Z`), contactEmail: "a@b.co" }];
    const selected = selectDueEnrollments(rows, now, 1);
    assert.equal(selected[0].contactEmail, "a@b.co");
    assert.equal(selected[0], rows[0]);
  });
});

// ─────────────────────── property-style invariants ───────────────────────

/** Seeded LCG. Deterministic so a failing round is reproducible. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const ZONES = ["UTC", "America/New_York", "Europe/Berlin", "Asia/Kathmandu", "Pacific/Auckland", "Bad/Zone"];
const SLOT_MS = 15 * 60 * 1000;

describe("INVARIANTS over pseudo-random input", () => {
  test("a 0-24 window over all seven days contains every instant", () => {
    const rand = lcg(0x51f3a1);
    const all: SendWindow = { days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, timezone: "UTC" };
    for (let i = 0; i < 300; i += 1) {
      const date = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 400 * 24 * 3600 * 1000));
      for (const timezone of ZONES) {
        assert.equal(isWithinSendWindow(date, { ...all, timezone }), true, `${date.toISOString()} ${timezone}`);
      }
    }
  });

  test("complementary hour ranges partition the day exactly once", () => {
    // [0, h) and [h, 24) (which the code reads as a midnight wrap) must cover
    // every instant, and never both.
    const rand = lcg(0x7c11d3);
    const days = [0, 1, 2, 3, 4, 5, 6];
    for (let i = 0; i < 400; i += 1) {
      const date = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 400 * 24 * 3600 * 1000));
      const timezone = ZONES[Math.floor(rand() * ZONES.length)];
      const h = 1 + Math.floor(rand() * 23); // 1..23
      const early = isWithinSendWindow(date, { days, startHour: 0, endHour: h, timezone });
      const late = isWithinSendWindow(date, { days, startHour: h, endHour: 0, timezone });
      assert.equal(
        Number(early) + Number(late),
        1,
        `round ${i}: ${date.toISOString()} ${timezone} split at ${h} -> ${early}/${late}`,
      );
    }
  });

  test("nextWindowOpening is the earliest in-window slot, found by naive scan", () => {
    const rand = lcg(0x2f6e2b1);
    const maxDays = 2;

    for (let round = 0; round < 120; round += 1) {
      const from = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 400 * 24 * 3600 * 1000));
      const days: number[] = [];
      for (let d = 0; d < 7; d += 1) {
        if (rand() < 0.45) days.push(d);
      }
      const w: SendWindow = {
        days,
        startHour: Math.floor(rand() * 24),
        endHour: Math.floor(rand() * 25),
        timezone: ZONES[Math.floor(rand() * ZONES.length)],
      };

      const result = nextWindowOpening(from, w, maxDays);

      // Independent scan of the same span, at the same 15-minute resolution.
      let expected: Date | null = null;
      const fromMs = from.getTime();
      const deadlineMs = fromMs + maxDays * 24 * 3600 * 1000;
      for (let ms = Math.floor(fromMs / SLOT_MS) * SLOT_MS; ms <= deadlineMs; ms += SLOT_MS) {
        if (ms < fromMs) continue;
        const candidate = new Date(ms);
        if (isWithinSendWindow(candidate, w)) {
          expected = candidate;
          break;
        }
      }
      // The scan cannot see a mid-slot `from` that is already inside.
      if (isWithinSendWindow(from, w)) expected = from;

      const label = `round ${round}: from=${from.toISOString()} w=${JSON.stringify(w)}`;
      assert.equal(iso(result), iso(expected), label);

      if (result !== null) {
        assert.ok(result.getTime() >= fromMs, `${label}: went backwards`);
        assert.equal(isWithinSendWindow(result, w), true, `${label}: result not in window`);
        const aligned = result.getTime() % SLOT_MS === 0;
        assert.ok(aligned || result === from, `${label}: unaligned result`);
      }
    }
  });

  test("computeNextRunAt never returns a time before `now`, and always lands in the window", () => {
    const rand = lcg(0x1a2b3c4);
    for (let round = 0; round < 200; round += 1) {
      const previousSendAt = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 300 * 24 * 3600 * 1000));
      const now = new Date(previousSendAt.getTime() + Math.floor((rand() - 0.4) * 20 * 24 * 3600 * 1000));
      const days: number[] = [];
      for (let d = 0; d < 7; d += 1) {
        if (rand() < 0.5) days.push(d);
      }
      const w: SendWindow = {
        days,
        startHour: Math.floor(rand() * 24),
        endHour: Math.floor(rand() * 25),
        timezone: ZONES[Math.floor(rand() * ZONES.length)],
      };
      const step = { delayDays: Math.floor(rand() * 10) - 2, delayHours: Math.floor(rand() * 48) - 6 };

      const result = computeNextRunAt(previousSendAt, step, w, now);
      if (result === null) continue;

      const label = `round ${round}: w=${JSON.stringify(w)} step=${JSON.stringify(step)}`;
      assert.ok(result.getTime() >= now.getTime(), `${label}: before now`);
      assert.ok(
        result.getTime() >= addStepDelay(previousSendAt, step.delayDays, step.delayHours).getTime(),
        `${label}: before the delay elapsed`,
      );
      assert.equal(isWithinSendWindow(result, w), true, `${label}: outside the window`);
    }
  });

  test("selectDueEnrollments is sorted, capped, due, and a subset of its input", () => {
    const rand = lcg(0x5eed01);
    const now = at(`${MON}T12:00:00Z`);

    for (let round = 0; round < 200; round += 1) {
      const rows: Enrollment[] = [];
      const size = Math.floor(rand() * 12);
      for (let i = 0; i < size; i += 1) {
        const roll = rand();
        const offsetMs = Math.floor((rand() - 0.5) * 6 * 3600 * 1000);
        rows.push({
          id: `e${i}`,
          nextRunAt: roll < 0.2 ? null : new Date(now.getTime() + offsetMs),
        });
      }
      const cap = Math.floor(rand() * 8) - 1;
      const selected = selectDueEnrollments(rows, now, cap);
      const label = `round ${round}: cap=${cap}`;

      assert.ok(selected.length <= Math.max(0, Math.floor(cap)), `${label}: over cap`);
      for (let i = 1; i < selected.length; i += 1) {
        const previous = selected[i - 1].nextRunAt as Date;
        const current = selected[i].nextRunAt as Date;
        assert.ok(previous.getTime() <= current.getTime(), `${label}: out of order`);
      }
      for (const row of selected) {
        assert.ok(rows.includes(row), `${label}: fabricated a row`);
        assert.ok(row.nextRunAt !== null, `${label}: selected an unscheduled row`);
        assert.ok((row.nextRunAt as Date).getTime() <= now.getTime(), `${label}: selected a future row`);
      }
      assert.equal(new Set(selected).size, selected.length, `${label}: duplicated a row`);

      // Nothing due was skipped in favour of something newer.
      const dueCount = rows.filter(
        (r) => r.nextRunAt !== null && r.nextRunAt.getTime() <= now.getTime(),
      ).length;
      assert.equal(selected.length, Math.min(dueCount, Math.max(0, Math.floor(cap))), `${label}: wrong count`);
    }
  });
});
