import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_RANDOM_RUNS,
  formatRandomSchedule,
  isRandomScheduleExpr,
  maxRandomRuns,
  parseRandomSchedule,
  type RandomSchedule,
} from "../../shared/randomSchedule.js";
import { nextRunFor } from "./cronMath.js";
import { countRandomRuns, nextRandomRun } from "./randomSchedule.js";

/**
 * A random schedule's promise: exactly so many Runs in every period, inside the
 * hours it was given, on the company's clock, at times nobody could predict and
 * that come out the same however often they are asked for.
 */

const SEED = "a1f3c9de-77b0-4f6e-9c1a-3d2e8b5f0a11";
const OTHER_SEED = "0c7e21ab-5d94-4b1f-8a36-91fe7d2c4b60";

function read(expr: string): RandomSchedule {
  const schedule = parseRandomSchedule(expr);
  assert.ok(schedule, `${expr} should parse`);
  return schedule;
}

/** Every Run after `from` and before `until`, by asking for the next one each time. */
function walk(expr: string, from: string, until: string, zone?: string, seed = SEED): Date[] {
  const schedule = read(expr);
  const end = new Date(until).getTime();
  const runs: Date[] = [];
  let cursor = new Date(from);
  for (;;) {
    const next = nextRandomRun(schedule, seed, cursor, zone);
    assert.ok(next, "a valid schedule always has a next Run");
    if (next.getTime() >= end) return runs;
    assert.ok(next.getTime() > cursor.getTime(), "strictly after the moment asked about");
    runs.push(next);
    cursor = next;
  }
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

function wallIn(zone: string, moment: Date): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(moment);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function tally(runs: Date[], key: (run: Date) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(key(run), (counts.get(key(run)) ?? 0) + 1);
  return counts;
}

/** Monday of the week this calendar date falls in, as `YYYY-MM-DD`. */
function mondayOf(wall: Wall): string {
  const utc = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc.toISOString().slice(0, 10);
}

describe("reading a random schedule", () => {
  test("reads a count, a period, and optional hours", () => {
    assert.deepEqual(parseRandomSchedule("@random 3/week"), {
      count: 3,
      period: "week",
      window: null,
    });
    assert.deepEqual(parseRandomSchedule("@random 2/day 09:00-17:30"), {
      count: 2,
      period: "day",
      window: { start: 540, end: 1050 },
    });
    assert.deepEqual(parseRandomSchedule("  @RANDOM   1/Year  "), {
      count: 1,
      period: "year",
      window: null,
    });
    for (const period of ["hour", "month", "quarter"]) {
      assert.equal(parseRandomSchedule(`@random 1/${period}`)?.period, period);
    }
  });

  test("a window may cross midnight, and end at it", () => {
    assert.deepEqual(parseRandomSchedule("@random 1/day 22:00-06:00")?.window, {
      start: 1320,
      end: 360,
    });
    assert.deepEqual(parseRandomSchedule("@random 1/day 09:00-00:00")?.window, {
      start: 540,
      end: 0,
    });
  });

  for (const expr of [
    "",
    "0 9 * * *",
    "@daily",
    "@random",
    "@random 3",
    "@random week",
    "@random 0/week",
    "@random -1/week",
    "@random 1.5/week",
    "@random 3/fortnight",
    "@random 3/weeks",
    "@random 101/week",
    "@random 61/hour",
    "@random 1/day 09:00",
    "@random 1/day 25:00-26:00",
    "@random 1/day 09:60-17:00",
    "@random 1/day 09:00-09:00",
    "@random 11/day 09:00-09:10",
    "@random 3/week extra",
    "@randomly 3/week",
  ]) {
    test(`refuses ${JSON.stringify(expr)}`, () => {
      assert.equal(parseRandomSchedule(expr), null);
    });
  }

  test("isRandomScheduleExpr tells a broken one apart from cron, to explain it properly", () => {
    assert.equal(isRandomScheduleExpr("@random 0/fortnight"), true);
    assert.equal(isRandomScheduleExpr(" @RANDOM"), true);
    assert.equal(isRandomScheduleExpr("@randomly 3/week"), false);
    assert.equal(isRandomScheduleExpr("@daily"), false);
    assert.equal(isRandomScheduleExpr("0 9 * * *"), false);
  });

  test("what is written reads back as the same schedule", () => {
    for (const expr of [
      "@random 3/week",
      "@random 1/hour",
      "@random 2/day 09:00-17:30",
      "@random 1/day 22:00-06:00",
      "@random 100/year 00:05-23:55",
    ]) {
      assert.equal(formatRandomSchedule(read(expr)), expr);
    }
  });

  test("the limit is one Run a minute at most, and a hundred a period", () => {
    assert.equal(maxRandomRuns("year", null), MAX_RANDOM_RUNS);
    assert.equal(maxRandomRuns("hour", null), 60);
    assert.equal(maxRandomRuns("hour", { start: 540, end: 550 }), 10);
    assert.equal(maxRandomRuns("day", { start: 540, end: 550 }), 10);
    assert.equal(maxRandomRuns("week", { start: 540, end: 550 }), 70);
    assert.equal(maxRandomRuns("day", { start: 1435, end: 5 }), 10, "across midnight");
  });
});

describe("exactly so many Runs in every period", () => {
  test("a week runs Monday to Sunday and gets exactly its count", () => {
    const runs = walk("@random 3/week", "2026-01-04T23:59:59Z", "2027-01-03T23:59:59Z", "UTC");
    const weeks = tally(runs, (run) => mondayOf(wallIn("UTC", run)));
    assert.equal(weeks.size, 52);
    for (const [week, count] of weeks) assert.equal(count, 3, week);
  });

  test("every day", () => {
    const runs = walk("@random 2/day", "2026-03-31T23:59:59Z", "2026-05-31T23:59:59Z", "UTC");
    const days = tally(runs, (run) => run.toISOString().slice(0, 10));
    assert.equal(days.size, 61);
    for (const [day, count] of days) assert.equal(count, 2, day);
  });

  test("every hour", () => {
    const runs = walk("@random 4/hour", "2026-05-01T00:00:00Z", "2026-05-03T00:00:00Z", "UTC");
    const hours = tally(runs, (run) => run.toISOString().slice(0, 13));
    assert.equal(hours.size, 48);
    for (const [hour, count] of hours) assert.equal(count, 4, hour);
  });

  test("every month, whatever its length", () => {
    const runs = walk("@random 5/month", "2023-12-31T23:59:59Z", "2025-12-31T23:59:59Z", "UTC");
    const months = tally(runs, (run) => run.toISOString().slice(0, 7));
    assert.equal(months.size, 24);
    for (const [month, count] of months) assert.equal(count, 5, month);
  });

  test("every quarter, starting in January, April, July and October", () => {
    const runs = walk("@random 2/quarter", "2025-12-31T23:59:59Z", "2027-12-31T23:59:59Z", "UTC");
    const quarters = tally(runs, (run) => {
      const { year, month } = wallIn("UTC", run);
      return `${year}-Q${Math.ceil(month / 3)}`;
    });
    assert.equal(quarters.size, 8);
    for (const [quarter, count] of quarters) assert.equal(count, 2, quarter);
  });

  test("every year", () => {
    const runs = walk("@random 3/year", "2019-12-31T23:59:59Z", "2031-12-31T23:59:59Z", "UTC");
    const years = tally(runs, (run) => run.toISOString().slice(0, 4));
    assert.equal(years.size, 12);
    for (const [year, count] of years) assert.equal(count, 3, year);
  });

  test("the most a period takes still fits", () => {
    const hourly = walk("@random 60/hour", "2026-05-01T00:00:00Z", "2026-05-01T02:00:00Z", "UTC");
    assert.equal(hourly.length, 120);
    const daily = walk("@random 100/day", "2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z", "UTC");
    assert.equal(daily.length, 100);
  });
});

describe("on the company's clock", () => {
  test("a day is the company's day, not UTC's", () => {
    const zone = "Asia/Tokyo";
    const runs = walk("@random 1/day", "2026-05-31T15:00:00Z", "2026-06-30T15:00:00Z", zone);
    const days = tally(runs, (run) => {
      const { month, day } = wallIn(zone, run);
      return `${month}-${day}`;
    });
    assert.equal(days.size, 30);
    for (const [day, count] of days) assert.equal(count, 1, day);
  });

  test("hours are the company's hours, through both ends of daylight saving", () => {
    const zone = "America/New_York";
    const runs = walk(
      "@random 6/day 09:00-17:00",
      "2026-01-01T05:00:00Z",
      "2027-01-01T05:00:00Z",
      zone,
    );
    assert.equal(runs.length, 365 * 6);
    for (const run of runs) {
      const { hour } = wallIn(zone, run);
      assert.ok(hour >= 9 && hour < 17, `${run.toISOString()} is ${hour}:00 in ${zone}`);
    }
  });

  test("a window across midnight keeps to both sides of it", () => {
    const zone = "Europe/Berlin";
    const runs = walk(
      "@random 2/day 22:00-06:00",
      "2026-05-31T22:00:00Z",
      "2026-07-31T22:00:00Z",
      zone,
    );
    assert.equal(runs.length, 61 * 2);
    for (const run of runs) {
      const { hour } = wallIn(zone, run);
      assert.ok(hour >= 22 || hour < 6, `${run.toISOString()} is ${hour}:00 in ${zone}`);
    }
    const hours = new Set(runs.map((run) => wallIn(zone, run).hour));
    assert.ok([...hours].some((hour) => hour >= 22) && [...hours].some((hour) => hour < 6));
  });

  test("a day the clocks skip or repeat an hour on loses no Runs", () => {
    const zone = "America/New_York";
    for (const [day, start, end] of [
      ["spring forward", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
      ["fall back", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
    ]) {
      const runs = walk("@random 24/day", start, end, zone);
      assert.equal(runs.length, 24, day);
      for (let i = 1; i < runs.length; i += 1) {
        assert.ok(runs[i - 1].getTime() < runs[i].getTime(), `${day} stays in order`);
      }
    }
  });

  test("an hourly schedule waits for its hours to come round", () => {
    const schedule = read("@random 2/hour 09:00-11:00");
    const zone = "Asia/Tokyo";
    const late = new Date("2026-05-01T06:00:00Z"); // 15:00 in Tokyo.
    const next = nextRandomRun(schedule, SEED, late, zone);
    assert.ok(next);
    const wall = wallIn(zone, next);
    assert.deepEqual([wall.day, wall.hour >= 9 && wall.hour < 11], [2, true]);
    const runs = walk("@random 2/hour 09:00-11:00", "2026-05-01T15:00:00Z", "2026-05-02T15:00:00Z", zone);
    assert.equal(runs.length, 4, "two an hour for the two hours it may run");
  });

  test("server time is the process's clock, read when asked", () => {
    const previous = process.env.TZ;
    const schedule = read("@random 2/day 09:00-17:00");
    const from = new Date("2026-05-01T00:00:00Z");
    try {
      for (const zone of ["Pacific/Auckland", "America/Los_Angeles"]) {
        process.env.TZ = zone;
        const onServer = nextRandomRun(schedule, SEED, from);
        const named = nextRandomRun(schedule, SEED, from, zone);
        assert.deepEqual(onServer, named, zone);
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("the same answer every time", () => {
  const runs = walk("@random 3/week", "2026-01-04T23:59:59Z", "2026-07-05T23:59:59Z", "UTC");
  const schedule = read("@random 3/week");

  test("asking again gives the same Runs", () => {
    assert.deepEqual(
      walk("@random 3/week", "2026-01-04T23:59:59Z", "2026-07-05T23:59:59Z", "UTC"),
      runs,
    );
  });

  test("asking from anywhere finds the same next Run, so nothing can re-roll one", () => {
    for (let i = 0; i < runs.length - 1; i += 1) {
      const just = new Date(runs[i].getTime() - 1_000);
      assert.deepEqual(nextRandomRun(schedule, SEED, just, "UTC"), runs[i]);
      assert.deepEqual(nextRandomRun(schedule, SEED, runs[i], "UTC"), runs[i + 1]);
      const between = new Date((runs[i].getTime() + runs[i + 1].getTime()) / 2);
      assert.deepEqual(nextRandomRun(schedule, SEED, between, "UTC"), runs[i + 1]);
    }
  });

  test("two Routines on the same schedule do not fire together", () => {
    const theirs = walk(
      "@random 3/week",
      "2026-01-04T23:59:59Z",
      "2026-07-05T23:59:59Z",
      "UTC",
      OTHER_SEED,
    );
    assert.equal(theirs.length, runs.length);
    const mine = new Set(runs.map((run) => run.getTime()));
    assert.equal(theirs.filter((run) => mine.has(run.getTime())).length, 0);
  });
});

describe("actually random", () => {
  test("once a week lands on every day of the week and all over the clock", () => {
    const runs = walk("@random 1/week", "2024-01-07T23:59:59Z", "2026-12-27T23:59:59Z", "UTC");
    assert.ok(runs.length >= 155);
    assert.equal(new Set(runs.map((run) => run.getUTCDay())).size, 7);
    assert.ok(new Set(runs.map((run) => run.getUTCHours())).size >= 20);
  });

  test("once a day lands on most hours of the day, and is not a pattern", () => {
    const runs = walk("@random 1/day", "2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "UTC");
    const hours = tally(runs, (run) => String(run.getUTCHours()));
    assert.ok(hours.size >= 20, `only ${hours.size} different hours`);
    // No hour takes more than three times its fair share of a year's Runs.
    for (const [hour, count] of hours) assert.ok(count < (runs.length / 24) * 3, `hour ${hour}`);
    assert.ok(new Set(runs.map((run) => run.getUTCMinutes())).size >= 50);
  });

  test("a year's Run lands anywhere in the year, not always the same month", () => {
    const months = new Set<number>();
    for (let n = 0; n < 40; n += 1) {
      const run = nextRandomRun(read("@random 1/year"), `seed-${n}`, new Date("2026-01-01T00:00:00Z"), "UTC");
      assert.ok(run);
      months.add(run.getUTCMonth());
    }
    assert.ok(months.size >= 8, `only ${months.size} different months`);
  });
});

describe("spread out", () => {
  test("Runs in a period never bunch up", () => {
    const runs = walk("@random 3/day", "2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z", "UTC");
    for (let i = 1; i < runs.length; i += 1) {
      const gap = runs[i].getTime() - runs[i - 1].getTime();
      assert.ok(gap >= 48 * 60_000, `${runs[i].toISOString()} is ${gap / 60_000} minutes on`);
    }
  });

  test("neither do the last Run of one period and the first of the next", () => {
    const runs = walk("@random 1/day", "2024-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "UTC");
    for (let i = 1; i < runs.length; i += 1) {
      assert.ok(runs[i].getTime() - runs[i - 1].getTime() >= 2 * 3_600_000);
    }
  });

  test("a long period keeps its Run clear of the edge by no more than an hour", () => {
    const year = read("@random 1/year");
    const earliest = Array.from({ length: 400 }, (_, n) =>
      nextRandomRun(year, `seed-${n}`, new Date("2026-01-01T00:00:00Z"), "UTC"),
    )
      .map((run) => (run as Date).getTime())
      .sort((a, b) => a - b)[0];
    // Four hundred Runs through a year land within a few days of its start: an
    // edge kept as a share of the year would keep them weeks away.
    assert.ok(earliest < new Date("2026-01-08T00:00:00Z").getTime());
    assert.ok(earliest >= new Date("2026-01-01T01:00:00Z").getTime());
  });
});

describe("counting the Runs a stretch of time missed", () => {
  const schedule = read("@random 3/week");
  const count = (after: string, until: string, cap = 1_000) =>
    countRandomRuns(schedule, SEED, new Date(after), new Date(until), cap, "UTC");

  test("agrees with walking the same stretch", () => {
    const after = "2026-01-04T23:59:59Z";
    const until = "2026-07-05T23:59:59Z";
    assert.deepEqual(count(after, until), {
      count: walk("@random 3/week", after, until, "UTC").length,
      capped: false,
    });
  });

  test("counts strictly after the start and up to and including the end", () => {
    const [first, second] = walk("@random 3/week", "2026-01-04T23:59:59Z", "2026-01-19T00:00:00Z", "UTC");
    assert.equal(count(first.toISOString(), second.toISOString()).count, 1);
    const justBefore = new Date(second.getTime() - 1_000).toISOString();
    assert.equal(count(first.toISOString(), justBefore).count, 0);
  });

  test("stops at the cap and says so, so a long outage costs nothing extra", () => {
    assert.deepEqual(count("2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z", 10), {
      count: 10,
      capped: true,
    });
  });

  test("nothing to count", () => {
    assert.deepEqual(count("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"), {
      count: 0,
      capped: false,
    });
    assert.deepEqual(count("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), {
      count: 0,
      capped: false,
    });
    assert.deepEqual(count("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", 0), {
      count: 0,
      capped: false,
    });
  });
});

test("nothing that is not a Routine can read one", () => {
  // Pipelines, Revenue Signals and recurring invoices compute with `nextRunFor`,
  // so a schedule only a Routine can honour must not pass for cron there.
  assert.equal(nextRunFor("@random 3/week"), null);
  assert.equal(nextRunFor("@random 2/day 09:00-17:00"), null);
});
