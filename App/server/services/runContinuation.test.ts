import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { startRoutineRun } from "./runner.js";
import { stopStanddowns } from "./standdowns.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import {
  checkpointAdvanced,
  continuationEligibility,
  readRunCheckpoint,
  runCheckpointSchema,
  saveRunCheckpoint,
  type RunCheckpoint,
} from "./runContinuation.js";

before(initTestDb);
beforeEach(async () => {
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  await resetTestDb();
});
after(async () => {
  stopStanddowns();
  await closeTestDb();
});

const first: RunCheckpoint = {
  state: "continue",
  completed: "Reviewed events through event-71 in the fixed September 21 window.",
  remaining: "Event-72 body and older audit; events after the saved anchor.",
  resume:
    "Read event-72 in full, fetch the September 20 Journal by ID, continue after event-71. Keep the September 8 verified checkpoint.",
  progressKey: "event-71",
};

async function fixture(values: Partial<Routine> = {}) {
  const company = await insert(Company, {
    name: "Continuation Co",
    slug: "continuation",
    ownerId: "owner",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Review",
    slug: "review",
    cronExpr: "0 9 * * *",
    body: "Review all source events.",
    ...values,
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
  return { company, employee, routine };
}

test("checkpoints require actionable resumable state and never equate remaining work with completion", () => {
  assert.equal(runCheckpointSchema.safeParse({ ...first, state: "complete" }).success, false);
  assert.equal(runCheckpointSchema.safeParse({ ...first, resume: " " }).success, false);
  assert.equal(readRunCheckpoint({ checkpointJson: "broken" }), null);
  assert.equal(checkpointAdvanced({ ...first, progressKey: "EVENT-71 " }, first), false);
  assert.equal(checkpointAdvanced({ ...first, progressKey: "event-72" }, first), false);
  assert.equal(
    checkpointAdvanced(
      { ...first, progressKey: "event-72", completed: "Reviewed through event-72" },
      first,
    ),
    true,
  );
});

test("only a live owning top-level Run can save or change progress", async () => {
  const { company, employee, routine } = await fixture();
  const run = await insert(Run, {
    routineId: routine.id,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
  });
  const token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    runId: run.id,
    routineId: routine.id,
  });
  const chat = issueMcpToken(employee.id, company.id, { authority: "employee" });
  const foreign = issueMcpToken(employee.id, "foreign-company", {
    authority: "employee",
    runId: run.id,
    routineId: routine.id,
  });
  try {
    await assert.rejects(saveRunCheckpoint(chat, first), /Only the AI Employee/);
    await assert.rejects(saveRunCheckpoint(foreign, first), /not yours/);
    await saveRunCheckpoint(token, first);
    await saveRunCheckpoint(token, {
      ...first,
      progressKey: "event-72",
      completed: "Reviewed event-72",
    });
    const persisted = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(readRunCheckpoint(persisted)?.progressKey, "event-72");
    assert.equal(persisted.status, "running");
    assert.equal(persisted.checksVerdict, null);
    await AppDataSource.getRepository(Run).update(run.id, {
      status: "failed",
      finishedAt: new Date(),
    });
    await assert.rejects(saveRunCheckpoint(token, first), /no longer running/);
  } finally {
    [token, chat, foreign].forEach(revokeMcpToken);
  }
});

test("default Routine queues partial work, resumes exact evidence, and finishes without changing retry settings", async (t) => {
  const { company, employee, routine } = await fixture();
  const briefs: string[] = [];
  let workTurns = 0;
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
    workTurns++;
    briefs.push(JSON.stringify(params.messages));
    const token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      routineId: routine.id,
      runId: current.id,
    });
    try {
      await saveRunCheckpoint(
        token,
        workTurns === 1
          ? first
          : {
              state: "complete",
              completed: "All source ranges and old gaps verified.",
              remaining: "",
              resume: "",
              progressKey: "coverage-complete",
            },
      );
    } finally {
      revokeMcpToken(token);
    }
    params.callbacks?.onUsage?.({ inputTokens: 100, outputTokens: 20 });
    return {
      finalText:
        workTurns === 1 ? "Partial review saved." : "Review completed; zero qualifying Contacts.",
      steps: 1,
      stopReason: "end_turn",
    };
  });
  const parent = await (await startRoutineRun(routine, { triggerKind: "schedule" })).completion;
  assert.equal(routine.maxAttempts, 1);
  assert.equal(parent.status, "failed");
  assert.ok(parent.retryAt);
  assert.equal(parent.checksVerdict, null);
  assert.equal(
    parent.continuationDeadlineAt?.getTime(),
    parent.startedAt.getTime() + routine.timeoutSec * 1000,
  );
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(child.status, "completed");
  assert.equal(child.retryAt, null);
  assert.equal(child.continuationCount, 1);
  assert.equal(child.continuationTokensUsed, 120);
  assert.equal(child.continuationDeadlineAt?.getTime(), parent.continuationDeadlineAt?.getTime());
  assert.match(briefs[1], /event-71/);
  assert.match(briefs[1], /September 20/);
  assert.match(briefs[1], /Verify prior Effects/);
  assert.equal(workTurns, 2);
});

