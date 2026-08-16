import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import { PDFDocument } from "pdf-lib";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailChatMessage } from "../db/entities/MailChatMessage.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  issueMcpToken,
  noteAttachmentForToken,
  revokeMcpToken,
  tokenOwnsAttachment,
} from "../services/mcpTokens.js";
import { companyDir } from "../services/paths.js";
import { recordAttachmentBytes } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The tool-side of working with files an email carried.
 *
 * The rule under test throughout is the same one: an employee may work with a
 * file it produced or opened this turn, and with what the teammate in front
 * of it put there — and with nothing else in the company's attachment table.
 * Gmail itself is never reached; the paths that would call it are covered in
 * services/mail/attachments.test.ts through the transport seam.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let requester: User;
let membership: Membership;
let account: MailAccount;
let thread: MailThread;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, {
    name: "Mail Files Co",
    slug: `mail-files-${randomUUID()}`,
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "Accounts payable",
    soulBody: "",
  });
  requester = await insert(User, {
    email: `member-${randomUUID()}@example.com`,
    passwordHash: "hash",
    name: "Delegating Member",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  membership = await insert(Membership, {
    companyId: company.id,
    userId: requester.id,
    role: "member",
    financeAccess: "none",
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "ap@example.com",
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: randomUUID(),
    subject: "Syniti New Supplier Form US",
  });
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: membership.userId,
    requesterSessionVersion: requester.sessionVersion,
  });
});

async function call(tool: string, body: unknown = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & { error?: string },
  };
}

async function grantMailbox(level: "read" | "draft" | "send" = "read"): Promise<void> {
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: level,
  });
}

async function mailMessageWithAttachment(): Promise<MailMessage> {
  return insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "gmail-1",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "accountspayable@syniti.com",
    subject: "Supplier onboarding",
    sentAt: new Date(),
    attachmentsJson: JSON.stringify([
      {
        partId: "1.1",
        attachmentId: "gmail-att",
        filename: "FIF_2026.pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    ]),
  });
}

/** A one-field PDF form, so the PDF tools have something real to read. */
async function pdfFormBytes(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const field = doc.getForm().createTextField("CompanyName");
  field.addToPage(page, { x: 20, y: 120, width: 200, height: 20 });
  return Buffer.from(await doc.save());
}

async function storeAttachment(params: {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  uploadedByUserId?: string | null;
  companyId?: string;
  companySlug?: string;
}): Promise<Attachment> {
  return recordAttachmentBytes({
    companyId: params.companyId ?? company.id,
    companySlug: params.companySlug ?? company.slug,
    filename: params.filename,
    mimeType: params.mimeType,
    bytes: params.bytes,
    uploadedByUserId: params.uploadedByUserId ?? null,
  });
}

function cleanUp(slug = company.slug): void {
  fs.rmSync(companyDir(slug), { recursive: true, force: true });
}

describe("read_mail_attachment authority", () => {
  test("is refused without a grant on the mailbox", async () => {
    const message = await mailMessageWithAttachment();

    const res = await call("read_mail_attachment", { messageId: message.id, index: 0 });

    assert.equal(res.status, 403);
    assert.match(res.body.error ?? "", /grant/i);
  });

  test("is refused for a message in another company", async () => {
    await grantMailbox();
    const otherCompany = await insert(Company, {
      name: "Other Co",
      slug: `other-${randomUUID()}`,
      ownerId: "owner-2",
    });
    const foreign = await insert(MailMessage, {
      companyId: otherCompany.id,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: "gmail-foreign",
      gmailThreadId: thread.gmailThreadId,
      attachmentsJson: "[]",
    });

    const res = await call("read_mail_attachment", { messageId: foreign.id, index: 0 });

    assert.equal(res.status, 404);
  });

  test("an out-of-range index is a readable refusal, and nothing is stored", async () => {
    await grantMailbox();
    const message = await mailMessageWithAttachment();

    const res = await call("read_mail_attachment", { messageId: message.id, index: 4 });

    assert.equal(res.status, 404);
    assert.match(res.body.error ?? "", /this email has 1/);
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 0);
  });

  test("rejects a malformed request rather than guessing", async () => {
    await grantMailbox();
    const message = await mailMessageWithAttachment();

    assert.equal((await call("read_mail_attachment", { messageId: message.id })).status, 400);
    assert.equal(
      (await call("read_mail_attachment", { messageId: message.id, index: -1 })).status,
      400,
    );
    assert.equal((await call("read_mail_attachment", { messageId: "not-a-uuid", index: 0 })).status, 400);
  });
});

