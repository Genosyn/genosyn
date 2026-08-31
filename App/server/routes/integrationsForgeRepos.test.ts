import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { IntegrationConfig } from "../integrations/types.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { decryptConnectionConfig, encryptConnectionConfig } from "../services/integrations.js";
import { integrationsRouter } from "./integrations.js";

/**
 * The per-Connection repository allowlist, now that two forges share it.
 *
 * These two endpoints decide which repositories a granted AI Employee gets
 * cloned into its working directory, so the invariant worth pinning is not
 * "the picker renders" — it is **which host the Connection's token is sent
 * to**. The GET used to build a `https://api.github.com/...` URL inline, and
 * the whole safety property of the Forgejo work is that a self-hosted token
 * reaches the server its owner issued it for and nowhere else. Every test
 * here that stubs `fetch` asserts the origin for that reason.
 *
 * The rest is the boring half that breaks in production: a Connection that is
 * not a forge at all, one whose credentials never made it into the config, a
 * forge that is down, and an allowlist write racing a reconnect.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

let company: Company;
let owner: User;
let member: User;
let githubConnection: IntegrationConnection;
let forgejoConnection: IntegrationConnection;
let stripeConnection: IntegrationConnection;

const originalFetch = globalThis.fetch;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    next();
  });
  app.use("/api/companies/:cid/integrations", integrationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await resetTestDb();
  forgeCalls.length = 0;
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });

  githubConnection = await connection("github", "apikey", "GitHub", {
    apiKey: "ghp_github_token",
    login: "acme",
    repos: [{ owner: "acme", name: "api", defaultBranch: "main" }],
  });
  // A port and a trailing slash together, because both are what an operator
  // actually pastes and neither may reach the API root: `<base>//api/v1` is a
  // 404 on every Forgejo, and a base URL compared with its port dropped would
  // let a Connection speak for a different service on the same host.
  forgejoConnection = await connection("forgejo", "apikey", "Ops forge", {
    baseUrl: "https://git.example.test:3000/",
    apiKey: "forgejo-token",
    login: "ops-bot",
    repos: [{ owner: "ops", name: "runbooks", defaultBranch: "trunk" }],
  });
  stripeConnection = await connection("stripe", "apikey", "Billing", { apiKey: "rk_test" });
  actingUserId = owner.id;
});

async function connection(
  provider: string,
  authMode: "apikey" | "oauth2",
  label: string,
  config: Record<string, unknown>,
): Promise<IntegrationConnection> {
  return insert(IntegrationConnection, {
    companyId: company.id,
    provider,
    label,
    authMode,
    encryptedConfig: encryptConnectionConfig(config as IntegrationConfig, company.id),
    accountHint: label,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
}

type ApiResponse<T> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await originalFetch(
    `${baseUrl}/api/companies/${company.id}/integrations${path}`,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type ForgeCall = { url: URL; method: string; headers: Headers };

const forgeCalls: ForgeCall[] = [];

function json(value: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Answer for the forge and record what was asked.
 *
 * `call()` deliberately holds its own reference to the real `fetch`: the route
 * under test and the test client share one global, and a stub that swallowed
 * the client's own loopback request would make every assertion here vacuous.
 */
function stubForge(respond: (url: URL) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    forgeCalls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    return respond(url);
  }) as typeof fetch;
}

function onlyForgeCall(): ForgeCall {
  assert.equal(forgeCalls.length, 1, "expected exactly one forge request");
  return forgeCalls[0];
}

const reposPath = (id: string) => `/connections/${id}/forge/repos`;

// ───────────────────────────── reading the list ─────────────────────────

