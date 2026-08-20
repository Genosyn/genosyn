import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { EmployeeMemberBrowserGrant } from "../db/entities/EmployeeMemberBrowserGrant.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { hashToken } from "../lib/token.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { normalizePairingCode } from "../services/memberBrowsers.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { memberBrowsersRouter } from "./memberBrowsers.js";

/**
 * A Member browser is a channel into a human's own computer, so this surface
 * is scoped harder than the rest of the company API: not by role, but by who
 * owns the machine. These tests hold that line at the route seam.
 */

let server: Server;
let baseUrl = "";
let company: Company;
let owner: User;
let colleague: User;
let employee: AIEmployee;
let bearer = "";

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    (req as unknown as { session: Record<string, unknown> | null }).session = userId
      ? { userId, sessionVersion: 0, authenticatedAt: Date.now() }
      : {};
    next();
  });
  app.use("/api/companies/:cid/member-browsers", memberBrowsersRouter);
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
  [owner, colleague] = await Promise.all([
    insert(User, {
      email: `browser-owner-${randomUUID()}@example.com`,
      name: "Browser Owner",
      passwordHash: "x",
      sessionVersion: 0,
    }),
    insert(User, {
      email: `browser-colleague-${randomUUID()}@example.com`,
      name: "Colleague",
      passwordHash: "x",
      sessionVersion: 0,
    }),
  ]);
  company = await insert(Company, {
    name: "Member Browser Company",
    slug: `member-browsers-${randomUUID()}`,
    ownerId: owner.id,
  });
  await Promise.all([
    insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" }),
    // Deliberately an admin: the isolation below must not depend on role.
    insert(Membership, { companyId: company.id, userId: colleague.id, role: "admin" }),
  ]);
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Operator",
    slug: `operator-${randomUUID()}`,
    role: "Operations",
    browserEnabled: true,
  });
  const tokenBody = "B".repeat(43);
  await insert(ApiKey, {
    userId: owner.id,
    companyId: company.id,
    name: "automation",
    prefix: tokenBody.slice(0, 8),
    tokenHash: hashApiToken(tokenBody),
  });
  bearer = `gen_${tokenBody}`;
});

type CallOptions = { as?: User; apiKey?: boolean; body?: unknown };

async function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.apiKey) headers.authorization = `Bearer ${bearer}`;
  else headers["x-test-user"] = (options.as ?? owner).id;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/member-browsers${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body:
      text && contentType.includes("application/json")
        ? (JSON.parse(text) as Record<string, unknown>)
        : { raw: text },
  };
}

async function createBrowser(as: User, name = "Chrome on my laptop") {
  const response = await call("POST", "/", {
    as,
    body: { name, allowedHosts: "example.com" },
  });
  assert.equal(response.status, 201);
  return response.body as { id: string; pairingCode: string };
}

describe("member browsers refuse machine credentials", () => {
  test("every route answers an API key with 403 rather than acting on it", async () => {
    const mine = await createBrowser(owner);
    const conversation = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: owner.id,
    });
    const requests: Array<[string, string, unknown?]> = [
      ["GET", "/"],
      ["POST", "/", { name: "Key browser" }],
      ["PATCH", `/${mine.id}`, { name: "Renamed" }],
      ["POST", `/${mine.id}/pairing-code`],
      ["DELETE", `/${mine.id}`],
      ["GET", `/${mine.id}/grants`],
      ["POST", `/${mine.id}/grants`, { employeeId: employee.id }],
      ["DELETE", `/${mine.id}/grants/${employee.id}`],
      ["GET", `/for-employee/${employee.id}`],
      ["POST", `/select/${conversation.id}`, { memberBrowserId: mine.id }],
    ];

    for (const [method, path, body] of requests) {
      const response = await call(method, path, { apiKey: true, body });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.match(String(response.body.error), /logged-in Member/i);
    }

    // Nothing an API key touched may have taken effect.
    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: mine.id,
    });
    assert.equal(stored.name, "Chrome on my laptop");
    assert.equal(stored.revokedAt, null);
    assert.equal(await AppDataSource.getRepository(MemberBrowser).countBy({}), 1);
    assert.equal(await AppDataSource.getRepository(EmployeeMemberBrowserGrant).countBy({}), 0);
  });
});

