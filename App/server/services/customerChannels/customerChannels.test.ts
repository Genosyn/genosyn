import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Conversation } from "../../db/entities/Conversation.js";
import { Customer } from "../../db/entities/Customer.js";
import { CustomerChannel } from "../../db/entities/CustomerChannel.js";
import { CustomerChannelMessage } from "../../db/entities/CustomerChannelMessage.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { EmployeeRevenueGrant } from "../../db/entities/EmployeeRevenueGrant.js";
import { ExternalChatIdentity } from "../../db/entities/ExternalChatIdentity.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { Membership } from "../../db/entities/Membership.js";
import { User } from "../../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import type { RestrictedEmployeeAgentParams } from "../agent/runEmployee.js";
import {
  clearChatSurfaceAdapterOverridesForTests,
  setChatSurfaceAdapterForTests,
} from "../chatSurfaces/adapters.js";
import { handleInboundTurn } from "../chatSurfaces/inbound.js";
import type { ChatSurfaceAdapter, InboundChatTurn } from "../chatSurfaces/types.js";
import { encryptConnectionConfig } from "../integrations.js";
import {
  deleteCustomerChannelsForConnection,
  detachEmployeeFromCustomerChannels,
} from "./cleanup.js";
import { NOTES_QUIET_MS, runCustomerChannelNotesPass, writeCustomerChannelNotes } from "./notes.js";
import { replyToCustomerChannelMessage, settleCustomerChannelReplies } from "./replies.js";
import { CustomerChannelError, linkCustomerChannel, serializeCustomerChannels } from "./store.js";
import { setCustomerChannelRunnerForTests } from "./turns.js";

/**
 * Customer channels, end to end against a real database: what is kept, what is
 * answered, in which voice, and what reaches the Customer's record.
 *
 * Two seams are substituted and nothing else. The outbound half of Slack, so
 * no test reaches Slack; and the model call, so a test plays the AI Employee —
 * it is handed the exact system prompt, user turn and tools a real turn gets,
 * and answers by writing text or by calling one of those tools.
 */

const CHANNEL = "C0ACME";
const SOUL = "SOUL-MARKER: never reveal the Q3 pricing experiment.";
const INSTRUCTIONS = "You support Acme on the Widget API. Rate limits are 100 requests a minute.";

let company: Company;
let employee: AIEmployee;
let customer: Customer;
let connection: IntegrationConnection;
let channel: CustomerChannel;
let sent: { text: string; replyTo: Record<string, unknown> }[];
let turns: RestrictedEmployeeAgentParams[];
let play: (params: RestrictedEmployeeAgentParams) => Promise<string>;

const captureAdapter: ChatSurfaceAdapter = {
  provider: "slack",
  transport: "socket",
  textLimit: 3800,
  requiresPublicUrl: false,
  async send({ text, replyTo }) {
    sent.push({ text, replyTo });
    return { externalMessageId: `${CHANNEL}:9000000000.00000${sent.length}` };
  },
};

before(initTestDb);
after(async () => {
  clearChatSurfaceAdapterOverridesForTests();
  setCustomerChannelRunnerForTests(null);
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  sent = [];
  turns = [];
  play = async () => "Happy to help — the limit is 100 requests a minute.";
  setChatSurfaceAdapterForTests("slack", captureAdapter);
  setCustomerChannelRunnerForTests(async (params) => {
    turns.push(params);
    const finalText = await play(params);
    return { status: "ok", finalText, steps: 1 };
  });

  company = await insert(Company, { name: "Widgets Inc", slug: "widgets", ownerId: "owner-1" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Sam Support",
    slug: "sam",
    role: "Support lead",
    soulBody: SOUL,
  });
  await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-test-model",
    authMode: "apikey",
    isActive: true,
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
  customer = await insert(Customer, { companyId: company.id, name: "Acme Corp", slug: "acme" });
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
});

let tsCounter = 0;

