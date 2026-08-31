import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, before, describe, test } from "node:test";
import type { IntegrationConfig, IntegrationRuntimeContext } from "../types.js";
import type { GithubAppConfig } from "./github-app.js";
import type { GithubOauthConfig } from "./github-oauth.js";
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

  test("returns an empty page rather than failing when the repository has no issues", async () => {
    const pages: number[] = [];
    globalThis.fetch = (async (input) => {
      pages.push(Number(new URL(String(input)).searchParams.get("page")));
      return json([]);
    }) as typeof fetch;

    const result = await githubProvider.invokeTool(
      "list_issues",
      { owner: "acme", repo: "widgets" },
      runtime(),
    );

    assert.deepEqual(result, []);
    // A short page ends the scan. An empty repository costing ten round trips
    // is how a rate limit gets spent on nothing.
    assert.deepEqual(pages, [1]);
  });

  test("stops scanning after ten API pages so a pull-request-only repo cannot fan out", async () => {
    const pages: number[] = [];
    globalThis.fetch = (async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      pages.push(page);
      return json(
        Array.from({ length: 100 }, (_, index) => ({
          number: (page - 1) * 100 + index + 1,
          pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/1" },
        })),
      );
    }) as typeof fetch;

    const result = await githubProvider.invokeTool(
      "list_issues",
      { owner: "acme", repo: "widgets" },
      runtime(),
    );

    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(result, []);
  });
});

// ─────────────────────────── regression helpers ────────────────────────────
//
// Everything below pins the GitHub half of the shared `forge/` layer. GitHub
// and Forgejo now run the same code with a flavor flag, so each of these
// asserts the branch a `flavor === "github"` check is supposed to take: the
// Bearer scheme rather than `token`, `per_page` rather than `limit`, label
// names rather than resolved ids. A flipped flag is silent otherwise —
// the call still goes out, it just goes out wrong.

/** One recorded outbound request, parsed the way an assertion wants it. */
type ForgeCall = {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
};

/**
 * Record every outbound request and answer all of them with `payload`.
 *
 * The returned array is the assertion target, and its length matters as much
 * as its contents: the shared layer gained a `/labels` lookup for Forgejo's
 * create-issue and a branch-pair lookup for its pull-request list, and GitHub
 * must pay for neither.
 */
function captureCalls(payload: unknown = []): ForgeCall[] {
  const calls: ForgeCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const raw = init?.body;
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    });
    return json(payload);
  }) as typeof fetch;
  return calls;
}

/** A fetch stub that fails the test if it is ever reached. */
function refuseNetwork(): () => boolean {
  let reached = false;
  globalThis.fetch = (async () => {
    reached = true;
    return json({});
  }) as typeof fetch;
  return () => reached;
}

function only(calls: ForgeCall[]): ForgeCall {
  assert.equal(calls.length, 1, `expected exactly one request, saw ${calls.length}`);
  return calls[0];
}

function query(call: ForgeCall): Record<string, string> {
  return Object.fromEntries(call.url.searchParams);
}

function toolProperties(name: string): Record<string, unknown> {
  const tool = githubProvider.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`GitHub no longer exposes a tool called "${name}"`);
  return tool.inputSchema.properties;
}

function validateApiKey(input: Record<string, string>) {
  const validate = githubProvider.validateApiKey;
  if (!validate) {
    throw new Error("GitHub no longer validates a pasted token — API-key connect depends on it.");
  }
  return validate.call(githubProvider, input);
}

function checkStatus(ctx: IntegrationRuntimeContext) {
  const check = githubProvider.checkStatus;
  if (!check) throw new Error("GitHub no longer reports connection status.");
  return check.call(githubProvider, ctx);
}

