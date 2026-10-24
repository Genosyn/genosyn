import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeModel } from "../db/entities/EmployeeModel.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { maskSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { newStoredApiKey, writeApiKeys } from "../services/modelApiKeys.js";
import { getActiveModel } from "../services/models.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { attachExistingModel, flaggedActiveModel } from "../test/modelFixtures.js";
import { persistTestSession } from "../test/userSession.js";
import { modelsRouter } from "./models.js";

/**
 * One AI Employee's AI Models through the real employee models router: the
 * list any Member may read, attaching one of the company's models (what
 * "reuse" became — the employee runs on the same model, never a copy),
 * switching which one is active, and detaching, which never deletes the
 * company's model or anyone else's use of it.
 */

type PublicModel = {
  id: string;
  isActive: boolean;
  status: string;
  apiKeys: Array<{ preview: string }>;
  employees: Array<{ id: string; name: string; isActive: boolean }>;
};
type ApiResponse<T> = { status: number; body: T; text: string };

const mutableConfig = config as unknown as {
  sessionSecret: string;
  security: { encryptionSecret: string };
};
const original = {
  sessionSecret: mutableConfig.sessionSecret,
  encryptionSecret: mutableConfig.security.encryptionSecret,
};

const KEY_A = "sk-ant-api03-attach-route-key-aaaa0001";
const KEY_B = "sk-ant-api03-attach-route-key-bbbb0002";

let server: Server;
let baseUrl: string;
let actingUser: User;
let owner: User;
let company: Company;
let ada: AIEmployee;
let grace: AIEmployee;

before(async () => {
  mutableConfig.sessionSecret = "models-attach-session-secret-0123456789abcdef";
  mutableConfig.security.encryptionSecret = "models-attach-encryption-secret-0123456789abcdef";
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: req.header("x-test-user"),
      sessionVersion: 0,
      authenticatedAt: Date.now(),
    };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  mutableConfig.sessionSecret = original.sessionSecret;
  mutableConfig.security.encryptionSecret = original.encryptionSecret;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function makeUser(label: string): Promise<User> {
  return insert(User, {
    email: `${label}-${randomUUID()}@example.com`,
    name: label,
    passwordHash: "x",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
}

async function makeEmployee(companyId: string, name: string): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId,
    name,
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "Researcher",
    soulBody: "",
  });
}

