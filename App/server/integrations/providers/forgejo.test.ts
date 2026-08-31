import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { IntegrationConfig, IntegrationRuntimeContext } from "../types.js";
import { forgejoProvider } from "./forgejo.js";
import { GITHUB_ENDPOINT, forgejoEndpoint } from "./forge/client.js";
import {
  FORGE_PROVIDERS,
  forgeEndpointFor,
  forgeGitUsername,
  forgeProviderName,
  isForgeProvider,
  readForgeRepos,
  resolveForgeCredentials,
  writeForgeRepos,
} from "./forge/connection.js";
import { listAccessibleForgeRepos } from "./forge/discovery.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function runtime(config: Record<string, unknown>): IntegrationRuntimeContext {
  return {
    authMode: "apikey",
    config: config as IntegrationConfig,
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

/** A fetch stub that fails the test if anything reaches the network. */
function forbidFetch(): void {
  globalThis.fetch = (async (input) => {
    throw new Error(`unexpected request to ${String(input)}`);
  }) as typeof fetch;
}

describe("Forgejo Integration catalog", () => {
  test("declares the identity the connect form and the catalogue check depend on", () => {
    const { catalog } = forgejoProvider;
    assert.equal(catalog.provider, "forgejo");
    assert.equal(catalog.authMode, "apikey");
    assert.equal(catalog.category, "Developer");
    // lucide is the only icon set allowed here; a name it does not ship would
    // render as a blank card in the catalogue.
    assert.equal(catalog.icon, "GitFork");
    assert.equal(catalog.enabled, true);
  });

  test("collects exactly a server URL and a token, with keys the catalogue check accepts", () => {
    const fields = forgejoProvider.catalog.fields ?? [];
    assert.deepEqual(
      fields.map((field) => field.key),
      ["baseUrl", "apiKey"],
    );
    // catalogue.test.ts holds every provider's field keys to this shape, so a
    // snake_case rename here breaks the whole catalogue, not just this form.
    for (const field of fields) {
      assert.match(field.key, /^[A-Za-z][A-Za-z0-9]*$/);
    }

    const [baseUrl, apiKey] = fields;
    assert.equal(baseUrl.type, "url");
    assert.equal(baseUrl.required, true);
    // "password" is what keeps the token out of the DOM in plain text and out
    // of a screen-share.
    assert.equal(apiKey.type, "password");
    assert.equal(apiKey.required, true);
  });
});

describe("Forgejo validateApiKey", () => {
  test("verifies the token against /user with Forgejo's own auth header, not GitHub's", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push(String(input));
      const url = new URL(String(input));
      assert.equal(url.origin, "https://git.example.com");
      assert.equal(url.pathname, "/api/v1/user");
      assert.equal(init?.method, "GET");

      const headers = new Headers(init?.headers);
      // Forgejo's swagger documents `token <t>`; `Bearer` only works on recent
      // versions, and a self-hoster may be running any of them.
      assert.equal(headers.get("authorization"), "token forgejo-secret");
      assert.equal(headers.get("accept"), "application/json");
      assert.equal(headers.get("user-agent"), "genosyn");
      assert.equal(headers.get("x-github-api-version"), null);

      return json({ id: 7, login: "ada", full_name: "Ada Lovelace" });
    }) as typeof fetch;

    const result = await forgejoProvider.validateApiKey!({
      baseUrl: "https://git.example.com",
      apiKey: "forgejo-secret",
    });

    assert.deepEqual(calls, ["https://git.example.com/api/v1/user"]);
    assert.deepEqual(result.config, {
      baseUrl: "https://git.example.com",
      apiKey: "forgejo-secret",
      login: "ada",
      userId: 7,
      userName: "Ada Lovelace",
      repos: [],
    });
  });

  test("persists the base URL with a trailing slash and an /api/v1 suffix stripped", async () => {
    globalThis.fetch = (async (input) => {
      // Whatever the operator pasted, exactly one /api/v1 must end up in the
      // request path — two would 404 every call this Connection ever makes.
      assert.equal(String(input), "https://git.example.com/api/v1/user");
      return json({ id: 1, login: "ada" });
    }) as typeof fetch;

    const result = await forgejoProvider.validateApiKey!({
      baseUrl: "https://git.example.com/api/v1/",
      apiKey: "t",
    });

    assert.equal((result.config as { baseUrl: string }).baseUrl, "https://git.example.com");
  });

  test("keeps a port and a sub-path install in the persisted base URL", async () => {
    globalThis.fetch = (async (input) => {
      assert.equal(String(input), "https://git.example.com:8443/forge/api/v1/user");
      return json({ id: 1, login: "ada" });
    }) as typeof fetch;

    const result = await forgejoProvider.validateApiKey!({
      baseUrl: "https://git.example.com:8443/forge/",
      apiKey: "t",
    });

    // Dropping either the port or the sub-path would point every later call,
    // and every clone URL, at a host that is not this company's forge.
    assert.equal(
      (result.config as { baseUrl: string }).baseUrl,
      "https://git.example.com:8443/forge",
    );
  });

  test("names the account and the host in the hint, and never the token", async () => {
    globalThis.fetch = (async () =>
      json({ id: 7, login: "ada", full_name: "Ada Lovelace" })) as typeof fetch;

    const result = await forgejoProvider.validateApiKey!({
      baseUrl: "https://git.example.com:8443/forge",
      apiKey: "forgejo-secret",
    });

    // Two Forgejo Connections are told apart by which server they point at, so
    // the host has to be in the hint — and the token never can be.
    assert.equal(result.accountHint, "Ada Lovelace (@ada) · git.example.com:8443");
    assert.ok(!result.accountHint.includes("forgejo-secret"));
  });

  test("falls back to the login alone when the account has no display name", async () => {
    globalThis.fetch = (async () => json({ id: 7, login: "ada", full_name: "" })) as typeof fetch;

    const result = await forgejoProvider.validateApiKey!({
      baseUrl: "https://git.example.com",
      apiKey: "t",
    });

    assert.equal(result.accountHint, "@ada · git.example.com");
  });

  test("rejects a blank token before it reaches the network", async () => {
    forbidFetch();
    await assert.rejects(
      forgejoProvider.validateApiKey!({ baseUrl: "https://git.example.com", apiKey: "   " }),
      /Access token is required/,
    );
  });

  test("rejects a blank server URL with a message about the URL, not the token", async () => {
    forbidFetch();
    await assert.rejects(
      forgejoProvider.validateApiKey!({ baseUrl: "  ", apiKey: "t" }),
      /Server URL is required/,
    );
  });

  test("rejects a malformed server URL by quoting what was typed", async () => {
    forbidFetch();
    await assert.rejects(
      forgejoProvider.validateApiKey!({ baseUrl: "not a url", apiKey: "t" }),
      /"not a url" is not a valid server URL/,
    );
  });

  test("refuses an http:// server rather than sending the token in the clear", async () => {
    forbidFetch();
    await assert.rejects(
      forgejoProvider.validateApiKey!({ baseUrl: "http://git.example.com", apiKey: "t" }),
      /must start with https:\/\//,
    );
  });

  test("rejects a 200 that carries no login, blaming the token or the URL", async () => {
    // A reverse proxy or a marketing site happily answers /api/v1/user with a
    // 200 and something that is not a user; accepting it would create a
    // Connection that fails on its first real call instead of at connect time.
    globalThis.fetch = (async () => json({ ok: true })) as typeof fetch;

    await assert.rejects(
      forgejoProvider.validateApiKey!({ baseUrl: "https://git.example.com", apiKey: "t" }),
      (err: Error) => {
        assert.match(err.message, /token/);
        assert.match(err.message, /URL/);
        return true;
      },
    );
  });

  test("propagates the server's own wording for a rejected token", async () => {
    globalThis.fetch = (async () =>
      json({ message: "token does not exist" }, 401, "Unauthorized")) as typeof fetch;

    await assert.rejects(
      forgejoProvider.validateApiKey!({ baseUrl: "https://git.example.com", apiKey: "stale" }),
      /token does not exist/,
    );
  });
});

