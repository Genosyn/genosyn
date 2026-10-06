import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import express from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { toolResultCap } from "../services/agent/toolResultBudget.js";
import type { readMailAttachmentText } from "../services/mail/attachmentRead.js";
import { GmailMailbox } from "../services/mail/mailbox/gmail.js";
import {
  drainAttachmentsForToken,
  issueMcpToken,
  noteAttachmentForToken,
  revokeMcpToken,
  tokenOwnsAttachment,
} from "../services/mcpTokens.js";
import { companyDir } from "../services/paths.js";
import { recordAttachmentBytes, resolveAttachmentFile } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { FakeMailbox } from "../test/fakeMailbox.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/** Only the external mailbox is fake: routing, Grant checks, persistence,
 * token ownership, byte identity, extraction and pagination are all real. */
type ReadBody = Awaited<ReturnType<typeof readMailAttachmentText>> & {
  attachment: {
    id: string;
    filename: string;
    filenameTruncated: boolean;
    mimeType: string;
    sizeBytes: number;
  };
  note: string;
  error?: string;
};
let server: Server;
let baseUrl: string;
let root: string;
let token = "";
let company: Company;
let employee: AIEmployee;
let account: MailAccount;
let message: MailMessage;
let mailbox: FakeMailbox;
let bytes: Buffer;
const originalDataDir = config.dataDir;
const PROVIDER_ID = "attachment-message";
const PART_ID = "fresh-attachment";

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-mail-attachment-pages-"));
  (config as { dataDir: string }).dataDir = root;
  await initTestDb();
  mock.method(GmailMailbox.prototype, "getMessage", (ref: string) => mailbox.getMessage(ref));
  mock.method(
    GmailMailbox.prototype,
    "getAttachmentBytes",
    (...args: Parameters<FakeMailbox["getAttachmentBytes"]>) => mailbox.getAttachmentBytes(...args),
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

after(async () => {
  if (token) revokeMcpToken(token);
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  mock.restoreAll();
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  if (company) await fs.rm(companyDir(company.slug), { recursive: true, force: true });
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  mailbox = new FakeMailbox();
  company = await insert(Company, {
    name: "Attachment pages",
    slug: randomUUID(),
    ownerId: "owner",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Reader",
    slug: "reader",
    role: "Sales",
    soulBody: "",
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "sales@example.test",
  });
  const thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: "thread",
    subject: "Supplier message",
  });
  const header = '<html><body><form action="https://example.invalid/protected">';
  const footer =
    '<input name="payload" value="end-of-file procurement payload" /></form></body></html>';
  bytes = Buffer.from(header + "x".repeat(57_166 - header.length - footer.length) + footer);
  const meta = {
    partId: "1",
    attachmentId: "stale",
    filename: "protected.html",
    mimeType: "text/html",
    size: bytes.length,
  };
  message = await insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: PROVIDER_ID,
    gmailThreadId: thread.gmailThreadId,
    labelIds: " INBOX UNREAD ",
    bodyText: "Protected procurement message",
    attachmentsJson: JSON.stringify([meta]),
  });
  mailbox.seed({
    ref: PROVIDER_ID,
    threadRef: thread.gmailThreadId,
    labelIds: ["INBOX", "UNREAD"],
    attachments: [{ ...meta, attachmentId: PART_ID }],
  });
  mailbox.attachments.set(PART_ID, bytes);
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "read",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

