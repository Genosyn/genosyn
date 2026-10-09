import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { DEFAULT_DECISION_STACK_INSTRUCTIONS } from "../../shared/decisionStackInstructions.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { decisionStackSettingsRouter } from "./decisionStackSettings.js";

/**
 * Decision stack → Settings over HTTP: every Member reads, owners and admins
 * change, every body is checked by zod at the door and the service's precise
 * limits come back as one sentence, and one company can never read or write
 * another's.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let other: Company;
const users: Record<Role, User> = {} as Record<Role, User>;
let outsider: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", decisionStackSettingsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, {
    email: "founder@example.test",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  other = await insert(Company, { name: "Globex", slug: "globex", ownerId: founder.id });
  for (const role of ["owner", "admin", "member"] as Role[]) {
    users[role] = await insert(User, {
      email: `${role}@example.test`,
      name: role,
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: users[role].id, role });
  }
  // An admin of the other company only.
  outsider = await insert(User, {
    email: "outsider@example.test",
    name: "Outsider",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: other.id, userId: outsider.id, role: "admin" });
  actingUserId = users.admin.id;
});

type Settings = {
  enabled: boolean;
  instructions: string;
  usingDefaultInstructions: boolean;
  pendingDecisions: number;
  canManage: boolean;
};

async function call<T = Record<string, unknown>>(
  method: string,
  body?: unknown,
  companyId = company.id,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}/decision-stack/settings`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const row = () => AppDataSource.getRepository(Company).findOneByOrFail({ id: company.id });

describe("reading", () => {
  for (const role of ["owner", "admin", "member"] as Role[]) {
    test(`a ${role} reads the defaults, and whether they can change them`, async () => {
      actingUserId = users[role].id;
      const response = await call<Settings>("GET");
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        enabled: true,
        instructions: DEFAULT_DECISION_STACK_INSTRUCTIONS,
        usingDefaultInstructions: true,
        pendingDecisions: 0,
        canManage: role !== "member",
      });
    });
  }

  test("counts the questions still waiting", async () => {
    await insert(Decision, {
      companyId: company.id,
      employeeId: "emp-1",
      title: "Waiting",
      body: "",
      optionsJson: "[]",
      status: "pending",
      urgency: "normal",
    });
    assert.equal((await call<Settings>("GET")).body.pendingDecisions, 1);
  });

  test("needs a signed-in Member of this company", async () => {
    actingUserId = null;
    assert.equal((await call("GET")).status, 401);
    actingUserId = outsider.id;
    assert.equal((await call("GET")).status, 403);
  });
});

describe("changing", () => {
  test("an admin switches it off, and the row and the answer agree", async () => {
    const response = await call<Settings>("PATCH", { enabled: false });
    assert.equal(response.status, 200);
    assert.equal(response.body.enabled, false);
    assert.equal(response.body.canManage, true);
    assert.equal((await row()).decisionStackEnabled, false);
    assert.equal((await call<Settings>("GET")).body.enabled, false);
  });

  test("an owner can too, and can switch it back on", async () => {
    actingUserId = users.owner.id;
    assert.equal((await call<Settings>("PATCH", { enabled: false })).body.enabled, false);
    assert.equal((await call<Settings>("PATCH", { enabled: true })).body.enabled, true);
    assert.equal((await row()).decisionStackEnabled, true);
  });

  test("a Member cannot change either part, and nothing is written or audited", async () => {
    actingUserId = users.member.id;
    for (const body of [{ enabled: false }, { instructions: "Ask about everything." }, { instructions: null }]) {
      const response = await call("PATCH", body);
      assert.equal(response.status, 403, JSON.stringify(body));
    }
    const current = await row();
    assert.equal(current.decisionStackEnabled, true);
    assert.equal(current.decisionStackInstructions, null);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).count({
        where: { action: "decision.stack.settings" },
      }),
      0,
    );
  });

  test("an admin of another company cannot change this one", async () => {
    actingUserId = outsider.id;
    assert.equal((await call("PATCH", { enabled: false })).status, 403);
    assert.equal((await row()).decisionStackEnabled, true);
  });

  test("not signed in is a 401", async () => {
    actingUserId = null;
    assert.equal((await call("PATCH", { enabled: false })).status, 401);
  });

  test("save, read back, clear and restore the instructions", async () => {
    const saved = await call<Settings>("PATCH", {
      instructions: "Only ask about money.  \r\nNever about labels.\n\n",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.instructions, "Only ask about money.\nNever about labels.");
    assert.equal(saved.body.usingDefaultInstructions, false);
    assert.equal((await row()).decisionStackInstructions, "Only ask about money.\nNever about labels.");

    actingUserId = users.member.id;
    assert.equal(
      (await call<Settings>("GET")).body.instructions,
      "Only ask about money.\nNever about labels.",
    );
    actingUserId = users.admin.id;

    const cleared = await call<Settings>("PATCH", { instructions: "" });
    assert.equal(cleared.body.instructions, "");
    assert.equal(cleared.body.usingDefaultInstructions, false);
    assert.equal((await row()).decisionStackInstructions, "");

    const restored = await call<Settings>("PATCH", { instructions: null });
    assert.equal(restored.body.instructions, DEFAULT_DECISION_STACK_INSTRUCTIONS);
    assert.equal(restored.body.usingDefaultInstructions, true);
    assert.equal((await row()).decisionStackInstructions, null);
  });

  test("both parts in one request", async () => {
    const response = await call<Settings>("PATCH", {
      enabled: false,
      instructions: "Ask about hiring.",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.enabled, false);
    assert.equal(response.body.instructions, "Ask about hiring.");
  });

  test("the service's limits come back as one sentence the box can show, changing nothing", async () => {
    const refusals: Array<[unknown, string]> = [
      [{ instructions: "a".repeat(4_001) }, "Keep the instructions under 4,000 characters."],
      [
        { instructions: Array.from({ length: 31 }, (_, index) => `Rule ${index}`).join("\n") },
        "Keep it to 30 instructions or fewer, one per line.",
      ],
      [{ instructions: "Ask\u0007 me", enabled: false }, "Instructions can only contain printable characters."],
    ];
    for (const [body, error] of refusals) {
      const response = await call("PATCH", body);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error });
    }
    const current = await row();
    assert.equal(current.decisionStackEnabled, true);
    assert.equal(current.decisionStackInstructions, null);
  });

  test("zod refuses malformed bodies at the door", async () => {
    const bodies: unknown[] = [
      {},
      { enabled: "false" },
      { enabled: 0 },
      { instructions: 42 },
      { instructions: ["a"] },
      { enabled: false, extra: true },
      { instructions: "x".repeat(16_001) },
      [],
    ];
    for (const body of bodies) {
      const response = await call<{ error: string }>("PATCH", body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(response.body.error, "ValidationError");
    }
    const current = await row();
    assert.equal(current.decisionStackEnabled, true);
    assert.equal(current.decisionStackInstructions, null);
  });

  test("a company id that is not a uuid is refused", async () => {
    const response = await call("GET", undefined, "acme");
    assert.ok(response.status === 400 || response.status === 403, String(response.status));
  });

  test("every change is in the audit log under the person who made it", async () => {
    await call("PATCH", { enabled: false });
    await call("PATCH", { instructions: "Ask about hiring." });
    const rows = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id, action: "decision.stack.settings" },
      order: { createdAt: "ASC" },
    });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((entry) => entry.actorUserId === users.admin.id));
    assert.equal(JSON.parse(rows[1].metadataJson).instructions, "Ask about hiring.");
  });

  test("the other company's settings never move", async () => {
    await call("PATCH", { enabled: false, instructions: "Ask about hiring." });
    const untouched = await AppDataSource.getRepository(Company).findOneByOrFail({ id: other.id });
    assert.equal(untouched.decisionStackEnabled, true);
    assert.equal(untouched.decisionStackInstructions, null);
  });
});
