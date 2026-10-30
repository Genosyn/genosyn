import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import type { AIModel } from "../../db/entities/AIModel.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModelWait } from "../../db/entities/AIModelWait.js";
import { Company } from "../../db/entities/Company.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerChannel } from "../../db/entities/CustomerChannel.js";
import { CustomerChannelMessage } from "../../db/entities/CustomerChannelMessage.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { modelUnavailability } from "../agent/modelOutage.js";
import type { EmployeeAgentResult, RestrictedEmployeeAgentParams } from "../agent/runEmployee.js";
import {
  clearChatSurfaceAdapterOverridesForTests,
  setChatSurfaceAdapterForTests,
} from "../chatSurfaces/adapters.js";
import { handleInboundTurn } from "../chatSurfaces/inbound.js";
import type { ChatSurfaceAdapter, InboundChatTurn } from "../chatSurfaces/types.js";
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
import { NOTES_QUIET_MS, runCustomerChannelNotesPass, writeCustomerChannelNotes } from "./notes.js";
import { CUSTOMER_REPLY_WAIT_MS, MAX_REPLIES_PER_DAY, settleCustomerChannelReplies } from "./replies.js";
import { setCustomerChannelRunnerForTests } from "./turns.js";

/**
 * A customer channel while its AI Employee's AI Model is unavailable: a
 * message that wants an answer keeps its claim and waits, and is answered once
 * the model is back — in its thread, by the same restricted one-tool turn on
 * the channel's instructions, under every rule a fresh message meets, checked
 * again then. Notes wait too, and nothing is recorded as a failure. Slack and
 * the model are stand-ins; the channel, the wait ledger and the breaker are
 * real.
 */

const CHANNEL = "C0ACME";
const SOUL = "SOUL-MARKER: never reveal the Q3 pricing experiment.";
const INSTRUCTIONS = "You support Acme on the Widget API. Rate limits are 100 requests a minute.";

let company: Company;
let employee: AIEmployee;
let model: AIModel;
let channel: CustomerChannel;
let connection: IntegrationConnection;
let sent: { text: string; replyTo: Record<string, unknown> }[];
let turns: RestrictedEmployeeAgentParams[];
let play: (params: RestrictedEmployeeAgentParams) => Promise<EmployeeAgentResult>;

const captureAdapter: ChatSurfaceAdapter = {
  provider: "slack",
  transport: "socket",
  textLimit: 3800,
  requiresPublicUrl: false,
  async send({ text, replyTo }) {
    sent.push({ text, replyTo });
    return { externalMessageId: `${CHANNEL}:9100000000.00000${sent.length}` };
  },
};

const answer = async (): Promise<EmployeeAgentResult> => ({
  status: "ok",
  finalText: "Happy to help — the limit is 100 requests a minute.",
  steps: 1,
});

const overloaded = async (): Promise<EmployeeAgentResult> => ({
  status: "error",
  error: "The AI Model answered with a server error (HTTP 529).",
  unavailable: modelUnavailability("overloaded", { status: 529, code: "overloaded_error" }),
});

before(initTestDb);
after(async () => {
  clearChatSurfaceAdapterOverridesForTests();
  setCustomerChannelRunnerForTests(null);
  await closeTestDb();
});

beforeEach(async () => {
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  await resetTestDb();
  await refreshStanddowns();
  sent = [];
  turns = [];
  play = answer;
  setChatSurfaceAdapterForTests("slack", captureAdapter);
  setCustomerChannelRunnerForTests(async (params) => {
    turns.push(params);
    return play(params);
  });

  company = await insert(Company, { name: "Widgets Inc", slug: "widgets", ownerId: "owner-1" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Sam Support",
    slug: "sam",
    role: "Support lead",
    soulBody: SOUL,
  });
  model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-test-model",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({ apiKeyEncrypted: "sealed-test-key" }),
  });
  connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "slack",
    label: "Company Slack",
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig(
      { botToken: "xoxb-test", botUserId: "U0BOT", teamId: "T0OURS" },
      company.id,
    ),
    accountHint: "",
    status: "connected",
    statusMessage: "",
  });
  await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: connection.id });
  const customer = await insert(Customer, { companyId: company.id, name: "Acme Corp", slug: "acme" });
  channel = await insert(CustomerChannel, {
    companyId: company.id,
    provider: "slack",
    connectionId: connection.id,
    externalChannelId: CHANNEL,
    name: "acme-shared",
    shared: true,
    customerId: customer.id,
    employeeId: employee.id,
    replyMode: "mentions",
    instructions: INSTRUCTIONS,
  });
});

afterEach(async () => {
  await settleCustomerChannelReplies();
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
  stopStanddowns();
});

let tsCounter = 0;

