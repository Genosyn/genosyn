import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { IntegrationRuntimeContext } from "../types.js";
import { githubProvider } from "./github.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function runtime(apiKey = "github-secret"): IntegrationRuntimeContext {
  return {
    authMode: "apikey",
    config: { apiKey },
    connectionId: "connection-1",
    companyId: "company-1",
    employeeId: "employee-1",
  };
}

function json(value: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub Integration list_issues", () => {
  test("uses issue defaults, encodes the repository path, authenticates, and removes pull requests", async () => {
    const issueOne = { id: 1, number: 11, title: "Real issue" };
    const issueTwo = { id: 2, number: 12, title: "Another issue" };
    const pullRequest = {
      id: 3,
      number: 13,
      title: "A pull request",
      pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/13" },
    };

    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.pathname, "/repos/acme%20labs/widgets%2Fapi/issues");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        per_page: "100",
        page: "1",
        state: "open",
      });
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);

      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer github-secret");
      assert.equal(headers.get("accept"), "application/vnd.github+json");
      assert.equal(headers.get("x-github-api-version"), "2022-11-28");
      assert.equal(headers.get("user-agent"), "genosyn");
      assert.equal(headers.get("content-type"), null);

      return json([issueOne, pullRequest, issueTwo]);
    }) as typeof fetch;

    const result = await githubProvider.invokeTool(
      "list_issues",
      { owner: " acme labs ", repo: " widgets/api " },
      runtime(),
    );

    assert.deepEqual(result, [issueOne, issueTwo]);
  });

  test("forwards encoded filters and applies logical issue pagination", async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        per_page: "100",
        page: String(page),
        state: "closed",
        labels: "bug,help wanted",
        assignee: "octo+bot",
        creator: "alice/bob",
        since: "2026-08-01T00:00:00Z",
      });
      return page === 1
        ? json(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })))
        : json([{ number: 101 }]);
    }) as typeof fetch;

    const result = await githubProvider.invokeTool(
      "list_issues",
      {
        owner: "acme",
        repo: "widgets",
        state: "closed",
        labels: "bug,help wanted",
        assignee: "octo+bot",
        creator: "alice/bob",
        since: "2026-08-01T00:00:00Z",
        per_page: 999,
        page: 2.9,
      },
      runtime(),
    );

    assert.deepEqual(
      (result as Array<{ number: number }>).map((issue) => issue.number),
      [101],
    );
  });

  test("continues past a pull-request-only API page to fill the logical issue page", async () => {
    const calls: number[] = [];
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      calls.push(page);
      if (page === 1) {
        return json(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            pull_request: { url: `https://api.github.com/pulls/${index + 1}` },
          })),
        );
      }
      return json([{ number: 101, title: "A real issue" }]);
    }) as typeof fetch;

    const result = await githubProvider.invokeTool(
      "list_issues",
      { owner: "acme", repo: "widgets" },
      runtime(),
    );

    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(result, [{ number: 101, title: "A real issue" }]);
  });

  test("treats every payload carrying GitHub's pull_request marker as a pull request", async () => {
    const issue = { id: 1, number: 1, title: "Issue" };
    globalThis.fetch = (async () =>
      json([
        issue,
        { id: 2, number: 2, pull_request: null },
        { id: 3, number: 3, pull_request: {} },
      ])) as typeof fetch;

    const result = await githubProvider.invokeTool(
      "list_issues",
      { owner: "acme", repo: "widgets" },
      runtime(),
    );

    assert.deepEqual(result, [issue]);
  });

  test("fails clearly when a successful GitHub response is not an array", async () => {
    globalThis.fetch = (async () => json({ message: "unexpected shape" })) as typeof fetch;

    await assert.rejects(
      githubProvider.invokeTool("list_issues", { owner: "acme", repo: "widgets" }, runtime()),
      /invalid response while listing issues \(expected an array\)/,
    );
  });

  test("propagates GitHub's structured API error", async () => {
    globalThis.fetch = (async () =>
      json(
        { message: "Resource not accessible by integration" },
        403,
        "Forbidden",
      )) as typeof fetch;

    await assert.rejects(
      githubProvider.invokeTool("list_issues", { owner: "acme", repo: "widgets" }, runtime()),
      { message: "Resource not accessible by integration" },
    );
  });

  test("reports status details when GitHub returns an unstructured error", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream unavailable", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;

    await assert.rejects(
      githubProvider.invokeTool("list_issues", { owner: "acme", repo: "widgets" }, runtime()),
      { message: "GitHub 502 Bad Gateway" },
    );
  });
});
