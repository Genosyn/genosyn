import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { InputRequest } from "../db/entities/InputRequest.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { addMember } from "../test/accessFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { agentRuntime } from "./agent/runtime.js";
import { stopCron, tickRoutine } from "./cron.js";
import {
  answerInputRequest,
  awaitPersonAtPage,
  declineInputRequest,
  openAnswerInputRequest,
  openPageInputRequest,
  parkRunForRequest,
  readyInputRequest,
  settleInputRequestPingsForTests,
  sweepInputRequests,
} from "./inputRequests.js";
import { isTokenTainted, markTokenTainted } from "./mcpTokens.js";
import { resetModelAvailabilityForTests } from "./modelAvailability.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import {
  dispatchQueuedRoutineRuns,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
} from "./routineQueue.js";
import {
  MAX_RUN_PAUSES,
  clearLocalRunPause,
  pauseLocalRuns,
  resetRunPausesForTests,
  restartPauseCount,
} from "./runPause.js";
import { startRoutineRun } from "./runner.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";
import { liftStanddown, placeStanddown, stopStanddowns } from "./standdowns.js";
import { taintGateApplies } from "./taintPolicy.js";

/**
 * A Routine Run that needs a person pauses as itself, through the real runner and the
 * real queue. The bar, from AGENTS.md §3: it can sit for days and cost nothing, nobody
 * taking their time counts against anyone, and when they come the same Run carries on,
 * first in the queue, knowing what happened.
 */

before(initTestDb);
beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  resetRunPausesForTests();
  resetModelAvailabilityForTests();
  overrideRuntimeSettingsForTests({ modelAvailability: { resumeIntervalSeconds: 0 } });
  await settleInputRequestPingsForTests();
  await resetTestDb();
  await resumeRoutineQueue();
});
afterEach(async () => {
  await waitForRoutineQueueIdle();
  await settleInputRequestPingsForTests();
  resetRunPausesForTests();
  resetModelAvailabilityForTests();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  overrideRuntimeSettingsForTests(null);
  await closeTestDb();
});

type RuntimeParams = Parameters<typeof agentRuntime.run>[0];
type RuntimeResult = Awaited<ReturnType<typeof agentRuntime.run>>;

const PAGE = "https://login.freeagent.test/two-factor";

async function fixture() {
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  const owner = await addMember(company.id, "owner", { name: "Ola Owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Mira",
    slug: "mira",
    role: "Finance",
  });
  await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: "{}",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "File VAT",
    slug: "file-vat",
    cronExpr: "0 9 1 * *",
    timeoutSec: 3600,
    maxAttempts: 3,
    body: "File the VAT return on FreeAgent.",
  });
  return { company, owner, employee, routine, actor: { userId: owner.id, role: "owner" as const } };
}

/** Grading and lessons go through the runtime too; answer them at once. */
function sideTurn(params: RuntimeParams): RuntimeResult | null {
  if (params.registry.resolve("submit_lesson"))
    return { finalText: "No lesson.", steps: 1, stopReason: "end_turn" };
  if (params.registry.resolve("submit_run_verdict"))
    return { finalText: "No verdict.", steps: 1, stopReason: "end_turn" };
  return null;
}

const runs = () => AppDataSource.getRepository(Run);
const requests = () => AppDataSource.getRepository(InputRequest);

async function row(runId: string): Promise<Run> {
  return runs().findOneByOrFail({ id: runId });
}

async function waitFor(runId: string, done: (run: Run) => boolean, label: string): Promise<Run> {
  for (let i = 0; i < 800; i++) {
    const current = await row(runId);
    if (done(current)) return current;
    await delay(10);
  }
  throw new Error(`Run ${runId} never ${label}.`);
}

const heldForPerson = (run: Run) => run.status === "queued" && run.pauseReason === "person";
const finished = (run: Run) => !["queued", "running"].includes(run.status);

