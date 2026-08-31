import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { IntegrationTool } from "../../types.js";
import { GITHUB_ENDPOINT, forgejoEndpoint, type ForgeFlavor } from "./client.js";
import { forgeToolDefinitions, invokeForgeTool, type ForgeToolContext } from "./tools.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const FLAVORS: ForgeFlavor[] = ["github", "forgejo"];

/** A Forgejo Connection as an operator would have configured one. */
const FORGEJO_ENDPOINT = forgejoEndpoint("https://git.acme.test");

function ctx(flavor: ForgeFlavor): ForgeToolContext {
  return flavor === "github"
    ? { endpoint: GITHUB_ENDPOINT, token: "github-secret" }
    : { endpoint: FORGEJO_ENDPOINT, token: "forgejo-secret" };
}

/** Where an API-root-relative path lands on each flavor. */
function apiUrl(flavor: ForgeFlavor, path: string): string {
  return flavor === "github"
    ? `https://api.github.com${path}`
    : `https://git.acme.test/api/v1${path}`;
}

type ForgeCall = {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
};

/**
 * Stub `fetch` and record every request the tool layer makes.
 *
 * These tests assert on the recorded calls rather than the return value
 * because that *is* the behaviour under test: a tool's job is to turn one
 * argument object into exactly the right request on each flavor, and a filter
 * that quietly failed to reach the wire looks identical from the result.
 */
