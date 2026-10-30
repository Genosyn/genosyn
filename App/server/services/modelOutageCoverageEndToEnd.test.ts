import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { config } from "../../config.js";
import { MODEL_WAIT_SURFACE_ACK } from "../../shared/modelAvailability.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModelOutage } from "../db/entities/AIModelOutage.js";
import { AIModelWait } from "../db/entities/AIModelWait.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { PipelineRun } from "../db/entities/PipelineRun.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { jsonResponse, phoneFixture, stubTwilio } from "../test/phoneFixtures.js";
import {
  clearChatSurfaceAdapterOverridesForTests,
  setChatSurfaceAdapterForTests,
} from "./chatSurfaces/adapters.js";
import { handleInboundTurn } from "./chatSurfaces/inbound.js";
import { encryptConnectionConfig } from "./integrations.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  isModelAvailable,
  resetModelAvailabilityForTests,
} from "./modelAvailability.js";
import { resetModelWaitsForTests, settleModelWaitsForTests } from "./modelWaits.js";
import { handleFreshInboundText, settleTextReplies } from "./phone/textReplies.js";
import { recordInboundText, setFreshInboundTextHandler } from "./phone/texts.js";
import { fireManually, serializeGraph } from "./pipelines/index.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";
import { stopStanddowns } from "./standdowns.js";

/**
 * AI work with no queue of its own, against an AI Model that goes down and
 * comes back, end to end: the pinned OpenCode runtime driving a real model
 * server through the per-turn model proxy, the availability breaker and its
 * real check, and the wait ledger. Nothing between the server and the
 * database is faked but the outbound halves of Telegram and Twilio.
 *
 * While the server fails, a Pipeline run pauses at its AI step, a Telegram
 * message is acknowledged once and waits, and a text's automatic reply waits.
 * A check finds the server answering again, and each carries on — once.
 */

let failing = true;
let upstream: Server;
let baseURL = "";
const chatPosts: boolean[] = [];
const privateHosts = [...config.security.outboundPrivateHostAllowlist];
const REPLY = "All caught up: three invoices reconciled.";

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
      res
        .writeHead(500, { "Content-Type": "application/json", "retry-after-ms": "1" })
        .end(JSON.stringify({ error: { message: "internal error", type: "server_error" } }));
      return;
    }
    completion(res, REPLY);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
});
beforeEach(async () => {
  stopStanddowns();
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  overrideRuntimeSettingsForTests({ modelAvailability: { resumeIntervalSeconds: 0 } });
  failing = true;
  chatPosts.length = 0;
  await resetTestDb();
});
afterEach(async () => {
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
  clearChatSurfaceAdapterOverridesForTests();
  setFreshInboundTextHandler(null);
});
after(async () => {
  overrideRuntimeSettingsForTests(null);
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...privateHosts);
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await closeTestDb();
});

async function customModel(employeeId: string) {
  return insertEmployeeModel({
    employeeId,
    provider: "custom",
    model: "e2e-model",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    maxConcurrentRuns: 0,
    configJson: JSON.stringify({ baseURLEncrypted: encryptSecret(baseURL), modelId: "e2e-model" }),
  });
}

async function seed() {
  const company = await insert(Company, { name: "E2E", slug: "e2e", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Quinn",
    slug: "quinn",
    role: "Bookkeeper",
  });
  const model = await customModel(employee.id);
  return { company, employee, model };
}

/** The server comes back, and the next check finds it. */
async function serverBack(model: Awaited<ReturnType<typeof customModel>>): Promise<void> {
  failing = false;
  assert.deepEqual(await checkModelAvailabilityNow(model), { available: true });
  await flushModelAvailabilityWrites();
}

