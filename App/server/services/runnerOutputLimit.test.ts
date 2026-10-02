import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { agentRuntime } from "./agent/runtime.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { startRoutineRun } from "./runner.js";
import { resumeRoutineQueue, waitForRoutineQueueIdle } from "./routineQueue.js";
import { stopStanddowns } from "./standdowns.js";

before(initTestDb);
beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  await closeTestDb();
});

async function routine() {
  const company = await insert(Company, { name: "Backfill", slug: "backfill", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Sales",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "custom",
    model: "Qwen/Qwen3.8-27B",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    contextWindow: 262144,
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret("http://127.0.0.1:19999/v1"),
      modelId: "Qwen/Qwen3.8-27B",
    }),
  });
  return insert(Routine, {
    employeeId: employee.id,
    name: "Historical Email Lead Backfill",
    slug: "historical-email-lead-backfill",
    cronExpr: "0 2 * * *",
    body: "Backfill leads from historical email.",
  });
}

// The 2026-10-01 02:00 Run of this Routine thought for exactly 8,192 tokens,
// was cut off before its first tool call, and was recorded as Completed.
test("a response cut off at the model's output limit is an Error, not completed work", async (t) => {
  const backfill = await routine();
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    params.callbacks?.onUsage?.({ inputTokens: 45_747, outputTokens: 8_192 });
    return { finalText: "", steps: 1, stopReason: "length" };
  });
  const run = await (await startRoutineRun(backfill, { triggerKind: "schedule" })).completion;
  assert.equal(run.status, "error");
  assert.equal(run.errorKind, "runtime");
  assert.match(run.logContent, /\[error\] The AI Model's response was cut off at its output limit/);
  assert.doesNotMatch(run.logContent, /\[work-summary\]/);
});

test("a response that ends normally still completes", async (t) => {
  const backfill = await routine();
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "Backfilled 3 leads.",
    steps: 4,
    stopReason: "end_turn",
  }));
  const run = await (await startRoutineRun(backfill, { triggerKind: "schedule" })).completion;
  assert.equal(run.status, "completed");
});

// 2026-10-02: a YouTube prospecting Run ended its turn with no reply, even
// before the runtime learned to ask again, and was recorded as Completed.
test("a turn that ends without a final report is unfinished, not completed", async (t) => {
  const backfill = await routine();
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    params.callbacks?.onSilentStop?.();
    params.callbacks?.onUsage?.({ inputTokens: 86_183, outputTokens: 18_334 });
    return { finalText: "", steps: 9, stopReason: "end_turn" };
  });
  const run = await (await startRoutineRun(backfill, { triggerKind: "manual" })).completion;
  assert.equal(run.status, "failed");
  assert.equal(run.errorKind, null);
  assert.match(run.logContent, /\[nudge\] The AI Model stopped without a reply or a tool call/);
  assert.match(run.logContent, /\[failed\] The AI Model ended its turn without a final report/);
  assert.doesNotMatch(run.logContent, /\[work-summary\]/);
});

// 2026-10-02: a restart of the self-hosted model server ended both Runs on it.
// A work turn now waits for the server, and its log says so.
test("a Run that waited out its model server's restart says so and completes", async (t) => {
  const backfill = await routine();
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    params.callbacks?.onModelOutage?.({ state: "waiting", waitedMs: 0 });
    params.callbacks?.onModelOutage?.({ state: "answered", waitedMs: 330_000 });
    return { finalText: "Backfilled 3 leads.", steps: 6, stopReason: "end_turn" };
  });
  const run = await (await startRoutineRun(backfill, { triggerKind: "schedule" })).completion;
  assert.equal(run.status, "completed");
  assert.match(
    run.logContent,
    /\[model\] The AI Model's server stopped answering\. This Run waits for it and continues once it answers/,
  );
  assert.match(
    run.logContent,
    /\[model\] The AI Model's server answered again after 6m; continuing\./,
  );
});
