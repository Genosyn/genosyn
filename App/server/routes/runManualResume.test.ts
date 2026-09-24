import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { agentRuntime } from "../services/agent/runtime.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { saveRunCheckpoint } from "../services/runContinuation.js";
import {
  assertManualResumeSource,
  manualResumeEligibility,
  resumeRoutineRun,
} from "../services/runManualResume.js";
import { getLiveRunSnapshot } from "../services/runner.js";
import { resetRuntimeSettingsCacheForTests } from "../services/runtimeSettings.js";
import { stopStanddowns } from "../services/standdowns.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { routinesRouter } from "./routines.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null;
let company: Company;
let administrator: User;
let member: User;
let employee: AIEmployee;
let routine: Routine;
let source: Run;
const checkpointJson = JSON.stringify({
  state: "continue",
  completed: "Reviewed Deal 29 in the original September 21 window.",
  remaining: "Nine conversation histories still need full review.",
  resume: "Read conversation private-thread-30 from its saved cursor.",
  progressKey: "deal-29",
});

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
  app.use("/api/companies/:cid", routinesRouter);
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
  stopStanddowns();
  await closeTestDb();
});

beforeEach(async (t) => {
  assert.ok("mock" in t, "beforeEach runs with a test context");
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  await resetTestDb();
  administrator = await insert(User, {
    email: "admin@example.test",
    name: "Admin",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "member@example.test",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Resume Co", slug: "resume", ownerId: administrator.id });
  await insert(Membership, { companyId: company.id, userId: administrator.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Follow up",
    slug: "follow-up",
    cronExpr: "0 9 * * *",
    body: "Review remaining conversations.",
    timeoutSec: 3600,
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "test",
    }),
  });
  source = await insert(Run, {
    routineId: routine.id,
    triggerKind: "schedule",
    status: "failed",
    startedAt: new Date(Date.now() - 7_200_000),
    finishedAt: new Date(Date.now() - 3_600_000),
    checkpointJson,
    continuationDeadlineAt: new Date(Date.now() - 3_600_000),
    continuationStopReason: "The shared token limit for automatic continuation was reached.",
    tokensIn: 17_700_000,
  });
  t.mock.method(agentRuntime, "run", async () => {
    const run = await AppDataSource.getRepository(Run).findOneByOrFail({
      routineId: routine.id,
      status: "running",
    });
    const token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      routineId: routine.id,
      runId: run.id,
    });
    try {
      await saveRunCheckpoint(token, {
        state: "complete",
        completed: "Reviewed the nine remaining conversation histories in the original window.",
        remaining: "",
        resume: "",
        progressKey: "window-complete",
      });
    } finally {
      revokeMcpToken(token);
    }
    return { finalText: "The remaining review is complete.", steps: 1, stopReason: "end_turn" };
  });
  actingUserId = administrator.id;
});

async function call(body: unknown = { acknowledgeNewAllowance: true }, runId = source.id) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/runs/${runId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Run & { error?: string } };
}

async function waitForChild(runId: string): Promise<Run> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await AppDataSource.getRepository(Run).findOneByOrFail({ id: runId });
    if (run.status !== "running" && !getLiveRunSnapshot(runId)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Resumed test Run did not finish.");
}

const resume = () =>
  resumeRoutineRun({
    companyId: company.id,
    sourceRunId: source.id,
    userId: administrator.id,
    acknowledgeNewAllowance: true,
  });

test("only a company administrator can authorize a fresh Run allowance", async () => {
  actingUserId = member.id;
  assert.equal((await call()).status, 403);
  actingUserId = null;
  assert.equal((await call()).status, 401);
  assert.equal(await AppDataSource.getRepository(Run).count(), 1);
});

test("the request requires an explicit acknowledgement and valid Run ID", async () => {
  for (const body of [
    {},
    { acknowledgeNewAllowance: false },
    { acknowledgeNewAllowance: true, unchecked: true },
  ])
    assert.equal((await call(body)).status, 400);
  assert.equal((await call({ acknowledgeNewAllowance: true }, "invalid")).status, 400);
  assert.equal(await AppDataSource.getRepository(Run).count(), 1);
});