describe("one Member's browser is invisible to another", () => {
  test("a colleague cannot see, patch, revoke, or grant somebody else's machine", async () => {
    const mine = await createBrowser(owner);

    // 404, never 403: an existence-revealing status on a colleague's laptop is
    // itself a disclosure, and company role deliberately buys nothing here.
    const requests: Array<[string, string, unknown?]> = [
      ["PATCH", `/${mine.id}`, { name: "Renamed by a colleague" }],
      ["POST", `/${mine.id}/pairing-code`],
      ["DELETE", `/${mine.id}`],
      ["GET", `/${mine.id}/grants`],
      ["POST", `/${mine.id}/grants`, { employeeId: employee.id }],
      ["DELETE", `/${mine.id}/grants/${employee.id}`],
    ];
    for (const [method, path, body] of requests) {
      const response = await call(method, path, { as: colleague, body });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(response.body.error, "Browser not found");
    }

    const listed = await call("GET", "/", { as: colleague });
    assert.deepEqual(listed.body, []);

    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: mine.id,
    });
    assert.equal(stored.name, "Chrome on my laptop");
    assert.equal(stored.revokedAt, null);
  });

  test("the chat picker only ever offers the caller's own machines", async () => {
    const mine = await createBrowser(owner);
    await call("POST", `/${mine.id}/grants`, { as: owner, body: { employeeId: employee.id } });

    const forOwner = (await call("GET", `/for-employee/${employee.id}`, { as: owner }))
      .body as unknown as Array<{ id: string }>;
    assert.deepEqual(
      forOwner.map((row) => row.id),
      [mine.id],
    );

    // The grant is company-wide; the machine is not. A colleague chatting with
    // the same employee must not be offered the owner's browser.
    const forColleague = (await call("GET", `/for-employee/${employee.id}`, { as: colleague }))
      .body as unknown as unknown[];
    assert.deepEqual(forColleague, []);
  });
});

describe("pairing codes over the wire", () => {
  test("the create response carries the code once and the row keeps only a hash", async () => {
    const created = await createBrowser(owner);
    assert.match(created.pairingCode, /^[0-9a-f]{8}(-[0-9a-f]{1,8})+$/);

    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: created.id,
    });
    assert.equal(stored.pairingCodeHash, hashToken(normalizePairingCode(created.pairingCode)));
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(created.pairingCode));

    // Every later read of the same row is code-free — the plaintext exists in
    // exactly one HTTP response and nowhere else.
    const listed = (await call("GET", "/", { as: owner })).body as unknown as Array<
      Record<string, unknown>
    >;
    assert.equal(listed.length, 1);
    assert.equal("pairingCode" in listed[0]!, false);
    assert.equal(listed[0]!.tokenPrefix, null);
    const patched = await call("PATCH", `/${created.id}`, { as: owner, body: { name: "Renamed" } });
    assert.equal("pairingCode" in patched.body, false);
  });

  test("regenerating hands back a different code, once", async () => {
    const created = await createBrowser(owner);
    const regenerated = await call("POST", `/${created.id}/pairing-code`, { as: owner });

    assert.equal(regenerated.status, 200);
    assert.notEqual(regenerated.body.pairingCode, created.pairingCode);
    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: created.id,
    });
    assert.equal(
      stored.pairingCodeHash,
      hashToken(normalizePairingCode(String(regenerated.body.pairingCode))),
    );
  });
});

describe("Routine recording consent", () => {
  test("legacy unattended use is off until the owner explicitly re-consents", async () => {
    const created = await createBrowser(owner);
    await AppDataSource.getRepository(MemberBrowser).update(
      { id: created.id },
      { allowUnattended: true, routineRecordingConsentAt: null },
    );

    const legacy = (await call("GET", "/", { as: owner })).body as unknown as Array<{
      allowUnattended: boolean;
      routineRecordingConsentAt: string | null;
      routineRecordingConsentRequired: boolean;
    }>;
    assert.equal(legacy[0]?.allowUnattended, false);
    assert.equal(legacy[0]?.routineRecordingConsentAt, null);
    assert.equal(legacy[0]?.routineRecordingConsentRequired, true);

    const consented = await call("PATCH", `/${created.id}`, {
      as: owner,
      body: { allowUnattended: true },
    });
    assert.equal(consented.status, 200);
    assert.equal(consented.body.allowUnattended, true);
    assert.equal(typeof consented.body.routineRecordingConsentAt, "string");
    assert.equal(consented.body.routineRecordingConsentRequired, false);
    assert.ok(
      (await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({ id: created.id }))
        .routineRecordingConsentAt,
    );

    await call("PATCH", `/${created.id}`, {
      as: owner,
      body: { allowUnattended: false },
    });
    const disabled = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: created.id,
    });
    assert.equal(disabled.allowUnattended, false);
    assert.equal(disabled.routineRecordingConsentAt, null);
  });
});