function recordFetch(respond: (call: ForgeCall, index: number) => Response): ForgeCall[] {
  const calls: ForgeCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: ForgeCall = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function json(value: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

/** Origin + path, with percent-encoding preserved. */
function pathOf(call: ForgeCall): string {
  return `${call.url.origin}${call.url.pathname}`;
}

function params(call: ForgeCall): Record<string, string> {
  return Object.fromEntries(call.url.searchParams);
}

function toolOf(flavor: ForgeFlavor, name: string): IntegrationTool {
  const found = forgeToolDefinitions(flavor).find((entry) => entry.name === name);
  if (!found) throw new Error(`${flavor} does not define a ${name} tool`);
  return found;
}

function argNames(flavor: ForgeFlavor, name: string): string[] {
  return Object.keys(toolOf(flavor, name).inputSchema.properties);
}

/** Every tool both forges offer, in the order the model is shown them. */
const SHARED_TOOLS = [
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
];

// ───────────────────────────── tool definitions ─────────────────────────────

describe("forgeToolDefinitions", () => {
  test("offers the same roster on both forges except search_code, which is GitHub's alone", () => {
    assert.deepEqual(
      forgeToolDefinitions("github").map((tool) => tool.name),
      [...SHARED_TOOLS, "search_code"],
    );
    assert.deepEqual(
      forgeToolDefinitions("forgejo").map((tool) => tool.name),
      SHARED_TOOLS,
    );
  });

  test("keeps required arguments identical across flavors so one Skill works on both", () => {
    for (const name of SHARED_TOOLS) {
      assert.deepEqual(
        toolOf("forgejo", name).inputSchema.required ?? [],
        toolOf("github", name).inputSchema.required ?? [],
        `required[] diverged on ${name}`,
      );
    }
  });

  test("rejects unknown arguments on every tool, on both flavors", () => {
    for (const flavor of FLAVORS) {
      for (const tool of forgeToolDefinitions(flavor)) {
        assert.equal(
          tool.inputSchema.additionalProperties,
          false,
          `${flavor}/${tool.name} accepts unknown arguments`,
        );
        assert.ok(tool.description.trim().length > 0, `${flavor}/${tool.name} has no description`);
      }
    }
  });

  test("offers per_page and page identically wherever a tool pages, on both flavors", () => {
    // The wire names differ (`per_page` vs `limit`); the tool argument must
    // not, or a Skill written against one forge silently stops paging on the
    // other.
    const paged = [
      "list_repos",
      "search_repos",
      "list_issues",
      "list_pull_requests",
      "list_commits",
    ];
    for (const name of [...paged, "search_code"]) {
      for (const flavor of FLAVORS) {
        if (name === "search_code" && flavor === "forgejo") continue;
        const properties = toolOf(flavor, name).inputSchema.properties;
        assert.deepEqual(
          properties.per_page,
          {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max rows per page (1-100, default 30).",
          },
          `${flavor}/${name} per_page`,
        );
        assert.deepEqual(
          properties.page,
          { type: "integer", minimum: 1, description: "1-indexed page." },
          `${flavor}/${name} page`,
        );
      }
    }
  });

  // A filter that silently does nothing is worse than one that was never
  // offered: the model believes the result was filtered and reports it as
  // such. Every argument here exists on GitHub and has no Forgejo equivalent.
  const FORGEJO_OMITS: Array<{ tool: string; args: string[] }> = [
    { tool: "list_repos", args: ["visibility", "affiliation", "sort", "direction"] },
    { tool: "list_pull_requests", args: ["sort", "direction"] },
    { tool: "create_pull_request", args: ["draft", "maintainer_can_modify"] },
    { tool: "list_commits", args: ["author", "since", "until"] },
  ];

  test("GitHub still offers every filter its API supports", () => {
    for (const { tool, args } of FORGEJO_OMITS) {
      const offered = argNames("github", tool);
      for (const arg of args) {
        assert.ok(offered.includes(arg), `github/${tool} lost ${arg}`);
      }
    }
  });

  test("Forgejo omits the filters its API cannot honour rather than accepting them", () => {
    for (const { tool, args } of FORGEJO_OMITS) {
      const offered = argNames("forgejo", tool);
      for (const arg of args) {
        assert.ok(!offered.includes(arg), `forgejo/${tool} offers ${arg}, which it cannot apply`);
      }
    }
  });

  test("Forgejo keeps head and base on list_pull_requests, which it can answer as a pair", () => {
    const offered = argNames("forgejo", "list_pull_requests");
    assert.ok(offered.includes("head"));
    assert.ok(offered.includes("base"));
  });
});

// ────────────────────────────── transport shape ─────────────────────────────

describe("invokeForgeTool transport", () => {
  test("GitHub authenticates with a bearer token and pins the API version", async () => {
    const calls = recordFetch(() => json({ login: "octocat" }));
    const result = await invokeForgeTool("get_authenticated_user", {}, ctx("github"));

    assert.equal(calls.length, 1);
    assert.equal(pathOf(calls[0]), "https://api.github.com/user");
    assert.equal(calls[0].url.search, "");
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers.get("authorization"), "Bearer github-secret");
    assert.equal(calls[0].headers.get("accept"), "application/vnd.github+json");
    assert.equal(calls[0].headers.get("x-github-api-version"), "2022-11-28");
    assert.equal(calls[0].headers.get("user-agent"), "genosyn");
    assert.equal(calls[0].headers.get("content-type"), null);
    assert.deepEqual(result, { login: "octocat" });
  });

  test("Forgejo authenticates with its documented `token` scheme, not a bearer", async () => {
    const calls = recordFetch(() => json({ login: "forge-user" }));
    const result = await invokeForgeTool("get_authenticated_user", {}, ctx("forgejo"));

    assert.equal(calls.length, 1);
    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/user");
    assert.equal(calls[0].headers.get("authorization"), "token forgejo-secret");
    assert.equal(calls[0].headers.get("accept"), "application/json");
    // Forgejo has no versioned media type; sending GitHub's would be noise at
    // best and a 400 on a strict proxy at worst.
    assert.equal(calls[0].headers.get("x-github-api-version"), null);
    assert.equal(calls[0].headers.get("user-agent"), "genosyn");
    assert.deepEqual(result, { login: "forge-user" });
  });

  test("tool paths land under a Forgejo mounted on a sub-path and a non-default port", async () => {
    const endpoint = forgejoEndpoint("https://git.acme.test:8443/forge/");
    const calls = recordFetch(() => json({ login: "forge-user" }));

    await invokeForgeTool("get_repo", { owner: "acme", repo: "widgets" }, { endpoint, token: "t" });

    assert.equal(calls[0].url.href, "https://git.acme.test:8443/forge/api/v1/repos/acme/widgets");
  });

  test("a base URL pasted with /api/v1 already on it does not double the API root", async () => {
    const endpoint = forgejoEndpoint("https://git.acme.test/api/v1/");
    const calls = recordFetch(() => json({ login: "forge-user" }));

    await invokeForgeTool("get_authenticated_user", {}, { endpoint, token: "t" });

    assert.equal(calls[0].url.href, "https://git.acme.test/api/v1/user");
  });
});

// ─────────────────────────────── simple reads ───────────────────────────────

describe("invokeForgeTool get_repo", () => {
  for (const flavor of FLAVORS) {
    test(`${flavor}: trims and percent-encodes the owner and repo into the path`, async () => {
      const calls = recordFetch(() => json({ full_name: "acme labs/widgets/api" }));

      await invokeForgeTool(
        "get_repo",
        { owner: " acme labs ", repo: " widgets/api " },
        ctx(flavor),
      );

      assert.equal(calls.length, 1);
      assert.equal(pathOf(calls[0]), apiUrl(flavor, "/repos/acme%20labs/widgets%2Fapi"));
      assert.equal(calls[0].method, "GET");
    });
  }
});

describe("invokeForgeTool get_file_contents", () => {
  for (const flavor of FLAVORS) {
    test(`${flavor}: encodes each path segment but keeps the separators`, async () => {
      const calls = recordFetch(() => json({ content: "" }));

      await invokeForgeTool(
        "get_file_contents",
        { owner: "acme", repo: "widgets", path: "src/deep dir/a+b.ts" },
        ctx(flavor),
      );

      assert.equal(
        pathOf(calls[0]),
        apiUrl(flavor, "/repos/acme/widgets/contents/src/deep%20dir/a%2Bb.ts"),
      );
    });

    test(`${flavor}: strips leading slashes so an absolute-looking path is still repo-relative`, async () => {
      const calls = recordFetch(() => json({ content: "" }));

      await invokeForgeTool(
        "get_file_contents",
        { owner: "acme", repo: "widgets", path: "///README.md" },
        ctx(flavor),
      );

      assert.equal(pathOf(calls[0]), apiUrl(flavor, "/repos/acme/widgets/contents/README.md"));
    });

    test(`${flavor}: an omitted path lists the repository root`, async () => {
      const calls = recordFetch(() => json([]));

      await invokeForgeTool("get_file_contents", { owner: "acme", repo: "widgets" }, ctx(flavor));

      assert.equal(pathOf(calls[0]), apiUrl(flavor, "/repos/acme/widgets/contents/"));
      assert.equal(calls[0].url.search, "");
    });

    test(`${flavor}: forwards a ref trimmed, and sends none when it is blank`, async () => {
      const calls = recordFetch(() => json({ content: "" }));

      await invokeForgeTool(
        "get_file_contents",
        { owner: "acme", repo: "widgets", path: "a.ts", ref: "  release/1.0  " },
        ctx(flavor),
      );
      await invokeForgeTool(
        "get_file_contents",
        { owner: "acme", repo: "widgets", path: "a.ts", ref: "   " },
        ctx(flavor),
      );

      assert.deepEqual(params(calls[0]), { ref: "release/1.0" });
      assert.deepEqual(params(calls[1]), {});
    });
  }
});

// ───────────────────────────────── list_repos ───────────────────────────────

describe("invokeForgeTool list_repos", () => {
  test("GitHub sends its sort defaults and forwards the visibility filters", async () => {
    const calls = recordFetch(() => json([]));

    await invokeForgeTool("list_repos", {}, ctx("github"));
    await invokeForgeTool(
      "list_repos",
      {
        visibility: "private",
        affiliation: "owner",
        sort: "full_name",
        direction: "asc",
        per_page: 5,
        page: 3,
      },
      ctx("github"),
    );

    assert.equal(pathOf(calls[0]), "https://api.github.com/user/repos");
    assert.deepEqual(params(calls[0]), {
      per_page: "30",
      page: "1",
      sort: "updated",
      direction: "desc",
    });
    assert.deepEqual(params(calls[1]), {
      per_page: "5",
      page: "3",
      sort: "full_name",
      direction: "asc",
      visibility: "private",
      affiliation: "owner",
    });
  });

  test("Forgejo sends limit and page only, dropping filters its API would ignore", async () => {
    const calls = recordFetch(() => json([]));

    await invokeForgeTool(
      "list_repos",
      {
        visibility: "private",
        affiliation: "owner",
        sort: "full_name",
        direction: "asc",
        per_page: 5,
        page: 3,
      },
      ctx("forgejo"),
    );

    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/user/repos");
    // Exactly these two. A `visibility=private` Forgejo silently ignores would
    // hand the model a full list it believes was filtered.
    assert.deepEqual(params(calls[0]), { limit: "5", page: "3" });
  });
});

// ──────────────────────────────── search_repos ──────────────────────────────

describe("invokeForgeTool search_repos", () => {
  test("GitHub hits /search/repositories and returns the payload untouched", async () => {
    const payload = { total_count: 1, incomplete_results: false, items: [{ full_name: "acme/w" }] };
    const calls = recordFetch(() => json(payload));

    const result = await invokeForgeTool(
      "search_repos",
      { q: "language:typescript stars:>100", sort: "stars", order: "desc" },
      ctx("github"),
    );

    assert.equal(pathOf(calls[0]), "https://api.github.com/search/repositories");
    assert.deepEqual(params(calls[0]), {
      q: "language:typescript stars:>100",
      per_page: "30",
      page: "1",
      sort: "stars",
      order: "desc",
    });
    assert.deepEqual(result, payload);
  });

  test("Forgejo hits /repos/search and unwraps its {ok,data} envelope to {items}", async () => {
    const rows = [{ full_name: "acme/widgets" }];
    const calls = recordFetch(() => json({ ok: true, data: rows }));

    const result = await invokeForgeTool(
      "search_repos",
      { q: "widget", sort: "updated", order: "desc", per_page: 10 },
      ctx("forgejo"),
    );

    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/repos/search");
    assert.deepEqual(params(calls[0]), {
      q: "widget",
      limit: "10",
      page: "1",
      sort: "updated",
      order: "desc",
    });
    assert.deepEqual(result, { items: rows });
  });

  test("Forgejo returns an empty item list rather than undefined when data is absent", async () => {
    recordFetch(() => json({ ok: true }));

    assert.deepEqual(await invokeForgeTool("search_repos", { q: "widget" }, ctx("forgejo")), {
      items: [],
    });
  });

  test("Forgejo returns an empty item list when data is not an array", async () => {
    recordFetch(() => json({ ok: false, data: { message: "no" } }));

    assert.deepEqual(await invokeForgeTool("search_repos", { q: "widget" }, ctx("forgejo")), {
      items: [],
    });
  });

  for (const flavor of FLAVORS) {
    test(`${flavor}: a blank query is rejected before any request is made`, async () => {
      const calls = recordFetch(() => {
        throw new Error("no request should have been made");
      });

      await assert.rejects(invokeForgeTool("search_repos", { q: "   " }, ctx(flavor)), {
        message: "q is required",
      });
      assert.equal(calls.length, 0);
    });
  }
});

// ───────────────────────────────── list_issues ──────────────────────────────

describe("invokeForgeTool list_issues", () => {
  test("GitHub asks for full API pages, defaults to open, and drops pull requests", async () => {
    const issueOne = { number: 11, title: "Real issue" };
    const issueTwo = { number: 12, title: "Another issue" };
    const calls = recordFetch(() =>
      json([issueOne, { number: 13, pull_request: { url: "…" } }, issueTwo]),
    );

    const result = await invokeForgeTool(
      "list_issues",
      { owner: "acme", repo: "widgets" },
      ctx("github"),
    );

    assert.equal(calls.length, 1);
    assert.equal(pathOf(calls[0]), "https://api.github.com/repos/acme/widgets/issues");
    assert.deepEqual(params(calls[0]), { per_page: "100", page: "1", state: "open" });
    assert.deepEqual(result, [issueOne, issueTwo]);
  });

  test("GitHub returns the requested logical page, not the API page", async () => {
    const calls = recordFetch(() =>
      json(Array.from({ length: 10 }, (_, index) => ({ number: index + 1 }))),
    );

    const result = await invokeForgeTool(
      "list_issues",
      { owner: "acme", repo: "widgets", per_page: 2, page: 2 },
      ctx("github"),
    );

    // One API page held enough rows, so the window is a slice and not a
    // second round trip.
    assert.equal(calls.length, 1);
    assert.deepEqual(params(calls[0]).per_page, "100");
    assert.deepEqual(result, [{ number: 3 }, { number: 4 }]);
  });

  test("GitHub stops scanning at the page cap so a pull-request-only repo cannot fan out", async () => {
    const calls = recordFetch(() =>
      json(
        Array.from({ length: 100 }, (_, index) => ({
          number: index + 1,
          pull_request: { url: "…" },
        })),
      ),
    );

    const result = await invokeForgeTool(
      "list_issues",
      { owner: "acme", repo: "widgets" },
      ctx("github"),
    );

    assert.equal(calls.length, 10);
    assert.deepEqual(
      calls.map((call) => params(call).page),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    );
    assert.deepEqual(result, []);
  });

  test("Forgejo filters pull requests server-side in a single request", async () => {
    const issue = { number: 7, title: "Real issue" };
    const calls = recordFetch(() => json([issue]));

    const result = await invokeForgeTool(
      "list_issues",
      { owner: "acme", repo: "widgets", per_page: 5, page: 4 },
      ctx("forgejo"),
    );

    assert.equal(calls.length, 1);
    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/repos/acme/widgets/issues");
    assert.deepEqual(params(calls[0]), {
      state: "open",
      type: "issues",
      limit: "5",
      page: "4",
    });
    assert.deepEqual(result, [issue]);
  });

  test("Forgejo still filters pull requests locally if type=issues did not take", async () => {
    // Older Gitea builds ignore `type`. The tool promises issues either way.
    const issue = { number: 7 };
    recordFetch(() => json([issue, { number: 8, pull_request: { url: "…" } }]));

    const result = await invokeForgeTool(
      "list_issues",
      { owner: "acme", repo: "widgets" },
      ctx("forgejo"),
    );

    assert.deepEqual(result, [issue]);
  });

  test("GitHub forwards creator and assignee under their own names", async () => {
    const calls = recordFetch(() => json([]));

    await invokeForgeTool(
      "list_issues",
      {
        owner: "acme",
        repo: "widgets",
        state: "closed",
        labels: "bug,help wanted",
        creator: "alice",
        assignee: "bob",
        since: "2026-08-01T00:00:00Z",
      },
      ctx("github"),
    );

    assert.deepEqual(params(calls[0]), {
      per_page: "100",
      page: "1",
      state: "closed",
      labels: "bug,help wanted",
      creator: "alice",
      assignee: "bob",
      since: "2026-08-01T00:00:00Z",
    });
  });

  test("Forgejo spells the same filters created_by and assigned_by", async () => {
    const calls = recordFetch(() => json([]));

    await invokeForgeTool(
      "list_issues",
      {
        owner: "acme",
        repo: "widgets",
        state: "all",
        labels: "bug",
        creator: "alice",
        assignee: "bob",
        since: "2026-08-01T00:00:00Z",
      },
      ctx("forgejo"),
    );

    assert.deepEqual(params(calls[0]), {
      state: "all",
      type: "issues",
      limit: "30",
      page: "1",
      labels: "bug",
      created_by: "alice",
      assigned_by: "bob",
      since: "2026-08-01T00:00:00Z",
    });
  });

  for (const flavor of FLAVORS) {
    test(`${flavor}: a non-array success payload fails loudly instead of returning nothing`, async () => {
      recordFetch(() => json({ message: "unexpected shape" }));

      await assert.rejects(
        invokeForgeTool("list_issues", { owner: "acme", repo: "widgets" }, ctx(flavor)),
        /returned an invalid response while listing issues \(expected an array\)/,
      );
    });
  }
});

// ───────────────────────────────── create_issue ─────────────────────────────

describe("invokeForgeTool create_issue", () => {
  test("GitHub posts label names straight through", async () => {
    const calls = recordFetch(() => json({ number: 1 }));

    await invokeForgeTool(
      "create_issue",
      {
        owner: "acme",
        repo: "widgets",
        title: "  Broken build  ",
        body: "It is broken.",
        labels: ["bug", "ci"],
        assignees: ["alice"],
      },
      ctx("github"),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(pathOf(calls[0]), "https://api.github.com/repos/acme/widgets/issues");
    assert.equal(calls[0].headers.get("content-type"), "application/json");
    assert.deepEqual(calls[0].body, {
      title: "Broken build",
      body: "It is broken.",
      assignees: ["alice"],
      labels: ["bug", "ci"],
    });
  });

  test("Forgejo resolves label names to ids, matching case-insensitively across label pages", async () => {
    const firstLabelPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `filler-${index + 1}`,
    }));
    const calls = recordFetch((call) => {
      if (call.url.pathname.endsWith("/labels")) {
        return params(call).page === "1" ? json(firstLabelPage) : json([{ id: 512, name: "Bug" }]);
      }
      return json({ number: 1 });
    });

    await invokeForgeTool(
      "create_issue",
      { owner: "acme", repo: "widgets", title: "Broken build", labels: ["bug"] },
      ctx("forgejo"),
    );

    assert.equal(calls.length, 3);
    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/repos/acme/widgets/labels");
    assert.deepEqual(params(calls[0]), { limit: "100", page: "1" });
    assert.deepEqual(params(calls[1]), { limit: "100", page: "2" });
    assert.equal(calls[2].method, "POST");
    assert.equal(pathOf(calls[2]), "https://git.acme.test/api/v1/repos/acme/widgets/issues");
    // Forgejo's payload is `[]int64`; posting the names would 422 the issue.
    assert.deepEqual(calls[2].body, { title: "Broken build", labels: [512] });
  });

  test("Forgejo refuses to file the issue when a label does not exist, naming each one", async () => {
    const calls = recordFetch(() => json([{ id: 1, name: "bug" }]));

    await assert.rejects(
      invokeForgeTool(
        "create_issue",
        {
          owner: "acme",
          repo: "widgets",
          title: "Broken build",
          labels: ["bug", "wontfix", "duplicate"],
        },
        ctx("forgejo"),
      ),
      /no label called "wontfix", "duplicate" on acme\/widgets/,
    );

    // An issue filed without the label someone asked for looks like it worked.
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET"],
    );
  });

  test("Forgejo does not pay for a label lookup when no label was asked for", async () => {
    const calls = recordFetch(() => json({ number: 1 }));

    await invokeForgeTool(
      "create_issue",
      { owner: "acme", repo: "widgets", title: "Broken build", labels: [] },
      ctx("forgejo"),
    );

    // One request, and it is the issue itself — an empty list has nothing to
    // resolve, so the `/labels` round trip must not happen.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/repos/acme/widgets/issues");
    assert.deepEqual(calls[0].body, { title: "Broken build", labels: [] });
  });

  for (const flavor of FLAVORS) {
    test(`${flavor}: a missing title is rejected before anything is created`, async () => {
      const calls = recordFetch(() => {
        throw new Error("no request should have been made");
      });

      await assert.rejects(
        invokeForgeTool("create_issue", { owner: "acme", repo: "widgets" }, ctx(flavor)),
        { message: "title is required" },
      );
      assert.equal(calls.length, 0);
    });
  }
});

