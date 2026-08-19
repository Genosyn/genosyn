import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeCalendarGrant } from "../db/entities/EmployeeCalendarGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { meetingsRouter } from "./meetings.js";

/**
 * Who may change the Meetings section's recording policy.
 *
 * The router runs for real over an in-memory database; only the cookie session
 * is faked, by a middleware that stamps `req.session` the way `cookie-session`
 * would. That matters here because the subject is guard *scoping* — which
 * paths and which methods the admin gate covers — and scoping is invisible to
 * a service test: `upsertCalendarGrant` happily writes a grant for anyone who
 * calls it, because deciding who may call it is this layer's job.
 *
 * The regression this file exists for: the AI-access and calendar-config
 * routes were guarded in the client only (`canManage` in
 * `client/pages/MeetingsAiAccess.tsx`), so a plain member with a terminal could
 * grant an AI Employee `record` on a calendar — read every transcript and start
 * the notetaker on live calls — and the server would persist it.
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
  app.use("/api/companies/:cid", meetingsRouter);
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

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "meetings-owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const admin = await insert(User, {
    email: "meetings-admin@example.com",
    name: "Admin",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const member = await insert(User, {
    email: "meetings-member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Northwind Calls",
    slug: `meetings-${randomUUID()}`,
    ownerId: owner.id,
  });
  ownerId = owner.id;
  adminId = admin.id;
  memberId = member.id;
  companyId = company.id;
  await insert(Membership, { companyId, userId: ownerId, role: "owner" as Role });
  await insert(Membership, { companyId, userId: adminId, role: "admin" as Role });
  await insert(Membership, { companyId, userId: memberId, role: "member" as Role });
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

/**
 * A calendar row without a usable Connection behind it.
 *
 * Enough for every route that only reads or writes the local mirror. Routes
 * that reach Google (connect, sync) fail on the missing Connection with a 400,
 * which is exactly the signal those tests want: 400 means the request got
 * *past* the authorization gate.
 */
async function aCalendar(): Promise<CalendarAccount> {
  return insert(CalendarAccount, {
    companyId,
    connectionId: randomUUID(),
    calendarId: "primary",
    displayName: "Sales calendar",
    address: "sales@example.com",
    status: "active",
  });
}

async function anEmployee(): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId,
    name: "Nova",
    slug: "nova",
    role: "Account executive",
  });
}

async function grantCount(): Promise<number> {
  return AppDataSource.getRepository(EmployeeCalendarGrant).count();
}

describe("meetings routes — AI access is admin-only", () => {
  test("any member may read the grant list", async () => {
    actingUserId = memberId;
    const res = await call<{ grants: unknown[] }>("GET", "/meetings/ai-access");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.grants));
  });

  test("a plain member cannot grant an AI Employee access to a calendar", async () => {
    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);
    actingUserId = memberId;
    const res = await call<{ error: string }>("PUT", "/meetings/ai-access", {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "record",
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin company role required");
    // The point of the guard: nothing was written on the way to the 403.
    assert.equal(await grantCount(), 0);
  });

  test("an admin can grant, and an owner can too", async () => {
    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);
    actingUserId = adminId;
    const granted = await call<{ grants: Array<{ accessLevel: string }> }>(
      "PUT",
      "/meetings/ai-access",
      { employeeId: employee.id, accountId: account.id, accessLevel: "record" },
    );
    assert.equal(granted.status, 200);
    assert.equal(granted.body.grants.length, 1);
    assert.equal(granted.body.grants[0]?.accessLevel, "record");

    // PUT is an upsert, so the owner moving the level is the same route again.
    actingUserId = ownerId;
    const lowered = await call<{ grants: Array<{ accessLevel: string }> }>(
      "PUT",
      "/meetings/ai-access",
      { employeeId: employee.id, accountId: account.id, accessLevel: "read" },
    );
    assert.equal(lowered.status, 200);
    assert.equal(lowered.body.grants[0]?.accessLevel, "read");
    assert.equal(await grantCount(), 1);
  });

  test("a plain member cannot revoke either", async () => {
    const [employee, account] = await Promise.all([anEmployee(), aCalendar()]);
    await call("PUT", "/meetings/ai-access", {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "record",
    });

    actingUserId = memberId;
    const forbidden = await call("POST", "/meetings/ai-access/revoke", {
      employeeId: employee.id,
      accountId: account.id,
    });
    assert.equal(forbidden.status, 403);
    assert.equal(await grantCount(), 1);

    actingUserId = adminId;
    const revoked = await call<{ grants: unknown[] }>("POST", "/meetings/ai-access/revoke", {
      employeeId: employee.id,
      accountId: account.id,
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.grants.length, 0);
  });
});

