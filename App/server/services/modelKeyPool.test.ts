import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { forgetKeyTurns, handOutKey, resetKeyPoolMemory, turnOrder } from "./modelKeyPool.js";

/**
 * Whose turn it is among an AI Model's API keys: round-robin, kept as "handed
 * out longest ago", from a random starting place, per AI Model row.
 */

const keys = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: Array<{ id: string }>) => list.map((key) => key.id);

/** Take `n` turns the way a session does: the first key in turn order, handed out. */
function take(modelId: string, pool: Array<{ id: string }>, n: number): string[] {
  const taken: string[] = [];
  for (let i = 0; i < n; i++) {
    const [next] = turnOrder(modelId, pool);
    handOutKey(modelId, next.id);
    taken.push(next.id);
  }
  return taken;
}

beforeEach(() => resetKeyPoolMemory({ random: () => 0 }));

describe("the turn order", () => {
  test("round-robin: every key once per cycle, then again in the same order", () => {
    const pool = keys("a", "b", "c", "d", "e", "f", "g");
    const taken = take("m", pool, 21);
    assert.deepEqual(taken, [...ids(pool), ...ids(pool), ...ids(pool)]);
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.deepEqual(
        [...taken.slice(cycle * 7, cycle * 7 + 7)].sort(),
        ids(pool),
        `cycle ${cycle + 1} used every key exactly once`,
      );
    }
  });

  test("reading the order takes no turn", () => {
    const pool = keys("a", "b", "c");
    for (let i = 0; i < 5; i++) assert.deepEqual(ids(turnOrder("m", pool)), ["a", "b", "c"]);
    handOutKey("m", "a");
    assert.deepEqual(ids(turnOrder("m", pool)), ["b", "c", "a"]);
    assert.deepEqual(ids(turnOrder("m", pool)), ["b", "c", "a"]);
  });

  test("never changes the list it was given", () => {
    const pool = Object.freeze(keys("a", "b", "c"));
    handOutKey("m", "a");
    turnOrder("m", pool);
    assert.deepEqual(ids([...pool]), ["a", "b", "c"]);
  });

  test("a single key, or none, is its own order", () => {
    assert.deepEqual(take("m", keys("only"), 4), ["only", "only", "only", "only"]);
    assert.deepEqual(turnOrder("m", []), []);
  });
});

describe("the random starting place", () => {
  test("keys never handed out start from the pool's random place onward", () => {
    resetKeyPoolMemory({ random: () => 0.5 });
    assert.deepEqual(take("m", keys("a", "b", "c", "d"), 8), [
      "c",
      "d",
      "a",
      "b",
      "c",
      "d",
      "a",
      "b",
    ]);
    resetKeyPoolMemory({ random: () => 0.999 });
    assert.deepEqual(take("m", keys("a", "b", "c", "d"), 4), ["d", "a", "b", "c"]);
  });

  test("each AI Model draws its own starting place", () => {
    const draws = [0.1, 0.8];
    resetKeyPoolMemory({ random: () => draws.shift() ?? 0 });
    const pool = keys("a", "b", "c", "d", "e");
    assert.equal(take("first", pool, 1)[0], "a");
    assert.equal(take("second", pool, 1)[0], "e");
  });

  test("a restart or another process does not start every model on its first key", () => {
    resetKeyPoolMemory();
    const pool = keys("a", "b", "c", "d");
    const firsts = new Set<string>();
    for (let restart = 0; restart < 400; restart++) {
      resetKeyPoolMemory();
      firsts.add(take("m", pool, 1)[0]);
    }
    // With 400 fresh starts the chance a key is never first is about 4 × (3/4)^400.
    assert.deepEqual([...firsts].sort(), ["a", "b", "c", "d"]);
  });

  test("the starting place follows the pool as keys come and go", () => {
    resetKeyPoolMemory({ random: () => 0.5 });
    assert.deepEqual(ids(turnOrder("m", keys("a", "b"))), ["b", "a"]);
    assert.deepEqual(ids(turnOrder("m", keys("a", "b", "c", "d", "e", "f"))), [
      "d",
      "e",
      "f",
      "a",
      "b",
      "c",
    ]);
  });
});

describe("keys that change mid-rotation", () => {
  test("a key added after a full cycle takes the very next turn, then joins the cycle", () => {
    const three = keys("a", "b", "c");
    assert.deepEqual(take("m", three, 6), ["a", "b", "c", "a", "b", "c"]);
    const four = keys("a", "b", "c", "d");
    assert.deepEqual(take("m", four, 8), ["d", "a", "b", "c", "d", "a", "b", "c"]);
  });

  test("a key added mid-cycle goes ahead of every key that already had a turn", () => {
    take("m", keys("a", "b", "c"), 1);
    // b and c haven't had a turn either; the new key waits behind them, never behind a.
    assert.deepEqual(take("m", keys("a", "b", "c", "d"), 4), ["b", "c", "d", "a"]);
  });

  test("a new key is never starved, however long the others have been running", () => {
    const pool = keys("a", "b", "c");
    take("m", pool, 300);
    const grown = keys("a", "b", "c", "late");
    const next = take("m", grown, 40);
    assert.equal(next[0], "late");
    assert.equal(next.filter((id) => id === "late").length, 10);
  });

  test("a removed key drops out and the others keep their turns", () => {
    assert.deepEqual(take("m", keys("a", "b", "c", "d"), 2), ["a", "b"]);
    // b removed: c and d still haven't had their turn, then a.
    assert.deepEqual(take("m", keys("a", "c", "d"), 6), ["c", "d", "a", "c", "d", "a"]);
  });

  test("forgetting the keys a model no longer holds keeps the others' turns", () => {
    take("m", keys("a", "b", "c"), 3);
    forgetKeyTurns("m", new Set(["b", "c"]));
    // a was forgotten, so it reads as never handed out and goes first.
    assert.deepEqual(ids(turnOrder("m", keys("a", "b", "c"))), ["a", "b", "c"]);
    take("m", keys("a", "b", "c"), 1);
    assert.deepEqual(ids(turnOrder("m", keys("a", "b", "c"))), ["b", "c", "a"]);
  });

  test("forgetting a whole model starts its pool afresh", () => {
    const draws = [0, 0.5];
    resetKeyPoolMemory({ random: () => draws.shift() ?? 0 });
    take("m", keys("a", "b", "c", "d"), 3);
    forgetKeyTurns("m");
    assert.deepEqual(ids(turnOrder("m", keys("a", "b", "c", "d"))), ["c", "d", "a", "b"]);
  });

  test("forgetting a model nobody used is harmless", () => {
    forgetKeyTurns("never-used", new Set(["a"]));
    forgetKeyTurns("never-used");
    assert.deepEqual(ids(turnOrder("never-used", keys("a", "b"))), ["a", "b"]);
  });
});

describe("one pool per AI Model", () => {
  test("turns on one model never move another's", () => {
    const pool = keys("a", "b", "c");
    take("shared-by-three-employees", pool, 2);
    assert.deepEqual(take("another-model", pool, 1), ["a"]);
    assert.deepEqual(take("shared-by-three-employees", pool, 1), ["c"]);
  });
});