// ────────────────────────── issue and PR by number ──────────────────────────

describe("invokeForgeTool get_issue / get_pull_request / add_issue_comment", () => {
  for (const flavor of FLAVORS) {
    test(`${flavor}: get_issue reads the issue by its number`, async () => {
      const calls = recordFetch(() => json({ number: 42 }));

      await invokeForgeTool(
        "get_issue",
        { owner: "acme", repo: "widgets", number: 42 },
        ctx(flavor),
      );

      assert.equal(pathOf(calls[0]), apiUrl(flavor, "/repos/acme/widgets/issues/42"));
      assert.equal(calls[0].method, "GET");
    });

    test(`${flavor}: get_pull_request reads the pull request by its number`, async () => {
      const calls = recordFetch(() => json({ number: 7 }));

      await invokeForgeTool(
        "get_pull_request",
        { owner: "acme", repo: "widgets", number: 7 },
        ctx(flavor),
      );

      assert.equal(pathOf(calls[0]), apiUrl(flavor, "/repos/acme/widgets/pulls/7"));
    });

    test(`${flavor}: add_issue_comment posts the body to the issue's comment endpoint`, async () => {
      const calls = recordFetch(() => json({ id: 9 }));

      await invokeForgeTool(
        "add_issue_comment",
        { owner: "acme", repo: "widgets", number: 42, body: "  Looking at it now.  " },
        ctx(flavor),
      );

      assert.equal(calls[0].method, "POST");
      assert.equal(pathOf(calls[0]), apiUrl(flavor, "/repos/acme/widgets/issues/42/comments"));
      assert.deepEqual(calls[0].body, { body: "Looking at it now." });
    });

    test(`${flavor}: an absent or non-numeric number is rejected, never guessed`, async () => {
      const calls = recordFetch(() => {
        throw new Error("no request should have been made");
      });

      for (const args of [
        { owner: "acme", repo: "widgets" },
        { owner: "acme", repo: "widgets", number: "42" },
        { owner: "acme", repo: "widgets", number: Number.NaN },
      ]) {
        await assert.rejects(invokeForgeTool("get_issue", args, ctx(flavor)), {
          message: "number is required",
        });
      }
      await assert.rejects(
        invokeForgeTool(
          "add_issue_comment",
          { owner: "acme", repo: "widgets", body: "hi" },
          ctx(flavor),
        ),
        { message: "number is required" },
      );
      assert.equal(calls.length, 0);
    });

    test(`${flavor}: a zero or negative number is rejected, not rounded up onto issue 1`, async () => {
      // `add_issue_comment` is the reason this matters: an employee that
      // failed to parse an issue number must not end up writing a comment on
      // whatever issue #1 happens to be.
      const calls = recordFetch(() => json({ number: 1 }));

      for (const number of [0, -7]) {
        await assert.rejects(
          invokeForgeTool("get_issue", { owner: "acme", repo: "widgets", number }, ctx(flavor)),
          { message: "number is required" },
        );
        await assert.rejects(
          invokeForgeTool(
            "get_pull_request",
            { owner: "acme", repo: "widgets", number },
            ctx(flavor),
          ),
          { message: "number is required" },
        );
        await assert.rejects(
          invokeForgeTool(
            "add_issue_comment",
            { owner: "acme", repo: "widgets", number, body: "Looking at it now." },
            ctx(flavor),
          ),
          { message: "number is required" },
        );
      }
      assert.equal(calls.length, 0);
    });

    test(`${flavor}: a comment with no body is rejected rather than posted empty`, async () => {
      const calls = recordFetch(() => {
        throw new Error("no request should have been made");
      });

      await assert.rejects(
        invokeForgeTool(
          "add_issue_comment",
          { owner: "acme", repo: "widgets", number: 42, body: "   " },
          ctx(flavor),
        ),
        { message: "body is required" },
      );
      assert.equal(calls.length, 0);
    });
  }
});

