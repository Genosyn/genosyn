import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeeSurfaceRouter } from "./employeeSurface.js";

let server: Server;
let baseUrl: string;
let company: Company;
let employee: AIEmployee;
let owner: User;
let admin: User;
let member: User;
let legacy: Conversation;
let legacyWorking: ConversationMessage;
let bearer = "";

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    (req as unknown as { session: Record<string, unknown> | null }).session = userId
      ? {
          userId,
          sessionVersion: 0,
          authenticatedAt: Number(req.header("x-test-authenticated-at") ?? "0") || undefined,
        }
      : {};
    next();
  });
  app.use("/api/companies/:cid/employees", employeeSurfaceRouter);
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
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  admin = await insert(User, {
    email: "admin@example.com",
    name: "Admin",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Analyst",
    slug: "analyst",
    role: "Analyst",
    soulBody: "",
  });
  legacy = await insert(Conversation, {
    employeeId: employee.id,
    ownerUserId: null,
    title: "Before private conversations",
    archivedAt: null,
    source: "web",
    externalKey: null,
    connectionId: null,
  });
  await insert(ConversationMessage, {
    conversationId: legacy.id,
    role: "user",
    content: "Legacy request",
    status: null,
  });
  legacyWorking = await insert(ConversationMessage, {
    conversationId: legacy.id,
    role: "assistant",
    content: "",
    status: "working",
    progressPercent: 30,
    progressLabel: "Working",
    turnRequesterUserId: null,
    turnWorkerId: "pre-upgrade-worker",
    turnLeaseExpiresAt: new Date(Date.now() + 60_000),
  });

  const tokenBody = "C".repeat(43);
  await insert(ApiKey, {
    userId: owner.id,
    companyId: company.id,
    name: "automation",
    prefix: tokenBody.slice(0, 8),
    tokenHash: hashApiToken(tokenBody),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  });
  bearer = `gen_${tokenBody}`;
});

async function call(
  method: string,
  suffix: string,
  options: { user?: User; bearer?: string; authenticatedAt?: number; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (options.user) headers["x-test-user"] = options.user.id;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.authenticatedAt) {
    headers["x-test-authenticated-at"] = String(options.authenticatedAt);
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/employees/${employee.id}${suffix}`,
    {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("legacy direct-conversation ownership", () => {
  test("owners/admins may list and inspect unclaimed web history while Members fail closed", async () => {
    const ownerList = await call("GET", "/conversations", { user: owner });
    assert.equal(ownerList.status, 200);
    assert.deepEqual(
      (ownerList.body as unknown as Array<{ id: string; legacyUnclaimed: boolean }>).map((row) => ({
        id: row.id,
        legacyUnclaimed: row.legacyUnclaimed,
      })),
      [{ id: legacy.id, legacyUnclaimed: true }],
    );
    assert.equal((await call("GET", `/conversations/${legacy.id}`, { user: admin })).status, 200);

    const memberList = await call("GET", "/conversations", { user: member });
    assert.equal(memberList.status, 200);
    assert.deepEqual(memberList.body, []);
    assert.equal((await call("GET", `/conversations/${legacy.id}`, { user: member })).status, 404);
  });

  test("claim is browser-only, role-bound, recent, atomic, and does not elevate a legacy working turn", async () => {
    assert.equal((await call("GET", "/conversations", { bearer })).status, 403);
    assert.equal(
      (
        await call("POST", `/conversations/${legacy.id}/claim`, {
          user: member,
          authenticatedAt: Date.now(),
        })
      ).status,
      403,
    );

    const stale = await call("POST", `/conversations/${legacy.id}/claim`, {
      user: admin,
      authenticatedAt: Date.now() - 16 * 60_000,
    });
    assert.equal(stale.status, 403);
    assert.equal(stale.body.code, "REAUTHENTICATION_REQUIRED");

    const claimed = await call("POST", `/conversations/${legacy.id}/claim`, {
      user: admin,
      authenticatedAt: Date.now(),
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.legacyUnclaimed, false);
    assert.equal(
      (await AppDataSource.getRepository(Conversation).findOneByOrFail({ id: legacy.id }))
        .ownerUserId,
      admin.id,
    );

    const terminal = await AppDataSource.getRepository(ConversationMessage).findOneByOrFail({
      id: legacyWorking.id,
    });
    assert.equal(terminal.status, "error");
    assert.equal(terminal.turnRequesterUserId, null);
    assert.equal(terminal.turnWorkerId, null);
    assert.equal(terminal.turnLeaseExpiresAt, null);
    assert.match(terminal.content, /original Member authority was not recorded/);

    const losingClaim = await call("POST", `/conversations/${legacy.id}/claim`, {
      user: owner,
      authenticatedAt: Date.now(),
    });
    assert.equal(losingClaim.status, 409);
    assert.equal((await call("GET", `/conversations/${legacy.id}`, { user: member })).status, 404);
  });
});
