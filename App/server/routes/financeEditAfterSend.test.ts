import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { overrideRuntimeSettingsForTests } from "../services/runtimeSettings.js";
import { AppDataSource } from "../db/datasource.js";
import { AccountingPeriod } from "../db/entities/AccountingPeriod.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerCredit } from "../db/entities/CustomerCredit.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { accountByCode, seedChartOfAccounts, trialBalance } from "../services/ledger.js";
import { documentRevisionState } from "../services/documentRevisions.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * An invoice or estimate that has gone out can still be wrong, and the fix is
 * to correct it and resend it under the same number — not to void it and
 * start over. These are the guarantees that make that safe:
 *
 *   - the books follow the edit: an `invoice_revision` entry brings AR,
 *     revenue and tax to what the invoice now says, and a later void reverses
 *     the revisions along with the original;
 *   - an edit can't strand money already applied, rewrite a closed period, or
 *     change who the numbered document belongs to;
 *   - an accepted estimate the customer hasn't seen in its new form is no
 *     longer marked accepted;
 *   - one payment settles one invoice once: its reference can't be recorded a
 *     second time, by a Member or by an AI Employee, and a payment matched to
 *     one bank line can't be matched to another.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let mcpToken = "";
let company: Company;
let customer: Customer;
let otherCustomer: Customer;

const originalLog = console.log;
const originalWarn = console.warn;

before(async () => {
  await initTestDb();
  // Keep the PDF renderer from launching a real browser (see
  // financeSendStrandedSlug.test.ts).
  overrideRuntimeSettingsForTests({
    browser: { executablePath: "/nonexistent/chrome-for-tests" },
  });
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
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
  if (mcpToken) revokeMcpToken(mcpToken);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  overrideRuntimeSettingsForTests(null);
});

