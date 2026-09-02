import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  HOUR_STEPS,
  MINUTE_STEPS,
  MONTH_NAMES,
  SCHEDULE_PRESETS,
  WEEKDAY_NAMES,
  cronToSchedule,
  daysInMonth,
  defaultSchedule,
  describeCronExpr,
  describeSchedule,
  describeWeekdays,
  formatRunTime,
  formatTimeOfDay,
  isFriendlyCron,
  nextRuns,
  normalizeSchedule,
  previewRuns,
  ordinal,
  scheduleToCron,
  timeInputValue,
  withTimeOfDay,
  type Schedule,
} from "./scheduleBuilder";

function schedule(over: Partial<Schedule> = {}): Schedule {
  return { ...defaultSchedule(), ...over };
}

/** Local-time constructor, so tests read the same way `nextRuns` computes. */
function at(y: number, m: number, d: number, h = 0, min = 0, s = 0): Date {
  return new Date(y, m - 1, d, h, min, s);
}

function iso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

describe("scheduleToCron", () => {
  test("compiles every frequency to its canonical cron shape", () => {
    assert.equal(scheduleToCron(schedule({ frequency: "minutes", every: 1 })), "* * * * *");
    assert.equal(scheduleToCron(schedule({ frequency: "minutes", every: 15 })), "*/15 * * * *");
    assert.equal(
      scheduleToCron(schedule({ frequency: "hourly", every: 1, minute: 0 })),
      "0 * * * *",
    );
    assert.equal(
      scheduleToCron(schedule({ frequency: "hourly", every: 6, minute: 30 })),
      "30 */6 * * *",
    );
    assert.equal(
      scheduleToCron(schedule({ frequency: "daily", hour: 8, minute: 0 })),
      "0 8 * * *",
    );
    assert.equal(
      scheduleToCron(schedule({ frequency: "weekly", weekdays: [1], hour: 9, minute: 0 })),
      "0 9 * * 1",
    );
    assert.equal(
      scheduleToCron(schedule({ frequency: "monthly", dayOfMonth: 15, hour: 7, minute: 45 })),
      "45 7 15 * *",
    );
    assert.equal(
      scheduleToCron(
        schedule({ frequency: "yearly", dayOfMonth: 20, month: 8, hour: 9, minute: 0 }),
      ),
      "0 9 20 8 *",
    );
  });

  test("emits weekdays sorted, deduped, and comma-joined", () => {
    assert.equal(
      scheduleToCron(schedule({ frequency: "weekly", weekdays: [5, 1, 3, 1] })),
      "0 9 * * 1,3,5",
    );
  });

  test("never emits a step the picker does not offer", () => {
    // A hand-authored 7 lands on the nearest clean divisor rather than
    // compiling to a cadence with a seam at the top of the hour.
    assert.equal(scheduleToCron(schedule({ frequency: "minutes", every: 7 })), "*/5 * * * *");
    assert.equal(scheduleToCron(schedule({ frequency: "hourly", every: 5 })), "0 */4 * * *");
  });

  test("clamps out-of-range values instead of emitting invalid cron", () => {
    assert.equal(
      scheduleToCron(schedule({ frequency: "daily", hour: 99, minute: -4 })),
      "0 23 * * *",
    );
    assert.equal(
      scheduleToCron(schedule({ frequency: "monthly", dayOfMonth: 0 })),
      "0 9 1 * *",
    );
    assert.equal(
      scheduleToCron(schedule({ frequency: "yearly", month: 13, dayOfMonth: 40 })),
      "0 9 31 12 *",
    );
  });

  test("an empty weekday selection fires on Monday rather than never", () => {
    assert.equal(scheduleToCron(schedule({ frequency: "weekly", weekdays: [] })), "0 9 * * 1");
  });

  test("never emits a date that does not exist", () => {
    // A yearly schedule names exactly one date. February 31st is not a rare
    // schedule, it is a schedule that never runs, and the API refuses it.
    assert.equal(
      scheduleToCron(schedule({ frequency: "yearly", month: 2, dayOfMonth: 31 })),
      "0 9 29 2 *",
    );
    assert.equal(
      scheduleToCron(schedule({ frequency: "yearly", month: 4, dayOfMonth: 31 })),
      "0 9 30 4 *",
    );
    assert.equal(
      scheduleToCron(schedule({ frequency: "yearly", month: 2, dayOfMonth: 29 })),
      "0 9 29 2 *",
      "a leap day is a real date and stays one",
    );
  });

  test("a monthly 31st is left alone — it simply skips the short months", () => {
    assert.equal(scheduleToCron(schedule({ frequency: "monthly", dayOfMonth: 31 })), "0 9 31 * *");
  });
});

