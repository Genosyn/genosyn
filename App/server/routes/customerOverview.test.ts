import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { Activity } from "../db/entities/Activity.js";
import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerCredit } from "../db/entities/CustomerCredit.js";
import { Deal } from "../db/entities/Deal.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { indexMailboxAddresses } from "../services/mail/addressIndex.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";
import { revenueRouter } from "./revenue.js";

/**
 * The reads behind the Customer page that are new with it: the customer's
 * mail, credits narrowed to one customer, and the account timeline that also
 * reaches activity recorded against its contacts and deals.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let customer: Customer;

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
  app.use("/api/companies/:cid", financeRouter);
  app.use("/api/companies/:cid", revenueRouter);
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

async function member(role: Role, financeAccess: FinanceAccess): Promise<User> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.com`,
    name: `${role} ${financeAccess}`,
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role, financeAccess });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Customer overview test",
    slug: `customer-overview-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme",
    slug: "acme",
    email: "billing@acme.com",
    domain: "acme.com",
  });
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("GET /customers/:slug/mail", () => {
  beforeEach(async () => {
    const mailbox = await insert(MailAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      address: "sales@northwind.test",
    });
    const thread = await insert(MailThread, {
      companyId: company.id,
      accountId: mailbox.id,
      gmailThreadId: "thread-1",
      subject: "Renewal",
      labelIds: " INBOX ",
      lastMessageAt: new Date("2026-09-01T10:00:00Z"),
    });
    await insert(MailMessage, {
      companyId: company.id,
      accountId: mailbox.id,
      threadId: thread.id,
      gmailMessageId: "message-1",
      gmailThreadId: thread.gmailThreadId,
      fromEmail: "Ada <ada@acme.com>",
      toEmails: "sales@northwind.test",
    });
    await indexMailboxAddresses(mailbox, { now: new Date(Date.now() + 60 * 60_000) });
  });

  test("lists the customer's conversations for anyone who can read finance", async () => {
    for (const reader of [null, await member("member", "read")]) {
      if (reader) actingUserId = reader.id;
      const { status, body } = await get("/customers/acme/mail");
      assert.equal(status, 200);
      assert.equal(body.total, 1);
      assert.deepEqual(
        (body.threads as Array<{ subject: string }>).map((thread) => thread.subject),
        ["Renewal"],
      );
    }
  });

  test("is closed to a Member without finance access, like the rest of the page", async () => {
    actingUserId = (await member("member", "none")).id;
    const { status } = await get("/customers/acme/mail");
    assert.equal(status, 403);
  });

  test("validates the page window and the customer", async () => {
    assert.equal((await get("/customers/acme/mail?limit=0")).status, 400);
    assert.equal((await get("/customers/acme/mail?limit=101")).status, 400);
    assert.equal((await get("/customers/acme/mail?folder=inbox")).status, 400);
    assert.equal((await get("/customers/nobody/mail")).status, 404);
  });
});

describe("GET /credit-notes?customerId=", () => {
  async function credit(customerId: string, number: string) {
    return insert(CustomerCredit, {
      companyId: company.id,
      customerId,
      kind: "credit_memo",
      status: "issued",
      numberSeq: Number(number.replace(/\D/g, "")),
      number,
      slug: number.toLowerCase(),
      currency: "USD",
      totalCents: 1000,
      issueDate: new Date("2026-09-01T00:00:00Z"),
    });
  }

  test("narrows the company's credits to one customer", async () => {
    const other = await insert(Customer, { companyId: company.id, name: "Other", slug: "other" });
    await credit(customer.id, "CN-1");
    await credit(other.id, "CN-2");

    const all = await fetch(`${baseUrl}/api/companies/${company.id}/credit-notes`);
    assert.equal(((await all.json()) as unknown[]).length, 2);

    const mine = await fetch(
      `${baseUrl}/api/companies/${company.id}/credit-notes?customerId=${customer.id}`,
    );
    assert.equal(mine.status, 200);
    assert.deepEqual(
      ((await mine.json()) as Array<{ number: string }>).map((row) => row.number),
      ["CN-1"],
    );

    const invalid = await fetch(
      `${baseUrl}/api/companies/${company.id}/credit-notes?customerId=not-a-uuid`,
    );
    assert.equal(invalid.status, 400);
  });
});

describe("GET /revenue/activities?customerId=&includeRelatedRecords=true", () => {
  test("adds activity recorded against the account's contacts and deals", async () => {
    const contact = await insert(Contact, {
      companyId: company.id,
      name: "Ada",
      email: "ada@acme.com",
      customerId: customer.id,
    });
    const deal = await insert(Deal, {
      companyId: company.id,
      title: "Renewal",
      customerId: customer.id,
      stageId: randomUUID(),
    });
    const strangerContact = await insert(Contact, { companyId: company.id, name: "Stranger" });
    const activity = (subject: string, links: Partial<Activity>, minute: number) =>
      insert(Activity, {
        companyId: company.id,
        kind: "note",
        subject,
        occurredAt: new Date(Date.UTC(2026, 8, 1, 9, minute)),
        ...links,
      });
    await activity("Logged on the account", { customerId: customer.id }, 1);
    await activity("Call before Ada was linked", { contactId: contact.id }, 2);
    await activity("Stage moved", { dealId: deal.id }, 3);
    await activity("Someone else", { contactId: strangerContact.id }, 4);

    const stamped = await get(`/revenue/activities?customerId=${customer.id}`);
    assert.deepEqual(
      (stamped.body.rows as Array<{ subject: string }>).map((row) => row.subject),
      ["Logged on the account"],
    );

    const whole = await get(
      `/revenue/activities?customerId=${customer.id}&includeRelatedRecords=true`,
    );
    assert.equal(whole.body.total, 3);
    assert.deepEqual(
      (whole.body.rows as Array<{ subject: string }>).map((row) => row.subject),
      ["Stage moved", "Call before Ada was linked", "Logged on the account"],
    );
  });
});
