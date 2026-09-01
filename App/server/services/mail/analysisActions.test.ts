import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import type { FindOptionsWhere } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { Customer } from "../../db/entities/Customer.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { Estimate } from "../../db/entities/Estimate.js";
import { EstimateLineItem } from "../../db/entities/EstimateLineItem.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { InvoiceLineItem } from "../../db/entities/InvoiceLineItem.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import { parseAnalysisActions, type MailAnalysisAction } from "./analysis.js";
import {
  executeAnalysisAction,
  MailAnalysisActionError,
  resolveOrCreateCustomer,
  type MailAnalysisActor,
} from "./analysisActions.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_analysis_actions_test";
const OTHER_COMPANY_ID = "co_mail_analysis_actions_other";
const ACTOR: MailAnalysisActor = {
  userId: "user_analysis_actions",
  sessionVersion: 0,
  financeAccess: "full",
};
/** A Member the owner turned down to read-only finance access. */
const READ_ONLY_FINANCE: MailAnalysisActor = { ...ACTOR, financeAccess: "read" };
/**
 * Every mailbox fixture points at a connection row that does not exist, so the
 * three Gmail-backed kinds fail at `accessTokenForAccount` — deterministically,
 * without a socket, and only after everything this module owns has run.
 */
const NO_CONNECTION = /Google connection behind this mailbox was deleted/;

type Scene = {
  account: MailAccount;
  thread: MailThread;
  message: MailMessage;
  analysis: MailInboundAnalysis;
};

async function mailbox(overrides: Partial<MailAccount> = {}): Promise<MailAccount> {
  return insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: testId("connection"),
    address: "owner@example.com",
    status: "active",
    ...overrides,
  });
}

async function customer(overrides: Partial<Customer> = {}): Promise<Customer> {
  return insert(Customer, {
    companyId: COMPANY_ID,
    name: "Northwind Labs",
    slug: testId("customer"),
    email: "",
    domain: "",
    accountStatus: "customer",
    ...overrides,
  });
}

function invoiceAction(
  overrides: Partial<Extract<MailAnalysisAction, { kind: "create_invoice" }>> = {},
): MailAnalysisAction {
  return {
    id: "0",
    kind: "create_invoice",
    label: "Create the invoice",
    customerName: "Northwind Labs",
    currency: "EUR",
    notes: "Banner work, as agreed on the call.",
    lines: [
      { description: "Banner set", quantity: 2, unitPriceCents: 5_000 },
      { description: "Landing page", quantity: 1.5, unitPriceCents: 999 },
    ],
    targetTotalCents: 11_499,
    ...overrides,
  };
}

function estimateAction(
  overrides: Partial<Extract<MailAnalysisAction, { kind: "create_estimate" }>> = {},
): MailAnalysisAction {
  return {
    id: "1",
    kind: "create_estimate",
    label: "Draft the estimate",
    customerName: "Northwind Labs",
    currency: "EUR",
    notes: "Quote for the banner refresh.",
    lines: [
      { description: "Discovery", quantity: 3, unitPriceCents: 12_000 },
      { description: "Revisions", quantity: 0.5, unitPriceCents: 8_001 },
    ],
    targetTotalCents: 40_001,
    ...overrides,
  };
}

/** One mailbox, one thread, one inbound email, and the analysis under it. */
async function scene(
  actions: MailAnalysisAction[],
  message: Partial<MailMessage> = {},
  analysis: Partial<MailInboundAnalysis> = {},
): Promise<Scene> {
  const account = await mailbox();
  const thread = await insert(MailThread, {
    companyId: account.companyId,
    accountId: account.id,
    gmailThreadId: testId("gmail_thread"),
    subject: "Two banners and a landing page",
  });
  const inbound = await insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: testId("gmail_message"),
    gmailThreadId: thread.gmailThreadId,
    fromName: "Ada Lovelace",
    fromEmail: "ada@northwind-labs.example",
    toEmails: account.address,
    subject: thread.subject,
    bodyText: "Please invoice us for the banners.",
    ...message,
  });
  const row = await insert(MailInboundAnalysis, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: thread.id,
    messageId: inbound.id,
    status: "succeeded",
    employeeId: testId("employee"),
    modelId: testId("model"),
    category: "invoice_request",
    summary: "Asks to be billed for the banner work.",
    actionsJson: JSON.stringify(actions),
    ...analysis,
  });
  return { account, thread, message: inbound, analysis: row };
}