describe("who may work with an attachment", () => {
  test("a file this turn opened can be read by the PDF tools straight away", async () => {
    // An imported email attachment has no uploader and no chat message. The
    // regression this guards: the employee opening a form and then being told
    // its own attachment does not exist on the very next call.
    const imported = await storeAttachment({
      filename: "FIF_2026.pdf",
      mimeType: "application/pdf",
      bytes: await pdfFormBytes(),
    });
    noteAttachmentForToken(token, imported.id);

    const res = await call("read_pdf_fields", { attachmentId: imported.id });

    assert.equal(res.status, 200);
    assert.deepEqual((res.body.fields as Array<{ name: string }>).map((f) => f.name), [
      "CompanyName",
    ]);
    cleanUp();
  });

  test("an unrelated company file stays out of reach", async () => {
    const someoneElses = await storeAttachment({
      filename: "private.pdf",
      mimeType: "application/pdf",
      bytes: await pdfFormBytes(),
      uploadedByUserId: "another-user",
    });

    const res = await call("read_pdf_fields", { attachmentId: someoneElses.id });

    assert.equal(res.status, 404);
    cleanUp();
  });

  test("a file uploaded into this email's chat is reachable by any teammate on it", async () => {
    // The mail panel is shared per email thread, unlike a private 1:1 chat —
    // a colleague's upload into the same conversation is in front of everyone
    // working that thread.
    const chatTurn = await insert(MailChatMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      role: "user",
      content: "Here is the form",
      createdByUserId: "some-other-member",
    });
    const upload = await storeAttachment({
      filename: "uploaded.pdf",
      mimeType: "application/pdf",
      bytes: await pdfFormBytes(),
      uploadedByUserId: "some-other-member",
    });
    await AppDataSource.getRepository(Attachment).update(
      { id: upload.id },
      { messageId: chatTurn.id },
    );

    const res = await call("read_pdf_fields", { attachmentId: upload.id });

    assert.equal(res.status, 200);
    cleanUp();
  });

  test("filling a form produces a new attachment owned by this turn", async () => {
    const source = await storeAttachment({
      filename: "FIF_2026.pdf",
      mimeType: "application/pdf",
      bytes: await pdfFormBytes(),
    });
    noteAttachmentForToken(token, source.id);

    const res = await call("fill_pdf_form", {
      attachmentId: source.id,
      fields: { CompanyName: "HackerBay, Inc." },
    });

    assert.equal(res.status, 200);
    const produced = res.body.attachment as { id: string; filename: string };
    assert.equal(produced.filename, "FIF_2026-filled.pdf");
    assert.ok(
      tokenOwnsAttachment(token, produced.id),
      "the filled copy is this turn's too, so it can go onto a draft",
    );
    cleanUp();
  });

  test("a non-PDF is refused with an explanation", async () => {
    const notes = await storeAttachment({
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("just text"),
    });
    noteAttachmentForToken(token, notes.id);

    const res = await call("read_pdf_fields", { attachmentId: notes.id });

    assert.equal(res.status, 400);
    assert.match(res.body.error ?? "", /not a PDF/i);
    cleanUp();
  });
});

describe("attaching a file to outgoing mail", () => {
  test("a foreign attachment id is refused before any mail is composed", async () => {
    await grantMailbox("draft");
    const someoneElses = await storeAttachment({
      filename: "private.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF private"),
      uploadedByUserId: "another-user",
    });

    const res = await call("create_mail_draft", {
      threadId: thread.id,
      bodyText: "Attached.",
      attachments: [{ attachmentId: someoneElses.id }],
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error ?? "", /No attachment/);
    cleanUp();
  });

  test("an attachment that does not exist is refused the same way", async () => {
    await grantMailbox("draft");

    const res = await call("create_mail_draft", {
      threadId: thread.id,
      bodyText: "Attached.",
      attachments: [{ attachmentId: randomUUID() }],
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error ?? "", /No attachment/);
  });

  test("the draft grant is still required, attachment or not", async () => {
    await grantMailbox("read");
    const produced = await storeAttachment({
      filename: "filled.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF filled"),
    });
    noteAttachmentForToken(token, produced.id);

    const res = await call("create_mail_draft", {
      threadId: thread.id,
      bodyText: "Attached.",
      attachments: [{ attachmentId: produced.id }],
    });

    assert.equal(res.status, 403);
    cleanUp();
  });

  test("a spec naming both a chat attachment and a resource is rejected", async () => {
    await grantMailbox("draft");

    // Each item is exactly one kind of file. Accepting a mixed spec would mean
    // guessing which half the employee meant, and attaching the wrong file to
    // outgoing mail is not a guess worth making.
    const res = await call("create_mail_draft", {
      threadId: thread.id,
      bodyText: "Attached.",
      attachments: [{ attachmentId: randomUUID(), resourceSlug: "handbook" }],
    });

    assert.equal(res.status, 400);
    const issues = res.body.issues as Array<{ path?: Array<string | number> }> | undefined;
    assert.ok(
      issues?.some((issue) => issue.path?.[0] === "attachments"),
      "the refusal points at the attachments field",
    );
  });
});

describe("web tools", () => {
  test("refuse a URL pointed at the operator's own network", async () => {
    const res = await call("fetch_web_page", { url: "http://169.254.169.254/latest/meta-data/" });

    assert.equal(res.status, 502);
    assert.match(res.body.error ?? "", /non-public address/);
  });

  test("refuse a non-http scheme", async () => {
    const res = await call("download_web_file", { url: "file:///etc/passwd" });

    assert.equal(res.status, 400);
    assert.match(res.body.error ?? "", /http and https/i);
  });

  test("validate their inputs", async () => {
    assert.equal((await call("search_web", {})).status, 400);
    assert.equal((await call("search_web", { query: "forms", limit: 99 })).status, 400);
    assert.equal((await call("fetch_web_page", { url: "" })).status, 400);
  });

  test("are available to an interactive Member turn", async () => {
    // Not a 403 from the delegation gate — the refusal below comes from the
    // outbound guard, which means the tool itself was allowed to run.
    const res = await call("fetch_web_page", { url: "http://127.0.0.1:1/nope" });

    assert.notEqual(res.status, 403);
  });
});
