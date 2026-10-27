import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { Company } from "../db/entities/Company.js";
import { CompanyPolicy } from "../db/entities/CompanyPolicy.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Suppression } from "../db/entities/Suppression.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { indexMailboxAddresses } from "../services/mail/addressIndex.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mailRouter } from "./mail.js";

/**
 * The To / Cc / Bcc fields at the HTTP boundary: the mailbox's address book,
 * the do-not-email check behind a red chip, and forwarding an email with its
 * own files. Gmail is stubbed at `fetch`; everything else is the real router,
 * authentication and company membership included.
 */

type Suggestion = { email: string; name: string; count: number; lastAt: string | null };
type Blocked = { email: string; reason: string; detail: string };
type ApiError = { error?: string; issues?: Array<{ path?: Array<string | number> }> };

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const SELF = "ap@oneuptime.example";
const CONTRACT = Buffer.from("%PDF-1.7 signed contract");

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let account: MailAccount;
let source: MailMessage;
let sentMime: string[] = [];
let gmailCalls: string[] = [];

const originalFetch = globalThis.fetch;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function member(role: Role = "member", into: Company = company): Promise<User> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.com`,
    name: role,
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: into.id, userId: user.id, role });
  return user;
}

async function gmailAccount(into: Company, address: string): Promise<MailAccount> {
  const connection = await insert(IntegrationConnection, {
    companyId: into.id,
    provider: "google",
    label: "Gmail",
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(
      {
        clientId: "client",
        clientSecret: "secret",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: "https://www.googleapis.com/auth/gmail.modify",
        email: address,
      },
      into.id,
    ),
  });
  return insert(MailAccount, {
    companyId: into.id,
    connectionId: connection.id,
    provider: "gmail",
    address,
    status: "active",
  });
}

let minute = 0;
async function message(into: MailAccount, fields: Partial<MailMessage>): Promise<MailMessage> {
  minute += 1;
  const suffix = randomUUID();
  return insert(MailMessage, {
    companyId: into.companyId,
    accountId: into.id,
    threadId: `thread_${suffix}`,
    gmailMessageId: `gmail_${suffix}`,
    gmailThreadId: `gmail_thread_${suffix}`,
    toEmails: SELF,
    subject: "Hello",
    bodyText: "Hi",
    createdAt: new Date(Date.parse("2026-10-01T09:00:00Z") + minute * 60_000),
    ...fields,
  });
}

beforeEach(async () => {
  await resetTestDb();
  sentMime = [];
  gmailCalls = [];
  const owner = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Recipients Co",
    slug: `recipients-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  actingUserId = (await member("member")).id;
  account = await gmailAccount(company, SELF);
  for (let index = 0; index < 3; index += 1) {
    await message(account, { fromName: "Felix Menzel", fromEmail: "felix.menzel@assense.example" });
  }
  await message(account, {
    fromEmail: SELF,
    toEmails: '"Anna Berg" <anna@assense.example>',
  });
  const thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: "gmail-thread-contract",
    subject: "Signed contract",
  });
  source = await message(account, {
    threadId: thread.id,
    gmailMessageId: "gmail-contract",
    gmailThreadId: "gmail-thread-contract",
    fromName: "Felix Menzel",
    fromEmail: "felix.menzel@assense.example",
    subject: "Signed contract",
    attachmentsJson: JSON.stringify([
      {
        partId: "1",
        attachmentId: "stale-contract",
        filename: "contract.pdf",
        mimeType: "application/pdf",
        size: CONTRACT.length,
      },
    ]),
  });
  await indexMailboxAddresses(account, { now: new Date(Date.now() + 60 * 60_000) });
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<{ status: number; body: T }> {
  const response = await originalFetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gmailMessage(id: string, threadId: string, withFile: boolean): unknown {
  return {
    id,
    threadId,
    labelIds: withFile ? ["INBOX"] : ["SENT"],
    internalDate: "1786615200000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: withFile ? "Felix Menzel <felix.menzel@assense.example>" : SELF },
        { name: "To", value: withFile ? SELF : "legal@acme.example" },
        { name: "Subject", value: withFile ? "Signed contract" : "Fwd: Signed contract" },
      ],
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          body: { data: Buffer.from("Hi").toString("base64url") },
        },
        ...(withFile
          ? [
              {
                partId: "1",
                filename: "contract.pdf",
                mimeType: "application/pdf",
                body: { attachmentId: "fresh-contract", size: CONTRACT.length },
              },
            ]
          : []),
      ],
    },
  };
}