/**
 * What the browser's tool does when nobody comes, with the wait already over: the page
 * stops being held, the reply goes back, and the Run's turn is stopped.
 */
async function nobodyComesToThePage(
  f: Awaited<ReturnType<typeof fixture>>,
  runId: string,
): Promise<InputRequest> {
  const asked = await openPageInputRequest({
    companyId: f.company.id,
    employeeId: f.employee.id,
    kind: "code",
    title: "FreeAgent sign-in code",
    named: null,
    work: { runId, routineId: f.routine.id, browserSessionId: "session-1" },
    pageUrl: PAGE,
  });
  await requests().update({ id: asked.id }, { askingUntil: new Date(Date.now() - 1_000) });
  const answer = await awaitPersonAtPage({ requestId: asked.id, companyId: f.company.id });
  assert.equal(answer.outcome, "lapsed");
  assert.equal(parkRunForRequest(answer.request as InputRequest), true, "the runner hears at once");
  return answer.request as InputRequest;
}

/** A turn stopping when it's told to, however the runtime reports that. */
async function untilStopped(params: RuntimeParams): Promise<RuntimeResult> {
  if (!params.signal?.aborted) {
    await new Promise<void>((resolve) =>
      params.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  return { finalText: "", steps: 1, stopReason: "aborted" };
}

async function runningRun(routineId: string): Promise<Run> {
  return runs().findOneByOrFail({ routineId, status: "running" });
}

describe("a Run that read something from outside", () => {
  /** A turn's token, which it lists its own tools with before the model starts. */
  function watchTurnToken(t: TestContext): () => string {
    let token = "";
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/api/internal/mcp")) return realFetch(input, init);
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      if (bearer.startsWith("Bearer ")) token = bearer.slice("Bearer ".length);
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    });
    return () => token;
  }

  test("is still gated when a person's answer brings it back", async (t) => {
    const f = await fixture();
    const token = watchTurnToken(t);
    const turns: boolean[] = [];
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turns.push(taintGateApplies(token(), "send_mail"));
      if (turns.length > 1) return { finalText: "Done.", steps: 1, stopReason: "end_turn" };
      markTokenTainted(token());
      const asked = await openAnswerInputRequest({
        companyId: f.company.id,
        employeeId: f.employee.id,
        title: "Which VAT number should I use?",
        work: { runId: (await runningRun(f.routine.id)).id, routineId: f.routine.id },
        tainted: isTokenTainted(token()),
      });
      assert.equal(parkRunForRequest(asked.request), true);
      return untilStopped(params);
    });

    const { run } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    const paused = await waitFor(run.id, heldForPerson, "paused for a person");
    await waitForRoutineQueueIdle();
    assert.equal(paused.tainted, true, "it's on the row, since the token dies with the turn");

    await answerInputRequest({
      companyId: f.company.id,
      id: paused.waitingOnInputRequestId!,
      actor: f.actor,
      value: "GB123",
    });
    await waitFor(run.id, finished, "finished");
    await waitForRoutineQueueIdle();
    assert.deepEqual(turns, [false, true], "held on the way back, and only after reading");
    assert.equal((await row(run.id)).tainted, true, "and there's no untaint");
  });

  test("is still gated when a restart brings it back", async (t) => {
    const f = await fixture();
    const token = watchTurnToken(t);
    const turns: boolean[] = [];
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turns.push(taintGateApplies(token(), "send_mail"));
      if (turns.length > 1) return { finalText: "Done.", steps: 1, stopReason: "end_turn" };
      markTokenTainted(token());
      void pauseLocalRuns({ graceMs: 0, reason: "restart" });
      return untilStopped(params);
    });

    const { run } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    const paused = await waitFor(
      run.id,
      (current) => current.status === "queued" && current.pauseReason === "restart",
      "paused for the restart",
    );
    assert.equal(paused.tainted, true);
    await waitForRoutineQueueIdle();
    clearLocalRunPause();
    await dispatchQueuedRoutineRuns();
    await waitFor(run.id, finished, "finished");
    await waitForRoutineQueueIdle();
    assert.deepEqual(turns, [false, true]);
  });

  test("a Run that read nothing comes back as open as it left", async (t) => {
    const f = await fixture();
    const token = watchTurnToken(t);
    const turns: boolean[] = [];
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turns.push(taintGateApplies(token(), "send_mail"));
      if (turns.length > 1) return { finalText: "Done.", steps: 1, stopReason: "end_turn" };
      const asked = await openAnswerInputRequest({
        companyId: f.company.id,
        employeeId: f.employee.id,
        title: "Which VAT number should I use?",
        work: { runId: (await runningRun(f.routine.id)).id, routineId: f.routine.id },
      });
      assert.equal(parkRunForRequest(asked.request), true);
      return untilStopped(params);
    });
    const { run } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    const paused = await waitFor(run.id, heldForPerson, "paused for a person");
    await waitForRoutineQueueIdle();
    assert.equal(paused.tainted, false);
    await answerInputRequest({
      companyId: f.company.id,
      id: paused.waitingOnInputRequestId!,
      actor: f.actor,
      value: "GB123",
    });
    await waitFor(run.id, finished, "finished");
    await waitForRoutineQueueIdle();
    assert.deepEqual(turns, [false, false]);
  });
});