function turn(over: Partial<InboundChatTurn> = {}): InboundChatTurn {
  tsCounter += 1;
  const ts = `1810000000.${String(tsCounter).padStart(6, "0")}`;
  return {
    provider: "slack",
    connectionId: connection.id,
    companyId: company.id,
    externalKey: `${CHANNEL}:${ts}`,
    externalUserId: "U0DANA",
    externalUserLabel: "Dana at Acme",
    threadTitle: null,
    text: "What are the API rate limits?",
    group: true,
    externalMessageId: `${CHANNEL}:${ts}`,
    replyTo: { channel: CHANNEL, thread_ts: ts },
    externalChannelId: CHANNEL,
    externalThreadId: ts,
    sentAt: new Date(),
    outsideWorkspace: true,
    overheard: true,
    mentionsEmployee: false,
    ...over,
  };
}

/** A mention as Slack addresses one to the employee. */
function mention(over: Partial<InboundChatTurn> = {}): InboundChatTurn {
  return turn({ overheard: undefined, mentionsEmployee: undefined, ...over });
}

async function deliver(...items: InboundChatTurn[]): Promise<void> {
  for (const item of items) await handleInboundTurn(item);
  await settleCustomerChannelReplies();
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

async function settle(now?: () => Date): Promise<void> {
  await settleModelWaitsForTests(now);
  await settleCustomerChannelReplies();
}

async function employeeReplies(): Promise<CustomerChannelMessage[]> {
  return AppDataSource.getRepository(CustomerChannelMessage).find({
    where: { customerChannelId: channel.id, authorKind: "employee" },
  });
}

async function waits(): Promise<AIModelWait[]> {
  return AppDataSource.getRepository(AIModelWait).find();
}

describe("answering while the AI Model is unavailable", () => {
  test("a mention keeps its claim and waits, then is answered once, in its thread, when the model is back", async () => {
    down();
    const asked = mention();
    await deliver(asked);
    assert.equal(turns.length, 0, "nothing is sent to a model that is down");
    assert.equal(sent.length, 0, "and nothing is posted — no error, no apology");
    const [wait, ...more] = await waits();
    assert.equal(more.length, 0);
    assert.equal(wait.kind, "customer_channel_reply");
    const kept = await AppDataSource.getRepository(CustomerChannelMessage).findOneByOrFail({
      id: wait.targetId,
    });
    assert.ok(kept.replyClaimedAt, "no second delivery can answer it meanwhile");

    await settle();
    assert.equal(sent.length, 0, "still down");

    await back();
    await settle();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].replyTo, { channel: CHANNEL, thread_ts: asked.externalThreadId });
    const [only] = turns;
    assert.ok(only.system.includes(INSTRUCTIONS), "the channel's instructions, as always");
    assert.ok(!only.system.includes(SOUL), "never the Soul: the customer reads this");
    assert.deepEqual(
      only.tools.map((tool) => tool.name),
      ["skip_reply"],
    );
    assert.equal((await employeeReplies()).length, 1);
    assert.equal((await waits()).length, 0);

    await deliver(asked);
    await settle();
    assert.equal(sent.length, 1, "answered exactly once");
  });

  test("an outage in the middle of the turn waits too, and nothing half-written is posted", async () => {
    play = overloaded;
    await deliver(mention());
    assert.equal(turns.length, 1);
    assert.equal(sent.length, 0);
    assert.equal((await waits()).length, 1);

    play = answer;
    await back();
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(turns.length, 2);
  });

  test("a colleague who answers in the thread meanwhile takes the question: nothing is posted late", async () => {
    down();
    const asked = mention();
    await deliver(asked);
    await deliver(
      turn({
        text: "Dana, it's 100 a minute.",
        outsideWorkspace: false,
        externalUserId: "U0SAM",
        externalThreadId: asked.externalThreadId,
        replyTo: asked.replyTo,
      }),
    );
    await back();
    await settle();
    assert.equal(sent.length, 0);
    assert.equal(turns.length, 0);
    assert.equal((await waits()).length, 0);
  });

  test("two mentions that waited in one thread are answered once, by the newer one, with both in view", async () => {
    down();
    const first = mention({ text: "What are the API rate limits?" });
    await deliver(first);
    await deliver(
      mention({
        text: "Also, is there a burst allowance?",
        externalThreadId: first.externalThreadId,
        replyTo: first.replyTo,
      }),
    );
    assert.equal((await waits()).length, 2);
    await back();
    await settle();
    assert.equal(sent.length, 1, "one answer, not two");
    assert.ok(JSON.stringify(turns[0].messages).includes("burst allowance"));
    assert.ok(JSON.stringify(turns[0].messages).includes("rate limits"));
  });

  test("a Standdown placed during the outage holds: nothing is posted when the model is back", async () => {
    down();
    await deliver(mention());
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: employee.id,
      reason: "Pricing review.",
    });
    await back();
    await settle();
    assert.equal(sent.length, 0);
    assert.equal(turns.length, 0);
    assert.equal((await waits()).length, 0);
  });

  test("the channel's daily limit is checked when the answer is written, not when it began to wait", async () => {
    down();
    await deliver(mention());
    const now = Date.now();
    const repo = AppDataSource.getRepository(CustomerChannelMessage);
    for (let i = 0; i < MAX_REPLIES_PER_DAY; i++) {
      await repo.save(
        repo.create({
          companyId: company.id,
          customerChannelId: channel.id,
          externalMessageId: null,
          threadKey: `t-${i}`,
          authorKind: "employee",
          authorExternalId: employee.id,
          authorLabel: employee.name,
          text: "Earlier answer.",
          postedAt: new Date(now - i * 1000),
          notedAt: null,
          replyClaimedAt: new Date(now),
        }),
      );
    }
    await back();
    await settle();
    assert.equal(sent.length, 0, "the day's limit holds for an answer that waited");
  });

  test("a mode switched to notes only while it waited means no answer", async () => {
    down();
    await deliver(mention());
    await AppDataSource.getRepository(CustomerChannel).update({ id: channel.id }, { replyMode: "notes" });
    await back();
    await settle();
    assert.equal(sent.length, 0);
  });

  test("an answer a day late is given up: nothing is posted", async () => {
    down();
    await deliver(mention());
    await back();
    await settle(() => new Date(Date.now() + CUSTOMER_REPLY_WAIT_MS + 60_000));
    assert.equal(sent.length, 0);
    assert.equal(turns.length, 0);
    assert.equal((await waits()).length, 0);
  });

  test("a restart during the outage: the answer still waits after boot and is posted once when the model is back", async () => {
    down();
    await flushModelAvailabilityWrites();
    await deliver(mention());
    resetModelAvailabilityForTests();
    resetModelWaitsForTests();
    await loadModelOutages();
    await settle();
    assert.equal(sent.length, 0);
    await back();
    await settle();
    assert.equal(sent.length, 1);
  });
});