describe("listing what a forge Connection can reach", () => {
  test("a GitHub Connection is asked github.com, and unusable rows are dropped", async () => {
    stubForge(() =>
      json([
        {
          owner: { login: "acme" },
          name: "web",
          default_branch: "trunk",
          description: "The site",
          private: true,
        },
        // No owner login. Rendering it would put "undefined/orphan" in the
        // picker and clone-fail later; it has to disappear here.
        { name: "orphan" },
      ]),
    );

    const response = await call<{
      allowed: unknown[];
      discoverable: unknown[];
    }>("GET", reposPath(githubConnection.id));

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.allowed, [
      { owner: "acme", name: "api", defaultBranch: "main" },
    ]);
    assert.deepEqual(response.body.discoverable, [
      {
        owner: "acme",
        name: "web",
        defaultBranch: "trunk",
        description: "The site",
        private: true,
      },
    ]);

    const called = onlyForgeCall();
    assert.equal(called.url.origin, "https://api.github.com");
    assert.equal(called.url.pathname, "/user/repos");
    assert.deepEqual(Object.fromEntries(called.url.searchParams), {
      per_page: "100",
      sort: "updated",
      affiliation: "owner,collaborator,organization_member",
    });
    assert.equal(called.headers.get("authorization"), "Bearer ghp_github_token");
    assert.equal(called.headers.get("accept"), "application/vnd.github+json");
  });

  test("a Forgejo Connection is asked its own server, with its own paging and auth", async () => {
    stubForge(() =>
      json([{ owner: { login: "ops" }, name: "runbooks", description: null, private: false }]),
    );

    const response = await call<{
      allowed: unknown[];
      discoverable: unknown[];
    }>("GET", reposPath(forgejoConnection.id));

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.allowed, [
      { owner: "ops", name: "runbooks", defaultBranch: "trunk" },
    ]);
    assert.deepEqual(response.body.discoverable, [
      // A repository with no `default_branch` still has a trunk; falling back
      // to "main" is what stops the clone from asking for a branch named "".
      { owner: "ops", name: "runbooks", defaultBranch: "main", description: "", private: false },
    ]);

    const called = onlyForgeCall();
    assert.equal(
      called.url.origin,
      "https://git.example.test:3000",
      "the self-hosted token must never be sent to github.com",
    );
    assert.equal(called.url.pathname, "/api/v1/user/repos");
    assert.deepEqual(Object.fromEntries(called.url.searchParams), { limit: "100" });
    assert.equal(called.headers.get("authorization"), "token forgejo-token");
    assert.equal(called.headers.get("accept"), "application/json");
    assert.equal(
      called.headers.get("x-github-api-version"),
      null,
      "Forgejo does not version its API by header and rejects nothing on it",
    );
  });

  test("a Forgejo mounted under a sub-path keeps that path in front of /api/v1", async () => {
    const subPath = await connection("forgejo", "apikey", "Sub-path forge", {
      baseUrl: "https://example.test/git",
      apiKey: "sub-path-token",
      login: "ops-bot",
    });
    stubForge(() => json([]));

    assert.equal((await call("GET", reposPath(subPath.id))).status, 200);
    assert.equal(onlyForgeCall().url.href, "https://example.test/git/api/v1/user/repos?limit=100");
  });

  test("a Connection with nothing to show answers with empty lists, not an error", async () => {
    stubForge(() => json([]));
    const response = await call<{ allowed: unknown[]; discoverable: unknown[] }>(
      "GET",
      reposPath(forgejoConnection.id),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.discoverable, []);
  });

  test("a payload that is not a list of repositories is reported as none, not thrown", async () => {
    // Forgejo answers its *search* endpoints with `{ok, data:[…]}`, so an
    // install (or a reverse proxy) that returns that shape here must not take
    // the whole Integrations page down.
    stubForge(() => json({ ok: true, data: [{ owner: { login: "ops" }, name: "runbooks" }] }));
    const response = await call<{ discoverable: unknown[] }>(
      "GET",
      reposPath(forgejoConnection.id),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.discoverable, []);
  });

  test("a Connection that is not a git forge is refused by name", async () => {
    const response = await call<{ error: string }>("GET", reposPath(stripeConnection.id));
    assert.equal(response.status, 400);
    assert.match(response.body.error, /not a git forge Connection/);
    assert.deepEqual(forgeCalls, [], "nothing should have been asked of any forge");
  });

  test("an unknown Connection id is a 404 rather than an empty picker", async () => {
    const response = await call<{ error: string }>(
      "GET",
      reposPath("00000000-0000-4000-8000-000000000000"),
    );
    assert.equal(response.status, 404);
    assert.match(response.body.error, /Connection not found/);
  });

  test("a Connection whose credentials are gone says to reconnect it", async () => {
    const tokenless = await connection("forgejo", "apikey", "Half-connected", {
      baseUrl: "https://git.example.test",
      apiKey: "",
    });
    const response = await call<{ error: string }>("GET", reposPath(tokenless.id));
    assert.equal(response.status, 400);
    assert.match(response.body.error, /missing credentials/i);
    assert.match(response.body.error, /Reconnect/);
  });

  test("a forge that cannot be reached is a 502 that says why", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:3000");
    }) as typeof fetch;
    const response = await call<{ error: string }>("GET", reposPath(forgejoConnection.id));
    assert.equal(response.status, 502);
    assert.match(response.body.error, /ECONNREFUSED/);
  });

  test("a config that will not decrypt is reported, not rendered as an empty picker", async () => {
    const unreadable = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "forgejo",
      label: "Restored without its key",
      authMode: "apikey",
      encryptedConfig: "not-ciphertext-this-install-can-read",
      accountHint: "",
      status: "connected",
      statusMessage: "",
      lastCheckedAt: null,
    });
    const response = await call<{ error: string }>("GET", reposPath(unreadable.id));
    assert.equal(response.status, 500);
    assert.deepEqual(forgeCalls, [], "an unreadable config must not reach any forge");
  });

  test("a forge that rejects the token carries its own words back", async () => {
    stubForge(() =>
      json(
        { message: "token does not have at least one of required scope(s): [read:repository]" },
        403,
        "Forbidden",
      ),
    );
    const response = await call<{ error: string }>("GET", reposPath(forgejoConnection.id));
    assert.equal(response.status, 502);
    assert.match(response.body.error, /required scope/);
  });
});