describe("Forgejo checkStatus", () => {
  test("reports ok when the stored token still resolves a user", async () => {
    globalThis.fetch = (async (input) => {
      assert.equal(String(input), "https://git.example.com/api/v1/user");
      return json({ id: 1, login: "ada" });
    }) as typeof fetch;

    const status = await forgejoProvider.checkStatus!(
      runtime({ baseUrl: "https://git.example.com", apiKey: "t", login: "ada" }),
    );

    assert.deepEqual(status, { ok: true });
  });

  test("returns the failure as a message instead of throwing out of the status check", async () => {
    globalThis.fetch = (async () =>
      json({ message: "token does not exist" }, 401, "Unauthorized")) as typeof fetch;

    const status = await forgejoProvider.checkStatus!(
      runtime({ baseUrl: "https://git.example.com", apiKey: "stale" }),
    );

    assert.equal(status.ok, false);
    assert.match(status.message ?? "", /token does not exist/);
  });

  test("reports a missing token without calling the server", async () => {
    forbidFetch();

    const status = await forgejoProvider.checkStatus!(
      runtime({ baseUrl: "https://git.example.com" }),
    );

    assert.equal(status.ok, false);
    assert.match(status.message ?? "", /missing its access token/);
  });
});

describe("Forgejo invokeTool", () => {
  test("sends tool calls to the Connection's own server, never to github.com", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.host, "git.example.com");
      assert.equal(url.pathname, "/api/v1/repos/acme/widgets");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "token forgejo-secret");
      return json({ full_name: "acme/widgets" });
    }) as typeof fetch;

    const result = await forgejoProvider.invokeTool(
      "get_repo",
      { owner: "acme", repo: "widgets" },
      runtime({ baseUrl: "https://git.example.com", apiKey: "forgejo-secret", login: "ada" }),
    );

    assert.deepEqual(result, { full_name: "acme/widgets" });
  });

  test("pages with Forgejo's `limit`, since `per_page` is silently ignored there", async () => {
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/v1/user/repos");
      assert.deepEqual(Object.fromEntries(url.searchParams), { limit: "30", page: "1" });
      return json([]);
    }) as typeof fetch;

    await forgejoProvider.invokeTool(
      "list_repos",
      {},
      runtime({ baseUrl: "https://git.example.com", apiKey: "t" }),
    );
  });

  test("refuses a tool call on a Connection with no token", async () => {
    forbidFetch();

    await assert.rejects(
      forgejoProvider.invokeTool(
        "get_repo",
        { owner: "acme", repo: "widgets" },
        runtime({ baseUrl: "https://git.example.com" }),
      ),
      /missing its access token/,
    );
  });
});