test(
  "a Pipeline run pauses at its AI step against a failing model server, and completes from there once it is back",
  { timeout: 300_000 },
  async () => {
    const { company, model } = await seed();
    const pipeline = await insert(Pipeline, {
      companyId: company.id,
      name: "Reconcile",
      slug: "reconcile",
      description: "",
      enabled: true,
      cronExpr: null,
      nextRunAt: null,
      graphJson: serializeGraph({
        nodes: [
          { id: "start", type: "trigger.manual", x: 0, y: 0, config: {} },
          {
            id: "ask",
            type: "action.askEmployee",
            x: 0,
            y: 0,
            config: { employeeSlug: "quinn", message: "Have the invoices been reconciled?" },
          },
          {
            id: "note",
            type: "action.journalNote",
            x: 0,
            y: 0,
            config: { employeeSlug: "quinn", title: "{{ask.reply}}", body: "" },
          },
        ],
        edges: [
          { id: "e1", fromNodeId: "start", toNodeId: "ask" },
          { id: "e2", fromNodeId: "ask", toNodeId: "note" },
        ],
      }),
    });

    const run = await fireManually(pipeline);
    assert.equal(run.status, "paused", run.logContent);
    assert.ok(chatPosts.length >= 1 && chatPosts.every(Boolean), "it was the failing server's answers");
    assert.equal(isModelAvailable(model), false);
    assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 0, "no step was handed the error");
    await flushModelAvailabilityWrites();
    assert.ok(await AppDataSource.getRepository(AIModelOutage).findOneBy({ modelId: model.id }));

    const still = await checkModelAvailabilityNow(model);
    assert.equal(still.available, false, "the real check: still failing");
    await settleModelWaitsForTests();
    assert.equal((await AppDataSource.getRepository(PipelineRun).findOneByOrFail({ id: run.id })).status, "paused");

    await serverBack(model);
    await settleModelWaitsForTests();
    const done = await AppDataSource.getRepository(PipelineRun).findOneByOrFail({ id: run.id });
    assert.equal(done.status, "completed", done.logContent);
    const [note] = await AppDataSource.getRepository(JournalEntry).find();
    assert.match(note.title, /three invoices reconciled/);
    assert.equal(await AppDataSource.getRepository(AIModelWait).count(), 0);
  },
);

test(
  "a Telegram message to a failing model server is acknowledged once and answered once it is back",
  { timeout: 300_000 },
  async () => {
    const { company, employee, model } = await seed();
    const sent: string[] = [];
    setChatSurfaceAdapterForTests("telegram", {
      provider: "telegram",
      transport: "poll",
      textLimit: 4000,
      requiresPublicUrl: false,
      async send({ text }) {
        sent.push(text);
      },
    });
    const connection = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "telegram",
      label: "Company bot",
      authMode: "apikey",
      encryptedConfig: encryptConnectionConfig({ botToken: "123:ABC" }, company.id),
      accountHint: "bot",
      status: "connected",
    });
    await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: connection.id });

    await handleInboundTurn({
      provider: "telegram",
      connectionId: connection.id,
      companyId: company.id,
      externalKey: "chat-1",
      externalUserId: "tg-1",
      externalUserLabel: "Mia",
      threadTitle: null,
      text: "Have the invoices been reconciled?",
      group: false,
      externalMessageId: "m1",
      replyTo: { chatId: 1 },
    });
    assert.deepEqual(sent, [MODEL_WAIT_SURFACE_ACK], "plain words, once");
    assert.equal(isModelAvailable(model), false);

    await serverBack(model);
    await settleModelWaitsForTests();
    assert.equal(sent.length, 2);
    assert.match(sent[1], /three invoices reconciled/);
    await settleModelWaitsForTests();
    assert.equal(sent.length, 2, "answered once");
  },
);

test(
  "a text's automatic reply waits for a failing model server and is sent once it is back",
  { timeout: 300_000 },
  async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" }, { model: false });
    const model = await customModel(employee.id);
    const sends: Array<string | null> = [];
    const twilio = stubTwilio((_url, init) => {
      const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      sends.push(body.get("Body"));
      return jsonResponse(201, { sid: `SM-out-${sends.length}`, status: "queued" });
    });
    setFreshInboundTextHandler(handleFreshInboundText);
    try {
      await recordInboundText(number, {
        sid: "SM-in-1",
        from: "+15550107777",
        to: number.e164,
        body: "Have the invoices been reconciled?",
        media: [],
        occurredAt: new Date(),
      });
      await settleTextReplies();
      assert.equal(sends.length, 0, "no text goes out — no error, no apology");
      assert.equal(isModelAvailable(model), false);
      assert.equal(await AppDataSource.getRepository(AIModelWait).count(), 1);

      await serverBack(model);
      await settleModelWaitsForTests();
      await settleTextReplies();
      assert.equal(sends.length, 1);
      assert.match(sends[0] ?? "", /three invoices reconciled/);
    } finally {
      twilio.restore();
    }
  },
);
