import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  clampInt,
  describeForgeError,
  ForgeApiError,
  forgeCloneUrl,
  forgeFetch,
  forgejoEndpoint,
  forgeLabel,
  GITHUB_ENDPOINT,
  pageSizeParam,
  parseForgeRemote,
  repoPath,
  requireOwnerRepo,
  requireResourceNumber,
  requireString,
  type ForgeEndpoint,
} from "./client.js";

/**
 * The layer where a Connection's token meets a URL.
 *
 * Two functions here are a security boundary rather than a convenience.
 * `forgejoEndpoint` turns what an operator typed into the only host Genosyn
 * will ever talk to, and `parseForgeRemote` decides whether a repository URL
 * sits underneath that host — which is to say, whether the token may be sent
 * for it. Everything above (the Integration tools, repository sync, the
 * pull-request flow) trusts both answers without rechecking them, so the
 * host-matching cases below — a different port, a lookalike domain, a sub-path
 * install, a path that merely shares a prefix string — are what this file
 * exists for.
 *
 * The rest guards the three mechanical differences the two providers were
 * merged onto: where the API root lives, how the token is presented, and what
 * the page-size parameter is called. A regression in any of them is a
 * Connection that authenticates on one forge and 401s on the other.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type ForgeCall = { raw: string; url: URL; init: RequestInit | undefined };

/** Stubs global fetch and records what was actually put on the wire. */
function captureForge(respond: (call: ForgeCall) => Response): ForgeCall[] {
  const calls: ForgeCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const raw = String(input);
    const call: ForgeCall = { raw, url: new URL(raw), init };
    calls.push(call);
    return respond(call);
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

/** The {@link ForgeApiError} a call threw — failing the test if it threw anything else. */
async function forgeError(run: () => Promise<unknown>): Promise<ForgeApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ForgeApiError) return err;
    assert.fail(`expected a ForgeApiError, got ${String(err)}`);
  }
  assert.fail("expected the forge call to reject");
}

