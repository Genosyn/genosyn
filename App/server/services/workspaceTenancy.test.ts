import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { ChannelMessage } from "../db/entities/ChannelMessage.js";
import { Company } from "../db/entities/Company.js";
import { MessageReaction } from "../db/entities/MessageReaction.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import {
  addChannelMembers,
  assertActorsInCompany,
  createChannel,
  findOrCreateDM,
  toggleReaction,
} from "./workspaceChat.js";

/**
 * Workspace writes cannot name an actor from another company.
 *
 * Every function here takes `userId` / `employeeId` values straight from a
 * request body. The browser routes authorize the *caller* against the company
 * in the URL and then never checked the ids in the payload — so a Member of
 * company A could name a user or an AI Employee of company B, leave a durable
 * `ChannelMember` row, and have `hydrateChannel` read that person's name and
 * email straight back out. The MCP twin of the same operation has always
 * checked; this suite pins the rule at the seam that writes the row, where
 * neither door can route around it.
 *
 * Each case asserts two things, and the second is the one that matters: the
 * call is refused, AND nothing was written. A guard that throws after the
 * insert would satisfy the first alone.
 */

let alpha: Company;
let beta: Company;
/** A Member and an AI Employee in each company. */
let alphaUser: User;
let betaUser: User;
let alphaEmployee: AIEmployee;
let betaEmployee: AIEmployee;

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  // Users first: a Company row requires its owner.
  alphaUser = await insert(User, {
    id: testId("usr"),
    email: `alpha-${testId("e")}@example.com`,
    name: "Alpha Person",
    passwordHash: "x",
  } as never);
  betaUser = await insert(User, {
    id: testId("usr"),
    email: `beta-${testId("e")}@example.com`,
    name: "Beta Person",
    passwordHash: "x",
  } as never);

  alpha = await insert(Company, {
    name: "Alpha",
    slug: `alpha-${testId("x")}`,
    ownerId: alphaUser.id,
  } as never);
  beta = await insert(Company, {
    name: "Beta",
    slug: `beta-${testId("x")}`,
    ownerId: betaUser.id,
  } as never);

  await insert(Membership, { companyId: alpha.id, userId: alphaUser.id, role: "owner" } as never);
  await insert(Membership, { companyId: beta.id, userId: betaUser.id, role: "owner" } as never);

  alphaEmployee = await insert(AIEmployee, {
    companyId: alpha.id,
    name: "Ada",
    slug: "ada",
    role: "Ops",
    soulBody: "",
  });
  betaEmployee = await insert(AIEmployee, {
    companyId: beta.id,
    name: "Bea",
    slug: "bea",
    role: "Ops",
    soulBody: "",
  });
});

async function channelCount(): Promise<number> {
  return AppDataSource.getRepository(Channel).count();
}
async function memberCount(): Promise<number> {
  return AppDataSource.getRepository(ChannelMember).count();
}
async function reactionCount(): Promise<number> {
  return AppDataSource.getRepository(MessageReaction).count();
}

/** A channel in `companyId` with `alphaUser` as its only human member. */
async function seedChannel(companyId: string, kind: "public" | "private" = "public") {
  const channel = await insert(Channel, {
    companyId,
    kind,
    name: "general",
    slug: `general-${testId("s")}`,
    topic: "",
    webhookToken: null,
    createdByUserId: null,
    archivedAt: null,
    lastMessageAt: null,
  } as never);
  return channel;
}

async function seedMessage(channelId: string) {
  return insert(ChannelMessage, {
    channelId,
    authorKind: "user",
    authorUserId: alphaUser.id,
    authorEmployeeId: null,
    authorName: "Alpha Person",
    content: "hello",
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
  } as never);
}