describe("normalizeSchedule", () => {
  test("sorts, dedupes and clamps weekdays", () => {
    assert.deepEqual(normalizeSchedule(schedule({ weekdays: [6, 0, 6, 3] })).weekdays, [0, 3, 6]);
    assert.deepEqual(normalizeSchedule(schedule({ weekdays: [-2, 9] })).weekdays, [0, 6]);
  });

  test("survives values no control can produce", () => {
    const wild = normalizeSchedule({
      frequency: "weekly",
      every: Number.NaN,
      minute: Number.POSITIVE_INFINITY,
      hour: Number.NaN,
      weekdays: [Number.NaN, 2],
      dayOfMonth: Number.NaN,
      month: Number.NaN,
    });
    assert.deepEqual(wild, {
      frequency: "weekly",
      every: 1,
      minute: 0,
      hour: 9,
      weekdays: [2],
      dayOfMonth: 1,
      month: 1,
    });
  });

  test("pins `every` to 1 for frequencies that do not use it", () => {
    assert.equal(normalizeSchedule(schedule({ frequency: "daily", every: 12 })).every, 1);
    assert.equal(normalizeSchedule(schedule({ frequency: "weekly", every: 4 })).every, 1);
  });

  test("is idempotent", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const once = normalizeSchedule(preset.schedule);
      assert.deepEqual(normalizeSchedule(once), once, preset.label);
    }
  });
});