describe("forgejoEndpoint", () => {
  test("treats every shape an operator might paste for one server as the same endpoint", () => {
    // The field is filled in once, by hand. A base URL that is right apart
    // from its last three characters must not become a support ticket.
    const pasted = [
      "https://git.example.com",
      "https://git.example.com/",
      "https://git.example.com///",
      "https://git.example.com/api/v1",
      "https://git.example.com/api/v1/",
      "https://git.example.com/API/V1",
      "git.example.com",
      "  https://git.example.com/  ",
    ];
    for (const input of pasted) {
      assert.deepEqual(
        forgejoEndpoint(input),
        {
          flavor: "forgejo",
          apiBase: "https://git.example.com/api/v1",
          webBase: "https://git.example.com",
        },
        input,
      );
    }
  });

  test("keeps a sub-path install's mount point in both bases", () => {
    // Dropping the `/git` here would point every call at the server root, and
    // point `parseForgeRemote` at a host prefix that matches too much.
    for (const input of [
      "https://example.com/git",
      "https://example.com/git/",
      "https://example.com/git/api/v1",
      "https://example.com/git/api/v1/",
    ]) {
      assert.deepEqual(
        forgejoEndpoint(input),
        {
          flavor: "forgejo",
          apiBase: "https://example.com/git/api/v1",
          webBase: "https://example.com/git",
        },
        input,
      );
    }
  });

  test("drops a query string and fragment that would corrupt every path built from the base", () => {
    // Operators paste the URL out of the browser bar, redirect parameters and
    // all. `<base>?next=1/api/v1/user` is not a request any forge answers.
    assert.deepEqual(forgejoEndpoint("https://example.com/git?next=%2Fdashboard#top"), {
      flavor: "forgejo",
      apiBase: "https://example.com/git/api/v1",
      webBase: "https://example.com/git",
    });
  });

  test("keeps a non-default port, which is half the address of a self-hosted forge", () => {
    assert.deepEqual(forgejoEndpoint("https://git.example.com:3000/"), {
      flavor: "forgejo",
      apiBase: "https://git.example.com:3000/api/v1",
      webBase: "https://git.example.com:3000",
    });
    assert.deepEqual(forgejoEndpoint("git.example.com:3000"), {
      flavor: "forgejo",
      apiBase: "https://git.example.com:3000/api/v1",
      webBase: "https://git.example.com:3000",
    });
  });

  test("refuses a missing server URL at the form instead of at the first fetch", () => {
    for (const input of ["", "   ", undefined as unknown as string]) {
      assert.throws(
        () => forgejoEndpoint(input),
        { message: "Server URL is required." },
        String(input),
      );
    }
  });

  test("refuses a URL it cannot parse rather than building an endpoint out of nonsense", () => {
    // An endpoint built from garbage fails later as an unreadable fetch error,
    // several screens away from the field that is wrong.
    assert.throws(() => forgejoEndpoint("not a url"), {
      message: '"not a url" is not a valid server URL.',
    });
    assert.throws(() => forgejoEndpoint("https://"), {
      message: '"https://" is not a valid server URL.',
    });
  });

  test("refuses http:// and says why, so a token is never sent in the clear", () => {
    for (const input of ["http://git.example.com", "http://git.example.com/git/"]) {
      assert.throws(
        () => forgejoEndpoint(input),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /must start with https:\/\//);
          // The reason is half this message's job. Without it an operator
          // reports a working server that Genosyn refuses for no stated cause.
          assert.match(err.message, /will not send a token over a plain http connection/);
          return true;
        },
        input,
      );
    }
  });

  test("refuses a scheme that is not http(s) at all, such as a pasted ssh remote", () => {
    assert.throws(() => forgejoEndpoint("ssh://git@git.example.com"), /must start with https:\/\//);
  });

  test("refuses a URL carrying userinfo, without echoing the credential back", () => {
    for (const input of [
      "https://token@git.example.com",
      "https://admin:hunter2@git.example.com/",
    ]) {
      assert.throws(
        () => forgejoEndpoint(input),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /must not contain a username or password/);
          // This message is rendered under the field and logged. Quoting the
          // input back would put the pasted password in both.
          assert.doesNotMatch(err.message, /hunter2/);
          return true;
        },
        input,
      );
    }
  });
});

describe("GITHUB_ENDPOINT", () => {
  test("keeps GitHub's two origins apart — the API is not served from github.com", () => {
    assert.deepEqual(GITHUB_ENDPOINT, {
      flavor: "github",
      apiBase: "https://api.github.com",
      webBase: "https://github.com",
    });
  });
});

describe("forgeLabel and pageSizeParam", () => {
  test("names each forge the way its own users write it", () => {
    assert.equal(forgeLabel("github"), "GitHub");
    assert.equal(forgeLabel("forgejo"), "Forgejo");
  });

  test("asks each forge for a page size by the only name it accepts", () => {
    // There is no endpoint on either forge where the other name also works:
    // sending `per_page` to Forgejo silently returns its default page.
    assert.equal(pageSizeParam("github"), "per_page");
    assert.equal(pageSizeParam("forgejo"), "limit");
  });
});

