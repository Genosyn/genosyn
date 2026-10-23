import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * `GET /customers/:slug/recipient-suggestions`, the read behind the send
 * dialog's suggestions: Finance access gates it like every Finance read, it
 * answers for the company in the path and no other, and its one knob is
 * validated. Who is suggested, and in what order, is
 * `services/recipientSuggestions.test.ts`.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
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

async function user(label: string): Promise<User> {
  return insert(User, {
    email: `${label}-${randomUUID()}@northwind.example`,
    name: label,
    passwordHash: "x",
    sessionVersion: 0,
  });
}

async function member(role: Role, financeAccess: FinanceAccess, of = company): Promise<User> {
  const person = await user(`${role}-${financeAccess}`);
  await insert(Membership, { companyId: of.id, userId: person.id, role, financeAccess });
  return person;
}

beforeEach(async () => {
  await resetTestDb();
  const owner = await user("owner");
  company = await insert(Company, {
    name: "Northwind",
    slug: `northwind-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  otherCompany = await insert(Company, {
    name: "Elsewhere",
    slug: `elsewhere-${randomUUID()}`,
    ownerId: owner.id,
  });
  actingUserId = owner.id;
  customer = await insert(Customer, {
    companyId: company.id,
    name: "OptionMetrics",
    slug: "optionmetrics",
    email: "billing@optionmetrics.com",
    domain: "optionmetrics.com",
  });
  await insert(CustomerContact, {
    companyId: company.id,
    customerId: customer.id,
    name: "Priya Shah",
    email: "priya@optionmetrics.com",
    role: "Accounts payable",
    isPrimary: true,
  });
  await insert(Contact, {
    companyId: company.id,
    name: "Chad Analyst",
    email: "chad@optionmetrics.com",
    title: "Analyst",
  });
});

type SuggestionBody = {
  error?: string;
  issues?: unknown[];
  suggestions?: Array<{
    email: string;
    name: string;
    role: string;
    primary: boolean;
    billing: boolean;
    sources: string[];
    dealTitle: string | null;
    lastEmailedAt: string | null;
  }>;
  domain?: string | null;
};

async function suggestions(
  slug = customer.slug,
  query = "",
  companyId = company.id,
): Promise<{ status: number; body: SuggestionBody }> {
  const response = await fetch(
    `${baseUrl}/api/companies/${companyId}/customers/${slug}/recipient-suggestions${query}`,
  );
  return { status: response.status, body: (await response.json()) as SuggestionBody };
}

describe("recipient suggestions route", () => {
  test("answers the customer's people, best first, with the domain they were matched at", async () => {
    const { status, body } = await suggestions();

    assert.equal(status, 200);
    assert.equal(body.domain, "optionmetrics.com");
    assert.deepEqual(body.suggestions, [
      {
        email: "billing@optionmetrics.com",
        name: "",
        role: "",
        primary: false,
        billing: true,
        sources: ["billing_email"],
        dealTitle: null,
        lastEmailedAt: null,
      },
      {
        email: "priya@optionmetrics.com",
        name: "Priya Shah",
        role: "Accounts payable",
        primary: true,
        billing: true,
        sources: ["customer_contact"],
        dealTitle: null,
        lastEmailedAt: null,
      },
      {
        email: "chad@optionmetrics.com",
        name: "Chad Analyst",
        role: "Analyst",
        primary: false,
        billing: false,
        sources: ["domain"],
        dealTitle: null,
        lastEmailedAt: null,
      },
    ]);
  });

  test("takes a limit", async () => {
    const { status, body } = await suggestions(customer.slug, "?limit=1");

    assert.equal(status, 200);
    assert.deepEqual(
      body.suggestions?.map((row) => row.email),
      ["billing@optionmetrics.com"],
    );
  });

  test("refuses a limit it cannot honor, and anything it does not know", async () => {
    for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?limit=1.5", "?q=priya"]) {
      const { status, body } = await suggestions(customer.slug, query);
      assert.equal(status, 400, query);
      assert.equal(body.error, "ValidationError", query);
      assert.equal(body.suggestions, undefined, query);
    }
  });

  test("still answers for an archived customer, whose invoices can still be resent", async () => {
    customer.archivedAt = new Date();
    await insert(Customer, customer);

    const { status, body } = await suggestions();

    assert.equal(status, 200);
    assert.equal(body.suggestions?.length, 3);
  });

  test("is a Finance read: read-only access answers, no access is refused", async () => {
    actingUserId = (await member("member", "read")).id;
    const read = await suggestions();
    assert.equal(read.status, 200);
    assert.equal(read.body.suggestions?.length, 3);

    actingUserId = (await member("member", "full")).id;
    assert.equal((await suggestions()).status, 200);

    actingUserId = (await member("member", "none")).id;
    const none = await suggestions();
    assert.equal(none.status, 403);
    assert.equal(none.body.suggestions, undefined);

    // Owners and admins always have Finance, whatever the column says.
    actingUserId = (await member("admin", "none")).id;
    assert.equal((await suggestions()).status, 200);
  });

  test("needs a signed-in member of the company in the path", async () => {
    actingUserId = null;
    assert.equal((await suggestions()).status, 401);

    actingUserId = (await member("owner", "full", otherCompany)).id;
    const outsider = await suggestions();
    assert.equal(outsider.status, 403);
    assert.equal(outsider.body.suggestions, undefined);
  });

  test("answers only for customers of the company in the path", async () => {
    await insert(Customer, {
      companyId: otherCompany.id,
      name: "Their Customer",
      slug: "their-customer",
      email: "ap@theirs.example",
    });

    // The slug exists, but in another company: this company has no such customer.
    const theirs = await suggestions("their-customer");
    assert.equal(theirs.status, 404);
    assert.equal(theirs.body.error, "Customer not found");
    assert.equal(theirs.body.suggestions, undefined);

    assert.equal((await suggestions("no-such-customer")).status, 404);
  });
});
