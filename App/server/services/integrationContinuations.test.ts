import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { IntegrationContinuation } from "../db/entities/IntegrationContinuation.js";
import { listGithubRepositoryActivity } from "../integrations/providers/github-activity.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  CONTINUATION_RETENTION_MS,
  continuationStore,
  databaseContinuationStore,
} from "./integrationContinuations.js";

const originalFetch = globalThis.fetch;
before(initTestDb);
beforeEach(resetTestDb);
after(async () => {
  globalThis.fetch = originalFetch;
  await closeTestDb();
});

const rows = () => AppDataSource.getRepository(IntegrationContinuation);

test("the database keeps each value once and prunes those past every expiry", async () => {
  await rows().insert({ id: "gha3.old", connectionId: "conn", token: "stale" });
  await rows().update({ id: "gha3.old" }, { createdAt: new Date(Date.now() - CONTINUATION_RETENTION_MS - 60_000) });
  await databaseContinuationStore.save("gha3.new", "value", "conn");
  await databaseContinuationStore.save("gha3.new", "value", "conn");
  assert.equal(await databaseContinuationStore.load("gha3.new"), "value");
  assert.equal(await databaseContinuationStore.load("gha3.missing"), null);
  assert.equal(await rows().count(), 1, "one row per value; the stale one is gone");
  assert.equal(continuationStore(), databaseContinuationStore, "the open database is the store");
});

// 2026-10-03: a self-hosted model copied a 300-ID cursor wrong after a dozen
// pages. A short reference has to survive the hand-off to a fresh Run and an
// App restart, so it lives in the database.
test("a GitHub activity scan resumes from a short reference stored in the database", async () => {
  const feed = ["3", "2", "1"].map((id) => ({
    id, type: "PushEvent", created_at: "2026-09-20T12:00:00Z",
    actor: { login: "octocat" }, repo: { name: "acme/widgets" }, payload: {},
  }));
  globalThis.fetch = (async () => new Response(JSON.stringify(feed))) as typeof fetch;
  const args = { owner: "acme", repo: "widgets", per_page: 1 };
  const first = await listGithubRepositoryActivity(args, "token", "conn");
  assert.match(first.nextCursor!, /^gha3\.[a-f0-9]{20}$/);
  const stored = await rows().findOneByOrFail({ id: first.nextCursor! });
  assert.equal(stored.connectionId, "conn");
  assert.match(stored.token, /^gha2\./);
  const second = await listGithubRepositoryActivity({ ...args, cursor: first.nextCursor }, "token", "conn");
  assert.deepEqual(second.eventIds, ["2"]);
});