describe("parseForgeRemote", () => {
  const forgejo = forgejoEndpoint("https://git.acme.com");
  const subPath = forgejoEndpoint("https://example.com/git");

  test("reads owner and repository off the clone and browser forms of a URL", () => {
    for (const url of [
      "https://github.com/acme/web.git",
      "https://github.com/acme/web",
      "https://github.com/acme/web/",
      "https://github.com/acme/web.GIT",
    ]) {
      assert.deepEqual(parseForgeRemote(GITHUB_ENDPOINT, url), { owner: "acme", repo: "web" }, url);
    }
  });

  test("only strips the .git suffix, not a dot inside the repository name", () => {
    assert.deepEqual(parseForgeRemote(GITHUB_ENDPOINT, "https://github.com/acme/web.js.git"), {
      owner: "acme",
      repo: "web.js",
    });
  });

  test("does not turn a sub-path install's mount point into the owner", () => {
    // The bug this whole prefix dance prevents: `pathname.split("/")` on a
    // Forgejo mounted at /git yields owner `git`, repo `acme` — a plausible
    // pair no forge has heard of, and a 404 nobody can explain.
    assert.deepEqual(parseForgeRemote(subPath, "https://example.com/git/acme/web.git"), {
      owner: "acme",
      repo: "web",
    });
  });

  test("refuses a repository beside the mount point rather than under it", () => {
    assert.equal(parseForgeRemote(subPath, "https://example.com/acme/web.git"), null);
    assert.equal(parseForgeRemote(subPath, "https://example.com/git"), null);
  });

  test("refuses a path that shares the mount point as a string but not as a segment", () => {
    // `/gitlab/...` starts with `/git`. It is a different application.
    assert.equal(parseForgeRemote(subPath, "https://example.com/gitlab/acme/web.git"), null);
    assert.equal(parseForgeRemote(subPath, "https://example.com/git-mirror/acme/web.git"), null);
  });

  test("refuses the same host on a different port", () => {
    // A second service on 8443 of the same box is a different trust domain,
    // and a hostname-only check would hand it this Connection's token.
    assert.equal(parseForgeRemote(forgejo, "https://git.acme.com:8443/acme/web.git"), null);
    const onPort = forgejoEndpoint("https://git.acme.com:8443");
    assert.equal(parseForgeRemote(onPort, "https://git.acme.com/acme/web.git"), null);
  });

  test("accepts the default port written out, which is the same origin", () => {
    const explicit = forgejoEndpoint("https://git.acme.com:443/");
    assert.deepEqual(parseForgeRemote(explicit, "https://git.acme.com/acme/web.git"), {
      owner: "acme",
      repo: "web",
    });
  });

  test("refuses http and ssh remotes, because this token authenticates https only", () => {
    for (const url of [
      "http://git.acme.com/acme/web.git",
      "ssh://git@git.acme.com/acme/web.git",
      "git@git.acme.com:acme/web.git",
    ]) {
      assert.equal(parseForgeRemote(forgejo, url), null, url);
    }
  });

  test("refuses a lookalike host", () => {
    for (const url of [
      "https://git.acme.com.evil.test/acme/web.git",
      "https://notgit.acme.com/acme/web.git",
      "https://evil.test/git.acme.com/acme/web.git",
      "https://git.acme.com.evil.test/git.acme.com/web.git",
    ]) {
      assert.equal(parseForgeRemote(forgejo, url), null, url);
    }
  });

  test("matches the host case-insensitively and the mount path exactly", () => {
    // Hostnames are case-insensitive by spec, so this is the same server.
    assert.deepEqual(parseForgeRemote(GITHUB_ENDPOINT, "https://GITHUB.com/acme/web.git"), {
      owner: "acme",
      repo: "web",
    });
    // Paths are not, and the reverse proxy fronting a sub-path install treats
    // them as distinct. Failing closed costs an operator one retype; the other
    // direction widens the boundary.
    assert.equal(parseForgeRemote(subPath, "https://example.com/GIT/acme/web.git"), null);
  });

  test("refuses a URL that is not exactly an owner and a repository", () => {
    for (const url of [
      "https://github.com/",
      "https://github.com/acme",
      "https://github.com/acme/web/tree",
      "https://github.com/acme/web/pull/12",
      "https://github.com/orgs/acme/repositories",
    ]) {
      assert.equal(parseForgeRemote(GITHUB_ENDPOINT, url), null, url);
    }
  });

  test("refuses an empty owner or repository", () => {
    // `/acme/.git` reduces to an empty repository name — a request for the
    // owner's whole account, not a repository.
    assert.equal(parseForgeRemote(GITHUB_ENDPOINT, "https://github.com/acme/.git"), null);
    assert.equal(parseForgeRemote(GITHUB_ENDPOINT, "https://github.com//web.git"), null);
  });

  test("returns null for an unparseable URL instead of throwing at the call site", () => {
    // Repository rows are user-supplied; a bad one must not take down the
    // credential lookup that is scanning every Connection.
    for (const url of ["", "not a url", "/acme/web.git", "https://"]) {
      assert.equal(parseForgeRemote(GITHUB_ENDPOINT, url), null, url);
    }
  });

  test("returns null when the endpoint itself has no usable base", () => {
    const broken: ForgeEndpoint = { flavor: "forgejo", apiBase: "", webBase: "not a url" };
    assert.equal(parseForgeRemote(broken, "https://git.acme.com/acme/web.git"), null);
  });
});