beforeEach(async () => {
  if (mcpToken) revokeMcpToken(mcpToken);
  mcpToken = "";
  await resetTestDb();
  const owner = await insert(User, {
    email: `finance-owner-${randomUUID()}@example.com`,
    name: "Finance Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Edit test",
    slug: `edit-test-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    currency: "USD",
  });
  otherCustomer = await insert(Customer, {
    companyId: company.id,
    name: "Globex",
    slug: "globex",
    currency: "USD",
  });
  await seedChartOfAccounts(company.id);
});

type Doc = {
  id: string;
  slug: string;
  number: string;
  status: string;
  currency: string;
  issueDate: string;
  dueDate?: string;
  validUntil?: string;
  acceptedAt?: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents?: number;
  balanceCents?: number;
  paidAt?: string | null;
  notes: string;
  lines: Array<{ id: string; description: string; taxPercent: number; lineTotalCents: number }>;
  payments?: Array<{ id: string; reference: string }>;
  revision?: { revisedAt: string | null; emailedAt: string | null };
  error?: string;
};

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Doc }> {
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Doc };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

type LineInput = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
};

const CONSULTING: LineInput[] = [
  { description: "Consulting", quantity: 1, unitPriceCents: 100_000 },
];

/** A line as the edit form sends it back: every field it loaded. */
function asSent(lines: LineInput[]): Array<LineInput & { productId: null; sortOrder: number }> {
  return lines.map((l, i) => ({ productId: null, taxRateId: null, ...l, sortOrder: i }));
}

async function issuedInvoice(
  lines: LineInput[] = CONSULTING,
  issueDate = "2026-09-10T00:00:00.000Z",
): Promise<Doc> {
  const draft = await call("POST", "/invoices", {
    customerId: customer.id,
    issueDate,
    dueDate: "2026-10-10T00:00:00.000Z",
    lines,
  });
  assert.equal(draft.status, 200, draft.body.error);
  const issued = await call("POST", `/invoices/${draft.body.slug}/issue`);
  assert.equal(issued.status, 200, issued.body.error);
  return issued.body;
}

async function issuedEstimate(lines: LineInput[] = CONSULTING): Promise<Doc> {
  const draft = await call("POST", "/estimates", {
    customerId: customer.id,
    issueDate: "2026-09-10T00:00:00.000Z",
    validUntil: "2026-12-10T00:00:00.000Z",
    lines,
  });
  assert.equal(draft.status, 200, draft.body.error);
  const issued = await call("POST", `/estimates/${draft.body.slug}/issue`);
  assert.equal(issued.status, 200, issued.body.error);
  return issued.body;
}

/** Signed (debit − credit) balance of each account code across the books. */
async function balances(): Promise<Record<string, number>> {
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { companyId: company.id },
  });
  const out: Record<string, number> = {};
  for (const code of ["1100", "1200", "2100", "4000"]) {
    const account = await accountByCode(company.id, code);
    out[code] = lines
      .filter((l) => l.accountId === account!.id)
      .reduce((s, l) => s + l.debitCents - l.creditCents, 0);
  }
  return out;
}

async function entriesBySource(source: string): Promise<LedgerEntry[]> {
  return AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId: company.id, source: source as LedgerEntry["source"] },
    order: { date: "ASC" },
  });
}

async function auditRows(action: string): Promise<AuditEvent[]> {
  return AppDataSource.getRepository(AuditEvent).find({
    where: { companyId: company.id, action },
  });
}

describe("editing a sent invoice", () => {
  test("keeps its number and brings the books to the new amounts", async () => {
    const inv = await issuedInvoice();

    const edit = await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([{ description: "Consulting", quantity: 2, unitPriceCents: 100_000 }]),
    });

    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(edit.body.slug, inv.slug);
    assert.equal(edit.body.number, inv.number);
    assert.equal(edit.body.status, "sent");
    assert.equal(edit.body.totalCents, 200_000);
    assert.equal(edit.body.balanceCents, 200_000);
    assert.deepEqual(await balances(), { "1100": 0, "1200": 200_000, "2100": 0, "4000": -200_000 });
    assert.equal((await entriesBySource("invoice_issue")).length, 1, "the original stays");
    assert.equal((await entriesBySource("invoice_revision")).length, 1);
    const [revised] = await auditRows("finance.invoice.revise");
    assert.ok(revised, "the History says it was edited after it was sent");
    assert.deepEqual(JSON.parse(revised.metadataJson).fields, ["lines"]);
    assert.equal(JSON.parse(revised.metadataJson).previousTotalCents, 100_000);
  });

  test("corrects tax payable as well as revenue", async () => {
    const vat = await insert(TaxRate, { companyId: company.id, name: "VAT", ratePercent: 10 });
    const inv = await issuedInvoice([{ ...CONSULTING[0], taxRateId: vat.id }]);
    assert.equal(inv.totalCents, 110_000);

    const edit = await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([
        { description: "Consulting", quantity: 1, unitPriceCents: 200_000, taxRateId: vat.id },
      ]),
    });

    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(edit.body.totalCents, 220_000);
    assert.deepEqual(await balances(), {
      "1100": 0,
      "1200": 220_000,
      "2100": -20_000,
      "4000": -200_000,
    });
  });

  test("keeps the tax rate it was issued with when that rate later changes", async () => {
    const vat = await insert(TaxRate, { companyId: company.id, name: "VAT", ratePercent: 10 });
    const inv = await issuedInvoice([{ ...CONSULTING[0], taxRateId: vat.id }]);
    vat.ratePercent = 20;
    await AppDataSource.getRepository(TaxRate).save(vat);

    const edit = await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([
        { ...CONSULTING[0], taxRateId: vat.id },
        { description: "Travel", quantity: 1, unitPriceCents: 5_000 },
      ]),
    });

    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(edit.body.lines[0].taxPercent, 10, "the issued line keeps its 10%");
    assert.equal(edit.body.totalCents, 115_000);
  });

  test("a save that changes nothing rewrites nothing", async () => {
    const inv = await issuedInvoice(CONSULTING, "2026-09-10T15:30:00.000Z");
    const before = await AppDataSource.getRepository(InvoiceLineItem).findBy({ invoiceId: inv.id });

    // What the form sends: the same day at midnight, and every line it loaded.
    const edit = await call("PATCH", `/invoices/${inv.slug}`, {
      customerId: customer.id,
      subsidiaryId: null,
      issueDate: "2026-09-10T00:00:00.000Z",
      dueDate: "2026-10-10T00:00:00.000Z",
      currency: "USD",
      notes: "",
      footer: "",
      lines: asSent(CONSULTING),
    });

    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(edit.body.issueDate, "2026-09-10T15:30:00.000Z", "the stored moment stays");
    const after = await AppDataSource.getRepository(InvoiceLineItem).findBy({ invoiceId: inv.id });
    assert.deepEqual(
      after.map((l) => l.id),
      before.map((l) => l.id),
    );
    assert.equal((await entriesBySource("invoice_revision")).length, 0);
    assert.equal((await auditRows("finance.invoice.revise")).length, 0);
  });

  test("moving the issue date moves the revenue to the new period", async () => {
    const inv = await issuedInvoice(CONSULTING, "2026-09-10T00:00:00.000Z");

    const edit = await call("PATCH", `/invoices/${inv.slug}`, {
      issueDate: "2026-10-02T00:00:00.000Z",
    });

    assert.equal(edit.status, 200, edit.body.error);
    const ar = async (asOf: string) =>
      (await trialBalance(company.id, new Date(asOf))).find((r) => r.account.code === "1200")!
        .balanceCents;
    assert.equal(await ar("2026-09-30T00:00:00.000Z"), 0, "September no longer carries it");
    assert.equal(await ar("2026-10-31T00:00:00.000Z"), 100_000);
    const revisions = await entriesBySource("invoice_revision");
    assert.deepEqual(
      revisions.map((e) => e.date.toISOString().slice(0, 10)),
      ["2026-09-10", "2026-10-02"],
    );
  });

  test("voiding a revised invoice reverses the revision too", async () => {
    const inv = await issuedInvoice();
    await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([{ description: "Consulting", quantity: 3, unitPriceCents: 100_000 }]),
    });

    const voided = await call("POST", `/invoices/${inv.slug}/void`);

    assert.equal(voided.status, 200, voided.body.error);
    assert.deepEqual(await balances(), { "1100": 0, "1200": 0, "2100": 0, "4000": 0 });
  });

  test("the customer and issuer stay fixed", async () => {
    const inv = await issuedInvoice();

    const customerChange = await call("PATCH", `/invoices/${inv.slug}`, {
      customerId: otherCustomer.id,
    });
    const issuerChange = await call("PATCH", `/invoices/${inv.slug}`, {
      subsidiaryId: randomUUID(),
    });

    assert.equal(customerChange.status, 409);
    assert.match(customerChange.body.error ?? "", /customer can't change/);
    assert.equal(issuerChange.status, 409);
    assert.match(issuerChange.body.error ?? "", /issuer can't change/);
  });

  test("the total can't drop below what has been paid", async () => {
    const inv = await issuedInvoice();
    const paid = await call("POST", `/invoices/${inv.slug}/payments`, {
      amountCents: 60_000,
      reference: "WIRE-1",
    });
    assert.equal(paid.status, 200, paid.body.error);

    const tooLow = await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([{ description: "Consulting", quantity: 1, unitPriceCents: 50_000 }]),
    });
    const currency = await call("PATCH", `/invoices/${inv.slug}`, { currency: "EUR" });
    const lower = await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([{ description: "Consulting", quantity: 1, unitPriceCents: 80_000 }]),
    });

    assert.equal(tooLow.status, 400);
    assert.match(tooLow.body.error ?? "", /less than the \$600\.00 already paid/);
    assert.equal(currency.status, 409);
    assert.equal(lower.status, 200, lower.body.error);
    assert.equal(lower.body.balanceCents, 20_000);
    assert.deepEqual(await balances(), {
      "1100": 60_000,
      "1200": 20_000,
      "2100": 0,
      "4000": -80_000,
    });
  });

  test("a paid invoice edited upward is open again", async () => {
    const inv = await issuedInvoice();
    await call("POST", `/invoices/${inv.slug}/payments`, { amountCents: 100_000 });

    const edit = await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([{ description: "Consulting", quantity: 1, unitPriceCents: 125_000 }]),
    });

    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(edit.body.status, "sent");
    assert.equal(edit.body.balanceCents, 25_000);
    assert.equal(edit.body.paidAt, null);
  });

  test("a closed period refuses changed amounts but not a new due date", async () => {
    const inv = await issuedInvoice(CONSULTING, "2026-09-10T00:00:00.000Z");
    await insert(AccountingPeriod, {
      companyId: company.id,
      name: "September 2026",
      startDate: new Date("2026-09-01T00:00:00.000Z"),
      endDate: new Date("2026-09-30T23:59:59.999Z"),
      status: "closed",
    });

    const amounts = await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([{ description: "Consulting", quantity: 2, unitPriceCents: 100_000 }]),
    });
    const terms = await call("PATCH", `/invoices/${inv.slug}`, {
      dueDate: "2026-11-10T00:00:00.000Z",
      notes: "Net 60, as agreed.",
    });

    assert.equal(amounts.status, 409);
    assert.match(amounts.body.error ?? "", /closed period "September 2026"/);
    assert.equal(terms.status, 200, terms.body.error);
    assert.equal(terms.body.notes, "Net 60, as agreed.");
    assert.equal(terms.body.totalCents, 100_000);
    assert.equal((await entriesBySource("invoice_revision")).length, 0);
  });

  test("a positive total stays required", async () => {
    const inv = await issuedInvoice();

    const zero = await call("PATCH", `/invoices/${inv.slug}`, {
      lines: asSent([{ description: "Consulting", quantity: 0, unitPriceCents: 100_000 }]),
    });

    assert.equal(zero.status, 400);
    assert.match(zero.body.error ?? "", /positive total/);
  });

  test("a voided invoice can't be edited", async () => {
    const inv = await issuedInvoice();
    await call("POST", `/invoices/${inv.slug}/void`);

    const edit = await call("PATCH", `/invoices/${inv.slug}`, { notes: "too late" });

    assert.equal(edit.status, 409);
  });

  test("the detail read says when it changed after it was last emailed", async () => {
    const inv = await issuedInvoice();
    await insert(AuditEvent, {
      companyId: company.id,
      actorKind: "user",
      action: "finance.invoice.send",
      targetType: "invoice",
      targetId: inv.id,
      targetLabel: inv.number,
      metadataJson: JSON.stringify({ status: "sent" }),
      createdAt: new Date("2026-09-10T09:00:00.000Z"),
    });

    const sentOnly = await call("GET", `/invoices/${inv.slug}`);
    await call("PATCH", `/invoices/${inv.slug}`, { notes: "Updated PO number" });
    const edited = await call("GET", `/invoices/${inv.slug}`);

    assert.equal(sentOnly.body.revision?.revisedAt, null);
    assert.equal(sentOnly.body.revision?.emailedAt, "2026-09-10T09:00:00.000Z");
    assert.ok(edited.body.revision?.revisedAt);
    assert.ok(
      new Date(edited.body.revision!.revisedAt!) > new Date(edited.body.revision!.emailedAt!),
    );
  });
});

describe("documentRevisionState", () => {
  test("counts only emails that were delivered, from a Member or an AI Employee", async () => {
    const targetId = randomUUID();
    const row = (action: string, metadata: object, at: string) =>
      insert(AuditEvent, {
        companyId: company.id,
        actorKind: "user",
        action,
        targetType: "estimate",
        targetId,
        targetLabel: "EST",
        metadataJson: JSON.stringify(metadata),
        createdAt: new Date(at),
      });
    await row("finance.estimate.send", { sendStatus: "sent" }, "2026-09-01T10:00:00.000Z");
    await row("finance.estimate.revise", {}, "2026-09-02T10:00:00.000Z");
    await row("finance.estimate.send", { status: "failed" }, "2026-09-03T10:00:00.000Z");

    const state = await documentRevisionState(company.id, "estimate", targetId);

    assert.equal(state.emailedAt?.toISOString(), "2026-09-01T10:00:00.000Z");
    assert.equal(state.revisedAt?.toISOString(), "2026-09-02T10:00:00.000Z");
  });
});

describe("editing a sent estimate", () => {
  test("keeps its number and takes the new lines", async () => {
    const est = await issuedEstimate();

    const edit = await call("PATCH", `/estimates/${est.slug}`, {
      lines: asSent([{ description: "Consulting", quantity: 4, unitPriceCents: 100_000 }]),
    });

    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(edit.body.number, est.number);
    assert.equal(edit.body.status, "sent");
    assert.equal(edit.body.totalCents, 400_000);
    assert.equal((await auditRows("finance.estimate.revise")).length, 1);
    assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0, "no books touched");
  });

  test("an accepted estimate goes back to sent once it changes", async () => {
    const est = await issuedEstimate();
    await call("POST", `/estimates/${est.slug}/accept`);

    const unchanged = await call("PATCH", `/estimates/${est.slug}`, { lines: asSent(CONSULTING) });
    const edit = await call("PATCH", `/estimates/${est.slug}`, { notes: "Adds a second visit." });

    assert.equal(unchanged.body.status, "accepted", "a save that changes nothing keeps it");
    assert.equal(edit.status, 200, edit.body.error);
    assert.equal(edit.body.status, "sent");
    assert.equal(edit.body.acceptedAt, null);
    const [revised] = await auditRows("finance.estimate.revise");
    assert.equal(JSON.parse(revised.metadataJson).previousStatus, "accepted");
  });

  test("declined, voided and converted estimates stay closed", async () => {
    const declined = await issuedEstimate();
    await call("POST", `/estimates/${declined.slug}/decline`);
    const voided = await issuedEstimate();
    await call("POST", `/estimates/${voided.slug}/void`);
    const converted = await issuedEstimate();
    assert.equal((await call("POST", `/estimates/${converted.slug}/convert`, {})).status, 200);

    for (const est of [declined, voided, converted]) {
      const edit = await call("PATCH", `/estimates/${est.slug}`, { notes: "One more thing" });
      assert.equal(edit.status, 409, `${est.slug} should refuse the edit`);
    }
  });

  test("the customer stays fixed", async () => {
    const est = await issuedEstimate();

    const edit = await call("PATCH", `/estimates/${est.slug}`, { customerId: otherCustomer.id });

    assert.equal(edit.status, 409);
  });
});

describe("recording the same payment twice", () => {
  test("a reference recorded on one invoice is refused on another", async () => {
    const first = await issuedInvoice();
    const second = await issuedInvoice();

    const recorded = await call("POST", `/invoices/${first.slug}/payments`, {
      amountCents: 10_000,
      reference: "TXN-42",
    });
    const again = await call("POST", `/invoices/${second.slug}/payments`, {
      amountCents: 10_000,
      reference: "TXN-42",
    });
    const respelled = await call("POST", `/invoices/${second.slug}/payments`, {
      amountCents: 10_000,
      reference: "  txn-42 ",
    });
    const sameInvoice = await call("POST", `/invoices/${first.slug}/payments`, {
      amountCents: 10_000,
      reference: "TXN-42",
    });

    assert.equal(recorded.status, 200, recorded.body.error);
    assert.equal(again.status, 409);
    assert.match(again.body.error ?? "", new RegExp(`already recorded on ${first.number}`));
    assert.equal(respelled.status, 409);
    assert.equal(sameInvoice.status, 409);
    assert.match(sameInvoice.body.error ?? "", /already recorded on this invoice/);
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 1);
    assert.equal((await entriesBySource("invoice_payment")).length, 1);
  });

  test("payments without a reference are never treated as the same payment", async () => {
    const inv = await issuedInvoice();

    const one = await call("POST", `/invoices/${inv.slug}/payments`, { amountCents: 10_000 });
    const two = await call("POST", `/invoices/${inv.slug}/payments`, {
      amountCents: 10_000,
      reference: "",
    });

    assert.equal(one.status, 200, one.body.error);
    assert.equal(two.status, 200, two.body.error);
  });

  test("deleting the payment frees its reference for the right invoice", async () => {
    const wrong = await issuedInvoice();
    const right = await issuedInvoice();
    const recorded = await call("POST", `/invoices/${wrong.slug}/payments`, {
      amountCents: 10_000,
      reference: "TXN-7",
    });
    const paymentId = recorded.body.payments![0].id;

    await call("DELETE", `/invoices/${wrong.slug}/payments/${paymentId}`);
    const moved = await call("POST", `/invoices/${right.slug}/payments`, {
      amountCents: 10_000,
      reference: "TXN-7",
    });

    assert.equal(moved.status, 200, moved.body.error);
  });

  test("a duplicate is not turned into an overpayment credit", async () => {
    const inv = await issuedInvoice();
    await call("POST", `/invoices/${inv.slug}/payments`, {
      amountCents: 100_000,
      reference: "FULL-1",
    });

    const duplicate = await call("POST", `/invoices/${inv.slug}/payments`, {
      amountCents: 100_000,
      reference: "FULL-1",
      allowOverpayment: true,
    });

    assert.equal(duplicate.status, 409);
    assert.equal(await AppDataSource.getRepository(CustomerCredit).count(), 0);
  });

  test("an AI Employee can't record a payment a Member already recorded", async () => {
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Finance partner",
      slug: "finance-partner",
      role: "Finance partner",
      soulBody: "",
    });
    await insert(EmployeeFinanceGrant, {
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: "invoice",
    });
    mcpToken = issueMcpToken(employee.id, company.id, { authority: "employee" });
    const first = await issuedInvoice();
    const second = await issuedInvoice();
    await call("POST", `/invoices/${first.slug}/payments`, {
      amountCents: 10_000,
      reference: "ch_3PayOnce",
    });

    const response = await fetch(`${baseUrl}/internal/mcp/tools/record_payment`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        invoiceSlug: second.slug,
        amountCents: 10_000,
        reference: "ch_3PayOnce",
      }),
    });
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 409);
    assert.match(body.error ?? "", /already recorded/);
    assert.match(body.error ?? "", /do not record it again/);
    assert.equal(await AppDataSource.getRepository(InvoicePayment).count(), 1);
  });
});

describe("matching a payment to bank lines", () => {
  test("a payment matched to one bank line can't be matched to another", async () => {
    const inv = await issuedInvoice();
    const paid = await call("POST", `/invoices/${inv.slug}/payments`, { amountCents: 100_000 });
    const paymentId = paid.body.payments![0].id;
    const bank = await accountByCode(company.id, "1100");
    const feed = await insert(BankFeed, {
      companyId: company.id,
      name: "Operating",
      kind: "csv",
      accountId: bank!.id,
    });
    const line = (description: string) =>
      insert(BankTransaction, {
        companyId: company.id,
        feedId: feed.id,
        date: new Date("2026-09-12T00:00:00.000Z"),
        amountCents: 100_000,
        description,
      });
    const deposit = await line("ACME CORP");
    const echo = await line("ACME CORP (duplicate import)");

    const matched = await call("POST", `/bank-transactions/${deposit.id}/match`, { paymentId });
    const again = await call("POST", `/bank-transactions/${echo.id}/match`, { paymentId });
    const rematch = await call("POST", `/bank-transactions/${deposit.id}/match`, { paymentId });

    assert.equal(matched.status, 200, matched.body.error);
    assert.equal(again.status, 400);
    assert.match(again.body.error ?? "", /already matched/);
    assert.equal(rematch.status, 200, "the line that holds it can be matched again");
  });
});
