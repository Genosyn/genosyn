import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Account, AccountType } from "../db/entities/Account.js";
import { Bill } from "../db/entities/Bill.js";
import { BillLineItem } from "../db/entities/BillLineItem.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { Estimate } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { Vendor } from "../db/entities/Vendor.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * "Issue & send" must never leave the caller holding a dead URL.
 *
 * Sending a draft auto-issues it, and issuing renumbers the row: an estimate's
 * slug goes from `edraft-a1b2c3` to `acme-corp-est-0001`, an invoice's from
 * `draft-a1b2c3` to `acme-corp-inv-0001`. The old slug stops resolving the
 * instant that write commits.
 *
 * The bug this file guards: the routes committed that rename *first* and only
 * then tried to address the email, so the overwhelmingly common case — a
 * customer with no email address on file — issued the document, threw, and
 * answered 400. The response never carried the new slug, so the open detail
 * page kept refetching the `edraft-…` URL, got a 404, and told the user "This
 * estimate doesn't exist or was deleted" about a document that had just been
 * issued and was sitting in the list. The invoice page did the same, and had
 * booked AR against the invoice on the way.
 *
 * The invariant, asserted from both directions below: either the send is
 * refused with nothing written at all, or it succeeds and the response names
 * the slug the caller must move to. There is no third outcome.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let customer: Customer;

const originalChromePath = config.browser.executablePath;
const originalLog = console.log;
const originalWarn = console.warn;

before(async () => {
  await initTestDb();
  // A real send renders a PDF attachment, and `renderPdfAttachment` launches a
  // browser to do it — ~24s per send on a machine with Chrome installed. It
  // swallows a launch failure and sends the HTML-only email instead, so
  // pointing it at a binary that does not exist keeps these tests on the code
  // path they are actually about, in milliseconds.
  (config.browser as { executablePath: string }).executablePath =
    "/nonexistent/chrome-for-tests";
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
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
  (config.browser as { executablePath: string }).executablePath = originalChromePath;
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `finance-owner-${randomUUID()}@example.com`,
    name: "Finance Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Send test",
    slug: `send-test-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  // No email address: the trigger a real user hits without knowing they have.
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    currency: "USD",
  });
});

/** Give the customer somewhere to send to. */
async function withEmail(): Promise<void> {
  customer.email = "ap@acme.example";
  await AppDataSource.getRepository(Customer).save(customer);
}

/**
 * The console branch of `sendEmail` logs every skipped delivery, and the PDF
 * renderer warns that it could not launch. Neither is the subject of a test.
 */
async function quietly<T>(operation: () => Promise<T>): Promise<T> {
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function draftEstimate(): Promise<Estimate> {
  const estimate = await insert(Estimate, {
    companyId: company.id,
    customerId: customer.id,
    slug: `edraft-${randomUUID().slice(0, 6)}`,
    number: "",
    numberSeq: 0,
    status: "draft",
    currency: "USD",
    issueDate: new Date("2026-08-06T00:00:00.000Z"),
    validUntil: new Date("2026-09-05T00:00:00.000Z"),
    subtotalCents: 10_000,
    totalCents: 10_000,
  });
  await insert(EstimateLineItem, {
    estimateId: estimate.id,
    description: "Advisory",
    quantity: 1,
    unitPriceCents: 10_000,
    lineTotalCents: 10_000,
    sortOrder: 0,
  });
  return estimate;
}

async function draftInvoice(): Promise<Invoice> {
  const invoice = await insert(Invoice, {
    companyId: company.id,
    customerId: customer.id,
    slug: `draft-${randomUUID().slice(0, 6)}`,
    number: "",
    numberSeq: 0,
    status: "draft",
    currency: "USD",
    issueDate: new Date("2026-08-06T00:00:00.000Z"),
    dueDate: new Date("2026-09-05T00:00:00.000Z"),
    subtotalCents: 10_000,
    totalCents: 10_000,
    balanceCents: 10_000,
  });
  await insert(InvoiceLineItem, {
    invoiceId: invoice.id,
    description: "Advisory",
    quantity: 1,
    unitPriceCents: 10_000,
    lineTotalCents: 10_000,
    sortOrder: 0,
  });
  return invoice;
}

type SendBody = {
  error?: string;
  estimate?: { slug: string; number: string; status: string };
  invoice?: { slug: string; number: string; status: string };
  send?: { status: string; errorMessage: string };
};

async function sendEstimate(slug: string): Promise<{ status: number; body: SendBody }> {
  const response = await quietly(() =>
    fetch(`${baseUrl}/api/companies/${company.id}/estimates/${slug}/send`, {
      method: "POST",
    }),
  );
  return { status: response.status, body: (await response.json()) as SendBody };
}

async function sendInvoice(
  slug: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: SendBody }> {
  const response = await quietly(() =>
    fetch(`${baseUrl}/api/companies/${company.id}/invoices/${slug}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as SendBody };
}

