import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  compareAndSetAuthFlowState,
  consumeAuthFlowStateSnapshot,
  createAuthFlowState,
  readAuthFlowState,
} from "./authFlowState.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

test("snapshots allow verification before an atomic consume without exposing plaintext storage", async () => {
  const token = await createAuthFlowState("proof", { secret: "private-refresh-token" }, 60_000);
  const snapshot = await readAuthFlowState<{ secret: string }>("proof", token);
  assert.ok(snapshot);
  assert.equal(snapshot.payload.secret, "private-refresh-token");
  const raw = JSON.stringify(await AppDataSource.getRepository(AuthFlowState).find());
  assert.equal(raw.includes("private-refresh-token"), false);
  assert.equal(raw.includes(token), false);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => consumeAuthFlowStateSnapshot("proof", token, snapshot)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await readAuthFlowState("proof", token), null);
});

test("compare-and-set rejects stale revisions, wrong kinds, and preserves the original expiry", async () => {
  const token = await createAuthFlowState("proof", { status: "pending" }, 60_000);
  const initial = await readAuthFlowState<{ status: string }>("proof", token);
  assert.ok(initial);
  assert.equal(
    await compareAndSetAuthFlowState("other", token, initial, { status: "complete" }),
    false,
  );
  assert.equal(
    await compareAndSetAuthFlowState("proof", token, initial, { status: "complete" }),
    true,
  );
  assert.equal(
    await compareAndSetAuthFlowState("proof", token, initial, { status: "stale" }),
    false,
  );
  assert.equal(await consumeAuthFlowStateSnapshot("proof", token, initial), null);
  const latest = await readAuthFlowState<{ status: string }>("proof", token);
  assert.equal(latest?.payload.status, "complete");
  assert.equal(latest?.expiresAt, initial.expiresAt);
});

test("an expired snapshot cannot be changed or consumed", async () => {
  const token = await createAuthFlowState("proof", { secret: "token" }, 60_000);
  const snapshot = await readAuthFlowState<{ secret: string }>("proof", token);
  assert.ok(snapshot);
  await AppDataSource.getRepository(AuthFlowState).update(
    { kind: "proof" },
    { expiresAt: new Date(0) },
  );
  assert.equal(await readAuthFlowState("proof", token), null);
  assert.equal(
    await compareAndSetAuthFlowState("proof", token, snapshot, { secret: "other" }),
    false,
  );
  assert.equal(await consumeAuthFlowStateSnapshot("proof", token, snapshot), null);
});