async function storedActions(analysisId: string): Promise<MailAnalysisAction[]> {
  const row = await AppDataSource.getRepository(MailInboundAnalysis).findOneByOrFail({
    id: analysisId,
  });
  return parseAnalysisActions(row.actionsJson);
}

async function countOf<T extends object>(
  entity: new () => T,
  where: FindOptionsWhere<T>,
): Promise<number> {
  return AppDataSource.getRepository(entity).countBy(where);
}

describe("resolving the counterparty behind a pressed button", () => {
  test("matches the exact address whichever case either side stores it in", async () => {
    const existing = await customer({
      name: "Old Display Name",
      email: "Billing@Northwind-Labs.Example",
    });

    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "Someone Entirely Else",
      email: "BILLING@northwind-labs.example",
    });

    assert.equal(resolved.id, existing.id);
    assert.equal(resolved.name, "Old Display Name");
    assert.equal(await countOf(Customer, { companyId: COMPANY_ID }), 1);
  });

  test("prefers the exact address over a customer sharing the sender's domain", async () => {
    const byDomain = await customer({ name: "Northwind Labs", domain: "northwind-labs.example" });
    const byEmail = await customer({
      name: "Ada at Northwind",
      slug: testId("customer"),
      email: "ada@northwind-labs.example",
    });

    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "Ada Lovelace",
      email: "ada@northwind-labs.example",
    });

    assert.equal(resolved.id, byEmail.id);
    assert.notEqual(resolved.id, byDomain.id);
  });

  test("falls back to the company domain when the address itself is new", async () => {
    const existing = await customer({ domain: "northwind-labs.example" });

    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "A New Hire",
      email: "newhire@northwind-labs.example",
    });

    assert.equal(resolved.id, existing.id);
    assert.equal(await countOf(Customer, { companyId: COMPANY_ID }), 1);
  });

  test("never joins two senders through a shared free-mail host", async () => {
    for (const host of ["gmail.com", "outlook.com", "icloud.com"]) {
      const squatter = await customer({
        name: `First ${host} signup`,
        slug: testId("customer"),
        email: `first@${host}`,
        domain: host,
      });

      const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
        name: `Second ${host} signup`,
        email: `second@${host}`,
      });

      assert.notEqual(resolved.id, squatter.id);
      assert.equal(resolved.email, `second@${host}`);
      // The free host must not be written onto the new row either — that row
      // would otherwise become the permanent home of every later sender there.
      assert.equal(resolved.domain, "");
      assert.equal(resolved.accountStatus, "prospect");
    }
  });

  test("never bills an existing customer on the strength of a name from the email", async () => {
    const existing = await customer({ name: "Northwind Labs" });

    // The name is whatever the sender wrote. Matching on it would let anyone
    // who can email the mailbox attach a draft invoice to a real account they
    // have nothing to do with — so an unrecognised address gets its own row.
    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "northwind LABS",
      email: "hello@unrelated-vendor.example",
    });

    assert.notEqual(resolved.id, existing.id);
    assert.equal(resolved.email, "hello@unrelated-vendor.example");
    assert.equal(await countOf(Customer, { companyId: COMPANY_ID }), 2);
  });

  test("mints a distinct slug for two customers whose names slugify identically", async () => {
    const first = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "Acme, Ltd.",
      email: "one@acme-one.example",
    });
    const second = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "Acme Ltd",
      email: "two@acme-two.example",
    });

    assert.notEqual(first.id, second.id);
    assert.equal(first.slug, "acme-ltd");
    assert.equal(second.slug, "acme-ltd-2");
  });

  test("creates prospects carrying the normalized address and the real domain", async () => {
    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "  Ada Lovelace  ",
      email: "Ada.Lovelace@Northwind-Labs.Example",
    });

    assert.equal(resolved.companyId, COMPANY_ID);
    assert.equal(resolved.name, "Ada Lovelace");
    assert.equal(resolved.slug, "ada-lovelace");
    assert.equal(resolved.email, "ada.lovelace@northwind-labs.example");
    assert.equal(resolved.domain, "northwind-labs.example");
    assert.equal(resolved.accountStatus, "prospect");
  });

  test("names an unnamed sender after the address, and a nameless one at all", async () => {
    const named = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "",
      email: "pat@vendor-x.example",
    });
    assert.equal(named.name, "pat@vendor-x.example");
    assert.equal(named.slug, "pat-vendor-x-example");

    const anonymous = await resolveOrCreateCustomer(COMPANY_ID, { name: "", email: "" });
    assert.equal(anonymous.name, "New customer");
    assert.equal(anonymous.slug, "new-customer");
    assert.equal(anonymous.email, "");
    assert.equal(anonymous.domain, "");
  });

  test("bounds an over-long sender name before it reaches the row or the slug", async () => {
    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "N".repeat(250),
      email: "long@vendor-y.example",
    });

    assert.equal(resolved.name.length, 200);
    assert.equal(resolved.slug, "n".repeat(60));
  });

  test("never matches a customer belonging to another company", async () => {
    const foreign = await customer({
      companyId: OTHER_COMPANY_ID,
      name: "Northwind Labs",
      email: "ada@northwind-labs.example",
      domain: "northwind-labs.example",
    });

    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "Northwind Labs",
      email: "ada@northwind-labs.example",
    });

    assert.notEqual(resolved.id, foreign.id);
    assert.equal(resolved.companyId, COMPANY_ID);
    assert.equal(await countOf(Customer, { companyId: OTHER_COMPANY_ID }), 1);
  });
});

