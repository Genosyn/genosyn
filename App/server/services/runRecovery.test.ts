import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunTrigger } from "../db/entities/Run.js";
import { WorkloadLease } from "../db/entities/WorkloadLease.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { INTERRUPTED_RECOVERY_DELAY_MS } from "./cronMath.js";
import { dispatchDueRetries, tickRoutine } from "./cron.js";
import { registerResourceChangeSink } from "./resourceEvents.js";
import { startRoutineRun } from "./runner.js";
import { readRunDiagnostics, RunDiagnosticRecorder } from "./runDiagnostics.js";
import { liftStanddown, placeStanddown } from "./standdowns.js";
import {
  ORPHAN_LOG_MARKER,
  RETRY_DISPATCH_CLAIM_TTL_MS,
  cancelPendingRetry,
  claimRetryDispatch,
  findDueRetries,
  isRetryDispatchClaimed,
  reconcileOrphanedRuns,
  settleRetryDispatchClaim,
} from "./runRecovery.js";

before(async () => {
  await initTestDb();
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
});

beforeEach(resetTestDb);
after(closeTestDb);

const NOW = new Date("2026-08-11T12:00:00.000Z");

async function fixture() {
  const company = await insert(Company, {
    name: "Recovery Co",
    slug: "recovery-co",
    ownerId: "owner-1",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Riley Recovery",
    slug: "riley-recovery",
    role: "Operations",
  });
  return { company, employee };
}

async function routine(
  employeeId: string,
  slug: string,
  values: Partial<Routine> = {},
): Promise<Routine> {
  return insert(Routine, {
    employeeId,
    name: `Routine ${slug}`,
    slug,
    cronExpr: "0 * * * *",
    ...values,
  });
}

async function runningRun(
  routineId: string,
  values: { attempt?: number; triggerKind?: RunTrigger } = {},
): Promise<Run> {
  return insert(Run, {
    routineId,
    startedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    finishedAt: null,
    status: "running",
    exitCode: null,
    logContent: "durable line\n",
    dismissedAt: null,
    triggerKind: values.triggerKind ?? "schedule",
    attempt: values.attempt ?? 1,
    parentRunId: null,
    retryAt: null,
    missedSlots: 0,
  });
}

async function interruptedRun(routineId: string, values: Partial<Run> = {}): Promise<Run> {
  return insert(Run, {
    routineId,
    startedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    finishedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    status: "error",
    errorKind: "interrupted",
    exitCode: null,
    logContent: "interrupted\n",
    dismissedAt: null,
    triggerKind: "schedule",
    attempt: 1,
    parentRunId: null,
    retryAt: NOW,
    missedSlots: 0,
    ...values,
  });
}

