import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { repositoryContentRouter } from "./repositoryContent.js";

/**
 * The HTTP surface an open work session is driven through.
 *
 * The service tests already cover what a revision *does*. What only shows up
 * here is the contract the page depends on: that the transcript comes back
 * with the session, that a follow-up answers before the turn has finished so
 * the composer can clear itself, and that the two operations which reach the
 * remote stay behind the admin gate while the collaborative ones do not.
 *
 * The model turn is never reached — every test drives a session whose row
 * already exists, so no chat runtime is needed.
 */

let server: Server;
let baseUrl = "";
let dataDir: string;
const originalDataDir = config.dataDir;
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-session-routes-"));
  (config as { dataDir: string }).dataDir = dataDir;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
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
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let company: Company;
let owner: User;
let member: User;
let outsider: User;
let employee: AIEmployee;
let repository: Repository;
let session: RepositoryWorkSession;

beforeEach(async () => {
  await resetTestDb();
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
  outsider = await insert(User, {
    email: "outsider@example.com",
    name: "Outsider",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Engineer",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-test",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
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
    committerName: "Genosyn",
    committerEmail: "repositories@genosyn.local",
    lastSyncStatus: "unknown",
    lastSyncError: "",
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "write",
  });
  session = await insert(RepositoryWorkSession, {
    companyId: company.id,
    repositoryId: repository.id,
    employeeId: employee.id,
    requestedByUserId: member.id,
    title: "Rewrite the plan",
    instruction: "Rewrite the plan",
    status: "ready",
    branch: "genosyn/ada/abcdef12",
    baseCommit: "aaaa",
    headCommit: "bbbb",
    reply: "Done.",
    turnCount: 1,
    filesChanged: 1,
    insertions: 2,
    deletions: 0,
  });
  await insert(RepositoryWorkSessionTurn, {
    companyId: company.id,
    sessionId: session.id,
    ordinal: 1,
    instruction: "Rewrite the plan",
    reply: "Done.",
    status: "ok",
    requestedByUserId: member.id,
    baseCommit: "aaaa",
    headCommit: "bbbb",
    filesChanged: 1,
    insertions: 2,
  });
  actingUserId = member.id;
});

const sessionsUrl = () => `${baseUrl}/api/companies/${company.id}/repositories/strategy/sessions`;

async function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("reading a session", () => {
  test("returns the session with its whole transcript", async () => {
    const result = await call("GET", `${sessionsUrl()}/${session.id}`);
    assert.equal(result.status, 200);
    const detail = result.body as {
      session: { id: string; title: string; turnCount: number; employee: { name: string } | null };
      turns: Array<{ ordinal: number; instruction: string; status: string }>;
    };
    assert.equal(detail.session.id, session.id);
    assert.equal(detail.session.title, "Rewrite the plan");
    assert.equal(detail.session.turnCount, 1);
    assert.equal(detail.session.employee?.name, "Ada");
    assert.deepEqual(detail.turns.map((turn) => turn.ordinal), [1]);
    assert.equal(detail.turns[0].status, "ok");
  });

  test("the list stays light — no transcripts in it", async () => {
    const result = await call("GET", sessionsUrl());
    assert.equal(result.status, 200);
    const rows = (result.body as { sessions: Array<Record<string, unknown>> }).sessions;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Rewrite the plan");
    assert.equal("turns" in rows[0], false);
  });

  test("a session from another repository is not found", async () => {
    const other = await insert(Repository, {
      companyId: company.id,
      name: "Other",
      slug: "other",
      description: "",
      origin: "local",
      kind: "code",
      gitUrl: "",
      defaultBranch: "main",
      authMode: "none",
      lastSyncStatus: "unknown",
      lastSyncError: "",
    });
    const result = await call(
      "GET",
      `${baseUrl}/api/companies/${company.id}/repositories/${other.slug}/sessions/${session.id}`,
    );
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /not found/);
  });

  test("a non-member gets nothing", async () => {
    actingUserId = outsider.id;
    const result = await call("GET", `${sessionsUrl()}/${session.id}`);
    assert.equal(result.status, 403);
  });
});

describe("renaming a session", () => {
  test("an ordinary Member may rename one", async () => {
    const result = await call("PATCH", `${sessionsUrl()}/${session.id}`, { title: "The plan" });
    assert.equal(result.status, 200);
    assert.equal(result.body.title, "The plan");
    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(row.title, "The plan");
  });

  test("refuses an empty name", async () => {
    const result = await call("PATCH", `${sessionsUrl()}/${session.id}`, { title: "" });
    assert.equal(result.status, 400);
  });
});

describe("asking for changes", () => {
  test("answers with the session and its transcript before the turn finishes", async () => {
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Also mention the risks",
    });
    assert.equal(result.status, 200);
    const detail = result.body as {
      session: { status: string; turnCount: number };
      turns: Array<{ ordinal: number; instruction: string }>;
    };
    // The turn itself cannot complete here — there is no model — but the row
    // the page renders must already be there, which is the contract.
    assert.equal(detail.session.turnCount, 2);
    assert.equal(detail.turns.length, 2);
    assert.equal(detail.turns[1].instruction, "Also mention the risks");
  });

  test("an ordinary Member may ask — it is not an admin action", async () => {
    actingUserId = member.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Tighten it",
    });
    assert.equal(result.status, 200);
  });

  test("refuses an empty instruction", async () => {
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, { instruction: "" });
    assert.equal(result.status, 400);
  });

  test("refuses a session that has already been accepted", async () => {
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { status: "published" },
    );
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "One more thing",
    });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /already been accepted/);
  });

  test("refuses while a turn is in flight", async () => {
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { status: "running" },
    );
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Hurry up",
    });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /still working/);
  });

  test("a Member who has never changed their password may still ask", async () => {
    // `sessionVersion` is 0 until a password reset moves it, and a truthiness
    // check on it used to refuse exactly those Members — which is most of them.
    const row = await AppDataSource.getRepository(User).findOneByOrFail({ id: member.id });
    assert.equal(row.sessionVersion, 0);
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Carry on",
    });
    assert.notEqual(result.status, 400);
    assert.equal(result.status, 200);
  });

  test("a non-member cannot drive someone else's session", async () => {
    actingUserId = outsider.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Mine now",
    });
    assert.equal(result.status, 403);
    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(row.turnCount, 1);
  });
});

describe("proposing the work to GitHub", () => {
  test("an ordinary Member cannot reach the remote", async () => {
    actingUserId = member.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/pull-request`, {});
    assert.equal(result.status, 403);
    assert.match(String(result.body.error), /admin company role required/);
  });

  test("an admin gets as far as the repository's own refusal", async () => {
    actingUserId = owner.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/pull-request`, {});
    // This repository is local, so there is nowhere to propose anything — the
    // point is that the request was allowed through to the service.
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /nowhere to open a pull request/);
  });
});