describe("cronToSchedule", () => {
  test("reads back the shape the screenshot showed", () => {
    assert.deepEqual(cronToSchedule("15 15 * * 3"), {
      ...defaultSchedule(),
      frequency: "weekly",
      weekdays: [3],
      hour: 15,
      minute: 15,
    });
  });

  test("reads every canonical shape", () => {
    assert.equal(cronToSchedule("* * * * *")?.frequency, "minutes");
    assert.equal(cronToSchedule("*/30 * * * *")?.every, 30);
    assert.equal(cronToSchedule("0 * * * *")?.frequency, "hourly");
    assert.equal(cronToSchedule("30 */6 * * *")?.every, 6);
    assert.equal(cronToSchedule("0 9 * * *")?.frequency, "daily");
    assert.equal(cronToSchedule("0 9 * * 1")?.frequency, "weekly");
    assert.equal(cronToSchedule("0 9 15 * *")?.frequency, "monthly");
    assert.equal(cronToSchedule("0 9 20 8 *")?.frequency, "yearly");
  });

  test("expands weekday ranges, lists and names", () => {
    assert.deepEqual(cronToSchedule("0 9 * * 1-5")?.weekdays, [1, 2, 3, 4, 5]);
    assert.deepEqual(cronToSchedule("0 9 * * 1,3,5")?.weekdays, [1, 3, 5]);
    assert.deepEqual(cronToSchedule("0 9 * * MON-FRI")?.weekdays, [1, 2, 3, 4, 5]);
    assert.deepEqual(cronToSchedule("0 9 * * mon,thu")?.weekdays, [1, 4]);
    assert.deepEqual(cronToSchedule("0 9 * * 5-6,1")?.weekdays, [1, 5, 6]);
  });

  test("treats 7 as a second spelling of Sunday", () => {
    assert.deepEqual(cronToSchedule("0 9 * * 7")?.weekdays, [0]);
    assert.deepEqual(cronToSchedule("0 9 * * 0,7")?.weekdays, [0]);
  });

  test("reads a named month", () => {
    const yearly = cronToSchedule("0 9 20 AUG *");
    assert.equal(yearly?.frequency, "yearly");
    assert.equal(yearly?.month, 8);
    assert.equal(yearly?.dayOfMonth, 20);
  });

  test("refuses everything the picker cannot faithfully redraw", () => {
    // Six fields — second granularity, which no control offers.
    assert.equal(cronToSchedule("0 0 9 * * 1"), null);
    // An hour list is two schedules in one field.
    assert.equal(cronToSchedule("0 9,17 * * *"), null);
    // Day-of-month AND day-of-week is cron's OR clause.
    assert.equal(cronToSchedule("0 9 13 * 5"), null);
    // Steps the picker does not offer would be silently rewritten.
    assert.equal(cronToSchedule("*/7 * * * *"), null);
    assert.equal(cronToSchedule("0 */5 * * *"), null);
    // Ranges outside the day-of-week field.
    assert.equal(cronToSchedule("0 9 1-5 * *"), null);
    assert.equal(cronToSchedule("0-30 9 * * *"), null);
    // Structurally wrong input.
    assert.equal(cronToSchedule("not cron"), null);
    assert.equal(cronToSchedule(""), null);
    assert.equal(cronToSchedule("0 9 * *"), null);
    assert.equal(cronToSchedule("0 99 * * *"), null);
    assert.equal(cronToSchedule("0 9 * * 9"), null);
    assert.equal(cronToSchedule("0 9 L * *"), null);
    // Dates that do not exist: schedulable-looking, never actually due.
    assert.equal(cronToSchedule("0 9 31 2 *"), null);
    assert.equal(cronToSchedule("0 9 30 2 *"), null);
    assert.equal(cronToSchedule("0 9 31 4 *"), null);
  });

  test("reads the shorthands the scheduler can honour, and only those", () => {
    assert.equal(cronToSchedule("@hourly")?.frequency, "hourly");
    assert.equal(cronToSchedule("@daily")?.frequency, "daily");
    assert.deepEqual(cronToSchedule("@daily"), cronToSchedule("0 0 * * *"));
    assert.deepEqual(cronToSchedule("@weekly")?.weekdays, [0]);
    assert.equal(cronToSchedule("@monthly")?.frequency, "monthly");
    assert.equal(cronToSchedule("@yearly")?.frequency, "yearly");
    assert.deepEqual(cronToSchedule("@YEARLY"), cronToSchedule("@yearly"), "case-insensitive");
    // node-cron validates both of these, but cron-parser cannot compute a next
    // run from either, so a routine on one saves and then never fires. Drawing
    // them as a friendly schedule would be a lie about work that never happens.
    assert.equal(cronToSchedule("@annually"), null);
    assert.equal(cronToSchedule("@midnight"), null);
  });

  test("opens a leap-day schedule in the friendly controls", () => {
    const leap = cronToSchedule("0 9 29 2 *");
    assert.equal(leap?.frequency, "yearly");
    assert.equal(leap?.month, 2);
    assert.equal(leap?.dayOfMonth, 29);
  });

  test("tolerates surrounding and repeated whitespace", () => {
    assert.deepEqual(cronToSchedule("  0   9  *  *  1  "), cronToSchedule("0 9 * * 1"));
  });

  test("isFriendlyCron agrees with cronToSchedule", () => {
    for (const expr of ["0 9 * * 1-5", "*/15 * * * *", "0 0 9 * * 1", "0 9 13 * 5", "nope"]) {
      assert.equal(isFriendlyCron(expr), cronToSchedule(expr) !== null, expr);
    }
  });
});

