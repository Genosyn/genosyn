import assert from "node:assert/strict";
import test from "node:test";
import {
  INTERRUPTED_RECOVERY_DELAY_MS,
  ORPHAN_GRACE_MS,
  RETRY_MAX_BACKOFF_MS,
  automaticRetryDelayMs,
  automaticRetryLimit,
  backoffDelayMs,
  countMissedSlots,
  cronZoneOptions,
  isRunOrphaned,
  isSlotStale,
  nextRunFor,
  shouldRetry,
} from "./cronMath.js";

const HOURLY = "0 * * * *";
const at = (iso: string): Date => new Date(iso);

test("counts no missed slots when the window is empty or inverted", () => {
  assert.deepEqual(
    countMissedSlots(HOURLY, at("2026-01-01T10:00:00Z"), at("2026-01-01T10:00:00Z"), 100),
    {
      count: 0,
      capped: false,
    },
  );
  assert.deepEqual(
    countMissedSlots(HOURLY, at("2026-01-01T12:00:00Z"), at("2026-01-01T10:00:00Z"), 100),
    {
      count: 0,
      capped: false,
    },
  );
});

test("counts occurrences strictly after the due slot and up to now", () => {
  // 10:00 is the slot being served, so it isn't counted; 30 minutes later
  // nothing else has come due.
  assert.deepEqual(
    countMissedSlots(HOURLY, at("2026-01-01T10:00:00Z"), at("2026-01-01T10:30:00Z"), 100),
    {
      count: 0,
      capped: false,
    },
  );
  // 11:00 through 15:00 elapsed while we were down.
  assert.deepEqual(
    countMissedSlots(HOURLY, at("2026-01-01T10:00:00Z"), at("2026-01-01T15:01:00Z"), 100),
    {
      count: 5,
      capped: false,
    },
  );
  // A slot landing exactly on `until` is included.
  assert.deepEqual(
    countMissedSlots(HOURLY, at("2026-01-01T10:00:00Z"), at("2026-01-01T11:00:00Z"), 100),
    {
      count: 1,
      capped: false,
    },
  );
});

test("caps the missed-slot count instead of enumerating a week of minutes", () => {
  const res = countMissedSlots(
    "* * * * *",
    at("2026-01-01T00:00:00Z"),
    at("2026-01-02T00:00:00Z"),
    100,
  );
  assert.equal(res.count, 100);
  assert.equal(res.capped, true);
});

test("treats an unschedulable expression as zero missed slots, not a throw", () => {
  // node-cron's validate() accepts this, so routines.ts used to let it through;
  // cron-parser throws on it. The heartbeat must not die on that.
  assert.deepEqual(
    countMissedSlots("5-1 9 * * *", at("2026-01-01T00:00:00Z"), at("2026-01-02T00:00:00Z"), 100),
    {
      count: 0,
      capped: false,
    },
  );
});

test("only calls a slot stale once it is past the grace window", () => {
  const slot = at("2026-01-01T10:00:00Z");
  assert.equal(isSlotStale(slot, at("2026-01-01T10:00:10Z")), false);
  assert.equal(isSlotStale(slot, at("2026-01-01T13:00:00Z")), true);
  // Exactly at the boundary is not stale — the comparison is strict.
  assert.equal(isSlotStale(slot, at("2026-01-01T10:01:00Z")), false);
  assert.equal(isSlotStale(slot, at("2026-01-01T09:00:00Z")), false);
});

test("only calls a run orphaned once it outlived its own timeout plus grace", () => {
  const started = at("2026-01-01T10:00:00Z");
  assert.equal(isRunOrphaned(started, 3600, at("2026-01-01T10:00:01Z")), false);
  assert.equal(isRunOrphaned(started, 60, at("2026-01-01T12:00:00Z")), true);
  const boundary = new Date(started.getTime() + 60_000 + ORPHAN_GRACE_MS);
  assert.equal(isRunOrphaned(started, 60, boundary), false);
  assert.equal(isRunOrphaned(started, 60, new Date(boundary.getTime() + 1)), true);
});

test("clamps a nonsensical timeout rather than declaring a fresh run dead", () => {
  const started = at("2026-01-01T10:00:00Z");
  assert.equal(isRunOrphaned(started, 0, at("2026-01-01T10:00:30Z")), false);
  assert.equal(isRunOrphaned(started, -5, at("2026-01-01T10:00:30Z")), false);
  // Clock skew: a startedAt in the future is not evidence of a crash.
  assert.equal(isRunOrphaned(at("2026-01-01T12:00:00Z"), 60, at("2026-01-01T10:00:00Z")), false);
});

