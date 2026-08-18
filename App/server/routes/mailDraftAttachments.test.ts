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
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mailRouter } from "./mail.js";

/**
 * Attaching files to a draft.
 *
 * Editing a draft replaces it wholesale: Gmail takes the raw MIME we build and
 * throws the old draft away. That made two things impossible from the draft
 * card — adding a file to a draft, and editing the wording of a draft that
 * already had one without silently losing it. Both are covered here through
 * the real router mount, with Gmail stubbed at `fetch`, so the assertions are
 * about the MIME that actually leaves the process.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const DRAFT_MESSAGE_ID = "gmail-message-draft";
const UPDATED_MESSAGE_ID = "gmail-message-updated";
const GMAIL_DRAFT_ID = "gmail-draft-1";
const GMAIL_THREAD_ID = "gmail-thread-1";

const FORM_BYTES = Buffer.from("%PDF-1.7 supplier form");
const NOTES_BYTES = Buffer.from("bank details");

const DRAFT_ATTACHMENTS = [
  {
    partId: "1.1",
    attachmentId: "stored-form",
    filename: "FIF_2026.pdf",
    mimeType: "application/pdf",
    size: FORM_BYTES.length,
  },
  {
    partId: "1.2",
    attachmentId: "stored-notes",
    filename: "bank-notes.txt",
    mimeType: "text/plain",
    size: NOTES_BYTES.length,
  },
];

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let account: MailAccount;
let thread: MailThread;
let draft: MailMessage;

const originalFetch = globalThis.fetch;

/** Every Gmail call the router made, in order, as `METHOD /path`. */
let gmailCalls: string[] = [];
/** The raw MIME (decoded) handed to `drafts.update`, newest last. */
let sentMime: string[] = [];

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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await resetTestDb();
  gmailCalls = [];
  sentMime = [];
  const owner = await insert(User, {
    email: `draft-owner-${randomUUID()}@example.com`,
    name: "Mailbox Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Draft Files Co",
    slug: `draft-files-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  const connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "google",
    label: "Test Gmail",
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(
      {
        clientId: "client",
        clientSecret: "secret",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: "https://www.googleapis.com/auth/gmail.modify",
        email: "ap@example.com",
      },
      company.id,
    ),
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: connection.id,
    address: "ap@example.com",
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: GMAIL_THREAD_ID,
    subject: "Syniti New Supplier Form US",
  });
  draft = await insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: DRAFT_MESSAGE_ID,
    gmailThreadId: GMAIL_THREAD_ID,
    gmailDraftId: GMAIL_DRAFT_ID,
    toEmails: "accountspayable@syniti.com",
    subject: "Re: Syniti New Supplier Form US",
    bodyText: "HackerBay, Inc. is a U.S. entity.",
    labelIds: " DRAFT ",
    attachmentsJson: JSON.stringify(DRAFT_ATTACHMENTS),
  });
});

/** A Gmail `messages.get` payload for the draft, with its two files. */
function draftPayload(id: string): unknown {
  return {
    id,
    threadId: GMAIL_THREAD_ID,
    labelIds: ["DRAFT"],
    internalDate: "1786615200000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "AP <ap@example.com>" },
        { name: "To", value: "accountspayable@syniti.com" },
        { name: "Subject", value: "Re: Syniti New Supplier Form US" },
      ],
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          body: { data: Buffer.from("HackerBay, Inc. is a U.S. entity.").toString("base64url") },
        },
        {
          partId: "1.1",
          filename: "FIF_2026.pdf",
          mimeType: "application/pdf",
          // Gmail reissues attachment ids over time — the stored ones are
          // deliberately stale so the positional resolve is exercised.
          body: { attachmentId: "fresh-form", size: FORM_BYTES.length },
        },
        {
          partId: "1.2",
          filename: "bank-notes.txt",
          mimeType: "text/plain",
          body: { attachmentId: "fresh-notes", size: NOTES_BYTES.length },
        },
      ],
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stub Gmail; anything else (our own test server) goes to the real fetch. */
function stubGmail(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GMAIL_API)) return originalFetch(input as RequestInfo, init);
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace("/gmail/v1", "");
    const method = (init?.method ?? "GET").toUpperCase();
    gmailCalls.push(`${method} ${path}`);

    if (method === "PUT" && path === `/users/me/drafts/${GMAIL_DRAFT_ID}`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { message?: { raw?: string } };
      sentMime.push(Buffer.from(body.message?.raw ?? "", "base64url").toString("utf8"));
      return json({
        id: GMAIL_DRAFT_ID,
        message: { id: UPDATED_MESSAGE_ID, threadId: GMAIL_THREAD_ID },
      });
    }
    if (path === `/users/me/messages/${DRAFT_MESSAGE_ID}/attachments/fresh-form`) {
      return json({ data: FORM_BYTES.toString("base64url"), size: FORM_BYTES.length });
    }
    if (path === `/users/me/messages/${DRAFT_MESSAGE_ID}/attachments/fresh-notes`) {
      return json({ data: NOTES_BYTES.toString("base64url"), size: NOTES_BYTES.length });
    }
    if (path === `/users/me/messages/${DRAFT_MESSAGE_ID}`) {
      return json(draftPayload(DRAFT_MESSAGE_ID));
    }
    if (path === `/users/me/messages/${UPDATED_MESSAGE_ID}`) {
      return json(draftPayload(UPDATED_MESSAGE_ID));
    }
    if (path === `/users/me/threads/${GMAIL_THREAD_ID}`) {
      return json({ id: GMAIL_THREAD_ID, messages: [draftPayload(UPDATED_MESSAGE_ID)] });
    }
    throw new Error(`unstubbed Gmail call: ${method} ${path}?${searchParams.toString()}`);
  }) as typeof fetch;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await originalFetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** Stage a file the way the compose UI does, returning its token. */
async function stage(filename: string, contents: string, type: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([contents], { type }), filename);
  const response = await originalFetch(
    `${baseUrl}/api/companies/${company.id}/mail/accounts/${account.id}/outbox-attachments`,
    { method: "POST", body: form },
  );
  const parsed = (await response.json()) as { attachment: { id: string } };
  assert.equal(response.status, 200, "staging an outbound attachment should succeed");
  return parsed.attachment.id;
}

async function patchDraft(body: Record<string, unknown>): Promise<{ status: number; body: never }> {
  return call("PATCH", `/mail/drafts/${draft.id}`, body);
}

/** Filenames in the order they appear in the last MIME we handed Gmail. */
function attachedFilenames(): string[] {
  const mime = sentMime.at(-1) ?? "";
  return [...mime.matchAll(/Content-Disposition: attachment; filename="([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
}

/** True when the given bytes ride along in the last MIME. Every part is
 *  base64 — the body included — so this is how content is asserted. */
function mimeCarries(bytes: Buffer): boolean {
  return (sentMime.at(-1) ?? "").includes(bytes.toString("base64"));
}

describe("editing a draft that already has files", () => {
  test("keeps them when the client says nothing about attachments", async () => {
    stubGmail();

    const res = await patchDraft({
      to: "accountspayable@syniti.com",
      subject: "Re: Syniti New Supplier Form US",
      bodyText: "Reworded, files untouched.",
    });

    assert.equal(res.status, 200);
    assert.deepEqual(
      attachedFilenames(),
      ["FIF_2026.pdf", "bank-notes.txt"],
      "a wording change must not quietly strip the draft's files",
    );
    assert.ok(mimeCarries(FORM_BYTES), "the kept file travels as real bytes, not just a name");
    assert.ok(mimeCarries(NOTES_BYTES));
    assert.ok(
      mimeCarries(Buffer.from("Reworded, files untouched.")),
      "the reworded body is what got saved",
    );
  });

  test("keeps only the ones the editor still shows", async () => {
    stubGmail();

    const res = await patchDraft({
      to: "accountspayable@syniti.com",
      bodyText: "Dropped the notes.",
      keepAttachmentIndexes: [0],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(attachedFilenames(), ["FIF_2026.pdf"]);
    assert.equal(mimeCarries(NOTES_BYTES), false, "the removed file is gone from the draft");
  });

  test("an explicit empty list clears every file", async () => {
    stubGmail();

    const res = await patchDraft({
      to: "accountspayable@syniti.com",
      bodyText: "No files any more.",
      keepAttachmentIndexes: [],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(attachedFilenames(), []);
    assert.equal(
      gmailCalls.some((c) => c.includes("/attachments/")),
      false,
      "clearing the list should not download bytes only to discard them",
    );
  });

  test("downloads the kept files with one message fetch, not one each", async () => {
    stubGmail();

    await patchDraft({ to: "accountspayable@syniti.com", bodyText: "Both kept." });

    const beforeUpdate = gmailCalls.slice(
      0,
      gmailCalls.indexOf(`PUT /users/me/drafts/${GMAIL_DRAFT_ID}`),
    );
    assert.deepEqual(beforeUpdate, [
      `GET /users/me/messages/${DRAFT_MESSAGE_ID}`,
      `GET /users/me/messages/${DRAFT_MESSAGE_ID}/attachments/fresh-form`,
      `GET /users/me/messages/${DRAFT_MESSAGE_ID}/attachments/fresh-notes`,
    ]);
  });

  test("resolves the attachment id Gmail reports now, not the stored one", async () => {
    stubGmail();

    await patchDraft({ to: "accountspayable@syniti.com", bodyText: "Both kept." });

    assert.equal(
      gmailCalls.some((c) => c.includes("stored-form") || c.includes("stored-notes")),
      false,
      "stale stored ids would 404 against Gmail",
    );
  });

  test("a download failure leaves the draft untouched rather than half-written", async () => {
    stubGmail();
    const gmail = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/attachments/fresh-notes")) return json({ error: "boom" }, 500);
      return gmail(input as RequestInfo, init);
    }) as typeof fetch;

    const res = await patchDraft({ to: "accountspayable@syniti.com", bodyText: "Reworded." });

    assert.equal(res.status, 400);
    assert.equal(sentMime.length, 0, "Gmail was never asked to replace the draft");
    const row = await AppDataSource.getRepository(MailMessage).findOneByOrFail({ id: draft.id });
    assert.equal(row.bodyText, "HackerBay, Inc. is a U.S. entity.");
    assert.equal(row.attachmentsJson, JSON.stringify(DRAFT_ATTACHMENTS));
  });
});

describe("adding a file to a draft", () => {
  test("attaches a staged upload alongside the files already there", async () => {
    const token = await stage("w9.pdf", "%PDF-1.7 w9", "application/pdf");
    stubGmail();

    const res = await patchDraft({
      to: "accountspayable@syniti.com",
      bodyText: "W-9 attached.",
      attachmentIds: [token],
      keepAttachmentIndexes: [0, 1],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(
      attachedFilenames(),
      ["FIF_2026.pdf", "bank-notes.txt", "w9.pdf"],
      "new files append after the ones already on the draft",
    );
    assert.ok((sentMime.at(-1) ?? "").includes(Buffer.from("%PDF-1.7 w9").toString("base64")));
  });

  test("attaches a staged upload to a draft that had no files at all", async () => {
    await AppDataSource.getRepository(MailMessage).update(
      { id: draft.id },
      { attachmentsJson: "[]" },
    );
    const token = await stage("w9.pdf", "%PDF-1.7 w9", "application/pdf");
    stubGmail();

    const res = await patchDraft({
      to: "accountspayable@syniti.com",
      bodyText: "W-9 attached.",
      attachmentIds: [token],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(attachedFilenames(), ["w9.pdf"]);
    assert.equal(
      gmailCalls.some((c) => c.includes("/attachments/")),
      false,
      "a draft with nothing to keep should not fetch anything",
    );
  });

  test("a token from another mailbox is ignored instead of leaking across accounts", async () => {
    const otherAccount = await insert(MailAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      address: "other@example.com",
    });
    const form = new FormData();
    form.append("file", new Blob(["secret"], { type: "text/plain" }), "secret.txt");
    const staged = (await (
      await originalFetch(
        `${baseUrl}/api/companies/${company.id}/mail/accounts/${otherAccount.id}/outbox-attachments`,
        { method: "POST", body: form },
      )
    ).json()) as { attachment: { id: string } };
    stubGmail();

    const res = await patchDraft({
      to: "accountspayable@syniti.com",
      bodyText: "Nothing of yours here.",
      attachmentIds: [staged.attachment.id],
      keepAttachmentIndexes: [],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(attachedFilenames(), []);
  });

  test("rejects a keep list that points past the end of the draft", async () => {
    stubGmail();

    const res = await patchDraft({
      to: "accountspayable@syniti.com",
      bodyText: "Bad index.",
      keepAttachmentIndexes: [5],
    });

    assert.equal(res.status, 400);
    assert.equal(sentMime.length, 0);
  });

  test("rejects a negative keep index at the schema boundary", async () => {
    stubGmail();

    const res = await patchDraft({
      to: "accountspayable@syniti.com",
      bodyText: "Bad index.",
      keepAttachmentIndexes: [-1],
    });

    assert.equal(res.status, 400);
    assert.equal(gmailCalls.length, 0, "validation runs before anything reaches Gmail");
  });
});