/** Gmail for one forward: read the original and its file, send, read the copy back. */
function stubGmail(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GMAIL_API)) return originalFetch(input as RequestInfo, init);
    const { pathname } = new URL(url);
    const path = pathname.replace("/gmail/v1", "");
    const method = (init?.method ?? "GET").toUpperCase();
    gmailCalls.push(`${method} ${path}`);
    if (method === "GET" && path === "/users/me/messages/gmail-contract") {
      return json(gmailMessage("gmail-contract", "gmail-thread-contract", true));
    }
    if (path === "/users/me/messages/gmail-contract/attachments/fresh-contract") {
      return json({ data: CONTRACT.toString("base64url"), size: CONTRACT.length });
    }
    if (method === "POST" && path === "/users/me/messages/send") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
      sentMime.push(Buffer.from(body.raw ?? "", "base64url").toString("utf8"));
      return json({ id: "gmail-sent-1", threadId: "gmail-thread-sent" });
    }
    if (method === "GET" && path === "/users/me/messages/gmail-sent-1") {
      return json(gmailMessage("gmail-sent-1", "gmail-thread-sent", false));
    }
    throw new Error(`unstubbed Gmail call: ${method} ${path}`);
  }) as typeof fetch;
}

describe("GET /mail/accounts/:aid/recipient-suggestions", () => {
  test("answers any Member with the mailbox's correspondents, best first", async () => {
    const res = await call<{ suggestions: Suggestion[] }>(
      "GET",
      `/mail/accounts/${account.id}/recipient-suggestions`,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.suggestions.map((person) => [person.email, person.name, person.count]),
      [
        ["felix.menzel@assense.example", "Felix Menzel", 4],
        ["anna@assense.example", "Anna Berg", 1],
      ],
    );
  });

  test("matches what is typed, and honours the limit", async () => {
    const typed = await call<{ suggestions: Suggestion[] }>(
      "GET",
      `/mail/accounts/${account.id}/recipient-suggestions?q=an&limit=5`,
    );
    assert.deepEqual(
      typed.body.suggestions.map((person) => person.email),
      ["anna@assense.example"],
    );
    const one = await call<{ suggestions: Suggestion[] }>(
      "GET",
      `/mail/accounts/${account.id}/recipient-suggestions?limit=1`,
    );
    assert.equal(one.body.suggestions.length, 1);
  });

  test("refuses a limit or a query out of bounds", async () => {
    for (const query of ["limit=0", "limit=21", "limit=abc", `q=${"a".repeat(321)}`]) {
      const res = await call<ApiError>(
        "GET",
        `/mail/accounts/${account.id}/recipient-suggestions?${query}`,
      );
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error, "ValidationError", query);
    }
  });

  test("never reaches into another company's mailbox", async () => {
    const otherOwner = await insert(User, {
      email: `other-${randomUUID()}@example.com`,
      name: "Other",
      passwordHash: "x",
      sessionVersion: 0,
    });
    const other = await insert(Company, {
      name: "Other",
      slug: `other-${randomUUID()}`,
      ownerId: otherOwner.id,
    });
    const foreign = await gmailAccount(other, "boss@other.example");
    const res = await call<ApiError>("GET", `/mail/accounts/${foreign.id}/recipient-suggestions`);
    assert.equal(res.status, 404);
    // Nor may a non-member read this company's.
    actingUserId = (await member("member", other)).id;
    const outsider = await call<ApiError>(
      "GET",
      `/mail/accounts/${account.id}/recipient-suggestions`,
    );
    assert.equal(outsider.status, 403);
  });

  test("needs a signed-in Member", async () => {
    actingUserId = null;
    const res = await call<ApiError>("GET", `/mail/accounts/${account.id}/recipient-suggestions`);
    assert.equal(res.status, 401);
  });
});