function turn(over: Partial<InboundChatTurn> = {}): InboundChatTurn {
  tsCounter += 1;
  const ts = `1800000000.${String(tsCounter).padStart(6, "0")}`;
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

/** A mention as Slack sends one: the overheard copy and the addressed copy. */
function mentionPair(over: Partial<InboundChatTurn> = {}): [InboundChatTurn, InboundChatTurn] {
  const overheard = turn({ mentionsEmployee: true, ...over });
  return [overheard, { ...overheard, overheard: undefined, mentionsEmployee: undefined }];
}

async function deliver(...items: InboundChatTurn[]): Promise<void> {
  for (const item of items) await handleInboundTurn(item);
  await settleCustomerChannelReplies();
}

async function kept(): Promise<CustomerChannelMessage[]> {
  return AppDataSource.getRepository(CustomerChannelMessage).find({
    where: { customerChannelId: channel.id },
    order: { postedAt: "ASC" },
  });
}

async function setChannel(values: Partial<CustomerChannel>): Promise<void> {
  await AppDataSource.getRepository(CustomerChannel).update({ id: channel.id }, values);
}

function userText(params: RestrictedEmployeeAgentParams): string {
  const block = params.messages[0]?.content[0];
  return block && block.type === "text" ? block.text : "";
}

describe("which messages a customer channel keeps", () => {
  test("an overheard message in a channel nobody linked is dropped unread", async () => {
    await deliver(turn({ externalChannelId: "C0ELSEWHERE", replyTo: { channel: "C0ELSEWHERE" } }));
    assert.equal(await AppDataSource.getRepository(CustomerChannelMessage).count(), 0);
    // Not even a sighting: the people in other channels are not this surface's business.
    assert.equal(await AppDataSource.getRepository(ExternalChatIdentity).count(), 0);
    assert.equal(sent.length, 0);
  });

  test("every message in the channel is kept, not only the ones that address the employee", async () => {
    await deliver(turn({ text: "Morning all" }), turn({ text: "Exports are failing again" }));
    assert.deepEqual(
      (await kept()).map((row) => row.text),
      ["Morning all", "Exports are failing again"],
    );
    const fresh = await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({
      id: channel.id,
    });
    assert.ok(fresh.lastMessageAt);
  });

  test("a mention arrives twice and is kept once", async () => {
    await deliver(...mentionPair());
    assert.equal((await kept()).filter((row) => row.authorKind !== "employee").length, 1);
  });

  test("the customer is told apart from the company's own people", async () => {
    await deliver(
      turn({ outsideWorkspace: true }),
      turn({ outsideWorkspace: false, externalUserId: "U0SAM" }),
    );
    assert.deepEqual(
      (await kept()).map((row) => row.authorKind),
      ["customer", "team"],
    );
  });

  test("its people never become chat-surface identities or Conversations", async () => {
    await deliver(...mentionPair());
    assert.equal(await AppDataSource.getRepository(ExternalChatIdentity).count(), 0);
    assert.equal(await AppDataSource.getRepository(Conversation).count(), 0);
  });
});

describe("answering in a customer channel", () => {
  test("a mention is answered once, in its thread, from the channel's own instructions", async () => {
    const [overheard, addressed] = mentionPair();
    await deliver(overheard, addressed, addressed);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].replyTo, { channel: CHANNEL, thread_ts: addressed.externalThreadId });
    assert.equal(turns.length, 1);
    const [only] = turns;
    assert.ok(only.system.includes(INSTRUCTIONS));
    assert.ok(only.system.includes("Acme Corp"));
    assert.ok(!only.system.includes(SOUL), "the Soul never reaches a turn the customer reads");
    assert.deepEqual(
      only.tools.map((tool) => tool.name),
      ["skip_reply"],
    );
    assert.ok(userText(only).includes("What are the API rate limits?"));
    // No Member link is offered to a customer.
    assert.ok(!sent[0].text.includes("link-chat"));
    const replies = (await kept()).filter((row) => row.authorKind === "employee");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].threadKey, addressed.externalThreadId);
  });

  test("a linked Member asking in the channel still gets the customer's answer, not theirs", async () => {
    const user = await insert(User, { email: "sam@widgets.test", name: "Sam", passwordHash: "x" });
    await insert(Membership, { companyId: company.id, userId: user.id, role: "owner" });
    await insert(ExternalChatIdentity, {
      companyId: company.id,
      provider: "slack",
      connectionId: connection.id,
      externalUserId: "U0SAM",
      externalUserLabel: "Sam",
      userId: user.id,
      boundAt: new Date(),
      boundVia: "link",
      boundSessionVersion: user.sessionVersion,
    });
    await deliver(...mentionPair({ externalUserId: "U0SAM", outsideWorkspace: false }));
    assert.equal(turns.length, 1, "answered by the restricted turn");
    assert.ok(!turns[0].system.includes(SOUL));
    assert.equal(sent.length, 1);
  });

  test("a channel that only takes notes never posts, even when asked by name", async () => {
    await setChannel({ replyMode: "notes" });
    await deliver(...mentionPair());
    assert.equal(turns.length, 0);
    assert.equal(sent.length, 0);
    assert.equal((await kept()).length, 1);
  });

  test("answering customer questions answers the customer without being asked", async () => {
    await setChannel({ replyMode: "questions" });
    await deliver(turn());
    assert.equal(sent.length, 1);
    assert.ok(turns[0].system.includes("Nobody addressed you by name"));
  });

  test("but never interrupts colleagues talking among themselves", async () => {
    await setChannel({ replyMode: "questions" });
    await deliver(turn({ outsideWorkspace: false, externalUserId: "U0SAM" }));
    assert.equal(turns.length, 0);
    assert.equal(sent.length, 0);
  });

  test("an unprompted question is answered only when the channel asks for that", async () => {
    await deliver(turn());
    assert.equal(turns.length, 0);
    assert.equal(sent.length, 0);
  });

  test("skip_reply posts nothing", async () => {
    await setChannel({ replyMode: "questions" });
    play = async (params) => {
      await params.tools[0].run({});
      return "";
    };
    await deliver(turn({ text: "Thanks!" }));
    assert.equal(turns.length, 1);
    assert.equal(sent.length, 0);
  });

  test("a colleague who answered first keeps the question", async () => {
    await setChannel({ replyMode: "questions" });
    const repo = AppDataSource.getRepository(CustomerChannelMessage);
    const question = await insert(CustomerChannelMessage, {
      companyId: company.id,
      customerChannelId: channel.id,
      externalMessageId: `${CHANNEL}:1.000001`,
      threadKey: "1.000001",
      authorKind: "customer",
      authorExternalId: "U0DANA",
      authorLabel: "Dana",
      text: "Can I get a refund?",
      postedAt: new Date(Date.now() - 60_000),
    });
    await insert(CustomerChannelMessage, {
      companyId: company.id,
      customerChannelId: channel.id,
      externalMessageId: `${CHANNEL}:1.000002`,
      threadKey: "1.000001",
      authorKind: "team",
      authorExternalId: "U0SAM",
      authorLabel: "Sam",
      text: "I'll sort that out for you today.",
      postedAt: new Date(Date.now() - 30_000),
    });
    assert.equal(await replyToCustomerChannelMessage(question.id, "question"), null);
    assert.equal(turns.length, 0);
    assert.equal(await repo.count({ where: { authorKind: "employee" } }), 0);
  });

  test("an employee with no AI Model stays quiet and the message is still kept", async () => {
    const other = await insert(AIEmployee, {
      companyId: company.id,
      name: "Nia New",
      slug: "nia",
      role: "Support",
    });
    await insert(EmployeeConnectionGrant, { employeeId: other.id, connectionId: connection.id });
    await setChannel({ employeeId: other.id });
    await deliver(...mentionPair());
    assert.equal(turns.length, 0);
    assert.equal(sent.length, 0);
    assert.equal((await kept()).length, 1);
    const [dto] = await serializeCustomerChannels([
      await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({ id: channel.id }),
    ]);
    assert.equal(dto.problem, "Nia New has no connected AI Model.");
    assert.equal(dto.pendingMessages, 1);
  });
});