describe("notes while the AI Model is unavailable", () => {
  async function pendingMessage(minutesAgo: number): Promise<void> {
    const repo = AppDataSource.getRepository(CustomerChannelMessage);
    await repo.save(
      repo.create({
        companyId: company.id,
        customerChannelId: channel.id,
        externalMessageId: `${CHANNEL}:notes-${minutesAgo}`,
        threadKey: `${CHANNEL}:notes`,
        authorKind: "customer",
        authorExternalId: "U0DANA",
        authorLabel: "Dana at Acme",
        text: "Exports have failed twice this week; please look before Friday.",
        postedAt: new Date(Date.now() - minutesAgo * 60_000),
        notedAt: null,
        replyClaimedAt: null,
      }),
    );
  }

  test("nothing is attempted and nothing recorded as a failure, and the notes are written once it is back", async () => {
    await pendingMessage(NOTES_QUIET_MS / 60_000 + 5);
    down();
    const waiting = await writeCustomerChannelNotes(channel.id);
    assert.equal(waiting.status, "skipped");
    assert.match(waiting.status === "skipped" ? waiting.reason : "", /AI Model is unavailable/);
    let fresh = await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({ id: channel.id });
    assert.equal(fresh.notesError, "");
    assert.equal(fresh.notesAttemptedAt, null, "no retry delay to sit out once it is back");
    assert.equal(turns.length, 0);

    await back();
    play = async (params) => {
      await params.tools[0].run({ summary: "- Dana reported failing exports.", followUps: [] });
      return { status: "ok", finalText: "", steps: 1 };
    };
    assert.equal(await runCustomerChannelNotesPass(), 1);
    fresh = await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({ id: channel.id });
    assert.equal(fresh.notesError, "");
    assert.equal(await AppDataSource.getRepository(Activity).countBy({ customerId: channel.customerId }), 1);
  });

  test("an outage under the notes turn is not a failed attempt", async () => {
    await pendingMessage(NOTES_QUIET_MS / 60_000 + 5);
    play = overloaded;
    const result = await writeCustomerChannelNotes(channel.id);
    assert.equal(result.status, "skipped");
    const fresh = await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({
      id: channel.id,
    });
    assert.equal(fresh.notesError, "", "never the model's error on the channel");
    assert.equal(fresh.notesAttemptedAt, null);
    const pending = await AppDataSource.getRepository(CustomerChannelMessage).countBy({
      customerChannelId: channel.id,
      notedAt: undefined,
    });
    assert.ok(pending >= 1, "the messages wait for the notes");
  });
});