describe("forgeCloneUrl", () => {
  test("round-trips through parseForgeRemote on every endpoint shape", () => {
    // Sync clones from the URL this builds rather than from the stored remote,
    // so the two must agree about what the stored remote meant.
    const endpoints = [
      GITHUB_ENDPOINT,
      forgejoEndpoint("https://git.acme.com"),
      forgejoEndpoint("https://example.com/git"),
    ];
    for (const endpoint of endpoints) {
      for (const [owner, repo] of [
        ["acme", "web"],
        ["acme", "web.js"],
      ]) {
        const url = forgeCloneUrl(endpoint, owner, repo);
        assert.deepEqual(parseForgeRemote(endpoint, url), { owner, repo }, url);
      }
    }
  });

  test("builds the canonical clone URL under the instance root, not the API root", () => {
    assert.equal(forgeCloneUrl(GITHUB_ENDPOINT, "acme", "web"), "https://github.com/acme/web.git");
    assert.equal(
      forgeCloneUrl(forgejoEndpoint("https://example.com/git/api/v1"), "acme", "web"),
      "https://example.com/git/acme/web.git",
    );
  });
});

describe("forgeFetch", () => {
  test("presents a GitHub call as a bearer token against api.github.com with the media type pinned", async () => {
    const calls = captureForge(() => json([{ number: 1 }]));

    const result = await forgeFetch(GITHUB_ENDPOINT, "gh-token", "/repos/acme/web/issues", {
      query: { per_page: 100, state: "open" },
    });

    assert.deepEqual(result, [{ number: 1 }]);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].raw,
      "https://api.github.com/repos/acme/web/issues?per_page=100&state=open",
    );
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(calls[0].init?.body, undefined);

    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get("authorization"), "Bearer gh-token");
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    // Pinned so a future default media type cannot change payload shapes
    // underneath the tool handlers.
    assert.equal(headers.get("x-github-api-version"), "2022-11-28");
    assert.equal(headers.get("user-agent"), "genosyn");
    assert.equal(headers.get("content-type"), null);
  });

  test("presents a Forgejo call as a `token` header against <base>/api/v1", async () => {
    const endpoint = forgejoEndpoint("https://git.example.com/git/");
    const calls = captureForge(() => json([{ number: 1 }]));

    await forgeFetch(endpoint, "fj-token", "/repos/acme/web/issues", {
      query: { limit: 50, state: "open" },
    });

    assert.equal(
      calls[0].raw,
      "https://git.example.com/git/api/v1/repos/acme/web/issues?limit=50&state=open",
    );

    const headers = new Headers(calls[0].init?.headers);
    // Forgejo's own swagger documents `token <t>`. Recent versions also accept
    // `Bearer`, but the documented form works on every install a self-hoster
    // might still be running.
    assert.equal(headers.get("authorization"), "token fj-token");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("user-agent"), "genosyn");
    // A GitHub-only header on a Forgejo call is at best noise and at worst a
    // fingerprint of the wrong client.
    assert.equal(headers.get("x-github-api-version"), null);
  });

  test("passes the caller's already-encoded path through untouched", async () => {
    const calls = captureForge(() => json({}));

    await forgeFetch(GITHUB_ENDPOINT, "t", "/repos/acme%20labs/widgets%2Fapi/issues");

    // Encoding it a second time here would send `%2520` and 404 every
    // repository whose name needs escaping in the first place.
    assert.equal(calls[0].url.pathname, "/repos/acme%20labs/widgets%2Fapi/issues");
  });

  test("drops undefined and empty query values while keeping false and zero", async () => {
    const calls = captureForge(() => json([]));

    await forgeFetch(GITHUB_ENDPOINT, "t", "/repos/acme/web/pulls", {
      query: { state: "open", assignee: undefined, labels: "", draft: false, page: 0 },
    });

    // An unset filter must not reach the forge as the string "undefined"; a
    // filter the caller explicitly set to `false` or `0` must still reach it.
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
      state: "open",
      draft: "false",
      page: "0",
    });
  });

  test("percent-encodes query values so a search term cannot smuggle in another parameter", async () => {
    const calls = captureForge(() => json({ items: [] }));

    await forgeFetch(GITHUB_ENDPOINT, "t", "/search/issues", {
      query: { q: "repo:acme/web is:open", sort: "created&per_page=1" },
    });

    assert.equal([...calls[0].url.searchParams].length, 2);
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
      q: "repo:acme/web is:open",
      sort: "created&per_page=1",
    });
    assert.match(calls[0].raw, /[?&]q=repo%3Aacme%2Fweb%20is%3Aopen(&|$)/);
  });

  test("leaves no bare ? on the URL when there is nothing to query with", async () => {
    const calls = captureForge(() => json({ login: "octocat" }));

    await forgeFetch(GITHUB_ENDPOINT, "t", "/user");
    await forgeFetch(GITHUB_ENDPOINT, "t", "/user", { query: {} });
    await forgeFetch(GITHUB_ENDPOINT, "t", "/user", { query: { since: undefined, q: "" } });

    for (const call of calls) {
      assert.equal(call.raw, "https://api.github.com/user");
    }
  });

  test("sends a JSON body with a content type, and only then", async () => {
    const calls = captureForge(() => json({ number: 7 }, 201, "Created"));
    const body = { title: "Add sync", head: "topic", base: "main" };

    await forgeFetch(GITHUB_ENDPOINT, "t", "/repos/acme/web/pulls", { method: "POST", body });

    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, JSON.stringify(body));
    assert.equal(new Headers(calls[0].init?.headers).get("content-type"), "application/json");
  });

  test("parses an empty body as null so a 204 does not read as a failure", async () => {
    const calls = captureForge((call) =>
      call.init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(""),
    );

    assert.equal(
      await forgeFetch(GITHUB_ENDPOINT, "t", "/repos/acme/web/issues/1/labels/bug", {
        method: "DELETE",
      }),
      null,
    );
    assert.equal(await forgeFetch(GITHUB_ENDPOINT, "t", "/user"), null);
    assert.equal(calls.length, 2);
  });

  test("returns a non-JSON success body as text instead of throwing a parse error", async () => {
    captureForge(
      () => new Response("ref: refs/heads/main", { headers: { "Content-Type": "text/plain" } }),
    );

    assert.equal(
      await forgeFetch(GITHUB_ENDPOINT, "t", "/repos/acme/web/contents/HEAD"),
      "ref: refs/heads/main",
    );
  });

  test("throws a ForgeApiError carrying GitHub's own wording, status, parsed body and flavor", async () => {
    const body = {
      message: "Validation Failed",
      errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
    };
    captureForge(() => json(body, 422, "Unprocessable Entity"));

    const error = await forgeError(() =>
      forgeFetch(GITHUB_ENDPOINT, "t", "/repos/acme/web/pulls", { method: "POST", body: {} }),
    );

    // The forge's own wording is what an AI Employee sees from a tool call;
    // the parsed body is what the pull-request flow keys its retry on.
    assert.equal(error.message, "Validation Failed");
    assert.equal(error.status, 422);
    assert.equal(error.flavor, "github");
    assert.deepEqual(error.body, body);
    assert.equal(error.name, "ForgeApiError");
    assert.ok(error instanceof Error);
  });

  test("carries the flavor of the forge that failed, so error copy names the right one", async () => {
    const endpoint = forgejoEndpoint("https://git.example.com");
    captureForge(() => json({ message: "pull request already exists" }, 409, "Conflict"));

    const error = await forgeError(() =>
      forgeFetch(endpoint, "t", "/repos/acme/web/pulls", { method: "POST", body: {} }),
    );

    assert.equal(error.flavor, "forgejo");
    assert.equal(error.status, 409);
    assert.equal(error.message, "pull request already exists");
  });

  test("falls back to the labelled status when the forge sent no message of its own", async () => {
    captureForge(() => json({}, 500, "Internal Server Error"));
    const github = await forgeError(() => forgeFetch(GITHUB_ENDPOINT, "t", "/user"));
    assert.equal(github.message, "GitHub 500 Internal Server Error");

    captureForge(() => json({ documentation_url: "https://docs" }, 403, "Forbidden"));
    const forgejo = await forgeError(() =>
      forgeFetch(forgejoEndpoint("https://git.example.com"), "t", "/user"),
    );
    assert.equal(forgejo.message, "Forgejo 403 Forbidden");
  });

  test("survives an HTML error page from a proxy sitting in front of the forge", async () => {
    // A self-hosted forge behind nginx answers a bad gateway in HTML, not
    // JSON. Crashing on the parse would hide the status the caller needs.
    const page = "<html><body><h1>502 Bad Gateway</h1></body></html>";
    captureForge(() => new Response(page, { status: 502, statusText: "Bad Gateway" }));

    const error = await forgeError(() =>
      forgeFetch(forgejoEndpoint("https://git.example.com"), "t", "/user"),
    );

    assert.equal(error.status, 502);
    assert.equal(error.message, "Forgejo 502 Bad Gateway");
    assert.equal(error.body, page);
  });
});