describe("compile / parse round-trips", () => {
  test("every preset survives a round-trip unchanged", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const expr = scheduleToCron(preset.schedule);
      assert.deepEqual(
        cronToSchedule(expr),
        normalizeSchedule(preset.schedule),
        `${preset.label} (${expr})`,
      );
    }
  });

  test("a grid of schedules round-trips through cron", () => {
    const grid: Schedule[] = [];
    for (const every of MINUTE_STEPS) grid.push(schedule({ frequency: "minutes", every }));
    for (const every of HOUR_STEPS) {
      for (const minute of [0, 7, 59]) grid.push(schedule({ frequency: "hourly", every, minute }));
    }
    for (const hour of [0, 9, 23]) {
      for (const minute of [0, 30, 59]) {
        grid.push(schedule({ frequency: "daily", hour, minute }));
        for (const weekdays of [[0], [6], [1, 2, 3, 4, 5], [0, 6], [0, 1, 2, 3, 4, 5, 6], [2, 4]]) {
          grid.push(schedule({ frequency: "weekly", hour, minute, weekdays }));
        }
        for (const dayOfMonth of [1, 15, 28, 31]) {
          grid.push(schedule({ frequency: "monthly", hour, minute, dayOfMonth }));
          for (const month of [1, 2, 12]) {
            grid.push(schedule({ frequency: "yearly", hour, minute, dayOfMonth, month }));
          }
        }
      }
    }
    assert.ok(grid.length > 200, "the grid should be broad enough to be worth running");
    for (const input of grid) {
      const expr = scheduleToCron(input);
      assert.deepEqual(cronToSchedule(expr), normalizeSchedule(input), expr);
    }
  });

  test("re-compiling a parsed expression preserves when it fires", () => {
    // `0 9 * * 1-5` normalizes to `0 9 * * 1,2,3,4,5` — a different string for
    // the same schedule. The bar is that the fire times do not move.
    const from = at(2026, 1, 1);
    for (const expr of [
      "0 9 * * 1-5",
      "0 9 * * MON-FRI",
      "0 9 * * 7",
      "0 9 20 AUG *",
      "0 9 * * 5-6,1",
    ]) {
      const parsed = cronToSchedule(expr);
      assert.ok(parsed, expr);
      const recompiled = scheduleToCron(parsed);
      assert.deepEqual(
        nextRuns(recompiled, from, 8).map(iso),
        nextRuns(expr, from, 8).map(iso),
        expr,
      );
    }
  });
});

describe("describeSchedule", () => {
  test("says the sentence the person just built", () => {
    assert.equal(
      describeSchedule(schedule({ frequency: "weekly", weekdays: [3], hour: 15, minute: 15 })),
      "Every Wednesday at 3:15 PM",
    );
    assert.equal(describeSchedule(schedule({ frequency: "daily" })), "Every day at 9:00 AM");
    assert.equal(
      describeSchedule(schedule({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5] })),
      "Every weekday at 9:00 AM",
    );
    assert.equal(
      describeSchedule(schedule({ frequency: "weekly", weekdays: [0, 6] })),
      "Every weekend day at 9:00 AM",
    );
    assert.equal(
      describeSchedule(schedule({ frequency: "weekly", weekdays: [1, 3, 5] })),
      "Every Mon, Wed & Fri at 9:00 AM",
    );
    assert.equal(
      describeSchedule(schedule({ frequency: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6] })),
      "Every day at 9:00 AM",
    );
    assert.equal(
      describeSchedule(schedule({ frequency: "monthly", dayOfMonth: 22, hour: 0, minute: 0 })),
      "The 22nd of every month at 12:00 AM",
    );
    assert.equal(
      describeSchedule(schedule({ frequency: "yearly", month: 3, dayOfMonth: 1, hour: 12 })),
      "Every March 1 at 12:00 PM",
    );
  });

  test("describes sub-hourly cadences without a meaningless time of day", () => {
    assert.equal(describeSchedule(schedule({ frequency: "minutes", every: 1 })), "Every minute");
    assert.equal(
      describeSchedule(schedule({ frequency: "minutes", every: 15 })),
      "Every 15 minutes",
    );
    assert.equal(
      describeSchedule(schedule({ frequency: "hourly", every: 1, minute: 0 })),
      "Every hour, on the hour",
    );
    assert.equal(
      describeSchedule(schedule({ frequency: "hourly", every: 3, minute: 20 })),
      "Every 3 hours, at 20 past the hour",
    );
  });

  test("every preset reads as a sentence, and matches its own label", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const sentence = describeSchedule(preset.schedule);
      assert.match(sentence, /^Every |^The /, preset.label);
      assert.doesNotMatch(sentence, /undefined|NaN/, preset.label);
    }
  });

  test("describeWeekdays names the common sets", () => {
    assert.equal(describeWeekdays([1, 2, 3, 4, 5]), "weekday");
    assert.equal(describeWeekdays([0, 6]), "weekend day");
    assert.equal(describeWeekdays([0, 1, 2, 3, 4, 5, 6]), "day");
    assert.equal(describeWeekdays([4]), "Thursday");
    assert.equal(describeWeekdays([2, 4]), "Tue & Thu");
    assert.equal(describeWeekdays([]), "Monday");
  });
});