/** Does this slug still resolve? This is exactly what the detail page asks. */
async function estimateResolves(slug: string): Promise<boolean> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/estimates/${slug}`,
  );
  return response.ok;
}

async function invoiceResolves(slug: string): Promise<boolean> {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/invoices/${slug}`,
  );
  return response.ok;
}

describe("bill Issue", () => {
  test("a ledger refusal rolls the issue back rather than stranding the bill", async () => {
    const vendor = await insert(Vendor, {
      companyId: company.id,
      name: "Hosting Ltd",
      slug: "hosting-ltd",
      currency: "EUR",
    });
    // Bills have no email step, but they share the shape: issuing renames the
    // row and only then posts to the ledger. A foreign-currency bill with no
    // exchange rate on file is the reachable version of that failure.
    const bill = await insert(Bill, {
      companyId: company.id,
      vendorId: vendor.id,
      slug: `bdraft-${randomUUID().slice(0, 6)}`,
      number: "",
      numberSeq: 0,
      status: "draft",
      currency: "EUR",
      issueDate: new Date("2026-08-06T00:00:00.000Z"),
      dueDate: new Date("2026-09-05T00:00:00.000Z"),
      subtotalCents: 10_000,
      totalCents: 10_000,
      balanceCents: 10_000,
    });
    const account = await insert(Account, {
      companyId: company.id,
      code: "6000",
      name: "Hosting",
      type: "expense" as AccountType,
    });
    await insert(BillLineItem, {
      billId: bill.id,
      description: "Servers",
      quantity: 1,
      unitPriceCents: 10_000,
      lineTotalCents: 10_000,
      expenseAccountId: account.id,
      sortOrder: 0,
    });

    const response = await quietly(() =>
      fetch(`${baseUrl}/api/companies/${company.id}/bills/${bill.slug}/issue`, {
        method: "POST",
      }),
    );
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /exchange rate/i);
    const after = await AppDataSource.getRepository(Bill).findOneByOrFail({
      id: bill.id,
    });
    assert.equal(after.slug, bill.slug, "the draft keeps its slug");
    assert.equal(after.status, "draft");
    assert.equal(after.number, "", "the gapless number is not burned");
    assert.equal(after.numberSeq, 0);
    assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
  });
});

