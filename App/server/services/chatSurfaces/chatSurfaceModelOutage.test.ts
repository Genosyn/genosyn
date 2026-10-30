import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import {
  MODEL_WAIT_SURFACE_ACK,
  MODEL_WAIT_SURFACE_GAVE_UP,
} from "../../../shared/modelAvailability.js";
import { AppDataSource } from "../../db/datasource.js";
import type { AIModel } from "../../db/entities/AIModel.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModelWait } from "../../db/entities/AIModelWait.js";
import { Company } from "../../db/entities/Company.js";
import { Conversation } from "../../db/entities/Conversation.js";
import { ConversationMessage } from "../../db/entities/ConversationMessage.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { ExternalChatIdentity } from "../../db/entities/ExternalChatIdentity.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { Membership } from "../../db/entities/Membership.js";
import { User } from "../../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { modelUnavailability } from "../agent/modelOutage.js";
import { openCodeError } from "../agent/opencodeEvents.js";
import { agentRuntime } from "../agent/runtime.js";
import { encryptConnectionConfig } from "../integrations.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  loadModelOutages,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "../modelAvailability.js";
import { resetModelWaitsForTests, settleModelWaitsForTests } from "../modelWaits.js";
import { placeStanddown, refreshStanddowns, stopStanddowns } from "../standdowns.js";
import {
  clearChatSurfaceAdapterOverridesForTests,
  setChatSurfaceAdapterForTests,
} from "./adapters.js";
import { WHATSAPP_REPLY_WAIT_MS, handleInboundTurn } from "./inbound.js";
import type { ChatSurfaceAdapter, ChatSurfaceProviderId, InboundChatTurn } from "./types.js";

/**
 * Slack, Teams, Telegram and WhatsApp while the responder's AI Model is
 * unavailable. The person is told once, in plain words, that the answer will
 * come when the model is back — and it does, by itself, in the same thread.
 * Who asked is decided again when the answer is written: a linked Member's
 * authority only while their link and session hold, and never where people
 * outside the company read the answer. The outbound half of each surface and
 * the model's runtime are stand-ins; the inbound core, the chat seam, the wait
 * ledger and the breaker are real.
 */

type RuntimeParams = Parameters<typeof agentRuntime.run>[0];

let company: Company;
let employee: AIEmployee;
let model: AIModel;
let connection: IntegrationConnection;
let sent: { provider: string; text: string; replyTo: unknown }[];

function captureAdapter(provider: ChatSurfaceProviderId): ChatSurfaceAdapter {
  return {
    provider,
    transport: provider === "telegram" ? "poll" : provider === "slack" ? "socket" : "webhook",
    textLimit: 4000,
    requiresPublicUrl: false,
    async send({ text, replyTo }) {
      sent.push({ provider, text, replyTo });
    },
    ...(provider === "slack"
      ? { channelSharedExternally: async () => true }
      : {}),
  };
}

before(initTestDb);
after(async () => {
  clearChatSurfaceAdapterOverridesForTests();
  await closeTestDb();
});

beforeEach(async () => {
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  await resetTestDb();
  await refreshStanddowns();
  sent = [];
  for (const provider of ["telegram", "slack", "whatsapp"] as const) {
    setChatSurfaceAdapterForTests(provider, captureAdapter(provider));
  }
  company = await insert(Company, { name: "Surface Co", slug: "surface-co", ownerId: "owner-1" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Finley Finance",
    slug: "finley",
    role: "Finance",
  });
  model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: "{}",
  });
  connection = await connectionFor("telegram");
});

afterEach(() => {
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
  stopStanddowns();
});

async function connectionFor(provider: ChatSurfaceProviderId): Promise<IntegrationConnection> {
  const row = await insert(IntegrationConnection, {
    companyId: company.id,
    provider,
    label: `Company ${provider}`,
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig({ botToken: "123:ABC" }, company.id),
    accountHint: "bot",
    status: "connected",
  });
  await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: row.id });
  return row;
}

let messageCounter = 0;
function turn(overrides: Partial<InboundChatTurn> = {}): InboundChatTurn {
  messageCounter += 1;
  return {
    provider: "telegram",
    connectionId: connection.id,
    companyId: company.id,
    externalKey: "chat-1",
    externalUserId: "tg-1",
    externalUserLabel: "Mia",
    threadTitle: null,
    text: "what is our runway?",
    group: false,
    externalMessageId: `m${messageCounter}`,
    replyTo: { chatId: 1 },
    ...overrides,
  };
}

async function boundMember(target: IntegrationConnection, externalUserId = "tg-1"): Promise<User> {
  const user = await insert(User, {
    email: `mia-${externalUserId}@example.com`,
    passwordHash: "x",
    name: "Mia Member",
    sessionVersion: 1,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role: "member" });
  await insert(ExternalChatIdentity, {
    companyId: company.id,
    provider: target.provider as ChatSurfaceProviderId,
    connectionId: target.id,
    externalUserId,
    externalUserLabel: "Mia",
    userId: user.id,
    boundAt: new Date(),
    boundVia: "link",
    boundSessionVersion: 1,
    lastSeenAt: new Date(),
  });
  return user;
}