function oauthRuntime(
  overrides: Partial<GithubOauthConfig>,
  saved: IntegrationConfig[],
): IntegrationRuntimeContext {
  const cfg: GithubOauthConfig = {
    clientId: "client-id",
    clientSecret: "client-secret",
    accessToken: "gho_token",
    refreshToken: "",
    expiresAt: 0,
    scope: "repo read:user",
    login: "octocat",
    userId: 1,
    repos: [],
    ...overrides,
  };
  return {
    authMode: "oauth2",
    config: cfg as unknown as IntegrationConfig,
    setConfig: (next) => {
      saved.push(next);
    },
    connectionId: "connection-1",
    companyId: "company-1",
    employeeId: "employee-1",
  };
}

function appRuntime(
  overrides: Partial<GithubAppConfig>,
  saved: IntegrationConfig[],
): IntegrationRuntimeContext {
  const cfg: GithubAppConfig = {
    appId: "12345",
    privateKey: "not-a-pem",
    installationId: "99",
    ...overrides,
  };
  return {
    authMode: "github_app",
    config: cfg as unknown as IntegrationConfig,
    setConfig: (next) => {
      saved.push(next);
    },
    connectionId: "connection-1",
    companyId: "company-1",
    employeeId: "employee-1",
  };
}

const ACME = { owner: "acme", repo: "widgets" };

/**
 * The GitHub tool surface named rather than counted.
 *
 * Every Skill and Soul in a customer's install is written against these names,
 * and the list is now assembled behind a flavor flag — one mistyped check and
 * a tool disappears from the model's menu with nothing failing. A length
 * assertion would survive a rename; this one will not.
 */
const EXPECTED_GITHUB_TOOL_NAMES = [
  "get_authenticated_user",
  "list_repos",
  "get_repo",
  "search_repos",
  "get_file_contents",
  "list_issues",
  "get_issue",
  "create_issue",
  "add_issue_comment",
  "list_pull_requests",
  "get_pull_request",
  "create_pull_request",
  "list_commits",
  "search_code",
];

describe("GitHub Integration tool surface", () => {
  test("exposes exactly the tools it exposed before the shared forge refactor", () => {
    const names = githubProvider.tools.map((tool) => tool.name);
    assert.deepEqual([...names].sort(), [...EXPECTED_GITHUB_TOOL_NAMES].sort());
    assert.equal(new Set(names).size, names.length);
  });

  test("keeps the arguments GitHub has and Forgejo does not", () => {
    // Each of these sits behind a `github ?` branch in forge/tools.ts. Losing
    // one costs the model a filter the description still promises it.
    for (const key of ["visibility", "affiliation", "sort", "direction"]) {
      assert.ok(key in toolProperties("list_repos"), `list_repos lost ${key}`);
    }
    for (const key of ["sort", "direction"]) {
      assert.ok(key in toolProperties("list_pull_requests"), `list_pull_requests lost ${key}`);
    }
    for (const key of ["draft", "maintainer_can_modify"]) {
      assert.ok(key in toolProperties("create_pull_request"), `create_pull_request lost ${key}`);
    }
    for (const key of ["author", "since", "until"]) {
      assert.ok(key in toolProperties("list_commits"), `list_commits lost ${key}`);
    }
    assert.ok("q" in toolProperties("search_code"));
  });

  test("offers GitHub's repository-search vocabulary, not Forgejo's", () => {
    // Forgejo sorts by alpha/created/updated/size/stars/forks/id. Handing a
    // GitHub model that enum would have it send values GitHub rejects.
    const sort = toolProperties("search_repos").sort as { enum: string[] };
    assert.deepEqual(sort.enum, ["stars", "forks", "help-wanted-issues", "updated"]);
  });

  test("advertises per_page on every paginated tool and never Forgejo's limit", () => {
    for (const name of [
      "list_repos",
      "search_repos",
      "list_issues",
      "list_pull_requests",
      "list_commits",
      "search_code",
    ]) {
      const properties = toolProperties(name);
      assert.ok("per_page" in properties, `${name} lost its per_page argument`);
      assert.ok("page" in properties, `${name} lost its page argument`);
      assert.ok(!("limit" in properties), `${name} offers a GitHub model Forgejo's limit`);
    }
  });
});