// ────────────────────────────── list_pull_requests ──────────────────────────

describe("invokeForgeTool list_pull_requests", () => {
  test("GitHub filters by head and base as query parameters", async () => {
    const calls = recordFetch(() => json([]));

    await invokeForgeTool(
      "list_pull_requests",
      {
        owner: "acme",
        repo: "widgets",
        state: "all",
        head: "acme:feature/login",
        base: "main",
        sort: "updated",
        direction: "asc",
      },
      ctx("github"),
    );

    assert.equal(pathOf(calls[0]), "https://api.github.com/repos/acme/widgets/pulls");
    assert.deepEqual(params(calls[0]), {
      per_page: "30",
      page: "1",
      state: "all",
      head: "acme:feature/login",
      base: "main",
      sort: "updated",
      direction: "asc",
    });
  });

  test("Forgejo looks up the exact branch pair and returns it as a one-element list", async () => {
    const pull = { number: 12, title: "Add login" };
    const calls = recordFetch(() => json(pull));

    const result = await invokeForgeTool(
      "list_pull_requests",
      { owner: "acme", repo: "widgets", head: " feature/login ", base: " release/1.0 " },
      ctx("forgejo"),
    );

    assert.equal(calls.length, 1);
    assert.equal(
      pathOf(calls[0]),
      "https://git.acme.test/api/v1/repos/acme/widgets/pulls/release%2F1.0/feature%2Flogin",
    );
    // The pair lookup is a path, not a filtered list — a stray `state` would
    // be meaningless here.
    assert.equal(calls[0].url.search, "");
    assert.deepEqual(result, [pull]);
  });

  test("Forgejo answers 'no pull request for this branch' with an empty list, not an error", async () => {
    recordFetch(() => json({ message: "Not Found" }, 404, "Not Found"));

    const result = await invokeForgeTool(
      "list_pull_requests",
      { owner: "acme", repo: "widgets", head: "feature/login", base: "main" },
      ctx("forgejo"),
    );

    assert.deepEqual(result, []);
  });

  test("Forgejo returns an empty list when the pair lookup answers with no body", async () => {
    recordFetch(() => new Response("", { status: 200 }));

    const result = await invokeForgeTool(
      "list_pull_requests",
      { owner: "acme", repo: "widgets", head: "feature/login", base: "main" },
      ctx("forgejo"),
    );

    assert.deepEqual(result, []);
  });

  test("Forgejo surfaces a pair lookup that failed for a reason other than 'not found'", async () => {
    // "No pull request exists for this branch" and "your token is not valid"
    // are different answers. Reporting the second as the first is what makes
    // an employee open a duplicate pull request, or report that the one it
    // just opened is missing.
    for (const status of [401, 403, 500]) {
      recordFetch(() => json({ message: `failed with ${status}` }, status));

      await assert.rejects(
        invokeForgeTool(
          "list_pull_requests",
          { owner: "acme", repo: "widgets", head: "feature/login", base: "main" },
          ctx("forgejo"),
        ),
        { message: `failed with ${status}` },
      );
    }
  });

  test("Forgejo rejects half a branch pair instead of returning an unfiltered list", async () => {
    const calls = recordFetch(() => json([]));

    for (const half of [{ head: "feature/login" }, { base: "main" }]) {
      await assert.rejects(
        invokeForgeTool(
          "list_pull_requests",
          { owner: "acme", repo: "widgets", ...half },
          ctx("forgejo"),
        ),
        /can only look up a pull request by head and base together — pass both, or neither/,
      );
    }
    assert.equal(calls.length, 0);
  });

  test("Forgejo lists normally when neither branch is given, sending no head or base", async () => {
    const calls = recordFetch(() => json([]));

    await invokeForgeTool(
      "list_pull_requests",
      { owner: "acme", repo: "widgets", state: "all", sort: "updated", direction: "asc" },
      ctx("forgejo"),
    );

    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/repos/acme/widgets/pulls");
    assert.deepEqual(params(calls[0]), { limit: "30", page: "1", state: "all" });
  });
});

