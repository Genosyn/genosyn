import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, mock, test } from "node:test";
import express from "express";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright-core";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { GmailMailbox } from "../services/mail/mailbox/gmail.js";
import type { MimeFields } from "../services/mail/mime.js";
import { ATTACHMENT_TOTAL_MAX_BYTES } from "../services/resourceAttachments.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { FakeMailbox } from "../test/fakeMailbox.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let account: MailAccount;
let thread: MailThread;
let customer: Customer;
let estimate: Estimate;
let financeGrant: EmployeeFinanceGrant;
let mailGrant: EmployeeMailAccountGrant;
let mailbox: FakeMailbox;
let renderedHtml: string[] = [];
let pdfBytes: Buffer;
let renderError: Error | null = null;

before(async () => {
  await initTestDb();
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  pdfBytes = Buffer.from(await doc.save());
  // The production HTML->PDF pipeline is exercised up to the Chromium boundary.
  // Capture its input, return real PDF bytes, and keep tests independent of a
  // workstation's browser installation or external mail servers.
  mock.method(chromium, "launch", async () => ({
    newContext: async () => ({
      newPage: async () => ({
        setContent: async (html: string) => {
          renderedHtml.push(html);
        },
        pdf: async () => {
          if (renderError) throw renderError;
          return pdfBytes;
        },
        close: async () => {},
      }),
      close: async () => {},
    }),
    close: async () => {},
  }));
  mock.method(
    GmailMailbox.prototype,
    "createDraft",
    (args: Parameters<FakeMailbox["createDraft"]>[0]) => mailbox.createDraft(args),
  );
  mock.method(
    GmailMailbox.prototype,
    "updateDraft",
    (args: Parameters<FakeMailbox["updateDraft"]>[0]) => mailbox.updateDraft(args),
  );
  mock.method(
    GmailMailbox.prototype,
    "sendMessage",
    (args: Parameters<FakeMailbox["sendMessage"]>[0]) => mailbox.sendMessage(args),
  );
  mock.method(
    GmailMailbox.prototype,
    "sendDraft",
    (args: Parameters<FakeMailbox["sendDraft"]>[0]) => mailbox.sendDraft(args),
  );
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  renderedHtml = [];
  renderError = null;
  mailbox = new FakeMailbox();
  company = await insert(Company, { name: "Quote Co", slug: "quote-co", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Sales",
    slug: "sales",
    role: "Sales",
    soulBody: "",
  });
  financeGrant = await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "invoice",
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "sales@example.com",
  });
  mailGrant = await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: "quote-request",
    subject: "Please quote for onboarding",
  });
  await insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "request",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "buyer@customer.example",
    toEmails: account.address,
    ccEmails: "purchasing@customer.example",
    subject: thread.subject,
    sentAt: new Date(),
  });
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Customer <Ltd>",
    slug: "customer",
    email: "buyer@customer.example",
    currency: "GBP",
    billingAddress: "10 High Street\nLondon",
  });
  estimate = await insert(Estimate, {
    companyId: company.id,
    customerId: customer.id,
    slug: "edraft-quote",
    issueDate: new Date("2026-09-08T00:00:00Z"),
    validUntil: new Date("2026-10-08T00:00:00Z"),
    currency: "GBP",
    subtotalCents: 10000,
    totalCents: 10000,
  });
  await insert(EstimateLineItem, {
    estimateId: estimate.id,
    description: "Onboarding & support",
    quantity: 2,
    unitPriceCents: 5000,
    lineSubtotalCents: 10000,
    lineTotalCents: 10000,
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  mock.restoreAll();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await closeTestDb();
});

async function call(tool: string, body: unknown) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      error?: string;
      customer?: { slug: string };
      estimate?: { slug: string };
      message?: { messageId: string };
    },
  };
}

function compose(slug = estimate.slug) {
  return {
    threadId: thread.id,
    cc: "purchasing@customer.example",
    bodyText: "Here is your preliminary quotation for review.",
    attachments: [{ estimateSlug: slug }],
  };
}

function lastMime(method = "createDraft"): MimeFields {
  const invocation = mailbox.calls.filter((entry) => entry.method === method).at(-1);
  assert.ok(invocation, `expected a ${method} mailbox call`);
  return invocation.args[0] as MimeFields;
}

async function memberAuthority(financeAccess: "none" | "read" | "full") {
  const user = await insert(User, {
    email: "member@example.com",
    passwordHash: "hash",
    name: "Member",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: user.id,
    role: "member",
    financeAccess,
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: user.id,
    requesterSessionVersion: user.sessionVersion,
  });
}

