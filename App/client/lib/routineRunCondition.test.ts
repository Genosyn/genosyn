import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RoutineRunConditionStatus } from "./api";
import {
  RUN_CONDITION_OPTIONS,
  relativeTime,
  revisitPhrase,
  routineRunConditionOf,
  runConditionHelp,
  runConditionLabel,
  scheduleWithRunCondition,
  summarizeRunConditionStatus,
} from "./routineRunCondition";

const now = Date.parse("2026-11-16T12:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();

const idle: RoutineRunConditionStatus = {
  condition: "workstream_due",
  due: false,
  dueWorkstreams: [],
  nextRevisit: null,
  unplanned: 0,
  lookedAt: null,
  nothingDueAt: null,
  nothingDueCount: 0,
};

describe("the setting", () => {
  test("offers Every time first, then the Workstream condition", () => {
    assert.deepEqual(
      RUN_CONDITION_OPTIONS.map((option) => option.value),
      ["always", "workstream_due"],
    );
    assert.deepEqual(
      RUN_CONDITION_OPTIONS.map((option) => option.label),
      ["Every time", "When a Workstream is due"],
    );
  });

  test("reads anything unknown as Every time", () => {
    for (const value of [undefined, null, "", "sometimes"]) {
      assert.equal(routineRunConditionOf(value), "always");
      assert.equal(runConditionLabel(value), "Every time");
    }
    assert.equal(runConditionLabel("workstream_due"), "Only when a Workstream is due");
  });

  test("explains itself in the employee's name, and that it costs nothing when idle", () => {
    const help = runConditionHelp("workstream_due", "Jamie");
    assert.match(help, /Jamie’s Workstreams/);
    assert.match(help, /without the AI Model/);
    assert.match(help, /costs nothing/);
    assert.match(help, /Run now always runs/);
    assert.match(runConditionHelp("workstream_due", null), /the employee’s Workstreams/);
    assert.match(runConditionHelp("always"), /Every scheduled time and Trigger starts a Run/);
  });

  test("a schedule reads with its condition", () => {
    assert.equal(
      scheduleWithRunCondition("Every 30 minutes", "workstream_due"),
      "Every 30 minutes, only when a Workstream is due",
    );
    assert.equal(scheduleWithRunCondition("Every 30 minutes", undefined), "Every 30 minutes");
  });
});

describe("relativeTime", () => {
  test("says how far off a moment is, either way", () => {
    assert.equal(relativeTime(iso(0), now), "just now");
    assert.equal(relativeTime(iso(0.4), now), "in under a minute");
    assert.equal(relativeTime(iso(-12), now), "12m ago");
    assert.equal(relativeTime(iso(45), now), "in 45m");
    assert.equal(relativeTime(iso(-180), now), "3h ago");
    assert.equal(relativeTime(iso(60 * 30), now), "in 1d");
    assert.equal(relativeTime(iso(-60 * 24 * 3), now), "3d ago");
    assert.equal(relativeTime("not a time", now), "");
  });
});

describe("revisitPhrase", () => {
  test("names a planned, due or missing revisit", () => {
    assert.equal(revisitPhrase(null, now), "No revisit planned");
    assert.equal(revisitPhrase(iso(120), now), "Revisit in 2h");
    assert.equal(revisitPhrase(iso(0), now), "Revisit due now");
    assert.equal(revisitPhrase(iso(-30), now), "Revisit due since 30m ago");
  });
});

describe("summarizeRunConditionStatus", () => {
  test("an idle Routine with nothing planned says it waits for a plan", () => {
    const summary = summarizeRunConditionStatus(idle, now);
    assert.equal(summary.state, "idle");
    assert.equal(summary.headline, "Nothing is due — scheduled times start no Run");
    assert.deepEqual(summary.details, [
      "No revisit is planned, so it waits until the employee plans one.",
    ]);
  });

  test("an idle Routine names the next revisit and what its condition saved", () => {
    const summary = summarizeRunConditionStatus(
      {
        ...idle,
        nextRevisit: { id: "w1", title: "Check the fix", revisitAt: iso(90) },
        nothingDueAt: iso(-3),
        nothingDueCount: 14,
        unplanned: 2,
      },
      now,
    );
    assert.equal(summary.state, "idle");
    assert.deepEqual(summary.details, [
      "Next revisit: “Check the fix” in 2h",
      "Since its last Run, Genosyn looked 14 times and found nothing due — no Runs, no AI Model turns. Last looked 3m ago.",
      "2 open Workstreams have no revisit planned and won’t start it.",
    ]);
  });

  test("one declined start and one unplanned Workstream read in the singular", () => {
    const summary = summarizeRunConditionStatus(
      { ...idle, nothingDueAt: iso(-1), nothingDueCount: 1, unplanned: 1 },
      now,
    );
    assert.ok(
      summary.details.includes(
        "Since its last Run, Genosyn looked once and found nothing due — no Run, no AI Model turn. Last looked 1m ago.",
      ),
    );
    assert.ok(
      summary.details.includes("1 open Workstream has no revisit planned and won’t start it."),
    );
  });

  test("a due Routine names what is due, three at most", () => {
    const due = Array.from({ length: 5 }, (_, index) => ({
      id: `w${index}`,
      title: `Work ${index}`,
      revisitAt: iso(-(index + 1) * 10),
    }));
    const summary = summarizeRunConditionStatus({ ...idle, due: true, dueWorkstreams: due }, now);
    assert.equal(summary.state, "due");
    assert.equal(summary.headline, "5 Workstreams are due — the next scheduled time starts a Run");
    assert.deepEqual(summary.details, [
      "“Work 0” · due 10m ago",
      "“Work 1” · due 20m ago",
      "“Work 2” · due 30m ago",
      "and 2 more",
    ]);
    const one = summarizeRunConditionStatus(
      { ...idle, due: true, dueWorkstreams: due.slice(0, 1) },
      now,
    );
    assert.equal(one.headline, "1 Workstream is due — the next scheduled time starts a Run");
  });
});
