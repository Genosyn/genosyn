import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../../config.js";
import { MODEL_UNAVAILABLE_WAIT_CAUSE } from "../../shared/chatActivity.js";
import { MODEL_WAIT_PROGRESS_LABEL } from "../../shared/modelAvailability.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModelOutage } from "../db/entities/AIModelOutage.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { listChatActivity } from "./chatTurnActivity.js";
import { stopCron } from "./cron.js";
import { enqueueDurableChatTurn, executeDurableChatTurn } from "./durableChatTurns.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  isModelAvailable,
  resetModelAvailabilityForTests,
} from "./modelAvailability.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { resumeRoutineQueue, waitForRoutineQueueIdle } from "./routineQueue.js";
import { resetRunPausesForTests } from "./runPause.js";
import { startRoutineRun } from "./runner.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";
import { stopStanddowns } from "./standdowns.js";

/**
 * An AI Model that goes down and comes back, end to end: the pinned OpenCode
 * runtime driving a real model server through the per-turn model proxy, the
 * real Routine runner and queue, the availability breaker and its real check.
 * Nothing between the server and the database is faked.
 *
 * While the server fails, a Run pauses instead of failing and a chat message
 * waits instead of erroring; a check finds the server answering again, and
 * the same Run and the same message finish there.
 */

let failing = true;
let upstream: Server;
let baseURL = "";
const chatPosts: boolean[] = [];
const privateHosts = [...config.security.outboundPrivateHostAllowlist];

function completion(res: ServerResponse, text: string): void {
  const send = (delta: Record<string, unknown>, finish: string | null) =>
    res.write(
      `data: ${JSON.stringify({
        id: "e2e",
        object: "chat.completion.chunk",
        created: 1,
        model: "e2e-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish ? { usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } } : {}),
      })}\n\n`,
    );
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  send({ role: "assistant", content: text }, null);
  send({}, "stop");
  res.end("data: [DONE]\n\n");
}

before(async () => {
  await initTestDb();
  upstream = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url?.endsWith("/models")) {
      if (failing) {
        res.writeHead(500, { "Content-Type": "text/plain" }).end("internal error");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ object: "list", data: [{ id: "e2e-model", object: "model" }] }));
      return;
    }
    chatPosts.push(failing);
    if (failing) {
      // A server error the runtime retries at once, then gives up on.
      res
        .writeHead(500, { "Content-Type": "application/json", "retry-after-ms": "1" })
        .end(JSON.stringify({ error: { message: "internal error", type: "server_error" } }));
      return;
    }
    completion(res, "All caught up: three invoices reconciled.");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
});
beforeEach(async () => {
  stopCron();
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  resetRunPausesForTests();
  resetModelAvailabilityForTests();
  overrideRuntimeSettingsForTests({ modelAvailability: { resumeIntervalSeconds: 0 } });
  failing = true;
  chatPosts.length = 0;
  await resetTestDb();
  await resumeRoutineQueue();
});
afterEach(async () => {
  await waitForRoutineQueueIdle();
  resetModelAvailabilityForTests();
});
after(async () => {
  overrideRuntimeSettingsForTests(null);
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...privateHosts);
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await closeTestDb();
});