// ───────────────────────────── create_pull_request ──────────────────────────

describe("invokeForgeTool create_pull_request", () => {
  test("GitHub forwards draft and maintainer_can_modify", async () => {
    const calls = recordFetch(() => json({ number: 3 }));

    await invokeForgeTool(
      "create_pull_request",
      {
        owner: "acme",
        repo: "widgets",
        title: "Add login",
        body: "Closes #1",
        head: "feature/login",
        base: "main",
        draft: true,
        maintainer_can_modify: false,
      },
      ctx("github"),
    );

    assert.equal(calls[0].method, "POST");
    assert.equal(pathOf(calls[0]), "https://api.github.com/repos/acme/widgets/pulls");
    assert.deepEqual(calls[0].body, {
      title: "Add login",
      head: "feature/login",
      base: "main",
      body: "Closes #1",
      draft: true,
      maintainer_can_modify: false,
    });
  });

  test("Forgejo omits draft and maintainer_can_modify even when the model passes them", async () => {
    const calls = recordFetch(() => json({ number: 3 }));

    await invokeForgeTool(
      "create_pull_request",
      {
        owner: "acme",
        repo: "widgets",
        title: "Add login",
        body: "Closes #1",
        head: "feature/login",
        base: "main",
        draft: true,
        maintainer_can_modify: false,
      },
      ctx("forgejo"),
    );

    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/repos/acme/widgets/pulls");
    // Forgejo's CreatePullRequestOption has neither field; a draft flag on the
    // wire would either 422 or be dropped, and the model would be told it
    // opened a draft.
    assert.deepEqual(calls[0].body, {
      title: "Add login",
      head: "feature/login",
      base: "main",
      body: "Closes #1",
    });
  });

  for (const flavor of FLAVORS) {
    test(`${flavor}: a pull request with no head or base is rejected before the POST`, async () => {
      const calls = recordFetch(() => {
        throw new Error("no request should have been made");
      });

      await assert.rejects(
        invokeForgeTool(
          "create_pull_request",
          { owner: "acme", repo: "widgets", title: "Add login", base: "main" },
          ctx(flavor),
        ),
        { message: "head is required" },
      );
      await assert.rejects(
        invokeForgeTool(
          "create_pull_request",
          { owner: "acme", repo: "widgets", title: "Add login", head: "feature/login" },
          ctx(flavor),
        ),
        { message: "base is required" },
      );
      assert.equal(calls.length, 0);
    });
  }
});