describe("assertActorsInCompany", () => {
  test("accepts members and employees of the company", async () => {
    await assert.doesNotReject(() =>
      assertActorsInCompany(alpha.id, {
        userIds: [alphaUser.id],
        employeeIds: [alphaEmployee.id],
      }),
    );
  });

  test("refuses a user who is merely a User row, with no Membership here", async () => {
    // Being a User is not being part of a company; the Membership is.
    await assert.rejects(
      () => assertActorsInCompany(alpha.id, { userIds: [betaUser.id] }),
      /User not found/,
    );
  });

  test("refuses an employee of another company", async () => {
    await assert.rejects(
      () => assertActorsInCompany(alpha.id, { employeeIds: [betaEmployee.id] }),
      /Employee not found/,
    );
  });

  test("refuses an id that does not exist at all", async () => {
    await assert.rejects(
      () => assertActorsInCompany(alpha.id, { userIds: ["usr_nope"] }),
      /User not found/,
    );
  });

  test("does not distinguish 'no such user' from 'other company's user'", async () => {
    // The difference would itself be a cross-tenant existence oracle.
    const foreign = await assertActorsInCompany(alpha.id, { userIds: [betaUser.id] }).catch(
      (e) => (e as Error).message,
    );
    const absent = await assertActorsInCompany(alpha.id, { userIds: ["usr_nope"] }).catch(
      (e) => (e as Error).message,
    );
    assert.equal(foreign, absent);
  });

  test("refuses when one id in a batch is foreign", async () => {
    await assert.rejects(
      () =>
        assertActorsInCompany(alpha.id, {
          userIds: [alphaUser.id, betaUser.id],
        }),
      /User not found/,
    );
  });

  test("empty lists are accepted", async () => {
    await assert.doesNotReject(() => assertActorsInCompany(alpha.id, {}));
    await assert.doesNotReject(() =>
      assertActorsInCompany(alpha.id, { userIds: [], employeeIds: [] }),
    );
  });

  test("duplicate ids are deduplicated, not double-counted", async () => {
    await assert.doesNotReject(() =>
      assertActorsInCompany(alpha.id, { userIds: [alphaUser.id, alphaUser.id] }),
    );
  });
});

describe("createChannel", () => {
  test("creates with same-company members", async () => {
    const channel = await createChannel({
      companyId: alpha.id,
      name: "Team",
      topic: "",
      kind: "public",
      createdByUserId: alphaUser.id,
      initialMemberUserIds: [alphaUser.id],
      initialEmployeeIds: [alphaEmployee.id],
    });
    assert.equal(channel.companyId, alpha.id);
    assert.equal(await memberCount(), 2);
  });

  test("refuses a member from another company, and writes nothing", async () => {
    await assert.rejects(
      () =>
        createChannel({
          companyId: alpha.id,
          name: "Team",
          topic: "",
          kind: "public",
          createdByUserId: alphaUser.id,
          initialMemberUserIds: [betaUser.id],
          initialEmployeeIds: [],
        }),
      /User not found/,
    );
    assert.equal(await channelCount(), 0, "no channel row should survive the refusal");
    assert.equal(await memberCount(), 0);
  });

  test("refuses an AI Employee from another company, and writes nothing", async () => {
    await assert.rejects(
      () =>
        createChannel({
          companyId: alpha.id,
          name: "Team",
          topic: "",
          kind: "public",
          createdByUserId: alphaUser.id,
          initialMemberUserIds: [],
          initialEmployeeIds: [betaEmployee.id],
        }),
      /Employee not found/,
    );
    assert.equal(await channelCount(), 0);
    assert.equal(await memberCount(), 0);
  });

  test("refuses a foreign creator", async () => {
    await assert.rejects(
      () =>
        createChannel({
          companyId: alpha.id,
          name: "Team",
          topic: "",
          kind: "public",
          createdByUserId: betaUser.id,
          initialMemberUserIds: [],
          initialEmployeeIds: [],
        }),
      /User not found/,
    );
    assert.equal(await channelCount(), 0);
  });

  test("refuses when only one of several members is foreign", async () => {
    await assert.rejects(
      () =>
        createChannel({
          companyId: alpha.id,
          name: "Team",
          topic: "",
          kind: "private",
          createdByUserId: alphaUser.id,
          initialMemberUserIds: [alphaUser.id, betaUser.id],
          initialEmployeeIds: [],
        }),
      /User not found/,
    );
    assert.equal(await channelCount(), 0);
  });
});

