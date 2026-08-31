import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { promisify } from "node:util";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { User } from "../db/entities/User.js";
import type { IntegrationConfig } from "../integrations/types.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { repositoryContentRouter } from "./repositoryContent.js";

/**
 * Route contract for working inside a Repository.
 *
 * Three things this file exists to pin down, because all three are easy to
 * lose in a refactor and expensive to lose in production:
 *
 *   1. **Who may do what.** Editing and committing are Member-level; pushing
 *      and pulling are admin-only. The old Code section admin-gated every
 *      mutation, and quietly reverting to that would make a repository of
 *      strategy documents unusable for the people who write them — while
 *      quietly opening up push would let any Member publish to production.
 *   2. **Paths cannot escape.** Every endpoint that takes a path is a
 *      traversal vector, and each one has to refuse independently.
 *   3. **Publishing to a forge.** Creating the repository on the forge and
 *      pushing into it is one request that both writes to a third party and
 *      changes the row, and it now has to work on a server the company hosts
 *      itself as well as on github.com.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let dataDir: string;
const originalDataDir = config.dataDir;
const originalMultiTenant = config.security.multiTenant;
const codingTools = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const originalCodingTools = { ...codingTools };
const originalFetch = globalThis.fetch;
const exec = promisify(execFile);

/** A git server on loopback that the publish push can actually reach. */
let forgeServer: Server;
let forgeRoot: string;
let forgeOrigin: string;

before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-routes-"));
  (config as { dataDir: string }).dataDir = dataDir;
  // The App-owned checkout runs Git through whatever execution mode boot
  // settled on, and no server boots here — so the shipped `bubblewrap` default
  // would send every Git child through a sandbox this host may not have. Pin
  // the mode `resolveCodingExecutionMode` resolves to wherever bubblewrap
  // cannot run (services/runtimeSecurity.ts), so these tests pin the route
  // contract rather than the host's user-namespace policy.
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.allowUnsafeHostExecution = false;

  const app = express();
  // Mirror the real server's body limit (server/index.ts). With the default
  // 100 KB a save just over the editor cap would 413 here and never reach the
  // validation this test is about.
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 1, authenticatedAt: Date.now() }
      : null;
    next();
  });
  app.use("/api/companies/:cid", repositoryContentRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  forgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-forge-remotes-"));
  forgeServer = await startGitServer(forgeRoot);
  forgeOrigin = `http://127.0.0.1:${(forgeServer.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    forgeServer.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  (config.security as { multiTenant: boolean }).multiTenant = originalMultiTenant;
  Object.assign(codingTools, originalCodingTools);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(forgeRoot, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Git's own CGI, wrapped in the smallest HTTP server that can host it.
 *
 * Publishing is the one route whose whole job is to push, and a stubbed
 * `runWorkspaceGit` would prove only that the route calls a function. Git
 * refuses to push over the dumb protocols and `assertSafeGitRemoteUrl` refuses
 * `file://`, so the honest way to watch a commit arrive on a remote is to
 * serve one. The repository is anonymous-writable — the credential path is
 * covered separately, by the tests that assert which Connection the push
 * resolves.
 */
async function startGitServer(projectRoot: string): Promise<Server> {
  const execPath = (await exec("git", ["--exec-path"])).stdout.trim();
  const created = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const backend = spawn(path.join(execPath, "git-http-backend"), [], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(backend.stdin);
    // CGI answers with its own header block; everything after the blank line
    // is the response body and has to stream, because a fetch negotiation is
    // several round trips inside one request.
    let head = Buffer.alloc(0);
    let headersSent = false;
    backend.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      let status = 200;
      for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
        else res.setHeader(name, value);
      }
      res.writeHead(status);
      headersSent = true;
      const body = head.subarray(end + 4);
      if (body.length) res.write(body);
    });
    backend.stdout.on("end", () => res.end());
  });
  await new Promise<void>((resolve) => {
    created.listen(0, "127.0.0.1", resolve);
  });
  return created;
}

/** An empty repository on the local git server, as a forge would create one. */
async function emptyRemote(name: string): Promise<string> {
  const bare = path.join(forgeRoot, `${name}.git`);
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", bare]);
  // `git http-backend` serves fetch to anyone and push only to an
  // authenticated caller unless the repository opts in.
  await exec("git", ["config", "http.receivepack", "true"], { cwd: bare });
  return `${forgeOrigin}/${name}.git`;
}

