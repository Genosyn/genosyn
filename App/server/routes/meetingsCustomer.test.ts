import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Meeting } from "../db/entities/Meeting.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";
import { meetingsRouter } from "./meetings.js";

/**
 * Going from a meeting to its customer, over the real router. A link grants
 * nothing: Customers follow Finance access, so a Member without it keeps the
 * whole meeting and learns only that it has a customer, never which.
 */

let server: Server;
let baseUrl: string;
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
  app.use("/api/companies/:cid", meetingsRouter);
  app.use("/api/companies/:cid", financeRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTestDb();
  actingUserId = null;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

async function company(): Promise<Company> {
  const owner = await insert(User, {
    email: `owner-${randomUUID()}@example.test`,
    name: "Owner",
    passwordHash: "x",
  });
  return insert(Company, { name: "Co", slug: `co-${randomUUID()}`, ownerId: owner.id });
}

async function memberOf(
  co: Company,
  role: Role = "member",
  financeAccess: FinanceAccess = "none",
): Promise<User> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.test`,
    name: role,
    passwordHash: "x",
  });
  await insert(Membership, { companyId: co.id, userId: user.id, role, financeAccess });
  return user;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as never };
}

describe("creating a meeting", () => {
  test("answers with the meeting already linked to a new Customer", async () => {
    const co = await company();
    actingUserId = (await memberOf(co, "member", "read")).id;

    const res = await call("POST", `/api/companies/${co.id}/meetings`, {
      title: "Intro",
      attendeeEmails: ["sam@acme.test"],
    });

    assert.equal(res.status, 201);
    const customer = await AppDataSource.getRepository(Customer).findOneByOrFail({
      companyId: co.id,
    });
    const { meeting } = res.body as { meeting: { customerId: string; customerChosen: boolean } };
    assert.equal(meeting.customerId, customer.id);
    assert.equal(meeting.customerChosen, false);
  });

  test("works for a Member with no Finance access, who is still told nothing", async () => {
    const co = await company();
    actingUserId = (await memberOf(co, "member", "none")).id;

    const created = await call("POST", `/api/companies/${co.id}/meetings`, {
      title: "Intro",
      attendeeEmails: ["sam@acme.test"],
    });
    assert.equal(created.status, 201);
    const id = (created.body as { meeting: { id: string } }).meeting.id;

    const detail = await call("GET", `/api/companies/${co.id}/meetings/${id}`);
    assert.equal(detail.status, 200);
    const body = detail.body as { customer: unknown; customerWithheld: boolean };
    assert.equal(body.customer, null);
    assert.equal(body.customerWithheld, true);
    assert.ok(!JSON.stringify(detail.body).includes("Acme"));
  });
});

describe("reading a meeting's customer", () => {
  async function linkedMeeting(co: Company) {
    const customer = await insert(Customer, {
      companyId: co.id,
      name: "Acme",
      slug: "acme",
      domain: "acme.test",
      email: "billing@acme.test",
      accountStatus: "prospect",
    });
    const meeting = await insert(Meeting, {
      companyId: co.id,
      title: "Review",
      customerId: customer.id,
    });
    return { customer, meeting };
  }

  test("the page gets its name and where to go, and no billing detail", async () => {
    const co = await company();
    const { customer, meeting } = await linkedMeeting(co);
    actingUserId = (await memberOf(co, "member", "read")).id;

    const res = await call("GET", `/api/companies/${co.id}/meetings/${meeting.id}`);

    assert.equal(res.status, 200);
    assert.deepEqual((res.body as { customer: unknown }).customer, {
      id: customer.id,
      name: "Acme",
      slug: "acme",
      domain: "acme.test",
      accountStatus: "prospect",
      archived: false,
    });
    assert.equal((res.body as { customerWithheld: boolean }).customerWithheld, false);
    assert.ok(!JSON.stringify(res.body).includes("billing@acme.test"));
  });

  test("a list row names its customer for a reader with Finance access", async () => {
    const co = await company();
    await linkedMeeting(co);
    actingUserId = (await memberOf(co, "member", "read")).id;

    const res = await call("GET", `/api/companies/${co.id}/meetings`);

    const { meetings } = res.body as { meetings: Array<{ customer: { name: string } | null }> };
    assert.equal(meetings[0].customer?.name, "Acme");
  });

  test("a list row keeps its customer from a reader with none", async () => {
    const co = await company();
    await linkedMeeting(co);
    actingUserId = (await memberOf(co, "member", "none")).id;

    const res = await call("GET", `/api/companies/${co.id}/meetings`);

    assert.equal(res.status, 200);
    const { meetings } = res.body as { meetings: Array<{ customer: unknown }> };
    assert.equal(meetings[0].customer, null);
    assert.ok(!JSON.stringify(res.body).includes("Acme"));
  });

  test("the customer's own list finds the meeting", async () => {
    const co = await company();
    const { customer, meeting } = await linkedMeeting(co);
    actingUserId = (await memberOf(co, "member", "read")).id;

    const res = await call("GET", `/api/companies/${co.id}/meetings?customerId=${customer.id}`);

    const { meetings } = res.body as { meetings: Array<{ id: string }> };
    assert.deepEqual(
      meetings.map((row) => row.id),
      [meeting.id],
    );
  });
});

describe("PUT /meetings/:id/customer", () => {
  test("a Member who can read Customers links a meeting, and it stays chosen", async () => {
    const co = await company();
    const customer = await insert(Customer, { companyId: co.id, name: "Acme", slug: "acme" });
    const meeting = await insert(Meeting, { companyId: co.id, title: "Review" });
    const user = await memberOf(co, "member", "read");
    actingUserId = user.id;

    const res = await call("PUT", `/api/companies/${co.id}/meetings/${meeting.id}/customer`, {
      customerId: customer.id,
    });

    assert.equal(res.status, 200);
    const body = res.body as {
      meeting: { customerId: string; customerChosen: boolean };
      customer: { name: string };
    };
    assert.equal(body.meeting.customerId, customer.id);
    assert.equal(body.meeting.customerChosen, true);
    assert.equal(body.customer.name, "Acme");

    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      companyId: co.id,
      targetId: meeting.id,
    });
    assert.equal(audit.action, "meeting.customer.link");
    assert.equal(audit.actorUserId, user.id);
    // A meeting's History is any Member's to read, so it never names the account.
    assert.ok(!(audit.metadataJson ?? "").includes("Acme"));
  });

  test("null removes the link, and it stays removed", async () => {
    const co = await company();
    const customer = await insert(Customer, { companyId: co.id, name: "Acme", slug: "acme" });
    const meeting = await insert(Meeting, {
      companyId: co.id,
      title: "Review",
      customerId: customer.id,
    });
    actingUserId = (await memberOf(co, "member", "read")).id;

    const res = await call("PUT", `/api/companies/${co.id}/meetings/${meeting.id}/customer`, {
      customerId: null,
    });

    assert.equal(res.status, 200);
    const stored = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.equal(stored.customerId, null);
    assert.equal(stored.customerChosen, true);
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      companyId: co.id,
      targetId: meeting.id,
    });
    assert.equal(audit.action, "meeting.customer.unlink");
  });

  test("a Member with no Finance access cannot choose", async () => {
    const co = await company();
    const customer = await insert(Customer, { companyId: co.id, name: "Acme", slug: "acme" });
    const meeting = await insert(Meeting, { companyId: co.id, title: "Review" });
    actingUserId = (await memberOf(co, "member", "none")).id;

    const res = await call("PUT", `/api/companies/${co.id}/meetings/${meeting.id}/customer`, {
      customerId: customer.id,
    });

    assert.equal(res.status, 403);
    const stored = await AppDataSource.getRepository(Meeting).findOneByOrFail({ id: meeting.id });
    assert.equal(stored.customerId, null);
  });

  test("another company's customer and meeting are not there", async () => {
    const co = await company();
    const other = await company();
    const theirCustomer = await insert(Customer, {
      companyId: other.id,
      name: "Theirs",
      slug: "theirs",
    });
    const theirMeeting = await insert(Meeting, { companyId: other.id, title: "Theirs" });
    const meeting = await insert(Meeting, { companyId: co.id, title: "Ours" });
    actingUserId = (await memberOf(co, "admin")).id;

    const wrongCustomer = await call(
      "PUT",
      `/api/companies/${co.id}/meetings/${meeting.id}/customer`,
      { customerId: theirCustomer.id },
    );
    assert.equal(wrongCustomer.status, 400);

    const wrongMeeting = await call(
      "PUT",
      `/api/companies/${co.id}/meetings/${theirMeeting.id}/customer`,
      { customerId: null },
    );
    assert.equal(wrongMeeting.status, 404);
  });

  test("the body must say which customer, or null", async () => {
    const co = await company();
    const meeting = await insert(Meeting, { companyId: co.id, title: "Review" });
    actingUserId = (await memberOf(co, "owner")).id;

    const res = await call("PUT", `/api/companies/${co.id}/meetings/${meeting.id}/customer`, {});
    assert.equal(res.status, 400);
  });
});

describe("deleting a Customer", () => {
  test("is refused while a meeting points at it, so the link can't dangle", async () => {
    const co = await company();
    const customer = await insert(Customer, { companyId: co.id, name: "Acme", slug: "acme" });
    await insert(Meeting, { companyId: co.id, title: "Review", customerId: customer.id });
    actingUserId = (await memberOf(co, "owner")).id;

    const res = await call("DELETE", `/api/companies/${co.id}/customers/acme`);

    assert.equal(res.status, 409);
    assert.ok(await AppDataSource.getRepository(Customer).findOneBy({ id: customer.id }));
  });
});
