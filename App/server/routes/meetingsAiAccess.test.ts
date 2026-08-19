import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";
import { meetingsRouter } from "./meetings.js";

/**
 * Meetings → AI access, end to end over HTTP.
 *
 * The page draws its AI Employee picker from `GET /employees` and then posts
 * the chosen id to `PUT /meetings/ai-access`, so the two routes are only
 * useful together — and the failure that shipped lived exactly in the seam.
 * `GET /employees` answers with a bare array; the page decoded it as
 * `{ employees: [...] }`, read `undefined`, fell back to `[]`, and rendered a
 * picker with no options. No request failed, so nothing surfaced an error and
 * the Grant button simply never enabled.
 *
 * Pinning the array shape in the same file as the grant round-trip keeps the
 * two halves honest: a future wrapper around either response breaks a test
 * here rather than silently emptying a dropdown.
 */

let server: Server;
let baseUrl: string;

/** Whose session the next request carries. Mutated per test. */
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid/employees", employeesRouter);
  app.use("/api/companies/:cid", meetingsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeTestDb();
});

let companyId: string;
let employeeId: string;
let accountId: string;

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  companyId = company.id;
  await insert(Membership, { companyId, userId: owner.id, role: "owner" as Role });
  actingUserId = owner.id;

  const employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Chief of Staff",
  });
  employeeId = employee.id;

  const account = await insert(CalendarAccount, {
    companyId,
    connectionId: "connection-1",
    calendarId: "primary",
    address: "ada@acme.test",
    displayName: "Acme calendar",
  });
  accountId = account.id;
});

type ApiResponse<T> = { status: number; body: T };

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("meetings AI access", () => {
  test("the employee picker's source is a bare array, not an object wrapper", async () => {
    const res = await call<unknown>("GET", "/employees");

    assert.equal(res.status, 200);
    assert.ok(
      Array.isArray(res.body),
      `GET /employees must answer with an array — the picker maps over it directly, got ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(
      (res.body as Array<{ id: string; name: string }>).map((row) => ({
        id: row.id,
        name: row.name,
      })),
      [{ id: employeeId, name: "Ada" }],
    );
  });

  test("granting an employee read access to a calendar round-trips", async () => {
    const granted = await call<{ grants: Array<Record<string, string>> }>(
      "PUT",
      "/meetings/ai-access",
      { employeeId, accountId, accessLevel: "read" },
    );

    assert.equal(granted.status, 200);
    assert.deepEqual(granted.body.grants, [
      {
        employeeId,
        employeeName: "Ada",
        employeeSlug: "ada",
        accountId,
        accountLabel: "Acme calendar",
        accessLevel: "read",
      },
    ]);

    const reloaded = await call<{ grants: Array<{ employeeId: string }> }>(
      "GET",
      "/meetings/ai-access",
    );
    assert.equal(reloaded.status, 200);
    assert.deepEqual(
      reloaded.body.grants.map((grant) => grant.employeeId),
      [employeeId],
    );
  });

  test("re-granting raises the level instead of duplicating the row", async () => {
    await call("PUT", "/meetings/ai-access", { employeeId, accountId, accessLevel: "read" });
    const raised = await call<{ grants: Array<{ accessLevel: string }> }>(
      "PUT",
      "/meetings/ai-access",
      { employeeId, accountId, accessLevel: "record" },
    );

    assert.equal(raised.status, 200);
    assert.deepEqual(
      raised.body.grants.map((grant) => grant.accessLevel),
      ["record"],
    );
  });

  test("revoking removes the grant", async () => {
    await call("PUT", "/meetings/ai-access", { employeeId, accountId, accessLevel: "read" });
    const revoked = await call<{ grants: unknown[] }>("POST", "/meetings/ai-access/revoke", {
      employeeId,
      accountId,
    });

    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body.grants, []);
  });

  test("an employee from another company cannot be granted access", async () => {
    const otherOwner = await insert(User, {
      email: "other@example.com",
      name: "Other",
      passwordHash: "x",
      sessionVersion: 0,
    });
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: otherOwner.id });
    const stranger = await insert(AIEmployee, {
      companyId: other.id,
      name: "Grace",
      slug: "grace",
      role: "Analyst",
    });

    const res = await call<{ error: string }>("PUT", "/meetings/ai-access", {
      employeeId: stranger.id,
      accountId,
      accessLevel: "read",
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, "AI Employee not found.");
  });
});