describe("forge provider identity", () => {
  test("counts github and forgejo as forges and nothing else", () => {
    assert.deepEqual([...FORGE_PROVIDERS].sort(), ["forgejo", "github"]);
    assert.equal(isForgeProvider("github"), true);
    assert.equal(isForgeProvider("forgejo"), true);
    // A non-forge Connection reaching the repository subsystem would be asked
    // for a clone URL it has no way to produce.
    assert.equal(isForgeProvider("stripe"), false);
    assert.equal(isForgeProvider("gitlab"), false);
    assert.equal(isForgeProvider(""), false);
  });

  test("names each forge for sentences shown to a person", () => {
    assert.equal(forgeProviderName("github"), "GitHub");
    assert.equal(forgeProviderName("forgejo"), "Forgejo");
  });
});

describe("forgeEndpointFor", () => {
  test("pins github Connections to github.com whatever their config says", () => {
    // A stray baseUrl on a GitHub row must never redirect a GitHub token
    // somewhere else.
    const endpoint = forgeEndpointFor("github", { baseUrl: "https://evil.test" });
    assert.equal(endpoint, GITHUB_ENDPOINT);
    assert.equal(endpoint.apiBase, "https://api.github.com");
    assert.equal(endpoint.webBase, "https://github.com");
  });

  test("builds a forgejo endpoint from the stored server URL", () => {
    const endpoint = forgeEndpointFor("forgejo", { baseUrl: "https://git.example.com/forge/" });
    assert.deepEqual(endpoint, {
      flavor: "forgejo",
      apiBase: "https://git.example.com/forge/api/v1",
      webBase: "https://git.example.com/forge",
    });
  });

  test("tells the operator to reconnect rather than fetching against undefined", () => {
    assert.throws(() => forgeEndpointFor("forgejo", {}), /has no server URL.*Reconnect it/s);
  });
});