// ───────────────────────────────── list_commits ─────────────────────────────

describe("invokeForgeTool list_commits", () => {
  test("GitHub forwards the branch, path, author, and date filters", async () => {
    const calls = recordFetch(() => json([]));

    await invokeForgeTool(
      "list_commits",
      {
        owner: "acme",
        repo: "widgets",
        sha: "main",
        path: "server/index.ts",
        author: "alice@acme.test",
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-31T00:00:00Z",
      },
      ctx("github"),
    );

    assert.equal(pathOf(calls[0]), "https://api.github.com/repos/acme/widgets/commits");
    assert.deepEqual(params(calls[0]), {
      per_page: "30",
      page: "1",
      sha: "main",
      path: "server/index.ts",
      author: "alice@acme.test",
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-31T00:00:00Z",
    });
  });

  test("Forgejo sends only the filters its commit listing understands", async () => {
    const calls = recordFetch(() => json([]));

    await invokeForgeTool(
      "list_commits",
      {
        owner: "acme",
        repo: "widgets",
        sha: "main",
        path: "server/index.ts",
        author: "alice@acme.test",
        since: "2026-08-01T00:00:00Z",
        until: "2026-08-31T00:00:00Z",
      },
      ctx("forgejo"),
    );

    assert.equal(pathOf(calls[0]), "https://git.acme.test/api/v1/repos/acme/widgets/commits");
    assert.deepEqual(params(calls[0]), {
      limit: "30",
      page: "1",
      sha: "main",
      path: "server/index.ts",
    });
  });
});