describe("findOrCreateDM", () => {
  test("opens a DM between two actors of the same company", async () => {
    const channel = await findOrCreateDM({
      companyId: alpha.id,
      from: { kind: "user", userId: alphaUser.id },
      target: { kind: "ai", employeeId: alphaEmployee.id },
    });
    assert.equal(channel.kind, "dm");
    assert.equal(channel.companyId, alpha.id);
  });

  test("is idempotent for the same pair", async () => {
    const first = await findOrCreateDM({
      companyId: alpha.id,
      from: { kind: "user", userId: alphaUser.id },
      target: { kind: "ai", employeeId: alphaEmployee.id },
    });
    const second = await findOrCreateDM({
      companyId: alpha.id,
      from: { kind: "user", userId: alphaUser.id },
      target: { kind: "ai", employeeId: alphaEmployee.id },
    });
    assert.equal(first.id, second.id);
    assert.equal(await channelCount(), 1);
  });

  test("refuses a DM to another company's user, and writes nothing", async () => {
    await assert.rejects(
      () =>
        findOrCreateDM({
          companyId: alpha.id,
          from: { kind: "user", userId: alphaUser.id },
          target: { kind: "user", userId: betaUser.id },
        }),
      /User not found/,
    );
    assert.equal(await channelCount(), 0);
    assert.equal(await memberCount(), 0);
  });

  test("refuses a DM to another company's AI Employee", async () => {
    await assert.rejects(
      () =>
        findOrCreateDM({
          companyId: alpha.id,
          from: { kind: "user", userId: alphaUser.id },
          target: { kind: "ai", employeeId: betaEmployee.id },
        }),
      /Employee not found/,
    );
    assert.equal(await channelCount(), 0);
  });

  test("refuses when the initiator is foreign to the named company", async () => {
    // The shape an attacker uses: authorize as Beta, pass Alpha's company id.
    await assert.rejects(
      () =>
        findOrCreateDM({
          companyId: alpha.id,
          from: { kind: "user", userId: betaUser.id },
          target: { kind: "user", userId: alphaUser.id },
        }),
      /User not found/,
    );
    assert.equal(await channelCount(), 0);
  });

  test("refuses an employee-to-employee DM across companies", async () => {
    await assert.rejects(
      () =>
        findOrCreateDM({
          companyId: alpha.id,
          from: { kind: "ai", employeeId: alphaEmployee.id },
          target: { kind: "ai", employeeId: betaEmployee.id },
        }),
      /Employee not found/,
    );
    assert.equal(await channelCount(), 0);
  });

  test("still refuses DMing yourself, before the company check", async () => {
    await assert.rejects(
      () =>
        findOrCreateDM({
          companyId: alpha.id,
          from: { kind: "user", userId: alphaUser.id },
          target: { kind: "user", userId: alphaUser.id },
        }),
      /Cannot DM yourself/,
    );
  });
});

describe("addChannelMembers", () => {
  test("adds same-company actors", async () => {
    const channel = await seedChannel(alpha.id);
    const added = await addChannelMembers({
      channelId: channel.id,
      companyId: alpha.id,
      userIds: [alphaUser.id],
      employeeIds: [alphaEmployee.id],
    });
    assert.equal(added.length, 2);
  });

  test("refuses a foreign user, and writes nothing", async () => {
    const channel = await seedChannel(alpha.id);
    await assert.rejects(
      () =>
        addChannelMembers({
          channelId: channel.id,
          companyId: alpha.id,
          userIds: [betaUser.id],
          employeeIds: [],
        }),
      /User not found/,
    );
    assert.equal(await memberCount(), 0);
  });

  test("refuses a foreign AI Employee", async () => {
    const channel = await seedChannel(alpha.id);
    await assert.rejects(
      () =>
        addChannelMembers({
          channelId: channel.id,
          companyId: alpha.id,
          userIds: [],
          employeeIds: [betaEmployee.id],
        }),
      /Employee not found/,
    );
    assert.equal(await memberCount(), 0);
  });

  test("refuses a channel belonging to another company", async () => {
    // Even with a perfectly valid local actor: the channel itself is foreign.
    const foreign = await seedChannel(beta.id);
    await assert.rejects(
      () =>
        addChannelMembers({
          channelId: foreign.id,
          companyId: alpha.id,
          userIds: [alphaUser.id],
          employeeIds: [],
        }),
      /Channel not found/,
    );
    assert.equal(await memberCount(), 0);
  });

  test("refuses a channel that does not exist", async () => {
    await assert.rejects(
      () =>
        addChannelMembers({
          channelId: "chn_nope",
          companyId: alpha.id,
          userIds: [alphaUser.id],
          employeeIds: [],
        }),
      /Channel not found/,
    );
  });

  test("the channel check runs before the actor check", async () => {
    const foreign = await seedChannel(beta.id);
    await assert.rejects(
      () =>
        addChannelMembers({
          channelId: foreign.id,
          companyId: alpha.id,
          userIds: [betaUser.id],
          employeeIds: [],
        }),
      /Channel not found/,
    );
  });

  test("adding an existing member stays idempotent", async () => {
    const channel = await seedChannel(alpha.id);
    await addChannelMembers({
      channelId: channel.id,
      companyId: alpha.id,
      userIds: [alphaUser.id],
      employeeIds: [],
    });
    const again = await addChannelMembers({
      channelId: channel.id,
      companyId: alpha.id,
      userIds: [alphaUser.id],
      employeeIds: [],
    });
    assert.equal(again.length, 0);
    assert.equal(await memberCount(), 1);
  });
});

