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
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import {
  RepositoryWorkSessionEvent,
  type RepositoryWorkSessionEventKind,
} from "../db/entities/RepositoryWorkSessionEvent.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  SessionActivityRecorder,
  nextSessionEventOrdinal,
  registerRunningSessionTurn,
  unregisterRunningSessionTurn,
} from "../services/repositoryWorkSessionActivity.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { repositoryContentRouter } from "./repositoryContent.js";

/**
 * The two routes the open session's page uses while a turn is running: the
 * activity feed it reads incrementally, and the Stop button.
 *
 * Neither needs a model or a worktree. The feed is rows; the stop is a lookup
 * in the process-local registry of running turns. So every session here is a
 * row inserted straight into the database, and a "running" turn is a recorder
 * and an abort controller registered by hand — exactly what the run path
 * registers, without the run.
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-session-events-"));
  (config as { dataDir: string }).dataDir = dataDir;
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.allowUnsafeHostExecution = false;
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
  Object.assign(codingTools, originalCodingTools);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let company: Company;
let owner: User;
let member: User;
let outsider: User;
let employee: AIEmployee;
let repository: Repository;
let session: RepositoryWorkSession;
let turn: RepositoryWorkSessionTurn;

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
  repository = await insertRepository(company.id, "Strategy", "strategy");
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
  });
  turn = await insert(RepositoryWorkSessionTurn, {
    companyId: company.id,
    sessionId: session.id,
    ordinal: 1,
    instruction: "Rewrite the plan",
    reply: "Done.",
    status: "ok",
    requestedByUserId: member.id,
    baseCommit: "aaaa",
    headCommit: "bbbb",
  });
  actingUserId = member.id;
});

function insertRepository(companyId: string, name: string, slug: string): Promise<Repository> {
  return insert(Repository, {
    companyId,
    name,
    slug,
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
}

const sessionUrl = (companyId = company.id, slug = "strategy", sessionId = session.id) =>
  `${baseUrl}/api/companies/${companyId}/repositories/${slug}/sessions/${sessionId}`;

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

type EventRow = {
  id: string;
  turnId: string;
  ordinal: number;
  kind: string;
  name: string;
  callId: string;
  summary: string;
  detail: unknown;
  isError: boolean;
  createdAt: string;
};

async function listEvents(
  query = "",
): Promise<{ status: number; events: EventRow[]; more: boolean; body: Record<string, unknown> }> {
  const result = await call("GET", `${sessionUrl()}/events${query}`);
  const body = result.body as { events?: EventRow[]; more?: boolean };
  return {
    status: result.status,
    events: body.events ?? [],
    more: body.more ?? false,
    body: result.body,
  };
}

/** Five events the way a turn writes them, ordinals 1..5. */
async function seedEvents(sessionId = session.id, turnId = turn.id): Promise<void> {
  const rows: Array<Partial<RepositoryWorkSessionEvent>> = [
    { ordinal: 1, kind: "text", summary: "", detailJson: JSON.stringify({ text: "Let me look." }) },
    {
      ordinal: 2,
      kind: "tool_use",
      name: "repository_read_file",
      callId: "call-1",
      summary: "Read docs/plan.md",
      detailJson: JSON.stringify({ input: { path: "docs/plan.md" } }),
    },
    {
      ordinal: 3,
      kind: "tool_result",
      name: "repository_read_file",
      callId: "call-1",
      summary: "5 lines",
      detailJson: JSON.stringify({ output: "   1\t# Plan" }),
    },
    {
      ordinal: 4,
      kind: "steps",
      summary: "0 of 1 steps done",
      detailJson: JSON.stringify({ steps: [{ text: "Edit it", status: "in_progress" }] }),
    },
    {
      ordinal: 5,
      kind: "tool_result",
      name: "repository_edit_file",
      callId: "call-2",
      summary: "old_string was not found in docs/plan.md.",
      detailJson: "",
      isError: true,
    },
  ];
  for (const row of rows) {
    await insert(RepositoryWorkSessionEvent, {
      companyId: company.id,
      repositoryId: repository.id,
      sessionId,
      turnId,
      name: "",
      callId: "",
      isError: false,
      ...row,
      kind: row.kind as RepositoryWorkSessionEventKind,
    });
  }
}

// ───────────────────────────── the feed ─────────────────────────────────

