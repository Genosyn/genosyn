import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailChatMessage } from "../db/entities/MailChatMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { companyDir } from "../services/paths.js";
import { recordAttachmentBytes } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mailRouter } from "./mail.js";

/**
 * The HTTP surface for files in an email's AI chat: uploading one, getting it
 * back out, and who is allowed to. Exercised through the real router mount so
 * the auth and company-membership middleware run exactly as they do in
 * production.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let account: MailAccount;
let thread: MailThread;
let owner: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", mailRouter);
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

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: `assistant-owner-${randomUUID()}@example.com`,
    name: "Mailbox Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Assistant Files Co",
    slug: `assistant-files-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "ap@example.com",
    status: "paused",
    createdByUserId: owner.id,
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: randomUUID(),
    subject: "Syniti New Supplier Form US",
  });
});

function cleanUp(): void {
  fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function upload(
  filename: string,
  contents: string,
  type = "application/pdf",
): Promise<{ status: number; body: { attachment?: { id: string; filename: string } } }> {
  const form = new FormData();
  form.append("file", new Blob([contents], { type }), filename);
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/mail/accounts/${account.id}/assistant/attachments`,
    { method: "POST", body: form },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function download(attachmentId: string, accountId = account.id): Promise<Response> {
  return fetch(
    `${baseUrl}/api/companies/${company.id}/mail/accounts/${accountId}/assistant/attachments/${attachmentId}`,
  );
}

describe("uploading into an email's AI chat", () => {
  test("stores the file against the company and reports it back", async () => {
    const res = await upload("FIF_2026.pdf", "%PDF-1.7 supplier form");

    assert.equal(res.status, 201);
    const attachment = res.body.attachment;
    assert.ok(attachment);
    assert.equal(attachment.filename, "FIF_2026.pdf");

    const row = await AppDataSource.getRepository(Attachment).findOneByOrFail({
      id: attachment.id,
    });
    assert.equal(row.companyId, company.id);
    assert.equal(row.uploadedByUserId, owner.id);
    assert.equal(row.messageId, null, "unbound until the message is actually sent");
    cleanUp();
  });

  test("is refused for an unknown mailbox", async () => {
    const response = await fetch(
      `${baseUrl}/api/companies/${company.id}/mail/accounts/${randomUUID()}/assistant/attachments`,
      { method: "POST", body: new FormData() },
    );

    assert.equal(response.status, 404);
  });

  test("requires a signed-in Member", async () => {
    actingUserId = null;
    try {
      const res = await upload("FIF_2026.pdf", "%PDF");
      assert.equal(res.status, 401);
    } finally {
      actingUserId = owner.id;
    }
  });
});

describe("downloading a file from an email's AI chat", () => {
  test("serves an attachment bound to this mailbox's chat", async () => {
    const turn = await insert(MailChatMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      role: "assistant",
      content: "Here is the filled form.",
      status: "ok",
    });
    const produced = await recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      filename: "FIF_2026-filled.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF filled"),
      uploadedByUserId: null,
    });
    await AppDataSource.getRepository(Attachment).update(
      { id: produced.id },
      { messageId: turn.id },
    );

    const response = await download(produced.id);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "%PDF filled");
    assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    cleanUp();
  });

  test("serves the requester's own upload before it has been sent", async () => {
    const res = await upload("draft-notes.txt", "notes", "text/plain");
    const attachmentId = res.body.attachment!.id;

    const response = await download(attachmentId);

    assert.equal(response.status, 200);
    cleanUp();
  });

  test("refuses an unbound upload belonging to someone else", async () => {
    const stranger = await recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      filename: "someone-elses.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF private"),
      uploadedByUserId: "another-user",
    });

    const response = await download(stranger.id);

    assert.equal(response.status, 404);
    cleanUp();
  });

  test("refuses a file bound to a different mailbox's chat", async () => {
    const otherAccount = await insert(MailAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      address: "other@example.com",
      status: "paused",
      createdByUserId: owner.id,
    });
    const otherTurn = await insert(MailChatMessage, {
      companyId: company.id,
      accountId: otherAccount.id,
      threadId: randomUUID(),
      role: "assistant",
      content: "Other mailbox.",
      status: "ok",
    });
    const file = await recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      filename: "other-mailbox.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF other"),
      uploadedByUserId: null,
    });
    await AppDataSource.getRepository(Attachment).update(
      { id: file.id },
      { messageId: otherTurn.id },
    );

    // Asked for through the first mailbox's route, this is not visible —
    // the URL's account is part of the check, not decoration.
    const response = await download(file.id);

    assert.equal(response.status, 404);
    assert.equal((await download(file.id, otherAccount.id)).status, 200);
    cleanUp();
  });

  test("refuses an attachment from another company", async () => {
    const otherCompany = await insert(Company, {
      name: "Other Co",
      slug: `other-co-${randomUUID()}`,
      ownerId: "owner-2",
    });
    const foreign = await recordAttachmentBytes({
      companyId: otherCompany.id,
      companySlug: otherCompany.slug,
      filename: "foreign.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF foreign"),
      uploadedByUserId: owner.id,
    });

    const response = await download(foreign.id);

    assert.equal(response.status, 404);
    fs.rmSync(companyDir(otherCompany.slug), { recursive: true, force: true });
  });
});

describe("the panel bootstrap", () => {
  test("returns files on each turn and the model the chat is running on", async () => {
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Jamie Mallers",
      slug: "jamie",
      role: "Accounts payable",
      soulBody: "",
    });
    const model = await insert(AIModel, {
      employeeId: employee.id,
      provider: "anthropic",
      model: "claude-picked",
      authMode: "apikey",
      isActive: false,
      configJson: JSON.stringify({ apiKeyEncrypted: "encrypted-test-key" }),
      connectedAt: new Date(),
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "draft",
    });
    const turn = await insert(MailChatMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      role: "assistant",
      employeeId: employee.id,
      modelId: model.id,
      content: "Filled the form.",
      status: "ok",
    });
    const produced = await recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      filename: "FIF_2026-filled.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF filled"),
      uploadedByUserId: null,
    });
    await AppDataSource.getRepository(Attachment).update(
      { id: produced.id },
      { messageId: turn.id },
    );

    const res = await call<{
      messages: Array<{ id: string; attachments: Array<{ filename: string }> }>;
      roster: Array<{ id: string; models: Array<{ id: string; model: string }> }>;
      modelId: string | null;
    }>("GET", `/mail/accounts/${account.id}/assistant?threadId=${thread.id}`);

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.messages[0].attachments.map((a) => a.filename),
      ["FIF_2026-filled.pdf"],
      "a reload shows the same download the live turn did",
    );
    assert.equal(res.body.modelId, model.id, "the panel resumes on the model that answered");
    assert.deepEqual(
      res.body.roster.find((r) => r.id === employee.id)?.models.map((m) => m.model),
      ["claude-picked"],
    );
    cleanUp();
  });

  test("rejects a send payload with a malformed attachment id or model", async () => {
    const badAttachment = await call("POST", `/mail/accounts/${account.id}/assistant/messages`, {
      message: "hello",
      threadId: thread.id,
      attachmentIds: ["not-a-uuid"],
    });
    assert.equal(badAttachment.status, 400);

    const badModel = await call("POST", `/mail/accounts/${account.id}/assistant/messages`, {
      message: "hello",
      threadId: thread.id,
      modelId: "not-a-uuid",
    });
    assert.equal(badModel.status, 400);
  });
});
