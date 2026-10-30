import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SESSION_WINDOW_HOURS,
  addSession,
  combineSessionsByHour,
  readSessionsByHour,
  sessionsInWindow,
  type HourlySessions,
} from "./modelKeySessions.js";

/**
 * How many sessions each API key carried in the last day: counted by the hour
 * on the key's health row, read tolerantly, never more than a day kept.
 */

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-30T12:30:00.000Z");
const hour = (at: number) => Math.floor(at / HOUR);

describe("counting a key's sessions by the hour", () => {
  test("each session adds one to its hour", () => {
    let byHour: HourlySessions[] = [];
    byHour = addSession(byHour, NOW);
    byHour = addSession(byHour, NOW + 60_000);
    byHour = addSession(byHour, NOW + HOUR);
    assert.deepEqual(byHour, [
      [hour(NOW), 2],
      [hour(NOW) + 1, 1],
    ]);
    assert.equal(sessionsInWindow(JSON.stringify(byHour), NOW + HOUR), 3);
  });

  test("hours older than the window are dropped as new sessions come in", () => {
    let byHour: HourlySessions[] = [];
    for (let h = 0; h < 30; h++) byHour = addSession(byHour, NOW + h * HOUR);
    assert.equal(byHour.length, SESSION_WINDOW_HOURS);
    assert.equal(byHour[0][0], hour(NOW + 29 * HOUR) - SESSION_WINDOW_HOURS + 1);
    assert.equal(sessionsInWindow(JSON.stringify(byHour), NOW + 29 * HOUR), 24);
  });

  test("the window reads only the last 24 hours, at whatever time it is read", () => {
    const stored = JSON.stringify([
      [hour(NOW) - 30, 9],
      [hour(NOW) - 23, 2],
      [hour(NOW), 3],
    ]);
    assert.equal(sessionsInWindow(stored, NOW), 5);
    assert.equal(sessionsInWindow(stored, NOW + HOUR), 3, "the oldest kept hour slips out");
    assert.equal(sessionsInWindow(stored, NOW + 24 * HOUR), 0, "a quiet day reads as none");
  });

  test("a session written by a clock that ran ahead is not counted yet", () => {
    assert.equal(sessionsInWindow(JSON.stringify([[hour(NOW) + 2, 4]]), NOW), 0);
  });

  test("never changes the list it was given", () => {
    const byHour: HourlySessions[] = [[hour(NOW), 1]];
    addSession(byHour, NOW);
    assert.deepEqual(byHour, [[hour(NOW), 1]]);
  });
});

describe("reading what is stored", () => {
  test("nothing stored is no sessions", () => {
    assert.deepEqual(readSessionsByHour(null), []);
    assert.deepEqual(readSessionsByHour(undefined), []);
    assert.deepEqual(readSessionsByHour(""), []);
    assert.equal(sessionsInWindow(null, NOW), 0);
  });

  test("malformed entries are skipped, never thrown", () => {
    for (const junk of ["{", "42", '"text"', "{}", "[1,2]", "null"]) {
      assert.deepEqual(readSessionsByHour(junk), [], junk);
    }
    assert.deepEqual(
      readSessionsByHour(
        JSON.stringify([
          [hour(NOW), 2],
          [hour(NOW), "3"],
          ["x", 1],
          [hour(NOW) - 1, -4],
          [hour(NOW) - 2, 1.5],
          [hour(NOW) - 3],
          null,
        ]),
      ),
      [[hour(NOW), 2]],
    );
  });

  test("an hour listed twice is added up, and hours come back in order", () => {
    assert.deepEqual(
      readSessionsByHour(
        JSON.stringify([
          [hour(NOW), 2],
          [hour(NOW) - 5, 1],
          [hour(NOW), 3],
        ]),
      ),
      [
        [hour(NOW) - 5, 1],
        [hour(NOW), 5],
      ],
    );
  });
});

describe("merging two copies of one key", () => {
  test("their sessions add up by the hour", () => {
    const a = JSON.stringify([
      [hour(NOW) - 1, 2],
      [hour(NOW), 1],
    ]);
    const b = JSON.stringify([[hour(NOW), 4]]);
    assert.equal(
      combineSessionsByHour(a, b, NOW),
      JSON.stringify([
        [hour(NOW) - 1, 2],
        [hour(NOW), 5],
      ]),
    );
  });

  test("nothing left in the window is nothing stored", () => {
    assert.equal(combineSessionsByHour(null, null, NOW), null);
    assert.equal(combineSessionsByHour(JSON.stringify([[hour(NOW) - 40, 3]]), null, NOW), null);
    assert.equal(
      combineSessionsByHour(null, JSON.stringify([[hour(NOW), 1]]), NOW),
      "[[" + hour(NOW) + ",1]]",
    );
  });
});