describe("GitHub Integration transport", () => {
  test("sends the bearer token, the pinned media type and API version, and nothing else", async () => {
    const calls = captureCalls({ login: "octocat" });

    const result = await githubProvider.invokeTool(
      "get_authenticated_user",
      {},
      runtime("ghp_live"),
    );

    const call = only(calls);
    assert.equal(call.url.href, "https://api.github.com/user");
    assert.equal(call.method, "GET");
    assert.equal(call.headers.get("authorization"), "Bearer ghp_live");
    assert.equal(call.headers.get("accept"), "application/vnd.github+json");
    assert.equal(call.headers.get("x-github-api-version"), "2022-11-28");
    assert.equal(call.headers.get("user-agent"), "genosyn");
    // `token <t>` and `application/json` are Forgejo's, and GitHub answers the
    // first with a 401 whose message explains nothing.
    assert.deepEqual(
      [...call.headers.keys()].sort(),
      ["accept", "authorization", "user-agent", "x-github-api-version"],
    );
    assert.deepEqual(result, { login: "octocat" });
  });

  test("adds Content-Type only when the tool actually sends a body", async () => {
    const calls = captureCalls({ id: 7 });

    await githubProvider.invokeTool(
      "add_issue_comment",
      { ...ACME, number: 12, body: "Looks good." },
      runtime(),
    );

    const call = only(calls);
    assert.equal(call.url.pathname, "/repos/acme/widgets/issues/12/comments");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, { body: "Looks good." });
    assert.deepEqual(
      [...call.headers.keys()].sort(),
      ["accept", "authorization", "content-type", "user-agent", "x-github-api-version"],
    );
  });

  test("names the tool the model got wrong instead of failing anonymously", async () => {
    await assert.rejects(
      githubProvider.invokeTool("teleport", {}, runtime()),
      /Unknown GitHub tool: teleport/,
    );
  });

  test("refuses a blank owner or repo before the token leaves the process", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      githubProvider.invokeTool("get_repo", { owner: "   ", repo: "widgets" }, runtime()),
      /owner is required/,
    );
    await assert.rejects(
      githubProvider.invokeTool("get_repo", { owner: "acme" }, runtime()),
      /repo is required/,
    );
    assert.equal(reached(), false);
  });

  test("refuses an issue or pull-request number that is not a number", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      githubProvider.invokeTool("get_issue", { ...ACME, number: "12" }, runtime()),
      /number is required/,
    );
    await assert.rejects(
      githubProvider.invokeTool("get_pull_request", ACME, runtime()),
      /number is required/,
    );
    assert.equal(reached(), false);
  });

  test("addresses an issue and a pull request by their number on their own paths", async () => {
    const issue = captureCalls({ number: 12 });
    await githubProvider.invokeTool("get_issue", { ...ACME, number: 12 }, runtime());
    assert.equal(only(issue).url.pathname, "/repos/acme/widgets/issues/12");

    const pull = captureCalls({ number: 12 });
    await githubProvider.invokeTool("get_pull_request", { ...ACME, number: 12 }, runtime());
    assert.equal(only(pull).url.pathname, "/repos/acme/widgets/pulls/12");
  });
});

