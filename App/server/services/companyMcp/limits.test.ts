import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  acquireSlot,
  callsInFlight,
  EMBED_BUDGET_BYTES,
  enterRequest,
  MAX_CALLS_IN_FLIGHT,
  MAX_REQUESTS_IN_FLIGHT,
  newEmbedBudget,
  requestsInFlight,
  SlotTimeoutError,
} from "./limits.js";

/** How much of the process one Member may hold through the MCP server at once. */

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("slots per key", () => {
  test("a key runs a few calls at once; the next waits until one finishes", async () => {
    const key = "key-a";
    const releases = await Promise.all(
      Array.from({ length: MAX_CALLS_IN_FLIGHT }, () => acquireSlot(key)),
    );
    assert.equal(callsInFlight(key), MAX_CALLS_IN_FLIGHT);
    let admitted = false;
    const waiting = acquireSlot(key).then((release) => {
      admitted = true;
      return release;
    });
    await tick();
    assert.equal(admitted, false, "the fifth call waits");
    releases[0]();
    const fifth = await waiting;
    assert.equal(admitted, true);
    assert.equal(callsInFlight(key), MAX_CALLS_IN_FLIGHT, "the slot passed straight on");
    for (const release of [...releases.slice(1), fifth]) release();
    assert.equal(callsInFlight(key), 0);
  });

  test("waiting callers are let in in the order they came", async () => {
    const key = "key-order";
    const held = await Promise.all(
      Array.from({ length: MAX_CALLS_IN_FLIGHT }, () => acquireSlot(key)),
    );
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      acquireSlot(key).then((release) => {
        order.push(n);
        return release;
      }),
    );
    for (const release of held.slice(0, 3)) release();
    const admitted = await Promise.all(waiters);
    assert.deepEqual(order, [1, 2, 3]);
    for (const release of [held[3], ...admitted]) release();
    assert.equal(callsInFlight(key), 0);
  });

  test("keys do not share slots", async () => {
    const releases = await Promise.all(
      Array.from({ length: MAX_CALLS_IN_FLIGHT }, () => acquireSlot("key-full")),
    );
    const other = await acquireSlot("key-other");
    assert.equal(callsInFlight("key-other"), 1);
    other();
    for (const release of releases) release();
  });

  test("a caller that waits too long gives up, and takes no slot", async () => {
    const key = "key-timeout";
    const releases = await Promise.all(
      Array.from({ length: MAX_CALLS_IN_FLIGHT }, () => acquireSlot(key)),
    );
    await assert.rejects(acquireSlot(key, { waitMs: 20 }), (error: Error) => {
      assert.ok(error instanceof SlotTimeoutError);
      assert.match(error.message, /This Member already has 4 calls running/);
      return true;
    });
    for (const release of releases) release();
    assert.equal(callsInFlight(key), 0, "the gone waiter was not handed a slot");
  });

  test("a cancelled wait stops waiting", async () => {
    const key = "key-abort";
    const releases = await Promise.all(
      Array.from({ length: MAX_CALLS_IN_FLIGHT }, () => acquireSlot(key)),
    );
    const controller = new AbortController();
    const waiting = acquireSlot(key, { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, /cancelled while waiting/);
    for (const release of releases) release();
    assert.equal(callsInFlight(key), 0);
  });

  test("releasing twice frees one slot, not two", async () => {
    const key = "key-twice";
    const release = await acquireSlot(key);
    const other = await acquireSlot(key);
    release();
    release();
    assert.equal(callsInFlight(key), 1);
    other();
    assert.equal(callsInFlight(key), 0);
  });
});

describe("open requests per Member", () => {
  test("a few at once; one more is refused, never queued", () => {
    const member = "member-requests";
    const leaves = Array.from({ length: MAX_REQUESTS_IN_FLIGHT }, () => enterRequest(member));
    assert.ok(leaves.every((leave) => leave !== null));
    assert.equal(requestsInFlight(member), MAX_REQUESTS_IN_FLIGHT);
    assert.equal(enterRequest(member), null);
    assert.ok(enterRequest("someone-else"), "another Member is not affected");
    leaves[0]!();
    leaves[0]!();
    assert.equal(requestsInFlight(member), MAX_REQUESTS_IN_FLIGHT - 1, "leaving twice counts once");
    const again = enterRequest(member);
    assert.ok(again);
    for (const leave of [...leaves.slice(1), again]) leave!();
    assert.equal(requestsInFlight(member), 0);
  });
});

describe("the embedding budget", () => {
  test("each request starts with its own", () => {
    const first = newEmbedBudget();
    first.remaining -= 1000;
    assert.equal(newEmbedBudget().remaining, EMBED_BUDGET_BYTES);
    assert.equal(first.remaining, EMBED_BUDGET_BYTES - 1000);
  });
});
