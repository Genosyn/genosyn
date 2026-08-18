import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { repositoryContentRouter } from "./repositoryContent.js";

/**
 * Route contract for working inside a Repository.
 *
 * Two things this file exists to pin down, because both are easy to lose in a
 * refactor and expensive to lose in production:
 *
 *   1. **Who may do what.** Editing and committing are Member-level; pushing
 *      and pulling are admin-only. The old Code section admin-gated every
 *      mutation, and quietly reverting to that would make a repository of
 *      strategy documents unusable for the people who write them — while
 *      quietly opening up push would let any Member publish to production.
 *   2. **Paths cannot escape.** Every endpoint that takes a path is a
 *      traversal vector, and each one has to refuse independently.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let dataDir: string;
const originalDataDir = config.dataDir;
const originalMultiTenant = config.security.multiTenant;

before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-routes-"));
  (config as { dataDir: string }).dataDir = dataDir;

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
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  (config.security as { multiTenant: boolean }).multiTenant = originalMultiTenant;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let company: Company;
let otherCompany: Company;
let owner: User;
let member: User;
let outsider: User;
let repository: Repository;
let employee: AIEmployee;

beforeEach(async () => {
  await resetTestDb();
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
  const response = await fetch(`${baseUrl}/api/companies/${companyId ?? company.id}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const base = () => `/repositories/${repository.slug}/workspace`;

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
  test("creates the checkout on first request", async () => {
    const response = await call<{ entries: unknown[] }>("GET", `${base()}/tree`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.entries, []);
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
    assert.equal(
      (await call("POST", `${base()}/delete`, { path: "archive/note.md" })).status,
      200,
    );
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