describe("describeCronExpr", () => {
  test("uses the app's voice for expressions the picker can draw", () => {
    assert.equal(describeCronExpr("15 15 * * 3"), "Every Wednesday at 3:15 PM");
    assert.equal(describeCronExpr("0 9 * * 1-5"), "Every weekday at 9:00 AM");
    assert.equal(describeCronExpr("*/15 * * * *"), "Every 15 minutes");
  });

  test("falls back to cronstrue for expressions only the escape hatch produces", () => {
    const described = describeCronExpr("0 9,17 * * *");
    assert.notEqual(described, "0 9,17 * * *");
    assert.match(described, /09:00|9:00/);
  });

  test("falls back to the raw expression rather than showing an error", () => {
    assert.equal(describeCronExpr("total nonsense"), "total nonsense");
  });

  test("never returns an empty description for a schedulable expression", () => {
    for (const expr of ["0 9 * * *", "0 0 9 * * 1", "*/5 * * * *", "0 9 13 * 5"]) {
      assert.ok(describeCronExpr(expr).length > 0, expr);
    }
  });
});

describe("nextRuns", () => {
  test("lists a daily schedule from the given moment", () => {
    assert.deepEqual(
      nextRuns("0 9 * * *", at(2026, 3, 2, 10, 0), 3).map(iso),
      ["2026-03-03 09:00:00", "2026-03-04 09:00:00", "2026-03-05 09:00:00"],
    );
  });

  test("is strictly after `from`", () => {
    assert.equal(iso(nextRuns("0 9 * * *", at(2026, 3, 2, 9, 0), 1)[0]), "2026-03-03 09:00:00");
    assert.equal(
      iso(nextRuns("0 9 * * *", at(2026, 3, 2, 8, 59, 59), 1)[0]),
      "2026-03-02 09:00:00",
    );
  });

  test("walks a weekly selection in order", () => {
    // 2026-03-02 is a Monday.
    assert.deepEqual(
      nextRuns("0 9 * * 1,3,5", at(2026, 3, 2, 12, 0), 4).map(iso),
      [
        "2026-03-04 09:00:00",
        "2026-03-06 09:00:00",
        "2026-03-09 09:00:00",
        "2026-03-11 09:00:00",
      ],
    );
  });

  test("skips months a day-of-month does not exist in", () => {
    assert.deepEqual(
      nextRuns("0 9 31 * *", at(2026, 1, 31, 12, 0), 3).map(iso),
      ["2026-03-31 09:00:00", "2026-05-31 09:00:00", "2026-07-31 09:00:00"],
    );
  });

  test("finds a leap day years out", () => {
    assert.deepEqual(nextRuns("0 9 29 2 *", at(2026, 6, 1), 2).map(iso), [
      "2028-02-29 09:00:00",
      "2032-02-29 09:00:00",
    ]);
  });

  test("returns nothing for a date that never comes", () => {
    assert.deepEqual(nextRuns("0 9 30 2 *", at(2026, 1, 1), 3), []);
  });

  test("honours cron's day-of-month OR day-of-week rule", () => {
    // The 13th, and also every Friday. 2026-03-13 is itself a Friday.
    assert.deepEqual(nextRuns("0 9 13 * 5", at(2026, 3, 1), 4).map(iso), [
      "2026-03-06 09:00:00",
      "2026-03-13 09:00:00",
      "2026-03-20 09:00:00",
      "2026-03-27 09:00:00",
    ]);
  });

  test("steps sub-hourly schedules", () => {
    assert.deepEqual(nextRuns("*/15 * * * *", at(2026, 3, 2, 9, 7), 3).map(iso), [
      "2026-03-02 09:15:00",
      "2026-03-02 09:30:00",
      "2026-03-02 09:45:00",
    ]);
    assert.deepEqual(nextRuns("30 */6 * * *", at(2026, 3, 2, 7, 0), 3).map(iso), [
      "2026-03-02 12:30:00",
      "2026-03-02 18:30:00",
      "2026-03-03 00:30:00",
    ]);
  });

  test("reads six-field second-granularity expressions", () => {
    assert.deepEqual(nextRuns("30 0 9 * * *", at(2026, 3, 2, 0, 0), 2).map(iso), [
      "2026-03-02 09:00:30",
      "2026-03-03 09:00:30",
    ]);
  });

  test("understands names, lists, ranges and stepped ranges", () => {
    assert.deepEqual(nextRuns("0 9 * JAN MON", at(2026, 12, 1), 2).map(iso), [
      "2027-01-04 09:00:00",
      "2027-01-11 09:00:00",
    ]);
    assert.deepEqual(nextRuns("0 9-17/4 * * *", at(2026, 3, 2, 0, 0), 3).map(iso), [
      "2026-03-02 09:00:00",
      "2026-03-02 13:00:00",
      "2026-03-02 17:00:00",
    ]);
  });

  test("returns an empty list rather than throwing on bad input", () => {
    assert.deepEqual(nextRuns("nope", at(2026, 1, 1), 3), []);
    assert.deepEqual(nextRuns("", at(2026, 1, 1), 3), []);
    assert.deepEqual(nextRuns("*/0 * * * *", at(2026, 1, 1), 3), []);
    assert.deepEqual(nextRuns("0 9 * * *", at(2026, 1, 1), 0), []);
    assert.deepEqual(nextRuns("0 9 * * *", at(2026, 1, 1), -1), []);
  });

  test("always returns ascending, distinct times", () => {
    for (const expr of ["* * * * *", "*/5 * * * *", "0 9 * * 1-5", "0 0 1 * *", "0 9 13 * 5"]) {
      const runs = nextRuns(expr, at(2026, 3, 2, 8, 3), 6);
      assert.equal(runs.length, 6, expr);
      for (let i = 1; i < runs.length; i += 1) {
        assert.ok(runs[i].getTime() > runs[i - 1].getTime(), `${expr} at ${i}`);
      }
    }
  });

  test("every preset previews cleanly", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const runs = nextRuns(scheduleToCron(preset.schedule), at(2026, 3, 2, 8, 3), 3);
      assert.equal(runs.length, 3, preset.label);
      assert.ok(formatRunTime(runs[0]).length > 0, preset.label);
    }
  });
});