describe("guards every pressed button passes first", () => {
  test("refuses an analysis that belongs to another mailbox or another company", async () => {
    const { analysis } = await scene([invoiceAction()]);
    const otherMailbox = await mailbox();
    const foreignCompany = await mailbox({ companyId: OTHER_COMPANY_ID });

    const wrongMailbox = await executeAnalysisAction(otherMailbox, analysis, "0", ACTOR).catch(
      (error: unknown) => error,
    );
    assert.ok(wrongMailbox instanceof MailAnalysisActionError);
    assert.match(wrongMailbox.message, /does not belong to this mailbox/);

    await assert.rejects(
      () =>
        executeAnalysisAction(
          foreignCompany,
          Object.assign(new MailInboundAnalysis(), analysis, { accountId: foreignCompany.id }),
          "0",
          ACTOR,
        ),
      /does not belong to this mailbox/,
    );
    assert.equal(await countOf(Invoice, { companyId: COMPANY_ID }), 0);
  });

  test("refuses an action id that is no longer on this email", async () => {
    const { account, analysis } = await scene([invoiceAction()]);

    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "no-such-action", ACTOR),
      /no longer on this email/,
    );
    assert.equal(await countOf(Invoice, { companyId: COMPANY_ID }), 0);
  });

  test("refuses an action that already carries a stamp", async () => {
    const { account, analysis } = await scene([
      invoiceAction({ executedAt: "2026-08-14T09:00:00.000Z" }),
    ]);

    await assert.rejects(() => executeAnalysisAction(account, analysis, "0", ACTOR), /already run/);
    assert.equal(await countOf(Invoice, { companyId: COMPANY_ID }), 0);
  });

  test("refuses when the mirrored message row is gone, before reaching Gmail", async () => {
    const { account, message, analysis } = await scene([
      { id: "0", kind: "unsubscribe", label: "Unsubscribe", targetHost: "lists.example" },
    ]);
    await AppDataSource.getRepository(MailMessage).delete({ id: message.id });

    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "0", ACTOR),
      /email this action belongs to is gone/,
    );
    assert.equal((await storedActions(analysis.id))[0].executedAt, undefined);
  });

  test("refuses when the thread row is gone, before reaching Gmail", async () => {
    const { account, thread, analysis } = await scene([
      { id: "0", kind: "thread_action", label: "Archive", action: "archive" },
    ]);
    await AppDataSource.getRepository(MailThread).delete({ id: thread.id });

    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "0", ACTOR),
      /thread this action belongs to is gone/,
    );
    assert.equal((await storedActions(analysis.id))[0].executedAt, undefined);
  });

  test("refuses a message mirrored under a different mailbox", async () => {
    const { account, message, analysis } = await scene([invoiceAction()]);
    const otherMailbox = await mailbox();
    await AppDataSource.getRepository(MailMessage).update(
      { id: message.id },
      { accountId: otherMailbox.id },
    );

    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "0", ACTOR),
      /email this action belongs to is gone/,
    );
  });
});