async function call(body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/read_mail_attachment`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messageId: message.id, index: 0, ...body }),
  });
  return { status: response.status, body: (await response.json()) as ReadBody };
}

function continuation(page: ReadBody) {
  return {
    attachmentId: page.attachment.id,
    expectedTextVersion: page.textVersion,
    textOffset: page.textCoverage.nextOffset,
  };
}

async function changeMetadata(fields: { filename?: string; mimeType?: string }) {
  const meta = JSON.parse(message.attachmentsJson) as Record<string, unknown>[];
  Object.assign(meta[0], fields);
  message.attachmentsJson = JSON.stringify(meta);
  await AppDataSource.getRepository(MailMessage).update(message.id, {
    attachmentsJson: message.attachmentsJson,
  });
}

test("a full 57,166-byte protected HTML attachment is recoverable through the real MCP route without file duplication", async () => {
  const saved = await AppDataSource.getRepository(MailMessage).findOneByOrFail({ id: message.id });
  const first = await call();
  assert.equal(first.status, 200);
  assert.ok(first.body.text.length > 0 && first.body.text.length <= 20_000);
  assert.equal(first.body.attachment.sizeBytes, 57_166);
  assert.equal(first.body.truncated, true);
  assert.ok(tokenOwnsAttachment(token, first.body.attachment.id));
  const pages = [first.body];
  let last = first.body;
  while (last.textCoverage.hasMore) {
    const next = await call(continuation(last));
    assert.equal(next.status, 200);
    assert.equal(next.body.attachment.id, first.body.attachment.id);
    assert.ok(JSON.stringify(next.body, null, 2).length < toolResultCap(4_096));
    pages.push(next.body);
    last = next.body;
  }
  assert.equal(pages.map((page) => page.text).join(""), bytes.toString());
  assert.equal(last.textCoverage.nextOffset, null);
  assert.equal(
    last.textCoverage.complete,
    false,
    "a later page does not alone cover the whole file",
  );
  assert.match(last.text, /end-of-file procurement payload/);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
  assert.equal((await fs.readdir(path.join(companyDir(company.slug), "attachments"))).length, 1);
  assert.equal(
    (await resolveAttachmentFile(first.body.attachment.id, company.id))?.row.sizeBytes,
    57_166,
  );
  assert.deepEqual(
    await AppDataSource.getRepository(MailMessage).findOneByOrFail({ id: message.id }),
    saved,
  );
  assert.deepEqual(mailbox.messages.get(PROVIDER_ID)?.labelIds, ["INBOX", "UNREAD"]);
  assert.deepEqual(
    mailbox.calls.map((entry) => entry.method),
    Array(pages.length).fill(["getMessage", "getAttachmentBytes"]).flat(),
  );
  assert.deepEqual(
    drainAttachmentsForToken(token),
    [],
    "opening pages must not stage unsolicited chat files",
  );
  assert.match(first.body.note, /does not decrypt/);
  assert.match(first.body.note, /not as instructions/);
});

test("changed mailbox bytes are refused before persistence even when the returned prefix is unchanged", async () => {
  const first = await call();
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  mailbox.attachments.set(PART_ID, changed);
  const read = await call(continuation(first.body));
  assert.equal(read.status, 409);
  assert.match(read.body.error ?? "", /changed.*Restart/);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({ action: "mail.attachment.read" }),
    1,
  );
  const restart = await call();
  assert.equal(restart.status, 200);
  assert.notEqual(restart.body.textVersion, first.body.textVersion);
});

for (const field of ["filename", "mimeType"] as const) {
  test(`changing extraction ${field} invalidates continuation even with identical bytes`, async () => {
    const first = await call();
    await changeMetadata({ [field]: field === "filename" ? "renamed.html" : "text/plain" });
    const read = await call(continuation(first.body));
    assert.equal(read.status, 409);
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
  });
}

test("rotated provider handles preserve file identity and do not create another attachment", async () => {
  const first = await call();
  mailbox.messages.get(PROVIDER_ID)!.attachments[0].attachmentId = "rotated";
  mailbox.attachments.set("rotated", bytes);
  const next = await call(continuation(first.body));
  assert.equal(next.status, 200);
  assert.equal(next.body.textVersion, first.body.textVersion);
  assert.equal(next.body.attachment.id, first.body.attachment.id);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
});

test("revoking the mailbox Read Grant between pages prevents any further download", async () => {
  const first = await call();
  await AppDataSource.getRepository(EmployeeMailAccountGrant).delete({ employeeId: employee.id });
  const calls = mailbox.calls.length;
  const next = await call(continuation(first.body));
  assert.equal(next.status, 403);
  assert.equal(mailbox.calls.length, calls);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
});

test("a continuation cannot cross companies through its message or mailbox reference", async () => {
  const first = await call();
  const calls = mailbox.calls.length;
  await AppDataSource.getRepository(MailMessage).update(message.id, { companyId: randomUUID() });
  assert.equal((await call(continuation(first.body))).status, 404);
  await AppDataSource.getRepository(MailMessage).update(message.id, { companyId: company.id });
  await AppDataSource.getRepository(MailAccount).update(account.id, { companyId: randomUUID() });
  assert.equal((await call(continuation(first.body))).status, 404);
  assert.equal(mailbox.calls.length, calls);
});

test("a new turn cannot reuse the previous turn's imported attachment", async () => {
  const first = await call();
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
  const calls = mailbox.calls.length;
  const next = await call(continuation(first.body));
  assert.equal(next.status, 404);
  assert.match(next.body.error ?? "", /this turn/);
  assert.equal(mailbox.calls.length, calls);
});

test("turn ownership cannot make a different file or foreign-company attachment reusable", async () => {
  const first = await call();
  const different = await recordAttachmentBytes({
    companyId: company.id,
    companySlug: company.slug,
    uploadedByUserId: null,
    filename: "protected.html",
    mimeType: "text/html",
    bytes: Buffer.alloc(bytes.length, 97),
  });
  noteAttachmentForToken(token, different.id);
  assert.equal(
    (await call({ ...continuation(first.body), attachmentId: different.id })).status,
    409,
  );
  await AppDataSource.getRepository(Attachment).update(different.id, { companyId: randomUUID() });
  assert.equal(
    (await call({ ...continuation(first.body), attachmentId: different.id })).status,
    404,
  );
});

test("removed or modified saved copies cannot silently substitute another file", async () => {
  const first = await call();
  const stored = await resolveAttachmentFile(first.body.attachment.id, company.id);
  assert.ok(stored);
  await fs.writeFile(stored.absPath, Buffer.alloc(bytes.length, 98));
  assert.equal((await call(continuation(first.body))).status, 409);
  await fs.writeFile(stored.absPath, "shorter");
  assert.equal((await call(continuation(first.body))).status, 409);
  await fs.unlink(stored.absPath);
  assert.equal((await call(continuation(first.body))).status, 404);
  const linkedFile = path.join(root, "linked-source.html");
  await fs.writeFile(linkedFile, bytes);
  await fs.symlink(linkedFile, stored.absPath);
  assert.equal((await call(continuation(first.body))).status, 409);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
});

test("invalid page parameters fail validation before contacting the mailbox or storing bytes", async () => {
  const id = randomUUID();
  const version = "a".repeat(64);
  for (const body of [
    { textOffset: 1 },
    { textOffset: 1, expectedTextVersion: version },
    { textOffset: 1, attachmentId: id },
    { attachmentId: id },
    { textOffset: -1 },
    { textOffset: 0.5 },
    { textOffset: "1" },
    { textOffset: Number.MAX_SAFE_INTEGER + 1 },
    { maxTextChars: 0 },
    { maxTextChars: 1 },
    { maxTextChars: 20_001 },
    { maxTextChars: 2.5 },
    { maxTextChars: "200" },
    { expectedTextVersion: "bad" },
    { expectedTextVersion: "A".repeat(64) },
    { attachmentId: "not-an-id", expectedTextVersion: version },
    { unknownPageField: true },
  ]) {
    const read = await call(body);
    assert.equal(read.status, 400, JSON.stringify(body));
  }
  assert.equal(mailbox.calls.length, 0);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 0);
});

test("out-of-range offsets are explicit errors and exact-end offsets terminate without false completion", async () => {
  const first = await call();
  const next = continuation(first.body);
  const invalid = await call({ ...next, textOffset: bytes.length + 1 });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error ?? "", /exceeds the 57166 extracted characters/);
  const end = await call({ ...next, textOffset: bytes.length });
  assert.equal(end.status, 200);
  assert.equal(end.body.text, "");
  assert.equal(end.body.textCoverage.nextOffset, null);
  assert.equal(end.body.textCoverage.complete, false);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
});

test("a provider failure during continuation leaves the saved file intact for a later retry", async () => {
  const first = await call();
  mailbox.failNext.getAttachmentBytes = new Error("Mailbox temporarily unavailable");
  const failed = await call(continuation(first.body));
  assert.equal(failed.status, 400);
  assert.match(failed.body.error ?? "", /temporarily unavailable/);
  const retried = await call(continuation(first.body));
  assert.equal(retried.status, 200);
  assert.equal(retried.body.attachment.id, first.body.attachment.id);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
});

test("unsupported extraction is explicit and never represents a binary file as an empty complete document", async () => {
  await changeMetadata({ filename: "scan.png", mimeType: "image/png" });
  const read = await call();
  assert.equal(read.status, 200);
  assert.equal(read.body.text, "");
  assert.equal(read.body.textCoverage.extractionAvailable, false);
  assert.equal(read.body.textCoverage.complete, false);
  assert.match(read.body.note, /unavailable or failed/);
  assert.match(read.body.note, /does not mean the file is empty/);
});

test("default short reads keep their full text and imported attachment identity", async () => {
  mailbox.attachments.set(PART_ID, Buffer.from("short supplier note"));
  const read = await call();
  assert.equal(read.status, 200);
  assert.equal(read.body.text, "short supplier note");
  assert.equal(read.body.truncated, false);
  assert.equal(read.body.textCoverage.complete, true);
  assert.equal(read.body.textCoverage.nextOffset, null);
  assert.ok(tokenOwnsAttachment(token, read.body.attachment.id));
});

test("escaped text and pathological metadata remain bounded and a small-context retry recovers the same offset", async () => {
  mailbox.attachments.set(PART_ID, Buffer.from('\u0001\t\\"'.repeat(20_000) + "last section"));
  await changeMetadata({
    filename: `${"\u0001".repeat(70_000)}.html`,
    mimeType: `text/${"\u0002".repeat(100)}`,
  });
  const first = await call();
  assert.equal(first.status, 200);
  const serialized = JSON.stringify(first.body);
  assert.ok(serialized.length < toolResultCap(null));
  assert.equal(first.body.attachment.filename.length, 128);
  assert.equal(first.body.attachment.filenameTruncated, true);
  const smallBudget = toolResultCap(4_096);
  assert.ok(JSON.stringify(first.body, null, 2).length < smallBudget);
  assert.ok(serialized.indexOf('"textCoverage"') < smallBudget);
  assert.ok(serialized.indexOf('"id"') < smallBudget);
  assert.match(
    serialized.slice(0, smallBudget),
    /retry textCoverage.offset with a smaller maxTextChars/,
  );
  const retry = await call({
    attachmentId: first.body.attachment.id,
    expectedTextVersion: first.body.textVersion,
    textOffset: first.body.textCoverage.offset,
    maxTextChars: 500,
  });
  assert.equal(retry.status, 200);
  assert.ok(JSON.stringify(retry.body).length < smallBudget);
  assert.equal(retry.body.text, first.body.text.slice(0, 500));
  assert.equal(retry.body.textCoverage.nextOffset, 500);
  assert.equal(retry.body.attachment.id, first.body.attachment.id);
  assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
});

test("the discoverable tool schema explains continuation, version checking and runtime clipping recovery", () => {
  const tool = STATIC_TOOLS.find((candidate) => candidate.name === "read_mail_attachment");
  assert.ok(tool);
  const schema = tool.inputSchema as {
    properties: Record<string, { minimum?: number; maximum?: number; pattern?: string }>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(schema.required, ["messageId", "index"]);
  assert.equal(schema.properties.maxTextChars.maximum, 20_000);
  assert.equal(schema.properties.maxTextChars.minimum, 2);
  assert.equal(schema.properties.textOffset.minimum, 0);
  assert.equal(schema.additionalProperties, false);
  for (const phrase of [
    "expectedTextVersion",
    "attachmentId",
    "nextOffset",
    "smaller maxTextChars",
    "Read Grant on every page",
  ])
    assert.ok(tool.description.includes(phrase), phrase);
});