test("a continuation that repeats its checkpoint stops instead of spending another attempt", async (t) => {
  const { company, employee, routine } = await fixture();
  t.mock.method(agentRuntime, "run", async () => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (current) {
      const token = issueMcpToken(employee.id, company.id, {
        authority: "employee",
        routineId: routine.id,
        runId: current.id,
      });
      try {
        await saveRunCheckpoint(token, first);
      } finally {
        revokeMcpToken(token);
      }
    }
    return { finalText: "Still partial.", steps: 1, stopReason: "end_turn" };
  });
  const parent = await (await startRoutineRun(routine)).completion;
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(child.status, "failed");
  assert.equal(child.retryAt, null);
  assert.match(child.continuationStopReason ?? "", /no measurable progress/);
});

test("automatic continuation respects approval, count, time and error boundaries regardless of token use", async () => {
  const { routine } = await fixture();
  const run = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "failed",
    triggerKind: "schedule",
    checkpointJson: JSON.stringify(first),
  });
  assert.equal(continuationEligibility(run, routine).eligible, true);
  assert.equal(
    continuationEligibility(
      Object.assign(new Run(), run, { continuationTokensUsed: 20_000_000, tokensIn: 10_000_000 }),
      routine,
    ).eligible,
    true,
    "token accounting must not prevent another continuation",
  );
  for (const patch of [
    { continuationCount: 3 },
    { continuationDeadlineAt: new Date(0) },
    { errorKind: "runtime" as const },
    { triggerKind: "approval" as const },
    { continuationStopReason: "No progress." },
  ])
    assert.equal(
      continuationEligibility(Object.assign(new Run(), run, patch), routine).eligible,
      false,
    );
  assert.equal(
    continuationEligibility(run, Object.assign(new Routine(), routine, { requiresApproval: true }))
      .eligible,
    false,
  );
  assert.equal(
    continuationEligibility(run, Object.assign(new Routine(), routine, { enabled: false }))
      .eligible,
    false,
  );
});

test("losing the AI Model leaves unfinished continuation work visible as a failure", async () => {
  const { employee, routine } = await fixture();
  await AppDataSource.getRepository(AIModel).delete({ employeeId: employee.id });
  const parent = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "failed",
    triggerKind: "schedule",
    checkpointJson: JSON.stringify(first),
  });
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(child.status, "failed");
  assert.equal(child.retryAt, null);
  assert.match(child.continuationStopReason ?? "", /connected AI Model/);
});

test("a checkpoint changed during finalization cannot leave a stale continuation queued", async (t) => {
  const { company, employee, routine } = await fixture();
  const runs = AppDataSource.getRepository(Run);
  t.mock.method(agentRuntime, "run", async () => {
    const run = await runs.findOneBy({ routineId: routine.id, status: "running" });
    if (run) {
      const token = issueMcpToken(employee.id, company.id, {
        authority: "employee",
        routineId: routine.id,
        runId: run.id,
      });
      try {
        await saveRunCheckpoint(token, first);
      } finally {
        revokeMcpToken(token);
      }
    }
    return { finalText: "Partial work.", steps: 1, stopReason: "end_turn" };
  });
  const update = runs.update.bind(runs);
  let raced = false;
  t.mock.method(runs, "update", async (...args: Parameters<typeof runs.update>) => {
    if (!raced && args[1].status === "failed" && args[1].retryAt) {
      raced = true;
      const live = await runs.findOneByOrFail({ routineId: routine.id, status: "running" });
      await update(live.id, {
        checkpointJson: JSON.stringify({
          ...first,
          state: "blocked",
          remaining: "Source access was revoked.",
        }),
      });
    }
    return update(...args);
  });
  const run = await (await startRoutineRun(routine)).completion;
  assert.equal(raced, true);
  assert.equal(run.status, "failed");
  assert.equal(run.retryAt, null);
  assert.match(run.continuationStopReason ?? "", /Source access was revoked/);
});

test("event-origin continuations retain their review scope", async (t) => {
  const { company, employee, routine } = await fixture();
  const scopes: boolean[] = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    const current = await AppDataSource.getRepository(Run).findOneBy({
      routineId: routine.id,
      status: "running",
    });
    if (!current) return { finalText: "", steps: 1, stopReason: "end_turn" };
    scopes.push(
      !params.registry.resolve("create_routine") &&
        params.system.includes("This is proactive preparation"),
    );
    const token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      routineId: routine.id,
      runId: current.id,
    });
    try {
      await saveRunCheckpoint(
        token,
        scopes.length === 1
          ? first
          : { ...first, state: "complete", remaining: "", progressKey: "done" },
      );
    } finally {
      revokeMcpToken(token);
    }
    return { finalText: "Reviewed source evidence.", steps: 1, stopReason: "end_turn" };
  });
  const parent = await (await startRoutineRun(routine, { triggerKind: "event" })).completion;
  const child = await (
    await startRoutineRun(routine, {
      triggerKind: "continuation",
      continuationFromRunId: parent.id,
      parentRunId: parent.id,
    })
  ).completion;
  assert.equal(child.continuationOriginTriggerKind, "event");
  assert.equal(child.status, "reviewed");
  assert.deepEqual(scopes, [true, true]);
});
