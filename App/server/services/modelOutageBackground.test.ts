import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { DataRoomJob } from "../db/entities/DataRoomJob.js";
import { EmployeeWakeup } from "../db/entities/EmployeeWakeup.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Meeting } from "../db/entities/Meeting.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { TldrSettings } from "../db/entities/TldrSettings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability } from "./agent/modelOutage.js";
import { agentRuntime } from "./agent/runtime.js";
import type { ChatResult } from "./chat.js";
import { createDataRoom } from "./dataRooms/rooms.js";
import { runDataRoomQueueOnce, setDataRoomQueueAutoKickForTests } from "./dataRooms/queue.js";
import { dataRoomPrivateCompanyDir } from "./paths.js";
import { setMeetingWriteUpAuthor, writeUpMeeting } from "./meetings/followUps.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "./modelAvailability.js";
import { gradeAndPersistRunOutcome, sweepUngradedRuns } from "./runGrading.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";
import { dispatchDueTldrs } from "./tldrs.js";
import { dispatchDueWakeups } from "./wakeups.js";

/**
 * AI work in the background meets an unavailable AI Model and defers — it
 * never records a result the outage made up. A graded verdict stays unwritten
 * (the Run is ungraded until the model is back, never judged by an outage), a
 * Wakeup stays pending, a data room job keeps its attempts, a meeting stays in
 * processing, a scheduled briefing stays due.
 */

before(async () => {
  await initTestDb();
  setDataRoomQueueAutoKickForTests(false);
});
beforeEach(async () => {
  resetModelAvailabilityForTests();
  await resetTestDb();
});
afterEach(() => {
  resetModelAvailabilityForTests();
  overrideRuntimeSettingsForTests(null);
});
after(closeTestDb);

async function setup() {
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Morgan",
    slug: "morgan",
    role: "Analyst",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({ apiKeyEncrypted: "sealed-test-key" }),
  });
  return { company, employee, model };
}

function down(model: AIModel): void {
  recordModelFailure(
    model,
    modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
  );
}

async function back(model: AIModel): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
}

const outage = () => modelUnavailability("overloaded", { status: 529, code: "overloaded_error" });

describe("grading a finished Run", () => {
  async function completedRun(routineId: string, employeeId: string) {
    return insert(Run, {
      routineId,
      employeeId,
      status: "completed",
      startedAt: new Date(Date.now() - 3_600_000),
      finishedAt: new Date(Date.now() - 3_000_000),
      logContent: "Reconciled the ledger.",
      triggerKind: "schedule",
    });
  }

  test("an outage records no verdict and stamps nothing: the Run waits to be graded", async () => {
    const { employee, model } = await setup();
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Ledger",
      slug: "ledger",
      cronExpr: "0 9 * * *",
      body: "Reconcile.",
      acceptanceCriteria: "The ledger balances.",
    });
    const run = await completedRun(routine.id, employee.id);
    const result = await gradeAndPersistRunOutcome({
      run,
      routine,
      employee,
      model,
      runRestricted: async () => ({
        status: "error",
        error: "The selected AI Model is overloaded.",
        unavailable: outage(),
      }),
    });
    assert.equal(result.graded, false);
    assert.equal(result.graded ? null : result.deferred, true);
    const fresh = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(fresh.outcomeVerdict, null, "never a verdict from an outage");
    assert.equal(fresh.outcomeCheckedAt, null, "left for the sweep, not stamped as looked at");
    assert.equal(fresh.status, "completed");
  });

  test("a checker that errors for another reason still records unverified, as before", async () => {
    const { employee, model } = await setup();
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Ledger",
      slug: "ledger-2",
      cronExpr: "0 9 * * *",
      body: "Reconcile.",
      acceptanceCriteria: "The ledger balances.",
    });
    const run = await completedRun(routine.id, employee.id);
    await gradeAndPersistRunOutcome({
      run,
      routine,
      employee,
      model,
      runRestricted: async () => ({ status: "error", error: "prompt is too long" }),
    });
    const fresh = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(fresh.outcomeVerdict, "unverified");
    assert.ok(fresh.outcomeCheckedAt);
  });

  test("the re-grade sweep skips a Run whose model is unavailable, and grades it once back", async (t) => {
    overrideRuntimeSettingsForTests({ containment: { regradeAfterMinutes: 1, regradePerPass: 10 } });
    const { employee, model } = await setup();
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Ledger",
      slug: "ledger-3",
      cronExpr: "0 9 * * *",
      body: "Reconcile.",
      acceptanceCriteria: "The ledger balances.",
    });
    const run = await completedRun(routine.id, employee.id);
    let calls = 0;
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      calls += 1;
      const submit = params.registry.resolve("submit_run_verdict");
      assert.ok(submit, "the checker's one tool");
      await submit.run({ verdict: "achieved", note: "The ledger balanced." });
      return { finalText: "Submitted.", steps: 1, stopReason: "end_turn" };
    });
    down(model);
    await sweepUngradedRuns(new Date());
    assert.equal(calls, 0, "no turn is spent on a model that cannot answer");
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).outcomeVerdict,
      null,
    );
    await back(model);
    await sweepUngradedRuns(new Date());
    assert.equal(calls, 1);
    const graded = await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id });
    assert.equal(graded.outcomeVerdict, "achieved");
    assert.ok(graded.outcomeCheckedAt);
  });
});