beforeEach(async () => {
  await resetTestDb();
  owner = await makeUser("Owner");
  actingUser = owner;
  company = await insert(Company, { name: "Acme", slug: `acme-${randomUUID()}`, ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  ada = await makeEmployee(company.id, "Ada");
  grace = await makeEmployee(company.id, "Grace");
});

async function actAs(role: Role): Promise<void> {
  const user = await makeUser(role);
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  actingUser = user;
}

async function call<T = PublicModel>(
  method: string,
  employee: AIEmployee,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(
    `${baseUrl}/api/companies/${companyId}/employees/${employee.id}/models${path}`,
    {
      method,
      headers: {
        "x-test-user": actingUser.id,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const text = await response.text();
  for (const secret of [KEY_A, KEY_B, "apiKeyEncrypted", "configJson"]) {
    assert.ok(!text.includes(secret), `response leaked ${secret}`);
  }
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T, text };
}

async function companyModel(key: string, companyId = company.id, connected = true): Promise<AIModel> {
  return insert(AIModel, {
    companyId,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    configJson: connected ? writeApiKeys("{}", [newStoredApiKey(key, companyId)]) : "{}",
    connectedAt: connected ? new Date() : null,
  });
}

const audits = (action: string) => AppDataSource.getRepository(AuditEvent).findBy({ action });

describe("an employee's AI Models", () => {
  test("any Member reads them: the active one marked, and who else shares each", async () => {
    const shared = await companyModel(KEY_A);
    const own = await companyModel(KEY_B);
    await attachExistingModel({ employeeId: ada.id, modelId: shared.id, isActive: true });
    await attachExistingModel({ employeeId: grace.id, modelId: shared.id, isActive: true });
    await attachExistingModel({ employeeId: ada.id, modelId: own.id, isActive: false });
    await actAs("member");
    const listed = await call<PublicModel[]>("GET", ada, "");
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.map((model) => [model.id, model.isActive]),
      [
        [own.id, false],
        [shared.id, true],
      ],
    );
    const sharedEntry = listed.body.find((model) => model.id === shared.id)!;
    assert.deepEqual(
      sharedEntry.employees.map((user) => [user.name, user.isActive]),
      [
        ["Ada", true],
        ["Grace", true],
      ],
    );
    assert.deepEqual(
      sharedEntry.apiKeys.map((key) => key.preview),
      [maskSecret(KEY_A)],
    );
  });

  test("an employee with none lists nothing", async () => {
    await companyModel(KEY_A);
    assert.deepEqual((await call<PublicModel[]>("GET", ada, "")).body, []);
  });

  test("another company's employee is not found", async () => {
    const stranger = await makeUser("Stranger");
    const globex = await insert(Company, { name: "Globex", slug: `globex-${randomUUID()}`, ownerId: stranger.id });
    const outsider = await makeEmployee(globex.id, "Outsider");
    assert.equal((await call("GET", outsider, "")).status, 404);
  });
});

describe("attaching a company model to an employee", () => {
  test("puts the same model on the employee, active — nothing is copied", async () => {
    const shared = await companyModel(KEY_A);
    await attachExistingModel({ employeeId: grace.id, modelId: shared.id, isActive: true });
    const before = await AppDataSource.getRepository(AIModel).count();
    const attached = await call("POST", ada, "/attach", { modelId: shared.id });
    assert.equal(attached.status, 200, attached.text);
    assert.equal(attached.body.id, shared.id);
    assert.equal(attached.body.isActive, true);
    assert.deepEqual(
      attached.body.employees.map((user) => user.name),
      ["Ada", "Grace"],
    );
    assert.equal(await AppDataSource.getRepository(AIModel).count(), before);
    assert.equal((await getActiveModel(ada.id))?.id, shared.id);
    assert.equal((await getActiveModel(grace.id))?.id, shared.id);
    const [audit] = await audits("model.attach");
    assert.equal(audit.targetType, "employee");
    assert.equal(audit.targetId, ada.id);
  });

  test("attaching a model it already has only makes it active — never a second row", async () => {
    const first = await companyModel(KEY_A);
    const second = await companyModel(KEY_B);
    await call("POST", ada, "/attach", { modelId: first.id });
    await call("POST", ada, "/attach", { modelId: second.id });
    const again = await call("POST", ada, "/attach", { modelId: first.id });
    assert.equal(again.status, 200);
    assert.equal(await AppDataSource.getRepository(EmployeeModel).countBy({ employeeId: ada.id }), 2);
    assert.equal((await flaggedActiveModel(ada.id))?.id, first.id);
    assert.equal((await audits("model.activate")).length, 1);
  });

  test("makeActive false adds a standby and keeps the brain", async () => {
    const active = await companyModel(KEY_A);
    const standby = await companyModel(KEY_B);
    await call("POST", ada, "/attach", { modelId: active.id });
    const added = await call("POST", ada, "/attach", { modelId: standby.id, makeActive: false });
    assert.equal(added.status, 200);
    assert.equal(added.body.isActive, false);
    assert.equal((await flaggedActiveModel(ada.id))?.id, active.id);
  });

  test("refuses a model still waiting to connect", async () => {
    const waiting = await companyModel(KEY_A, company.id, false);
    const refused = await call<{ error: string }>("POST", ada, "/attach", { modelId: waiting.id });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /isn't connected yet/);
  });

  test("refuses another company's model exactly like one that does not exist", async () => {
    const stranger = await makeUser("Stranger");
    const globex = await insert(Company, { name: "Globex", slug: `globex-${randomUUID()}`, ownerId: stranger.id });
    const theirs = await companyModel(KEY_B, globex.id);
    const foreign = await call<{ error: string }>("POST", ada, "/attach", { modelId: theirs.id });
    const missing = await call<{ error: string }>("POST", ada, "/attach", { modelId: randomUUID() });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, missing.body);
    assert.equal(await AppDataSource.getRepository(EmployeeModel).count(), 0);
  });

  test("only owners and admins attach", async () => {
    const shared = await companyModel(KEY_A);
    await actAs("member");
    assert.equal((await call("POST", ada, "/attach", { modelId: shared.id })).status, 403);
    await actAs("admin");
    assert.equal((await call("POST", ada, "/attach", { modelId: shared.id })).status, 200);
  });

  test("validates the request", async () => {
    for (const body of [{}, { modelId: "nope" }, { modelId: randomUUID(), extra: 1 }]) {
      assert.equal((await call("POST", ada, "/attach", body)).status, 400);
    }
  });
});

describe("switching and detaching", () => {
  test("Make active switches to another attached model, and only an attached one", async () => {
    const first = await companyModel(KEY_A);
    const second = await companyModel(KEY_B);
    await attachExistingModel({ employeeId: ada.id, modelId: first.id, isActive: true });
    await attachExistingModel({ employeeId: ada.id, modelId: second.id, isActive: false });
    const switched = await call("POST", ada, `/${second.id}/activate`);
    assert.equal(switched.status, 200);
    assert.equal(switched.body.isActive, true);
    assert.equal((await flaggedActiveModel(ada.id))?.id, second.id);
    const notHers = await companyModel(KEY_A);
    assert.equal((await call("POST", ada, `/${notHers.id}/activate`)).status, 404);
    assert.equal((await flaggedActiveModel(ada.id))?.id, second.id);
  });

  test("detaching never deletes the company's model or anyone else's use of it", async () => {
    const shared = await companyModel(KEY_A);
    await attachExistingModel({ employeeId: ada.id, modelId: shared.id, isActive: true });
    await attachExistingModel({ employeeId: grace.id, modelId: shared.id, isActive: true });
    const pinned = await insert(Routine, {
      employeeId: ada.id,
      name: "Nightly",
      slug: `nightly-${randomUUID().slice(0, 8)}`,
      cronExpr: "0 3 * * *",
      modelId: shared.id,
    });
    const detached = await call<{ ok: boolean }>("DELETE", ada, `/${shared.id}`);
    assert.equal(detached.status, 200);
    assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: shared.id }));
    assert.equal(await getActiveModel(ada.id), null);
    assert.equal((await getActiveModel(grace.id))?.id, shared.id);
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: pinned.id })).modelId,
      null,
    );
    assert.equal((await audits("model.detach"))[0].targetId, ada.id);
    // Detaching from the last employee keeps it too: it waits in Settings → AI Models.
    assert.equal((await call("DELETE", grace, `/${shared.id}`)).status, 200);
    assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: shared.id }));
  });

  test("the employee's next most recently attached model takes over", async () => {
    const older = await companyModel(KEY_A);
    const active = await companyModel(KEY_B);
    await attachExistingModel({ employeeId: ada.id, modelId: older.id, isActive: false });
    await attachExistingModel({ employeeId: ada.id, modelId: active.id, isActive: true });
    await call("DELETE", ada, `/${active.id}`);
    assert.equal((await flaggedActiveModel(ada.id))?.id, older.id);
  });

  test("a model the employee doesn't use is not found", async () => {
    const shared = await companyModel(KEY_A);
    await attachExistingModel({ employeeId: grace.id, modelId: shared.id, isActive: true });
    assert.equal((await call("DELETE", ada, `/${shared.id}`)).status, 404);
    assert.equal((await getActiveModel(grace.id))?.id, shared.id);
  });

  test("only owners and admins switch or detach", async () => {
    const shared = await companyModel(KEY_A);
    await attachExistingModel({ employeeId: ada.id, modelId: shared.id, isActive: true });
    await actAs("member");
    assert.equal((await call("POST", ada, `/${shared.id}/activate`)).status, 403);
    assert.equal((await call("DELETE", ada, `/${shared.id}`)).status, 403);
    assert.equal((await getActiveModel(ada.id))?.id, shared.id);
  });
});
