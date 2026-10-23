import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import express from "express";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright-core";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { CompanyFinanceSettings } from "../db/entities/CompanyFinanceSettings.js";
import { Customer } from "../db/entities/Customer.js";
import { EmailProvider } from "../db/entities/EmailProvider.js";
import { Estimate } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { getFinanceSettings } from "../services/fx.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * The send dialog's contract with the server, for both documents it sends:
 * an invoice or an estimate goes to exactly the To and Cc the Member
 * confirmed — plus Finance → Settings → Always Cc on an invoice — and to
 * nobody else. Each address is checked again here, whatever the dialog
 * accepted, and an empty body keeps meaning what Issue & send always meant:
 * the customer's billing email, with the PDF.
 *
 * Chromium and SMTP are stubbed at their process boundary, so what is
 * asserted is the message the transport was handed.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let customer: Customer;
let mailMessages: nodemailer.SendMailOptions[] = [];
let pdfPages: string[] = [];
let pdfBytes: Buffer;

before(async () => {
  await initTestDb();
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  pdfBytes = Buffer.from(await doc.save());
  mock.method(chromium, "launch", async () => ({
    newContext: async () => ({
      newPage: async () => ({
        setContent: async (html: string) => {
          pdfPages.push(html);
        },
        pdf: async () => pdfBytes,
        close: async () => {},
      }),
      close: async () => {},
    }),
    close: async () => {},
  }));
  mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message: nodemailer.SendMailOptions) => {
      mailMessages.push(message);
      return { messageId: `test-message-${mailMessages.length}` };
    },
  }));
  mock.method(console, "log", () => {});
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
  mock.restoreAll();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  mailMessages = [];
  pdfPages = [];
  const owner = await member("owner", "full");
  actingUserId = owner.id;
  customer = await insert(Customer, {
    companyId: company.id,
    name: "Acme Corp",
    slug: "acme-corp",
    email: "billing@acme.example",
    domain: "acme.example",
    currency: "USD",
  });
  await insert(EmailProvider, {
    companyId: company.id,
    name: "Test SMTP",
    kind: "smtp",
    fromAddress: "finance@northwind.example",
    replyTo: "ar@northwind.example",
    isDefault: true,
    encryptedConfig: encryptSecret(
      JSON.stringify({
        host: "smtp.northwind.example",
        port: 587,
        secure: false,
        user: "",
        pass: "",
      }),
      `company:${company.id}`,
    ),
  });
});