test("customer request becomes a new Customer, estimate and reply draft with the actual PDF", async () => {
  const createdCustomer = await call("create_customer", {
    name: "New buyer",
    email: "buyer@new.example",
    currency: "GBP",
  });
  assert.equal(createdCustomer.status, 200, createdCustomer.body.error);
  const createdEstimate = await call("create_estimate", {
    customerSlug: createdCustomer.body.customer!.slug,
    lines: [{ description: "Implementation", quantity: 3, unitPriceCents: 7000 }],
  });
  assert.equal(createdEstimate.status, 200, createdEstimate.body.error);
  const drafted = await call("create_mail_draft", compose(createdEstimate.body.estimate!.slug));
  assert.equal(drafted.status, 200, drafted.body.error);
  const mime = lastMime();
  assert.equal(mime.to, "buyer@customer.example");
  assert.equal(mime.cc, "purchasing@customer.example");
  assert.equal(mime.subject, "Re: Please quote for onboarding");
  assert.deepEqual(mime.attachments?.[0].content, pdfBytes);
  assert.match(mime.attachments?.[0].filename ?? "", /^DRAFT-edraft-.*\.pdf$/);
  assert.equal(mime.attachments?.[0].mimeType, "application/pdf");
  assert.match(renderedHtml[0], /New buyer/);
  assert.match(renderedHtml[0], /Implementation/);
  assert.match(renderedHtml[0], /210\.00/);
  assert.match(renderedHtml[0], /<h1 class="estimate-number">DRAFT<\/h1>/);
  assert.equal(
    mailbox.calls.some((c) => c.method.startsWith("send")),
    false,
  );
  const stored = await AppDataSource.getRepository(Estimate).findOneByOrFail({
    slug: createdEstimate.body.estimate!.slug,
  });
  assert.equal(stored.status, "draft");
  assert.equal(stored.number, "");
  assert.equal(stored.sentAt, null);
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
});

test("draft PDF escapes customer and line text and preserves its source status", async () => {
  const response = await call("create_mail_draft", compose());
  assert.equal(response.status, 200, response.body.error);
  assert.match(renderedHtml[0], /Customer &lt;Ltd&gt;/);
  assert.match(renderedHtml[0], /Onboarding &amp; support/);
  assert.match(renderedHtml[0], /10 High Street\nLondon/);
  assert.equal(
    (await AppDataSource.getRepository(Estimate).findOneByOrFail({ id: estimate.id })).numberSeq,
    0,
  );
});

test("Read finance can attach an issued quotation", async () => {
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(financeGrant.id, {
    accessLevel: "read",
  });
  await AppDataSource.getRepository(Estimate).update(estimate.id, {
    status: "sent",
    number: "EST-0007",
    numberSeq: 7,
  });
  const response = await call("create_mail_draft", compose());
  assert.equal(response.status, 200, response.body.error);
  assert.equal(lastMime().attachments?.[0].filename, "EST-0007.pdf");
  assert.match(renderedHtml[0], /EST-0007/);
});

test("Read finance cannot attach a draft quotation", async () => {
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(financeGrant.id, {
    accessLevel: "read",
  });
  const response = await call("create_mail_draft", compose());
  assert.equal(response.status, 400);
  assert.match(response.body.error ?? "", /Invoicing/);
  assert.equal(renderedHtml.length, 0);
  assert.equal(mailbox.calls.length, 0);
});

for (const change of ["revoked", "wrong-company", "unknown-level"] as const) {
  test(`Finance grant ${change} blocks quotation rendering before mailbox access`, async () => {
    if (change === "revoked")
      await AppDataSource.getRepository(EmployeeFinanceGrant).delete(financeGrant.id);
    if (change === "wrong-company")
      await AppDataSource.getRepository(EmployeeFinanceGrant).update(financeGrant.id, {
        companyId: randomUUID(),
      });
    if (change === "unknown-level")
      await AppDataSource.getRepository(EmployeeFinanceGrant).update(financeGrant.id, {
        accessLevel: "future" as "read",
      });
    const response = await call("create_mail_draft", compose());
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /finance access/);
    assert.equal(renderedHtml.length, 0);
    assert.equal(mailbox.calls.length, 0);
  });
}

for (const financeAccess of ["none", "read"] as const) {
  test(`a Member with Finance ${financeAccess} cannot borrow the employee's Invoicing grant`, async () => {
    await memberAuthority(financeAccess);
    const response = await call("create_mail_draft", compose());
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /finance access/);
    assert.equal(renderedHtml.length, 0);
    assert.equal(mailbox.calls.length, 0);
  });
}

test("a Member with full Finance can prepare the quotation through the employee", async () => {
  await memberAuthority("full");
  const response = await call("create_mail_draft", compose());
  assert.equal(response.status, 200, response.body.error);
});

for (const corrupt of ["estimate", "customer"] as const) {
  test(`a foreign-company ${corrupt} is never rendered`, async () => {
    const entity = corrupt === "estimate" ? Estimate : Customer;
    await AppDataSource.getRepository(entity).update(
      corrupt === "estimate" ? estimate.id : customer.id,
      { companyId: randomUUID() },
    );
    const response = await call("create_mail_draft", compose());
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /not found/);
    assert.equal(renderedHtml.length, 0);
    assert.equal(mailbox.calls.length, 0);
  });
}