describe("ForgeApiError accessors", () => {
  const githubValidation = {
    message: "Validation Failed",
    errors: [
      { resource: "PullRequest", field: "base", code: "invalid", message: "Base does not exist" },
      {
        resource: "PullRequest",
        field: "head",
        code: "custom",
        message: "No commits between main and topic",
      },
    ],
  };

  test("finds the code GitHub attached to one field, and nothing for a field it did not", () => {
    // The pull-request flow branches on exactly this: `base invalid` means
    // retry against the default branch, anything else is fatal.
    const error = new ForgeApiError("Validation Failed", 422, githubValidation, "github");
    assert.equal(error.fieldCode("base"), "invalid");
    assert.equal(error.fieldCode("head"), "custom");
    assert.equal(error.fieldCode("title"), null);
  });

  test("joins every message GitHub attached to the validation errors", () => {
    const error = new ForgeApiError("Validation Failed", 422, githubValidation, "github");
    assert.equal(error.errorMessages(), "Base does not exist; No commits between main and topic");
  });

  test("degrades to null and an empty string on Forgejo's flat error body", () => {
    // Forgejo answers a bad pull request with `{message, url}` and no errors
    // array at all. Callers fall through to matching on the message text, so
    // these two must answer "nothing here" rather than throw.
    const error = new ForgeApiError(
      "pull request already exists",
      409,
      {
        message: "pull request already exists",
        url: "https://git.example.com/api/swagger",
      },
      "forgejo",
    );
    assert.equal(error.fieldCode("base"), null);
    assert.equal(error.errorMessages(), "");
  });

  test("does not throw on a body that is missing, not an object, or not shaped like an error", () => {
    const bodies: unknown[] = [
      null,
      undefined,
      "<html>502</html>",
      42,
      [],
      { errors: "boom" },
      { errors: {} },
      { errors: [null, 7, {}, { field: "base" }, { message: 5 }] },
      { errors: [{ field: "base", code: 42 }] },
    ];
    for (const body of bodies) {
      const error = new ForgeApiError("failed", 500, body, "github");
      assert.equal(error.fieldCode("base"), null, JSON.stringify(body));
      assert.equal(error.errorMessages(), "", JSON.stringify(body));
    }
  });
});