describe("create_invoice", () => {
  test("creates a draft invoice, its lines, and its totals for a brand-new customer", async () => {
    const { account, analysis } = await scene([invoiceAction()]);

    const result = await executeAnalysisAction(account, analysis, "0", ACTOR);

    const invoice = await AppDataSource.getRepository(Invoice).findOneByOrFail({
      companyId: COMPANY_ID,
    });
    const created = await AppDataSource.getRepository(Customer).findOneByOrFail({
      companyId: COMPANY_ID,
    });
    assert.equal(created.name, "Northwind Labs");
    assert.equal(created.email, "ada@northwind-labs.example");
    assert.equal(created.domain, "northwind-labs.example");
    assert.equal(created.accountStatus, "prospect");

    assert.equal(invoice.customerId, created.id);
    assert.equal(invoice.status, "draft");
    assert.equal(invoice.numberSeq, 0);
    assert.equal(invoice.number, "");
    assert.equal(invoice.currency, "EUR");
    assert.equal(invoice.notes, "Banner work, as agreed on the call.");
    assert.equal(invoice.createdById, ACTOR.userId);
    assert.match(invoice.slug, /^draft-[a-z0-9]+$/);
    assert.equal(invoice.subtotalCents, 11_499);
    assert.equal(invoice.taxCents, 0);
    assert.equal(invoice.totalCents, 11_499);
    assert.equal(invoice.paidCents, 0);
    assert.equal(invoice.balanceCents, 11_499);

    const lines = await AppDataSource.getRepository(InvoiceLineItem).find({
      where: { invoiceId: invoice.id },
      order: { sortOrder: "ASC" },
    });
    assert.deepEqual(
      lines.map((line) => [
        line.description,
        line.quantity,
        line.unitPriceCents,
        line.lineTotalCents,
        line.sortOrder,
      ]),
      [
        ["Banner set", 2, 5_000, 10_000, 0],
        ["Landing page", 1.5, 999, 1_499, 1],
      ],
    );

    assert.equal(result.navigateTo, `/finance/invoices/${invoice.slug}/edit`);
    assert.equal(result.message, "Draft invoice created for Northwind Labs");
  });

  test("bills the customer matched on the sender's address, in that customer's currency", async () => {
    const existing = await customer({
      name: "Northwind Labs GmbH",
      email: "ada@northwind-labs.example",
      currency: "GBP",
    });
    const { account, analysis } = await scene([invoiceAction({ currency: undefined })]);

    const result = await executeAnalysisAction(account, analysis, "0", ACTOR);

    const invoice = await AppDataSource.getRepository(Invoice).findOneByOrFail({
      companyId: COMPANY_ID,
    });
    assert.equal(invoice.customerId, existing.id);
    assert.equal(invoice.currency, "GBP");
    assert.equal(result.message, "Draft invoice created for Northwind Labs GmbH");
    assert.equal(await countOf(Customer, { companyId: COMPANY_ID }), 1);
  });

  test("defaults an unpriced invoice for a brand-new customer to USD", async () => {
    const { account, analysis } = await scene([
      invoiceAction({ currency: undefined, notes: undefined }),
    ]);

    await executeAnalysisAction(account, analysis, "0", ACTOR);

    const invoice = await AppDataSource.getRepository(Invoice).findOneByOrFail({
      companyId: COMPANY_ID,
    });
    assert.equal(invoice.currency, "USD");
    assert.equal(invoice.notes, "");
  });
});