describe("estimate Issue & send", () => {
  test("refusing a send the customer cannot receive leaves the draft exactly as it was", async () => {
    const estimate = await draftEstimate();

    const response = await sendEstimate(estimate.slug);

    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /no email address/i);
    // The whole point: the row must not have been renumbered on the way out.
    const after = await AppDataSource.getRepository(Estimate).findOneByOrFail({
      id: estimate.id,
    });
    assert.equal(after.slug, estimate.slug, "the draft keeps its slug");
    assert.equal(after.status, "draft", "the draft is still a draft");
    assert.equal(after.number, "", "no gapless number was burned");
    assert.equal(after.numberSeq, 0);
    assert.equal(after.sentAt, null);
  });

  test("the URL the user is sitting on still resolves after a refused send", async () => {
    const estimate = await draftEstimate();

    await sendEstimate(estimate.slug);

    // The regression, stated as the page states it: before the fix this was
    // false, and the detail page rendered "This estimate doesn't exist or was
    // deleted" about an estimate that had just been issued.
    assert.equal(await estimateResolves(estimate.slug), true);
  });

  test("a refused send writes no delivery log", async () => {
    const estimate = await draftEstimate();

    await sendEstimate(estimate.slug);

    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
  });

  test("a successful send answers with the new slug the caller must move to", async () => {
    await withEmail();
    const estimate = await draftEstimate();

    const response = await sendEstimate(estimate.slug);

    assert.equal(response.status, 200);
    assert.equal(response.body.estimate?.slug, "acme-corp-est-0001");
    assert.equal(response.body.estimate?.number, "ACME-CORP-EST-0001");
    assert.equal(response.body.estimate?.status, "sent");
    assert.notEqual(response.body.estimate?.slug, estimate.slug);
    // With no transport configured the delivery is skipped, not failed — and
    // either way the caller has been told where the estimate now lives.
    assert.equal(response.body.send?.status, "skipped");
    assert.equal(await estimateResolves("acme-corp-est-0001"), true);
  });

  test("a customer deleted out from under the draft is refused without issuing", async () => {
    const estimate = await draftEstimate();
    await AppDataSource.getRepository(Customer).delete({ id: customer.id });

    const response = await sendEstimate(estimate.slug);

    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /customer not found/i);
    const after = await AppDataSource.getRepository(Estimate).findOneByOrFail({
      id: estimate.id,
    });
    assert.equal(after.slug, estimate.slug);
    assert.equal(after.status, "draft");
  });

  test("resending an already-issued estimate reports the failure without touching the row", async () => {
    await withEmail();
    const estimate = await draftEstimate();
    await sendEstimate(estimate.slug);
    // Take the address away, then resend: nothing is issued this time, so a
    // plain error is the right answer and the slug is already stable.
    customer.email = "";
    await AppDataSource.getRepository(Customer).save(customer);

    const response = await sendEstimate("acme-corp-est-0001");

    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /no email address/i);
    assert.equal(await estimateResolves("acme-corp-est-0001"), true);
  });

  test("a voided estimate is still refused outright", async () => {
    await withEmail();
    const estimate = await draftEstimate();
    await AppDataSource.getRepository(Estimate).update(
      { id: estimate.id },
      { status: "void" },
    );

    const response = await sendEstimate(estimate.slug);

    assert.equal(response.status, 409);
    assert.match(response.body.error ?? "", /voided/i);
  });

  test("an unknown slug is a plain 404 and issues nothing", async () => {
    await withEmail();
    await draftEstimate();

    const response = await sendEstimate("edraft-nosuch");

    assert.equal(response.status, 404);
    assert.equal(
      await AppDataSource.getRepository(Estimate).countBy({ status: "sent" }),
      0,
    );
  });
});