test("doubles the backoff ceiling on each attempt", () => {
  const top = { baseMs: 1000, rng: () => 1 };
  assert.equal(backoffDelayMs(1, top), 1000);
  assert.equal(backoffDelayMs(2, top), 2000);
  assert.equal(backoffDelayMs(3, top), 4000);
  assert.equal(backoffDelayMs(4, top), 8000);
});

test("jitters the whole band, so the low end is zero", () => {
  const bottom = { baseMs: 1000, rng: () => 0 };
  for (const attempt of [1, 2, 3, 10]) assert.equal(backoffDelayMs(attempt, bottom), 0);
});

test("caps the backoff and stays capped for every higher attempt", () => {
  const opts = { baseMs: 1000, maxMs: 5000, rng: () => 1 };
  assert.equal(backoffDelayMs(3, opts), 4000);
  assert.equal(backoffDelayMs(4, opts), 5000);
  assert.equal(backoffDelayMs(50, opts), 5000);
});

test("stays finite at absurd attempt numbers", () => {
  // The exponent is clamped before the `**`; without that, 2 ** 1000 is
  // Infinity and the delay becomes NaN.
  const delay = backoffDelayMs(1000, { baseMs: 1000, rng: () => 1 });
  assert.equal(Number.isFinite(delay), true);
  assert.equal(delay <= RETRY_MAX_BACKOFF_MS, true);
  assert.equal(Number.isInteger(delay), true);
});

test("treats a zero or negative attempt as the first tier", () => {
  const top = { baseMs: 1000, rng: () => 1 };
  assert.equal(backoffDelayMs(0, top), 1000);
  assert.equal(backoffDelayMs(-3, top), 1000);
});

const base = {
  triggerKind: "schedule" as const,
  attempt: 1,
  maxAttempts: 3,
  retryOnTimeout: false,
};

test("default settings grant only one recovery attempt to interrupted scheduled Runs", () => {
  for (const status of ["running", "completed", "failed", "skipped", "timeout"] as const) {
    assert.equal(shouldRetry({ ...base, status, maxAttempts: 1 }), false);
  }
  assert.equal(shouldRetry({ ...base, status: "interrupted", maxAttempts: 1 }), true);
  assert.equal(shouldRetry({ ...base, status: "interrupted", maxAttempts: 1, attempt: 2 }), false);
  assert.equal(automaticRetryLimit("interrupted", 1), 2);
  assert.equal(automaticRetryLimit("failed", 1), 1);
});

test("uses a fixed hour for implicit interruption recovery and configured jitter otherwise", () => {
  assert.equal(
    automaticRetryDelayMs({
      status: "interrupted",
      attempt: 1,
      maxAttempts: 1,
      baseMs: 10_000,
      rng: () => 0,
    }),
    INTERRUPTED_RECOVERY_DELAY_MS,
  );
  assert.equal(
    automaticRetryDelayMs({
      status: "interrupted",
      attempt: 1,
      maxAttempts: 3,
      baseMs: 10_000,
      rng: () => 0.5,
    }),
    5_000,
  );
});

test("retries failed and interrupted runs, but not clean or skipped ones", () => {
  assert.equal(shouldRetry({ ...base, status: "failed" }), true);
  assert.equal(shouldRetry({ ...base, status: "interrupted" }), true);
  assert.equal(shouldRetry({ ...base, status: "completed" }), false);
  assert.equal(shouldRetry({ ...base, status: "skipped" }), false);
  assert.equal(shouldRetry({ ...base, status: "running" }), false);
});

test("gates timeout retries on their own flag", () => {
  assert.equal(shouldRetry({ ...base, status: "timeout" }), false);
  assert.equal(shouldRetry({ ...base, status: "timeout", retryOnTimeout: true }), true);
});

test("stops once the attempt budget is spent", () => {
  assert.equal(shouldRetry({ ...base, status: "failed", attempt: 2 }), true);
  assert.equal(shouldRetry({ ...base, status: "failed", attempt: 3 }), false);
  assert.equal(shouldRetry({ ...base, status: "failed", attempt: 4 }), false);
});

