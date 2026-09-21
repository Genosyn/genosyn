import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { githubProvider } from "./github.js";
import { listGithubRepositoryActivity } from "./github-activity.js";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });
const repo = { owner: "acme", repo: "widgets" };
function event(id: string, created_at = "2026-09-20T12:00:00Z", type = "PushEvent", payload: unknown = {}) {
  return { id, type, created_at, actor: { login: "octocat" }, repo: { name: "acme/widgets" }, payload };
}
function json(data: unknown, link?: string) {
  return new Response(JSON.stringify(data), { headers: link ? { link } : {} });
}
function feed(ids: string[]) {
  globalThis.fetch = (async () => json(ids.map((id) => event(id)))) as typeof fetch;
}

describe("GitHub structured activity coverage", () => {
  test("uses the existing Connection token and keeps event detail bounded with source links", async () => {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-secret");
      assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2022-11-28");
      assert.equal(init?.method, "GET");
      return json([
        event("3", undefined, "PullRequestReviewEvent", {
          action: "submitted", pull_request: { number: 12, title: "Ship", html_url: "https://github.com/acme/widgets/pull/12", body: "x".repeat(100_000) },
          review: { id: 1, state: "approved", body: "x".repeat(100_000) },
        }),
        event("2", undefined, "PushEvent", { head: "abc", before: "def", ref: "refs/heads/main", commits: [{ message: "x".repeat(100_000) }] }),
      ]);
    }) as typeof fetch;
    const result = await githubProvider.invokeTool("list_repository_activity", repo, {
      authMode: "apikey", config: { apiKey: "github-secret" }, companyId: "co", connectionId: "conn",
    }) as Awaited<ReturnType<typeof listGithubRepositoryActivity>>;
    assert.equal(result.events[0].pull_request?.number, 12);
    assert.equal(result.events[0].review?.state, "approved");
    assert.equal(result.events[1].head, "abc");
    assert.ok(JSON.stringify(result).length < 5000);
    assert.deepEqual(result.eventIds, ["3", "2"]);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.snapshotComplete, true);
    assert.ok(result.checkpoint);
    assert.equal(result.coverage.maximumDelaySeconds, 21600);
  });

  test("resumes stable IDs despite newly prepended events and checkpoints delayed arrivals without duplicates", async () => {
    feed(["3", "2", "1"]);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
    assert.deepEqual(first.eventIds, ["3"]);
    assert.ok(first.nextCursor);
    feed(["4", "3", "2", "1"]);
    const second = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: first.nextCursor }, "token");
    assert.deepEqual(second.eventIds, ["2"]);
    const replay = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: first.nextCursor }, "token");
    assert.deepEqual(replay.eventIds, second.eventIds);
    const last = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: second.nextCursor }, "token");
    assert.deepEqual(last.eventIds, ["1"]);
    assert.ok(last.checkpoint);
    assert.equal(last.coverage.snapshotComplete, true);
    // A newly visible event can have an older timestamp/position than the checkpoint anchor.
    feed(["5", "4", "3", "2", "late", "1"]);
    const nextScan = await listGithubRepositoryActivity({ ...repo, checkpoint: last.checkpoint }, "token");
    assert.deepEqual(nextScan.eventIds, ["5", "4", "late"]);
    assert.equal(nextScan.coverage.checkpointStatus, "resumed");
    const unchanged = await listGithubRepositoryActivity({ ...repo, checkpoint: nextScan.checkpoint }, "token");
    assert.deepEqual(unchanged.eventIds, []);
    assert.ok(unchanged.checkpoint);
  });

  test("missing snapshot IDs and evicted checkpoint anchors report gaps without advancing progress", async () => {
    feed(["3", "2", "1"]);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 1 }, "token");
    feed(["3", "1"]);
    const missing = await listGithubRepositoryActivity({ ...repo, per_page: 1, cursor: first.nextCursor }, "token");
    assert.equal(missing.coverage.gap?.reason, "snapshot_events_missing");
    assert.deepEqual(missing.coverage.gap?.missingEventIds, ["2"]);
    assert.deepEqual(missing.events, []);
    assert.equal(missing.nextCursor, null);
    assert.equal(missing.checkpoint, null);
    feed(["3", "2", "1"]);
    const initial = await listGithubRepositoryActivity(repo, "token");
    feed(["6", "5", "4"]);
    const evicted = await listGithubRepositoryActivity({ ...repo, checkpoint: initial.checkpoint }, "token");
    assert.equal(evicted.coverage.gap?.reason, "checkpoint_anchor_missing");
    assert.equal(evicted.checkpoint, null);
  });

  test("resumes halfway through a batch from the last recorded processed event", async () => {
    feed(["4", "3", "2", "1"]);
    const batch = await listGithubRepositoryActivity({ ...repo, per_page: 2 }, "token");
    assert.deepEqual(batch.eventIds, ["4", "3"]);
    feed(["5", "4", "3", "2", "1"]);
    const resumed = await listGithubRepositoryActivity({ ...repo, per_page: 2, cursor: batch.resumeCursor, afterEventId: "4" }, "token");
    assert.deepEqual(resumed.eventIds, ["3", "2"]);
    assert.equal(resumed.coverage.processedBefore, 1);
    await assert.rejects(listGithubRepositoryActivity({ ...repo, per_page: 2, cursor: batch.resumeCursor, afterEventId: "1" }, "token"), /saved batch/);
  });

  test("an expired checkpoint reports retention loss even when its anchor is still present", async () => {
    feed(["1"]);
    const first = await listGithubRepositoryActivity(repo, "token");
    Date.now = () => originalNow() + 31 * 86_400_000;
    const expired = await listGithubRepositoryActivity({ ...repo, checkpoint: first.checkpoint }, "token");
    assert.equal(expired.coverage.gap?.reason, "checkpoint_expired");
    assert.deepEqual(expired.events, []);
  });

  test("an initially empty checkpoint cannot claim continuity when the feed reaches its retention cap", async () => {
    feed([]);
    const empty = await listGithubRepositoryActivity(repo, "token");
    globalThis.fetch = (async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return json(Array.from({ length: 100 }, (_, i) => event(String(300 - (page - 1) * 100 - i))),
        page < 3 ? `<https://api.github.com/repos/acme/widgets/events?per_page=100&page=${page + 1}>; rel="next"` : undefined);
    }) as typeof fetch;
    const capped = await listGithubRepositoryActivity({ ...repo, checkpoint: empty.checkpoint }, "token");
    assert.equal(capped.coverage.gap?.reason, "unanchored_feed_at_capacity");
    assert.equal(capped.coverage.retainedFeedAtCapacity, true);
    assert.equal(capped.checkpoint, null);
  });

  test("date filters bind a checkpoint's scope and empty feeds retain honest coverage", async () => {
    feed([]);
    const empty = await listGithubRepositoryActivity(repo, "token");
    assert.equal(empty.coverage.complete, false);
    assert.equal(empty.coverage.newestScannedAt, null);
    globalThis.fetch = (async () => json([event("1", "2026-09-19T12:00:00Z", "FutureEvent", { action: "published" })])) as typeof fetch;
    const args = { ...repo, since: "2026-09-19T00:00:00Z", until: "2026-09-20T00:00:00Z" };
    const first = await listGithubRepositoryActivity(args, "token");
    assert.equal(first.events[0].type, "FutureEvent");
    assert.equal(first.events[0].action, "published");
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json([]); }) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity({ ...repo, checkpoint: first.checkpoint }, "token"), /scope unchanged/);
    await assert.rejects(listGithubRepositoryActivity({ ...args, owner: "other", checkpoint: first.checkpoint }, "token"), /scope unchanged/);
    await assert.rejects(listGithubRepositoryActivity({ ...args, checkpoint: first.checkpoint }, "token", "other-connection"), /scope unchanged/);
    assert.equal(calls, 0);
  });

  test("restarts a scan if the feed shifts while collecting provider pages", async () => {
    let firstPageCalls = 0;
    globalThis.fetch = (async (input) => {
      const page = new URL(String(input)).searchParams.get("page");
      if (page === "2") return json([event("1")]);
      firstPageCalls += 1;
      return json((firstPageCalls === 1 ? ["3", "2"] : ["4", "3", "2"]).map((id) => event(id)),
        '<https://api.github.com/repos/acme/widgets/events?per_page=100&page=2>; rel="next"');
    }) as typeof fetch;
    const result = await listGithubRepositoryActivity(repo, "token");
    assert.deepEqual(result.eventIds, ["4", "3", "2", "1"]);
    assert.equal(firstPageCalls, 4);
    assert.equal(result.coverage.atomicProviderSnapshot, false);
  });

  test("rejects invalid arguments, untrusted continuation URLs and malformed provider data", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json([]); }) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity({ ...repo, owner: ".." }, "token"), /must not/);
    await assert.rejects(listGithubRepositoryActivity({ ...repo, since: "yesterday" }, "token"));
    await assert.rejects(listGithubRepositoryActivity({ ...repo, cursor: "bad" }, "token"), /Invalid GitHub activity continuation/);
    assert.equal(calls, 0);
    globalThis.fetch = (async () => json({ message: "unexpected" })) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /coverage could not be established/);
    globalThis.fetch = (async () => json([event("1", "invalid")])) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /coverage could not be established/);
    globalThis.fetch = (async () => json([], '<https://attacker.example/events?page=2>; rel="next"')) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /invalid activity continuation/);
  });
});