function down(): void {
  recordModelFailure(
    model,
    modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
  );
}

async function back(): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
}

/** What OpenCode throws once its retries are spent on an overloaded service. */
function overloadedError(): Error {
  return openCodeError({
    name: "APIError",
    data: {
      message: "Overloaded",
      statusCode: 529,
      isRetryable: true,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    },
  } as never);
}

function answering(t: TestContext, text = "Runway is 14 months."): RuntimeParams[] {
  const calls: RuntimeParams[] = [];
  t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
    calls.push(params);
    params.callbacks?.onText?.(text);
    return { finalText: text, steps: 1, stopReason: "end_turn" };
  });
  return calls;
}

function lastUserText(params: RuntimeParams): string {
  const last = params.messages[params.messages.length - 1];
  const block = last?.content.find((part) => part.type === "text");
  return block && block.type === "text" ? block.text : "";
}

async function transcript(): Promise<ConversationMessage[]> {
  const conversation = await AppDataSource.getRepository(Conversation).findOneOrFail({ where: {} });
  return AppDataSource.getRepository(ConversationMessage).find({
    where: { conversationId: conversation.id },
    order: { createdAt: "ASC" },
  });
}

async function waits(): Promise<AIModelWait[]> {
  return AppDataSource.getRepository(AIModelWait).find();
}

describe("a message on an external chat surface while the AI Model is unavailable", () => {
  test("is acknowledged once, waits, and is answered in the same chat once the model is back", async (t) => {
    const calls = answering(t);
    down();
    await handleInboundTurn(turn());
    assert.equal(calls.length, 0, "nothing is sent to a model that is down");
    assert.deepEqual(
      sent.map((s) => s.text),
      [MODEL_WAIT_SURFACE_ACK],
      "plain words, once — never the model's error",
    );
    assert.deepEqual(
      (await transcript()).map((m) => m.role),
      ["user"],
      "no error is written into the transcript",
    );
    const [wait] = await waits();
    assert.equal(wait.kind, "chat_surface_reply");
    assert.equal(wait.targetId, (await transcript())[0].id);

    await settleModelWaitsForTests();
    assert.equal(sent.length, 1, "still down");

    await back();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1);
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /^Runway is 14 months\./);
    assert.deepEqual(sent[1].replyTo, { chatId: 1 }, "in the same chat");
    const rows = await transcript();
    assert.deepEqual(
      rows.map((m) => [m.role, m.status]),
      [
        ["user", null],
        ["assistant", "ok"],
      ],
    );
    assert.equal((await waits()).length, 0);
    await settleModelWaitsForTests();
    assert.equal(sent.length, 2, "answered exactly once");
  });

  test("a second message while it waits is not acknowledged again, and both are answered once, together", async (t) => {
    const calls = answering(t);
    down();
    await handleInboundTurn(turn({ text: "what is our runway?" }));
    await handleInboundTurn(turn({ text: "and our burn last month?" }));
    assert.deepEqual(
      sent.map((s) => s.text),
      [MODEL_WAIT_SURFACE_ACK],
    );
    assert.equal((await waits()).length, 2);
    await back();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1, "one answer for both");
    assert.equal(sent.length, 2);
    assert.match(lastUserText(calls[0]), /burn last month/);
    assert.ok(
      JSON.stringify(calls[0].messages).includes("what is our runway?"),
      "the earlier message is in view",
    );
  });

  test("an outage in the middle of the turn is acknowledged once and answered when the model is back", async (t) => {
    let call = 0;
    t.mock.method(agentRuntime, "run", async (params: RuntimeParams) => {
      call += 1;
      if (call === 1) throw overloadedError();
      params.callbacks?.onText?.("Runway is 14 months.");
      return { finalText: "Runway is 14 months.", steps: 1, stopReason: "end_turn" };
    });
    await handleInboundTurn(turn());
    assert.deepEqual(
      sent.map((s) => s.text),
      [MODEL_WAIT_SURFACE_ACK],
    );
    assert.doesNotMatch(sent[0].text, /529|Overloaded/);
    await back();
    await settleModelWaitsForTests();
    assert.equal(call, 2);
    assert.match(sent[1].text, /Runway is 14 months/);
  });

  test("a message answered live after recovery covers the one that waited: no second answer", async (t) => {
    const calls = answering(t);
    down();
    await handleInboundTurn(turn({ text: "what is our runway?" }));
    await back();
    await handleInboundTurn(turn({ text: "are you back?" }));
    assert.equal(calls.length, 1);
    assert.ok(JSON.stringify(calls[0].messages).includes("what is our runway?"));
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1, "the waiting message needs nothing more");
    assert.equal(sent.length, 2);
  });
});