// ───────────────────────────── writing the list ─────────────────────────

describe("choosing which repositories a Connection may clone", () => {
  test("one repository named twice in different case is stored once", async () => {
    // The picker sends what the forge told it, and a forge is case-preserving
    // but case-insensitive. Two entries here mean two clones of one repository
    // into an employee's working directory, and a second `git clone` into an
    // existing directory fails the whole materialization.
    const response = await call<{ allowed: Array<Record<string, string>> }>(
      "PUT",
      reposPath(forgejoConnection.id),
      {
        repos: [
          { owner: "Ops", name: "Runbooks", defaultBranch: "main" },
          { owner: "ops", name: "runbooks", defaultBranch: "trunk" },
          { owner: "ops", name: "api", defaultBranch: "main" },
        ],
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.allowed, [
      { owner: "Ops", name: "Runbooks", defaultBranch: "main" },
      { owner: "ops", name: "api", defaultBranch: "main" },
    ]);
  });

  test("the allowlist lands in the Forgejo config beside the credential, not instead of it", async () => {
    await call("PUT", reposPath(forgejoConnection.id), {
      repos: [{ owner: "ops", name: "api", defaultBranch: "main" }],
    });

    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: forgejoConnection.id,
    });
    assert.deepEqual(decryptConnectionConfig(stored), {
      baseUrl: "https://git.example.test:3000/",
      apiKey: "forgejo-token",
      login: "ops-bot",
      repos: [{ owner: "ops", name: "api", defaultBranch: "main" }],
    });
  });

  test("a GitHub OAuth Connection keeps its tokens and reads the new list straight back", async () => {
    const oauth = await connection("github", "oauth2", "GitHub OAuth", {
      clientId: "client",
      clientSecret: "secret",
      accessToken: "gho_access",
      refreshToken: "ghr_refresh",
      expiresAt: 0,
      scope: "repo",
      login: "acme",
      repos: [],
    });

    const written = await call<{ allowed: unknown[] }>("PUT", reposPath(oauth.id), {
      repos: [{ owner: "acme", name: "web", defaultBranch: "trunk" }],
    });
    assert.equal(written.status, 200);

    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: oauth.id,
    });
    const config = decryptConnectionConfig(stored) as Record<string, unknown>;
    assert.equal(config.accessToken, "gho_access");
    assert.equal(config.refreshToken, "ghr_refresh");

    // Read back through the GET, because that is where an allowlist written
    // into the wrong half of a config blob would show up as an empty picker.
    stubForge(() => json([]));
    const listed = await call<{ allowed: unknown[] }>("GET", reposPath(oauth.id));
    assert.deepEqual(listed.body.allowed, [{ owner: "acme", name: "web", defaultBranch: "trunk" }]);
  });

  test("more repositories than the schema allows is refused whole", async () => {
    const oversized = Array.from({ length: 201 }, (_, index) => ({
      owner: "ops",
      name: `repo-${index}`,
      defaultBranch: "main",
    }));
    const response = await call<{ error: string }>("PUT", reposPath(forgejoConnection.id), {
      repos: oversized,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");

    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: forgejoConnection.id,
    });
    assert.deepEqual(
      (decryptConnectionConfig(stored) as { repos: unknown[] }).repos,
      [{ owner: "ops", name: "runbooks", defaultBranch: "trunk" }],
      "a rejected write must leave the previous allowlist alone",
    );

    const atTheLimit = await call("PUT", reposPath(forgejoConnection.id), {
      repos: oversized.slice(0, 200),
    });
    assert.equal(atTheLimit.status, 200);
  });

  test("a malformed entry is refused by the schema rather than stored half-formed", async () => {
    for (const repos of [
      [{ owner: "", name: "api", defaultBranch: "main" }],
      [{ owner: "ops", name: "api" }],
      [{ owner: "ops", name: "api", defaultBranch: 7 }],
      "everything",
    ]) {
      const response = await call<{ error: string }>("PUT", reposPath(forgejoConnection.id), {
        repos,
      });
      assert.equal(response.status, 400, JSON.stringify(repos));
      assert.equal(response.body.error, "ValidationError");
    }
  });

  test("a Connection that is not a git forge cannot be given an allowlist", async () => {
    const response = await call<{ error: string }>("PUT", reposPath(stripeConnection.id), {
      repos: [{ owner: "ops", name: "api", defaultBranch: "main" }],
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /not a git forge Connection/);
  });

  test("an ordinary Member cannot change which repositories are cloned", async () => {
    actingUserId = member.id;
    const response = await call("PUT", reposPath(forgejoConnection.id), {
      repos: [{ owner: "ops", name: "api", defaultBranch: "main" }],
    });
    assert.equal(response.status, 403);
  });

  test("a reconnect that lands mid-write wins, and the stale allowlist is refused", async (t) => {
    // The compare-and-swap is on the ciphertext the route decrypted, so the
    // race needs the row to change between the route's read and its write.
    // It cannot be produced with two overlapping requests here: the test
    // database is better-sqlite3, every query runs synchronously, and a
    // second request therefore never interleaves. Standing in for the
    // reconnect at the exact seam is the only way to reach the branch.
    const repo = AppDataSource.getRepository(IntegrationConnection);
    const realFindOneBy = repo.findOneBy.bind(repo);
    (repo as unknown as { findOneBy: unknown }).findOneBy = async (where: never) => {
      const row = await realFindOneBy(where);
      if (row?.id === forgejoConnection.id) {
        await AppDataSource.getRepository(IntegrationConnection).update(
          { id: row.id },
          {
            encryptedConfig: encryptConnectionConfig(
              {
                baseUrl: "https://git.example.test:3000/",
                apiKey: "rotated-forgejo-token",
                login: "ops-bot",
                repos: [],
              } as unknown as IntegrationConfig,
              company.id,
            ),
          },
        );
      }
      return row;
    };
    t.after(() => {
      (repo as unknown as { findOneBy: unknown }).findOneBy = realFindOneBy;
    });

    const response = await call<{ error: string }>("PUT", reposPath(forgejoConnection.id), {
      repos: [{ owner: "ops", name: "api", defaultBranch: "main" }],
    });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /changed while repositories were updated/);

    const stored = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({
      id: forgejoConnection.id,
    });
    assert.equal(
      (decryptConnectionConfig(stored) as { apiKey: string }).apiKey,
      "rotated-forgejo-token",
      "the losing write must not have restored the credential it read",
    );
  });
});

