import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AuthRateLimit } from "../db/entities/AuthRateLimit.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { AuthRateLimitError, consumeAuthAttempt } from "./authThrottle.js";

const settings = config.security.authRateLimit as {
  windowMinutes: number;
  maxAttempts: number;
  blockMinutes: number;
};
const originalSettings = { ...settings };

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  Object.assign(settings, originalSettings, {
    maxAttempts: 3,
    blockMinutes: 2,
  });
});
after(async () => {
  Object.assign(settings, originalSettings);
  await closeTestDb();
});

test("concurrent requests grant exactly the configured attempts for one bucket", async () => {
  const bucket = "concurrent-auth-bucket";
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => consumeAuthAttempt([bucket])),
  );

  const granted = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(granted.length, 3, "the Nth attempt must still be granted");
  assert.equal(rejected.length, 17);
  for (const result of rejected) {
    assert.ok(result.reason instanceof AuthRateLimitError);
    assert.ok(result.reason.retryAfterSeconds > 0);
  }

  const row = await AppDataSource.getRepository(AuthRateLimit).findOneByOrFail({ id: bucket });
  assert.equal(row.attempts, 3);
  assert.ok(row.blockedUntil);
  assert.ok(row.blockedUntil.getTime() > Date.now());

  await assert.rejects(consumeAuthAttempt([bucket]), AuthRateLimitError);
});