describe("GitHub Integration pagination", () => {
  /**
   * Every paginated tool and what `{per_page: 7, page: 3}` must look like on
   * the wire. `limit` is Forgejo's spelling and GitHub ignores it silently,
   * which turns a page-size argument into a no-op rather than an error — the
   * model then believes it read 7 rows when it read 30.
   */
  const PAGINATED = [
    { name: "list_repos", args: {}, path: "/user/repos", perPage: "7", page: "3" },
    {
      name: "search_repos",
      args: { q: "genosyn" },
      path: "/search/repositories",
      perPage: "7",
      page: "3",
    },
    {
      name: "list_pull_requests",
      args: ACME,
      path: "/repos/acme/widgets/pulls",
      perPage: "7",
      page: "3",
    },
    {
      name: "list_commits",
      args: ACME,
      path: "/repos/acme/widgets/commits",
      perPage: "7",
      page: "3",
    },
    { name: "search_code", args: { q: "encryptSecret" }, path: "/search/code", perPage: "7", page: "3" },
    // list_issues is the deliberate exception: GitHub serves pull requests
    // from the issues endpoint, so the tool reads fixed 100-row API pages and
    // slices the caller's logical page out of them itself.
    {
      name: "list_issues",
      args: ACME,
      path: "/repos/acme/widgets/issues",
      perPage: "100",
      page: "1",
    },
  ];

  for (const tool of PAGINATED) {
    test(`${tool.name} paginates with per_page, never Forgejo's limit`, async () => {
      const calls = captureCalls([]);

      await githubProvider.invokeTool(tool.name, { ...tool.args, per_page: 7, page: 3 }, runtime());

      const call = only(calls);
      assert.equal(call.url.pathname, tool.path);
      assert.equal(call.url.searchParams.get("per_page"), tool.perPage);
      assert.equal(call.url.searchParams.get("page"), tool.page);
      assert.equal(call.url.searchParams.get("limit"), null);
    });
  }
});

describe("GitHub Integration repositories and search", () => {
  test("list_repos defaults to most-recently-updated first", async () => {
    const calls = captureCalls([]);

    await githubProvider.invokeTool("list_repos", {}, runtime());

    assert.deepEqual(query(only(calls)), {
      per_page: "30",
      page: "1",
      sort: "updated",
      direction: "desc",
    });
  });

  test("list_repos forwards the visibility and affiliation filters Forgejo has no answer for", async () => {
    const calls = captureCalls([]);

    await githubProvider.invokeTool(
      "list_repos",
      {
        visibility: "private",
        affiliation: "owner,collaborator",
        sort: "pushed",
        direction: "asc",
      },
      runtime(),
    );

    assert.deepEqual(query(only(calls)), {
      per_page: "30",
      page: "1",
      sort: "pushed",
      direction: "asc",
      visibility: "private",
      affiliation: "owner,collaborator",
    });
  });

  test("search_repos hits /search/repositories and hands back GitHub's envelope untouched", async () => {
    const envelope = {
      total_count: 2,
      incomplete_results: false,
      items: [{ full_name: "acme/widgets" }, { full_name: "acme/gadgets" }],
    };
    const calls = captureCalls(envelope);

    const result = await githubProvider.invokeTool(
      "search_repos",
      { q: "org:acme language:typescript", sort: "stars", order: "desc" },
      runtime(),
    );

    const call = only(calls);
    // /repos/search is Forgejo's path and 404s on GitHub.
    assert.equal(call.url.pathname, "/search/repositories");
    assert.equal(call.url.searchParams.get("q"), "org:acme language:typescript");
    assert.equal(call.url.searchParams.get("sort"), "stars");
    assert.equal(call.url.searchParams.get("order"), "desc");
    // Forgejo's `{ok, data}` gets unwrapped into `{items}`. GitHub's must pass
    // through whole, or every caller reading `total_count` sees undefined and
    // reports that the search found nothing.
    assert.deepEqual(result, envelope);
  });

  test("search_code reaches GitHub's code index — the one endpoint Forgejo has not got", async () => {
    const payload = { total_count: 1, items: [{ path: "server/lib/secret.ts" }] };
    const calls = captureCalls(payload);

    const result = await githubProvider.invokeTool(
      "search_code",
      { q: "repo:acme/widgets path:server encryptSecret" },
      runtime(),
    );

    const call = only(calls);
    assert.equal(call.url.pathname, "/search/code");
    assert.equal(call.url.searchParams.get("q"), "repo:acme/widgets path:server encryptSecret");
    assert.deepEqual(result, payload);
  });

  test("both search tools refuse a blank query rather than asking for everything", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      githubProvider.invokeTool("search_code", { q: "   " }, runtime()),
      /q is required/,
    );
    await assert.rejects(githubProvider.invokeTool("search_repos", {}, runtime()), /q is required/);
    assert.equal(reached(), false);
  });

  test("get_file_contents encodes each path segment and keeps a fragment out of the URL", async () => {
    const calls = captureCalls({ content: "" });

    await githubProvider.invokeTool(
      "get_file_contents",
      { ...ACME, path: "/docs/read me#1.md", ref: "  release/1.0  " },
      runtime(),
    );

    const call = only(calls);
    // The leading slash is stripped — GitHub 404s on `/contents//docs/…` — and
    // an unencoded `#` would truncate the request path at the fragment.
    assert.equal(call.url.pathname, "/repos/acme/widgets/contents/docs/read%20me%231.md");
    assert.equal(call.url.hash, "");
    assert.equal(call.url.searchParams.get("ref"), "release/1.0");
  });

  test("get_file_contents lists the repository root, with no ref, when given no path", async () => {
    const calls = captureCalls([]);

    await githubProvider.invokeTool("get_file_contents", ACME, runtime());

    const call = only(calls);
    assert.equal(call.url.pathname, "/repos/acme/widgets/contents/");
    assert.equal(call.url.search, "");
  });
});