describe("create_estimate", () => {
  test("creates a draft estimate with its lines and sends the Member to its edit screen", async () => {
    const { account, analysis } = await scene([estimateAction({ id: "0" })]);

    const result = await executeAnalysisAction(account, analysis, "0", ACTOR);

    const estimate = await AppDataSource.getRepository(Estimate).findOneByOrFail({
      companyId: COMPANY_ID,
    });
    const created = await AppDataSource.getRepository(Customer).findOneByOrFail({
      companyId: COMPANY_ID,
    });
    assert.equal(estimate.customerId, created.id);
    assert.equal(estimate.status, "draft");
    assert.equal(estimate.numberSeq, 0);
    assert.equal(estimate.number, "");
    assert.equal(estimate.currency, "EUR");
    assert.equal(estimate.notes, "Quote for the banner refresh.");
    assert.equal(estimate.createdById, ACTOR.userId);
    assert.match(estimate.slug, /^edraft-[a-z0-9]+$/);
    assert.equal(estimate.subtotalCents, 40_001);
    assert.equal(estimate.taxCents, 0);
    assert.equal(estimate.totalCents, 40_001);

    const lines = await AppDataSource.getRepository(EstimateLineItem).find({
      where: { estimateId: estimate.id },
      order: { sortOrder: "ASC" },
    });
    assert.deepEqual(
      lines.map((line) => [
        line.description,
        line.quantity,
        line.unitPriceCents,
        line.lineTotalCents,
        line.sortOrder,
      ]),
      [
        ["Discovery", 3, 12_000, 36_000, 0],
        ["Revisions", 0.5, 8_001, 4_001, 1],
      ],
    );

    assert.equal(result.navigateTo, `/finance/estimates/${estimate.slug}/edit`);
    assert.equal(result.message, "Draft estimate created for Northwind Labs");
  });

  test("defaults an unpriced estimate for a brand-new customer to USD", async () => {
    const { account, analysis } = await scene([
      estimateAction({ id: "0", currency: undefined, notes: undefined }),
    ]);

    await executeAnalysisAction(account, analysis, "0", ACTOR);

    const estimate = await AppDataSource.getRepository(Estimate).findOneByOrFail({
      companyId: COMPANY_ID,
    });
    assert.equal(estimate.currency, "USD");
    assert.equal(estimate.notes, "");
  });
});

describe("hand_over", () => {
  test("refuses a handover to an employee with no grant on the mailbox", async () => {
    const employee = await insert(AIEmployee, {
      companyId: COMPANY_ID,
      name: "Jamie Mallers",
      slug: "jamie-mallers",
      role: "Inbox manager",
    });
    const { account, analysis } = await scene([
      {
        id: "0",
        kind: "hand_over",
        label: "Hand to Jamie",
        employeeId: employee.id,
        mode: "draft",
        instruction: "Work out what they are asking for.",
        targetEmployeeName: "Jamie Mallers",
      },
    ]);

    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "0", ACTOR),
      /no access to the mailbox yet/,
    );
    assert.equal(await countOf(MailHandover, { companyId: COMPANY_ID }), 0);
    assert.equal((await storedActions(analysis.id))[0].executedAt, undefined);
  });

  test("refuses a reply handover from an employee holding only draft access", async () => {
    const employee = await insert(AIEmployee, {
      companyId: COMPANY_ID,
      name: "Jamie Mallers",
      slug: "jamie-mallers",
      role: "Inbox manager",
    });
    const { account, analysis } = await scene([
      {
        id: "0",
        kind: "hand_over",
        label: "Reply as Jamie",
        employeeId: employee.id,
        mode: "reply",
        instruction: "Answer them directly.",
        targetEmployeeName: "Jamie Mallers",
      },
    ]);
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "draft",
    });

    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "0", ACTOR),
      /needs at least "send"/,
    );
    assert.equal(await countOf(MailHandover, { companyId: COMPANY_ID }), 0);
    assert.equal((await storedActions(analysis.id))[0].executedAt, undefined);
  });
});

