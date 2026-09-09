import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import type { MailAttachmentMeta } from "../services/mail/attachments.js";
import type { GmailPart } from "../services/mail/gmailClient.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { mailRouter } from "./mail.js";

/**
 * The download link on an editable draft reaches this real HTTP route. Gmail
 * alone is stubbed: session validation, company scoping, metadata lookup,
 * current attachment-handle resolution, and response headers all run normally.
 * Every row lives in dbHarness's private in-memory database; no real mailbox
 * or application database is contacted.
 */
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const MESSAGE_REF = "draft-download-message";
const THREAD_REF = "draft-download-thread";
const FILES = [
  {
    filename: "quotation.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0x0a]),
  },
  {
    filename: "notes.txt",
    mimeType: "text/plain",
    bytes: Buffer.from("Keep the original terms.\nSecond line.\n"),
  },
  {
    filename: "quotation.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from("%PDF-1.7 a different quotation with the same filename"),
  },
];

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let owner: User;
let company: Company;
let connection: IntegrationConnection;
let account: MailAccount;
let thread: MailThread;
let draft: MailMessage;
let metadata: MailAttachmentMeta[];
let currentParts: GmailPart[];
let bytesById: Map<string, Buffer>;
let providerFailure: "message" | "attachment" | null;
let gmailCalls: string[];
const originalFetch = globalThis.fetch;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.session = actingUserId ? { userId: actingUserId, sessionVersion: 0 } : null;
    await persistTestSession(req);
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
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await closeTestDb();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: `download-owner-${randomUUID()}@example.test`,
    name: "Download Owner",
    passwordHash: "test-only",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Download Fixtures",
    slug: `download-fixtures-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "google",
    label: "Fake Gmail",
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(
      {
        clientId: "test-client",
        clientSecret: "test-secret",
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: "https://www.googleapis.com/auth/gmail.modify",
        email: "mailbox@example.test",
      },
      company.id,
    ),
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: connection.id,
    address: "mailbox@example.test",
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: THREAD_REF,
    subject: "Download fixture",
  });
  metadata = FILES.map((file, index) => ({
    partId: `1.${index + 1}`,
    attachmentId: `stored-${index}`,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.bytes.length,
  }));
  currentParts = metadata.map((meta, index) => ({
    partId: meta.partId,
    filename: meta.filename,
    mimeType: meta.mimeType,
    body: { attachmentId: `fresh-${index}`, size: meta.size },
  }));
  bytesById = new Map(FILES.map((file, index) => [`fresh-${index}`, file.bytes]));
  draft = await insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: MESSAGE_REF,
    gmailThreadId: THREAD_REF,
    gmailDraftId: "draft-provider-handle",
    toEmails: "recipient@example.test",
    ccEmails: "copy@example.test",
    subject: "Re: Download fixture",
    bodyText: "The saved draft must stay unchanged when a file is downloaded.",
    labelIds: " DRAFT ",
    attachmentsJson: JSON.stringify(metadata),
  });
  providerFailure = null;
  gmailCalls = [];
  stubGmail();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubGmail(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${baseUrl}/`)) return originalFetch(input, init);
    assert.ok(url.startsWith(`${GMAIL_API}/`), "Only the fake Gmail endpoint may be contacted");
    const pathname = new URL(url).pathname.replace("/gmail/v1", "");
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    gmailCalls.push(`${method} ${pathname}`);
    assert.equal(method, "GET", "Downloading must never save, send, or remove a draft");
    if (pathname === `/users/me/messages/${MESSAGE_REF}`) {
      if (providerFailure === "message")
        return json({ error: { message: "Message unavailable" } }, 404);
      return json({
        id: MESSAGE_REF,
        threadId: THREAD_REF,
        labelIds: ["DRAFT"],
        payload: { mimeType: "multipart/mixed", parts: currentParts },
      });
    }
    const prefix = `/users/me/messages/${MESSAGE_REF}/attachments/`;
    assert.ok(pathname.startsWith(prefix), `Unexpected Gmail request: ${pathname}`);
    if (providerFailure === "attachment") {
      return json({ error: { message: "Attachment unavailable" } }, 403);
    }
    const id = decodeURIComponent(pathname.slice(prefix.length));
    assert.ok(bytesById.has(id), `Unexpected attachment handle: ${id}`);
    const bytes = bytesById.get(id)!;
    return json({ data: bytes.toString("base64url"), size: bytes.length });
  }) as typeof fetch;
}

function download(index: number | string = 0, messageId = draft.id, companyId = company.id) {
  return originalFetch(
    `${baseUrl}/api/companies/${companyId}/mail/messages/${messageId}/attachments/${encodeURIComponent(index)}`,
  );
}

