import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { addSuppression } from "../services/mail/suppression.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
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
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await closeTestDb();
});
beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Mail reader", slug: "mail-reader", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Reader",
    slug: "reader",
    role: "Reader",
    soulBody: "",
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "reader@example.com",
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: "provider-thread",
    subject: "A long conversation",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "read",
  });
  await insert(EmployeeRevenueGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

type ReadResponse = {
  message?: {
    messageId: string;
    bodyText: string;
    bodyCoverage: { nextOffset: number | null; complete: boolean; sourceComplete: boolean };
  };
  messages?: { messageId: string; bodyText: string }[];
  coverage?: {
    totalMessages: number;
    returnedMessages: number;
    nextMessageOffset: number | null;
    complete: boolean;
  };
  suppressed?: boolean;
  doNotContact?: boolean;
  suppression?: { reason: string; contactId: string | null } | null;
  email?: string;
};
async function call(tool: string, body: object) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ReadResponse };
}
async function message(
  number: number,
  bodyText = `${number}: New reply\nOn Monday, Pat wrote:\n${"old history\n".repeat(2_000)}`,
) {
  return insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: `message-${number}`,
    gmailThreadId: thread.gmailThreadId,
    bodyText,
    sentAt: new Date(Date.UTC(2026, 8, 1, 0, number)),
  });
}

test("thread reads page newest messages, keep chronological presentation, and explicitly recover older pages", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push((await message(i)).id);
  const first = await call("get_mail_thread", { threadId: thread.id });
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.messages?.map((row) => row.messageId),
    ids.slice(2),
  );
  assert.ok(first.body.messages?.every((row) => row.bodyText.length < 30));
  assert.equal(first.body.coverage?.totalMessages, 7);
  assert.equal(first.body.coverage?.nextMessageOffset, 5);
  assert.equal(first.body.coverage?.complete, false);
  const older = await call("get_mail_thread", { threadId: thread.id, messageOffset: 5 });
  assert.deepEqual(
    older.body.messages?.map((row) => row.messageId),
    ids.slice(0, 2),
  );
  assert.equal(older.body.coverage?.nextMessageOffset, null);
  assert.equal(older.body.coverage?.complete, false);
});

test("single-message continuation exposes original history without changing stored bodies", async () => {
  const row = await message(1);
  const read = await call("get_mail_message", {
    messageId: row.id,
    includeQuoted: true,
    bodyOffset: 100,
    maxBodyChars: 200,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.message?.bodyText, row.bodyText.slice(100, 300));
  assert.equal(read.body.message?.bodyCoverage.nextOffset, 300);
  assert.equal(read.body.message?.bodyCoverage.complete, false);
  assert.equal(
    (await AppDataSource.getRepository(MailMessage).findOneByOrFail({ id: row.id })).bodyText,
    row.bodyText,
  );
  await AppDataSource.getRepository(MailMessage).update(row.id, {
    bodyText: "",
    snippet: "Preview only",
  });
  const snippet = await call("get_mail_message", { messageId: row.id });
  assert.equal(snippet.body.message?.bodyCoverage.sourceComplete, false);
  assert.equal(snippet.body.message?.bodyCoverage.complete, false);
});

test("aggregate thread body budget and input bounds prevent oversized reads", async () => {
  for (let i = 0; i < 20; i++) await message(i, "x".repeat(30_000));
  const read = await call("get_mail_thread", {
    threadId: thread.id,
    messageLimit: 20,
    maxBodyChars: 20_000,
    includeQuoted: true,
  });
  assert.equal(read.status, 200);
  assert.equal(
    read.body.messages?.reduce((sum, row) => sum + row.bodyText.length, 0),
    40_000,
  );
  assert.equal(
    (await call("get_mail_thread", { threadId: thread.id, messageLimit: 21 })).status,
    400,
  );
  assert.equal(
    (await call("get_mail_message", { messageId: randomUUID(), bodyOffset: -1 })).status,
    400,
  );
});

test("reads keep mailbox and company boundaries, and discovery advertises the required Grants", async () => {
  const row = await message(1);
  await AppDataSource.getRepository(EmployeeMailAccountGrant).delete({ employeeId: employee.id });
  assert.equal((await call("get_mail_thread", { threadId: thread.id })).status, 403);
  assert.equal((await call("get_mail_message", { messageId: row.id })).status, 403);
  await AppDataSource.getRepository(MailMessage).update(row.id, { companyId: "other-company" });
  assert.equal((await call("get_mail_message", { messageId: row.id })).status, 404);
  await AppDataSource.getRepository(EmployeeRevenueGrant).delete({ employeeId: employee.id });
  assert.equal((await call("lookup_suppression", { email: "blocked@example.com" })).status, 403);
  const dead = await deadToolNames(employee.id);
  assert.ok(dead.has("get_mail_message"));
  assert.ok(dead.has("lookup_suppression"));
  for (const name of ["get_mail_thread", "get_mail_message", "lookup_suppression"]) {
    assert.equal(STATIC_TOOLS.find((tool) => tool.name === name)?.readOnly, true);
  }
});

test("suppression lookup handles addresses without Contacts, both block sources, and tenant isolation", async () => {
  await addSuppression({
    companyId: company.id,
    email: "blocked@example.com",
    reason: "unsubscribe",
    source: "mail",
  });
  const read = await call("lookup_suppression", { email: "Blocked <BLOCKED@Example.com>" });
  assert.equal(read.status, 200);
  assert.equal(read.body.email, "blocked@example.com");
  assert.equal(read.body.suppressed, true);
  assert.equal(read.body.suppression?.reason, "unsubscribe");
  assert.equal(read.body.suppression?.contactId, null);
  assert.equal(await AppDataSource.getRepository(Contact).count(), 0);
  await insert(Contact, {
    companyId: company.id,
    name: "Do not mail",
    email: "person@example.com",
    doNotContact: true,
  });
  const contact = await call("lookup_suppression", { email: "person@example.com" });
  assert.equal(contact.body.suppressed, true);
  assert.equal(contact.body.doNotContact, true);
  assert.equal(contact.body.suppression, null);
  await addSuppression({
    companyId: "other-company",
    email: "elsewhere@example.com",
    reason: "complaint",
  });
  assert.equal(
    (await call("lookup_suppression", { email: "elsewhere@example.com" })).body.suppressed,
    false,
  );
  assert.equal(
    (await call("lookup_suppression", { email: "blocked+sales@example.com" })).body.suppressed,
    false,
  );
  assert.equal((await call("lookup_suppression", { email: "garbage" })).status, 400);
});
