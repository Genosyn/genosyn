import { persistTestSession } from "../test/userSession.js";
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
import { Company } from "../db/entities/Company.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import {
  RepositoryWorkSession,
  type RepositoryWorkSessionStatus,
} from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionEvent } from "../db/entities/RepositoryWorkSessionEvent.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { repositoryCheckoutExists } from "../services/repositoryWorkspace.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { repositoryContentRouter } from "./repositoryContent.js";

/**
 * The one request the Repository Overview page is built on.
 *
 * `services/repositoryAiOverview.ts` is covered as arithmetic over rows. What
 * only exists here is the HTTP contract the page reads: the eight fields it
 * draws, that an ordinary Member may ask for them — this is a read, the same
 * class as the session list — and that a session filed out of the inbox still
 * counts even though it is no longer listed.
 *
 * The last group is the one worth keeping honest. The route is mounted with
 * `workspace: false`, so a repository whose remote resolves nowhere still
 * answers what its employees did — a question that has nothing to do with the
 * files on disk. That is a one-word option somebody could drop while tidying,
 * so it is pinned here rather than assumed.
 */

let server: Server;
let baseUrl = "";
let dataDir: string;
const originalDataDir = config.dataDir;
let actingUserId: string | null = null;
const codingTools = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const originalCodingTools = { ...codingTools };

before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-ai-overview-routes-"));
  (config as { dataDir: string }).dataDir = dataDir;
  // Same reason the work-session route tests do this: no server boots here, so
  // the shipped `bubblewrap` default would send every Git child through a
  // sandbox this host may not have. Pin the mode `resolveCodingExecutionMode`
  // settles on wherever bubblewrap cannot run, so this file pins the route
  // contract rather than the host's user-namespace policy.
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.allowUnsafeHostExecution = false;
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
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
  Object.assign(codingTools, originalCodingTools);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let company: Company;
let owner: User;
let member: User;
let outsider: User;
let employee: AIEmployee;
let repository: Repository;

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
  actingUserId = member.id;
});

type OverviewBody = {
  counts: {
    total: number;
    running: number;
    attention: number;
    completed: number;
    archived: number;
  };
  landed: { sessions: number; filesChanged: number; insertions: number; deletions: number };
  totals: { turns: number; discarded: number };
  lastActiveAt: string | null;
  employees: Array<{
    employeeId: string;
    sessions: number;
    landed: number;
    lastActiveAt: string | null;
  }>;
  capped: boolean;
  sessions: Array<{ id: string; status: string; employee: { name: string } | null }>;
  activity: Array<{
    sessionId: string;
    summary: string;
    at: string | null;
    steps: { done: number; total: number; current: string | null } | null;
    toolCalls: number;
  }>;
};

const overviewUrl = (slug = "strategy") =>
  `${baseUrl}/api/companies/${company.id}/repositories/${slug}/ai-overview`;