describe("notes on the Customer's record", () => {
  async function keepPending(texts: string[], minutesAgo = 120): Promise<void> {
    let offset = texts.length;
    for (const text of texts) {
      await insert(CustomerChannelMessage, {
        companyId: company.id,
        customerChannelId: channel.id,
        externalMessageId: `${CHANNEL}:${minutesAgo}.${offset}`,
        threadKey: `${minutesAgo}.${offset}`,
        authorKind: "customer",
        authorExternalId: "U0DANA",
        authorLabel: "Dana",
        text,
        postedAt: new Date(Date.now() - minutesAgo * 60_000 - offset * 1000),
      });
      offset -= 1;
    }
  }

  function submit(notes: Record<string, unknown>) {
    play = async (params) => {
      await params.tools[0].run(notes);
      return "";
    };
  }

  test("a quiet channel's messages become a note on the Customer, authored by the employee", async () => {
    await insert(EmployeeRevenueGrant, {
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: "write",
    });
    await keepPending(["Exports have failed since Tuesday", "Sam said he'd look by Friday"]);
    submit({
      summary: "- Dana reported exports failing since Tuesday.",
      followUps: [{ title: "Fix the export job", dueDate: "2030-01-04", owner: "Sam" }],
    });

    const result = await writeCustomerChannelNotes(channel.id);
    assert.equal(result.status, "written");

    const [only] = turns;
    assert.deepEqual(
      only.tools.map((tool) => tool.name),
      ["submit_notes"],
    );
    assert.ok(only.system.includes("quoted material"));
    assert.ok(!only.system.includes(SOUL));
    assert.ok(userText(only).includes("Exports have failed since Tuesday"));

    const activities = await AppDataSource.getRepository(Activity).find({
      where: { companyId: company.id },
      order: { kind: "ASC" },
    });
    const note = activities.find((row) => row.kind === "note")!;
    assert.equal(note.customerId, customer.id);
    assert.equal(note.actorEmployeeId, employee.id);
    assert.equal(note.subject, "Notes from #acme-shared on Slack");
    assert.equal(note.bodyText, "- Dana reported exports failing since Tuesday.");
    assert.equal(JSON.parse(note.metaJson ?? "{}").customerChannelId, channel.id);

    const task = activities.find((row) => row.kind === "task")!;
    assert.equal(task.subject, "Fix the export job");
    assert.equal(task.assignedEmployeeId, employee.id);
    assert.equal(task.customerId, customer.id);
    assert.equal(task.dueAt?.toISOString(), "2030-01-04T12:00:00.000Z");

    assert.ok((await kept()).every((row) => row.notedAt));
    const fresh = await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({
      id: channel.id,
    });
    assert.ok(fresh.lastNotedAt);
    assert.equal(fresh.notesError, "");
  });

  test("without Revenue write access the note is written and the follow-ups are not", async () => {
    await keepPending(["We need the invoice resent"]);
    submit({
      summary: "- Dana asked for the invoice again.",
      followUps: [{ title: "Resend invoice" }],
    });
    const result = await writeCustomerChannelNotes(channel.id);
    assert.equal(result.status === "written" && result.followUps, 0);
    const kinds = (await AppDataSource.getRepository(Activity).find()).map((row) => row.kind);
    assert.deepEqual(kinds, ["note"]);
  });

  test("small talk writes nothing on the record but is not written up again", async () => {
    await keepPending(["Thanks!", "Have a good weekend"]);
    submit({ summary: "", followUps: [] });
    const result = await writeCustomerChannelNotes(channel.id);
    assert.equal(result.status === "written" && result.activityId, null);
    assert.equal(await AppDataSource.getRepository(Activity).count(), 0);
    assert.ok((await kept()).every((row) => row.notedAt));
  });

  test("a channel still talking waits, unless an admin asks for notes now", async () => {
    await keepPending(["Still looking into it"], 2);
    submit({ summary: "- Still looking.", followUps: [] });
    const waiting = await writeCustomerChannelNotes(channel.id);
    assert.equal(waiting.status, "skipped");
    assert.equal(turns.length, 0);
    const forced = await writeCustomerChannelNotes(channel.id, { force: true });
    assert.equal(forced.status, "written");
  });

  test("a turn that submits nothing writes nothing and says why", async () => {
    await keepPending(["Hello?"]);
    play = async () => "I would rather chat.";
    const result = await writeCustomerChannelNotes(channel.id);
    assert.equal(result.status, "failed");
    assert.ok((await kept()).every((row) => !row.notedAt));
    const fresh = await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({
      id: channel.id,
    });
    assert.equal(fresh.notesError, "Sam Support did not submit any notes.");
  });

  test("the heartbeat writes up quiet channels and leaves busy ones", async () => {
    const busy = await insert(CustomerChannel, {
      companyId: company.id,
      provider: "slack",
      connectionId: connection.id,
      externalChannelId: "C0BUSY",
      name: "busy",
      customerId: customer.id,
      employeeId: employee.id,
    });
    await keepPending(["Quiet now"]);
    await insert(CustomerChannelMessage, {
      companyId: company.id,
      customerChannelId: busy.id,
      externalMessageId: "C0BUSY:1.1",
      threadKey: "1.1",
      authorKind: "customer",
      text: "Typing…",
      postedAt: new Date(Date.now() - NOTES_QUIET_MS / 10),
    });
    submit({ summary: "- Quiet.", followUps: [] });
    assert.equal(await runCustomerChannelNotesPass(), 1);
    const busyPending = await AppDataSource.getRepository(CustomerChannelMessage).findOneByOrFail({
      customerChannelId: busy.id,
    });
    assert.equal(busyPending.notedAt, null);
  });

  test("channels nobody can work never crowd a healthy one out of the pass", async () => {
    const idle = await insert(AIEmployee, {
      companyId: company.id,
      name: "Ida Idle",
      slug: "ida",
      role: "Support",
    });
    await insert(EmployeeConnectionGrant, { employeeId: idle.id, connectionId: connection.id });
    for (let index = 0; index < 12; index += 1) {
      const stuck = await insert(CustomerChannel, {
        companyId: company.id,
        provider: "slack",
        connectionId: connection.id,
        externalChannelId: `C0STUCK${index}`,
        name: `stuck-${index}`,
        customerId: customer.id,
        employeeId: idle.id,
      });
      await insert(CustomerChannelMessage, {
        companyId: company.id,
        customerChannelId: stuck.id,
        externalMessageId: `C0STUCK${index}:1.1`,
        threadKey: "1.1",
        authorKind: "customer",
        text: "Anyone there?",
        postedAt: new Date(Date.now() - 3 * 60 * 60_000),
      });
    }
    // Written up most recently, so it sorts behind every stuck channel.
    await setChannel({ lastNotedAt: new Date() });
    await keepPending(["Exports are fixed, thanks"]);
    submit({ summary: "- Dana confirmed exports are fixed.", followUps: [] });

    assert.equal(await runCustomerChannelNotesPass(), 1);
    // A channel that could not be worked keeps no stale error: the problem is
    // shown live, and goes away the moment it is fixed.
    const stuck = await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({
      externalChannelId: "C0STUCK0",
    });
    assert.equal(stuck.notesError, "");
    assert.equal(stuck.notesAttemptedAt, null);
  });
});

