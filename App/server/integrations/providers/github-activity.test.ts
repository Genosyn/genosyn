import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { githubProvider } from "./github.js";
import { listGithubRepositoryActivity } from "./github-activity.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const repo = { owner: "acme", repo: "widgets" };
function event(id: string, created_at: string, type = "PushEvent", payload: unknown = {}) {
  return { id, type, created_at, actor: { login: "octocat" }, repo: { name: "acme/widgets" }, payload };
}
function json(data: unknown, link?: string) {
  return new Response(JSON.stringify(data), { headers: link ? { link } : {} });
}

describe("GitHub structured activity coverage", () => {
  test("uses the existing Connection token and keeps event detail bounded with source links", async () => {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), "https://api.github.com/repos/acme/widgets/events?per_page=30&page=1");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-secret");
      assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2022-11-28");
      assert.equal(init?.method, "GET");
      return json([
        event("1", "2026-09-20T12:00:00Z", "PullRequestReviewEvent", {
          action: "submitted", pull_request: { number: 12, title: "Ship", html_url: "https://github.com/acme/widgets/pull/12", body: "x".repeat(100_000) },
          review: { id: 1, state: "approved", body: "x".repeat(100_000) },
        }),
        event("2", "2026-09-20T11:00:00Z", "PushEvent", { head: "abc", before: "def", ref: "refs/heads/main", commits: [{ message: "x".repeat(100_000) }] }),
      ]);
    }) as typeof fetch;
    const result = await githubProvider.invokeTool("list_repository_activity", repo, {
      authMode: "apikey", config: { apiKey: "github-secret" }, companyId: "co", connectionId: "conn",
    }) as Awaited<ReturnType<typeof listGithubRepositoryActivity>>;
    assert.equal(result.events[0].pull_request?.number, 12);
    assert.equal(result.events[0].review?.state, "approved");
    assert.equal(result.events[1].head, "abc");
    assert.ok(JSON.stringify(result).length < 3000);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.reachedFeedEnd, true);
    assert.equal(result.coverage.retentionDays, 30);
    assert.equal(result.coverage.maximumDelaySeconds, 21600);
  });

  test("a date-filtered empty page still exposes the next provider page", async () => {
    const pages: string[] = [];
    globalThis.fetch = (async (url) => {
      const page = new URL(String(url)).searchParams.get("page")!;
      pages.push(page);
      return page === "1"
        ? json([event("1", "2026-09-21T12:00:00Z")], '<https://api.github.com/repos/acme/widgets/events?per_page=1&page=2>; rel="next", <https://api.github.com/repos/acme/widgets/events?per_page=1&page=3>; rel="last"')
        : json([event("2", "2026-09-20T12:00:00Z")]);
    }) as typeof fetch;
    const args = { ...repo, per_page: 1, since: "2026-09-20T00:00:00Z", until: "2026-09-21T00:00:00Z" };
    const first = await listGithubRepositoryActivity(args, "token");
    assert.equal(first.events.length, 0);
    assert.equal(first.coverage.scanned, 1);
    assert.equal(first.nextPage, 2);
    assert.equal(first.coverage.reachedFeedEnd, false);
    const second = await listGithubRepositoryActivity({ ...args, page: first.nextPage }, "token");
    assert.equal(second.events.length, 1);
    assert.equal(second.coverage.complete, false);
    assert.deepEqual(pages, ["1", "2"]);
  });

  test("empty feeds and unknown event types retain honest coverage", async () => {
    globalThis.fetch = (async () => json([])) as typeof fetch;
    const empty = await listGithubRepositoryActivity(repo, "token");
    assert.equal(empty.coverage.complete, false);
    assert.equal(empty.coverage.newestScannedAt, null);
    globalThis.fetch = (async () => json([event("1", "2026-09-19T12:00:00Z", "FutureEvent", { action: "published" })])) as typeof fetch;
    const unknown = await listGithubRepositoryActivity({ ...repo, since: "2026-09-19T00:00:00Z" }, "token");
    assert.equal(unknown.events[0].type, "FutureEvent");
    assert.equal(unknown.events[0].action, "published");
    assert.equal(unknown.coverage.maximumEvents, 300);
  });

  test("rejects invalid windows and path traversal before any provider call", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return json([]); }) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity({ ...repo, owner: ".." }, "token"), /must not/);
    await assert.rejects(listGithubRepositoryActivity({ ...repo, per_page: 100, page: 4 }, "token"), /300 events/);
    await assert.rejects(listGithubRepositoryActivity({ ...repo, since: "yesterday" }, "token"));
    await assert.rejects(listGithubRepositoryActivity({ ...repo, since: "2026-09-21T00:00:00Z", until: "2026-09-20T00:00:00Z" }, "token"), /earlier/);
    assert.equal(calls, 0);
  });

  test("rejects malformed pages and does not follow arbitrary continuation URLs", async () => {
    globalThis.fetch = (async () => json({ message: "unexpected" })) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /coverage could not be established/);
    globalThis.fetch = (async () => json([event("1", "invalid")])) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /coverage could not be established/);
    globalThis.fetch = (async () => json([], '<https://attacker.example/events?page=2>; rel="next"')) as typeof fetch;
    await assert.rejects(listGithubRepositoryActivity(repo, "token"), /invalid activity continuation/);
  });
});