describe("resolveForgeCredentials", () => {
  test("hands back the forgejo token, login and endpoint with nothing to re-persist", async () => {
    const resolved = await resolveForgeCredentials(
      "forgejo",
      { baseUrl: "https://git.example.com/", apiKey: "forgejo-secret", login: "ada" },
      "apikey",
    );

    assert.ok(resolved);
    assert.equal(resolved.accessToken, "forgejo-secret");
    assert.equal(resolved.login, "ada");
    assert.equal(resolved.endpoint.apiBase, "https://git.example.com/api/v1");
    // A Forgejo token does not rotate, so a non-null here would make every
    // caller re-encrypt and write a config that did not change.
    assert.equal(resolved.refreshedConfig, null);
  });

  test("reports an empty login for a forgejo row that never captured one", async () => {
    // Resolving still succeeds — tool calls only need the token — but the empty
    // login is what `forgeGitUsername` turns into a refusal to build a push
    // credential, so it must not be quietly filled in with something plausible.
    const resolved = await resolveForgeCredentials(
      "forgejo",
      { baseUrl: "https://git.example.com", apiKey: "forgejo-secret" },
      "apikey",
    );

    assert.equal(resolved?.login, "");
    assert.equal(forgeGitUsername("forgejo", resolved?.login ?? ""), null);
  });

  test("skips a forgejo Connection whose token was never stored", async () => {
    const resolved = await resolveForgeCredentials(
      "forgejo",
      { baseUrl: "https://git.example.com" },
      "apikey",
    );
    assert.equal(resolved, null);
  });

  test("delegates github to the GitHub resolver and keeps the token on github.com", async () => {
    const resolved = await resolveForgeCredentials(
      "github",
      { apiKey: "gh-token", login: "octocat", baseUrl: "https://git.example.com" },
      "apikey",
    );

    assert.ok(resolved);
    assert.equal(resolved.accessToken, "gh-token");
    assert.equal(resolved.login, "octocat");
    assert.equal(resolved.endpoint, GITHUB_ENDPOINT);
    assert.equal(resolved.refreshedConfig, null);
  });

  test("skips a github Connection carrying no credential at all", async () => {
    assert.equal(await resolveForgeCredentials("github", {}, "apikey"), null);
  });
});

describe("forge repo allowlist round-trip", () => {
  test("reads back exactly what was written and leaves the rest of the config alone", () => {
    const config = {
      baseUrl: "https://git.example.com",
      apiKey: "forgejo-secret",
      login: "ada",
      userId: 7,
      repos: [{ owner: "acme", name: "old", defaultBranch: "main" }],
    };
    const repos = [
      { owner: "acme", name: "widgets", defaultBranch: "trunk" },
      { owner: "acme", name: "docs", defaultBranch: "main" },
    ];

    const next = writeForgeRepos("forgejo", config, "apikey", repos);

    assert.deepEqual(readForgeRepos("forgejo", next, "apikey"), repos);
    // The write goes back into the same encrypted blob as the credential, so
    // losing a key here logs the Connection out.
    assert.equal(next.baseUrl, "https://git.example.com");
    assert.equal(next.apiKey, "forgejo-secret");
    assert.equal(next.login, "ada");
    assert.equal(next.userId, 7);
    // The caller re-encrypts the returned copy; mutating the original in place
    // would make a failed write look like it succeeded.
    assert.deepEqual(config.repos, [{ owner: "acme", name: "old", defaultBranch: "main" }]);
  });

  test("reads an empty allowlist from a forgejo config that has never picked repos", () => {
    assert.deepEqual(
      readForgeRepos("forgejo", { baseUrl: "https://git.example.com", apiKey: "t" }, "apikey"),
      [],
    );
  });
});

describe("forgeGitUsername", () => {
  test("always uses GitHub's literal, which its installation tokens require", () => {
    assert.equal(forgeGitUsername("github", ""), "x-access-token");
    assert.equal(forgeGitUsername("github", "octocat"), "x-access-token");
  });

  test("uses the token owner's login on forgejo, which resolves basic auth by username", () => {
    assert.equal(forgeGitUsername("forgejo", "ada"), "ada");
    assert.equal(forgeGitUsername("forgejo", " ada "), "ada");
  });

  test("refuses to build a credential for a forgejo Connection with no login", () => {
    // Pushing with a username Forgejo cannot resolve fails as a plain
    // "authentication failed" from git, with nothing pointing at the cause.
    assert.equal(forgeGitUsername("forgejo", ""), null);
    assert.equal(forgeGitUsername("forgejo", "   "), null);
  });
});