describe("GitHub Integration issue writes", () => {
  test("create_issue forwards label names unchanged and looks up no label ids", async () => {
    const calls = captureCalls({ number: 42 });

    const result = await githubProvider.invokeTool(
      "create_issue",
      {
        ...ACME,
        title: "Ship the forge layer",
        body: "Details.",
        labels: ["bug", "help wanted"],
        assignees: ["octocat"],
      },
      runtime(),
    );

    const call = only(calls);
    assert.equal(call.url.pathname, "/repos/acme/widgets/issues");
    assert.equal(call.method, "POST");
    // GitHub takes label *names* and creates the ones that do not exist yet.
    // Forgejo takes numeric ids and needs a /labels page to find them; a
    // GitHub connection must make neither that call nor send those ids.
    assert.deepEqual(call.body, {
      title: "Ship the forge layer",
      body: "Details.",
      assignees: ["octocat"],
      labels: ["bug", "help wanted"],
    });
    assert.deepEqual(result, { number: 42 });
  });

  test("create_issue sends only the fields it was given", async () => {
    const calls = captureCalls({ number: 43 });

    await githubProvider.invokeTool("create_issue", { ...ACME, title: "Bare" }, runtime());

    assert.deepEqual(only(calls).body, { title: "Bare" });
  });

  test("create_issue still sends an empty label array through untouched", async () => {
    const calls = captureCalls({ number: 44 });

    await githubProvider.invokeTool(
      "create_issue",
      { ...ACME, title: "No labels", labels: [] },
      runtime(),
    );

    // GitHub has always been sent `labels: []` for this, and it means the same
    // as omitting the field. The value of pinning it is the round trip: on the
    // Forgejo side an empty list is what skips the /labels lookup, and GitHub
    // must never make that call whatever the list holds.
    const call = only(calls);
    assert.deepEqual(call.body, { title: "No labels", labels: [] });
  });

  test("create_issue refuses a blank title rather than filing an untitled issue", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      githubProvider.invokeTool("create_issue", { ...ACME, title: "   " }, runtime()),
      /title is required/,
    );
    assert.equal(reached(), false);
  });

  test("add_issue_comment refuses an empty comment", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      githubProvider.invokeTool("add_issue_comment", { ...ACME, number: 3, body: "" }, runtime()),
      /body is required/,
    );
    assert.equal(reached(), false);
  });
});