test("leaves human- and caller-triggered runs alone", () => {
  for (const triggerKind of ["manual", "webhook", "approval"] as const) {
    assert.equal(shouldRetry({ ...base, status: "failed", triggerKind }), false);
    assert.equal(
      shouldRetry({
        ...base,
        status: "interrupted",
        triggerKind,
        maxAttempts: 1,
      }),
      false,
    );
  }
  // A retry may itself be retried, up to the budget.
  assert.equal(shouldRetry({ ...base, status: "failed", triggerKind: "retry" }), true);
});

test("Error preserves timeout and restart recovery policies using its durable cause", () => {
  assert.equal(shouldRetry({ ...base, status: "error", errorKind: "runtime" }), true);
  assert.equal(shouldRetry({ ...base, status: "error", errorKind: "timeout" }), false);
  assert.equal(
    shouldRetry({ ...base, status: "error", errorKind: "timeout", retryOnTimeout: true }),
    true,
  );
  assert.equal(
    shouldRetry({ ...base, status: "error", errorKind: "interrupted", maxAttempts: 1 }),
    true,
  );
  assert.equal(
    shouldRetry({ ...base, status: "error", errorKind: "interrupted", maxAttempts: 1, attempt: 2 }),
    false,
  );
  assert.equal(automaticRetryLimit("error", 1, "interrupted"), 2);
  assert.equal(
    automaticRetryDelayMs({
      status: "error",
      errorKind: "interrupted",
      attempt: 1,
      maxAttempts: 1,
      baseMs: 10,
      rng: () => 0,
    }),
    INTERRUPTED_RECOVERY_DELAY_MS,
  );
});

// --- Reading a schedule in a company's time zone ---------------------------