describe("the mailbox-backed buttons", () => {
  test("a draft reply reaches the mailbox credential and leaves the button armed", async () => {
    const { account, analysis } = await scene([
      {
        id: "0",
        kind: "draft_reply",
        label: "Draft a reply",
        bodyText: "Thanks — invoice on the way.",
        subject: "Re: Two banners and a landing page",
        targetTo: "ada@northwind-labs.example",
      },
    ]);

    await assert.rejects(() => executeAnalysisAction(account, analysis, "0", ACTOR), NO_CONNECTION);
    assert.equal((await storedActions(analysis.id))[0].executedAt, undefined);
  });

  test("a thread action reaches the mailbox credential and leaves the button armed", async () => {
    const { account, analysis } = await scene([
      {
        id: "0",
        kind: "thread_action",
        label: "Label it",
        action: "applyLabel",
        labelName: "Billing",
      },
    ]);

    await assert.rejects(() => executeAnalysisAction(account, analysis, "0", ACTOR), NO_CONNECTION);
    assert.equal((await storedActions(analysis.id))[0].executedAt, undefined);
  });

  test("an unsubscribe reaches the mailbox credential and leaves the button armed", async () => {
    const { account, analysis } = await scene([
      { id: "0", kind: "unsubscribe", label: "Unsubscribe", targetHost: "lists.example" },
    ]);

    await assert.rejects(() => executeAnalysisAction(account, analysis, "0", ACTOR), NO_CONNECTION);
    assert.equal((await storedActions(analysis.id))[0].executedAt, undefined);
  });

  test("an unsubscribe refuses mail the server binned, without asking for a credential", async () => {
    const { account, analysis } = await scene(
      [{ id: "0", kind: "unsubscribe", label: "Unsubscribe", targetHost: "lists.example" }],
      { labelIds: "INBOX SPAM" },
    );

    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "0", ACTOR),
      /will not unsubscribe from mail the mail server marked as spam or trash/,
    );
    assert.equal((await storedActions(analysis.id))[0].executedAt, undefined);
  });
});

describe("stamping a spent button", () => {
  test("stamps exactly the pressed button and leaves its siblings armed", async () => {
    const { account, analysis } = await scene([invoiceAction(), estimateAction()]);

    const result = await executeAnalysisAction(account, analysis, "0", ACTOR);

    const returned = parseAnalysisActions(result.analysis.actionsJson);
    assert.equal(result.analysis.id, analysis.id);
    assert.equal(returned.length, 2);
    assert.equal(typeof returned[0].executedAt, "string");
    assert.equal(new Date(returned[0].executedAt as string).toISOString(), returned[0].executedAt);
    assert.equal(returned[1].executedAt, undefined);

    const persisted = await storedActions(analysis.id);
    assert.equal(typeof persisted[0].executedAt, "string");
    assert.equal(persisted[1].executedAt, undefined);
    assert.equal(persisted[1].kind, "create_estimate");
  });

  test("refuses to run the pressed button a second time", async () => {
    const { account, analysis } = await scene([invoiceAction()]);

    const first = await executeAnalysisAction(account, analysis, "0", ACTOR);
    await assert.rejects(
      () => executeAnalysisAction(account, first.analysis, "0", ACTOR),
      /already run/,
    );

    assert.equal(await countOf(Invoice, { companyId: COMPANY_ID }), 1);
    assert.equal(await countOf(Customer, { companyId: COMPANY_ID }), 1);
  });

  test("leaves a sibling runnable after its neighbour was spent", async () => {
    const { account, analysis } = await scene([invoiceAction(), estimateAction()]);

    const first = await executeAnalysisAction(account, analysis, "0", ACTOR);
    const second = await executeAnalysisAction(account, first.analysis, "1", ACTOR);

    assert.equal(await countOf(Invoice, { companyId: COMPANY_ID }), 1);
    assert.equal(await countOf(Estimate, { companyId: COMPANY_ID }), 1);
    const persisted = await storedActions(analysis.id);
    assert.equal(typeof persisted[0].executedAt, "string");
    assert.equal(typeof persisted[1].executedAt, "string");
    assert.match(second.navigateTo ?? "", /^\/finance\/estimates\/edraft-[a-z0-9]+\/edit$/);
  });

  test("audits the press against the analysis row, under the Member who made it", async () => {
    const { account, thread, analysis } = await scene([invoiceAction()]);

    await executeAnalysisAction(account, analysis, "0", ACTOR);

    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      companyId: COMPANY_ID,
      action: "mail.analysis.create_invoice",
    });
    assert.equal(audit.actorKind, "user");
    assert.equal(audit.actorUserId, ACTOR.userId);
    assert.equal(audit.targetType, "mail_inbound_analysis");
    assert.equal(audit.targetId, analysis.id);
    assert.equal(audit.targetLabel, thread.subject);
    assert.deepEqual(JSON.parse(audit.metadataJson), { actionId: "0", kind: "create_invoice" });
  });
});