/** The subject of the commit a branch points at on one of those remotes. */
async function remoteCommitSubject(name: string, branch: string): Promise<string> {
  const bare = path.join(forgeRoot, `${name}.git`);
  const { stdout } = await exec("git", ["--git-dir", bare, "log", "-1", "--format=%s", branch]);
  return stdout.trim();
}

let company: Company;
let otherCompany: Company;
let owner: User;
let member: User;
let outsider: User;
let repository: Repository;
let employee: AIEmployee;

beforeEach(async () => {
  await resetTestDb();
  forgeCalls.length = 0;
  (config.security as { multiTenant: boolean }).multiTenant = false;
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 1,
  });
  member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 1,
  });
  outsider = await insert(User, {
    email: "outsider@example.com",
    name: "Outsider",
    passwordHash: "x",
    sessionVersion: 1,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  await insert(Membership, {
    companyId: otherCompany.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Engineer",
  });
  repository = await insert(Repository, {
    companyId: company.id,
    name: "Strategy",
    slug: "strategy",
    description: "",
    origin: "local",
    kind: "documents",
    gitUrl: "",
    defaultBranch: "main",
    authMode: "none",
    lastSyncStatus: "unknown",
    lastSyncError: "",
  });
  actingUserId = member.id;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  companyId?: string,
): Promise<ApiResponse<T>> {
  // The real `fetch`, held on purpose: the publish tests replace the global
  // one to answer for the forge, and a client that went through the stub would
  // make every assertion below vacuous.
  const response = await originalFetch(
    `${baseUrl}/api/companies/${companyId ?? company.id}${path}`,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const base = () => `/repositories/${repository.slug}/workspace`;

async function forgeConnection(
  provider: "github" | "forgejo",
  label: string,
  connectionConfig: Record<string, unknown>,
): Promise<IntegrationConnection> {
  return insert(IntegrationConnection, {
    companyId: company.id,
    provider,
    label,
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig(
      connectionConfig as IntegrationConfig,
      company.id,
    ),
    accountHint: label,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
}

type ForgeCall = { url: URL; method: string; headers: Headers; body: unknown };

const forgeCalls: ForgeCall[] = [];

/**
 * Answer the forge's create-repository call with a clone URL of our choosing.
 *
 * Pointing it at the local git server is what lets the push in the same
 * request be a real one.
 */
function stubForgeCreate(cloneUrl: string, htmlUrl: string | null = null): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    forgeCalls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(
      JSON.stringify({ clone_url: cloneUrl, html_url: htmlUrl, default_branch: "trunk" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

async function reloadRepository(): Promise<Repository> {
  return AppDataSource.getRepository(Repository).findOneByOrFail({ id: repository.id });
}

// ───────────────────────────── authorization ────────────────────────────

describe("authorization", () => {
  test("an unauthenticated caller is rejected", async () => {
    actingUserId = null;
    assert.equal((await call("GET", `${base()}/tree`)).status, 401);
  });

  test("a non-member of the company is rejected", async () => {
    actingUserId = outsider.id;
    assert.equal((await call("GET", `${base()}/tree`)).status, 403);
  });

  test("an ordinary member may browse, edit, and commit", async () => {
    actingUserId = member.id;
    assert.equal((await call("GET", `${base()}/tree`)).status, 200);
    assert.equal(
      (await call("PUT", `${base()}/file`, { path: "plan.md", content: "# Plan\n" })).status,
      200,
    );
    const committed = await call<{ committed: boolean }>("POST", `${base()}/commit`, {
      message: "Add the plan",
    });
    assert.equal(committed.status, 200);
    assert.equal(committed.body.committed, true);
  });

  test("an ordinary member may not push or pull", async () => {
    actingUserId = member.id;
    assert.equal((await call("POST", `${base()}/push`, { name: "main" })).status, 403);
    assert.equal((await call("POST", `${base()}/pull`, { name: "main" })).status, 403);
  });

  test("an owner may reach the push route — it fails on the repository, not the role", async () => {
    actingUserId = owner.id;
    const response = await call<{ error: string }>("POST", `${base()}/push`, { name: "main" });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /no remote/);
  });

  test("a repository in another company is not found from this one", async () => {
    actingUserId = owner.id;
    const response = await call("GET", base() + "/tree", undefined, otherCompany.id);
    assert.equal(response.status, 404);
  });

  test("shared SaaS mode is read-only", async () => {
    (config.security as { multiTenant: boolean }).multiTenant = true;
    assert.equal((await call("GET", `${base()}/tree`)).status, 200);
    const write = await call<{ error: string }>("PUT", `${base()}/file`, {
      path: "x.md",
      content: "x",
    });
    assert.equal(write.status, 403);
    assert.match(write.body.error, /read-only in shared SaaS mode/);
  });
});

// ───────────────────────────── path safety ──────────────────────────────

describe("path safety", () => {
  // A leading slash means "from the repository root" and is normalized, not
  // rejected — these are the shapes that genuinely try to leave the checkout.
  const traversals = ["../escape.md", ".git/config", "docs/../../escape.md", "a/../../../etc/x"];

  test("every path-taking endpoint refuses traversal", async () => {
    for (const bad of traversals) {
      assert.equal(
        (await call("GET", `${base()}/file?path=${encodeURIComponent(bad)}`)).status,
        400,
        `GET file ${bad}`,
      );
      assert.equal(
        (await call("PUT", `${base()}/file`, { path: bad, content: "x" })).status,
        400,
        `PUT file ${bad}`,
      );
      assert.equal(
        (await call("POST", `${base()}/directory`, { path: bad })).status,
        400,
        `directory ${bad}`,
      );
      assert.equal(
        (await call("POST", `${base()}/delete`, { path: bad })).status,
        400,
        `delete ${bad}`,
      );
      assert.equal(
        (await call("POST", `${base()}/move`, { from: "a.md", to: bad })).status,
        400,
        `move to ${bad}`,
      );
      assert.equal(
        (await call("POST", `${base()}/discard`, { paths: [bad] })).status,
        400,
        `discard ${bad}`,
      );
    }
  });

  test("nothing was written outside the checkout", () => {
    assert.equal(fs.existsSync(path.join(dataDir, "escape.md")), false);
  });

  test("a branch name that looks like a Git option is refused", async () => {
    const response = await call("POST", `${base()}/branches`, { name: "--upload-pack=id" });
    assert.equal(response.status, 400);
  });

  test("a revision that looks like a Git option is refused", async () => {
    const response = await call("GET", `${base()}/commits/--output%3D%2Ftmp%2Fx`);
    assert.equal(response.status, 400);
  });
});

// ─────────────────────────── request validation ─────────────────────────

describe("request validation", () => {
  test("rejects a body with unexpected keys", async () => {
    const response = await call("PUT", `${base()}/file`, {
      path: "a.md",
      content: "x",
      sneaky: true,
    });
    assert.equal(response.status, 400);
  });

  test("rejects a missing file path on read", async () => {
    assert.equal((await call("GET", `${base()}/file`)).status, 400);
  });

  test("rejects an empty commit message", async () => {
    assert.equal((await call("POST", `${base()}/commit`, { message: "" })).status, 400);
  });

  test("rejects a commit with nothing staged", async () => {
    const response = await call<{ error: string }>("POST", `${base()}/commit`, {
      message: "Nothing",
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /nothing to commit/i);
  });

  test("rejects discarding an empty list", async () => {
    assert.equal((await call("POST", `${base()}/discard`, { paths: [] })).status, 400);
  });
});

// ──────────────────────────── the happy path ────────────────────────────

describe("editing a repository through the API", () => {
  test("creates the checkout on first request, seeded with a README", async () => {
    const response = await call<{ entries: { name: string }[] }>("GET", `${base()}/tree`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.entries.map((entry) => entry.name),
      ["README.md"],
    );
  });

  test("writes, reads back, sees the change, commits, and finds it in history", async () => {
    await call("PUT", `${base()}/file`, { path: "docs/plan.md", content: "# Plan\n\nShip it.\n" });

    const read = await call<{ content: string; binary: boolean }>(
      "GET",
      `${base()}/file?path=docs%2Fplan.md`,
    );
    assert.equal(read.body.content, "# Plan\n\nShip it.\n");
    assert.equal(read.body.binary, false);

    const status = await call<{ changes: { path: string; status: string }[] }>(
      "GET",
      `${base()}/status`,
    );
    assert.deepEqual(status.body.changes, [
      { path: "docs/plan.md", fromPath: null, status: "untracked", staged: false },
    ]);

    const diff = await call<{ patch: string; insertions: number }>("GET", `${base()}/diff`);
    assert.match(diff.body.patch, /\+# Plan/);

    const commit = await call<{ committed: boolean; sha: string }>("POST", `${base()}/commit`, {
      message: "Add the plan",
    });
    assert.equal(commit.body.committed, true);

    const history = await call<{ commits: { subject: string; authorName: string }[] }>(
      "GET",
      `${base()}/history`,
    );
    assert.equal(history.body.commits[0].subject, "Add the plan");
    assert.equal(
      history.body.commits[0].authorName,
      "Member",
      "the commit is attributed to the Member who made it",
    );

    const detail = await call<{ patch: string }>("GET", `${base()}/commits/${commit.body.sha}`);
    assert.match(detail.body.patch, /\+Ship it\./);
  });

  test("creates a folder, moves a file into it, and deletes it again", async () => {
    await call("PUT", `${base()}/file`, { path: "note.md", content: "note\n" });
    assert.equal((await call("POST", `${base()}/directory`, { path: "archive" })).status, 200);
    assert.equal(
      (await call("POST", `${base()}/move`, { from: "note.md", to: "archive/note.md" })).status,
      200,
    );
    const listing = await call<{ entries: { path: string }[] }>(
      "GET",
      `${base()}/tree?path=archive`,
    );
    assert.deepEqual(listing.body.entries.map((e) => e.path).sort(), [
      "archive/.gitkeep",
      "archive/note.md",
    ]);
    assert.equal((await call("POST", `${base()}/delete`, { path: "archive/note.md" })).status, 200);
    assert.equal((await call("GET", `${base()}/file?path=archive%2Fnote.md`)).status, 400);
  });

  test("discards an unwanted edit", async () => {
    await call("PUT", `${base()}/file`, { path: "keep.md", content: "original\n" });
    await call("POST", `${base()}/commit`, { message: "Add it" });
    await call("PUT", `${base()}/file`, { path: "keep.md", content: "mistake\n" });
    assert.equal((await call("POST", `${base()}/discard`, { paths: ["keep.md"] })).status, 200);
    const read = await call<{ content: string }>("GET", `${base()}/file?path=keep.md`);
    assert.equal(read.body.content, "original\n");
  });

  test("branches, commits on the branch, and lists both", async () => {
    assert.equal((await call("POST", `${base()}/branches`, { name: "draft" })).status, 200);
    await call("PUT", `${base()}/file`, { path: "draft.md", content: "draft\n" });
    await call("POST", `${base()}/commit`, { message: "Start a draft" });

    const branches = await call<{ branches: { name: string; current: boolean }[] }>(
      "GET",
      `${base()}/branches`,
    );
    const names = branches.body.branches.map((b) => b.name).sort();
    assert.deepEqual(names, ["draft", "main"]);
    assert.equal(branches.body.branches.find((b) => b.name === "draft")?.current, true);

    assert.equal((await call("POST", `${base()}/checkout`, { name: "main" })).status, 200);
    assert.equal((await call("GET", `${base()}/file?path=draft.md`)).status, 400);
  });

  test("reports a file that is too large rather than trying to render it", async () => {
    const big = "x".repeat(300 * 1024);
    const response = await call<{ error: string }>("PUT", `${base()}/file`, {
      path: "big.txt",
      content: big,
    });
    assert.equal(response.status, 400, "the write cap rejects it before it reaches disk");
    // And it is rejected by our own cap, below the body-parser limit, so the
    // person gets an explanation rather than a bare 413.
    assert.ok(response.body.error);
  });
});

// ───────────────────────────── AI sessions ──────────────────────────────

describe("AI work sessions", () => {
  test("lists no candidates until an employee is granted the repository", async () => {
    const response = await call<{ employees: unknown[] }>(
      "GET",
      `/repositories/${repository.slug}/session-candidates`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.employees, []);
  });

  test("refuses to start a session for an unknown employee", async () => {
    const response = await call("POST", `/repositories/${repository.slug}/sessions`, {
      employeeId: "00000000-0000-4000-8000-000000000000",
      instruction: "Do something",
    });
    assert.equal(response.status, 400);
  });

  test("refuses a session with an empty instruction", async () => {
    const response = await call("POST", `/repositories/${repository.slug}/sessions`, {
      employeeId: employee.id,
      instruction: "",
    });
    assert.equal(response.status, 400);
  });

  test("starts with an empty session list", async () => {
    const response = await call<{ sessions: unknown[] }>(
      "GET",
      `/repositories/${repository.slug}/sessions`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.sessions, []);
  });

  test("reports a session that does not exist", async () => {
    const response = await call(
      "GET",
      `/repositories/${repository.slug}/sessions/00000000-0000-4000-8000-000000000000/diff`,
    );
    assert.equal(response.status, 400);
  });
});

// ─────────────────────── search and ignored files ───────────────────────

describe("search", () => {
  test("finds text and reports where it is", async () => {
    await call("PUT", `${base()}/file`, { path: "docs/plan.md", content: "Grow revenue.\n" });
    const response = await call<{ matches: { path: string; line: number }[] }>(
      "GET",
      `${base()}/search?q=revenue`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.matches.map((m) => m.path),
      ["docs/plan.md"],
    );
  });

  test("refuses an empty query", async () => {
    assert.equal((await call("GET", `${base()}/search?q=`)).status, 400);
  });
});

describe("the tree and ignored files", () => {
  test("hides ignored entries unless asked", async () => {
    await call("PUT", `${base()}/file`, { path: ".gitignore", content: "junk/\n" });
    await call("PUT", `${base()}/file`, { path: "junk/thing.txt", content: "x" });
    await call("PUT", `${base()}/file`, { path: "kept.md", content: "y" });

    const hidden = await call<{ entries: { name: string; ignored: boolean }[] }>(
      "GET",
      `${base()}/tree`,
    );
    assert.ok(!hidden.body.entries.some((e) => e.name === "junk"));

    const shown = await call<{ entries: { name: string; ignored: boolean }[] }>(
      "GET",
      `${base()}/tree?showIgnored=1`,
    );
    assert.equal(shown.body.entries.find((e) => e.name === "junk")?.ignored, true);
    assert.equal(shown.body.entries.find((e) => e.name === "kept.md")?.ignored, false);
  });
});

// ───────────────────────── connecting to a remote ───────────────────────

describe("connecting a local repository to a remote", () => {
  test("lists forge connections, empty when none are connected", async () => {
    const response = await call<{ connections: unknown[] }>(
      "GET",
      `/repositories/${repository.slug}/forge-connections`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.connections, []);
  });

  test("an ordinary member may not connect a remote", async () => {
    actingUserId = member.id;
    assert.equal(
      (
        await call("POST", `${base()}/connect-remote`, {
          gitUrl: "https://example.invalid/a/b.git",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("POST", `${base()}/connect-forge`, {
          connectionId: "00000000-0000-4000-8000-000000000000",
          name: "web",
        })
      ).status,
      403,
    );
  });

  test("refuses a clone URL that carries credentials", async () => {
    actingUserId = owner.id;
    const response = await call("POST", `${base()}/connect-remote`, {
      gitUrl: "https://user:secret@example.invalid/a/b.git",
    });
    assert.equal(response.status, 400);
  });

  test("refuses a repository name no forge would accept, without naming GitHub", async () => {
    actingUserId = owner.id;
    const response = await call<{ error: string; issues: Array<{ message: string }> }>(
      "POST",
      `${base()}/connect-forge`,
      {
        connectionId: "00000000-0000-4000-8000-000000000000",
        name: "not a valid name",
      },
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
    assert.ok(
      response.body.issues.some((issue) => /^Repository names may use letters/.test(issue.message)),
      "the rule the person broke has to be in the message",
    );
    // Someone connecting a self-hosted Forgejo is not helped by being told
    // what GitHub allows, and the rule is not GitHub's.
    assert.doesNotMatch(JSON.stringify(response.body), /GitHub/);
  });

  test("refuses to connect a repository that already has a remote", async () => {
    actingUserId = owner.id;
    const remote = await insert(Repository, {
      companyId: company.id,
      name: "Web",
      slug: "web",
      description: "",
      origin: "remote",
      kind: "code",
      gitUrl: "https://example.invalid/acme/web.git",
      defaultBranch: "main",
      authMode: "none",
      lastSyncStatus: "unknown",
      lastSyncError: "",
    });
    const response = await call<{ error: string }>(
      "POST",
      `/repositories/${remote.slug}/workspace/connect-remote`,
      { gitUrl: "https://example.invalid/acme/other.git" },
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error, /already has a remote/);
  });

  test("refuses HTTPS credentials without a token", async () => {
    actingUserId = owner.id;
    const response = await call("POST", `${base()}/connect-remote`, {
      gitUrl: "https://gitlab.example/acme/web.git",
      authMode: "https",
      httpsUsername: "oauth2",
    });
    assert.equal(response.status, 400);
  });

  test("refuses SSH without a key", async () => {
    actingUserId = owner.id;
    const response = await call("POST", `${base()}/connect-remote`, {
      gitUrl: "git@gitlab.example:acme/web.git",
      authMode: "ssh",
    });
    assert.equal(response.status, 400);
  });

  test("refuses HTTPS credentials on a non-https clone URL", async () => {
    actingUserId = owner.id;
    const response = await call<{ error: string }>("POST", `${base()}/connect-remote`, {
      gitUrl: "git@gitlab.example:acme/web.git",
      authMode: "https",
      token: "glpat-x",
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /plain https/);
  });

  test("reports an unknown Connection rather than failing obscurely", async () => {
    actingUserId = owner.id;
    const response = await call<{ error: string }>("POST", `${base()}/connect-forge`, {
      connectionId: "00000000-0000-4000-8000-000000000000",
      name: "web",
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /no longer available/);
  });

  test("refuses a Connection that is not a git forge at all", async () => {
    actingUserId = owner.id;
    // The picker only offers forges, so reaching here means a stale page or a
    // hand-made request — and creating a repository on Stripe is not a
    // mistake worth attempting.
    const stripe = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "stripe",
      label: "Billing",
      authMode: "apikey",
      encryptedConfig: encryptConnectionConfig(
        { apiKey: "rk_test" } as IntegrationConfig,
        company.id,
      ),
      accountHint: "acct_test",
      status: "connected",
      statusMessage: "",
      lastCheckedAt: null,
    });
    const response = await call<{ error: string }>("POST", `${base()}/connect-forge`, {
      connectionId: stripe.id,
      name: "web",
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /no longer available/);

    const stored = await reloadRepository();
    assert.equal(stored.origin, "local");
    assert.equal(stored.gitUrl, "");
  });

  test("the picker says which forge each Connection is and which server it is on", async () => {
    const github = await forgeConnection("github", "Work GitHub", {
      apiKey: "ghp_github_token",
      login: "acme",
    });
    const forgejo = await forgeConnection("forgejo", "Ops forge", {
      baseUrl: "https://git.example.test",
      apiKey: "forgejo-token",
      login: "ops-bot",
    });
    await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "stripe",
      label: "Billing",
      authMode: "apikey",
      encryptedConfig: encryptConnectionConfig(
        { apiKey: "rk_test" } as IntegrationConfig,
        company.id,
      ),
      accountHint: "acct_test",
      status: "connected",
      statusMessage: "",
      lastCheckedAt: null,
    });

    const response = await call<{ connections: Array<Record<string, unknown>> }>(
      "GET",
      `/repositories/${repository.slug}/forge-connections`,
    );
    assert.equal(response.status, 200);
    const byId = new Map(response.body.connections.map((entry) => [entry.id, entry]));
    assert.deepEqual(byId.get(github.id), {
      id: github.id,
      label: "Work GitHub",
      provider: "github",
      providerName: "GitHub",
      accountLogin: "acme",
      host: "github.com",
    });
    assert.deepEqual(byId.get(forgejo.id), {
      id: forgejo.id,
      label: "Ops forge",
      provider: "forgejo",
      providerName: "Forgejo",
      accountLogin: "ops-bot",
      // Two Forgejo Connections are told apart by this and nothing else, so a
      // picker that dropped it would be asking people to guess.
      host: "git.example.test",
    });
    assert.equal(
      response.body.connections.length,
      2,
      "a Connection that is not a git forge has no business in this list",
    );
  });

  test("a Connection whose server URL is unusable is left out rather than crashing the picker", async () => {
    // An operator can restore a database older than the base-URL field, or
    // one written by a broken connect. The list is not the place to find out.
    await forgeConnection("forgejo", "Restored from backup", { apiKey: "forgejo-token" });
    const good = await forgeConnection("forgejo", "Ops forge", {
      baseUrl: "https://git.example.test",
      apiKey: "forgejo-token",
      login: "ops-bot",
    });

    const response = await call<{ connections: Array<{ id: string }> }>(
      "GET",
      `/repositories/${repository.slug}/forge-connections`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.connections.map((entry) => entry.id),
      [good.id],
    );
  });
});

// ────────────────────── publishing to a git forge ───────────────────────

describe("publishing a Genosyn repository to a forge", () => {
  beforeEach(() => {
    actingUserId = owner.id;
  });

  test("creates the repository on the Connection's own server and pushes the history into it", async () => {
    const connection = await forgeConnection("forgejo", "Ops forge", {
      baseUrl: "https://git.example.test",
      apiKey: "forgejo-token",
      login: "ops-bot",
    });
    // Work the Member already did. Publishing has to carry it, not replace it.
    await call("PUT", `${base()}/file`, { path: "plan.md", content: "# Plan\n" });
    await call("POST", `${base()}/commit`, { message: "Add the plan" });

    const remoteUrl = await emptyRemote("published");
    stubForgeCreate(remoteUrl, "https://git.example.test/ops/published");

    const response = await call<{
      gitUrl: string;
      htmlUrl: string | null;
      branch: string;
      pushed: boolean;
    }>("POST", `${base()}/connect-forge`, {
      connectionId: connection.id,
      name: "published",
      private: true,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.gitUrl, remoteUrl);
    assert.equal(response.body.htmlUrl, "https://git.example.test/ops/published");
    assert.equal(response.body.branch, "main");
    assert.equal(response.body.pushed, true);

    assert.equal(forgeCalls.length, 1);
    const [created] = forgeCalls;
    assert.equal(created.url.href, "https://git.example.test/api/v1/user/repos");
    assert.equal(created.method, "POST");
    assert.equal(created.headers.get("authorization"), "token forgejo-token");
    assert.deepEqual(created.body, {
      name: "published",
      private: true,
      // Empty on purpose: an initial commit on the forge would make the very
      // push this route is about a non-fast-forward nobody can resolve.
      auto_init: false,
    });

    assert.equal(
      await remoteCommitSubject("published", "main"),
      "Add the plan",
      "the Member's work has to be on the remote, not just the row",
    );

    const stored = await reloadRepository();
    assert.equal(stored.origin, "remote");
    assert.equal(stored.gitUrl, remoteUrl);
    assert.equal(stored.githubConnectionId, connection.id);
    assert.equal(stored.lastSyncStatus, "ok");
    assert.equal(
      stored.defaultBranch,
      "main",
      "the branch that was pushed, not the account's preferred name for new repositories",
    );
  });

  test("publishes a repository nobody has opened in the editor yet", async () => {
    // Creating a Repository does not materialize its checkout — the editor
    // does, on first visit. Connecting one straight from settings is an
    // ordinary thing to do, and the seeded first commit is exactly what the
    // push is for.
    const connection = await forgeConnection("forgejo", "Ops forge", {
      baseUrl: "https://git.example.test",
      apiKey: "forgejo-token",
      login: "ops-bot",
    });
    const remoteUrl = await emptyRemote("unopened");
    stubForgeCreate(remoteUrl);

    const response = await call<{ pushed: boolean; branch: string; error?: string }>(
      "POST",
      `${base()}/connect-forge`,
      { connectionId: connection.id, name: "unopened" },
    );

    assert.equal(response.status, 200, response.body.error);
    assert.equal(response.body.pushed, true);
    assert.equal(await remoteCommitSubject("unopened", "main"), "Create repository");
  });

  test("the Connection is pinned before the push, not after it", async () => {
    // Two Connections on one server. Nothing but the pin can say which of them
    // speaks for the new remote, and the push resolves its own credential from
    // that pin — so a pin written after the push is a push that goes out
    // anonymous and fails on every private repository.
    //
    // The chosen Connection cannot name the account it authenticates as, so
    // the credential lookup refuses by name. Reaching that refusal at all is
    // the assertion: with the pin written later the two Connections are
    // indistinguishable, no credential is resolved, and the failure comes
    // from the network instead.
    const chosen = await forgeConnection("forgejo", "Deploy bot", {
      baseUrl: "https://git.example.test",
      apiKey: "forgejo-token",
      login: "",
    });
    await forgeConnection("forgejo", "Second account", {
      baseUrl: "https://git.example.test",
      apiKey: "other-token",
      login: "someone",
    });
    await call("GET", `${base()}/tree`);
    stubForgeCreate("https://git.example.test/ops/web.git");

    const response = await call<{ error: string }>("POST", `${base()}/connect-forge`, {
      connectionId: chosen.id,
      name: "web",
    });

    assert.equal(response.status, 400);
    assert.match(response.body.error, /Deploy bot/);
    assert.match(response.body.error, /does not know which account it authenticates as/);

    const stored = await reloadRepository();
    assert.equal(stored.origin, "local", "a publish that failed leaves the repository local");
    assert.equal(stored.gitUrl, "");
    assert.equal(stored.githubConnectionId, null);
  });

  test("a GitHub Connection still publishes, and is asked github.com", async () => {
    const connection = await forgeConnection("github", "Work GitHub", {
      apiKey: "ghp_github_token",
      login: "acme",
    });
    await call("GET", `${base()}/tree`);
    const remoteUrl = await emptyRemote("from-github");
    stubForgeCreate(remoteUrl);

    const response = await call<{ pushed: boolean; error?: string }>(
      "POST",
      `${base()}/connect-forge`,
      {
        connectionId: connection.id,
        name: "from-github",
        owner: "acme labs",
        private: false,
      },
    );

    assert.equal(response.status, 200, response.body.error);
    assert.equal(response.body.pushed, true);
    const [created] = forgeCalls;
    assert.equal(created.url.href, "https://api.github.com/orgs/acme%20labs/repos");
    assert.equal(created.headers.get("authorization"), "Bearer ghp_github_token");
    assert.equal(created.headers.get("x-github-api-version"), "2022-11-28");
    assert.deepEqual(created.body, { name: "from-github", private: false, auto_init: false });
    assert.equal((await reloadRepository()).githubConnectionId, connection.id);
  });

  test("refuses to publish a repository that already has a remote", async () => {
    const connection = await forgeConnection("forgejo", "Ops forge", {
      baseUrl: "https://git.example.test",
      apiKey: "forgejo-token",
      login: "ops-bot",
    });
    const remote = await insert(Repository, {
      companyId: company.id,
      name: "Web",
      slug: "web",
      description: "",
      origin: "remote",
      kind: "code",
      gitUrl: "https://git.example.test/ops/web.git",
      defaultBranch: "main",
      authMode: "none",
      lastSyncStatus: "unknown",
      lastSyncError: "",
    });
    stubForgeCreate(`${forgeOrigin}/never-created.git`);

    const response = await call<{ error: string }>(
      "POST",
      `/repositories/${remote.slug}/workspace/connect-forge`,
      { connectionId: connection.id, name: "web" },
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error, /already has a remote/);
    assert.deepEqual(forgeCalls, [], "nothing may be created on the forge before that check");
  });

  test("a forge that refuses to create the repository is reported, and nothing is pushed", async () => {
    const connection = await forgeConnection("forgejo", "Ops forge", {
      baseUrl: "https://git.example.test",
      apiKey: "forgejo-token",
      login: "ops-bot",
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "repository already exists" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const response = await call<{ error: string }>("POST", `${base()}/connect-forge`, {
      connectionId: connection.id,
      name: "taken",
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /repository already exists/);

    const stored = await reloadRepository();
    assert.equal(stored.origin, "local");
    assert.equal(stored.githubConnectionId, null);
  });
});