async function assertError(response: Response, status: number, message: RegExp): Promise<void> {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("content-disposition"), null);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, message);
}

async function saveMetadata(): Promise<void> {
  await AppDataSource.getRepository(MailMessage).update(draft.id, {
    attachmentsJson: JSON.stringify(metadata),
  });
}

async function anotherCompany(): Promise<Company> {
  return insert(Company, {
    name: "Other Download Fixtures",
    slug: `other-download-fixtures-${randomUUID()}`,
    ownerId: owner.id,
  });
}

describe("saved draft attachment downloads", () => {
  test("returns exact binary bytes with download, media type, length, and nosniff headers", async () => {
    const response = await download();

    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), FILES[0].bytes);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-length"), String(FILES[0].bytes.length));
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="quotation.pdf"',
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(gmailCalls, [
      `GET /users/me/messages/${MESSAGE_REF}`,
      `GET /users/me/messages/${MESSAGE_REF}/attachments/fresh-0`,
    ]);
  });

  test("uses original indexes even when two files have the same filename and are clicked out of order", async () => {
    for (const index of [2, 0, 1]) {
      const response = await download(index);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), FILES[index].bytes);
      assert.equal(
        response.headers.get("content-disposition"),
        `attachment; filename="${FILES[index].filename}"`,
      );
    }
    assert.deepEqual(
      gmailCalls.filter((call) => call.includes("/attachments/")),
      [2, 0, 1].map((index) => `GET /users/me/messages/${MESSAGE_REF}/attachments/fresh-${index}`),
    );
  });

  test("repeated reads refresh provider handles and leave every persisted draft and thread field unchanged", async () => {
    const messages = AppDataSource.getRepository(MailMessage);
    const threads = AppDataSource.getRepository(MailThread);
    const beforeDraft = await messages.findOneByOrFail({ id: draft.id });
    const beforeThread = await threads.findOneByOrFail({ id: thread.id });
    for (const handle of ["first-read", "second-read"]) {
      currentParts[0].body = { attachmentId: handle, size: FILES[0].bytes.length };
      bytesById.set(handle, FILES[0].bytes);
      const response = await download();
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), FILES[0].bytes);
    }

    assert.deepEqual(await messages.findOneByOrFail({ id: draft.id }), beforeDraft);
    assert.deepEqual(await threads.findOneByOrFail({ id: thread.id }), beforeThread);
    assert.equal(await messages.count(), 1);
    assert.deepEqual(
      gmailCalls.filter((call) => call.includes("/attachments/")),
      ["first-read", "second-read"].map(
        (handle) => `GET /users/me/messages/${MESSAGE_REF}/attachments/${handle}`,
      ),
    );
  });

  test("uses a download media type when the saved MIME type is absent", async () => {
    metadata[0].mimeType = "";
    await saveMetadata();
    const response = await download();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), FILES[0].bytes);
  });

  test("removes quotes and line breaks from the download filename header", async () => {
    metadata[0].filename = 'quotation "signed"\r\n2026.pdf';
    await saveMetadata();
    const response = await download();
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="quotation signed2026.pdf"',
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), FILES[0].bytes);
  });

  test("downloads a file whose saved filename contains non-Latin characters", async () => {
    metadata[0].filename = "見積書-2026.pdf";
    await saveMetadata();
    const response = await download();
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), FILES[0].bytes);
    const disposition = response.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment;/);
    assert.ok(
      disposition.includes(`filename*=UTF-8''${encodeURIComponent(metadata[0].filename)}`),
      "The encoded header preserves the filename",
    );
  });
});