describe("a button that must run exactly once", () => {
  test("runs one effect when the same button is pressed twice at the same moment", async () => {
    const { account, analysis } = await scene([estimateAction({ id: "0" })]);

    // A double-click, two tabs, or a retried request. Both presses read an
    // unstamped copy of the row; only one may reach the ledger.
    const [first, second] = await Promise.allSettled([
      executeAnalysisAction(account, analysis, "0", ACTOR),
      executeAnalysisAction(account, analysis, "0", ACTOR),
    ]);

    const outcomes = [first.status, second.status].sort();
    assert.deepEqual(outcomes, ["fulfilled", "rejected"]);
    assert.equal(await countOf(Estimate, { companyId: COMPANY_ID }), 1);
    assert.equal(await countOf(Customer, { companyId: COMPANY_ID }), 1);

    const [stored] = await storedActions(analysis.id);
    assert.ok(stored.executedAt, "the winning press must leave the button spent");
  });

  test("hands the button back when the effect it was claimed for failed", async () => {
    // A handover to an employee with no grant is refused before anything
    // external happens — the cleanest way to fail an effect deterministically.
    const stranger = await insert(AIEmployee, {
      companyId: COMPANY_ID,
      name: "Morgan",
      slug: testId("morgan"),
      role: "Support",
    });
    const { account, analysis } = await scene([
      {
        id: "0",
        kind: "hand_over",
        label: "Hand this to Morgan",
        employeeId: stranger.id,
        mode: "draft",
        instruction: "Answer the pricing question.",
        targetEmployeeName: "Morgan",
      },
    ]);

    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "0", ACTOR),
      MailAnalysisActionError,
    );

    const [stored] = await storedActions(analysis.id);
    assert.equal(stored.executedAt, undefined, "a button that could not run stays armed");
    assert.equal(await countOf(MailHandover, { companyId: COMPANY_ID }), 0);

    // And the retry, once the grant exists, succeeds and spends it.
    await insert(EmployeeMailAccountGrant, {
      employeeId: stranger.id,
      accountId: account.id,
      accessLevel: "draft",
    });
    await executeAnalysisAction(account, analysis, "0", ACTOR);
    const [after] = await storedActions(analysis.id);
    assert.ok(after.executedAt);
  });

  test("a failed press never disarms a sibling button that already ran", async () => {
    const stranger = await insert(AIEmployee, {
      companyId: COMPANY_ID,
      name: "Morgan",
      slug: testId("morgan"),
      role: "Support",
    });
    const { account, analysis } = await scene([
      estimateAction({ id: "0" }),
      {
        id: "1",
        kind: "hand_over",
        label: "Hand this to Morgan",
        employeeId: stranger.id,
        mode: "draft",
        instruction: "Answer the pricing question.",
        targetEmployeeName: "Morgan",
      },
    ]);

    await executeAnalysisAction(account, analysis, "0", ACTOR);
    await assert.rejects(() => executeAnalysisAction(account, analysis, "1", ACTOR));

    const stored = await storedActions(analysis.id);
    assert.ok(stored[0].executedAt, "the estimate really was created; it must stay spent");
    assert.equal(stored[1].executedAt, undefined);
  });
});