describe("reading a session's activity", () => {
  test("a fresh session has an empty feed and nothing more to fetch", async () => {
    const result = await listEvents();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { events: [], more: false });
  });

  test("returns what happened after the ordinal the client already holds", async () => {
    await seedEvents();
    const result = await listEvents("?after=2");
    assert.equal(result.status, 200);
    assert.equal(result.more, false);
    assert.deepEqual(
      result.events.map((event) => event.ordinal),
      [3, 4, 5],
    );

    const [toolResult, steps, failed] = result.events;
    assert.equal(toolResult.kind, "tool_result");
    assert.equal(toolResult.name, "repository_read_file");
    assert.equal(toolResult.callId, "call-1");
    assert.equal(toolResult.turnId, turn.id);
    assert.equal(toolResult.summary, "5 lines");
    assert.deepEqual(
      toolResult.detail,
      { output: "   1\t# Plan" },
      "detail is parsed, not a string",
    );
    assert.equal(toolResult.isError, false);
    assert.ok(toolResult.id);
    assert.ok(toolResult.createdAt);

    assert.equal(steps.kind, "steps");
    assert.deepEqual(steps.detail, { steps: [{ text: "Edit it", status: "in_progress" }] });

    assert.equal(failed.isError, true);
    assert.equal(failed.detail, null, "no detail is null, not an empty string");
  });

  test("everything from the start when the client holds nothing", async () => {
    await seedEvents();
    const result = await listEvents();
    assert.deepEqual(
      result.events.map((event) => event.ordinal),
      [1, 2, 3, 4, 5],
    );
    assert.equal(result.more, false);
    assert.deepEqual(result.events[0].detail, { text: "Let me look." });
  });

  test("a limit says whether there is more to fetch", async () => {
    await seedEvents();
    const first = await listEvents("?limit=2");
    assert.equal(first.status, 200);
    assert.deepEqual(
      first.events.map((event) => event.ordinal),
      [1, 2],
    );
    assert.equal(first.more, true);

    const next = await listEvents(`?after=${first.events.at(-1)?.ordinal}&limit=2`);
    assert.deepEqual(
      next.events.map((event) => event.ordinal),
      [3, 4],
    );
    assert.equal(next.more, true);

    const last = await listEvents("?after=4&limit=2");
    assert.deepEqual(
      last.events.map((event) => event.ordinal),
      [5],
    );
    assert.equal(last.more, false);

    const exact = await listEvents("?limit=5");
    assert.equal(exact.events.length, 5);
    assert.equal(exact.more, false, "a page that ends exactly at the end has no more");
  });

  test("rejects a query it does not understand rather than guessing", async () => {
    for (const query of [
      "?after=abc",
      "?after=-1",
      "?after=1.5",
      "?limit=0",
      "?limit=1001",
      "?limit=x",
      "?foo=1",
    ]) {
      const result = await listEvents(query);
      assert.equal(result.status, 400, query);
      assert.equal(result.body.error, "ValidationError", query);
    }
  });

  test("does not mix in another session's events", async () => {
    await seedEvents();
    const other = await insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: repository.id,
      employeeId: employee.id,
      requestedByUserId: member.id,
      title: "Other",
      instruction: "Other",
      status: "ready",
    });
    await insert(RepositoryWorkSessionEvent, {
      companyId: company.id,
      repositoryId: repository.id,
      sessionId: other.id,
      turnId: "other-turn",
      ordinal: 1,
      kind: "text",
      summary: "",
      detailJson: JSON.stringify({ text: "not yours" }),
    });
    const result = await listEvents();
    assert.equal(result.events.length, 5);
    assert.ok(result.events.every((event) => event.turnId === turn.id));
  });

  test("a session of another repository is not found", async () => {
    await insertRepository(company.id, "Other", "other");
    const result = await call("GET", `${sessionUrl(company.id, "other")}/events`);
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /not found/);
  });

  test("a session of another company is not found, even through a same-named repository", async () => {
    const elsewhere = await insert(Company, {
      name: "Elsewhere",
      slug: "elsewhere",
      ownerId: member.id,
    });
    await insert(Membership, { companyId: elsewhere.id, userId: member.id, role: "owner" as Role });
    await insertRepository(elsewhere.id, "Strategy", "strategy");
    const result = await call("GET", `${sessionUrl(elsewhere.id)}/events`);
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /not found/);
  });

  test("a non-member gets nothing", async () => {
    actingUserId = outsider.id;
    const result = await call("GET", `${sessionUrl()}/events`);
    assert.equal(result.status, 403);
  });
});

// ───────────────────────────── stopping ─────────────────────────────────