describe("previewRuns", () => {
  test("separates a schedule that never comes from syntax it cannot walk", () => {
    // February 30th: understood completely, and it never happens. This is the
    // case worth warning a person about.
    const impossible = previewRuns("0 9 30 2 *", at(2026, 1, 1), 3);
    assert.equal(impossible.supported, true);
    assert.deepEqual(impossible.runs, []);

    // `L`, `#` and `W` fire perfectly well — node-cron and cron-parser both
    // honour them — and this preview does not implement them. Reporting them
    // as dead schedules would cry wolf, so they come back unsupported.
    for (const expr of ["0 9 * * 5L", "0 9 L * *", "0 9 * * 1#2", "0 9 1W * *"]) {
      const unsupported = previewRuns(expr, at(2026, 1, 1), 3);
      assert.equal(unsupported.supported, false, expr);
      assert.deepEqual(unsupported.runs, [], expr);
    }
  });

  test("previews the shorthands", () => {
    assert.deepEqual(
      previewRuns("@daily", at(2026, 3, 2, 6, 0), 2).runs.map(iso),
      ["2026-03-03 00:00:00", "2026-03-04 00:00:00"],
    );
    assert.deepEqual(
      previewRuns("@hourly", at(2026, 3, 2, 6, 30), 2).runs.map(iso),
      ["2026-03-02 07:00:00", "2026-03-02 08:00:00"],
    );
    // Not schedulable, so nothing is claimed about it either way.
    assert.equal(previewRuns("@midnight", at(2026, 3, 2), 2).supported, false);
  });

  test("nextRuns is previewRuns without the reason", () => {
    for (const expr of ["0 9 * * 1-5", "0 9 30 2 *", "0 9 L * *", "nonsense"]) {
      assert.deepEqual(
        nextRuns(expr, at(2026, 3, 2), 3),
        previewRuns(expr, at(2026, 3, 2), 3).runs,
        expr,
      );
    }
  });
});