async function call(
  method: "GET" | "POST",
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

/** The digest, as the page reads it. Every test here goes through the wire. */
async function overview(): Promise<OverviewBody> {
  const result = await call("GET", overviewUrl());
  assert.equal(result.status, 200);
  return result.body as unknown as OverviewBody;
}

async function seedSession(
  values: Partial<RepositoryWorkSession> & { status: RepositoryWorkSessionStatus },
): Promise<RepositoryWorkSession> {
  return insert(RepositoryWorkSession, {
    companyId: company.id,
    repositoryId: repository.id,
    employeeId: employee.id,
    requestedByUserId: member.id,
    title: values.status,
    instruction: "Rewrite the plan",
    turnCount: 1,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    ...values,
  });
}

/** One session per outcome the page draws, with a distinct turn count each. */
async function seedEveryOutcome(): Promise<Record<string, RepositoryWorkSession>> {
  return {
    running: await seedSession({ status: "running", turnCount: 1 }),
    ready: await seedSession({ status: "ready", turnCount: 2 }),
    archived: await seedSession({
      status: "ready",
      turnCount: 3,
      archivedAt: new Date("2024-05-01T00:00:00.000Z"),
    }),
    published: await seedSession({
      status: "published",
      turnCount: 4,
      filesChanged: 3,
      insertions: 40,
      deletions: 5,
    }),
    discarded: await seedSession({
      status: "discarded",
      turnCount: 5,
      filesChanged: 9,
      insertions: 90,
      deletions: 90,
    }),
  };
}

describe("reading the digest", () => {
  test("answers with every field the Overview page draws", async () => {
    await seedEveryOutcome();
    const result = await call("GET", overviewUrl());
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), [
      "activity",
      "capped",
      "counts",
      "employees",
      "landed",
      "lastActiveAt",
      "sessions",
      "totals",
    ]);
    const body = result.body as unknown as OverviewBody;
    assert.equal(body.capped, false);
    assert.match(String(body.lastActiveAt), /^\d{4}-\d{2}-\d{2}T/);
  });

  test("an ordinary Member may read it — it is not an admin surface", async () => {
    await seedSession({ status: "ready" });
    actingUserId = member.id;
    const body = await overview();
    assert.equal(body.counts.attention, 1);
  });

  test("a non-member gets nothing", async () => {
    actingUserId = outsider.id;
    const result = await call("GET", overviewUrl());
    assert.equal(result.status, 403);
  });

  test("a signed-out request does not get the digest", async () => {
    actingUserId = null;
    const result = await call("GET", overviewUrl());
    assert.equal(result.status, 401);
  });

  test("an unknown repository is not found", async () => {
    const result = await call("GET", overviewUrl("no-such-repository"));
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Repository not found");
  });
});

describe("what the digest says about the rows", () => {
  test("counts every session once and splits them by outcome", async () => {
    await seedEveryOutcome();
    const body = await overview();
    assert.deepEqual(body.counts, {
      total: 5,
      running: 1,
      attention: 1,
      completed: 2,
      archived: 1,
    });
    // The four buckets are a partition of `total`, which is the only reason the
    // numbers on the page can be read as parts of one whole.
    const { running, attention, completed, archived, total } = body.counts;
    assert.equal(running + attention + completed + archived, total);
  });

  test("an archived session is counted but not listed", async () => {
    const seeded = await seedEveryOutcome();
    const body = await overview();
    assert.deepEqual(
      body.sessions.map((row) => row.id).sort(),
      [seeded.running.id, seeded.ready.id, seeded.published.id, seeded.discarded.id].sort(),
    );
    assert.equal(
      body.sessions.some((row) => row.id === seeded.archived.id),
      false,
    );
    assert.equal(body.counts.archived, 1);
    assert.equal(body.counts.total, 5);
  });

  test("only accepted work counts as landed", async () => {
    await seedEveryOutcome();
    const body = await overview();
    // The published session alone. The discarded one's nine files never reached
    // the repository, however much the employee typed into them.
    assert.deepEqual(body.landed, { sessions: 1, filesChanged: 3, insertions: 40, deletions: 5 });
    // Turns are counted across every session, archived ones included — the
    // instruction was still given.
    assert.deepEqual(body.totals, { turns: 15, discarded: 1 });
  });

  test("credits the employee for all of its work, listed or not", async () => {
    await seedEveryOutcome();
    const body = await overview();
    assert.equal(body.employees.length, 1);
    assert.equal(body.employees[0].employeeId, employee.id);
    assert.equal(body.employees[0].sessions, 5);
    assert.equal(body.employees[0].landed, 1);
    assert.match(String(body.employees[0].lastActiveAt), /^\d{4}-\d{2}-\d{2}T/);
  });

  test("names the employee on each listed session, the way the list route does", async () => {
    await seedSession({ status: "ready" });
    const body = await overview();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].employee?.name, "Ada");
  });

  test("another repository's sessions are not counted here", async () => {
    await seedEveryOutcome();
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
    await insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: other.id,
      employeeId: employee.id,
      requestedByUserId: member.id,
      title: "Elsewhere",
      instruction: "Elsewhere",
      status: "published",
      turnCount: 7,
      filesChanged: 11,
      insertions: 11,
      deletions: 11,
    });
    const body = await overview();
    assert.equal(body.counts.total, 5);
    assert.deepEqual(body.landed, { sessions: 1, filesChanged: 3, insertions: 40, deletions: 5 });
    assert.equal(body.totals.turns, 15);
  });

  test("says nothing rather than guessing where no employee has worked", async () => {
    const body = await overview();
    assert.deepEqual(body.counts, {
      total: 0,
      running: 0,
      attention: 0,
      completed: 0,
      archived: 0,
    });
    assert.deepEqual(body.sessions, []);
    assert.deepEqual(body.activity, []);
    assert.deepEqual(body.employees, []);
    assert.equal(body.lastActiveAt, null);
  });
});