describe("toggleReaction", () => {
  test("reacts in a channel the user belongs to", async () => {
    const channel = await seedChannel(alpha.id);
    await addChannelMembers({
      channelId: channel.id,
      companyId: alpha.id,
      userIds: [alphaUser.id],
      employeeIds: [],
    });
    const message = await seedMessage(channel.id);
    const result = await toggleReaction({
      messageId: message.id,
      emoji: "👍",
      userId: alphaUser.id,
      companyId: alpha.id,
    });
    assert.deepEqual(result, { added: true });
    assert.equal(await reactionCount(), 1);
  });

  test("toggling twice removes the reaction", async () => {
    const channel = await seedChannel(alpha.id);
    await addChannelMembers({
      channelId: channel.id,
      companyId: alpha.id,
      userIds: [alphaUser.id],
      employeeIds: [],
    });
    const message = await seedMessage(channel.id);
    const args = {
      messageId: message.id,
      emoji: "👍",
      userId: alphaUser.id,
      companyId: alpha.id,
    };
    await toggleReaction(args);
    assert.deepEqual(await toggleReaction(args), { added: false });
    assert.equal(await reactionCount(), 0);
  });

  test("refuses a message in another company, and writes nothing", async () => {
    const foreignChannel = await seedChannel(beta.id);
    const foreignMessage = await seedMessage(foreignChannel.id);
    await assert.rejects(
      () =>
        toggleReaction({
          messageId: foreignMessage.id,
          emoji: "👍",
          userId: alphaUser.id,
          companyId: alpha.id,
        }),
      /Message not found/,
    );
    assert.equal(await reactionCount(), 0);
  });

  test("refuses a private channel of the same company the user is not in", async () => {
    // Same-company is necessary but not sufficient — reacting is a write.
    const privateChannel = await seedChannel(alpha.id, "private");
    const message = await seedMessage(privateChannel.id);
    await assert.rejects(
      () =>
        toggleReaction({
          messageId: message.id,
          emoji: "👍",
          userId: alphaUser.id,
          companyId: alpha.id,
        }),
      /Message not found/,
    );
    assert.equal(await reactionCount(), 0);
  });

  test("refuses a message id that does not exist", async () => {
    await assert.rejects(
      () =>
        toggleReaction({
          messageId: "msg_nope",
          emoji: "👍",
          userId: alphaUser.id,
          companyId: alpha.id,
        }),
      /Message not found/,
    );
  });

  test("the cross-tenant refusal is indistinguishable from a missing message", async () => {
    const foreignChannel = await seedChannel(beta.id);
    const foreignMessage = await seedMessage(foreignChannel.id);
    const foreign = await toggleReaction({
      messageId: foreignMessage.id,
      emoji: "👍",
      userId: alphaUser.id,
      companyId: alpha.id,
    }).catch((e) => (e as Error).message);
    const absent = await toggleReaction({
      messageId: "msg_nope",
      emoji: "👍",
      userId: alphaUser.id,
      companyId: alpha.id,
    }).catch((e) => (e as Error).message);
    assert.equal(foreign, absent);
  });

  test("a foreign reaction never reaches the other company's message", async () => {
    const foreignChannel = await seedChannel(beta.id);
    const foreignMessage = await seedMessage(foreignChannel.id);
    await toggleReaction({
      messageId: foreignMessage.id,
      emoji: "👍",
      userId: alphaUser.id,
      companyId: alpha.id,
    }).catch(() => undefined);
    const onForeign = await AppDataSource.getRepository(MessageReaction).count({
      where: { messageId: foreignMessage.id },
    });
    assert.equal(onForeign, 0);
  });
});