describe("Wakeups", () => {
  async function dueWakeup(companyId: string, employeeId: string) {
    return insert(EmployeeWakeup, {
      companyId,
      employeeId,
      at: new Date(Date.now() - 60_000),
      brief: "Check whether the invoice was paid.",
      status: "pending",
    });
  }

  test("a Wakeup due while the model is unavailable stays pending and fires once it is back", async () => {
    const { company, employee, model } = await setup();
    const wakeup = await dueWakeup(company.id, employee.id);
    down(model);
    let calls = 0;
    const runChat = async (): Promise<ChatResult> => {
      calls += 1;
      return { status: "ok", reply: "The invoice was paid.", attachmentIds: [], sidecars: {} };
    };
    await dispatchDueWakeups(new Date(), runChat as never);
    assert.equal(calls, 0);
    let fresh = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({ id: wakeup.id });
    assert.equal(fresh.status, "pending", "deferred, not dropped");
    await back(model);
    await dispatchDueWakeups(new Date(), runChat as never);
    assert.equal(calls, 1);
    fresh = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({ id: wakeup.id });
    assert.equal(fresh.status, "fired");
    assert.equal(fresh.outcomeNote, "The invoice was paid.");
  });

  test("one the outage cut off goes back to pending, and the journal hears nothing", async () => {
    const { company, employee } = await setup();
    const wakeup = await dueWakeup(company.id, employee.id);
    await dispatchDueWakeups(new Date(), (async () => ({
      status: "error",
      reply: "The selected AI Model is overloaded.",
      attachmentIds: [],
      sidecars: {},
      unavailable: outage(),
    })) as never);
    const fresh = await AppDataSource.getRepository(EmployeeWakeup).findOneByOrFail({ id: wakeup.id });
    assert.equal(fresh.status, "pending");
    assert.equal(fresh.firedAt, null);
    assert.equal(fresh.outcomeNote, "");
    assert.equal(await AppDataSource.getRepository(JournalEntry).countBy({ employeeId: employee.id }), 0);
  });
});

describe("a data room's AI work", () => {
  test("waits without spending an attempt while the model is unavailable", async () => {
    const { company, employee, model } = await setup();
    try {
      const room = await createDataRoom({
        companyId: company.id,
        name: "Series A diligence",
        purpose: "fundraising",
        aiEmployeeId: employee.id,
        actor: { kind: "user", userId: "owner" },
      });
      await AppDataSource.getRepository(DataRoomJob).delete({ roomId: room.id });
      const job = await insert(DataRoomJob, {
        companyId: company.id,
        roomId: room.id,
        kind: "readiness",
        targetId: room.id,
        status: "queued",
        attempts: 0,
        runAfter: new Date(Date.now() - 1_000),
      });
      down(model);
      const outcomes = await runDataRoomQueueOnce();
      assert.deepEqual(
        outcomes.map((o) => (o.outcome === "retry" ? o.cause : o.outcome)),
        ["model_unavailable"],
      );
      const fresh = await AppDataSource.getRepository(DataRoomJob).findOneByOrFail({ id: job.id });
      assert.equal(fresh.status, "queued");
      assert.equal(fresh.attempts, 0, "an outage spends no attempt");
      assert.ok(fresh.runAfter.getTime() > Date.now(), "it looks again later");
      assert.match(fresh.error, /unavailable/);
    } finally {
      fs.rmSync(dataRoomPrivateCompanyDir(company.id), { recursive: true, force: true });
    }
  });
});

describe("a meeting's write-up", () => {
  test("waits in processing while the model is unavailable, instead of reading ready", async () => {
    const { company, employee, model } = await setup();
    const meeting = await insert(Meeting, {
      companyId: company.id,
      title: "Weekly sync",
      status: "processing",
      notetakerEmployeeId: employee.id,
      transcriptState: "ready",
      transcriptText: "Ada: we ship Friday.",
    } as Partial<Meeting>);
    let authored = 0;
    setMeetingWriteUpAuthor(async () => {
      authored += 1;
      return null;
    });
    down(model);
    const result = await writeUpMeeting(company.id, meeting.id);
    assert.equal(result.status, "deferred");
    assert.equal(authored, 0);
  });
});

describe("a scheduled briefing", () => {
  test("stays due while its author's model is unavailable, rather than failing every pass", async () => {
    const { company, employee, model } = await setup();
    await insert(TldrSettings, {
      companyId: company.id,
      employeeId: employee.id,
      enabled: true,
      cadence: "daily",
      nextRunAt: new Date(Date.now() - 60_000),
    } as Partial<TldrSettings>);
    down(model);
    const result = await dispatchDueTldrs(new Date());
    assert.equal(result.started, 0);
    const settings = await AppDataSource.getRepository(TldrSettings).findOneByOrFail({
      companyId: company.id,
    });
    assert.ok(settings.nextRunAt && settings.nextRunAt.getTime() <= Date.now(), "still due");
    assert.equal(settings.activeTldrId, null);
  });
});
