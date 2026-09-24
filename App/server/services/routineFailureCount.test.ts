import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Standdown } from "../db/entities/Standdown.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { createCheck } from "./routineChecks.js";
import { startRoutineRun } from "./runner.js";
import { placeStanddown, StanddownError, stopStanddowns } from "./standdowns.js";
import {
  RUNTIME_SETTING_KEYS,
  reloadRuntimeSettings,
  resetRuntimeSettingsCacheForTests,
} from "./runtimeSettings.js";

/**
 * Drive real Runs against a local AI Model to verify failure accounting and
 * continued scheduling after repeated failures, including old saved settings.
 */

/** How the scripted model answers the next turn. Set per test. */
type UpstreamMode = "ok" | "reject";
let upstreamMode: UpstreamMode = "ok";
/** Every model turn this Run family made — remediation rounds included. */
let upstreamTurns = 0;

let upstream: Server;
let upstreamBaseUrl = "";
let previousAllowlist: string[] = [];

let company: Company;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  upstream = createServer((request, response) => {
    void drain(request).then(() => {
      upstreamTurns += 1;
      if (upstreamMode === "reject") {
        // A permanent 4xx is not retried by OpenCode, so the
        // turn fails once and immediately rather than riding out ten backoffs.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "the model rejected this request" } }));
        return;
      }
      sendCompletion(response, "Everything asked for is done.");
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  previousAllowlist = [...config.security.outboundPrivateHostAllowlist];
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
});

after(async () => {
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
  stopStanddowns();
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    upstream.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // The body is not interesting here; it just has to be consumed.
  }
}

function sendCompletion(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.write(
    `data: ${JSON.stringify({
      id: "breaker-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: "breaker-test",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

beforeEach(async () => {
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  upstreamMode = "ok";
  upstreamTurns = 0;
  await resetTestDb();
  company = await insert(Company, {
    name: "Breaker Co",
    slug: "breaker-co",
    ownerId: "owner-breaker",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Bree Breaker",
    slug: "bree-breaker",
    role: "Operations",
  });
});

afterEach(() => {
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
});

/** An employee with a working brain, so Runs actually execute. */
async function connectModel(): Promise<AIModel> {
  return insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "breaker-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(upstreamBaseUrl),
      modelId: "breaker-test",
    }),
  });
}

let routineSeq = 0;

async function makeRoutine(values: Partial<Routine> = {}): Promise<Routine> {
  routineSeq += 1;
  return insert(Routine, {
    employeeId: employee.id,
    name: `Breaker routine ${routineSeq}`,
    slug: `breaker-routine-${routineSeq}`,
    cronExpr: "0 3 * * *",
    body: "Do the work.",
    // No acceptance criteria: outcome grading is a separate model turn with its
    // own tests, and the failure counter reads `outcomeVerdict` rather than producing it.
    acceptanceCriteria: "",
    timeoutSec: 180,
    maxAttempts: 1,
    ...values,
  });
}

async function runOnce(routine: Routine): Promise<Run> {
  const fresh = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
  const started = await startRoutineRun(fresh, { triggerKind: "schedule" });
  return started.completion;
}

async function failuresOn(routineId: string): Promise<number> {
  const row = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routineId });
  return row.consecutiveFailures;
}

async function routineStanddowns(routineId: string): Promise<Standdown[]> {
  return AppDataSource.getRepository(Standdown).find({
    where: { companyId: company.id, scope: "routine", scopeId: routineId },
  });
}

describe("counting bad Runs", () => {
  test("each failed Run increments the counter", async () => {
    await connectModel();
    const routine = await makeRoutine();
    upstreamMode = "reject";

    const first = await runOnce(routine);
    assert.equal(first.status, "error");
    assert.equal(await failuresOn(routine.id), 1);

    const second = await runOnce(routine);
    assert.equal(second.status, "error");
    assert.equal(await failuresOn(routine.id), 2);
  });

  test("a clean Run resets the counter to zero", async () => {
    await connectModel();
    const routine = await makeRoutine();
    await AppDataSource.getRepository(Routine).update(
      { id: routine.id },
      { consecutiveFailures: 3 },
    );

    const run = await runOnce(routine);

    assert.equal(run.status, "completed");
    assert.equal(run.checksVerdict, "not_run");
    assert.equal(await failuresOn(routine.id), 0);
  });

  test("a completed Run whose Checks failed still counts as bad", async () => {
    await connectModel();
    const routine = await makeRoutine();
    await AppDataSource.getRepository(Routine).update({ id: routine.id }, { consecutiveFailures: 4 });
    // An effect Check nothing in this Run can satisfy: the ledger records what
    // the *server* did, and this Run writes no invoice.
    await createCheck({
      companyId: company.id,
      routineId: routine.id,
      name: "an invoice was sent",
      kind: "effect",
      spec: JSON.stringify({ action: "invoice.send", min: 1 }),
      createdById: null,
    });

    const run = await runOnce(routine);

    assert.equal(run.status, "failed", "required Checks determine whether the work finished");
    assert.equal(run.checksVerdict, "failed");
    assert.equal(
      await failuresOn(routine.id),
      5,
      "a green status with a red Check is not a good Run",
    );
    assert.deepEqual(await routineStanddowns(routine.id), []);
  });

  test("a Run with a retry still owed does not increment", async () => {
    await connectModel();
    const routine = await makeRoutine({ maxAttempts: 3, retryBackoffSec: 3600 });
    upstreamMode = "reject";

    const run = await runOnce(routine);

    assert.equal(run.status, "error");
    assert.equal(run.errorKind, "runtime");
    assert.notEqual(run.retryAt, null, "the fixture must actually owe a retry");
    assert.equal(
      await failuresOn(routine.id),
      0,
      "only an exhausted retry chain counts as a failure",
    );
  });

  test("a skipped Run does not count", async () => {
    // Deliberately no model. Note this passes for a stronger reason than the
    // `run.status === "skipped"` guard inside the counter: the no-model branch
    // in `startRoutineRun` returns before the counter is reached at all, so
    // that guard is unreachable today. The observable contract still holds.
    const routine = await makeRoutine();
    await AppDataSource.getRepository(Routine).update(
      { id: routine.id },
      { consecutiveFailures: 1 },
    );

    const run = await runOnce(routine);

    assert.equal(run.status, "skipped");
    assert.equal(await failuresOn(routine.id), 1, "a Run that never started did not fail");
  });
});

describe("continued work after failures", () => {
  test("repeated failures keep running even with a saved legacy threshold", async () => {
    await insert(AppSetting, {
      key: RUNTIME_SETTING_KEYS.containment,
      value: JSON.stringify({ routineBreakerThreshold: 2 }),
    });
    await reloadRuntimeSettings();
    await connectModel();
    // Already close to the old default threshold as well as above the saved one.
    const routine = await makeRoutine({ consecutiveFailures: 4 });
    upstreamMode = "reject";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const turnsBefore = upstreamTurns;
      const run = await runOnce(routine);
      assert.equal(run.status, "error");
      assert.ok(upstreamTurns > turnsBefore, "the next slot still reaches the AI Model");
      assert.equal(await failuresOn(routine.id), 5 + attempt);
      assert.deepEqual(await routineStanddowns(routine.id), []);
      const current = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
      assert.equal(current.enabled, true);
      assert.ok(current.nextRunAt, "the Routine retains its next scheduled slot");
    }
  });

  for (const source of ["human", "breaker"] as const) {
    test(`an existing ${source} Standdown still blocks the next Run`, async () => {
      await connectModel();
      const routine = await makeRoutine({ consecutiveFailures: 8 });
      await placeStanddown({
        companyId: company.id,
        scope: "routine",
        scopeId: routine.id,
        source,
        reason: "Work has been stopped pending review.",
      });

      const turnsBefore = upstreamTurns;
      await assert.rejects(() => runOnce(routine), StanddownError);
      assert.equal(upstreamTurns, turnsBefore);
      assert.equal((await routineStanddowns(routine.id)).length, 1);
    });
  }

  test("the counter is per Routine, not per AI Employee", async () => {
    await connectModel();
    const broken = await makeRoutine();
    const healthy = await makeRoutine();
    upstreamMode = "reject";

    await runOnce(broken);
    await runOnce(broken);

    assert.equal(await failuresOn(healthy.id), 0);
    assert.deepEqual(await routineStanddowns(healthy.id), []);
  });
});

describe("timeout failure accounting", () => {
  test("a timed-out Run increments the counter", async () => {
    await connectModel();
    const routine = await makeRoutine({ timeoutSec: 1, retryOnTimeout: false, consecutiveFailures: 4 });

    const fresh = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    const started = await startRoutineRun(fresh, {
      triggerKind: "schedule",
      beforeRunPersist: () => new Promise((resolve) => setTimeout(resolve, 1_050)),
    });
    const run = await started.completion;

    assert.equal(run.status, "error");
    assert.equal(run.errorKind, "timeout");
    assert.equal(run.retryAt, null, "no retry is owed, so nothing defers the count");
    assert.equal(
      await failuresOn(routine.id),
      5,
      "timeouts still contribute to the diagnostic failure count",
    );
    assert.deepEqual(await routineStanddowns(routine.id), []);
  });
});