describe("invoice Issue & send", () => {
  test("refusing a send the customer cannot receive leaves the draft exactly as it was", async () => {
    const invoice = await draftInvoice();

    const response = await sendInvoice(invoice.slug);

    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /no email address/i);
    const after = await AppDataSource.getRepository(Invoice).findOneByOrFail({
      id: invoice.id,
    });
    assert.equal(after.slug, invoice.slug, "the draft keeps its slug");
    assert.equal(after.status, "draft", "the draft is still a draft");
    assert.equal(after.number, "", "no gapless number was burned");
    assert.equal(after.numberSeq, 0);
    assert.equal(after.sentAt, null);
  });

  test("the URL the user is sitting on still resolves after a refused send", async () => {
    const invoice = await draftInvoice();

    await sendInvoice(invoice.slug);

    assert.equal(await invoiceResolves(invoice.slug), true);
  });

  test("a refused send books no receivable and writes no delivery log", async () => {
    const invoice = await draftInvoice();

    await sendInvoice(invoice.slug);

    // Issuing posts DR Accounts Receivable / CR Revenue. A send that reports
    // failure must not have moved the books.
    assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
  });

  test("a successful send answers with the new slug the caller must move to", async () => {
    await withEmail();
    const invoice = await draftInvoice();

    const response = await sendInvoice(invoice.slug);

    assert.equal(response.status, 200);
    assert.equal(response.body.invoice?.slug, "acme-corp-inv-0001");
    assert.equal(response.body.invoice?.number, "ACME-CORP-INV-0001");
    assert.equal(response.body.invoice?.status, "sent");
    assert.notEqual(response.body.invoice?.slug, invoice.slug);
    assert.equal(response.body.send?.status, "skipped");
    assert.equal(await invoiceResolves("acme-corp-inv-0001"), true);
  });

  test("an explicit recipient sends an invoice whose customer has no address on file", async () => {
    const invoice = await draftInvoice();

    const response = await sendInvoice(invoice.slug, {
      to: ["billing@acme.example"],
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.invoice?.slug, "acme-corp-inv-0001");
  });

  test("a customer deleted out from under the draft is refused without issuing", async () => {
    const invoice = await draftInvoice();
    await AppDataSource.getRepository(Customer).delete({ id: customer.id });

    const response = await sendInvoice(invoice.slug);

    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /customer not found/i);
    const after = await AppDataSource.getRepository(Invoice).findOneByOrFail({
      id: invoice.id,
    });
    assert.equal(after.slug, invoice.slug);
    assert.equal(after.status, "draft");
    assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
  });

  test("resending an already-issued invoice reports the failure without touching the row", async () => {
    await withEmail();
    const invoice = await draftInvoice();
    await sendInvoice(invoice.slug);
    customer.email = "";
    await AppDataSource.getRepository(Customer).save(customer);

    const response = await sendInvoice("acme-corp-inv-0001");

    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /no email address/i);
    assert.equal(await invoiceResolves("acme-corp-inv-0001"), true);
  });

  test("a non-positive total is still refused before anything is issued", async () => {
    await withEmail();
    const invoice = await draftInvoice();
    await AppDataSource.getRepository(Invoice).update(
      { id: invoice.id },
      { subtotalCents: 0, totalCents: 0, balanceCents: 0 },
    );

    const response = await sendInvoice(invoice.slug);

    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /non-positive total/i);
    assert.equal(await invoiceResolves(invoice.slug), true);
  });

  test("a ledger refusal rolls the issue back rather than stranding the invoice", async () => {
    await withEmail();
    const invoice = await draftInvoice();
    // A foreign-currency invoice with no exchange rate on file: issuing mints
    // the number and renames the row, and only then does `postInvoiceIssue`
    // discover it cannot convert. That used to leave a renamed, unposted
    // invoice behind a URL nobody had been given — the same "doesn't exist"
    // dead end by a different route.
    await AppDataSource.getRepository(Invoice).update(
      { id: invoice.id },
      { currency: "EUR" },
    );

    const response = await sendInvoice(invoice.slug);

    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /exchange rate/i);
    const after = await AppDataSource.getRepository(Invoice).findOneByOrFail({
      id: invoice.id,
    });
    assert.equal(after.slug, invoice.slug, "the draft keeps its slug");
    assert.equal(after.status, "draft");
    assert.equal(after.number, "", "the gapless number is not burned");
    assert.equal(after.numberSeq, 0);
    assert.equal(await invoiceResolves(invoice.slug), true);
    assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
  });

  test("a rolled-back issue leaves the number free for the next one", async () => {
    await withEmail();
    const failed = await draftInvoice();
    await AppDataSource.getRepository(Invoice).update(
      { id: failed.id },
      { currency: "EUR" },
    );
    await sendInvoice(failed.slug);

    // Gapless numbering means a failed issue must not consume a sequence.
    const next = await draftInvoice();
    const response = await sendInvoice(next.slug);

    assert.equal(response.status, 200);
    assert.equal(response.body.invoice?.number, "ACME-CORP-INV-0001");
  });

  test("a voided invoice is still refused outright", async () => {
    await withEmail();
    const invoice = await draftInvoice();
    await AppDataSource.getRepository(Invoice).update(
      { id: invoice.id },
      { status: "void" },
    );

    const response = await sendInvoice(invoice.slug);

    assert.equal(response.status, 409);
    assert.match(response.body.error ?? "", /voided/i);
  });
});