describe("describeForgeError", () => {
  test("tells a 403 caller which forge's credential to go and reconnect", () => {
    assert.equal(
      describeForgeError("github", { message: "Resource not accessible by integration" }, 403),
      "Resource not accessible by integration. The GitHub credential may not have permission for this — reconnect it in Settings → Integrations with repository access.",
    );
  });

  test("names Forgejo, not GitHub, on a Forgejo 401", () => {
    const sentence = describeForgeError(
      "forgejo",
      { message: "token does not have at least one of required scope(s): [write:repository]" },
      401,
    );
    assert.equal(
      sentence,
      "token does not have at least one of required scope(s): [write:repository]. The Forgejo credential may not have permission for this — reconnect it in Settings → Integrations with repository access.",
    );
    // Sending someone to the wrong Settings page is worse than saying nothing.
    assert.doesNotMatch(sentence, /GitHub/);
  });

  test("keeps the forge's detail in the permission sentence", () => {
    assert.equal(
      describeForgeError(
        "github",
        {
          message: "Resource not accessible by integration",
          errors: [{ resource: "Repository", field: "permissions", code: "insufficient_scope" }],
        },
        403,
      ),
      "Resource not accessible by integration. permissions insufficient_scope. The GitHub credential may not have permission for this — reconnect it in Settings → Integrations with repository access.",
    );
  });

  test("surfaces the nested detail that the top-level message leaves out", () => {
    // "Validation Failed" on its own helps nobody; the reason is one level down.
    assert.equal(
      describeForgeError(
        "github",
        {
          message: "Validation Failed",
          errors: [
            { message: "Base does not exist" },
            { message: "No commits between main and topic" },
          ],
        },
        422,
      ),
      "Validation Failed: Base does not exist; No commits between main and topic",
    );
  });

  test("falls back to field and code for an entry GitHub gave no message", () => {
    assert.equal(
      describeForgeError(
        "github",
        {
          message: "Validation Failed",
          errors: [
            { resource: "Issue", field: "title", code: "missing_field" },
            { resource: "Issue" },
            { message: "Title cannot be blank" },
          ],
        },
        422,
      ),
      "Validation Failed: title missing_field; Title cannot be blank",
    );
  });

  test("returns the headline alone when the forge offered no detail", () => {
    assert.equal(describeForgeError("github", { message: "Not Found" }, 404), "Not Found");
    assert.equal(
      describeForgeError("forgejo", { message: "The target couldn't be found." }, 404),
      "The target couldn't be found.",
    );
    assert.equal(
      describeForgeError("github", { message: "Validation Failed", errors: [] }, 422),
      "Validation Failed",
    );
  });

  test("falls back to the labelled status when there is no message at all", () => {
    assert.equal(describeForgeError("github", {}, 500), "GitHub returned 500");
    assert.equal(describeForgeError("forgejo", {}, 502), "Forgejo returned 502");
  });

  test("still returns a sentence for a body of any unexpected shape", () => {
    // This runs inside a catch block on the pull-request path. Throwing here
    // would replace a forge error the caller can report with a stack trace.
    const bodies: unknown[] = [
      undefined,
      null,
      "boom",
      42,
      [],
      { message: null },
      { message: 42 },
      { message: "" },
      { errors: {} },
      { errors: [null, 7, {}] },
      { errors: [{ message: 5 }] },
    ];
    for (const body of bodies) {
      assert.equal(
        describeForgeError("github", body, 400),
        "GitHub returned 400",
        JSON.stringify(body),
      );
    }
  });
});