describe("choosing a browser for a conversation", () => {
  test("a thread belonging to another Member cannot be pointed at any browser", async () => {
    const mine = await createBrowser(owner);
    const theirThread = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: colleague.id,
    });

    const response = await call("POST", `/select/${theirThread.id}`, {
      as: owner,
      body: { memberBrowserId: mine.id },
    });

    assert.equal(response.status, 403);
    assert.equal(
      (await AppDataSource.getRepository(Conversation).findOneByOrFail({ id: theirThread.id }))
        .memberBrowserId,
      null,
    );
  });

  test("a Member cannot point their own thread at a browser they do not own", async () => {
    const theirs = await createBrowser(colleague);
    const myThread = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: owner.id,
    });

    const response = await call("POST", `/select/${myThread.id}`, {
      as: owner,
      body: { memberBrowserId: theirs.id },
    });

    assert.equal(response.status, 404);
    assert.equal(
      (await AppDataSource.getRepository(Conversation).findOneByOrFail({ id: myThread.id }))
        .memberBrowserId,
      null,
    );
  });

  test("the owner may select their own browser and clear it again", async () => {
    const mine = await createBrowser(owner);
    const myThread = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: owner.id,
    });
    const repo = AppDataSource.getRepository(Conversation);

    const selected = await call("POST", `/select/${myThread.id}`, {
      as: owner,
      body: { memberBrowserId: mine.id },
    });
    assert.equal(selected.status, 200);
    assert.equal((await repo.findOneByOrFail({ id: myThread.id })).memberBrowserId, mine.id);

    const cleared = await call("POST", `/select/${myThread.id}`, {
      as: owner,
      body: { memberBrowserId: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal((await repo.findOneByOrFail({ id: myThread.id })).memberBrowserId, null);
  });
});

describe("granting a browser to an AI Employee", () => {
  test("an employee from another company is not found and gains no grant", async () => {
    const mine = await createBrowser(owner);
    const otherCompany = await insert(Company, {
      name: "Other Co",
      slug: `other-co-${randomUUID()}`,
      ownerId: owner.id,
    });
    const outsider = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Outsider",
      slug: `outsider-${randomUUID()}`,
      role: "Operations",
    });

    const response = await call("POST", `/${mine.id}/grants`, {
      as: owner,
      body: { employeeId: outsider.id },
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error, "AI Employee not found");
    assert.equal(await AppDataSource.getRepository(EmployeeMemberBrowserGrant).countBy({}), 0);
  });

  test("granting twice is a no-op and revoking removes the row", async () => {
    const mine = await createBrowser(owner);
    const grantRepo = AppDataSource.getRepository(EmployeeMemberBrowserGrant);

    for (const _attempt of [1, 2]) {
      const response = await call("POST", `/${mine.id}/grants`, {
        as: owner,
        body: { employeeId: employee.id },
      });
      assert.equal(response.status, 201);
    }
    assert.equal(await grantRepo.countBy({ memberBrowserId: mine.id }), 1);

    const listed = (await call("GET", `/${mine.id}/grants`, { as: owner }))
      .body as unknown as Array<{ employeeId: string }>;
    assert.deepEqual(
      listed.map((row) => row.employeeId),
      [employee.id],
    );

    const revoked = await call("DELETE", `/${mine.id}/grants/${employee.id}`, { as: owner });
    assert.equal(revoked.status, 200);
    assert.equal(await grantRepo.countBy({ memberBrowserId: mine.id }), 0);
  });
});