describe("formatRunTime", () => {
  test("leaves the year off a run in the reference year", () => {
    const formatted = formatRunTime(at(2026, 9, 2, 15, 15), at(2026, 3, 1));
    assert.doesNotMatch(formatted, /2026/);
    assert.match(formatted, /3:15/);
  });

  test("names the year once a run leaves it — a yearly schedule needs it", () => {
    // Without the year, `0 9 20 8 *` previews as "20 Aug · 20 Aug · 20 Aug".
    const runs = nextRuns("0 9 20 8 *", at(2026, 9, 1), 3);
    const reference = at(2026, 9, 1);
    const labels = runs.map((run) => formatRunTime(run, reference));
    assert.equal(new Set(labels).size, 3, labels.join(" · "));
    assert.match(labels[0], /2027/);
  });

  test("uses the same 12-hour clock as the sentence above it", () => {
    assert.match(formatRunTime(at(2026, 9, 2, 15, 15), at(2026, 9, 1)), /3:15\s?PM/i);
    assert.match(formatRunTime(at(2026, 9, 2, 0, 30), at(2026, 9, 1)), /12:30\s?AM/i);
  });
});

describe("time-of-day helpers", () => {
  test("timeInputValue pads to HH:MM", () => {
    assert.equal(timeInputValue(schedule({ hour: 9, minute: 5 })), "09:05");
    assert.equal(timeInputValue(schedule({ hour: 0, minute: 0 })), "00:00");
    assert.equal(timeInputValue(schedule({ hour: 23, minute: 59 })), "23:59");
  });

  test("withTimeOfDay round-trips an input value", () => {
    const applied = withTimeOfDay(schedule(), "15:15");
    assert.equal(applied.hour, 15);
    assert.equal(applied.minute, 15);
    assert.equal(timeInputValue(applied), "15:15");
  });

  test("withTimeOfDay keeps the old time when the browser clears the field", () => {
    const before = schedule({ hour: 7, minute: 30 });
    assert.deepEqual(withTimeOfDay(before, ""), normalizeSchedule(before));
    assert.deepEqual(withTimeOfDay(before, "not:atime"), normalizeSchedule(before));
  });

  test("formatTimeOfDay uses a 12-hour clock with a real noon and midnight", () => {
    assert.equal(formatTimeOfDay(0, 0), "12:00 AM");
    assert.equal(formatTimeOfDay(12, 0), "12:00 PM");
    assert.equal(formatTimeOfDay(13, 5), "1:05 PM");
    assert.equal(formatTimeOfDay(23, 59), "11:59 PM");
  });

  test("ordinal covers the awkward ones", () => {
    assert.equal(ordinal(1), "1st");
    assert.equal(ordinal(2), "2nd");
    assert.equal(ordinal(3), "3rd");
    assert.equal(ordinal(4), "4th");
    assert.equal(ordinal(11), "11th");
    assert.equal(ordinal(12), "12th");
    assert.equal(ordinal(13), "13th");
    assert.equal(ordinal(21), "21st");
    assert.equal(ordinal(31), "31st");
  });
});

describe("label tables", () => {
  test("weekday and month names line up with their indices", () => {
    assert.equal(WEEKDAY_NAMES.length, 7);
    assert.equal(WEEKDAY_NAMES[0], "Sunday");
    assert.equal(MONTH_NAMES.length, 12);
    assert.equal(MONTH_NAMES[0], "January");
    assert.equal(MONTH_NAMES[11], "December");
  });

  test("daysInMonth allows a leap day and refuses a 31st February", () => {
    assert.deepEqual(
      Array.from({ length: 12 }, (_, i) => daysInMonth(i + 1)),
      [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    );
    assert.equal(daysInMonth(0), 31, "out-of-range months fall back to January");
    assert.equal(daysInMonth(13), 31);
  });

  test("every offered step divides its unit evenly", () => {
    for (const step of MINUTE_STEPS) assert.equal(60 % step, 0, `minute step ${step}`);
    for (const step of HOUR_STEPS) assert.equal(24 % step, 0, `hour step ${step}`);
  });

  test("preset labels are unique", () => {
    const labels = SCHEDULE_PRESETS.map((p) => p.label);
    assert.equal(new Set(labels).size, labels.length);
  });
});