describe("GitHub Integration pull requests", () => {
  test("list_pull_requests filters by GitHub's owner-qualified head branch", async () => {
    const calls = captureCalls([]);

    await githubProvider.invokeTool(
      "list_pull_requests",
      {
        ...ACME,
        state: "all",
        head: " acme:feature-x ",
        base: "main",
        sort: "updated",
        direction: "asc",
      },
      runtime(),
    );

    const call = only(calls);
    assert.equal(call.url.pathname, "/repos/acme/widgets/pulls");
    assert.deepEqual(query(call), {
      per_page: "30",
      page: "1",
      state: "all",
      head: "acme:feature-x",
      base: "main",
      sort: "updated",
      direction: "asc",
    });
  });

  test("list_pull_requests keeps the plain filtered list where Forgejo needs a branch pair", async () => {
    const calls = captureCalls([]);

    const result = await githubProvider.invokeTool(
      "list_pull_requests",
      { ...ACME, head: "acme:only-a-head" },
      runtime(),
    );

    const call = only(calls);
    // Forgejo rejects a head without a base and answers the pair from
    // /pulls/<base>/<head>. GitHub filters, defaults to open, and returns a
    // list — a single-object response here would break every caller.
    assert.equal(call.url.pathname, "/repos/acme/widgets/pulls");
    assert.equal(call.url.searchParams.get("state"), "open");
    assert.equal(call.url.searchParams.get("head"), "acme:only-a-head");
    assert.deepEqual(result, []);
  });

  test("create_pull_request forwards draft and maintainer_can_modify", async () => {
    const calls = captureCalls({ number: 7, draft: true });

    await githubProvider.invokeTool(
      "create_pull_request",
      {
        ...ACME,
        title: "Add the forge layer",
        body: "Why this exists.",
        head: "feature-x",
        base: "main",
        draft: true,
        maintainer_can_modify: false,
      },
      runtime(),
    );

    const call = only(calls);
    assert.equal(call.url.pathname, "/repos/acme/widgets/pulls");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, {
      title: "Add the forge layer",
      body: "Why this exists.",
      head: "feature-x",
      base: "main",
      draft: true,
      maintainer_can_modify: false,
    });
  });

  test("create_pull_request drops a draft flag that is not a boolean", async () => {
    const calls = captureCalls({ number: 8 });

    await githubProvider.invokeTool(
      "create_pull_request",
      { ...ACME, title: "T", head: "h", base: "b", draft: "true", maintainer_can_modify: 1 },
      runtime(),
    );

    // GitHub 422s on a string `draft`. Opening an ordinary pull request is the
    // one outcome the caller can still act on.
    assert.deepEqual(only(calls).body, { title: "T", head: "h", base: "b" });
  });

  test("create_pull_request will not open a PR without both branches named", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      githubProvider.invokeTool(
        "create_pull_request",
        { ...ACME, title: "T", base: "main" },
        runtime(),
      ),
      /head is required/,
    );
    await assert.rejects(
      githubProvider.invokeTool(
        "create_pull_request",
        { ...ACME, title: "T", head: "feature-x" },
        runtime(),
      ),
      /base is required/,
    );
    assert.equal(reached(), false);
  });
});

describe("GitHub Integration commits", () => {
  test("list_commits forwards the author and date filters Forgejo does not have", async () => {
    const calls = captureCalls([]);

    await githubProvider.invokeTool(
      "list_commits",
      {
        ...ACME,
        sha: "release/1.0",
        path: "server/services",
        author: "octocat@example.com",
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-31T00:00:00Z",
      },
      runtime(),
    );

    const call = only(calls);
    assert.equal(call.url.pathname, "/repos/acme/widgets/commits");
    assert.deepEqual(query(call), {
      per_page: "30",
      page: "1",
      sha: "release/1.0",
      path: "server/services",
      author: "octocat@example.com",
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-31T00:00:00Z",
    });
  });
});