// ───────────────── a Connection that cannot name its server ─────────────
//
// Last in the file on purpose: it is the one case where the route has no
// answer at all, and a request that never gets one takes the process with it.

describe("a Forgejo Connection with no usable server URL", () => {
  test("is answered, not left hanging", async () => {
    // `forgeEndpointFor` throws for this row — a database restored from before
    // the server-URL field existed, or one left behind by a connect that
    // failed halfway. The route decrypts inside a try/catch for exactly this
    // class of problem and then resolves credentials outside one, and Express 4
    // does not turn a rejected handler into a response.
    //
    // Bounded and aborted rather than simply awaited: a request that never
    // answers would otherwise hold this file open for as long as the runner
    // allows, and the socket has to close for the server to shut down.
    const noServer = await connection("forgejo", "apikey", "Restored from backup", {
      apiKey: "forgejo-token",
      login: "ops-bot",
    });
    const answered = await originalFetch(
      `${baseUrl}/api/companies/${company.id}/integrations${reposPath(noServer.id)}`,
      { signal: AbortSignal.timeout(5_000) },
    ).catch(() => null);

    assert.ok(answered, "the request was never answered — the browser would spin forever");
    assert.equal(answered.status, 400);
    assert.match(((await answered.json()) as { error: string }).error, /server URL/i);
  });
});