/** Put the process on another clock — "server time" — for the length of `fn`. */
function onServerClock<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** The 24-hour wall clock ("09:00") a moment reads in `zone`, or on the process clock. */
function clockIn(zone: string | undefined, moment: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(zone ? { timeZone: zone } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(moment);
}

/** Every fire strictly after `after` and no later than `until`. */
function firesBetween(expr: string, zone: string, after: Date, until: Date): Date[] {
  const fires: Date[] = [];
  let cursor = after;
  for (;;) {
    const next = nextRunFor(expr, cursor, zone);
    if (next === null || next.getTime() > until.getTime()) return fires;
    fires.push(next);
    cursor = next;
  }
}

const DAILY_9 = "0 9 * * *";
const MORNING = at("2026-06-05T12:00:00Z");

test("reads a schedule's clock fields in the zone it is given", () => {
  // Nine o'clock is a different instant in every zone, daylight saving included.
  const iso = (zone: string) => nextRunFor(DAILY_9, MORNING, zone)?.toISOString();
  assert.equal(iso("Europe/Berlin"), "2026-06-06T07:00:00.000Z");
  assert.equal(iso("Asia/Kolkata"), "2026-06-06T03:30:00.000Z");
  assert.equal(iso("Asia/Kathmandu"), "2026-06-06T03:15:00.000Z");
  assert.equal(iso("UTC"), "2026-06-06T09:00:00.000Z");
  // 12:00Z is 08:00 in New York: today's nine o'clock there is still ahead.
  assert.equal(iso("America/New_York"), "2026-06-05T13:00:00.000Z");
});

test("an empty zone is server time, exactly as schedules were read before zones existed", () => {
  for (const server of ["UTC", "America/New_York", "Pacific/Auckland"]) {
    onServerClock(server, () => {
      const unset = nextRunFor(DAILY_9, MORNING);
      assert.ok(unset, server);
      assert.equal(clockIn(undefined, unset), "09:00", `${server} reads nine on its own clock`);
      for (const empty of ["", "  ", null, undefined]) {
        assert.equal(
          nextRunFor(DAILY_9, MORNING, empty)?.toISOString(),
          unset.toISOString(),
          `${server}: ${JSON.stringify(empty)}`,
        );
      }
    });
  }
  // And a zone is not the server's: the same expression lands elsewhere.
  onServerClock("Pacific/Auckland", () => {
    assert.notEqual(
      nextRunFor(DAILY_9, MORNING, "Europe/Berlin")?.toISOString(),
      nextRunFor(DAILY_9, MORNING)?.toISOString(),
    );
  });
});

test("a zone the runtime does not know keeps the schedule alive on server time", () => {
  // cron-parser throws on an unknown zone and nextRunFor() turns a throw into
  // null, which the heartbeat reads as "never runs". Falling back is the
  // smaller failure.
  onServerClock("UTC", () => {
    for (const unknown of ["Mars/Base", "+01:00", "local", "Europe/Berlin; rm -rf"]) {
      assert.equal(
        nextRunFor(DAILY_9, MORNING, unknown)?.toISOString(),
        "2026-06-06T09:00:00.000Z",
        unknown,
      );
    }
  });
  assert.equal(nextRunFor("5-1 9 * * *", MORNING, "Europe/Berlin"), null, "bad cron is still null");
});

test("hands cron-parser a zone only when there is a usable one", () => {
  assert.deepEqual(cronZoneOptions("Europe/Berlin"), { tz: "Europe/Berlin" });
  assert.deepEqual(cronZoneOptions("  Asia/Tokyo "), { tz: "Asia/Tokyo" });
  for (const none of ["", "   ", null, undefined, "Mars/Base"]) {
    assert.deepEqual(cronZoneOptions(none), {}, JSON.stringify(none));
  }
});

test("a daily schedule keeps its wall-clock hour across a daylight-saving change", () => {
  // New York springs forward on 2026-03-08: nine o'clock is 14:00Z before, 13:00Z after.
  const spring: string[] = [];
  let cursor = at("2026-03-06T00:00:00Z");
  for (let day = 0; day < 4; day += 1) {
    const next = nextRunFor(DAILY_9, cursor, "America/New_York");
    assert.ok(next);
    spring.push(next.toISOString());
    cursor = next;
  }
  assert.deepEqual(spring, [
    "2026-03-06T14:00:00.000Z",
    "2026-03-07T14:00:00.000Z",
    "2026-03-08T13:00:00.000Z",
    "2026-03-09T13:00:00.000Z",
  ]);
  // Berlin falls back on 2026-10-25: 07:00Z before, 08:00Z after.
  const fall: string[] = [];
  cursor = at("2026-10-23T00:00:00Z");
  for (let day = 0; day < 4; day += 1) {
    const next = nextRunFor(DAILY_9, cursor, "Europe/Berlin");
    assert.ok(next);
    fall.push(next.toISOString());
    cursor = next;
  }
  assert.deepEqual(fall, [
    "2026-10-23T07:00:00.000Z",
    "2026-10-24T07:00:00.000Z",
    "2026-10-25T08:00:00.000Z",
    "2026-10-26T08:00:00.000Z",
  ]);
});

test("a day with a skipped or repeated hour neither loses nor doubles a daily run", () => {
  // 02:30 does not exist in New York on 2026-03-08 and 01:30 happens twice on
  // 2026-11-01. Either way the local day must hold exactly one run.
  assert.equal(
    firesBetween(
      "30 2 * * *",
      "America/New_York",
      at("2026-03-08T04:59:59Z"),
      at("2026-03-09T03:59:59Z"),
    ).length,
    1,
  );
  assert.equal(
    firesBetween(
      "30 1 * * *",
      "America/New_York",
      at("2026-11-01T03:59:59Z"),
      at("2026-11-02T04:59:59Z"),
    ).length,
    1,
  );
});

test("an hourly schedule runs every real hour of a 23- and a 25-hour day", () => {
  assert.equal(
    firesBetween(
      "0 * * * *",
      "America/New_York",
      at("2026-03-08T04:59:59Z"),
      at("2026-03-09T03:59:59Z"),
    ).length,
    23,
  );
  assert.equal(
    firesBetween(
      "0 * * * *",
      "America/New_York",
      at("2026-11-01T03:59:59Z"),
      at("2026-11-02T04:59:59Z"),
    ).length,
    25,
  );
});

test("counts missed slots on the same clock the schedule fires on", () => {
  const after = at("2026-06-01T00:00:00Z");
  const until = at("2026-06-04T08:00:00Z");
  // Nine in Berlin is 07:00Z: June 1–4 have all come round by 08:00Z on the 4th.
  assert.deepEqual(countMissedSlots(DAILY_9, after, until, 100, "Europe/Berlin"), {
    count: 4,
    capped: false,
  });
  // Nine in UTC is 09:00Z: the 4th is still an hour away.
  assert.deepEqual(countMissedSlots(DAILY_9, after, until, 100, "UTC"), {
    count: 3,
    capped: false,
  });
  // Server time is whatever the process clock says, and "" asks for it.
  onServerClock("Europe/Berlin", () => {
    assert.equal(countMissedSlots(DAILY_9, after, until, 100, "").count, 4);
    assert.equal(countMissedSlots(DAILY_9, after, until, 100).count, 4);
  });
  onServerClock("UTC", () => {
    assert.equal(countMissedSlots(DAILY_9, after, until, 100, "").count, 3);
  });
});
