import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Customer } from "../db/entities/Customer.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
} from "../test/dbHarness.js";
import { resolveEstimateRecipient } from "./estimates.js";
import { resolveInvoiceRecipients } from "./finance.js";

/**
 * The preflight both `/send` routes run before they auto-issue a draft.
 *
 * Issuing renumbers the row and changes its slug, so every reason a send
 * cannot be addressed has to be discoverable *before* that happens —
 * otherwise the caller is told "failed" about a document that was issued
 * anyway, under a URL it was never given. These are the reasons.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY = "co_send_recipients";

async function customer(fields: Partial<Customer> = {}): Promise<Customer> {
  return insert(Customer, {
    companyId: COMPANY,
    name: "Acme Corp",
    slug: "acme-corp",
    currency: "USD",
    ...fields,
  });
}

async function estimateFor(customerId: string): Promise<Estimate> {
  return insert(Estimate, {
    companyId: COMPANY,
    customerId,
    slug: "edraft-abc123",
    status: "draft",
    currency: "USD",
    issueDate: new Date("2026-08-06T00:00:00.000Z"),
    validUntil: new Date("2026-09-05T00:00:00.000Z"),
  });
}

async function invoiceFor(customerId: string): Promise<Invoice> {
  return insert(Invoice, {
    companyId: COMPANY,
    customerId,
    slug: "draft-abc123",
    status: "draft",
    currency: "USD",
    issueDate: new Date("2026-08-06T00:00:00.000Z"),
    dueDate: new Date("2026-09-05T00:00:00.000Z"),
  });
}

describe("resolveEstimateRecipient", () => {
  test("returns the customer when there is an address to send to", async () => {
    const c = await customer({ email: "ap@acme.example" });

    const resolved = await resolveEstimateRecipient(
      COMPANY,
      await estimateFor(c.id),
    );

    assert.equal(resolved.id, c.id);
    assert.equal(resolved.email, "ap@acme.example");
  });

  test("refuses a customer with no address, in words that say what to do", async () => {
    const c = await customer({ email: "" });
    const estimate = await estimateFor(c.id);

    await assert.rejects(
      () => resolveEstimateRecipient(COMPANY, estimate),
      /no email address/i,
    );
  });

  test("refuses when the customer row is gone", async () => {
    const estimate = await estimateFor("cust_deleted");

    await assert.rejects(
      () => resolveEstimateRecipient(COMPANY, estimate),
      /customer not found/i,
    );
  });

  test("will not reach across companies for a customer", async () => {
    const c = await customer({ email: "ap@acme.example" });
    const estimate = await estimateFor(c.id);

    await assert.rejects(
      () => resolveEstimateRecipient("co_someone_else", estimate),
      /customer not found/i,
    );
  });
});

describe("resolveInvoiceRecipients", () => {
  test("defaults to the customer's address on file", async () => {
    const c = await customer({ email: "ap@acme.example" });

    const resolved = await resolveInvoiceRecipients(
      COMPANY,
      await invoiceFor(c.id),
    );

    assert.deepEqual(resolved.to, ["ap@acme.example"]);
    assert.equal(resolved.customer.id, c.id);
  });

  test("an explicit recipient list stands in for a missing address on file", async () => {
    const c = await customer({ email: "" });

    const resolved = await resolveInvoiceRecipients(
      COMPANY,
      await invoiceFor(c.id),
      { to: ["billing@acme.example"] },
    );

    assert.deepEqual(resolved.to, ["billing@acme.example"]);
  });

  test("refuses a customer with no address and no explicit recipient", async () => {
    const c = await customer({ email: "" });
    const invoice = await invoiceFor(c.id);

    await assert.rejects(
      () => resolveInvoiceRecipients(COMPANY, invoice),
      /no email address/i,
    );
  });

  test("refuses an explicit list that normalizes away to nothing", async () => {
    const c = await customer({ email: "ap@acme.example" });
    const invoice = await invoiceFor(c.id);

    // Blank-but-present is the shape that used to slip past the address check
    // and fail deep inside the send, after the invoice had been issued.
    await assert.rejects(
      () => resolveInvoiceRecipients(COMPANY, invoice, { to: ["   "] }),
      /at least one To recipient/i,
    );
  });

  test("de-duplicates recipients case-insensitively", async () => {
    const c = await customer({ email: "ap@acme.example" });

    const resolved = await resolveInvoiceRecipients(
      COMPANY,
      await invoiceFor(c.id),
      { to: ["AP@acme.example", "ap@acme.example", "second@acme.example"] },
    );

    assert.deepEqual(resolved.to, ["AP@acme.example", "second@acme.example"]);
  });

  test("refuses when the customer row is gone", async () => {
    const invoice = await invoiceFor("cust_deleted");

    await assert.rejects(
      () => resolveInvoiceRecipients(COMPANY, invoice),
      /customer not found/i,
    );
  });
});