// ────────────────────────────────── search_code ─────────────────────────────

describe("invokeForgeTool search_code", () => {
  test("GitHub searches code with the query and paging", async () => {
    const payload = { total_count: 0, items: [] };
    const calls = recordFetch(() => json(payload));

    const result = await invokeForgeTool(
      "search_code",
      { q: "repo:acme/widgets encryptSecret", per_page: 50, page: 2 },
      ctx("github"),
    );

    assert.equal(pathOf(calls[0]), "https://api.github.com/search/code");
    assert.deepEqual(params(calls[0]), {
      q: "repo:acme/widgets encryptSecret",
      per_page: "50",
      page: "2",
    });
    assert.deepEqual(result, payload);
  });

  test("Forgejo says it has no code search rather than emulating one", async () => {
    const calls = recordFetch(() => {
      throw new Error("no request should have been made");
    });

    await assert.rejects(invokeForgeTool("search_code", { q: "encryptSecret" }, ctx("forgejo")), {
      message: "This server has no code search API.",
    });
    assert.equal(calls.length, 0);
  });
});

// ──────────────────────────── argument validation ───────────────────────────

describe("invokeForgeTool argument handling", () => {
  for (const flavor of FLAVORS) {
    const label = flavor === "github" ? "GitHub" : "Forgejo";

    test(`${flavor}: an unknown tool name names the forge it was asked of`, async () => {
      const calls = recordFetch(() => {
        throw new Error("no request should have been made");
      });

      await assert.rejects(invokeForgeTool("frobnicate", {}, ctx(flavor)), {
        message: `Unknown ${label} tool: frobnicate`,
      });
      assert.equal(calls.length, 0);
    });

    test(`${flavor}: a missing or blank owner or repo names the argument at fault`, async () => {
      const calls = recordFetch(() => {
        throw new Error("no request should have been made");
      });

      await assert.rejects(invokeForgeTool("get_repo", undefined, ctx(flavor)), {
        message: "owner is required",
      });
      await assert.rejects(invokeForgeTool("get_repo", { owner: "   " }, ctx(flavor)), {
        message: "owner is required",
      });
      await assert.rejects(invokeForgeTool("get_repo", { owner: "acme" }, ctx(flavor)), {
        message: "repo is required",
      });
      await assert.rejects(invokeForgeTool("get_repo", { owner: "acme", repo: 12 }, ctx(flavor)), {
        message: "repo is required",
      });
      assert.equal(calls.length, 0);
    });

    test(`${flavor}: per_page is clamped to 1..100 and defaults to 30`, async () => {
      const calls = recordFetch(() => json([]));
      const sizeParam = flavor === "github" ? "per_page" : "limit";

      for (const per_page of [0, 5000, 7.9, "20", undefined]) {
        await invokeForgeTool(
          "list_commits",
          { owner: "acme", repo: "widgets", per_page },
          ctx(flavor),
        );
      }

      assert.deepEqual(
        calls.map((call) => params(call)[sizeParam]),
        ["1", "100", "7", "30", "30"],
      );
    });

    test(`${flavor}: page is floored at 1 so a zero or negative page still returns rows`, async () => {
      const calls = recordFetch(() => json([]));

      for (const page of [0, -4, 3.7, "2", undefined]) {
        await invokeForgeTool(
          "list_commits",
          { owner: "acme", repo: "widgets", page },
          ctx(flavor),
        );
      }

      assert.deepEqual(
        calls.map((call) => params(call).page),
        ["1", "1", "3", "1", "1"],
      );
    });
  }
});