describe("stopping a turn", () => {
  async function markRunning(): Promise<void> {
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { status: "running" },
    );
  }

  /** What the run path registers, built by hand. */
  async function registerTurn(): Promise<{
    controller: AbortController;
    recorder: SessionActivityRecorder;
  }> {
    const recorder = new SessionActivityRecorder(
      {
        companyId: company.id,
        repositoryId: repository.id,
        sessionId: session.id,
        turnId: turn.id,
      },
      await nextSessionEventOrdinal(session.id),
    );
    const controller = new AbortController();
    registerRunningSessionTurn(session.id, { controller, recorder, stoppedByUserId: null });
    return { controller, recorder };
  }

  async function stopAudits(): Promise<AuditEvent[]> {
    return AppDataSource.getRepository(AuditEvent).findBy({
      companyId: company.id,
      action: "repository.work_session_stop",
    });
  }

  test("refuses a session that is not working", async () => {
    const result = await call("POST", `${sessionUrl()}/stop`, {});
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /not working right now/);
    assert.equal((await stopAudits()).length, 0, "a refused stop is not audited as one");
  });

  test("says so when no process is running the turn", async () => {
    await markRunning();
    const result = await call("POST", `${sessionUrl()}/stop`, {});
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /cannot be stopped from here/);
    assert.equal((await stopAudits()).length, 0);
    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(row.status, "running", "the row is left for the process that owns it");
  });

  test("aborts the registered turn, records the stop, and audits who did it", async () => {
    await markRunning();
    await seedEvents();
    const { controller, recorder } = await registerTurn();
    try {
      const result = await call("POST", `${sessionUrl()}/stop`, {});
      assert.equal(result.status, 200);
      assert.equal(result.body.id, session.id);
      // The turn is told to stop; it is the turn's own finish that changes the
      // status, so the row still says running for now.
      assert.equal(result.body.status, "running");
      assert.equal(controller.signal.aborted, true);

      await recorder.finish();
      const stopped = await AppDataSource.getRepository(RepositoryWorkSessionEvent).findBy({
        sessionId: session.id,
        kind: "stopped",
      });
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0].ordinal, 6, "the stop follows what the turn had already written");
      assert.equal(stopped[0].turnId, turn.id);
      assert.equal(stopped[0].summary, "Stopped by a Member");
      assert.deepEqual(JSON.parse(stopped[0].detailJson), { userId: member.id });

      const feed = await listEvents("?after=5");
      assert.deepEqual(
        feed.events.map((event) => [event.kind, event.detail]),
        [["stopped", { userId: member.id }]],
      );

      const audits = await stopAudits();
      assert.equal(audits.length, 1);
      assert.equal(audits[0].actorUserId, member.id);
      assert.equal(audits[0].actorKind, "user");
      assert.equal(audits[0].targetType, "repository");
      assert.equal(audits[0].targetId, repository.id);
      assert.equal(audits[0].targetLabel, "Strategy");
      assert.deepEqual(JSON.parse(audits[0].metadataJson), {
        sessionId: session.id,
        employeeId: employee.id,
      });
    } finally {
      unregisterRunningSessionTurn(session.id);
    }
  });

  test("a second stop is harmless and does not record a second one", async () => {
    await markRunning();
    const { controller, recorder } = await registerTurn();
    try {
      const first = await call("POST", `${sessionUrl()}/stop`, {});
      assert.equal(first.status, 200);
      actingUserId = owner.id;
      const second = await call("POST", `${sessionUrl()}/stop`, {});
      assert.equal(second.status, 200);
      assert.equal(controller.signal.aborted, true);

      await recorder.finish();
      const stopped = await AppDataSource.getRepository(RepositoryWorkSessionEvent).findBy({
        sessionId: session.id,
        kind: "stopped",
      });
      assert.equal(stopped.length, 1);
      assert.deepEqual(
        JSON.parse(stopped[0].detailJson),
        { userId: member.id },
        "the first Member to stop it is the one on record",
      );
    } finally {
      unregisterRunningSessionTurn(session.id);
    }
  });

  test("a non-member cannot stop someone else's session", async () => {
    await markRunning();
    const { controller, recorder } = await registerTurn();
    try {
      actingUserId = outsider.id;
      const result = await call("POST", `${sessionUrl()}/stop`, {});
      assert.equal(result.status, 403);
      assert.equal(controller.signal.aborted, false);
      await recorder.finish();
      assert.equal(
        await AppDataSource.getRepository(RepositoryWorkSessionEvent).countBy({
          sessionId: session.id,
        }),
        0,
      );
      assert.equal((await stopAudits()).length, 0);
    } finally {
      unregisterRunningSessionTurn(session.id);
    }
  });

  test("a session of another repository is not found", async () => {
    await markRunning();
    const { controller } = await registerTurn();
    try {
      await insertRepository(company.id, "Other", "other");
      const result = await call("POST", `${sessionUrl(company.id, "other")}/stop`, {});
      assert.equal(result.status, 400);
      assert.match(String(result.body.error), /not found/);
      assert.equal(controller.signal.aborted, false);
    } finally {
      unregisterRunningSessionTurn(session.id);
    }
  });
});