describe("the live line for a turn in flight", () => {
  test("comes back with the newest readable event and the employee's own progress", async () => {
    const session = await seedSession({ status: "running" });
    const turn = await insert(RepositoryWorkSessionTurn, {
      companyId: company.id,
      sessionId: session.id,
      ordinal: 1,
      instruction: "Rewrite the plan",
      reply: "",
      status: "running",
      requestedByUserId: member.id,
    });
    const event = (values: Partial<RepositoryWorkSessionEvent>) =>
      insert(RepositoryWorkSessionEvent, {
        companyId: company.id,
        repositoryId: repository.id,
        sessionId: session.id,
        turnId: turn.id,
        summary: "",
        detailJson: "",
        ...values,
      });
    await event({
      ordinal: 1,
      kind: "text",
      detailJson: JSON.stringify({ text: "I will start with the plan." }),
    });
    await event({ ordinal: 2, kind: "tool_use", name: "read_file", summary: "Read docs/plan.md" });
    await event({ ordinal: 3, kind: "tool_result", summary: "Ran npm test → Exit 1" });
    await event({
      ordinal: 4,
      kind: "steps",
      summary: "Updated the plan",
      detailJson: JSON.stringify({
        steps: [
          { text: "Read the plan", status: "completed" },
          { text: "Rewrite it", status: "in_progress" },
          { text: "Run the tests", status: "pending" },
        ],
      }),
    });

    const body = await overview();
    assert.equal(body.activity.length, 1);
    const line = body.activity[0];
    assert.equal(line.sessionId, session.id);
    // The newest event is the step update, and its summary is deliberately not
    // the line — the progress beside it already says that. The tool result
    // under it is the newest thing that tells a reader something else.
    assert.equal(line.summary, "Ran npm test → Exit 1");
    assert.deepEqual(line.steps, { done: 1, total: 3, current: "Rewrite it" });
    assert.equal(line.toolCalls, 1);
    assert.match(String(line.at), /^\d{4}-\d{2}-\d{2}T/);
  });

  test("a session nobody is working on gets no live line", async () => {
    await seedSession({ status: "ready" });
    const body = await overview();
    assert.equal(body.sessions.length, 1);
    assert.deepEqual(body.activity, []);
  });
});

describe("a remote that cannot be reached", () => {
  /** RFC 6761 reserves `.invalid`, so this fails in DNS rather than dialing out. */
  const unreachable = "https://genosyn.invalid/acme/strategy.git";

  beforeEach(async () => {
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      { origin: "remote", gitUrl: unreachable },
    );
  });

  test("does not stop the page from saying what the employees did", async () => {
    await seedEveryOutcome();
    const body = await overview();
    assert.equal(body.counts.total, 5);
    // The point of `workspace: false`: no clone was attempted at all, so there
    // is still nothing on disk for this repository.
    const row = await AppDataSource.getRepository(Repository).findOneByOrFail({
      id: repository.id,
    });
    assert.equal(row.gitUrl, unreachable);
    assert.equal(repositoryCheckoutExists(row), false);
  });

  test("the workspace routes on the same repository do fail — the digest is the exception", async () => {
    // Without this the test above proves nothing: it would pass just as well on
    // a remote that happened to be reachable.
    const result = await call(
      "GET",
      `${baseUrl}/api/companies/${company.id}/repositories/strategy/workspace/status`,
    );
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /clone/);
  });
});