describe("meetings routes — calendar configuration is admin-only", () => {
  test("any member may list calendars", async () => {
    await aCalendar();
    actingUserId = memberId;
    const res = await call<{ calendars: unknown[] }>("GET", "/meetings/calendars");
    assert.equal(res.status, 200);
    assert.equal(res.body.calendars.length, 1);
  });

  test("a plain member cannot connect a calendar", async () => {
    actingUserId = memberId;
    const forbidden = await call("POST", "/meetings/calendars", {
      connectionId: randomUUID(),
      calendarId: "primary",
    });
    assert.equal(forbidden.status, 403);

    // An admin is past the guard: the 400 comes from the absent Connection,
    // not from authorization.
    actingUserId = adminId;
    const allowed = await call<{ error: string }>("POST", "/meetings/calendars", {
      connectionId: randomUUID(),
      calendarId: "primary",
    });
    assert.equal(allowed.status, 400);
    assert.equal(allowed.body.error, "Connection not found.");
  });

  test("a plain member cannot arm auto-record or reassign the notetaker", async () => {
    const account = await aCalendar();
    const employee = await anEmployee();

    actingUserId = memberId;
    const forbidden = await call("PATCH", `/meetings/calendars/${account.id}`, {
      autoRecord: "all",
      notetakerEmployeeId: employee.id,
    });
    assert.equal(forbidden.status, 403);
    const untouched = await AppDataSource.getRepository(CalendarAccount).findOneByOrFail({
      id: account.id,
    });
    assert.equal(untouched.autoRecord, "off");
    assert.equal(untouched.notetakerEmployeeId, null);

    actingUserId = adminId;
    const allowed = await call<{ calendar: { autoRecord: string; notetakerEmployeeId: string } }>(
      "PATCH",
      `/meetings/calendars/${account.id}`,
      { autoRecord: "all", notetakerEmployeeId: employee.id },
    );
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.calendar.autoRecord, "all");
    assert.equal(allowed.body.calendar.notetakerEmployeeId, employee.id);
  });

  test("a plain member cannot disconnect a calendar", async () => {
    const account = await aCalendar();

    actingUserId = memberId;
    const forbidden = await call("DELETE", `/meetings/calendars/${account.id}`);
    assert.equal(forbidden.status, 403);
    assert.ok(
      await AppDataSource.getRepository(CalendarAccount).findOneBy({ id: account.id }),
      "the calendar should survive a member's delete",
    );

    actingUserId = ownerId;
    const allowed = await call("DELETE", `/meetings/calendars/${account.id}`);
    assert.equal(allowed.status, 200);
    assert.equal(await AppDataSource.getRepository(CalendarAccount).count(), 0);
  });
});

/**
 * The other half of the guard. `onRoutePaths` exists because this router shares
 * the `/api/companies/:cid` mount with its siblings, so an unscoped `.use()`
 * would make unrelated features admin-only; and the calendar matchers are
 * anchored so `/meetings/calendars/:id/sync` stays outside the gate. Both are
 * silent failures — a member simply finds a button stops working — so they get
 * assertions rather than a comment.
 */
describe("meetings routes — the admin gate stays scoped", () => {
  test("a member may still sync a calendar", async () => {
    const account = await aCalendar();
    actingUserId = memberId;
    const res = await call<{ error: string }>("POST", `/meetings/calendars/${account.id}/sync`);
    // 400 from the missing Connection, not 403: the sync route is not gated.
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Google connection/);
  });

  test("a member may still create a meeting and work on it", async () => {
    actingUserId = memberId;
    const created = await call<{ meeting: { id: string } }>("POST", "/meetings", {
      title: "Discovery call",
    });
    assert.equal(created.status, 201);

    const id = created.body.meeting.id;
    const transcript = await call("POST", `/meetings/${id}/transcript`, {
      text: "Buyer asked about pricing.",
    });
    assert.equal(transcript.status, 200);

    const attendees = await call("POST", `/meetings/${id}/attendees`, {
      emails: ["buyer@example.com"],
    });
    assert.equal(attendees.status, 200);

    const linked = await call("POST", `/meetings/${id}/link`);
    assert.equal(linked.status, 200);
  });

  test("a member may still start the notetaker on a meeting they can see", async () => {
    actingUserId = memberId;
    const created = await call<{ meeting: { id: string } }>("POST", "/meetings", {
      title: "Renewal call",
    });
    assert.equal(created.status, 201);

    const res = await call<{ error: string }>(
      "POST",
      `/meetings/${created.body.meeting.id}/notetaker`,
    );
    // 400 because the ad-hoc meeting carries no conference link — the request
    // reached the handler, which is what this asserts.
    assert.equal(res.status, 400);
    assert.notEqual(res.status, 403);
  });
});
