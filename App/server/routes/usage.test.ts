import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunStatus } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { usageRouter } from "./usage.js";

/**
 * Settings → Usage rolls Runs up by what happened to them. A Run that handed
 * its work to a continuation is counted in its own bucket: it spent tokens and
 * time like any Run, but it is neither delivered work nor a problem.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null;
let company: Company;
let routine: Routine;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", usageRouter);
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
});

beforeEach(async () => {
  await resetTestDb();
  const admin = await insert(User, {
    email: "admin@usage.test",
    name: "Admin",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Usage Co", slug: "usage", ownerId: admin.id });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Sales",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Prospecting",
    slug: "prospecting",
    cronExpr: "0 8 * * *",
    body: "",
  });
  actingUserId = admin.id;
});

async function run(status: RunStatus, minutes: number, tokensIn: number) {
  const startedAt = new Date(Date.now() - 60 * 60_000);
  return insert(Run, {
    routineId: routine.id,
    status,
    triggerKind: "schedule",
    startedAt,
    finishedAt: new Date(startedAt.getTime() + minutes * 60_000),
    tokensIn,
    tokensOut: 0,
  });
}

type Bucket = Record<
  "runs" | "completed" | "reviewed" | "continued" | "failed" | "error" | "durationMs" | "tokensIn",
  number
>;

test("hand-offs get their own bucket and still count their tokens and time", async () => {
  await run("continued", 4, 2_000_000);
  await run("continued", 4, 2_500_000);
  await run("completed", 2, 1_000_000);
  await run("failed", 1, 500_000);

  const response = await fetch(`${baseUrl}/api/companies/${company.id}/usage?days=7`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { totals: Bucket; byRoutine: Bucket[] };
  for (const bucket of [body.totals, body.byRoutine[0]]) {
    assert.equal(bucket.runs, 4);
    assert.equal(bucket.continued, 2);
    assert.equal(bucket.completed, 1);
    assert.equal(bucket.failed, 1, "a hand-off is not a problem");
    assert.equal(bucket.error, 0);
    assert.equal(bucket.tokensIn, 6_000_000, "every Run's tokens are spent, hand-off or not");
    assert.equal(bucket.durationMs, 11 * 60_000);
  }
});

test("a company with no Runs reports an empty Continued bucket", async () => {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/usage`);
  const body = (await response.json()) as { totals: Bucket };
  assert.equal(body.totals.continued, 0);
  assert.equal(body.totals.runs, 0);
});
