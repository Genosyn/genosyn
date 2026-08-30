import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Standdown } from "../db/entities/Standdown.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { createCheck } from "./routineChecks.js";
import { startRoutineRun } from "./runner.js";
import { stopStanddowns } from "./standdowns.js";
import {
  overrideRuntimeSettingsForTests,
  resetRuntimeSettingsCacheForTests,
} from "./runtimeSettings.js";

/**
 * The Routine circuit breaker (M58).
 *
 * `updateRoutineBreaker` is private to `runner.ts` and has no injection seam,
 * so everything here is driven the only way it can be: a real Run, end to end,
 * against a local OpenAI-compatible endpoint standing in for the AI Model. The
 * pattern is `durableChatInterrupt.test.ts`'s, for the same reason — a breaker
 * that counts the wrong Runs compiles perfectly, and only the finished row on
 * the Routine says whether it counted the right ones.
 *
 * What the breaker is for is worth keeping in view while reading the cases: a
 * Routine whose integration was deleted fires on its cron forever, failing
 * identically and spending model budget every slot, until a human notices. The
 * counter is the noticing.
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
        // A 4xx is deliberately not retryable (see `modelRetry.ts`), so the
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
      choices: [
        { index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
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
    // own tests, and the breaker reads `outcomeVerdict` rather than producing it.
    acceptanceCriteria: "",
    timeoutSec: 60,
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

async function breakerStanddowns(routineId: string): Promise<Standdown[]> {
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
    assert.equal(first.status, "failed");
    assert.equal(await failuresOn(routine.id), 1);

    const second = await runOnce(routine);
    assert.equal(second.status, "failed");
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

    assert.equal(run.status, "completed", "the loop returned; only the Checks disagreed");
    assert.equal(run.checksVerdict, "failed");
    assert.equal(
      await failuresOn(routine.id),
      1,
      "a green status with a red Check is not a good Run",
    );
  });

  test("a Run with a retry still owed does not increment", async () => {
    await connectModel();
    const routine = await makeRoutine({ maxAttempts: 3, retryBackoffSec: 3600 });
    upstreamMode = "reject";

    const run = await runOnce(routine);

    assert.equal(run.status, "failed");
    assert.notEqual(run.retryAt, null, "the fixture must actually owe a retry");
    assert.equal(
      await failuresOn(routine.id),
      0,
      "counting every attempt would trip the breaker inside one bad hour",
    );
  });

  test("a skipped Run does not count", async () => {
    // Deliberately no model. Note this passes for a stronger reason than the
    // `run.status === "skipped"` guard inside the breaker: the no-model branch
    // in `startRoutineRun` returns before the breaker is reached at all, so
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

describe("tripping the breaker", () => {
  test("crossing the threshold places exactly one breaker-sourced Standdown", async () => {
    overrideRuntimeSettingsForTests({ containment: { routineBreakerThreshold: 2 } });
    await connectModel();
    const routine = await makeRoutine();
    upstreamMode = "reject";

    await runOnce(routine);
    assert.deepEqual(await breakerStanddowns(routine.id), [], "one failure is not a pattern");

    await runOnce(routine);

    const placed = await breakerStanddowns(routine.id);
    assert.equal(placed.length, 1);
    assert.equal(placed[0].source, "breaker");
    assert.equal(placed[0].placedByUserId, null);
    assert.match(placed[0].reason, /2 consecutive failed Runs/);
    assert.equal(await failuresOn(routine.id), 2);

    // And the stop is live: the Routine's next slot is refused rather than
    // spending another model turn on the same failure.
    const turnsBefore = upstreamTurns;
    await assert.rejects(() => runOnce(routine));
    assert.equal(upstreamTurns, turnsBefore);
    assert.equal((await breakerStanddowns(routine.id)).length, 1);
  });

  test("a threshold of 0 disables the breaker without disabling the counter", async () => {
    overrideRuntimeSettingsForTests({ containment: { routineBreakerThreshold: 0 } });
    await connectModel();
    const routine = await makeRoutine();
    upstreamMode = "reject";

    await runOnce(routine);
    await runOnce(routine);
    await runOnce(routine);

    assert.equal(await failuresOn(routine.id), 3);
    assert.deepEqual(await breakerStanddowns(routine.id), []);
  });

  test("the counter is per Routine, not per AI Employee", async () => {
    overrideRuntimeSettingsForTests({ containment: { routineBreakerThreshold: 2 } });
    await connectModel();
    const broken = await makeRoutine();
    const healthy = await makeRoutine();
    upstreamMode = "reject";

    await runOnce(broken);
    await runOnce(broken);

    assert.equal(await failuresOn(healthy.id), 0);
    assert.deepEqual(await breakerStanddowns(healthy.id), []);
  });
});

describe("Runs the breaker never sees", () => {
  /**
   * KNOWN FAILING — reported, not fixed.
   *
   * `finalizeTimedOutRun` (services/runner.ts:321-340) returns the Run
   * directly, and every one of its call sites in the completion body is a
   * bare `return timedOutRun;`. `updateRoutineBreaker` is the last statement
   * of the happy path (services/runner.ts:671), so a Run that exhausts
   * `Routine.timeoutSec` never reaches it. Neither does one that throws: the
   * catch at services/runner.ts:673 returns without calling it either.
   *
   * That is precisely the population the breaker was written for. A Routine
   * whose integration was deleted usually hangs and times out rather than
   * returning a tidy provider error, and this one fires on its cron forever
   * with `consecutiveFailures` pinned at 0. The counter also never *resets*
   * on those paths, but that direction is safe; this one is not.
   */
  test("a timed-out Run increments the counter", async () => {
    await connectModel();
    const routine = await makeRoutine({ timeoutSec: 1, retryOnTimeout: false });

    const fresh = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    const started = await startRoutineRun(fresh, {
      triggerKind: "schedule",
      beforeRunPersist: () => new Promise((resolve) => setTimeout(resolve, 1_050)),
    });
    const run = await started.completion;

    assert.equal(run.status, "timeout");
    assert.equal(run.retryAt, null, "no retry is owed, so nothing defers the count");
    assert.equal(
      await failuresOn(routine.id),
      1,
      "a Routine that times out every slot is exactly what the breaker exists to stop",
    );
  });
});