describe("customers the Member has retired", () => {
  test("never bills an archived customer matched by address", async () => {
    const archived = await customer({
      name: "Northwind Labs",
      email: "ada@northwind-labs.example",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "Northwind Labs",
      email: "ada@northwind-labs.example",
    });

    // Archived accounts are hidden from every picker, so reviving one behind
    // the Member's back is worse than making a fresh row they can merge.
    assert.notEqual(resolved.id, archived.id);
    assert.equal(resolved.archivedAt, null);
  });

  test("never matches an archived customer by domain or by name", async () => {
    const byDomain = await customer({
      name: "Northwind Domain",
      domain: "northwind-labs.example",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const byName = await customer({
      name: "Northwind Labs",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "Northwind Labs",
      email: "ada@northwind-labs.example",
    });

    assert.notEqual(resolved.id, byDomain.id);
    assert.notEqual(resolved.id, byName.id);
    assert.equal(resolved.archivedAt, null);
  });

  test("still prefers a live customer over an archived one with the same address", async () => {
    await customer({
      name: "Northwind Labs (old)",
      email: "ada@northwind-labs.example",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const live = await customer({
      name: "Northwind Labs",
      email: "ada@northwind-labs.example",
    });

    const resolved = await resolveOrCreateCustomer(COMPANY_ID, {
      name: "Anything",
      email: "ada@northwind-labs.example",
    });

    assert.equal(resolved.id, live.id);
  });
});

describe("buttons that write to Finance", () => {
  test("refuses a Member whose finance access is read-only", async () => {
    const { account, analysis } = await scene([invoiceAction(), estimateAction()]);

    // The finance router's own gate is bound to that router's verbs, so it
    // cannot reach a button pressed from the mail surface. Without this check
    // the inbox would be a side door into a ledger Finance itself keeps shut.
    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "0", READ_ONLY_FINANCE),
      /read-only finance access/,
    );
    await assert.rejects(
      () => executeAnalysisAction(account, analysis, "1", READ_ONLY_FINANCE),
      /read-only finance access/,
    );

    assert.equal(await countOf(Invoice, { companyId: COMPANY_ID }), 0);
    assert.equal(await countOf(Estimate, { companyId: COMPANY_ID }), 0);
    assert.equal(await countOf(Customer, { companyId: COMPANY_ID }), 0);
  });

  test("leaves a refused button armed for someone who may press it", async () => {
    const { account, analysis } = await scene([estimateAction({ id: "0" })]);

    await assert.rejects(() => executeAnalysisAction(account, analysis, "0", READ_ONLY_FINANCE));
    const [afterRefusal] = await storedActions(analysis.id);
    assert.equal(afterRefusal.executedAt, undefined);

    await executeAnalysisAction(account, analysis, "0", ACTOR);
    const [afterPress] = await storedActions(analysis.id);
    assert.ok(afterPress.executedAt);
    assert.equal(await countOf(Estimate, { companyId: COMPANY_ID }), 1);
  });

  test("does not let a read-only Member create the customer either", async () => {
    const { account, analysis } = await scene([
      invoiceAction({ customerName: "Somebody Entirely New" }),
    ]);

    await assert.rejects(() => executeAnalysisAction(account, analysis, "0", READ_ONLY_FINANCE));

    // The refusal has to come before `resolveOrCreateCustomer`, or a blocked
    // press still litters the customer list.
    assert.equal(await countOf(Customer, { companyId: COMPANY_ID }), 0);
  });
});

describe("the recipient a draft reply promises", () => {
  test("uses the address the button showed, not whoever is newest on the thread", async () => {
    const { account, analysis, thread } = await scene([
      {
        id: "0",
        kind: "draft_reply",
        label: "Draft a reply",
        bodyText: "On it.",
        targetTo: "ada@northwind-labs.example",
      },
    ]);
    // A later message from someone else is what `replyContext` would otherwise
    // pick, and the Member was promised Ada.
    await insert(MailMessage, {
      companyId: account.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: testId("gmail_message"),
      gmailThreadId: thread.gmailThreadId,
      fromName: "Someone Else",
      fromEmail: "someone-else@elsewhere.example",
      toEmails: account.address,
      subject: thread.subject,
      bodyText: "Adding myself to this thread.",
      sentAt: new Date("2030-01-01T00:00:00Z"),
    });

    // The Gmail call fails (the fixture connection does not exist), but only
    // after the recipient has been resolved — which is the part under test.
    await assert.rejects(() => executeAnalysisAction(account, analysis, "0", ACTOR), NO_CONNECTION);
    const [stored] = await storedActions(analysis.id);
    assert.equal(stored.kind, "draft_reply");
    assert.equal(
      stored.kind === "draft_reply" ? stored.targetTo : null,
      "ada@northwind-labs.example",
    );
    // A Gmail failure must not burn the button.
    assert.equal(stored.executedAt, undefined);
  });
});