test("another company's Run stays inaccessible to an administrator", async () => {
  const foreignCompany = await insert(Company, {
    name: "Other",
    slug: "other",
    ownerId: administrator.id,
  });
  await AppDataSource.getRepository(AIEmployee).update(employee.id, {
    companyId: foreignCompany.id,
  });
  assert.equal((await call()).status, 404);
});

test("resuming exhausted work preserves the source and creates exactly one fresh allowance", async () => {
  const original = await AppDataSource.getRepository(Run).findOneByOrFail({ id: source.id });
  const first = await call();
  assert.equal(first.status, 200);
  assert.notEqual(first.body.id, source.id);
  assert.equal(first.body.parentRunId, source.id);
  assert.equal(first.body.triggerKind, "continuation");
  assert.doesNotMatch(JSON.stringify(first.body), /private-thread-30|checkpointJson/);
  const child = await waitForChild(first.body.id);
  assert.equal(child.status, "completed");
  assert.equal(child.continuationCount, 0);
  assert.equal(child.continuationTokensUsed, 0);
  assert.equal(
    child.continuationDeadlineAt?.getTime(),
    child.startedAt.getTime() + routine.timeoutSec * 1000,
  );
  assert.equal(child.continuationOriginTriggerKind, "schedule");
  assert.deepEqual(
    await AppDataSource.getRepository(Run).findOneByOrFail({ id: source.id }),
    original,
  );
  assert.equal((await call()).status, 409);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: source.id }), 1);
});

test("simultaneous resume requests cannot start two copies of the saved work", async () => {
  const results = await Promise.all([call(), call()]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  await waitForChild(results.find((result) => result.status === 200)!.body.id);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: source.id }), 1);
});

test("failed startup leaves source progress intact and releases the claim", async (t) => {
  const repo = AppDataSource.getRepository(Run);
  const original = await repo.findOneByOrFail({ id: source.id });
  t.mock.method(repo, "save", async () => {
    throw new Error("insert denied");
  });
  await assert.rejects(resume, /insert denied/);
  assert.deepEqual(await repo.findOneByOrFail({ id: source.id }), original);
  assert.equal(await repo.count(), 1);
  const claim = await AppDataSource.getRepository(SchedulerLease).findOneByOrFail({
    name: `routine-resume:${routine.id}`,
  });
  assert.ok(claim.expiresAt && claim.expiresAt.getTime() <= Date.now());
});

test("a stale manual claim needs another explicit request and never queues a retry", async () => {
  await insert(SchedulerLease, {
    name: `routine-resume:${routine.id}`,
    holderId: "dead-process",
    expiresAt: new Date(Date.now() - 1),
  });
  const result = await call();
  assert.equal(result.status, 200);
  await waitForChild(result.body.id);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: source.id })).retryAt,
    null,
  );
});

test("a displaced resume claimant cannot create a child or release its replacement", async (t) => {
  const runs = AppDataSource.getRepository(Run);
  const exists = runs.existsBy.bind(runs);
  const name = `routine-resume:${routine.id}`;
  t.mock.method(runs, "existsBy", async (...args: Parameters<typeof runs.existsBy>) => {
    await AppDataSource.getRepository(SchedulerLease).update(
      { name },
      {
        holderId: "replacement",
        expiresAt: new Date(Date.now() + 300_000),
      },
    );
    return exists(...args);
  });
  await assert.rejects(resume, /resumption expired/);
  assert.equal(await runs.count(), 1);
  assert.equal(
    (await AppDataSource.getRepository(SchedulerLease).findOneByOrFail({ name })).holderId,
    "replacement",
  );
});

test("a gate added during preparation prevents the Run from being created", async (t) => {
  const models = AppDataSource.getRepository(AIModel);
  const find = models.find.bind(models);
  t.mock.method(models, "find", async (...args: Parameters<typeof models.find>) => {
    await AppDataSource.getRepository(Routine).update(routine.id, { requiresApproval: true });
    return find(...args);
  });
  await assert.rejects(resume, /human review/);
  assert.equal(await AppDataSource.getRepository(Run).count(), 1);
});