describe("GitHub Integration token resolution", () => {
  let appPrivateKey = "";

  before(() => {
    // A real RSA key, so `signAppJwt` genuinely signs and a broken key would
    // surface as a signing failure rather than a stubbed-away one. Only the
    // HTTP exchange is faked; nothing here reaches the network.
    appPrivateKey = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;
  });

  test("an apikey Connection presents its stored personal access token", async () => {
    const calls = captureCalls({ login: "octocat" });

    await githubProvider.invokeTool("get_authenticated_user", {}, runtime("ghp_stored"));

    assert.equal(only(calls).headers.get("authorization"), "Bearer ghp_stored");
  });

  test("an apikey Connection with no token says so instead of sending `Bearer undefined`", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      githubProvider.invokeTool(
        "get_authenticated_user",
        {},
        { authMode: "apikey", config: {}, connectionId: "connection-1", companyId: "company-1" },
      ),
      /GitHub Connection is missing its API key\./,
    );
    assert.equal(reached(), false);
  });

  test("an oauth2 Connection whose token never expires is used as it stands", async () => {
    const calls = captureCalls({ login: "octocat" });
    const saved: IntegrationConfig[] = [];

    await githubProvider.invokeTool(
      "get_authenticated_user",
      {},
      oauthRuntime({ accessToken: "gho_longlived", expiresAt: 0 }, saved),
    );

    // expiresAt 0 means the OAuth App has token expiration disabled: there is
    // no refresh token to spend, and attempting a refresh would fail the call
    // outright on a credential that was working.
    assert.equal(only(calls).headers.get("authorization"), "Bearer gho_longlived");
    assert.deepEqual(saved, []);
  });

  test("an oauth2 Connection inside the expiry window refreshes, persists, and uses the new token", async () => {
    const calls: ForgeCall[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const raw = init?.body;
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: raw === undefined || raw === null ? undefined : String(raw),
      });
      if (url.href === "https://github.com/login/oauth/access_token") {
        return json({
          access_token: "gho_fresh",
          refresh_token: "ghr_next",
          expires_in: 28_800,
          scope: "repo read:user",
        });
      }
      return json({ login: "octocat" });
    }) as typeof fetch;

    const saved: IntegrationConfig[] = [];
    const ctx = oauthRuntime(
      {
        accessToken: "gho_stale",
        refreshToken: "ghr_current",
        // Inside the 60-second window the provider refreshes on.
        expiresAt: Date.now() + 30_000,
      },
      saved,
    );

    await githubProvider.invokeTool("get_authenticated_user", {}, ctx);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "POST");
    const form = new URLSearchParams(String(calls[0].body));
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "ghr_current");
    assert.equal(form.get("client_id"), "client-id");
    assert.equal(form.get("client_secret"), "client-secret");

    assert.equal(calls[1].url.href, "https://api.github.com/user");
    assert.equal(calls[1].headers.get("authorization"), "Bearer gho_fresh");

    // GitHub rotates the refresh token on every use. Failing to hand the new
    // one back for persistence means the next refresh spends a token GitHub
    // has already retired, and the Connection dies eight hours later.
    assert.equal(saved.length, 1);
    const persisted = saved[0] as unknown as GithubOauthConfig;
    assert.equal(persisted.accessToken, "gho_fresh");
    assert.equal(persisted.refreshToken, "ghr_next");
    assert.equal(persisted.scope, "repo read:user");
    assert.ok(persisted.expiresAt > Date.now() + 60_000);
    // The in-flight context is updated too, so a second tool call in the same
    // request does not refresh again.
    assert.equal((ctx.config as unknown as GithubOauthConfig).accessToken, "gho_fresh");
  });

  test("an oauth2 Connection with no access token names the missing credential", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      githubProvider.invokeTool(
        "get_authenticated_user",
        {},
        oauthRuntime({ accessToken: "" }, []),
      ),
      /GitHub Connection is missing its OAuth access token\./,
    );
    assert.equal(reached(), false);
  });

  test("a github_app Connection reuses a live installation token without minting another", async () => {
    const calls = captureCalls({ login: "acme-bot" });
    const saved: IntegrationConfig[] = [];

    await githubProvider.invokeTool(
      "get_authenticated_user",
      {},
      appRuntime(
        // `privateKey` is deliberately not a key: reaching the signer at all is
        // the regression this test exists to catch.
        { accessToken: "ghs_cached", expiresAt: Date.now() + 30 * 60_000 },
        saved,
      ),
    );

    assert.equal(only(calls).headers.get("authorization"), "Bearer ghs_cached");
    assert.deepEqual(saved, []);
  });

  test("a github_app Connection mints a fresh installation token when the cached one has expired", async () => {
    const calls: ForgeCall[] = [];
    const mintedExpiry = new Date(Date.now() + 3_600_000).toISOString();
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: undefined,
      });
      if (url.pathname === "/app/installations/99/access_tokens") {
        return json({ token: "ghs_minted", expires_at: mintedExpiry });
      }
      return json({ login: "acme-bot" });
    }) as typeof fetch;

    const saved: IntegrationConfig[] = [];
    await githubProvider.invokeTool(
      "get_authenticated_user",
      {},
      appRuntime(
        { privateKey: appPrivateKey, accessToken: "ghs_expired", expiresAt: Date.now() - 1_000 },
        saved,
      ),
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "POST");
    // The mint is authorized by a JWT the App signed for itself; GitHub
    // rejects it outright if the issuer claim is not the App's own id.
    const jwt = (calls[0].headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const claims = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
    ) as { iss?: string };
    assert.equal(claims.iss, "12345");

    assert.equal(calls[1].url.href, "https://api.github.com/user");
    assert.equal(calls[1].headers.get("authorization"), "Bearer ghs_minted");

    assert.equal(saved.length, 1);
    const persisted = saved[0] as unknown as GithubAppConfig;
    assert.equal(persisted.accessToken, "ghs_minted");
    assert.equal(persisted.expiresAt, Date.parse(mintedExpiry));
  });

  test("an auth mode GitHub does not support names the mode it was handed", async () => {
    await assert.rejects(
      githubProvider.invokeTool("get_authenticated_user", {}, {
        authMode: "service_account",
        config: {},
        connectionId: "connection-1",
        companyId: "company-1",
      }),
      /GitHub connector does not support authMode "service_account"/,
    );
  });
});

