import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimitError } from "../src/errors.js";
import { Throttle } from "../src/throttle.js";

const rule = { limit: 3, windowMs: 60_000, blockMs: 120_000 };

test("a bucket admits its limit, then refuses until the block ends", () => {
  let now = 1_000_000;
  const throttle = new Throttle(() => now);
  for (let attempt = 0; attempt < 3; attempt++) throttle.consume("a", rule);
  assert.throws(
    () => throttle.consume("a", rule),
    (error) => error instanceof RateLimitError && error.retryAfterSeconds === 120,
  );
  assert.throws(() => throttle.check("a"), RateLimitError);
  throttle.consume("b", rule);
  now += 60_000;
  assert.throws(
    () => throttle.consume("a", rule),
    RateLimitError,
    "the window ending does not lift a block",
  );
  now += 60_001;
  throttle.check("a");
  for (let attempt = 0; attempt < 3; attempt++) throttle.consume("a", rule);
});

test("a window resets the count when nothing was blocked", () => {
  let now = 0;
  const throttle = new Throttle(() => now);
  for (let attempt = 0; attempt < 3; attempt++) throttle.consume("a", rule);
  now += 60_000;
  for (let attempt = 0; attempt < 3; attempt++) throttle.consume("a", rule);
  assert.throws(() => throttle.consume("a", rule), RateLimitError);
});

test("recording a failure never throws, but shuts the bucket for the next attempt", () => {
  const throttle = new Throttle(() => 0);
  for (let attempt = 0; attempt < 5; attempt++) throttle.record("a", rule);
  assert.throws(() => throttle.check("a"), RateLimitError);
  throttle.check("b");
});

test("keys are hashed, swept once idle, and bounded under pressure", () => {
  let now = 0;
  const throttle = new Throttle(() => now, 10);
  const key = Throttle.key("google", "refresh-token", "1//refresh-token-secret");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(Throttle.key("a", "bc"), Throttle.key("ab", "c"));
  for (let index = 0; index < 50; index++) throttle.consume(`k${index}`, rule);
  assert.ok(throttle.size <= 11, `size ${throttle.size}`);
  throttle.record("blocked", { limit: 0, windowMs: 1_000, blockMs: 60 * 60_000 });
  now += 16 * 60_000;
  throttle.sweep();
  assert.equal(throttle.size, 1, "only the still-blocked bucket remains");
  assert.throws(() => throttle.check("blocked"), RateLimitError);
});