describe("a Run waiting on a person", () => {
  test("pauses as itself, holding nothing, and records nothing final", async (t) => {
    const f = await fixture();
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      params.callbacks?.onText?.("Signed in to FreeAgent. It wants a code.\n");
      params.callbacks?.onUsage?.({ inputTokens: 1_000, outputTokens: 100 });
      await nobodyComesToThePage(f, (await runningRun(f.routine.id)).id);
      return untilStopped(params);
    });
    const { run: accepted } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    const paused = await waitFor(accepted.id, heldForPerson, "paused for a person");
    await waitForRoutineQueueIdle();

    assert.equal(paused.status, "queued");
    assert.equal(paused.queueActiveEmployeeId, null, "no slot held");
    assert.equal(paused.pauseCount, 1);
    assert.equal(paused.personPauses, 1);
    assert.ok(paused.waitingOnInputRequestId);
    assert.ok(paused.pauseRemainingMs! > 0, "it keeps the time it had left");
    assert.match(paused.logContent, /Signed in to FreeAgent/);
    assert.match(paused.logContent, /\[paused\] Waiting for a person/);
    assert.equal(paused.tokensIn, 1_000);
    assert.equal(paused.outcomeVerdict, null);
    assert.equal(paused.checksVerdict, null);
    assert.equal(paused.finishedAt, null);
    assert.equal(paused.retryAt, null);
    assert.equal(
      await AppDataSource.getRepository(JournalEntry).countBy({ employeeId: f.employee.id }),
      0,
    );
    const failure = await AppDataSource.getRepository(Notification).countBy({ kind: "run_failed" });
    assert.equal(failure, 0, "a person taking their time counts against nobody");

    // However often the queue looks, it doesn't start: nothing has changed.
    await dispatchQueuedRoutineRuns();
    await dispatchQueuedRoutineRuns();
    await waitForRoutineQueueIdle();
    assert.equal(turn, 1);
    assert.equal((await row(accepted.id)).status, "queued");
  });

  test("I'm ready resumes the same Run, told to sign in again, with the time it had left", async (t) => {
    const f = await fixture();
    let turn = 0;
    let resumedBrief = "";
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      if (turn === 1) {
        params.callbacks?.onText?.("Signed in. It wants a code.\n");
        await nobodyComesToThePage(f, (await runningRun(f.routine.id)).id);
        return untilStopped(params);
      }
      resumedBrief = JSON.stringify(params.messages);
      params.callbacks?.onText?.("Signed in again, got a fresh code, filed the VAT return.\n");
      return { finalText: "Filed.", steps: 3, stopReason: "end_turn" };
    });
    const { run: accepted } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    const paused = await waitFor(accepted.id, heldForPerson, "paused for a person");
    await waitForRoutineQueueIdle();
    assert.equal(turn, 1);

    await readyInputRequest({
      companyId: f.company.id,
      id: paused.waitingOnInputRequestId!,
      actor: f.actor,
    });
    const done = await waitFor(accepted.id, finished, "finished");
    await waitForRoutineQueueIdle();

    assert.equal(turn, 2, "one more turn, and only because a person came");
    assert.equal(done.id, accepted.id, "the same Run");
    assert.equal(done.status, "completed");
    assert.equal(done.pauseCount, 1);
    assert.match(done.logContent, /Signed in. It wants a code/);
    assert.match(done.logContent, /\[resumed\] A person came back to it/);
    assert.match(done.logContent, /filed the VAT return/);
    assert.match(resumedBrief, /Resume this Run now that a person has answered/);
    assert.match(resumedBrief, /just said they're ready/);
    assert.match(resumedBrief, /sign in again from the start/);
    assert.match(resumedBrief, /browser_ask_person/);

    // It ended without asking again, so the sweep closes what's left of it.
    await sweepInputRequests();
    const closed = await requests().findOneByOrFail({ id: paused.waitingOnInputRequestId! });
    assert.equal(closed.status, "closed");
  });

  test("gone again after saying they're ready: it pauses again, with no restart spent", async (t) => {
    const f = await fixture();
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      await nobodyComesToThePage(f, (await runningRun(f.routine.id)).id);
      return untilStopped(params);
    });
    const { run: accepted } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    let current = await waitFor(accepted.id, heldForPerson, "paused");
    for (let round = 2; round <= MAX_RUN_PAUSES + 2; round += 1) {
      await waitForRoutineQueueIdle();
      await readyInputRequest({
        companyId: f.company.id,
        id: current.waitingOnInputRequestId!,
        actor: f.actor,
      });
      current = await waitFor(
        accepted.id,
        (run) => heldForPerson(run) && run.personPauses === round,
        `paused ${round} times`,
      );
    }
    await waitForRoutineQueueIdle();
    assert.equal(current.status, "queued", "still waiting, long past the bound on restarts");
    assert.equal(restartPauseCount(current), 0);
    assert.equal(await requests().count(), 1, "one person, one request");
    assert.equal(turn, MAX_RUN_PAUSES + 2);
  });

  test("a turn that ends with a person owed an answer pauses rather than finishing", async (t) => {
    const f = await fixture();
    let turn = 0;
    let answerInBrief = "";
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      if (turn === 1) {
        // `ask_person`, whose reply tells the model to end its turn. This one ends
        // it before the pause reaches it, so the runner has to catch it at the end.
        await openAnswerInputRequest({
          companyId: f.company.id,
          employeeId: f.employee.id,
          title: "Which VAT quarter is this for?",
          work: { runId: (await runningRun(f.routine.id)).id, routineId: f.routine.id },
        });
        return { finalText: "I've asked.", steps: 1, stopReason: "end_turn" };
      }
      answerInBrief = JSON.stringify(params.messages);
      return { finalText: "Filed Q3.", steps: 2, stopReason: "end_turn" };
    });
    const { run: accepted } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    const paused = await waitFor(accepted.id, heldForPerson, "paused");
    await waitForRoutineQueueIdle();
    assert.equal(paused.outcomeVerdict, null, "not a finished Run");

    await answerInputRequest({
      companyId: f.company.id,
      id: paused.waitingOnInputRequestId!,
      actor: f.actor,
      value: "Q3, July to September",
    });
    const done = await waitFor(accepted.id, finished, "finished");
    assert.equal(done.status, "completed");
    assert.match(answerInBrief, /Q3, July to September/);
  });

  test("I can't resumes it too, told so, and it reports what stayed undone", async (t) => {
    const f = await fixture();
    let turn = 0;
    let brief = "";
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      if (turn === 1) {
        await nobodyComesToThePage(f, (await runningRun(f.routine.id)).id);
        return untilStopped(params);
      }
      brief = JSON.stringify(params.messages);
      return { finalText: "Could not file it.", steps: 1, stopReason: "end_turn" };
    });
    const { run: accepted } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    const paused = await waitFor(accepted.id, heldForPerson, "paused");
    await waitForRoutineQueueIdle();
    await declineInputRequest({
      companyId: f.company.id,
      id: paused.waitingOnInputRequestId!,
      actor: f.actor,
      note: "I'm away until Monday",
    });
    await waitFor(accepted.id, finished, "finished");
    assert.match(brief, /said they can't help/);
    assert.match(brief, /away until Monday/);
    assert.match(brief, /stayed undone/);
  });

  test("a scheduled occurrence that comes due folds in, so no second one queues up", async (t) => {
    const f = await fixture();
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      await nobodyComesToThePage(f, (await runningRun(f.routine.id)).id);
      return untilStopped(params);
    });
    const { run: accepted } = await startRoutineRun(f.routine, { triggerKind: "schedule" });
    await waitFor(accepted.id, heldForPerson, "paused");
    await waitForRoutineQueueIdle();

    await tickRoutine(f.routine.id, { missedSlots: 0 }, () => undefined);
    await waitForRoutineQueueIdle();

    const all = await runs().findBy({ routineId: f.routine.id });
    assert.equal(all.length, 1, "this month's VAT return doesn't queue behind last month's");
    assert.equal(all[0].missedSlots, 1, "and the one waiting knows it now covers both");
    assert.ok(all[0].waitingOnInputRequestId, "still waiting for its person");
  });

  test("a restart while it waits leaves it waiting", async (t) => {
    const f = await fixture();
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      await nobodyComesToThePage(f, (await runningRun(f.routine.id)).id);
      return untilStopped(params);
    });
    const { run: accepted } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    await waitFor(accepted.id, heldForPerson, "paused");
    await waitForRoutineQueueIdle();
    await pauseLocalRuns({ graceMs: 0, reason: "restart" }, { timeoutMs: 5_000 });
    resetRunPausesForTests();
    await dispatchQueuedRoutineRuns();
    await waitForRoutineQueueIdle();
    const after = await row(accepted.id);
    assert.equal(after.pauseReason, "person");
    assert.ok(after.waitingOnInputRequestId);
    assert.equal(turn, 1);
  });

  test("a Standdown wins: ready doesn't start it until the Standdown is lifted", async (t) => {
    const f = await fixture();
    let turn = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      const side = sideTurn(params);
      if (side) return side;
      turn += 1;
      if (turn === 1) {
        await nobodyComesToThePage(f, (await runningRun(f.routine.id)).id);
        return untilStopped(params);
      }
      return { finalText: "Done.", steps: 1, stopReason: "end_turn" };
    });
    const { run: accepted } = await startRoutineRun(f.routine, { triggerKind: "manual" });
    const paused = await waitFor(accepted.id, heldForPerson, "paused");
    await waitForRoutineQueueIdle();
    const standdown = await placeStanddown({
      companyId: f.company.id,
      scope: "company",
      reason: "Stop everything",
      placedByUserId: f.owner.id,
    });
    await readyInputRequest({
      companyId: f.company.id,
      id: paused.waitingOnInputRequestId!,
      actor: f.actor,
    });
    await dispatchQueuedRoutineRuns();
    await waitForRoutineQueueIdle();
    assert.equal(turn, 1, "a person being ready doesn't lift a Standdown");
    assert.equal((await row(accepted.id)).status, "queued");

    await liftStanddown({ standdown, userId: f.owner.id });
    await dispatchQueuedRoutineRuns();
    await waitFor(accepted.id, finished, "finished after the lift");
    assert.equal(turn, 2);
  });
});
