import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Conversation } from "../../db/entities/Conversation.js";
import { ConversationMessage } from "../../db/entities/ConversationMessage.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { ExternalChatIdentity } from "../../db/entities/ExternalChatIdentity.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { Membership } from "../../db/entities/Membership.js";
import { User } from "../../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { encryptConnectionConfig } from "../integrations.js";
import {
  clearChatSurfaceAdapterOverridesForTests,
  setChatSurfaceAdapterForTests,
} from "./adapters.js";
import { handleInboundTurn, resolveResponder } from "./inbound.js";
import type { ChatSurfaceAdapter, InboundChatTurn } from "./types.js";

/**
 * The rules every external chat surface shares.
 *
 * These run against a real database with a real `chatWithEmployee`: the
 * employees here have no AI Model, so the chat seam short-circuits to a
 * `skipped` reply without reaching a provider. That is deliberate — stubbing
 * the chat seam would also stub the authority plumbing this file exists to
 * check, and the reply text is not what any of these assertions are about.
 *
 * Only the *outbound* half is substituted, because otherwise every test would
 * try to reach Telegram.
 */

let company: Company;
let employee: AIEmployee;
let second: AIEmployee;
let connection: IntegrationConnection;
const sent: { text: string; replyTo: unknown }[] = [];

const captureAdapter: ChatSurfaceAdapter = {
  provider: "telegram",
  transport: "poll",
  textLimit: 4000,
  requiresPublicUrl: false,
  async send({ text, replyTo }) {
    sent.push({ text, replyTo });
  },
};

before(initTestDb);
after(async () => {
  clearChatSurfaceAdapterOverridesForTests();
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  sent.length = 0;
  setChatSurfaceAdapterForTests("telegram", captureAdapter);
  company = await insert(Company, { name: "Surface Co", slug: "surface-co", ownerId: "owner-1" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Finley Finance",
    slug: "finley",
    role: "Finance",
  });
  second = await insert(AIEmployee, {
    companyId: company.id,
    name: "Sam Support",
    slug: "sam",
    role: "Support",
  });
  connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "telegram",
    label: "Company bot",
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig({ botToken: "123:ABC" }, company.id),
    accountHint: "bot",
    status: "connected",
  });
});

afterEach(() => {
  clearChatSurfaceAdapterOverridesForTests();
});

async function grant(employeeId: string): Promise<void> {
  await insert(EmployeeConnectionGrant, { employeeId, connectionId: connection.id });
}

function turn(overrides: Partial<InboundChatTurn> = {}): InboundChatTurn {
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
    externalMessageId: "m1",
    replyTo: { chatId: 1 },
    ...overrides,
  };
}

async function messages(conversationId: string): Promise<ConversationMessage[]> {
  return AppDataSource.getRepository(ConversationMessage).find({
    where: { conversationId },
    order: { createdAt: "ASC" },
  });
}

async function onlyConversation(): Promise<Conversation> {
  const rows = await AppDataSource.getRepository(Conversation).find();
  assert.equal(rows.length, 1, `expected exactly one conversation, found ${rows.length}`);
  return rows[0];
}

