import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { routineChecksRouter } from "./routineChecks.js";
import { routinesRouter } from "./routines.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let ownerId: string;
let company: Company;
let routine: Routine;
let run: Run;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(async (req, _res, next) => {
    req.session = actingUserId ? { userId: actingUserId, sessionVersion: 0 } : null;
    try {
      await persistTestSession(req);
      next();
    } catch (err) {
      next(err);
    }
  });
  app.use("/api/companies/:cid", routinesRouter);
  app.use("/api/companies/:cid", routineChecksRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "unused",
    sessionVersion: 0,
  });
  ownerId = owner.id;
  const member = await insert(User, {
    email: "member@example.test",
    name: "Member",
    passwordHash: "unused",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Evidence Co", slug: "evidence", ownerId });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Reviewer",
    slug: "reviewer",
    role: "Analyst",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Review",
    slug: "review",
    cronExpr: "0 9 * * *",
  });
  run = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date("2026-09-28T09:00:00Z"),
    finishedAt: new Date("2026-09-28T09:01:00Z"),
    status: "completed",
    logContent: "Review finished.\n",
    exitCode: 0,
  });
  await insert(AuditEvent, {
    companyId: company.id,
    actorKind: "ai",
    runId: run.id,
    action: "note.update",
    targetType: "note",
    targetId: null,
    targetLabel: "Review note",
    metadataJson: "{}",
  });
  actingUserId = member.id;
});

async function read(path: string, companyId = company.id) {
  // A missing Express 4 catch used to leave these requests open forever.
  // Keep the regression bounded even when the handler stops forwarding errors.
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: (await response.json()) as Record<string, unknown>,
  };
}

type Evidence = "log" | "effects";

function evidencePath(kind: Evidence) {
  return kind === "log" ? `/runs/${run.id}/log` : `/routines/runs/${run.id}/effects`;
}

async function assertRecovered(kind: Evidence) {
  const response = await read(evidencePath(kind));
  assert.equal(response.status, 200);
  if (kind === "log") {
    assert.equal(response.body.content, "Review finished.\n");
    assert.equal(response.body.status, "completed");
    assert.equal(response.body.live, false);
    assert.deepEqual(response.body.browserRecordings, []);
  } else {
    assert.equal(response.body.total, 1);
    const effects = response.body.effects as Array<{ action: string; targetLabel: string }>;
    assert.equal(effects.length, 1);
    assert.equal(effects[0].action, "note.update");
    assert.equal(effects[0].targetLabel, "Review note");
  }
}

async function assertReadFailure(t: TestContext, kind: Evidence) {
  const logged = t.mock.method(console, "error", () => {});
  const response = await read(evidencePath(kind));
  assert.equal(response.status, 500);
  assert.match(response.contentType ?? "", /application\/json/);
  assert.deepEqual(response.body, { error: "Internal server error" });
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(logged.mock.calls[0].arguments[0], "[error]");
  // The same request can succeed once the transient read failure clears.
  await assertRecovered(kind);
}

for (const kind of ["log", "effects"] as const) {
  test(`${kind} returns a structured error when its Run lookup rejects, then recovers`, async (t) => {
    t.mock.method(AppDataSource.getRepository(Run), "findOneBy", async () => {
      throw new Error("private database details must not reach the browser");
    }, { times: 1 });
    await assertReadFailure(t, kind);
  });

  test(`${kind} forwards a rejected Routine scope lookup without exposing evidence`, async (t) => {
    t.mock.method(AppDataSource.getRepository(Routine), "findOneBy", async () => {
      throw new Error("private Routine read failure");
    }, { times: 1 });
    await assertReadFailure(t, kind);
  });

  test(`${kind} remains readable by an ordinary Member`, async () => {
    await assertRecovered(kind);
  });

  test(`${kind} still refuses evidence from another company`, async () => {
    const foreignCompany = await insert(Company, {
      name: "Other Co",
      slug: "other",
      ownerId,
    });
    await insert(Membership, {
      companyId: foreignCompany.id,
      userId: actingUserId!,
      role: "member",
    });
    const response = await read(evidencePath(kind), foreignCompany.id);
    assert.equal(response.status, 404);
    assert.equal(response.body.content, undefined);
    assert.equal(response.body.effects, undefined);
  });
}

test("log forwards rejected recording metadata reads and remains retryable", async (t) => {
  t.mock.method(AppDataSource.getRepository(BrowserSession), "find", async () => {
    throw new Error("private recording metadata read failure");
  }, { times: 1 });
  await assertReadFailure(t, "log");
});

test("log forwards rejected follow-up reads after loading the transcript", async (t) => {
  const repo = AppDataSource.getRepository(Run);
  const createQueryBuilder = repo.createQueryBuilder.bind(repo);
  t.mock.method(repo, "createQueryBuilder", (...args: Parameters<typeof createQueryBuilder>) => {
    const builder = createQueryBuilder(...args);
    t.mock.method(builder, "getRawAndEntities", async () => {
      throw new Error("private continuation read failure");
    });
    return builder;
  }, { times: 1 });
  await assertReadFailure(t, "log");
});

test("effects forwards a rejected row read from its parallel evidence query", async (t) => {
  t.mock.method(AppDataSource.getRepository(AuditEvent), "find", async () => {
    throw new Error("private Effects row read failure");
  }, { times: 1 });
  await assertReadFailure(t, "effects");
});

test("effects forwards a rejected count from its parallel evidence query", async (t) => {
  t.mock.method(AppDataSource.getRepository(AuditEvent), "countBy", async () => {
    throw new Error("private Effects count failure");
  }, { times: 1 });
  await assertReadFailure(t, "effects");
});
