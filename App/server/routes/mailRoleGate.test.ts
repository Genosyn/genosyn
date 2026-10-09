import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import {
  EmployeeMailAccountGrant,
  type MailAccessLevel,
} from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mailRouter } from "./mail.js";

/**
 * Who may decide what AI Employees can do with a company mailbox.
 *
 * The router runs for real over an in-memory database; only the cookie session
 * is faked, by a middleware that stamps `req.session` the way `cookie-session`
 * would. The subject is guard *scoping* — which paths and methods the admin
 * gate covers — and that is invisible to a service test, because the services
 * write a Grant for anyone who calls them. Deciding who may call them is this
 * layer's job.
 *
 * The regression this file exists for: the mailbox AI-access routes were
 * guarded by nothing but company membership, so a plain Member with a terminal
 * could grant an AI Employee `send` on the company's mailbox. Every sibling
 * AI-access surface (Revenue, Meetings, Signatures, Marketing, Finance) is
 * owner/admin. A Member could also disconnect the mailbox, which deletes every
 * Grant and leaves the Google connector's `gmail_*` tools answering to the
 * Connection Grant alone.
 */

let server: Server;
let baseUrl: string;

/** Whose session the next request carries. Mutated per test. */
let actingUserId: string | null = null;

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
  app.use("/api/companies/:cid", mailRouter);
  // A sibling mounted after the mail router at the same prefix, the way
  // `server/index.ts` mounts a dozen of them. An unscoped admin guard on the
  // mail router would reach it too.
  const sibling = express.Router({ mergeParams: true });
  sibling.post("/sibling-feature", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/companies/:cid", sibling);
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

let companyId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let account: MailAccount;
let employee: AIEmployee;

beforeEach(async () => {
  await resetTestDb();
  const aUser = (who: string) =>
    insert(User, {
      email: `mail-${who}-${randomUUID()}@example.com`,
      name: who,
      passwordHash: "x",
      sessionVersion: 0,
    });
  const owner = await aUser("owner");
  const admin = await aUser("admin");
  const member = await aUser("member");
  const company = await insert(Company, {
    name: "Northwind Mail",
    slug: `mail-roles-${randomUUID()}`,
    ownerId: owner.id,
  });
  ownerId = owner.id;
  adminId = admin.id;
  memberId = member.id;
  companyId = company.id;
  await insert(Membership, { companyId, userId: ownerId, role: "owner" as Role });
  await insert(Membership, { companyId, userId: adminId, role: "admin" as Role });
  await insert(Membership, { companyId, userId: memberId, role: "member" as Role });
  // No Connection behind it: every route here only touches the local rows.
  account = await insert(MailAccount, {
    companyId,
    connectionId: randomUUID(),
    provider: "gmail",
    address: "support@northwind.example",
    status: "active",
    createdByUserId: ownerId,
  });
  employee = await insert(AIEmployee, {
    companyId,
    name: "Iris",
    slug: `iris-${randomUUID()}`,
    role: "Support lead",
  });
  actingUserId = ownerId;
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

function grantsPath(): string {
  return `/mail/accounts/${account.id}/grants`;
}

async function aGrant(accessLevel: MailAccessLevel): Promise<EmployeeMailAccountGrant> {
  return insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel,
  });
}

/** Every Grant on the mailbox, as `[employeeId, level]` pairs. */
async function grantLevels(): Promise<Array<[string, MailAccessLevel]>> {
  const rows = await AppDataSource.getRepository(EmployeeMailAccountGrant).find();
  return rows.map((row) => [row.employeeId, row.accessLevel]);
}

describe("mail routes — AI access is admin-only", () => {
  test("any member may see who has access, and who could be given it", async () => {
    await aGrant("draft");
    actingUserId = memberId;

    const list = await call<{ direct: Array<{ employeeId: string; accessLevel: string }> }>(
      "GET",
      grantsPath(),
    );
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.direct.map((grant) => [grant.employeeId, grant.accessLevel]),
      [[employee.id, "draft"]],
    );

    const candidates = await call<{ candidates: Array<{ id: string; alreadyGranted: boolean }> }>(
      "GET",
      `/mail/accounts/${account.id}/grant-candidates`,
    );
    assert.equal(candidates.status, 200);
    assert.deepEqual(
      candidates.body.candidates.map((candidate) => [candidate.id, candidate.alreadyGranted]),
      [[employee.id, true]],
    );
  });

  test("a plain member cannot grant an AI Employee access, at any level", async () => {
    actingUserId = memberId;
    for (const accessLevel of ["read", "draft", "send"] as const) {
      const res = await call<{ error: string }>("POST", grantsPath(), {
        employeeId: employee.id,
        accessLevel,
      });
      assert.equal(res.status, 403, accessLevel);
      assert.equal(res.body.error, "admin company role required");
    }
    // The point of the guard: nothing was written on the way to the 403.
    assert.deepEqual(await grantLevels(), []);
  });

  test("an admin can grant, and an owner can too", async () => {
    actingUserId = adminId;
    const granted = await call<{ grant: { employeeId: string; accessLevel: string } }>(
      "POST",
      grantsPath(),
      { employeeId: employee.id, accessLevel: "send" },
    );
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.grant.employeeId, employee.id);
    assert.equal(granted.body.grant.accessLevel, "send");

    // POST is an upsert, so the owner lowering the level is the same route.
    actingUserId = ownerId;
    const lowered = await call<{ grant: { accessLevel: string } }>("POST", grantsPath(), {
      employeeId: employee.id,
      accessLevel: "read",
    });
    assert.equal(lowered.status, 200);
    assert.equal(lowered.body.grant.accessLevel, "read");
    assert.deepEqual(await grantLevels(), [[employee.id, "read"]]);
  });

  test("a plain member cannot raise a Grant to send", async () => {
    const grant = await aGrant("draft");

    actingUserId = memberId;
    const forbidden = await call("PATCH", `${grantsPath()}/${grant.id}`, { accessLevel: "send" });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await grantLevels(), [[employee.id, "draft"]]);

    actingUserId = adminId;
    const raised = await call<{ grant: { accessLevel: string } }>(
      "PATCH",
      `${grantsPath()}/${grant.id}`,
      { accessLevel: "send" },
    );
    assert.equal(raised.status, 200);
    assert.equal(raised.body.grant.accessLevel, "send");
    assert.deepEqual(await grantLevels(), [[employee.id, "send"]]);
  });

  test("a plain member cannot revoke a Grant either", async () => {
    const grant = await aGrant("send");

    actingUserId = memberId;
    const forbidden = await call("DELETE", `${grantsPath()}/${grant.id}`);
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await grantLevels(), [[employee.id, "send"]]);

    actingUserId = ownerId;
    const revoked = await call<{ ok: boolean }>("DELETE", `${grantsPath()}/${grant.id}`);
    assert.equal(revoked.status, 200);
    assert.deepEqual(await grantLevels(), []);
  });

  test("respelling the path does not get a member past the gate", async () => {
    // Express routes these to the same handlers — it matches paths without
    // regard to case and ignores a trailing slash — so the guard must too.
    const grant = await aGrant("read");
    actingUserId = memberId;

    const shouted = await call("POST", `/MAIL/ACCOUNTS/${account.id}/GRANTS`, {
      employeeId: employee.id,
      accessLevel: "send",
    });
    assert.equal(shouted.status, 403);
    const slashed = await call("POST", `${grantsPath()}/`, {
      employeeId: employee.id,
      accessLevel: "send",
    });
    assert.equal(slashed.status, 403);
    const mixed = await call("PATCH", `/mail/accounts/${account.id}/Grants/${grant.id}/`, {
      accessLevel: "send",
    });
    assert.equal(mixed.status, 403);

    assert.deepEqual(await grantLevels(), [[employee.id, "read"]]);
  });
});