async function member(role: Role, financeAccess: FinanceAccess): Promise<User> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@northwind.example`,
    name: `${role} ${financeAccess}`,
    passwordHash: "x",
    sessionVersion: 0,
  });
  if (role === "owner") {
    company = await insert(Company, {
      name: "Northwind",
      slug: `northwind-${randomUUID()}`,
      ownerId: user.id,
    });
  }
  await insert(Membership, { companyId: company.id, userId: user.id, role, financeAccess });
  return user;
}

async function sentEstimate(fields: Partial<Estimate> = {}): Promise<Estimate> {
  const estimate = await insert(Estimate, {
    companyId: company.id,
    customerId: customer.id,
    slug: `acme-corp-est-${randomUUID().slice(0, 4)}`,
    number: "ACME-CORP-EST-0001",
    numberSeq: 1,
    status: "sent",
    currency: "USD",
    issueDate: new Date("2026-08-06T00:00:00.000Z"),
    validUntil: new Date("2026-09-05T00:00:00.000Z"),
    subtotalCents: 10_000,
    totalCents: 10_000,
    sentAt: new Date("2026-08-06T00:00:00.000Z"),
    ...fields,
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

async function sentInvoice(): Promise<Invoice> {
  const invoice = await insert(Invoice, {
    companyId: company.id,
    customerId: customer.id,
    slug: `acme-corp-inv-${randomUUID().slice(0, 4)}`,
    number: "ACME-CORP-INV-0001",
    numberSeq: 1,
    status: "sent",
    currency: "USD",
    issueDate: new Date("2026-08-06T00:00:00.000Z"),
    dueDate: new Date("2026-09-05T00:00:00.000Z"),
    subtotalCents: 10_000,
    totalCents: 10_000,
    balanceCents: 10_000,
    sentAt: new Date("2026-08-06T00:00:00.000Z"),
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

type SendResponse = {
  error?: string;
  issues?: unknown[];
  send?: {
    status: string;
    errorMessage: string;
    toAddress: string;
    ccAddress: string;
    pdfRequested: boolean;
    pdfAttached: boolean;
    hasMessage: boolean;
  };
};

async function post(path: string, body?: unknown): Promise<{ status: number; body: SendResponse }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as SendResponse };
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

function attachmentNames(message: nodemailer.SendMailOptions): string[] {
  return (message.attachments ?? []).map((attachment) => String(attachment.filename));
}

describe("estimate send dialog details", () => {
  test("the estimate's page gets the sender and the billing email, and no Always Cc", async () => {
    const settings = await getFinanceSettings(company.id);
    settings.invoiceCcEmails = ["books@northwind.example"];
    await AppDataSource.getRepository(CompanyFinanceSettings).save(settings);
    const estimate = await sentEstimate();

    const { status, body } = await get<{ emailDetails: Record<string, unknown> }>(
      `/estimates/${estimate.slug}`,
    );

    assert.equal(status, 200);
    assert.deepEqual(body.emailDetails, {
      toAddress: "billing@acme.example",
      alwaysCcAddress: "",
      fromAddress: "finance@northwind.example",
      replyTo: "ar@northwind.example",
      configured: true,
      source: "company_provider",
    });
  });

  test("an estimate whose customer row is gone still opens, with nobody to send to", async () => {
    const estimate = await sentEstimate({ customerId: randomUUID() });

    const { status, body } = await get<{ emailDetails: { toAddress: string } }>(
      `/estimates/${estimate.slug}`,
    );

    assert.equal(status, 200);
    assert.equal(body.emailDetails.toAddress, "");
  });
});

describe("estimate send", () => {
  test("goes to exactly the To and Cc the Member confirmed, with their note and the PDF", async () => {
    const estimate = await sentEstimate();

    const { status, body } = await post(`/estimates/${estimate.slug}/send`, {
      to: ["ap@acme.example", " Jane@Acme.example "],
      cc: ["cfo@acme.example", "jane@acme.example", "CFO@acme.example"],
      message: "  The updated quote, as discussed.  ",
      attachPdf: true,
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(mailMessages.length, 1);
    const [message] = mailMessages;
    assert.equal(message.to, "ap@acme.example, Jane@Acme.example");
    // Jane is already on the To line; the second CFO is the first one again.
    assert.equal(message.cc, "cfo@acme.example");
    assert.match(String(message.text), /^The updated quote, as discussed\.\n\n/);
    assert.match(String(message.html), /email-message">The updated quote, as discussed\.</);
    assert.deepEqual(attachmentNames(message), ["ACME-CORP-EST-0001.pdf"]);
    // The note is for the email; the PDF is the estimate itself.
    assert.equal(pdfPages.length, 1);
    assert.doesNotMatch(pdfPages[0], /as discussed/);

    assert.equal(body.send?.status, "sent");
    assert.equal(body.send?.toAddress, "ap@acme.example, Jane@Acme.example");
    assert.equal(body.send?.ccAddress, "cfo@acme.example");
    assert.equal(body.send?.hasMessage, true);
    assert.equal(body.send?.pdfAttached, true);

    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      companyId: company.id,
      action: "finance.estimate.send",
      targetId: estimate.id,
    });
    assert.deepEqual(JSON.parse(audit.metadataJson), {
      status: "sent",
      errorMessage: "",
      toAddress: "ap@acme.example, Jane@Acme.example",
      ccAddress: "cfo@acme.example",
      pdfRequested: true,
      pdfAttached: true,
      hasMessage: true,
    });
  });

  test("with no body it still goes to the billing email alone, with the PDF — Issue & send", async () => {
    const estimate = await sentEstimate();

    const { status, body } = await post(`/estimates/${estimate.slug}/send`);

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(mailMessages.length, 1);
    assert.equal(mailMessages[0].to, "billing@acme.example");
    assert.equal(mailMessages[0].cc, undefined);
    assert.deepEqual(attachmentNames(mailMessages[0]), ["ACME-CORP-EST-0001.pdf"]);
    assert.doesNotMatch(String(mailMessages[0].html), /email-message"/);
    assert.equal(body.send?.hasMessage, false);
  });

  test("leaves the PDF off when the Member unticks it", async () => {
    const estimate = await sentEstimate();

    const { status, body } = await post(`/estimates/${estimate.slug}/send`, {
      to: ["billing@acme.example"],
      attachPdf: false,
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(attachmentNames(mailMessages[0]), []);
    assert.equal(pdfPages.length, 0, "no PDF was rendered");
    assert.equal(body.send?.pdfRequested, false);
    assert.equal(body.send?.pdfAttached, false);
    assert.match(String(mailMessages[0].text), /The estimate is included in this email\./);
  });

  test("reaches an explicit To even when the customer has no billing email on file", async () => {
    customer.email = "";
    await AppDataSource.getRepository(Customer).save(customer);
    const estimate = await sentEstimate();

    const refused = await post(`/estimates/${estimate.slug}/send`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? "", /no email address/i);

    const sent = await post(`/estimates/${estimate.slug}/send`, { to: ["ap@acme.example"] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(mailMessages.length, 1);
    assert.equal(mailMessages[0].to, "ap@acme.example");
  });

  test("checks every address again, whatever the dialog accepted, and sends nothing on a bad one", async () => {
    const estimate = await sentEstimate();
    for (const body of [
      { to: ["not-an-address"] },
      { to: ["Jane Doe <jane@acme.example>"] },
      { to: [] },
      { cc: ["jane@acme"] },
      { to: ["ap@acme.example"], bcc: ["hidden@elsewhere.example"] },
      { cc: Array.from({ length: 26 }, (_, i) => `person${i}@acme.example`) },
      { message: "x".repeat(4001) },
      { attachPdf: "yes" },
    ]) {
      const { status, body: response } = await post(`/estimates/${estimate.slug}/send`, body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(response.error, "ValidationError", JSON.stringify(body));
    }
    assert.equal(mailMessages.length, 0);
  });

  test("a Member with read-only finance access can see the details but not send", async () => {
    const estimate = await sentEstimate();
    actingUserId = (await member("member", "read")).id;

    assert.equal((await get(`/estimates/${estimate.slug}`)).status, 200);
    const { status } = await post(`/estimates/${estimate.slug}/send`, { to: ["ap@acme.example"] });

    assert.equal(status, 403);
    assert.equal(mailMessages.length, 0);
  });
});

describe("invoice resend", () => {
  test("goes to the confirmed To and Cc plus Always Cc, each person once", async () => {
    const settings = await getFinanceSettings(company.id);
    settings.invoiceCcEmails = ["books@northwind.example", "ap@acme.example"];
    await AppDataSource.getRepository(CompanyFinanceSettings).save(settings);
    const invoice = await sentInvoice();

    const { status, body } = await post(`/invoices/${invoice.slug}/send`, {
      to: ["ap@acme.example", "billing@acme.example"],
      cc: ["jane@acme.example", "Books@Northwind.example", "billing@acme.example"],
      message: "",
      attachPdf: false,
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(mailMessages.length, 1);
    assert.equal(mailMessages[0].to, "ap@acme.example, billing@acme.example");
    // Always Cc first, then the Member's own — without anyone on the To line,
    // and without the same mailbox twice.
    assert.equal(mailMessages[0].cc, "books@northwind.example, jane@acme.example");
    assert.equal(body.send?.ccAddress, "books@northwind.example, jane@acme.example");
  });
});