async function boundMember(externalUserId = "tg-1"): Promise<User> {
  const user = await insert(User, {
    email: "mia@example.com",
    passwordHash: "x",
    name: "Mia Member",
    sessionVersion: 1,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role: "member" });
  await insert(ExternalChatIdentity, {
    companyId: company.id,
    provider: "telegram",
    connectionId: connection.id,
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

describe("resolveResponder", () => {
  test("an ungranted Connection has nobody to answer with", async () => {
    assert.equal(await resolveResponder(connection.id, "hello"), null);
  });

  test("defaults to the earliest grant", async () => {
    await grant(employee.id);
    await grant(second.id);
    const picked = await resolveResponder(connection.id, "hello");
    assert.equal(picked?.employeeId, employee.id);
    assert.equal(picked?.text, "hello");
  });

  test("an @slug prefix reaches another granted employee and is stripped", async () => {
    await grant(employee.id);
    await grant(second.id);
    const picked = await resolveResponder(connection.id, "@sam can you look at ticket 12?");
    assert.equal(picked?.employeeId, second.id);
    assert.equal(picked?.text, "can you look at ticket 12?");
  });

  test("accepts a colon after the slug, and ignores case", async () => {
    await grant(employee.id);
    await grant(second.id);
    assert.equal((await resolveResponder(connection.id, "sam: hi"))?.employeeId, second.id);
    assert.equal((await resolveResponder(connection.id, "@SAM hi"))?.employeeId, second.id);
    assert.equal((await resolveResponder(connection.id, "@Sam, hi"))?.employeeId, second.id);
  });

  test("a bare first word is never a route, even when it is a real slug", async () => {
    await grant(employee.id);
    await grant(second.id);
    // "sam is out today" must not both re-point the thread and delete his
    // name from the sentence. Addressing takes a marker.
    const picked = await resolveResponder(connection.id, "sam is out today, can you cover?");
    assert.equal(picked?.employeeId, employee.id);
    assert.equal(picked?.text, "sam is out today, can you cover?");
  });

  test("a slug the Connection was never granted is not a routing hint", async () => {
    await grant(employee.id);
    const picked = await resolveResponder(connection.id, "@sam are you there");
    assert.equal(picked?.employeeId, employee.id, "an ungranted employee stays unreachable");
    assert.equal(picked?.text, "@sam are you there", "and the text is left intact");
  });

  test("a prefix with nothing after it is a message, not a route", async () => {
    await grant(employee.id);
    await grant(second.id);
    const picked = await resolveResponder(connection.id, "@sam");
    assert.equal(picked?.employeeId, employee.id);
    assert.equal(picked?.text, "@sam");
  });

  test("an ordinary sentence starting with a word is not mistaken for a route", async () => {
    await grant(employee.id);
    const picked = await resolveResponder(connection.id, "hello there, quick question");
    assert.equal(picked?.employeeId, employee.id);
    assert.equal(picked?.text, "hello there, quick question");
  });
});

describe("handleInboundTurn", () => {
  test("ignores an empty message", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn({ text: "   " }));
    assert.equal(sent.length, 0);
    assert.equal(await AppDataSource.getRepository(Conversation).count(), 0);
  });

  test("ignores a turn whose Connection has gone", async () => {
    await grant(employee.id);
    await AppDataSource.getRepository(IntegrationConnection).delete({ id: connection.id });
    await handleInboundTurn(turn());
    assert.equal(sent.length, 0);
  });

  test("ignores a turn whose Connection belongs to another provider", async () => {
    await grant(employee.id);
    await AppDataSource.getRepository(IntegrationConnection).update(
      { id: connection.id },
      { provider: "slack" },
    );
    await handleInboundTurn(turn());
    assert.equal(sent.length, 0);
  });

  test("tells an operator how to finish setup when nobody is granted", async () => {
    await handleInboundTurn(turn());
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Settings → Integrations/);
    assert.equal(await AppDataSource.getRepository(Conversation).count(), 0);
  });

  test("records the sender even before they have proved who they are", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn());
    const identity = await AppDataSource.getRepository(ExternalChatIdentity).findOneByOrFail({
      connectionId: connection.id,
      externalUserId: "tg-1",
    });
    assert.equal(identity.userId, null);
    assert.equal(identity.externalUserLabel, "Mia");
    assert.equal(identity.provider, "telegram");
  });

  test("opens one Conversation keyed to the upstream thread and answers", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn());
    const conversation = await onlyConversation();
    assert.equal(conversation.source, "telegram");
    assert.equal(conversation.externalKey, "chat-1");
    assert.equal(conversation.connectionId, connection.id);
    assert.equal(conversation.employeeId, employee.id);
    assert.equal(conversation.title, "what is our runway?");

    const rows = await messages(conversation.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].role, "user");
    assert.equal(rows[0].content, "what is our runway?");
    assert.equal(rows[0].externalMessageId, "m1");
    assert.equal(rows[1].role, "assistant");
    assert.equal(rows[1].externalMessageId, null);
    assert.equal(rows[1].status, "skipped", "an employee with no AI Model skips rather than errors");
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.startsWith(rows[1].content));
    assert.deepEqual(sent[0].replyTo, { chatId: 1 });
  });

  test("a second message continues the same thread", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn());
    await handleInboundTurn(turn({ externalMessageId: "m2", text: "and next quarter?" }));
    const conversation = await onlyConversation();
    const rows = await messages(conversation.id);
    assert.equal(rows.length, 4);
    assert.equal(rows[2].content, "and next quarter?");
    assert.equal(conversation.title, "what is our runway?", "the title is set once, from the first turn");
  });

  test("a different upstream thread is a different Conversation", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn());
    await handleInboundTurn(turn({ externalKey: "chat-2", externalMessageId: "m2" }));
    assert.equal(await AppDataSource.getRepository(Conversation).count(), 2);
  });

  test("a redelivered message is answered once", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn());
    await handleInboundTurn(turn());
    const conversation = await onlyConversation();
    const rows = await messages(conversation.id);
    assert.equal(rows.length, 2, "the platform retried; the employee must not answer twice");
    assert.equal(sent.length, 1);
  });

  test("a message with no upstream id cannot be deduped and is answered again", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn({ externalMessageId: null }));
    await handleInboundTurn(turn({ externalMessageId: null }));
    const conversation = await onlyConversation();
    assert.equal((await messages(conversation.id)).length, 4);
  });

  test("an unproven sender is invited to link, once while the link is live", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn());
    assert.match(sent[0].text, /link-chat/);
    assert.match(sent[0].text, /single-use/);
    await handleInboundTurn(turn({ externalMessageId: "m2" }));
    assert.equal(sent.length, 2);
    assert.doesNotMatch(sent[1].text, /link-chat/, "one live link at a time, not a footer per message");
  });

  test("a proven Member is never nagged to link", async () => {
    await grant(employee.id);
    await boundMember();
    await handleInboundTurn(turn());
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /link-chat/);
  });

  test("a direct thread with a proven Member becomes their own history", async () => {
    await grant(employee.id);
    const user = await boundMember();
    await handleInboundTurn(turn());
    assert.equal((await onlyConversation()).ownerUserId, user.id);
  });

  test("a group thread never adopts an owner, even for a proven Member", async () => {
    await grant(employee.id);
    await boundMember();
    await handleInboundTurn(turn({ group: true }));
    assert.equal(
      (await onlyConversation()).ownerUserId,
      null,
      "a transcript several people can read must not become one Member's private history",
    );
  });

  test("an unproven sender's direct thread has no owner", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn());
    assert.equal((await onlyConversation()).ownerUserId, null);
  });

  test("addressing another granted employee moves the thread to them", async () => {
    await grant(employee.id);
    await grant(second.id);
    await handleInboundTurn(turn());
    assert.equal((await onlyConversation()).employeeId, employee.id);
    await handleInboundTurn(turn({ externalMessageId: "m2", text: "@sam take this one" }));
    const conversation = await onlyConversation();
    assert.equal(conversation.employeeId, second.id);
    const rows = await messages(conversation.id);
    assert.equal(rows[2].content, "take this one", "the routing prefix is not part of the question");
  });

  test("names the thread from the upstream title when the surface supplies one", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn({ threadTitle: "Finance war room" }));
    assert.equal((await onlyConversation()).title, "Finance war room");
  });

  test("truncates a reply that would exceed the surface's cap", async () => {
    await grant(employee.id);
    setChatSurfaceAdapterForTests("telegram", { ...captureAdapter, textLimit: 40 });
    await handleInboundTurn(turn());
    assert.ok(sent[0].text.length <= 40);
    assert.match(sent[0].text, /truncated/);
  });

  test("a group thread is never sent a bind link", async () => {
    await grant(employee.id);
    await handleInboundTurn(turn({ group: true }));
    assert.equal(sent.length, 1);
    assert.doesNotMatch(
      sent[0].text,
      /link-chat/,
      "a link in a channel is a standing offer of somebody else's authority",
    );
    assert.match(sent[0].text, /direct message/, "it says where to go instead");
  });

  test("a Member whose auth epoch moved is treated as unproven again", async () => {
    await grant(employee.id);
    const user = await boundMember();
    await AppDataSource.getRepository(User).update({ id: user.id }, { sessionVersion: 2 });
    await handleInboundTurn(turn());
    assert.equal(
      (await onlyConversation()).ownerUserId,
      null,
      "signing out everywhere has to reach this surface too",
    );
    assert.match(sent[0].text, /link-chat/, "and they are invited to prove themselves again");
  });

  test("a failing surface does not lose the transcript", async () => {
    await grant(employee.id);
    setChatSurfaceAdapterForTests("telegram", {
      ...captureAdapter,
      async send() {
        throw new Error("Slack is down");
      },
    });
    await handleInboundTurn(turn());
    const conversation = await onlyConversation();
    assert.equal((await messages(conversation.id)).length, 2);
  });
});