describe("mail routes — connecting and disconnecting a mailbox is admin-only", () => {
  test("a plain member cannot disconnect a mailbox", async () => {
    await aGrant("draft");

    actingUserId = memberId;
    const forbidden = await call("DELETE", `/mail/accounts/${account.id}`);
    assert.equal(forbidden.status, 403);
    assert.ok(
      await AppDataSource.getRepository(MailAccount).findOneBy({ id: account.id }),
      "the mailbox should survive a member's disconnect",
    );
    // The Grants are what keep the `gmail_*` tools in line; they survive too.
    assert.deepEqual(await grantLevels(), [[employee.id, "draft"]]);

    actingUserId = adminId;
    const allowed = await call("DELETE", `/mail/accounts/${account.id}`);
    assert.equal(allowed.status, 200);
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
    assert.deepEqual(await grantLevels(), []);
  });

  test("a plain member cannot link an existing Connection as a mailbox", async () => {
    actingUserId = memberId;
    const forbidden = await call("POST", "/mail/accounts", { connectionId: randomUUID() });
    assert.equal(forbidden.status, 403);
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 1);

    // An admin is past the guard: the 400 comes from the absent Connection,
    // not from authorization.
    actingUserId = adminId;
    const allowed = await call<{ error: string }>("POST", "/mail/accounts", {
      connectionId: randomUUID(),
    });
    assert.equal(allowed.status, 400);
    assert.equal(allowed.body.error, "Connection not found");
  });
});