describe("Routine Run crash recovery", () => {
  test("preserves a newer diagnostic and log checkpoint written during recording finalization", async (t) => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "checkpoint-during-shutdown");
    const run = await runningRun(scheduled.id);
    const runs = AppDataSource.getRepository(Run);
    const old = new RunDiagnosticRecorder();
    old.toolStarted("old_step", "old");
    await runs.update(run.id, { diagnosticsJson: old.json() });
    const newer = new RunDiagnosticRecorder();
    newer.phase("work");
    newer.toolStarted("stripe_list_customers", "latest");
    const browserSessions = AppDataSource.getRepository(BrowserSession);
    const findSessions = browserSessions.find.bind(browserSessions);
    let checkpointLanded = false;
    // The production recording finalizer queries this repository after the
    // recovery sweep has already loaded its initial Run snapshot.
    t.mock.method(browserSessions, "find", async (...args: Parameters<typeof browserSessions.find>) => {
      if (!checkpointLanded) {
        checkpointLanded = true;
        await runs.update({ id: run.id, status: "running" }, {
          logContent: "newer durable tool boundary\n", diagnosticsJson: newer.json(),
        });
      }
      return findSessions(...args);
    });

    const result = await reconcileOrphanedRuns({ boot: true, now: NOW });
    assert.equal(checkpointLanded, true);
    assert.equal(result.interrupted, 1);
    const recovered = await runs.findOneByOrFail({ id: run.id });
    assert.equal(recovered.logContent, `newer durable tool boundary\n${ORPHAN_LOG_MARKER}`);
    assert.equal(readRunDiagnostics(recovered).failure?.step?.tool, "stripe_list_customers");
    assert.equal(readRunDiagnostics(recovered).failure?.step?.callId, "latest");
  });

  test("a diagnostic checkpoint racing the recovery CAS wins and is recovered on the next sweep", async (t) => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "checkpoint-cas-race");
    const run = await runningRun(scheduled.id);
    const runs = AppDataSource.getRepository(Run);
    const update = runs.update.bind(runs);
    const newer = new RunDiagnosticRecorder();
    newer.phase("checks");
    newer.toolStarted("get_run_report", "cas-winner");
    let checkpointLanded = false;
    t.mock.method(runs, "update", async (...args: Parameters<typeof runs.update>) => {
      if (!checkpointLanded && args[1].status === "error") {
        checkpointLanded = true;
        await update({ id: run.id, status: "running" }, {
          logContent: "CAS winner checkpoint\n", diagnosticsJson: newer.json(),
        });
      }
      return update(...args);
    });

    const first = await reconcileOrphanedRuns({ boot: true, now: NOW });
    assert.equal(checkpointLanded, true);
    assert.equal(first.interrupted, 0);
    const waiting = await runs.findOneByOrFail({ id: run.id });
    assert.equal(waiting.status, "running");
    assert.equal(waiting.logContent, "CAS winner checkpoint\n");
    assert.equal(waiting.diagnosticsJson, newer.json());
    const second = await reconcileOrphanedRuns({ boot: true, now: NOW });
    assert.equal(second.interrupted, 1);
    const recovered = await runs.findOneByOrFail({ id: run.id });
    assert.equal(recovered.logContent, `CAS winner checkpoint\n${ORPHAN_LOG_MARKER}`);
    assert.equal(readRunDiagnostics(recovered).failure?.step?.callId, "cas-winner");
  });

  test("schedules the default recovery exactly one hour after interruption detection", async () => {
    const { company, employee } = await fixture();
    const scheduled = await routine(employee.id, "hourly");
    const run = await runningRun(scheduled.id);
    const diagnostics = new RunDiagnosticRecorder();
    diagnostics.phase("work");
    diagnostics.toolStarted("browser_open", "before-crash");
    await AppDataSource.getRepository(Run).update(run.id, { diagnosticsJson: diagnostics.json() });
    await insert(WorkloadLease, {
      companyId: company.id,
      employeeId: employee.id,
      kind: "chat",
      ownerKey: null,
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    });

    const result = await reconcileOrphanedRuns({ boot: true, now: NOW });

    assert.deepEqual(result, { interrupted: 1, retriesScheduled: 1, leasesCleared: 1 });
    const recovered = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(recovered.status, "error");
    assert.equal(recovered.errorKind, "interrupted");
    assert.equal(readRunDiagnostics(recovered).failure?.category, "interrupted");
    assert.equal(readRunDiagnostics(recovered).failure?.step?.tool, "browser_open");
    assert.equal(recovered.finishedAt?.getTime(), NOW.getTime());
    assert.equal(recovered.retryAt?.getTime(), NOW.getTime() + INTERRUPTED_RECOVERY_DELAY_MS);
    assert.equal(recovered.logContent, `durable line\n${ORPHAN_LOG_MARKER}`);
    assert.equal(await AppDataSource.getRepository(JournalEntry).countBy({ runId: run.id }), 1);

    assert.deepEqual(
      await findDueRetries(new Date(NOW.getTime() + INTERRUPTED_RECOVERY_DELAY_MS - 1), 5),
      [],
    );
    assert.deepEqual(
      (await findDueRetries(new Date(NOW.getTime() + INTERRUPTED_RECOVERY_DELAY_MS), 5)).map(
        (row) => row.id,
      ),
      [run.id],
    );
  });

  test("emits a live Run update when recovery wins its terminal compare-and-set", async () => {
    const { company, employee } = await fixture();
    const scheduled = await routine(employee.id, "live-recovery");
    await runningRun(scheduled.id);
    const events: Array<{ companyId: string; kind: string; scopeIds: string[] }> = [];
    registerResourceChangeSink((companyId, kind, scopeIds) => {
      events.push({ companyId, kind, scopeIds });
    });

    await reconcileOrphanedRuns({ boot: true, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.ok(
      events.some(
        (event) =>
          event.companyId === company.id &&
          event.kind === "run" &&
          event.scopeIds.includes(scheduled.id),
      ),
    );
  });

  test("counts start prerequisites against the Run's absolute timeout", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "absolute-timeout", {
      timeoutSec: 1,
      retryOnTimeout: false,
    });

    const started = await startRoutineRun(scheduled, {
      triggerKind: "schedule",
      beforeRunPersist: () => new Promise((resolve) => setTimeout(resolve, 1_050)),
    });
    const finished = await started.completion;

    assert.equal(finished.status, "error");
    assert.equal(finished.errorKind, "timeout");
    assert.equal(finished.retryAt, null);
    assert.match(finished.logContent, /\[timeout\] Stopped after 1s/);
  });

  test("keeps the implicit recovery bounded and preserves trigger safety", async (t) => {
    t.mock.method(Math, "random", () => 0.5);
    const { employee } = await fixture();
    const cases = [
      { slug: "budget-spent", attempt: 2, triggerKind: "schedule" as const, maxAttempts: 1 },
      { slug: "manual", attempt: 1, triggerKind: "manual" as const, maxAttempts: 1 },
      { slug: "webhook", attempt: 1, triggerKind: "webhook" as const, maxAttempts: 3 },
      { slug: "approval", attempt: 1, triggerKind: "approval" as const, maxAttempts: 3 },
      { slug: "configured", attempt: 2, triggerKind: "retry" as const, maxAttempts: 3 },
      { slug: "configured-spent", attempt: 3, triggerKind: "retry" as const, maxAttempts: 3 },
    ];
    const runs: Array<{ row: Run; shouldSchedule: boolean }> = [];
    for (const item of cases) {
      const scheduled = await routine(employee.id, item.slug, {
        maxAttempts: item.maxAttempts,
      });
      const row = await runningRun(scheduled.id, item);
      runs.push({ row, shouldSchedule: item.slug === "configured" });
    }

    const result = await reconcileOrphanedRuns({ boot: true, now: NOW });

    assert.equal(result.interrupted, cases.length);
    assert.equal(result.retriesScheduled, 1);
    for (const item of runs) {
      const recovered = await AppDataSource.getRepository(Run).findOneByOrFail({
        id: item.row.id,
      });
      assert.equal(recovered.status, "error");
      assert.equal(recovered.errorKind, "interrupted");
      assert.equal(recovered.retryAt !== null, item.shouldSchedule);
      if (item.shouldSchedule) {
        // Attempt 2 uses a 120s jitter ceiling at the default 60s base.
        assert.equal(recovered.retryAt?.getTime(), NOW.getTime() + 60 * 1000);
      }
    }
  });

  test("does not sweep historical interrupted Runs into the recovery queue", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "historical");
    const historical = await interruptedRun(scheduled.id, {
      status: "interrupted",
      errorKind: null,
      finishedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      retryAt: null,
    });

    const recovery = await reconcileOrphanedRuns({ boot: true, now: NOW });
    const dispatch = await dispatchDueRetries(NOW);

    assert.deepEqual(recovery, { interrupted: 0, retriesScheduled: 0, leasesCleared: 0 });
    assert.equal(dispatch.started, 0);
    const unchanged = await AppDataSource.getRepository(Run).findOneByOrFail({
      id: historical.id,
    });
    assert.equal(unchanged.retryAt, null);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: historical.id }), 0);
    assert.equal(
      await AppDataSource.getRepository(JournalEntry).countBy({ runId: historical.id }),
      0,
    );
  });

  test("gives cancellation and dispatch a deterministic claim winner", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "claim-race");
    const cancelledFirst = await interruptedRun(scheduled.id);
    const dispatchedFirst = await interruptedRun(scheduled.id);

    assert.equal(await cancelPendingRetry(cancelledFirst.id), "cancelled");
    assert.equal(await claimRetryDispatch(cancelledFirst.id, NOW, NOW), null);

    const claim = await claimRetryDispatch(dispatchedFirst.id, NOW, NOW);
    assert.ok(claim);
    const claimed = await AppDataSource.getRepository(Run).findOneByOrFail({
      id: dispatchedFirst.id,
    });
    assert.equal(isRetryDispatchClaimed(claimed.retryAt), true);
    assert.equal(await cancelPendingRetry(dispatchedFirst.id), "dispatching");
    assert.deepEqual(
      await findDueRetries(new Date(NOW.getTime() + RETRY_DISPATCH_CLAIM_TTL_MS - 1), 5),
      [],
    );
    assert.deepEqual(
      (await findDueRetries(new Date(NOW.getTime() + RETRY_DISPATCH_CLAIM_TTL_MS), 5)).map(
        (run) => run.id,
      ),
      [dispatchedFirst.id],
    );
    const reclaimed = await claimRetryDispatch(
      dispatchedFirst.id,
      claim,
      new Date(NOW.getTime() + RETRY_DISPATCH_CLAIM_TTL_MS),
    );
    assert.ok(reclaimed);
    assert.notEqual(reclaimed.getTime(), claim.getTime());
    assert.equal(await cancelPendingRetry(dispatchedFirst.id), "dispatching");
    assert.equal(
      await claimRetryDispatch(
        dispatchedFirst.id,
        claim,
        new Date(NOW.getTime() + RETRY_DISPATCH_CLAIM_TTL_MS + 1),
      ),
      null,
    );
    assert.equal(
      await settleRetryDispatchClaim(dispatchedFirst.id, scheduled.id, reclaimed, null),
      true,
    );
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: dispatchedFirst.id })).retryAt,
      null,
    );
  });

  test("does not dispatch a due recovery after it is cancelled", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "cancel-before-due");
    const parent = await interruptedRun(scheduled.id);

    assert.equal(await cancelPendingRetry(parent.id), "cancelled");
    const result = await dispatchDueRetries(NOW);

    assert.equal(result.started, 0);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: parent.id }), 0);
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id })).retryAt,
      null,
    );
  });

  test("does not dispatch a due recovery through a newly added approval gate", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "approval-gated", {
      requiresApproval: true,
    });
    const parent = await interruptedRun(scheduled.id);

    const result = await dispatchDueRetries(NOW);

    assert.equal(result.started, 0);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: parent.id }), 0);
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id })).retryAt,
      null,
    );
  });

  test("honors a reduced retry policy before dispatching queued work", async () => {
    const { employee } = await fixture();
    const capped = await routine(employee.id, "attempt-limit-reduced", { maxAttempts: 3 });
    const timeoutDisabled = await routine(employee.id, "timeout-retry-disabled", {
      maxAttempts: 2,
      retryOnTimeout: true,
    });
    const cappedParent = await interruptedRun(capped.id, {
      status: "failed",
      attempt: 2,
    });
    const timeoutParent = await interruptedRun(timeoutDisabled.id, {
      status: "timeout",
    });
    const routineRepo = AppDataSource.getRepository(Routine);

    // Both parents were eligible when their durable due stamps were written.
    // Current settings must win if a member tightens the policy while they wait.
    await routineRepo.update({ id: capped.id }, { maxAttempts: 2 });
    await routineRepo.update({ id: timeoutDisabled.id }, { retryOnTimeout: false });

    const result = await dispatchDueRetries(NOW);

    assert.equal(result.started, 0);
    assert.equal(result.completions.length, 0);
    for (const parent of [cappedParent, timeoutParent]) {
      assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: parent.id }), 0);
      assert.equal(
        (await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id })).retryAt,
        null,
      );
    }
  });

  test("rechecks safety and retry policy after preparation before creating a retry Run", async (t) => {
    const { employee } = await fixture();
    const paused = await routine(employee.id, "paused-during-preparation");
    const gated = await routine(employee.id, "gated-during-preparation");
    const capped = await routine(employee.id, "capped-during-preparation", { maxAttempts: 3 });
    const pausedParent = await interruptedRun(paused.id);
    const gatedParent = await interruptedRun(gated.id);
    const cappedParent = await interruptedRun(capped.id, { status: "failed", attempt: 2 });
    const routineRepo = AppDataSource.getRepository(Routine);
    const originalFindOneBy = routineRepo.findOneBy.bind(routineRepo);
    const lookups = new Map<string, number>();

    t.mock.method(
      routineRepo,
      "findOneBy",
      async (where: Parameters<typeof routineRepo.findOneBy>[0]) => {
        const whereId = Array.isArray(where) ? null : where.id;
        const id = typeof whereId === "string" ? whereId : null;
        if (id === paused.id || id === gated.id || id === capped.id) {
          const count = (lookups.get(id) ?? 0) + 1;
          lookups.set(id, count);
          if (count === 2) {
            const values =
              id === paused.id
                ? { enabled: false }
                : id === gated.id
                  ? { requiresApproval: true }
                  : { maxAttempts: 2 };
            await routineRepo.update({ id }, values);
          }
        }
        return originalFindOneBy(where);
      },
    );

    const result = await dispatchDueRetries(NOW);

    assert.equal(result.started, 0);
    assert.equal(result.completions.length, 0);
    assert.equal(
      await AppDataSource.getRepository(Run).countBy({ parentRunId: pausedParent.id }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(Run).countBy({ parentRunId: gatedParent.id }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(Run).countBy({ parentRunId: cappedParent.id }),
      0,
    );
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: pausedParent.id })).retryAt,
      null,
    );
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: gatedParent.id })).retryAt,
      null,
    );
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: cappedParent.id })).retryAt,
      null,
    );
  });

  test("does not resurrect a cancelled recovery or duplicate reconciliation records", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "cancelled");
    const run = await runningRun(scheduled.id);

    await reconcileOrphanedRuns({ boot: true, now: NOW });
    const repo = AppDataSource.getRepository(Run);
    const cancelled = await repo.findOneByOrFail({ id: run.id });
    cancelled.retryAt = null;
    await repo.save(cancelled);

    const second = await reconcileOrphanedRuns({ boot: true, now: new Date(NOW.getTime() + 1) });
    const unchanged = await repo.findOneByOrFail({ id: run.id });
    assert.deepEqual(second, { interrupted: 0, retriesScheduled: 0, leasesCleared: 0 });
    assert.equal(unchanged.retryAt, null);
    assert.equal(unchanged.logContent.split(ORPHAN_LOG_MARKER).length - 1, 1);
    assert.equal(await AppDataSource.getRepository(JournalEntry).countBy({ runId: run.id }), 1);
  });

  test("finalizes disabled, approval-gated, and deleted routine Runs without scheduling work", async () => {
    const { company, employee } = await fixture();
    const disabled = await routine(employee.id, "disabled", { enabled: false });
    const gated = await routine(employee.id, "gated", { requiresApproval: true });
    const disabledRun = await runningRun(disabled.id);
    const gatedRun = await runningRun(gated.id);
    const deletedRun = await runningRun("deleted-routine");
    await insert(WorkloadLease, {
      companyId: company.id,
      employeeId: employee.id,
      kind: "chat",
      ownerKey: null,
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    });

    const result = await reconcileOrphanedRuns({ boot: true, now: NOW });

    assert.deepEqual(result, { interrupted: 3, retriesScheduled: 0, leasesCleared: 1 });
    for (const id of [disabledRun.id, gatedRun.id, deletedRun.id]) {
      const recovered = await AppDataSource.getRepository(Run).findOneByOrFail({ id });
      assert.equal(recovered.status, "error");
      assert.equal(recovered.errorKind, "interrupted");
      assert.equal(recovered.retryAt, null);
    }
  });

  test("continues reconciling later Runs when journal writes fail", async (t) => {
    t.mock.method(console, "error", () => {});
    const { employee } = await fixture();
    const firstRoutine = await routine(employee.id, "first");
    const secondRoutine = await routine(employee.id, "second");
    const first = await runningRun(firstRoutine.id);
    const second = await runningRun(secondRoutine.id);
    await AppDataSource.query(`
      CREATE TRIGGER reject_recovery_journal
      BEFORE INSERT ON journal_entries
      BEGIN
        SELECT RAISE(FAIL, 'journal unavailable');
      END
    `);

    const result = await reconcileOrphanedRuns({ boot: true, now: NOW });

    assert.equal(result.interrupted, 2);
    assert.equal(result.retriesScheduled, 2);
    for (const id of [first.id, second.id]) {
      const recovered = await AppDataSource.getRepository(Run).findOneByOrFail({ id });
      assert.equal(recovered.status, "error");
      assert.equal(recovered.errorKind, "interrupted");
      assert.notEqual(recovered.retryAt, null);
    }
  });

  test("dispatches one durable child with retry provenance and self-heals a stale stamp", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "dispatch");
    const parent = await interruptedRun(scheduled.id, {
      missedSlots: 4,
    });

    const [first, concurrent] = await Promise.all([
      dispatchDueRetries(NOW),
      dispatchDueRetries(NOW),
    ]);
    assert.equal(first.started + concurrent.started, 1);
    await Promise.all([...first.completions, ...concurrent.completions]);

    const runRepo = AppDataSource.getRepository(Run);
    const refreshedParent = await runRepo.findOneByOrFail({ id: parent.id });
    assert.equal(refreshedParent.retryAt, null);
    const children = await runRepo.findBy({ parentRunId: parent.id });
    assert.equal(children.length, 1);
    assert.equal(children[0]?.triggerKind, "retry");
    assert.equal(children[0]?.attempt, 2);
    assert.equal(children[0]?.missedSlots, 0);
    assert.match(children[0]?.logContent ?? "", /attempt 2 of 2/);

    // Simulate a crash after child creation but before the parent stamp was
    // cleared. The child proof prevents a second dispatch and repairs it.
    refreshedParent.retryAt = NOW;
    await runRepo.save(refreshedParent);
    const second = await dispatchDueRetries(NOW);
    assert.equal(second.started, 0);
    assert.equal(await runRepo.countBy({ parentRunId: parent.id }), 1);
    assert.equal((await runRepo.findOneByOrFail({ id: parent.id })).retryAt, null);
  });

  test("defers a due recovery while the same routine still has a Run in flight", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "overlap");
    const parent = await interruptedRun(scheduled.id);
    await runningRun(scheduled.id);

    const result = await dispatchDueRetries(NOW);

    assert.equal(result.started, 0);
    const deferred = await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id });
    assert.equal(deferred.retryAt?.getTime(), NOW.getTime() + 60 * 1000);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: parent.id }), 0);
  });
});