describe("listAccessibleForgeRepos", () => {
  test("asks GitHub for a full page of the repos this account is affiliated with", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.pathname, "/user/repos");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        per_page: "100",
        sort: "updated",
        affiliation: "owner,collaborator,organization_member",
      });
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer gh-token");
      return json([]);
    }) as typeof fetch;

    assert.deepEqual(await listAccessibleForgeRepos(GITHUB_ENDPOINT, "gh-token"), []);
  });

  test("asks Forgejo with `limit` and without affiliation, which it does not support", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://git.example.com");
      assert.equal(url.pathname, "/api/v1/user/repos");
      // Sending `affiliation` here is not merely ignored on some versions — it
      // is the kind of unknown parameter that has to stay off the wire for the
      // picker to work on every install.
      assert.deepEqual(Object.fromEntries(url.searchParams), { limit: "100" });
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "token forgejo-secret");
      return json([]);
    }) as typeof fetch;

    assert.deepEqual(
      await listAccessibleForgeRepos(forgejoEndpoint("https://git.example.com"), "forgejo-secret"),
      [],
    );
  });

  test("maps the five fields the picker renders, on both flavors", async () => {
    const rows = [
      {
        owner: { login: "acme" },
        name: "widgets",
        default_branch: "trunk",
        description: "The widget service",
        private: true,
        // The picker must not carry the rest of the payload into the config
        // blob it writes back.
        id: 91,
        html_url: "https://git.example.com/acme/widgets",
      },
    ];
    globalThis.fetch = (async () => json(rows)) as typeof fetch;

    const expected = [
      {
        owner: "acme",
        name: "widgets",
        defaultBranch: "trunk",
        description: "The widget service",
        private: true,
      },
    ];
    assert.deepEqual(await listAccessibleForgeRepos(GITHUB_ENDPOINT, "gh-token"), expected);

    globalThis.fetch = (async () => json(rows)) as typeof fetch;
    assert.deepEqual(
      await listAccessibleForgeRepos(forgejoEndpoint("https://git.example.com"), "t"),
      expected,
    );
  });

  test("defaults an absent branch to main and a null description to empty", async () => {
    // Forgejo answers with `description: null` for a repository with no
    // description, and an empty repository has no default branch at all — the
    // branch is what the runner checks out before a spawn, so it cannot be
    // undefined.
    globalThis.fetch = (async () =>
      json([{ owner: { login: "acme" }, name: "empty", description: null }])) as typeof fetch;

    assert.deepEqual(
      await listAccessibleForgeRepos(forgejoEndpoint("https://git.example.com"), "t"),
      [{ owner: "acme", name: "empty", defaultBranch: "main", description: "", private: false }],
    );
  });

  test("drops rows with no owner or no name rather than offering an uncloneable repo", async () => {
    globalThis.fetch = (async () =>
      json([
        { name: "orphan", default_branch: "main" },
        { owner: {}, name: "no-login" },
        { owner: { login: "acme" } },
        { owner: { login: "acme" }, name: 42 },
        { owner: { login: "acme" }, name: "keeper", default_branch: "main" },
      ])) as typeof fetch;

    const repos = await listAccessibleForgeRepos(forgejoEndpoint("https://git.example.com"), "t");

    assert.deepEqual(
      repos.map((repo) => `${repo.owner}/${repo.name}`),
      ["acme/keeper"],
    );
  });

  test("returns an empty list when a 200 payload is not an array", async () => {
    // Some Forgejo endpoints answer with an `{ok, data}` envelope rather than a
    // bare array; the picker has to render "no repositories" rather than throw
    // on `payload.map`.
    for (const payload of [{ ok: true, data: [] }, "", 0]) {
      globalThis.fetch = (async () => json(payload)) as typeof fetch;
      assert.deepEqual(
        await listAccessibleForgeRepos(forgejoEndpoint("https://git.example.com"), "t"),
        [],
      );
    }
  });

  test("surfaces a rejected token instead of reporting no repositories", async () => {
    // An empty picker and a dead credential must not look the same to the
    // operator choosing an allowlist.
    globalThis.fetch = (async () =>
      json({ message: "token does not exist" }, 401, "Unauthorized")) as typeof fetch;

    await assert.rejects(
      listAccessibleForgeRepos(forgejoEndpoint("https://git.example.com"), "t"),
      /token does not exist/,
    );
  });
});
