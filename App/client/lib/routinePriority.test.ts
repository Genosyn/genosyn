import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  headStartWords,
  isHighPriority,
  movedUpNote,
  ordinal,
  queuePlace,
  QUEUE_ORDER_NOTE,
  ROUTINE_PRIORITY_OPTIONS,
  routinePriorityHelp,
  routinePriorityOf,
  HIGH_PRIORITY_HEAD_START_MS,
} from "./routinePriority";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

describe("a Routine's priority", () => {
  test("reads anything unknown or missing as Normal", () => {
    assert.equal(routinePriorityOf("high"), "high");
    assert.equal(routinePriorityOf("normal"), "normal");
    for (const value of [undefined, null, "", "urgent", "HIGH", 2]) {
      assert.equal(routinePriorityOf(value), "normal", String(value));
      assert.equal(isHighPriority(value), false, String(value));
    }
    assert.equal(isHighPriority("high"), true);
  });

  test("offers Normal, then High, in settings", () => {
    assert.deepEqual(
      ROUTINE_PRIORITY_OPTIONS.map((option) => [option.value, option.label]),
      [
        ["normal", "Normal"],
        ["high", "High"],
      ],
    );
  });

  test("explains what each choice does, including the bound on waiting", () => {
    const high = routinePriorityHelp("high");
    assert.match(high, /start before Normal ones/);
    const normal = routinePriorityHelp("normal");
    assert.match(normal, /in the order they were queued/);
    for (const help of [high, normal]) {
      assert.match(help, /paused for a restart and continuations of unfinished work still go first/);
      assert.match(help, /waited a day moves up with High ones, so nothing waits forever/);
    }
  });

  test("says the head start in words", () => {
    assert.equal(headStartWords(), "a day");
    assert.equal(headStartWords(HIGH_PRIORITY_HEAD_START_MS), "a day");
    assert.equal(headStartWords(2 * 24 * 3_600_000), "2 days");
    assert.equal(headStartWords(3_600_000), "an hour");
    assert.equal(headStartWords(6 * 3_600_000), "6 hours");
  });
});

describe("a waiting Run's place in the queue", () => {
  test("is Next up at the front and a number behind it", () => {
    assert.deepEqual(queuePlace(1), {
      label: "Next up",
      description: "Queue position 1: next to start when its AI Model has room",
      next: true,
    });
    assert.deepEqual(queuePlace(2), {
      label: "#2",
      description: "Queue position 2: 2nd in line to start",
      next: false,
    });
    assert.equal(queuePlace(23)?.description, "Queue position 23: 23rd in line to start");
  });

  test("is nothing for a Run the server gave no place, or an older server's reply", () => {
    for (const position of [null, undefined, 0, -1, 1.5, Number.NaN]) {
      assert.equal(queuePlace(position), null, String(position));
    }
  });

  test("counts in English", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal),
      ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th"],
    );
  });

  test("says why a Normal Run sits among High work once it has waited a day", () => {
    assert.equal(
      movedUpNote({ priority: "normal", queuedAt: hoursAgo(25) }, NOW),
      "Waited over a day, so it now goes ahead of Normal work",
    );
    assert.equal(movedUpNote({ priority: "normal", queuedAt: hoursAgo(23) }, NOW), null);
    assert.equal(movedUpNote({ priority: "high", queuedAt: hoursAgo(48) }, NOW), null);
    assert.equal(movedUpNote({ queuedAt: hoursAgo(30) }, NOW) !== null, true, "missing reads Normal");
    assert.equal(
      movedUpNote({ priority: "normal", queuedAt: hoursAgo(30) }, new Date(NOW).toISOString()) !==
        null,
      true,
      "the clock may come as text, as the day modal passes it",
    );
    assert.equal(movedUpNote({ priority: "normal", queuedAt: null }, NOW), null);
    assert.equal(movedUpNote({ priority: "normal", queuedAt: "soon" }, NOW), null);
    assert.equal(movedUpNote({ priority: "normal", queuedAt: hoursAgo(30) }, "later"), null);
  });

  test("the queue's order is named in one line", () => {
    assert.equal(QUEUE_ORDER_NOTE, "In start order · High priority first");
  });
});
