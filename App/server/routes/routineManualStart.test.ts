import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { stopCron } from "../services/cron.js";
import { startRoutineRun } from "../services/runner.js";
import {
  resumeRoutineQueue,
  stopRoutineQueue,
  waitForRoutineQueueIdle,
} from "../services/routineQueue.js";
import { placeStanddown, stopStanddowns } from "../services/standdowns.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { routinesRouter } from "./routines.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null;
let administrator: User;
let member: User;
let outsider: User;
let company: Company;
let employee: AIEmployee;
let routine: Routine;
let onRequest: (() => void) | undefined;

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

before(async () => {
  await initTestDb();
  stopRoutineQueue();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    onRequest?.();
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
  await waitForRoutineQueueIdle();
  stopRoutineQueue();
  stopCron();
  stopStanddowns();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

afterEach(async () => {
  // Retire fixture-only queued rows before resetting the database so their
  // original completion waiters do not leak into another test.
  await waitForRoutineQueueIdle();
  await AppDataSource.getRepository(Run).update(
    { status: "queued" },
    { status: "skipped", finishedAt: new Date() },
  );
  await resumeRoutineQueue();
  await waitForRoutineQueueIdle();
  stopRoutineQueue();
});

beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopRoutineQueue();
  onRequest = undefined;
  stopStanddowns();
  await resetTestDb();
  [administrator, member, outsider] = await Promise.all(
    ["administrator", "member", "outsider"].map((name) =>
      insert(User, {
        name,
        email: `${name}@example.test`,
        passwordHash: "x",
        sessionVersion: 0,
      }),
    ),
  );
  company = await insert(Company, {
    name: "Manual Start Co",
    slug: "manual-start",
    ownerId: administrator.id,
  });
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
    name: "Review records",
    slug: "review-records",
    cronExpr: "0 9 * * *",
    body: "Review current records and preserve captured scope.",
  });
  actingUserId = administrator.id;
});