describe("argument helpers", () => {
  test("clamps a page size into range and floors a fractional one", () => {
    assert.equal(clampInt(50, 1, 100, 30), 50);
    assert.equal(clampInt(2.9, 1, 100, 30), 2);
    assert.equal(clampInt(999, 1, 100, 30), 100);
    assert.equal(clampInt(0, 1, 100, 30), 1);
    assert.equal(clampInt(-4.2, 1, 100, 30), 1);
  });

  test("falls back for anything that is not a finite number, rather than sending NaN to the forge", () => {
    // A model will pass "50" sooner or later. `per_page=NaN` is a 422 the
    // employee cannot diagnose; the default is a page of results.
    const values: unknown[] = [undefined, null, "50", "", true, {}, [], NaN, Infinity, -Infinity];
    for (const value of values) {
      assert.equal(clampInt(value, 1, 100, 30), 30, String(value));
    }
  });

  test("trims a required string and names the argument that was missing", () => {
    assert.equal(requireString("  acme  ", "owner"), "acme");
    for (const value of [undefined, null, "", "   ", 42]) {
      assert.throws(
        () => requireString(value, "owner"),
        { message: "owner is required" },
        String(value),
      );
    }
  });

  test("requires both halves of an owner/repo pair and says which one is absent", () => {
    assert.deepEqual(requireOwnerRepo({ owner: " acme ", repo: " web " }), {
      owner: "acme",
      repo: "web",
    });
    assert.throws(() => requireOwnerRepo({}), { message: "owner is required" });
    assert.throws(() => requireOwnerRepo({ owner: "acme" }), { message: "repo is required" });
    assert.throws(() => requireOwnerRepo({ owner: "acme", repo: "  " }), {
      message: "repo is required",
    });
  });

  test("encodes each half of a repository path so an argument cannot add a segment", () => {
    assert.equal(repoPath("acme", "web"), "/repos/acme/web");
    // A slash inside either argument is one path segment, not two — otherwise
    // `repo: "web/issues/1/comments"` addresses a different endpoint.
    assert.equal(repoPath("acme labs", "widgets/api"), "/repos/acme%20labs/widgets%2Fapi");
  });

  test("a dot segment in an owner or repository is refused, not encoded", () => {
    // Encoding cannot hold this boundary, and the first two assertions are
    // here to say why a later reader should not "simplify" the refusal back
    // into an `encodeURIComponent`: "." and ".." are unreserved, so encoding
    // leaves them as they were, and the URL standard counts `%2e` as a dot for
    // path normalisation, so escaping them does not help either. Both forms
    // are resolved away by `fetch` before the request goes out, which would
    // send a call that names a repository to an endpoint outside /repos
    // carrying the Connection's token.
    const root = GITHUB_ENDPOINT.apiBase;
    assert.equal(new URL(`${root}/repos/${encodeURIComponent("..")}/web`).pathname, "/web");
    assert.equal(new URL(`${root}/repos/%2E%2E/web`).pathname, "/web");

    for (const [owner, repo, message] of [
      ["..", "web", 'owner must not be ".."'],
      ["acme", "..", 'repo must not be ".."'],
      ["..", "..", 'owner must not be ".."'],
      [".", ".", 'owner must not be "."'],
    ]) {
      assert.throws(() => repoPath(owner, repo), { message }, `${owner}/${repo}`);
    }
    // A dot that is only part of a name is an ordinary character and stays one.
    assert.equal(repoPath("acme", "web.js"), "/repos/acme/web.js");
    assert.equal(repoPath("..acme", "..web"), "/repos/..acme/..web");
  });

  test("a resource number is refused when it is out of range, not clamped onto issue 1", () => {
    // The difference from `clampInt` is the point: rounding a page size into
    // range is a kindness, rounding a *number* into range addresses a
    // different resource than the caller named.
    assert.equal(requireResourceNumber(42, "number"), 42);
    for (const value of [0, -7, 1.4, undefined, null, "3", NaN, Infinity]) {
      assert.throws(
        () => requireResourceNumber(value, "number"),
        { message: "number is required" },
        String(value),
      );
    }
  });
});
