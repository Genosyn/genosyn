import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { createEstimateDraft, issueEstimate } from "../services/estimates.js";
import { createInvoiceDraft, issueInvoice } from "../services/finance.js";
import { getFinanceSettings } from "../services/fx.js";
import { recordInvoicePayment } from "../services/invoicePayments.js";
import type { EstimateStats, InvoiceStats } from "../../shared/financeStats.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { financeRouter } from "./finance.js";

/**
 * The figures Finance → Invoices and Finance → Estimates lead with come from
 * `GET …/invoices/stats` and `GET …/estimates/stats`: Read Finance access,
 * this company's documents only, no query parameters, and never mistaken for
 * a document's slug.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string;
let owner: User;
let company: Company;
let acme: Customer;

const originalLog = console.log;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: actingUserId, sessionVersion: 0 };
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

async function user(name: string): Promise<User> {
  return insert(User, {
    email: `${name.toLowerCase()}-${randomUUID()}@example.com`,
    name,
    passwordHash: "x",
    sessionVersion: 0,
  });
}

async function newCompany(founder: User, name: string): Promise<Company> {
  const created = await insert(Company, {
    name,
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    ownerId: founder.id,
    timezone: "UTC",
  });
  await insert(Membership, { companyId: created.id, userId: founder.id, role: "owner" });
  await getFinanceSettings(created.id);
  return created;
}

beforeEach(async () => {
  await resetTestDb();
  owner = await user("Owner");
  actingUserId = owner.id;
  company = await newCompany(owner, "Sunwise");
  acme = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "billing@acme.example",
    currency: "USD",
  });
});

async function get<T>(path: string, companyId = company.id): Promise<{ status: number; body: T }> {
  console.log = () => undefined;
  try {
    const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`);
    return { status: response.status, body: (await response.json()) as T };
  } finally {
    console.log = originalLog;
  }
}

async function invoiceFor(target: Company, customer: Customer, amountCents: number) {
  const draft = await createInvoiceDraft({
    companyId: target.id,
    customerId: customer.id,
    issueDate: new Date(Date.now() - 20 * 86_400_000),
    dueDate: new Date(Date.now() - 5 * 86_400_000),
    lines: [{ description: "Panels", quantity: 1, unitPriceCents: amountCents }],
  });
  return issueInvoice(draft, null);
}

async function estimateFor(target: Company, customer: Customer, amountCents: number) {
  const draft = await createEstimateDraft({
    companyId: target.id,
    customerId: customer.id,
    lines: [{ description: "Panels", quantity: 1, unitPriceCents: amountCents }],
  });
  return issueEstimate(draft, null);
}

describe("GET /invoices/stats and /estimates/stats", () => {
  test("answer with the company's figures, the invoice ones read from its issued invoices", async () => {
    const invoice = await invoiceFor(company, acme, 120_000);
    await recordInvoicePayment(
      invoice,
      { amountCents: 20_000, paidAt: new Date(), reference: "wire-1" },
      null,
    );
    const estimate = await estimateFor(company, acme, 55_000);

    const invoices = await get<InvoiceStats>("/invoices/stats");
    assert.equal(invoices.status, 200);
    assert.equal(invoices.body.currency, "USD");
    assert.equal(invoices.body.timeZone, "UTC");
    assert.match(invoices.body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(invoices.body.issuedInvoices, 1);
    assert.deepEqual(invoices.body.outstanding, {
      count: 1,
      amountCents: 100_000,
      ids: [invoice.id],
      customers: 1,
    });
    assert.deepEqual(invoices.body.overdue.ids, [invoice.id]);
    assert.equal(invoices.body.overdue.oldest?.daysLate, 5);
    assert.equal(invoices.body.paid.amountCents, 20_000);
    assert.equal(invoices.body.largestCustomer?.name, "Acme Corp");

    const estimates = await get<EstimateStats>("/estimates/stats");
    assert.equal(estimates.status, 200);
    assert.deepEqual(estimates.body.open.ids, [estimate.id]);
    assert.equal(estimates.body.open.amountCents, 55_000);
    assert.equal(estimates.body.issuedEstimates, 1);
  });

  test("are never taken for a document's slug, which still opens its document", async () => {
    const invoice = await invoiceFor(company, acme, 10_000);
    const estimate = await estimateFor(company, acme, 10_000);
    const stats = await get<InvoiceStats & { error?: string }>("/invoices/stats");
    assert.equal(stats.status, 200);
    assert.ok("outstanding" in stats.body, "the figures, not an invoice lookup");
    const opened = await get<{ id: string }>(`/invoices/${invoice.slug}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.id, invoice.id);
    const estimateStats = await get<EstimateStats>("/estimates/stats");
    assert.ok("open" in estimateStats.body);
    const openedEstimate = await get<{ id: string }>(`/estimates/${estimate.slug}`);
    assert.equal(openedEstimate.body.id, estimate.id);
  });

  test("take no query parameters", async () => {
    for (const path of ["/invoices/stats?days=7", "/estimates/stats?currency=EUR"]) {
      const refused = await get<{ error: string }>(path);
      assert.equal(refused.status, 400, path);
    }
  });

  test("need Read Finance access: refused with none, answered with read or full", async () => {
    const member = await user("Member");
    const membership = await insert(Membership, {
      companyId: company.id,
      userId: member.id,
      role: "member",
      financeAccess: "none",
    });
    actingUserId = member.id;
    for (const path of ["/invoices/stats", "/estimates/stats"]) {
      const refused = await get<{ error: string }>(path);
      assert.equal(refused.status, 403, `${path} with no finance access`);
      assert.match(refused.body.error, /finances/);
    }
    for (const access of ["read", "full"] as const) {
      await AppDataSource.getRepository(Membership).update(membership.id, {
        financeAccess: access,
      });
      for (const path of ["/invoices/stats", "/estimates/stats"]) {
        assert.equal((await get(path)).status, 200, `${path} with ${access} access`);
      }
    }
    // Owners and admins read finances whatever their own row says.
    const admin = await user("Admin");
    await insert(Membership, {
      companyId: company.id,
      userId: admin.id,
      role: "admin",
      financeAccess: "none",
    });
    actingUserId = admin.id;
    assert.equal((await get("/invoices/stats")).status, 200);
    assert.equal((await get("/estimates/stats")).status, 200);
  });

  test("answer for one company only, and not at all to someone outside it", async () => {
    const rival = await user("Rival");
    const other = await newCompany(rival, "Moonwise");
    const theirCustomer = await insert(Customer, {
      companyId: other.id,
      name: "Initech",
      slug: "initech",
      email: "ap@initech.example",
      currency: "USD",
    });
    const theirInvoice = await invoiceFor(other, theirCustomer, 70_000);
    const theirEstimate = await estimateFor(other, theirCustomer, 90_000);
    const ours = await invoiceFor(company, acme, 5_000);

    const invoices = await get<InvoiceStats>("/invoices/stats");
    assert.deepEqual(invoices.body.outstanding.ids, [ours.id]);
    assert.ok(!invoices.body.overdue.ids.includes(theirInvoice.id));
    const estimates = await get<EstimateStats>("/estimates/stats");
    assert.ok(!estimates.body.open.ids.includes(theirEstimate.id));
    assert.equal(estimates.body.open.count, 0);
    assert.equal(estimates.body.issuedEstimates, 0);

    // The owner here is no Member there.
    for (const path of ["/invoices/stats", "/estimates/stats"]) {
      assert.equal((await get(path, other.id)).status, 403, `${path} of another company`);
    }
    actingUserId = rival.id;
    const theirs = await get<InvoiceStats>("/invoices/stats", other.id);
    assert.deepEqual(theirs.body.outstanding.ids, [theirInvoice.id]);
  });
});