async function call(id = routine.id, signal = AbortSignal.timeout(10_000)) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/routines/${id}/run`, {
    method: "POST",
    signal,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("repeating Run now returns its already accepted queued Run without changing the Routine", async () => {
  const before = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
  const first = await call();
  const second = await call();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.status, "queued");
  assert.equal(second.body.id, first.body.id);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
  assert.deepEqual(
    await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id }),
    before,
  );
});

test("reopening an accepted Run bypasses unnecessary model preparation failures", async (t) => {
  const first = await call();
  assert.equal(first.status, 200);
  const modelRead = t.mock.method(AppDataSource.getRepository(AIModel), "find", async () => {
    throw new Error("Synthetic unavailable model lookup");
  });
  const repeated = await call();
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.id, first.body.id);
  assert.equal(modelRead.mock.callCount(), 0);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
});

test("overlapping Member requests share the first queued Run", async (t) => {
  const repo = AppDataSource.getRepository(Run);
  const save = repo.save.bind(repo);
  const saving = barrier();
  const release = barrier();
  let saveCalls = 0;
  t.mock.method(repo, "save", async (...args: Parameters<typeof repo.save>) => {
    if (++saveCalls === 1) {
      saving.resolve();
      await release.promise;
    }
    return save(...args);
  });
  const first = call();
  const firstSaving = Promise.race([saving.promise, first.then(() => assert.fail("No save"))]);
  await firstSaving;
  const received = barrier();
  onRequest = received.resolve;
  const second = call();
  try {
    await Promise.race([received.promise, second.then(() => assert.fail("No request"))]);
  } finally {
    release.resolve();
  }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.id, b.body.id);
  assert.equal(saveCalls, 1);
  assert.equal(await repo.countBy({ routineId: routine.id }), 1);
});

test("retrying a lost response reuses the original in-flight acceptance", async (t) => {
  const repo = AppDataSource.getRepository(Run);
  const save = repo.save.bind(repo);
  const saving = barrier();
  const release = barrier();
  let saveCalls = 0;
  t.mock.method(repo, "save", async (...args: Parameters<typeof repo.save>) => {
    if (++saveCalls === 1) {
      saving.resolve();
      await release.promise;
    }
    return save(...args);
  });
  const abandoned = new AbortController();
  const first = call(routine.id, abandoned.signal);
  const firstRejected = assert.rejects(first, /abort/i);
  try {
    await Promise.race([saving.promise, first.then(() => assert.fail("No save"))]);
    abandoned.abort();
    await firstRejected;
    const received = barrier();
    onRequest = received.resolve;
    const second = call();
    await Promise.race([received.promise, second.then(() => assert.fail("No request"))]);
    release.resolve();
    const retry = await second;
    assert.equal(retry.status, 200);
    const rows = await repo.findBy({ routineId: routine.id });
    assert.equal(rows.length, 1);
    assert.equal(retry.body.id, rows[0].id);
    assert.equal(saveCalls, 1);
  } finally {
    abandoned.abort();
    release.resolve();
  }
});

for (const status of ["running", "failed", "completed", "error"] as const) {
  test(`Run now returns the existing ${status} ownership unchanged`, async () => {
    const repo = AppDataSource.getRepository(Run);
    const source = await insert(Run, {
      routineId: routine.id,
      employeeId: employee.id,
      status,
      triggerKind: "continuation",
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: status === "running" ? null : new Date(),
      queueActiveEmployeeId: `run:synthetic:owner`,
      queueOptionsJson: JSON.stringify({ privateFixture: "must not be returned" }),
      parentRunId: randomUUID(),
      continuationCount: 2,
      continuationDeadlineAt: new Date(Date.now() + 30_000),
      checkpointJson: JSON.stringify({ state: "continue", progressKey: "record-3" }),
    });
    const before = await repo
      .createQueryBuilder("run")
      .addSelect("run.queueOptionsJson")
      .where("run.id = :id", { id: source.id })
      .getOneOrFail();
    const response = await call();
    assert.equal(response.status, 200);
    assert.equal(response.body.id, source.id);
    assert.equal(response.body.status, status);
    assert.equal("queueOptionsJson" in response.body, false);
    assert.equal("queueActiveEmployeeId" in response.body, false);
    assert.equal(await repo.countBy({ routineId: routine.id }), 1);
    assert.deepEqual(
      await repo
        .createQueryBuilder("run")
        .addSelect("run.queueOptionsJson")
        .where("run.id = :id", { id: source.id })
        .getOneOrFail(),
      before,
    );
  });
}

test("a running legacy Run without a modern claim is reused", async () => {
  const source = await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "running",
    startedAt: new Date(),
    queueActiveEmployeeId: null,
  });
  assert.equal((await call()).body.id, source.id);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
});

for (const triggerKind of [
  "schedule",
  "retry",
  "event",
  "webhook",
  "approval",
  "continuation",
] as const) {
  test(`Run now opens queued ${triggerKind} work without replacing its occurrence`, async () => {
    const source = await insert(Run, {
      routineId: routine.id,
      employeeId: employee.id,
      status: "queued",
      triggerKind,
      startedAt: new Date(),
      parentRunId: triggerKind === "continuation" ? randomUUID() : null,
      continuationCount: triggerKind === "continuation" ? 2 : 0,
    });
    const response = await call();
    assert.equal(response.status, 200);
    assert.equal(response.body.id, source.id);
    assert.equal(response.body.triggerKind, triggerKind);
    assert.equal(response.body.parentRunId, source.parentRunId);
    assert.equal(response.body.continuationCount, source.continuationCount);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
  });
}

test("an existing owner is preferred to legacy queued duplicates", async () => {
  await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "queued",
    startedAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 60_000),
  });
  const owner = await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "completed",
    startedAt: new Date(),
    queueActiveEmployeeId: "run:fixture:cleanup",
  });
  assert.equal((await call()).body.id, owner.id);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 2);
});

test("a new occurrence is accepted only after existing cleanup releases its claim", async () => {
  const repo = AppDataSource.getRepository(Run);
  const source = await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "completed",
    startedAt: new Date(),
    queueActiveEmployeeId: "run:fixture:cleanup",
    finishedAt: new Date(),
  });
  assert.equal((await call()).body.id, source.id);
  await repo.update({ id: source.id }, { queueActiveEmployeeId: null });
  const next = await call();
  assert.equal(next.status, 200);
  assert.notEqual(next.body.id, source.id);
  assert.equal(next.body.triggerKind, "manual");
  assert.equal(next.body.parentRunId, null);
  assert.equal(await repo.countBy({ routineId: routine.id }), 2);
});

test("terminal retry metadata alone does not change direct manual occurrence semantics", async () => {
  const source = await insert(Run, {
    routineId: routine.id,
    employeeId: employee.id,
    status: "error",
    startedAt: new Date(),
    finishedAt: new Date(),
    retryAt: new Date(Date.now() + 60_000),
    queueActiveEmployeeId: null,
  });
  const next = await call();
  assert.equal(next.status, 200);
  assert.notEqual(next.body.id, source.id);
  assert.equal(next.body.triggerKind, "manual");
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: source.id })).retryAt?.getTime(),
    source.retryAt?.getTime(),
  );
});

test("reusing a queued Run preserves its original completion waiter", async () => {
  const source = await startRoutineRun(routine, { triggerKind: "schedule" });
  assert.equal((await call()).body.id, source.run.id);
  await resumeRoutineQueue();
  await waitForRoutineQueueIdle();
  const completion = await Promise.race([
    source.completion,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Original waiter was replaced")), 5_000);
      void source.completion.then(
        () => clearTimeout(timeout),
        () => clearTimeout(timeout),
      );
    }),
  ]);
  assert.equal(completion.id, source.run.id);
  assert.notEqual(completion.status, "queued");
  assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
});

test("ordinary scheduled acceptance still creates its own occurrence", async () => {
  const first = await call();
  const scheduled = await startRoutineRun(routine, { triggerKind: "schedule" });
  assert.notEqual(first.body.id, scheduled.run.id);
  assert.equal(scheduled.run.triggerKind, "schedule");
  assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 2);
});

test("one pending acceptance does not block a different Routine", async (t) => {
  const other = await insert(Routine, {
    employeeId: employee.id,
    name: "Independent review",
    slug: "independent-review",
    cronExpr: "0 9 * * *",
    body: "Review a different source.",
  });
  const repo = AppDataSource.getRepository(Run);
  const save = repo.save.bind(repo);
  const saving = barrier();
  const release = barrier();
  t.mock.method(repo, "save", async (...args: Parameters<typeof repo.save>) => {
    if (args[0].routineId === routine.id) {
      saving.resolve();
      await release.promise;
    }
    return save(...args);
  });
  const first = call();
  try {
    await Promise.race([saving.promise, first.then(() => assert.fail("No save"))]);
    const independent = await call(other.id);
    assert.equal(independent.status, 200);
    assert.equal(independent.body.routineId, other.id);
  } finally {
    release.resolve();
    await first;
  }
});

for (const stage of ["load", "save"] as const) {
  test(`a rejected ${stage} answers safely and does not poison a subsequent acceptance`, async (t) => {
    t.mock.method(console, "error", () => undefined);
    const error = new Error("Synthetic database detail that must not reach the caller");
    if (stage === "load")
      t.mock.method(
        AppDataSource.getRepository(Routine),
        "findOneBy",
        async () => {
          throw error;
        },
        { times: 1 },
      );
    else
      t.mock.method(
        AppDataSource.getRepository(Run),
        "save",
        async () => {
          throw error;
        },
        { times: 1 },
      );
    assert.deepEqual(await call(), { status: 500, body: { error: "Internal server error" } });
    assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 0);
    const next = await call();
    assert.equal(next.status, 200);
    assert.equal((await call()).body.id, next.body.id);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
  });
}

test("a Standdown still refuses Run now even when accepted work already exists", async () => {
  const accepted = await call();
  await placeStanddown({
    companyId: company.id,
    scope: "routine",
    scopeId: routine.id,
    reason: "Synthetic stop",
    placedByUserId: administrator.id,
  });
  const stopped = await call();
  assert.equal(stopped.status, 409);
  assert.match(String(stopped.body.error), /stood down/);
  assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: String(accepted.body.id) }))
      .status,
    "queued",
  );
});

test("Run now requires an authenticated company administrator even for reuse", async () => {
  await call();
  for (const [userId, expected] of [
    [null, 401],
    [member.id, 403],
    [outsider.id, 403],
  ] as const) {
    actingUserId = userId;
    assert.equal((await call()).status, expected);
  }
  assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
});

test("foreign-company and missing Routines are indistinguishable and never exposed", async () => {
  const foreignEmployee = await insert(AIEmployee, {
    companyId: randomUUID(),
    name: "Foreign",
    slug: "foreign",
    role: "Operations",
  });
  const foreign = await insert(Routine, {
    employeeId: foreignEmployee.id,
    name: "Foreign routine",
    slug: "foreign-routine",
    cronExpr: "0 9 * * *",
  });
  const source = await insert(Run, {
    routineId: foreign.id,
    employeeId: foreignEmployee.id,
    status: "running",
    startedAt: new Date(),
  });
  assert.deepEqual(await call(foreign.id), { status: 404, body: { error: "Not found" } });
  assert.deepEqual(await call(randomUUID()), { status: 404, body: { error: "Not found" } });
  assert.equal(await AppDataSource.getRepository(Run).count(), 1);
  assert.equal(
    (await AppDataSource.getRepository(Run).findOneByOrFail({ id: source.id })).status,
    "running",
  );
});

test("company ownership is rechecked after preparation before reuse or insertion", async (t) => {
  const repo = AppDataSource.getRepository(Routine);
  const find = repo.findOne.bind(repo);
  const accepting = barrier();
  const release = barrier();
  let reads = 0;
  t.mock.method(
    repo,
    "findOne",
    async (...args: Parameters<typeof repo.findOne>) => {
      if (++reads === 2) {
        accepting.resolve();
        await release.promise;
      }
      return find(...args);
    },
    { times: 2 },
  );
  const foreignEmployee = await insert(AIEmployee, {
    companyId: randomUUID(),
    name: "Foreign",
    slug: "foreign",
    role: "Operations",
  });
  const first = call();
  try {
    await Promise.race([accepting.promise, first.then(() => assert.fail("No acceptance"))]);
    await repo.update({ id: routine.id }, { employeeId: foreignEmployee.id });
  } finally {
    release.resolve();
  }
  assert.equal((await first).status, 404);
  assert.equal(await AppDataSource.getRepository(Run).count(), 0);
});

test("latest Routine edits survive a slow start and new restrictions are captured", async (t) => {
  const repo = AppDataSource.getRepository(Routine);
  const find = repo.findOne.bind(repo);
  const accepting = barrier();
  const release = barrier();
  let reads = 0;
  t.mock.method(
    repo,
    "findOne",
    async (...args: Parameters<typeof repo.findOne>) => {
      if (++reads === 2) {
        accepting.resolve();
        await release.promise;
      }
      return find(...args);
    },
    { times: 2 },
  );
  const first = call();
  try {
    await Promise.race([accepting.promise, first.then(() => assert.fail("No acceptance"))]);
    await repo.update(
      { id: routine.id },
      { body: "Revised current instructions.", timeoutSec: 120, mailDeliveryMode: "draft" },
    );
  } finally {
    release.resolve();
  }
  const response = await first;
  assert.equal(response.status, 200);
  const latest = await repo.findOneByOrFail({ id: routine.id });
  assert.equal(latest.body, "Revised current instructions.");
  assert.equal(latest.timeoutSec, 120);
  assert.equal(latest.mailDeliveryMode, "draft");
  const accepted = await AppDataSource.getRepository(Run)
    .createQueryBuilder("run")
    .addSelect("run.queueOptionsJson")
    .where("run.id = :id", { id: response.body.id })
    .getOneOrFail();
  assert.equal(accepted.continuationReviewOnly, true);
  assert.equal(JSON.parse(accepted.queueOptionsJson!).queuePolicy.mailDeliveryMode, "draft");
});