describe("POST /mail/accounts/:aid/recipient-check", () => {
  test("flags each blocked recipient once, with the reason, and nobody else", async () => {
    await insert(Suppression, {
      companyId: company.id,
      email: "support@oneuptime.example",
      reason: "manual",
      source: "test",
      notes: "",
    });
    await insert(CompanyPolicy, {
      companyId: company.id,
      title: "No competitors",
      body: "",
      blockedRecipientDomains: "rival.example",
      forbiddenTools: "",
      enabled: true,
    });
    const res = await call<{ blocked: Blocked[] }>(
      "POST",
      `/mail/accounts/${account.id}/recipient-check`,
      {
        to: "felix.menzel@assense.example",
        cc: "Support <support@oneuptime.example>",
        bcc: "ceo@rival.example, SUPPORT@oneuptime.example",
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.blocked, [
      {
        email: "support@oneuptime.example",
        reason: "suppressed",
        detail: "Added by hand to this company's do-not-email list",
      },
      {
        email: "ceo@rival.example",
        reason: "policy",
        detail: "Blocked by the policy “No competitors”",
      },
    ]);
  });

  test("an empty check is an empty answer", async () => {
    const res = await call<{ blocked: Blocked[] }>(
      "POST",
      `/mail/accounts/${account.id}/recipient-check`,
      {},
    );
    assert.deepEqual(res.body, { blocked: [] });
  });

  test("refuses fields it does not know, and lists that are too long", async () => {
    for (const body of [{ subject: "x" }, { to: "a".repeat(2_001) }, { cc: 42 }]) {
      const res = await call<ApiError>(
        "POST",
        `/mail/accounts/${account.id}/recipient-check`,
        body,
      );
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    }
  });

  test("404s a mailbox that is not this company's", async () => {
    const res = await call<ApiError>("POST", `/mail/accounts/${randomUUID()}/recipient-check`, {
      to: "a@b.example",
    });
    assert.equal(res.status, 404);
  });
});

describe("forwarding with the original's files", () => {
  test("sends the chosen attachment along, read fresh from Gmail", async () => {
    stubGmail();
    const res = await call<{ message: { id: string } }>(
      "POST",
      `/mail/accounts/${account.id}/send`,
      {
        to: "legal@acme.example",
        subject: "Fwd: Signed contract",
        bodyText: "See the signed contract.",
        forwardFrom: { messageId: source.id, attachmentIndexes: [0] },
      },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const mime = sentMime.at(-1) ?? "";
    assert.match(mime, /Content-Disposition: attachment; filename="contract.pdf"/);
    assert.ok(mime.includes(CONTRACT.toString("base64")), "the file travels as its real bytes");
    assert.ok(
      gmailCalls.includes("GET /users/me/messages/gmail-contract/attachments/fresh-contract"),
    );
  });

  test("404s an email from another mailbox, sending nothing", async () => {
    stubGmail();
    const other = await gmailAccount(company, "sales@oneuptime.example");
    const foreign = await message(other, {
      fromEmail: "felix.menzel@assense.example",
      attachmentsJson: source.attachmentsJson,
    });
    const res = await call<ApiError>("POST", `/mail/accounts/${account.id}/send`, {
      to: "legal@acme.example",
      bodyText: "x",
      forwardFrom: { messageId: foreign.id, attachmentIndexes: [0] },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "The email being forwarded is not in this mailbox.");
    assert.equal(sentMime.length, 0);
  });

  test("404s a file the email does not have", async () => {
    stubGmail();
    const res = await call<ApiError>("POST", `/mail/accounts/${account.id}/send`, {
      to: "legal@acme.example",
      bodyText: "x",
      forwardFrom: { messageId: source.id, attachmentIndexes: [3] },
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error ?? "", /No attachment at index 3/);
    assert.equal(sentMime.length, 0);
  });

  test("validates the forward reference", async () => {
    for (const forwardFrom of [
      { messageId: "not-a-uuid", attachmentIndexes: [0] },
      { messageId: source.id, attachmentIndexes: [-1] },
      { messageId: source.id, attachmentIndexes: Array.from({ length: 21 }, (_, index) => index) },
      { messageId: source.id, attachmentIndexes: [0], extra: true },
    ]) {
      for (const path of [
        `/mail/accounts/${account.id}/send`,
        `/mail/accounts/${account.id}/drafts`,
      ]) {
        const res = await call<ApiError>("POST", path, {
          to: "legal@acme.example",
          bodyText: "x",
          forwardFrom,
        });
        assert.equal(res.status, 400, `${path} ${JSON.stringify(forwardFrom).slice(0, 60)}`);
      }
    }
    assert.equal(sentMime.length, 0);
  });
});