test("mailbox Read cannot create quote drafts", async () => {
  await AppDataSource.getRepository(EmployeeMailAccountGrant).update(mailGrant.id, {
    accessLevel: "read",
  });
  const response = await call("create_mail_draft", compose());
  assert.equal(response.status, 403);
  assert.equal(renderedHtml.length, 0);
});

test("mailbox Draft cannot send quote PDFs", async () => {
  const response = await call("send_mail", compose());
  assert.equal(response.status, 403);
  assert.equal(renderedHtml.length, 0);
  assert.equal(mailbox.calls.length, 0);
});

test("authorized mailbox Send sends the PDF while leaving the estimate unissued", async () => {
  await AppDataSource.getRepository(EmployeeMailAccountGrant).update(mailGrant.id, {
    accessLevel: "send",
  });
  const response = await call("send_mail", compose());
  assert.equal(response.status, 200, response.body.error);
  assert.deepEqual(lastMime("sendMessage").attachments?.[0].content, pdfBytes);
  const stored = await AppDataSource.getRepository(Estimate).findOneByOrFail({ id: estimate.id });
  assert.equal(stored.status, "draft");
  assert.equal(stored.sentAt, null);
  assert.equal(stored.number, "");
});

test("an estimate edit refreshes the PDF when edit_mail_draft reattaches its slug", async () => {
  const draft = await call("create_mail_draft", compose());
  assert.equal(draft.status, 200, draft.body.error);
  await AppDataSource.getRepository(Estimate).update(estimate.id, {
    notes: "Updated scope after discussion",
  });
  const response = await call("edit_mail_draft", {
    draftMessageId: draft.body.message!.messageId,
    attachments: [{ estimateSlug: estimate.slug, filename: "quotation.pdf" }],
  });
  assert.equal(response.status, 200, response.body.error);
  const update = mailbox.calls.find((c) => c.method === "updateDraft")!;
  const mime = update.args[1] as MimeFields;
  assert.equal(mime.attachments?.[0].filename, "quotation.pdf");
  assert.match(renderedHtml[1], /Updated scope after discussion/);
});

test("issuing a quotation lets the employee replace its draft PDF in the existing reply", async () => {
  const draft = await call("create_mail_draft", compose());
  assert.equal(draft.status, 200, draft.body.error);
  assert.match(lastMime().attachments?.[0].filename ?? "", /^DRAFT-/);
  const issued = await call("issue_estimate", { estimateSlug: estimate.slug });
  assert.equal(issued.status, 200, issued.body.error);
  const updated = await call("edit_mail_draft", {
    draftMessageId: draft.body.message!.messageId,
    bodyText: "Here is your quotation for onboarding and support.",
    attachments: [{ estimateSlug: issued.body.estimate!.slug }],
  });
  assert.equal(updated.status, 200, updated.body.error);
  const update = mailbox.calls.find((entry) => entry.method === "updateDraft")!;
  const mime = update.args[1] as MimeFields;
  assert.equal(mime.attachments?.length, 1);
  assert.equal(mime.attachments?.[0].filename, "CUSTOMER-EST-0001.pdf");
  assert.deepEqual(mime.attachments?.[0].content, pdfBytes);
  assert.match(renderedHtml[1], /CUSTOMER-EST-0001/);
  assert.doesNotMatch(renderedHtml[1], /DRAFT/);
  assert.equal(mailbox.calls.some((entry) => entry.method.startsWith("send")), false);
  assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), 0);
});

test("mixed attachment handles and unsupported formats are rejected before rendering", async () => {
  for (const spec of [
    { estimateSlug: estimate.slug, invoiceSlug: "invoice" },
    { estimateSlug: estimate.slug, format: "txt" },
    { estimateSlug: "" },
  ]) {
    const response = await call("create_mail_draft", { ...compose(), attachments: [spec] });
    assert.equal(response.status, 400);
  }
  assert.equal(renderedHtml.length, 0);
  assert.equal(mailbox.calls.length, 0);
});

test("PDF render failure prevents an email missing its promised quotation", async () => {
  renderError = new Error("PDF renderer unavailable");
  const response = await call("create_mail_draft", compose());
  assert.equal(response.status, 400);
  assert.match(response.body.error ?? "", /PDF renderer unavailable/);
  assert.equal(mailbox.calls.length, 0);
});

test("combined quotation PDFs respect the total attachment size limit", async () => {
  const original = pdfBytes;
  try {
    pdfBytes = Buffer.alloc(Math.floor(ATTACHMENT_TOTAL_MAX_BYTES / 2) + 1);
    const response = await call("create_mail_draft", {
      ...compose(),
      attachments: [{ estimateSlug: estimate.slug }, { estimateSlug: estimate.slug }],
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /over the limit/);
    assert.equal(mailbox.calls.length, 0);
  } finally {
    pdfBytes = original;
  }
});
