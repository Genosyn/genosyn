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
function pagedFeed(ids: string[]) {
  const calls: number[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, "/repos/acme/widgets/events");
    assert.equal(url.searchParams.get("per_page"), "100");
    const page = Number(url.searchParams.get("page"));
    calls.push(page);
    return json(ids.slice((page - 1) * 100, page * 100).map((id) => event(id)),
      page * 100 < ids.length
        ? `<https://api.github.com/repositories/380744866/events?per_page=100&page=${page + 1}>; rel="next"`
        : undefined);
  }) as typeof fetch;
  return calls;
}

describe("GitHub structured activity coverage", () => {
  test("accepts GitHub's numeric repository pagination and resumes all 300 retained events", async () => {
    const input = { owner: "OneUptime", repo: "oneuptime", per_page: 100 };
    const calls: number[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      // GitHub's Link is canonicalized to /repositories/<id>/events, even
      // though the caller used /repos/<owner>/<repo>/events. The numeric URL
      // supplies only the next page number; credentials stay on our own path.
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.pathname, "/repos/OneUptime/oneuptime/events");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-secret");
      const page = Number(url.searchParams.get("page"));
      calls.push(page);
      return json(Array.from({ length: 100 }, (_, i) => event(String(300 - (page - 1) * 100 - i))),
        page < 3
          ? `<https://api.github.com/repositories/380744866/events?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/repositories/380744866/events?per_page=100&page=3>; rel="last"`
          : '<https://api.github.com/repositories/380744866/events?per_page=100&page=2>; rel="prev"');
    }) as typeof fetch;

    const first = await listGithubRepositoryActivity(input, "github-secret", "connection");
    assert.deepEqual(first.eventIds, Array.from({ length: 100 }, (_, i) => String(300 - i)));
    assert.deepEqual(calls, [1, 2, 3, 1]);
    assert.equal(first.coverage.scanned, 300);
    assert.equal(first.coverage.retainedFeedAtCapacity, true);
    assert.equal(first.coverage.complete, false);
    assert.equal(first.coverage.snapshotComplete, false);
    assert.ok(first.nextCursor);
    assert.equal(first.checkpoint, null);

    const second = await listGithubRepositoryActivity({ ...input, cursor: first.nextCursor }, "github-secret", "connection");
    assert.deepEqual(second.eventIds, Array.from({ length: 100 }, (_, i) => String(200 - i)));
    assert.equal(second.coverage.processedBefore, 100);
    assert.ok(second.nextCursor);
    const last = await listGithubRepositoryActivity({ ...input, cursor: second.nextCursor }, "github-secret", "connection");
    assert.deepEqual(last.eventIds, Array.from({ length: 100 }, (_, i) => String(100 - i)));
    assert.equal(last.nextCursor, null);
    assert.ok(last.checkpoint);
    assert.equal(last.coverage.snapshotComplete, true);
    assert.equal(last.coverage.complete, false);
    const checkpoint = await listGithubRepositoryActivity({ ...input, checkpoint: last.checkpoint }, "github-secret", "connection");
    assert.deepEqual(checkpoint.eventIds, []);
    assert.equal(checkpoint.coverage.checkpointStatus, "resumed");
    assert.equal(checkpoint.coverage.complete, false);
    assert.deepEqual(calls, Array.from({ length: 4 }, () => [1, 2, 3, 1]).flat());
  });

  test("keeps caller batch size independent of canonical provider pages and resumes a partial batch", async () => {
    const ids = Array.from({ length: 203 }, (_, i) => String(203 - i));
    const calls = pagedFeed(ids);
    const input = { ...repo, per_page: 73 };
    const first = await listGithubRepositoryActivity(input, "token");
    assert.deepEqual(first.eventIds, ids.slice(0, 73));
    assert.equal(first.coverage.scanned, 203);
    assert.equal(first.coverage.retainedFeedAtCapacity, false);
    const partial = await listGithubRepositoryActivity({
      ...input, cursor: first.resumeCursor, afterEventId: ids[27],
    }, "token");
    assert.deepEqual(partial.eventIds, ids.slice(28, 101));
    assert.equal(partial.coverage.processedBefore, 28);
    assert.ok(partial.nextCursor);
    const second = await listGithubRepositoryActivity({ ...input, cursor: first.nextCursor }, "token");
    const replay = await listGithubRepositoryActivity({ ...input, cursor: first.nextCursor }, "token");
    assert.deepEqual(second.eventIds, ids.slice(73, 146));
    assert.deepEqual(replay.eventIds, second.eventIds);
    const last = await listGithubRepositoryActivity({ ...input, cursor: second.nextCursor }, "token");
    assert.deepEqual(last.eventIds, ids.slice(146));
    assert.equal(last.coverage.snapshotComplete, true);
    assert.equal(last.nextCursor, null);
    assert.ok(last.checkpoint);
    assert.deepEqual(calls, Array.from({ length: 5 }, () => [1, 2, 3, 1]).flat());
  });

  test("canonical pagination does not claim recovery of older historical activity", async () => {
    const calls = pagedFeed(Array.from({ length: 300 }, (_, i) => String(300 - i)));
    const result = await listGithubRepositoryActivity({
      ...repo, since: "2026-09-08T00:00:00Z", until: "2026-09-19T00:00:00Z",
    }, "token");
    assert.deepEqual(calls, [1, 2, 3, 1]);
    assert.deepEqual(result.eventIds, []);
    assert.equal(result.coverage.scanned, 300);
    assert.equal(result.coverage.snapshotComplete, true);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.retainedFeedAtCapacity, true);
    assert.equal(result.coverage.oldestScannedAt, "2026-09-20T12:00:00.000Z");
    assert.deepEqual(result.coverage.filters, {
      since: "2026-09-08T00:00:00Z", until: "2026-09-19T00:00:00Z",
    });
    assert.ok(result.checkpoint);
  });

  test("an evicted event in a canonical feed remains a gap instead of advancing the saved cursor", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => String(300 - i));
    pagedFeed(ids);
    const first = await listGithubRepositoryActivity({ ...repo, per_page: 100 }, "token");
    pagedFeed(["301", ...ids.slice(0, -1)]);
    const missing = await listGithubRepositoryActivity({ ...repo, per_page: 100, cursor: first.nextCursor }, "token");
    assert.equal(missing.coverage.gap?.reason, "snapshot_events_missing");
    assert.deepEqual(missing.coverage.gap?.missingEventIds, ["1"]);
    assert.deepEqual(missing.eventIds, []);
    assert.equal(missing.resumeCursor, null);
    assert.equal(missing.nextCursor, null);
    assert.equal(missing.checkpoint, null);
  });

  test("uses only the canonical Link's page number and never forwards its path or other parameters", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
      if (url === "https://api.github.com/repos/acme/widgets/events?per_page=100&page=2") {
        return json([event("1")]);
      }
      assert.equal(url, "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1");
      return json([event("2")], '<https://api.github.com/repositories/999/events?per_page=1&page=2&redirect=https%3A%2F%2Fattacker.example&access_token=untrusted>; rel="next"');
    }) as typeof fetch;
    const result = await listGithubRepositoryActivity(repo, "secret");
    assert.deepEqual(result.eventIds, ["2", "1"]);
    assert.deepEqual(calls, [
      "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1",
      "https://api.github.com/repos/acme/widgets/events?per_page=100&page=2",
      "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1",
    ]);
  });

  const invalidLinks = [
    ["foreign host", "https://attacker.example/repositories/380744866/events?per_page=100&page=2"],
    ["lookalike host", "https://api.github.com.attacker.example/repositories/380744866/events?per_page=100&page=2"],
    ["plain HTTP", "http://api.github.com/repositories/380744866/events?per_page=100&page=2"],
    ["different port", "https://api.github.com:444/repositories/380744866/events?per_page=100&page=2"],
    ["different named repository", "https://api.github.com/repos/acme/other/events?per_page=100&page=2"],
    ["different repository owner", "https://api.github.com/repos/other/widgets/events?per_page=100&page=2"],
    ["different resource", "https://api.github.com/repositories/380744866/issues?per_page=100&page=2"],
    ["missing repository ID", "https://api.github.com/repositories//events?per_page=100&page=2"],
    ["nonnumeric repository ID", "https://api.github.com/repositories/other/events?per_page=100&page=2"],
    ["negative repository ID", "https://api.github.com/repositories/-1/events?per_page=100&page=2"],
    ["extra route segment", "https://api.github.com/repositories/380744866/events/other?per_page=100&page=2"],
    ["encoded path separator", "https://api.github.com/repositories/380744866%2Fevents?per_page=100&page=2"],
    ["repeated page", "https://api.github.com/repositories/380744866/events?per_page=100&page=1"],
    ["skipped page", "https://api.github.com/repositories/380744866/events?per_page=100&page=3"],
    ["page past retention bound", "https://api.github.com/repositories/380744866/events?per_page=100&page=4"],
    ["fractional page", "https://api.github.com/repositories/380744866/events?per_page=100&page=2.5"],
    ["nonnumeric page", "https://api.github.com/repositories/380744866/events?per_page=100&page=second"],
    ["missing page", "https://api.github.com/repositories/380744866/events?per_page=100"],
  ];
  for (const [reason, target] of invalidLinks) {
    test(`rejects ${reason} in a canonical continuation before making another request`, async () => {
      let calls = 0;
      globalThis.fetch = (async (input, init) => {
        calls += 1;
        assert.equal(String(input), "https://api.github.com/repos/acme/widgets/events?per_page=100&page=1");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
        return json([event("1")], `<${target}>; rel="next"`);
      }) as typeof fetch;
      await assert.rejects(listGithubRepositoryActivity(repo, "secret"), /invalid activity continuation/);
      assert.equal(calls, 1);
    });
  }

  test("refuses a fourth provider page without acknowledging any of the collected activity", async () => {
    const calls = pagedFeed(Array.from({ length: 400 }, (_, i) => String(400 - i)));
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /invalid activity continuation/);
    assert.deepEqual(calls, [1, 2, 3]);
  });

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