async function seed() {
  const owner = await insert(User, {
    email: "owner@e2e.example",
    passwordHash: "hash",
    name: "E2E Owner",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  const company = await insert(Company, { name: "E2E", slug: "e2e", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Quinn",
    slug: "quinn",
    role: "Bookkeeper",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "custom",
    model: "e2e-model",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    maxConcurrentRuns: 0,
    configJson: JSON.stringify({ baseURLEncrypted: encryptSecret(baseURL), modelId: "e2e-model" }),
  });
  return { owner, company, employee, model };
}

test(
  "a Run that meets a failing model server pauses, and the same Run finishes once a check finds it back",
  { timeout: 300_000 },
  async () => {
    const { employee, model } = await seed();
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Invoice Reconciliation",
      slug: "invoice-reconciliation",
      cronExpr: "0 9 * * *",
      timeoutSec: 1800,
      body: "Reconcile this week's invoices and report what you did.",
    });
    const { run: accepted, completion: finished } = await startRoutineRun(routine, {
      triggerKind: "schedule",
    });

    let paused: Run | null = null;
    for (let i = 0; i < 2_400 && !paused; i++) {
      const current = await AppDataSource.getRepository(Run).findOneByOrFail({ id: accepted.id });
      if (current.status === "queued" && current.pauseCount > 0) paused = current;
      else if (!["queued", "running"].includes(current.status))
        assert.fail(`the Run ended ${current.status} instead of pausing:\n${current.logContent}`);
      else await delay(50);
    }
    assert.ok(paused, "the Run paused");
    assert.equal(paused.pauseReason, "outage");
    assert.equal(paused.errorKind, null);
    assert.equal(paused.retryAt, null);
    assert.match(paused.logContent, /\[paused\] The AI Model answered with a server error/);
    assert.ok(chatPosts.length >= 1 && chatPosts.every(Boolean), "it was the failing server's answers");
    assert.equal(isModelAvailable(model), false);
    await flushModelAvailabilityWrites();
    const outage = await AppDataSource.getRepository(AIModelOutage).findOneByOrFail({
      modelId: model.id,
    });
    assert.equal(outage.endedAt, null);
    assert.equal(outage.cause, "server_error");
    assert.equal(await AppDataSource.getRepository(JournalEntry).countBy({ runId: accepted.id }), 0);

    // The real check asks the server's model list: still failing, still down.
    const still = await checkModelAvailabilityNow(model);
    assert.equal(still.available, false);

    // The server comes back; the next check finds it, and the Run carries on.
    failing = false;
    const back = await checkModelAvailabilityNow(model);
    assert.deepEqual(back, { available: true });
    const done = await finished;
    assert.equal(done.id, accepted.id);
    assert.equal(done.status, "completed", done.logContent);
    assert.equal(done.pauseCount, 1);
    assert.match(done.logContent, /\[resumed\] The AI Model is answering again/);
    assert.match(done.logContent, /three invoices reconciled/);
    await flushModelAvailabilityWrites();
    const closed = await AppDataSource.getRepository(AIModelOutage).findOneByOrFail({ id: outage.id });
    assert.ok(closed.endedAt);
    assert.equal(closed.recoveredBy, "check");
  },
);

test(
  "a chat message that meets a failing model server waits in the conversation and is answered once it is back",
  { timeout: 300_000 },
  async () => {
    const { owner, company, employee, model } = await seed();
    const conversation = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: owner.id,
      title: null,
      source: "web",
    });
    const enqueued = await enqueueDurableChatTurn({
      companyId: company.id,
      employeeId: employee.id,
      conversationId: conversation.id,
      message: "Have the invoices been reconciled?",
      attachmentIds: [],
      modelId: model.id,
      requesterUserId: owner.id,
      requesterSessionVersion: 0,
    });
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "deferred");
    const waiting = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: enqueued.assistantMessage.id,
    });
    assert.equal(waiting.status, "working", "never an error in the conversation");
    assert.equal(waiting.progressLabel, MODEL_WAIT_PROGRESS_LABEL);
    const events = await listChatActivity(enqueued.assistantMessage.id, 0, 100);
    assert.ok(
      events.some((event) => event.kind === "waiting" && event.name === MODEL_UNAVAILABLE_WAIT_CAUSE),
      "the conversation says the AI Model is unavailable",
    );
    assert.equal(isModelAvailable(model), false);

    failing = false;
    assert.deepEqual(await checkModelAvailabilityNow(model), { available: true });
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: enqueued.assistantMessage.id },
      { turnLeaseExpiresAt: new Date(Date.now() - 1) },
    );
    assert.equal(await executeDurableChatTurn(enqueued.assistantMessage.id), "completed");
    const answered = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: enqueued.assistantMessage.id,
    });
    assert.equal(answered.status, "ok");
    assert.match(answered.content, /three invoices reconciled/);
  },
);
