import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import type { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { ModelEffort } from "../../shared/modelEffort.js";
import { errorHandler } from "../middleware/error.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { attachExistingModel } from "../test/modelFixtures.js";

/**
 * Thinking levels through the real `createApp()` stack: a Member sets their
 * own conversation's level from a signed-in browser and every message
 * resolves it against its AI Model; owners and admins set each model's
 * default and ceiling at Settings → AI Models. Nobody else changes either —
 * not another Member, not an API key.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let owner: User;
let member: User;
let employee: AIEmployee;
/** GPT-5.4 offers Off to Extra high, at Medium by itself. */
let gpt: AIModel;
let memberThread: Conversation;

async function addUser(role: Role): Promise<User> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.test`,
    name: role,
    passwordHash: "not-a-real-hash",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  return user;
}

async function thread(ownerUserId: string | null, values: Partial<Conversation> = {}) {
  return insert(Conversation, {
    employeeId: employee.id,
    ownerUserId,
    title: "Quotes",
    source: "web",
    ...values,
  });
}

beforeEach(async () => {
  await resetTestDb();
  ({ user: owner, company } = await createMemberOfNewCompany("owner"));
  member = await addUser("member");
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  gpt = await insert(AIModel, {
    companyId: company.id,
    provider: "openai",
    model: "gpt-5.4",
    authMode: "apikey",
    configJson: JSON.stringify({ apiKeyEncrypted: "v2.cipher", apiKeyPreview: "sk-…0001" }),
    connectedAt: new Date(),
  });
  await attachExistingModel({ employeeId: employee.id, modelId: gpt.id, isActive: true });
  memberThread = await thread(member.id);
});

async function request(
  method: string,
  path: string,
  auth: { token?: string; cookie?: string },
  body?: unknown,
) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: {
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(auth.cookie ? { cookie: auth.cookie, origin: baseUrl } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed as Record<string, unknown>, text };
}

/** Every SSE frame of a streamed send, read to the end. */
function sseFrames(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const frame of text.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (event && data) frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }
  return frames;
}

const conversationPath = (id: string) => `/employees/${employee.id}/conversations/${id}`;
const storedEffort = async (id: string) =>
  (await AppDataSource.getRepository(Conversation).findOneByOrFail({ id })).effort;

describe("a conversation's thinking level", () => {
  test("its owner sets it, it sticks without moving the thread, and Default clears it", async () => {
    const cookie = await sessionCookieFor(member);
    const before = await AppDataSource.getRepository(Conversation).findOneByOrFail({
      id: memberThread.id,
    });
    const set = await request("PUT", `${conversationPath(memberThread.id)}/thinking`, { cookie }, {
      effort: "high",
    });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.body.effort, "high");
    assert.equal(await storedEffort(memberThread.id), "high");

    const detail = await request("GET", conversationPath(memberThread.id), { cookie });
    assert.equal((detail.body.conversation as { effort: string }).effort, "high");
    const listed = await request("GET", `/employees/${employee.id}/conversations`, { cookie });
    assert.equal((listed.body as unknown as Array<{ effort: string }>)[0].effort, "high");
    // A setting, not activity: the thread keeps its place in the sidebar.
    const after = await AppDataSource.getRepository(Conversation).findOneByOrFail({
      id: memberThread.id,
    });
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());

    const cleared = await request(
      "PUT",
      `${conversationPath(memberThread.id)}/thinking`,
      { cookie },
      { effort: null },
    );
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.effort, null);
    assert.equal(await storedEffort(memberThread.id), null);
  });

  test("the schema refuses a level it does not know, a missing level and extra fields", async () => {
    const cookie = await sessionCookieFor(member);
    for (const body of [{ effort: "turbo" }, {}, { effort: "high", modelId: gpt.id }, { effort: 3 }]) {
      const result = await request("PUT", `${conversationPath(memberThread.id)}/thinking`, { cookie }, body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error, "ValidationError");
    }
    assert.equal(await storedEffort(memberThread.id), null);
  });

  test("nobody who cannot send to the conversation changes it", async () => {
    const legacy = await thread(null);
    const ownerCookie = await sessionCookieFor(owner);
    const otherMember = await addUser("member");
    const otherCookie = await sessionCookieFor(otherMember);
    for (const [cookie, id] of [
      // The company's owner cannot reach into a Member's private thread…
      [ownerCookie, memberThread.id],
      // …nor can another Member…
      [otherCookie, memberThread.id],
      // …and a legacy thread must be claimed first, like sending to it.
      [ownerCookie, legacy.id],
      [ownerCookie, randomUUID()],
    ] as const) {
      const result = await request("PUT", `${conversationPath(id)}/thinking`, { cookie }, {
        effort: "max",
      });
      assert.equal(result.status, 404, id);
    }
    assert.equal(await storedEffort(memberThread.id), null);
    assert.equal(await storedEffort(legacy.id), null);
  });

  test("an API key cannot set it, even the conversation owner's own", async () => {
    const { token } = await mintTestApiKey(member.id, company.id);
    const result = await request("PUT", `${conversationPath(memberThread.id)}/thinking`, { token }, {
      effort: "high",
    });
    assert.equal(result.status, 403);
    assert.match(String(result.body.error), /browser session/);
    assert.equal(await storedEffort(memberThread.id), null);
  });

  test("a new conversation can start at a level", async () => {
    const cookie = await sessionCookieFor(member);
    const created = await request("POST", `/employees/${employee.id}/conversations`, { cookie }, {
      effort: "low",
    });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.effort, "low");
    assert.equal(await storedEffort(String(created.body.id)), "low");
    const refused = await request("POST", `/employees/${employee.id}/conversations`, { cookie }, {
      effort: "turbo",
    });
    assert.equal(refused.status, 400);
  });
});

describe("sending at the conversation's level", () => {
  async function send(body: Record<string, unknown>, id = memberThread.id) {
    const cookie = await sessionCookieFor(member);
    const response = await request("POST", `${conversationPath(id)}/messages`, { cookie }, body);
    assert.equal(response.status, 200, response.text);
    return sseFrames(response.text);
  }

  async function reply(id = memberThread.id) {
    return AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      conversationId: id,
      role: "assistant",
    });
  }

  test("a level the model does not offer runs at its nearest, shown on the reply", async () => {
    await AppDataSource.getRepository(Conversation).update({ id: memberThread.id }, { effort: "max" });
    const frames = await send({ message: "Think hard", modelId: gpt.id });
    const working = frames.find((frame) => frame.event === "working")?.data;
    assert.deepEqual(working?.thinking, { level: "xhigh", requested: "max", adjusted: "unsupported" });
    const row = await reply();
    assert.equal(row.effort, "xhigh");
    assert.equal(row.modelId, gpt.id);
    // The conversation keeps Max: another model may offer it.
    assert.equal(await storedEffort(memberThread.id), "max");
  });

  test("a message that names a level sets the conversation's", async () => {
    const frames = await send({ message: "Keep it quick", effort: "low" });
    const conversation = frames.find((frame) => frame.event === "conversation")?.data;
    assert.equal(conversation?.effort, "low");
    assert.equal(await storedEffort(memberThread.id), "low");
    assert.equal((await reply()).effort, "low");
  });

  test("a message without one keeps the conversation's level", async () => {
    await AppDataSource.getRepository(Conversation).update({ id: memberThread.id }, { effort: "high" });
    await send({ message: "Carry on" });
    assert.equal(await storedEffort(memberThread.id), "high");
    assert.equal((await reply()).effort, "high");
  });

  test("Default takes the owners' default, and every level their ceiling", async () => {
    await AppDataSource.getRepository(AIModel).update({ id: gpt.id }, { defaultEffort: "low" });
    await send({ message: "At default" });
    const atDefault = await reply();
    assert.equal(atDefault.effort, "low");
    assert.deepEqual(JSON.parse(atDefault.thinkingJson), {
      level: "low",
      requested: null,
      adjusted: null,
    });

    const capped = await thread(member.id, { effort: "xhigh" });
    await AppDataSource.getRepository(AIModel).update(
      { id: gpt.id },
      { defaultEffort: null, effortCeiling: "medium" },
    );
    await send({ message: "Think as hard as you can" }, capped.id);
    const row = await reply(capped.id);
    assert.equal(row.effort, "medium");
    assert.deepEqual(JSON.parse(row.thinkingJson), {
      level: "medium",
      requested: "xhigh",
      adjusted: "ceiling",
    });
  });

  test("the reply's level comes back with the conversation", async () => {
    await AppDataSource.getRepository(Conversation).update({ id: memberThread.id }, { effort: "high" });
    await send({ message: "Think" });
    const cookie = await sessionCookieFor(member);
    const detail = await request("GET", conversationPath(memberThread.id), { cookie });
    const messages = detail.body.messages as Array<{ role: string; thinking: unknown }>;
    assert.deepEqual(messages.find((message) => message.role === "assistant")?.thinking, {
      level: "high",
      requested: "high",
      adjusted: null,
    });
    assert.equal(messages.find((message) => message.role === "user")?.thinking, null);
  });
});

describe("an AI Model's thinking settings", () => {
  const path = () => `/models/${gpt.id}/thinking`;

  test("owners and admins set the default and ceiling from a browser, and it is audited", async () => {
    const cookie = await sessionCookieFor(owner);
    const saved = await request("PUT", path(), { cookie }, {
      defaultEffort: "medium",
      effortCeiling: "high",
    });
    assert.equal(saved.status, 200, saved.text);
    const thinking = saved.body.thinking as Record<string, unknown>;
    assert.equal(thinking.defaultLevel, "medium");
    assert.equal(thinking.ceiling, "high");
    assert.deepEqual(thinking.levels, ["none", "low", "medium", "high", "xhigh"]);
    assert.equal(thinking.nativeDefault, "medium");
    const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: gpt.id });
    assert.equal(stored.defaultEffort, "medium");
    assert.equal(stored.effortCeiling, "high");
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "model.configure",
      targetId: gpt.id,
    });
    assert.match(audit.metadataJson, /"effortCeiling":"high"/);
    assert.match(audit.metadataJson, /"defaultEffort":"medium"/);

    const admin = await addUser("admin");
    const byAdmin = await request("PUT", path(), { cookie: await sessionCookieFor(admin) }, {
      defaultEffort: null,
      effortCeiling: null,
    });
    assert.equal(byAdmin.status, 200, byAdmin.text);
    assert.equal((byAdmin.body.thinking as Record<string, unknown>).ceiling, null);
  });

  test("a Member and an API key cannot change them", async () => {
    const asMember = await request("PUT", path(), { cookie: await sessionCookieFor(member) }, {
      defaultEffort: "max",
      effortCeiling: null,
    });
    assert.equal(asMember.status, 403);
    const { token } = await mintTestApiKey(owner.id, company.id);
    const asKey = await request("PUT", path(), { token }, { defaultEffort: "max", effortCeiling: null });
    assert.equal(asKey.status, 403);
    const stored = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: gpt.id });
    assert.equal(stored.defaultEffort, null);
  });

  test("levels the model does not offer, a default over the ceiling and the custom switch are refused", async () => {
    const cookie = await sessionCookieFor(owner);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ defaultEffort: "max", effortCeiling: null }, /doesn't offer Max as a default/],
      [{ defaultEffort: null, effortCeiling: "ultra" }, /doesn't offer Ultra as a highest level/],
      [{ defaultEffort: "high", effortCeiling: "low" }, /can't be above the highest level/],
      [
        { defaultEffort: null, effortCeiling: null, customThinkingLevels: true },
        /Only a custom endpoint turns thinking levels on or off/,
      ],
    ];
    for (const [body, message] of cases) {
      const result = await request("PUT", path(), { cookie }, body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.match(String(result.body.error), message);
    }
    for (const body of [
      { defaultEffort: "turbo", effortCeiling: null },
      { defaultEffort: "low" },
      { defaultEffort: null, effortCeiling: null, extra: true },
    ]) {
      const result = await request("PUT", path(), { cookie }, body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error, "ValidationError");
    }
  });

  test("a custom endpoint's levels turn on, take a default, and turn off with it cleared", async () => {
    const local = await insert(AIModel, {
      companyId: company.id,
      provider: "custom",
      model: "qwen3",
      authMode: "customEndpoint",
      configJson: JSON.stringify({ baseURLPreview: "gpu.example.test", modelId: "qwen3" }),
      connectedAt: new Date(),
    });
    const cookie = await sessionCookieFor(owner);
    const at = `/models/${local.id}/thinking`;
    const off = await request("GET", `/models/${local.id}`, { cookie });
    assert.deepEqual((off.body.thinking as { levels: ModelEffort[] }).levels, []);

    const on = await request("PUT", at, { cookie }, {
      customThinkingLevels: true,
      defaultEffort: "low",
      effortCeiling: "medium",
    });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.body.customThinkingLevels, true);
    assert.deepEqual((on.body.thinking as { levels: ModelEffort[] }).levels, [
      "none",
      "low",
      "medium",
      "high",
    ]);

    const inconsistent = await request("PUT", at, { cookie }, {
      customThinkingLevels: false,
      defaultEffort: "low",
      effortCeiling: null,
    });
    assert.equal(inconsistent.status, 400);
    const cleared = await request("PUT", at, { cookie }, {
      customThinkingLevels: false,
      defaultEffort: null,
      effortCeiling: null,
    });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.customThinkingLevels, false);
    assert.deepEqual((cleared.body.thinking as { levels: ModelEffort[] }).levels, []);
  });

  test("the employee's model list carries what the composer needs, for any Member", async () => {
    await AppDataSource.getRepository(AIModel).update(
      { id: gpt.id },
      { defaultEffort: "low", effortCeiling: "high" },
    );
    const listed = await request("GET", `/employees/${employee.id}/models`, {
      cookie: await sessionCookieFor(member),
    });
    assert.equal(listed.status, 200, listed.text);
    const [model] = listed.body as unknown as Array<{ thinking: Record<string, unknown> }>;
    assert.deepEqual(model.thinking, {
      levels: ["none", "low", "medium", "high", "xhigh"],
      nativeDefault: "medium",
      defaultLevel: "low",
      ceiling: "high",
      unavailableReason: null,
    });
  });
});
