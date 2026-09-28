import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  bootAuthFlowStateSweeper,
  purgeExpiredAuthFlowStates,
  stopAuthFlowStateSweeper,
} from "./authFlowCleanup.js";

before(initTestDb);
beforeEach(resetTestDb);
afterEach(() => {
  stopAuthFlowStateSweeper();
  mock.restoreAll();
  mock.timers.reset();
});
after(closeTestDb);

async function insertFlow(kind: string, expiresAt: number): Promise<AuthFlowState> {
  const repo = AppDataSource.getRepository(AuthFlowState);
  return repo.save(repo.create({
    kind,
    tokenHash: randomUUID(),
    payloadEncrypted: "opaque encrypted handoff",
    expiresAt: new Date(expiresAt),
  }));
}

test("purging expired handoffs preserves every still-valid authentication flow", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  await insertFlow("hosted-google-sign-in", Date.now() - 1);
  await insertFlow("hosted-google-consumer", Date.now());
  await insertFlow("integration-oauth", Date.now() - 1);
  const valid = await insertFlow("hosted-google-sign-in", Date.now() + 1);

  assert.equal(await purgeExpiredAuthFlowStates(), 3);
  const remaining = await AppDataSource.getRepository(AuthFlowState).find();
  assert.deepEqual(remaining.map((row) => row.id), [valid.id]);
  assert.equal(remaining[0].payloadEncrypted, "opaque encrypted handoff");
});

test("startup and the idle minute sweep delete abandoned handoffs without a new sign-in", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
  await insertFlow("hosted-google-sign-in", Date.now() - 1);
  await bootAuthFlowStateSweeper();
  const repo = AppDataSource.getRepository(AuthFlowState);
  assert.equal(await repo.count(), 0);

  await insertFlow("hosted-google-sign-in", Date.now() + 1000);
  const valid = await insertFlow("integration-oauth", Date.now() + 120_000);
  // Starting the lifecycle twice must not add another interval.
  await bootAuthFlowStateSweeper();
  mock.timers.tick(59_999);
  await setImmediate();
  assert.equal(await repo.count(), 2);
  mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual((await repo.find()).map((row) => row.id), [valid.id]);
});

test("an interval failure logs no credential material and retries on the next minute", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
  await bootAuthFlowStateSweeper();
  await insertFlow("hosted-google-sign-in", Date.now() + 1);
  const repo = AppDataSource.getRepository(AuthFlowState);
  const deleted = mock.method(repo, "delete", async () => {
    throw new Error("sensitive database payload");
  });
  const warning = mock.method(console, "warn", () => undefined);

  mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(await repo.count(), 1);
  assert.equal(warning.mock.callCount(), 1);
  assert.doesNotMatch(String(warning.mock.calls[0].arguments[0]), /sensitive database payload/);

  deleted.mock.restore();
  mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(await repo.count(), 0);
});