async function continuationRun(routineId: string, values: Partial<Run> = {}): Promise<Run> {
  const now = new Date();
  return interruptedRun(routineId, {
    startedAt: new Date(now.getTime() - 60_000),
    finishedAt: now,
    status: "failed",
    errorKind: null,
    exitCode: 0,
    retryAt: now,
    checkpointJson: JSON.stringify({
      state: "continue",
      completed: "Reviewed events through event-71.",
      remaining: "Review the remaining events and one incomplete release.",
      resume: "Fetch event-72 by ID and continue from cursor next-events.",
      progressKey: "event-71",
    }),
    continuationCount: 0,
    continuationDeadlineAt: new Date(now.getTime() + 30 * 60_000),
    continuationTokensUsed: 0,
    continuationStopReason: null,
    tokensIn: 100,
    tokensOut: 20,
    ...values,
  });
}

describe("Routine checkpoint continuation dispatch", () => {
  test("continues at the default retry setting once under concurrent dispatch", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "continue-default");
    assert.equal(scheduled.maxAttempts, 1);
    const parent = await continuationRun(scheduled.id);
    const now = new Date();

    const results = await Promise.all([dispatchDueRetries(now), dispatchDueRetries(now)]);
    assert.equal(
      results.reduce((sum, result) => sum + result.started, 0),
      1,
    );
    await Promise.all(results.flatMap((result) => result.completions));
    const repo = AppDataSource.getRepository(Run);
    const children = await repo.findBy({ parentRunId: parent.id });
    assert.equal(children.length, 1);
    assert.equal(children[0].triggerKind, "continuation");
    assert.equal(
      children[0].attempt,
      parent.attempt,
      "continuing does not consume a retry attempt",
    );
    assert.equal(children[0].continuationCount, 1);
    assert.equal(children[0].continuationTokensUsed, 120);
    assert.equal(
      children[0].continuationDeadlineAt?.getTime(),
      parent.continuationDeadlineAt?.getTime(),
    );
    assert.equal((await repo.findOneByOrFail({ id: parent.id })).retryAt, null);

    // A crash after the durable child insert must repair the old stamp, even
    // if the continuation budget or policy has since become ineligible.
    await repo.update({ id: parent.id }, { retryAt: now, continuationStopReason: "Budget spent." });
    const again = await dispatchDueRetries(new Date());
    assert.equal(again.started, 0);
    assert.equal(await repo.countBy({ parentRunId: parent.id }), 1);
    assert.equal((await repo.findOneByOrFail({ id: parent.id })).retryAt, null);
  });

  test("natural schedule does not overtake queued or claimed continuation work", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "continue-before-slot");
    const parent = await continuationRun(scheduled.id, { retryAt: new Date(Date.now() + 60_000) });
    const repo = AppDataSource.getRepository(Run);
    await tickRoutine(scheduled.id, { missedSlots: 0 }, () => undefined);
    assert.equal(await repo.countBy({ routineId: scheduled.id }), 1);

    const claim = await claimRetryDispatch(parent.id, parent.retryAt as Date);
    assert.ok(claim);
    await tickRoutine(scheduled.id, { missedSlots: 0 }, () => undefined);
    assert.equal(await repo.countBy({ routineId: scheduled.id }), 1);
  });

  test("cancellation prevents a queued continuation from restarting", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "continue-cancelled");
    const parent = await continuationRun(scheduled.id);
    assert.equal(await cancelPendingRetry(parent.id), "cancelled");
    assert.equal((await dispatchDueRetries(new Date())).started, 0);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ parentRunId: parent.id }), 0);
  });

  test("stops unsafe or spent continuations without using the ordinary retry budget", async () => {
    const { employee } = await fixture();
    const cases: Array<{
      name: string;
      routine?: Partial<Routine>;
      run?: Partial<Run>;
      reason: RegExp;
    }> = [
      { name: "disabled", routine: { enabled: false }, reason: /disabled/i },
      { name: "approval", routine: { requiresApproval: true }, reason: /review/i },
      { name: "self-review", routine: { selfReviewOnly: true }, reason: /review/i },
      { name: "approved-run", run: { triggerKind: "approval" }, reason: /review/i },
      {
        name: "expired",
        run: { continuationDeadlineAt: new Date(Date.now() - 1) },
        reason: /time limit/i,
      },
      { name: "spent", run: { continuationCount: 3 }, reason: /continuation limit/i },
      { name: "tokens", run: { continuationTokensUsed: 10_000_000 }, reason: /token limit/i },
      {
        name: "no-progress",
        run: { continuationStopReason: "No progress since the previous checkpoint." },
        reason: /no progress/i,
      },
    ];
    const parents: Array<{ parent: Run; reason: RegExp }> = [];
    for (const item of cases) {
      const scheduled = await routine(employee.id, `continue-${item.name}`, {
        maxAttempts: 5,
        ...item.routine,
      });
      parents.push({ parent: await continuationRun(scheduled.id, item.run), reason: item.reason });
    }
    // The scheduler processes at most five queue rows per pass.
    assert.equal((await dispatchDueRetries(new Date())).started, 0);
    assert.equal((await dispatchDueRetries(new Date())).started, 0);
    const repo = AppDataSource.getRepository(Run);
    for (const { parent, reason } of parents) {
      const stopped = await repo.findOneByOrFail({ id: parent.id });
      assert.equal(stopped.retryAt, null);
      assert.match(stopped.continuationStopReason ?? "", reason);
      assert.equal(await repo.countBy({ parentRunId: parent.id }), 0);
    }
  });

  test("a Standdown defers a continuation until lifted", async () => {
    const { company, employee } = await fixture();
    const scheduled = await routine(employee.id, "continue-stood-down");
    const parent = await continuationRun(scheduled.id);
    const standdown = await placeStanddown({
      companyId: company.id,
      scope: "routine",
      scopeId: scheduled.id,
      source: "human",
      reason: "Inspect the remaining source coverage.",
      placedByUserId: null,
    });
    try {
      const now = new Date();
      assert.equal((await dispatchDueRetries(now)).started, 0);
      const queued = await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id });
      assert.equal(queued.retryAt?.getTime(), now.getTime() + 60_000);
      assert.equal(queued.continuationStopReason, null);
    } finally {
      await liftStanddown({ standdown });
    }
    const result = await dispatchDueRetries(new Date(Date.now() + 61_000));
    assert.equal(result.started, 1);
    await Promise.all(result.completions);
  });

  test("rechecks an approval gate added while continuation setup runs", async (t) => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "continue-new-gate");
    const parent = await continuationRun(scheduled.id);
    const repo = AppDataSource.getRepository(Routine);
    const original = repo.findOneBy.bind(repo);
    let reads = 0;
    t.mock.method(repo, "findOneBy", async (where: Parameters<typeof repo.findOneBy>[0]) => {
      if (!Array.isArray(where) && where.id === scheduled.id) {
        reads += 1;
        if (reads === 2) await repo.update({ id: scheduled.id }, { requiresApproval: true });
      }
      return original(where);
    });

    const result = await dispatchDueRetries(new Date());
    assert.equal(result.started, 0);
    const runRepo = AppDataSource.getRepository(Run);
    assert.equal(await runRepo.countBy({ parentRunId: parent.id }), 0);
    const stopped = await runRepo.findOneByOrFail({ id: parent.id });
    assert.equal(stopped.retryAt, null);
    assert.match(stopped.continuationStopReason ?? "", /review/i);
  });

  test("a running sibling defers continuation rather than starting duplicate work", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "continue-overlap");
    const parent = await continuationRun(scheduled.id);
    await insert(Run, {
      routineId: scheduled.id,
      startedAt: new Date(),
      status: "running",
      logContent: "",
    });
    const now = new Date();
    assert.equal((await dispatchDueRetries(now)).started, 0);
    const deferred = await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id });
    assert.equal(deferred.retryAt?.getTime(), now.getTime() + 60_000);
  });

  test("crash recovery cannot reset a continuation's budget through ordinary retries", async () => {
    const { employee } = await fixture();
    const scheduled = await routine(employee.id, "continue-interrupted", { maxAttempts: 5 });
    const parent = await continuationRun(scheduled.id, {
      status: "running",
      finishedAt: null,
      retryAt: null,
      triggerKind: "continuation",
      continuationCount: 2,
    });
    const result = await reconcileOrphanedRuns({ boot: true, now: new Date() });
    assert.equal(result.retriesScheduled, 0);
    const recovered = await AppDataSource.getRepository(Run).findOneByOrFail({ id: parent.id });
    assert.equal(recovered.status, "error");
    assert.equal(recovered.retryAt, null);
    assert.match(recovered.continuationStopReason ?? "", /interrupted/i);
    assert.equal(recovered.checkpointJson, parent.checkpointJson);
  });
});