describe("unavailable draft attachments", () => {
  test("returns a clear error for a missing message without contacting Gmail", async () => {
    await assertError(await download(0, randomUUID()), 404, /message not found/i);
    assert.deepEqual(gmailCalls, []);
  });

  test("returns a clear error for a missing mailbox without contacting Gmail", async () => {
    await AppDataSource.getRepository(MailAccount).delete(account.id);
    await assertError(await download(), 404, /mail account not found/i);
    assert.deepEqual(gmailCalls, []);
  });

  for (const [name, value] of [
    ["no files", "[]"],
    ["malformed metadata", "not-json"],
    ["non-array metadata", '{"filename":"quotation.pdf"}'],
  ]) {
    test(`returns a clear error for ${name} without contacting Gmail`, async () => {
      await AppDataSource.getRepository(MailMessage).update(draft.id, { attachmentsJson: value });
      await assertError(await download(), 404, /no attachments/i);
      assert.deepEqual(gmailCalls, []);
    });
  }

  for (const index of ["99", String(Number.MAX_SAFE_INTEGER)]) {
    test(`rejects unavailable index ${index} before contacting Gmail`, async () => {
      await assertError(await download(index), 404, /no attachment at index/i);
      assert.deepEqual(gmailCalls, []);
    });
  }

  for (const index of [
    "-1",
    "not-an-index",
    "1.5",
    "1suffix",
    "1e0",
    "+1",
    " 1",
    "9007199254740992",
  ]) {
    test(`rejects malformed index ${index} instead of downloading another file`, async () => {
      const response = await download(index);
      await assertError(response, 400, /ValidationError/);
      assert.deepEqual(gmailCalls, []);
    });
  }

  test("reports a provider message lookup failure as an error instead of a file", async () => {
    providerFailure = "message";
    await assertError(await download(), 400, /message unavailable/i);
    assert.equal(gmailCalls.length, 1);
  });

  test("reports provider attachment failure and preserves the saved draft for another attempt", async () => {
    const messages = AppDataSource.getRepository(MailMessage);
    const beforeDraft = await messages.findOneByOrFail({ id: draft.id });
    providerFailure = "attachment";
    await assertError(await download(), 400, /attachment unavailable/i);
    assert.deepEqual(await messages.findOneByOrFail({ id: draft.id }), beforeDraft);
    providerFailure = null;
    const retry = await download();
    assert.equal(retry.status, 200);
    assert.deepEqual(Buffer.from(await retry.arrayBuffer()), FILES[0].bytes);
  });

  test("reports empty provider bytes instead of downloading an empty file", async () => {
    bytesById.set("fresh-0", Buffer.alloc(0));
    await assertError(await download(), 404, /attachment is empty/i);
  });

  test("reports a removed mailbox Connection without making an external request", async () => {
    await AppDataSource.getRepository(IntegrationConnection).delete(connection.id);
    await assertError(await download(), 400, /connection/i);
    assert.deepEqual(gmailCalls, []);
  });
});

describe("download session and company boundaries", () => {
  test("requires a signed-in Member before looking up or downloading files", async () => {
    actingUserId = null;
    await assertError(await download(), 401, /unauthorized/i);
    assert.deepEqual(gmailCalls, []);
  });

  test("rejects an invalidated session before contacting Gmail", async () => {
    await AppDataSource.getRepository(User).update(owner.id, { sessionVersion: 1 });
    await assertError(await download(), 401, /unauthorized/i);
    assert.deepEqual(gmailCalls, []);
  });

  test("rejects a signed-in person without company membership", async () => {
    const outsider = await insert(User, {
      email: `download-outsider-${randomUUID()}@example.test`,
      name: "Outside Member",
      passwordHash: "test-only",
      sessionVersion: 0,
    });
    actingUserId = outsider.id;
    await assertError(await download(), 403, /forbidden/i);
    assert.deepEqual(gmailCalls, []);
  });

  test("permits an ordinary company Member to download without an admin role", async () => {
    await AppDataSource.getRepository(Membership).update(
      { companyId: company.id, userId: owner.id },
      { role: "member" },
    );
    const response = await download();
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), FILES[0].bytes);
  });

  test("does not reveal a draft through a different company even to a Member of both", async () => {
    const other = await anotherCompany();
    await insert(Membership, { companyId: other.id, userId: owner.id, role: "member" });
    await assertError(await download(0, draft.id, other.id), 404, /message not found/i);
    assert.deepEqual(gmailCalls, []);
  });

  test("refuses another company's message id through the current company route", async () => {
    const other = await anotherCompany();
    const foreign = await insert(MailMessage, {
      companyId: other.id,
      accountId: randomUUID(),
      threadId: randomUUID(),
      gmailMessageId: "foreign-message",
      gmailThreadId: "foreign-thread",
      gmailDraftId: "foreign-draft",
      attachmentsJson: JSON.stringify(metadata),
    });
    await assertError(await download(0, foreign.id), 404, /message not found/i);
    assert.deepEqual(gmailCalls, []);
  });

  test("does not follow a mismatched mailbox reference into another company", async () => {
    const other = await anotherCompany();
    const foreign = await insert(MailAccount, {
      companyId: other.id,
      connectionId: randomUUID(),
      address: "other-mailbox@example.test",
    });
    await AppDataSource.getRepository(MailMessage).update(draft.id, { accountId: foreign.id });
    await assertError(await download(), 404, /mail account not found/i);
    assert.deepEqual(gmailCalls, []);
  });
});
