import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test, type TestContext } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import type { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { maskSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { apiKeyRingFor } from "../services/agent/apiKeyRing.js";
import { agentRuntime } from "../services/agent/runtime.js";
import {
  decryptApiKeys,
  newStoredApiKey,
  readApiKeys,
  writeApiKeys,
} from "../services/modelApiKeys.js";
import { resetKeyHealthMemory, settleKeySessionWrites } from "../services/modelKeyHealth.js";
import { resetKeyPoolMemory } from "../services/modelKeyPool.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";

/**
 * The routes behind an AI Model's API keys card, end to end through the real
 * `createApp()` — cookie session, browser-only guard, company scoping and all:
 * the card lists every key as an equal with the sessions it carried in the last
 * day, a key added there joins the turns at once, a key removed there takes no
 * more sessions, an order can still be set without changing whose turn it is,
 * and nothing secret ever comes back.
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

type CardKey = {
  id: string;
  preview: string;
  lastUsedAt: string | null;
  restingUntil: string | null;
  sessionsLast24h: number;
};
type CardModel = { id: string; status: string; apiKeys: CardKey[] };

const KEYS = [
  "sk-ant-api03-card-pool-key-one-00000001",
  "sk-ant-api03-card-pool-key-two-00000002",
  "sk-ant-api03-card-pool-key-three-000003",
];
const ADDED = "sk-ant-api03-card-pool-key-added-00004";
const SECRETS = [...KEYS, ADDED];

let company: Company;
let owner: User;
let cookie = "";
let employee: AIEmployee;
let model: AIModel;

beforeEach(async () => {
  await resetTestDb();
  resetKeyHealthMemory();
  resetKeyPoolMemory({ random: () => 0 });
  const created = await createMemberOfNewCompany("owner");
  company = created.company;
  owner = created.user;
  cookie = await sessionCookieFor(owner);
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Avery",
    slug: `avery-${randomUUID()}`,
    role: "Researcher",
  });
  model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    isActive: true,
    configJson: writeApiKeys(
      "{}",
      KEYS.map((key) => newStoredApiKey(key, company.id)),
    ),
    connectedAt: new Date(),
  });
});

async function call<T = CardModel>(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; token?: string } = {},
): Promise<{ status: number; body: T; text: string }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.token ? {} : { cookie: options.cookie ?? cookie }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret}`);
  for (const field of ["apiKeyEncrypted", "configJson", "backupKeys", "v2."]) {
    assert.ok(!text.includes(field), `exposed ${field}`);
  }
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, text };
}

/** The connection test behind Add key passes, and says whether it took a turn. */
function stubKeyTest(t: TestContext): Array<boolean | undefined> {
  const keySessions: Array<boolean | undefined> = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    keySessions.push(params.keySession);
    await params.registry.resolve("connection_test")!.run({ ok: true });
    return { finalText: "OK", steps: 2, stopReason: "end_turn" };
  });
  return keySessions;
}

/** Open `n` sessions on the saved model, as turns do; the plaintext key each opened on. */
async function openSessions(n: number): Promise<string[]> {
  const opened: string[] = [];
  for (let i = 0; i < n; i++) {
    const saved = await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id });
    opened.push((await apiKeyRingFor(saved, { session: true }))!.attemptOrder()[0].apiKey);
  }
  await settleKeySessionWrites();
  return opened;
}

const card = async () => {
  const listed = await call<CardModel[]>("GET", "/models");
  assert.equal(listed.status, 200, listed.text);
  const found = listed.body.find((entry) => entry.id === model.id);
  assert.ok(found);
  return found;
};

describe("the API keys card, through createApp()", () => {
  test("lists every key as an equal, with the sessions each carried in the last day", async () => {
    let shown = await card();
    assert.deepEqual(
      shown.apiKeys.map((key) => key.preview),
      KEYS.map(maskSecret),
    );
    assert.deepEqual(
      shown.apiKeys.map((key) => key.sessionsLast24h),
      [0, 0, 0],
    );
    assert.deepEqual(await openSessions(6), [...KEYS, ...KEYS]);
    shown = await card();
    assert.deepEqual(
      shown.apiKeys.map((key) => key.sessionsLast24h),
      [2, 2, 2],
    );
  });

  test("a key added on the card is tested alone without taking a turn, then joins the turns at once", async (t) => {
    const keySessions = stubKeyTest(t);
    await openSessions(3);
    const added = await call("POST", `/models/${model.id}/keys`, { body: { apiKey: ADDED } });
    assert.equal(added.status, 200, added.text);
    assert.deepEqual(keySessions, [false]);
    assert.deepEqual(
      added.body.apiKeys.map((key) => key.preview),
      [...KEYS, ADDED].map(maskSecret),
    );
    const next = await openSessions(4);
    assert.deepEqual(next, [ADDED, ...KEYS], "the new key goes first, then everyone's next turn");
  });

  test("a key removed on the card takes no more sessions", async () => {
    await openSessions(2);
    const [, second] = readApiKeys(model.configJson);
    const removed = await call("DELETE", `/models/${model.id}/keys/${second.id}`);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.apiKeys.length, 2);
    assert.deepEqual(await openSessions(4), [KEYS[2], KEYS[0], KEYS[2], KEYS[0]]);
  });

  test("an order can still be set, and whose turn it is stays the same", async () => {
    assert.deepEqual(await openSessions(3), KEYS);
    const ids = readApiKeys(model.configJson).map((key) => key.id);
    const reordered = await call("POST", `/models/${model.id}/keys/reorder`, {
      body: { orderedIds: [ids[2], ids[1], ids[0]] },
    });
    assert.equal(reordered.status, 200, reordered.text);
    assert.deepEqual(
      reordered.body.apiKeys.map((key) => key.id),
      [ids[2], ids[1], ids[0]],
    );
    assert.deepEqual(await openSessions(3), KEYS);
  });

  test("a Member reads the keys and their sessions on the employee's page, and changes nothing", async () => {
    await openSessions(3);
    const member = await insert(User, {
      email: `member-${randomUUID()}@example.test`,
      name: "Member",
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
    const memberCookie = await sessionCookieFor(member);
    const onEmployee = await call<CardModel[]>("GET", `/employees/${employee.id}/models`, {
      cookie: memberCookie,
    });
    assert.equal(onEmployee.status, 200, onEmployee.text);
    assert.deepEqual(
      onEmployee.body[0].apiKeys.map((key) => key.sessionsLast24h),
      [1, 1, 1],
    );
    assert.equal(
      (
        await call("POST", `/models/${model.id}/keys`, {
          body: { apiKey: ADDED },
          cookie: memberCookie,
        })
      ).status,
      403,
    );
    assert.deepEqual(
      decryptApiKeys(
        (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id })).configJson,
      ).map((key) => key.apiKey),
      KEYS,
    );
  });

  test("an API key can't reach the card's routes: keys are managed from a signed-in browser", async () => {
    const { token } = await mintTestApiKey(owner.id, company.id);
    const [, second] = readApiKeys(model.configJson);
    for (const [method, path, body] of [
      ["GET", "/models", undefined],
      ["POST", `/models/${model.id}/keys`, { apiKey: ADDED }],
      ["DELETE", `/models/${model.id}/keys/${second.id}`, undefined],
    ] as const) {
      const response = await call(method, path, { token, body });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  });
});