/**
 * The other half of the guard. Working the inbox stays open to every Member,
 * and none of it can widen what an AI Employee may do. These are silent
 * failures: a member just finds a control stops working. So they get
 * assertions rather than a comment.
 */
describe("mail routes — the admin gate stays scoped", () => {
  test("a member may still pause sync", async () => {
    // The same route carries resume and the sender name; `mailSenderName.test.ts`
    // covers a member renaming the mailbox.
    actingUserId = memberId;
    const paused = await call<{ account: { status: string } }>(
      "PATCH",
      `/mail/accounts/${account.id}`,
      { status: "paused" },
    );
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.account.status, "paused");
  });

  test("a member may change AI analysis, but only among employees already granted", async () => {
    actingUserId = memberId;
    const off = await call<{ account: { aiAnalysisEnabled: boolean } }>(
      "PATCH",
      `/mail/accounts/${account.id}/ai-analysis`,
      { enabled: false },
    );
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.account.aiAnalysisEnabled, false);

    // Naming an employee nobody granted cannot be a back door to access.
    const ungranted = await call<{ error: string }>(
      "PATCH",
      `/mail/accounts/${account.id}/ai-analysis`,
      { enabled: true, employeeId: employee.id },
    );
    assert.equal(ungranted.status, 400);
    assert.match(ungranted.body.error, /Grant it under AI access first/);
    assert.deepEqual(await grantLevels(), []);

    await aGrant("read");
    const chosen = await call<{ account: { aiAnalysisEmployeeId: string | null } }>(
      "PATCH",
      `/mail/accounts/${account.id}/ai-analysis`,
      { enabled: true, employeeId: employee.id },
    );
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.equal(chosen.body.account.aiAnalysisEmployeeId, employee.id);
    assert.deepEqual(await grantLevels(), [[employee.id, "read"]]);
  });

  test("a member may write the mailbox's instructions, which cannot widen any Grant", async () => {
    actingUserId = memberId;
    const saved = await call<{ instructions: string; usingDefaultInstructions: boolean }>(
      "PATCH",
      `/mail/accounts/${account.id}/ai-analysis`,
      { instructions: "Star mail from our accountant." },
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.instructions, "Star mail from our accountant.");
    assert.equal(saved.body.usingDefaultInstructions, false);
    // Writing instructions is not granting access: no Grant appears, and an
    // instruction can only act through a Grant an owner or admin already gave.
    assert.deepEqual(await grantLevels(), []);

    const restored = await call<{ usingDefaultInstructions: boolean }>(
      "PATCH",
      `/mail/accounts/${account.id}/ai-analysis`,
      { instructions: null },
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.usingDefaultInstructions, true);
  });

  test("a member may still write a rule for the mailbox", async () => {
    actingUserId = memberId;
    const created = await call<{ rule: { name: string } }>(
      "POST",
      `/mail/accounts/${account.id}/rules`,
      {
        name: "Archive receipts",
        conditions: { from: "receipts@" },
        actions: [{ type: "archive" }],
      },
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.rule.name, "Archive receipts");
  });

  test("the guard does not reach routers mounted beside this one", async () => {
    actingUserId = memberId;
    const res = await call<{ ok: boolean }>("POST", "/sibling-feature");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});