test("revoking administrator authority during preparation prevents starting work", async (t) => {
  const models = AppDataSource.getRepository(AIModel);
  const find = models.find.bind(models);
  t.mock.method(models, "find", async (...args: Parameters<typeof models.find>) => {
    await AppDataSource.getRepository(Membership).update(
      { companyId: company.id, userId: administrator.id },
      { role: "member" },
    );
    return find(...args);
  });
  await assert.rejects(resume, /administrator/);
  assert.equal(await AppDataSource.getRepository(Run).count(), 1);
});

test("a missing AI Model refuses resumption without creating a child or consuming progress", async () => {
  const repo = AppDataSource.getRepository(Run);
  const original = await repo.findOneByOrFail({ id: source.id });
  await AppDataSource.getRepository(AIModel).delete({ employeeId: employee.id });
  await assert.rejects(resume, /AI Model/);
  assert.equal(await repo.count(), 1);
  assert.deepEqual(await repo.findOneByOrFail({ id: source.id }), original);
});

test("a disconnected AI Model refuses resumption before creating a child", async () => {
  await AppDataSource.getRepository(AIModel).update(
    { employeeId: employee.id },
    { connectedAt: null },
  );
  const result = await call();
  assert.equal(result.status, 409);
  assert.match(result.body.error ?? "", /AI Model/);
  assert.equal(await AppDataSource.getRepository(Run).count(), 1);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: source.id })).checkpointJson,
    checkpointJson,
  );
});

test("pending work, nonactionable progress, and operational Errors cannot be resumed", () => {
  for (const patch of [
    { retryAt: new Date() },
    { checkpointJson: null },
    { checkpointJson: JSON.stringify({ ...JSON.parse(checkpointJson), state: "blocked" }) },
    { status: "error" as const, errorKind: "interrupted" as const },
    { status: "timeout" as const },
    { status: "completed" as const },
  ])
    assert.equal(
      manualResumeEligibility(Object.assign(new Run(), source, patch), routine).eligible,
      false,
    );
});

test("removing a self-review gate cannot erase its persisted review stop", async () => {
  source.continuationStopReason = "This work requires human review before another Run can start.";
  assert.equal(routine.selfReviewOnly, false);
  await assert.rejects(() => assertManualResumeSource(source, routine), /human review/);
});

test("approval ancestry cannot be replayed through a later failed continuation", async () => {
  const parent = await insert(Run, {
    routineId: routine.id,
    status: "failed",
    triggerKind: "approval",
    startedAt: new Date(source.startedAt.getTime() - 1000),
    finishedAt: source.finishedAt,
  });
  source.triggerKind = "continuation";
  source.parentRunId = parent.id;
  await assert.rejects(() => assertManualResumeSource(source, routine), /Approved or reviewed/);
});

test("a newer failed Run prevents resuming stale source work", async () => {
  await insert(Run, {
    routineId: routine.id,
    status: "failed",
    triggerKind: "manual",
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  assert.equal((await call()).status, 409);
});

test("another queued follow-up prevents overlapping a manual resumption", async () => {
  await insert(Run, {
    routineId: routine.id,
    status: "failed",
    triggerKind: "schedule",
    startedAt: new Date(source.startedAt.getTime() - 1000),
    finishedAt: source.finishedAt,
    retryAt: new Date(Date.now() + 60_000),
  });
  const response = await call();
  assert.equal(response.status, 409);
  assert.match(response.body.error ?? "", /follow-up queued or starting/);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: source.id }), 0);
});

test("lineage must leave room for the complete new continuation allowance", async () => {
  let parent = await insert(Run, {
    routineId: routine.id,
    status: "failed",
    triggerKind: "schedule",
    startedAt: new Date(1),
    finishedAt: new Date(2),
  });
  for (let index = 1; index < 16; index++) {
    parent = await insert(Run, {
      routineId: routine.id,
      status: "failed",
      triggerKind: "continuation",
      parentRunId: parent.id,
      startedAt: new Date(index + 1),
      finishedAt: new Date(index + 2),
    });
  }
  source.triggerKind = "continuation";
  source.parentRunId = parent.id;
  await assert.rejects(() => assertManualResumeSource(source, routine), /earlier evidence/);
});