describe("who the answer speaks for, decided when it is written", () => {
  test("a linked Member whose session ended during the outage is answered without their authority", async (t) => {
    const calls = answering(t);
    const user = await boundMember(connection);
    down();
    await handleInboundTurn(turn());
    // A password reset while the answer waited.
    await AppDataSource.getRepository(User).update({ id: user.id }, { sessionVersion: 2 });
    await back();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1);
    assert.match(lastUserText(calls[0]), /sender is not a verified Genosyn Member/);
    assert.match(sent[1].text, /I can only answer generally/);
  });

  test("a linked Member whose link still holds is answered with it", async (t) => {
    const calls = answering(t);
    await boundMember(connection);
    down();
    await handleInboundTurn(turn());
    await back();
    await settleModelWaitsForTests();
    assert.doesNotMatch(lastUserText(calls[0]), /not a verified Genosyn Member/);
    assert.doesNotMatch(sent[1].text, /answer generally/);
  });

  test("in a channel shared with another organization the answer carries nobody's authority", async (t) => {
    const calls = answering(t);
    const slack = await connectionFor("slack");
    await boundMember(slack, "U0MIA");
    down();
    await handleInboundTurn(
      turn({
        provider: "slack",
        connectionId: slack.id,
        externalKey: "C0SHARED:1",
        externalUserId: "U0MIA",
        group: true,
        externallyShared: true,
        externalChannelId: "C0SHARED",
        replyTo: { channel: "C0SHARED", thread_ts: "1" },
      }),
    );
    assert.deepEqual(
      sent.map((s) => s.text),
      [MODEL_WAIT_SURFACE_ACK],
    );
    await back();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1);
    assert.match(lastUserText(calls[0]), /people from another organization can read this conversation/);
    assert.match(sent[1].text, /shared with another organization/);
    assert.deepEqual(sent[1].replyTo, { channel: "C0SHARED", thread_ts: "1" });
  });

  test("a group the delivery did not describe is checked with the platform again when the answer is written", async (t) => {
    const calls = answering(t);
    const slack = await connectionFor("slack");
    await boundMember(slack, "U0MIA");
    down();
    await handleInboundTurn(
      turn({
        provider: "slack",
        connectionId: slack.id,
        externalKey: "C0ASK:1",
        externalUserId: "U0MIA",
        group: true,
        externalChannelId: "C0ASK",
        replyTo: { channel: "C0ASK", thread_ts: "1" },
      }),
    );
    await back();
    await settleModelWaitsForTests();
    // The capture adapter says the channel is shared: nobody's authority.
    assert.match(lastUserText(calls[0]), /people from another organization/);
  });
});

describe("the rules of the moment", () => {
  test("a Standdown placed during the outage is said, as for any message — the model is never asked", async (t) => {
    const calls = answering(t);
    down();
    await handleInboundTurn(turn());
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: employee.id,
      reason: "Month-end close.",
    });
    await back();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0);
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /stood down/);
  });

  test("a responder taken off the Connection while it waited answers nothing", async (t) => {
    const calls = answering(t);
    down();
    await handleInboundTurn(turn());
    await AppDataSource.getRepository(EmployeeConnectionGrant).delete({
      employeeId: employee.id,
      connectionId: connection.id,
    });
    await back();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0);
    assert.equal(sent.length, 1);
    assert.equal((await waits()).length, 0);
  });

  test("on WhatsApp an answer past the reply window is given up: nothing is sent, and the transcript says why", async (t) => {
    const calls = answering(t);
    const whatsapp = await connectionFor("whatsapp");
    down();
    await handleInboundTurn(
      turn({
        provider: "whatsapp",
        connectionId: whatsapp.id,
        externalKey: "wa-1",
        externalUserId: "+15550107777",
        replyTo: { to: "+15550107777" },
      }),
    );
    assert.deepEqual(
      sent.map((s) => s.text),
      [MODEL_WAIT_SURFACE_ACK],
    );
    await back();
    await settleModelWaitsForTests(() => new Date(Date.now() + WHATSAPP_REPLY_WAIT_MS + 60_000));
    assert.equal(calls.length, 0);
    assert.equal(sent.length, 1, "nothing outside WhatsApp's window");
    const rows = await transcript();
    assert.deepEqual(
      rows.map((m) => [m.role, m.content]),
      [
        ["user", "what is our runway?"],
        ["assistant", MODEL_WAIT_SURFACE_GAVE_UP],
      ],
    );
  });

  test("a restart during the outage: the answer still waits after boot and is sent once when the model is back", async (t) => {
    const calls = answering(t);
    down();
    await flushModelAvailabilityWrites();
    await handleInboundTurn(turn());
    resetModelAvailabilityForTests();
    resetModelWaitsForTests();
    await loadModelOutages();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 0);
    await back();
    await settleModelWaitsForTests();
    assert.equal(calls.length, 1);
    assert.equal(sent.length, 2);
  });
});