describe("GitHub Integration connect and status", () => {
  test("validateApiKey identifies the account and keeps the raw token out of the hint", async () => {
    const calls = captureCalls({ id: 42, login: "octocat", name: "Octo Cat", type: "User" });

    const result = await validateApiKey({ apiKey: "  ghp_supersecrettoken  " });

    const call = only(calls);
    assert.equal(call.url.href, "https://api.github.com/user");
    assert.equal(call.headers.get("authorization"), "Bearer ghp_supersecrettoken");
    const config = result.config as { apiKey?: string; login?: string; repos?: unknown };
    assert.equal(config.apiKey, "ghp_supersecrettoken");
    assert.equal(config.login, "octocat");
    // A new Connection allowlists nothing until an operator picks repositories.
    assert.deepEqual(config.repos, []);
    assert.ok(result.accountHint.startsWith("Octo Cat (@octocat) · "));
    // The hint is rendered in the Connections list; a full PAT there is a leak.
    assert.ok(!result.accountHint.includes("ghp_supersecrettoken"));
  });

  test("validateApiKey rejects a token GitHub answers without a login", async () => {
    captureCalls({ message: "Bad credentials" });

    await assert.rejects(
      validateApiKey({ apiKey: "ghp_wrong" }),
      /GitHub returned no user — token may be invalid\./,
    );
  });

  test("validateApiKey refuses a blank token without a round trip", async () => {
    const reached = refuseNetwork();

    await assert.rejects(
      validateApiKey({ apiKey: "   " }),
      /Personal access token is required/,
    );
    assert.equal(reached(), false);
  });

  test("checkStatus is green when /user answers", async () => {
    const calls = captureCalls({ login: "octocat" });

    assert.deepEqual(await checkStatus(runtime()), { ok: true });
    assert.equal(only(calls).url.href, "https://api.github.com/user");
  });

  test("checkStatus reports GitHub's own wording when the credential is rejected", async () => {
    globalThis.fetch = (async () =>
      json({ message: "Bad credentials" }, 401, "Unauthorized")) as typeof fetch;

    assert.deepEqual(await checkStatus(runtime()), { ok: false, message: "Bad credentials" });
  });
});