describe("linking and unlinking", () => {
  const realFetch = globalThis.fetch;
  let slackChannel: Record<string, unknown>;

  beforeEach(() => {
    slackChannel = { id: "C0NEW", name: "globex-shared", is_member: true, is_ext_shared: true };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, channel: slackChannel }))) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function link(over: Partial<Parameters<typeof linkCustomerChannel>[0]> = {}) {
    return linkCustomerChannel({
      companyId: company.id,
      connectionId: connection.id,
      externalChannelId: "C0NEW",
      customerId: customer.id,
      employeeId: employee.id,
      replyMode: "mentions",
      instructions: "  Be kind.  \n",
      userId: null,
      ...over,
    });
  }

  test("a channel the app is in is linked with what Slack says about it", async () => {
    const row = await link();
    assert.equal(row.name, "globex-shared");
    assert.equal(row.shared, true);
    assert.equal(row.instructions, "  Be kind.");
  });

  test("Slack has the last word on whether the app is in the channel", async () => {
    slackChannel = { ...slackChannel, is_member: false };
    await assert.rejects(
      link(),
      (err: unknown) => err instanceof CustomerChannelError && /Invite it/.test(err.message),
    );
  });

  test("the employee must be granted the Slack Connection it would post through", async () => {
    const other = await insert(AIEmployee, {
      companyId: company.id,
      name: "Ola",
      slug: "ola",
      role: "Ops",
    });
    await assert.rejects(link({ employeeId: other.id }), /not granted this Slack Connection/);
  });

  test("one channel links to one Customer", async () => {
    await assert.rejects(link({ externalChannelId: CHANNEL }), /already linked/);
  });

  test("a Customer from another company is not found", async () => {
    const otherCo = await insert(Company, { name: "Other", slug: "other", ownerId: "owner-2" });
    const stranger = await insert(Customer, {
      companyId: otherCo.id,
      name: "Stranger",
      slug: "stranger",
    });
    await assert.rejects(link({ customerId: stranger.id }), /Customer not found/);
  });

  test("a deleted Connection takes its channels and their kept messages with it", async () => {
    await deliver(turn());
    await deleteCustomerChannelsForConnection(connection.id);
    assert.equal(await AppDataSource.getRepository(CustomerChannel).count(), 0);
    assert.equal(await AppDataSource.getRepository(CustomerChannelMessage).count(), 0);
  });

  test("a deleted employee leaves its channels linked, with nobody working them", async () => {
    await detachEmployeeFromCustomerChannels(employee.id);
    const fresh = await AppDataSource.getRepository(CustomerChannel).findOneByOrFail({
      id: channel.id,
    });
    assert.equal(fresh.employeeId, null);
    await deliver(...mentionPair());
    assert.equal(sent.length, 0);
    assert.equal((await kept()).length, 1);
  });
});
