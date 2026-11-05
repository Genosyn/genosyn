import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { SupportInbox } from "../db/entities/SupportInbox.js";
import { SupportTicket } from "../db/entities/SupportTicket.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { setSupportQueueAutoKickForTests } from "../services/support/queue.js";
import { mintRatingLink } from "../services/support/ratings.js";
import { setSupportMailboxForTests } from "../services/support/replies.js";
import { captureMessage, setSupportHeaderReaderForTests } from "../services/support/intake.js";
import { labelIdsToColumn } from "../services/mail/store.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { FakeMailbox } from "../test/fakeMailbox.js";
import { persistTestSession } from "../test/userSession.js";
import { publicSupportRouter, publicSupportSecurityHeaders } from "./publicSupport.js";
import { supportRouter } from "./support.js";

/**
 * Who may do what in Support, through the real routers over an in-memory database.
 *
 * Tickets, Articles and saved replies are every Member's. What decides how the
 * company speaks to customers is owners' and admins': a Member who could set an
 * inbox to reply on its own, or grant an AI Employee `reply`, could put words in
 * the company's mouth. And a customer's rating link reaches one thing only.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let owner: User;
let member: User;
let company: Company;
let account: MailAccount;
let mailbox: FakeMailbox;
let sequence = 0;

before(async () => {
  await initTestDb();
  setSupportQueueAutoKickForTests(false);
  setSupportHeaderReaderForTests(async () => []);
  const app = express();
  app.use("/api/feedback", publicSupportSecurityHeaders);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/feedback", publicSupportRouter);
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", supportRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  setSupportHeaderReaderForTests(null);
  setSupportMailboxForTests(null);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});

async function person(email: string, target: Company, role: Role): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId: target.id, userId: user.id, role });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  sequence = 0;
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "o" });
  owner = await person("owner@example.com", company, "owner");
  member = await person("member@example.com", company, "member");
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: "never",
    provider: "imap",
    address: "team@acme.com",
    status: "active",
    backfilledAt: new Date(),
  });
  mailbox = new FakeMailbox();
  setSupportMailboxForTests(async () => mailbox);
  actingUserId = owner.id;
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  who: User | null = owner,
): Promise<{ status: number; body: T & { error?: string; code?: string } }> {
  actingUserId = who?.id ?? null;
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as never };
}

async function inbox(): Promise<SupportInbox> {
  const response = await call<{ inbox: { id: string } }>("POST", "/support/inboxes", {
    accountId: account.id,
    name: "Support",
    addresses: ["support@acme.com"],
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  await AppDataSource.getRepository(SupportInbox).update(
    { id: response.body.inbox.id },
    { watchFrom: new Date(Date.now() - 60 * 60_000) },
  );
  return AppDataSource.getRepository(SupportInbox).findOneByOrFail({ id: response.body.inbox.id });
}

async function ticket(subject = "Can't sign in"): Promise<SupportTicket> {
  sequence += 1;
  const threadRef = `thread-${sequence}`;
  const threads = AppDataSource.getRepository(MailThread);
  const thread = await threads.save(
    threads.create({
      companyId: company.id,
      accountId: account.id,
      gmailThreadId: threadRef,
      subject,
      lastMessageAt: new Date(),
    }),
  );
  const message = await insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: `<m-${sequence}@mail>`,
    gmailThreadId: threadRef,
    messageIdHeader: `<m-${sequence}@mail>`,
    fromName: "Ada",
    fromEmail: "ada@customer.com",
    toEmails: "support@acme.com",
    subject,
    bodyText: "Help me please.",
    labelIds: labelIdsToColumn(["INBOX"]),
    sentAt: new Date(),
  });
  const result = await captureMessage({ account, message, headers: [] });
  assert.equal(result.outcome, "created");
  return AppDataSource.getRepository(SupportTicket).findOneByOrFail({
    id: (result as { ticketId: string }).ticketId,
  });
}

describe("who may do what", () => {
  test("nobody signed out reaches anything", async () => {
    const response = await call("GET", "/support/tickets", undefined, null);
    assert.equal(response.status, 401);
  });

  test("a Member works tickets, Articles and saved replies", async () => {
    await inbox();
    const open = await ticket();

    const list = await call<{ total: number }>(
      "GET",
      "/support/tickets?view=inbox",
      undefined,
      member,
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);

    const detail = await call<{ ticket: { id: string } }>(
      "GET",
      `/support/tickets/${open.id}`,
      undefined,
      member,
    );
    assert.equal(detail.body.ticket.id, open.id);

    const reply = await call(
      "POST",
      `/support/tickets/${open.id}/reply`,
      { body: "Try this." },
      member,
    );
    assert.equal(reply.status, 201, JSON.stringify(reply.body));

    const patched = await call<{ ticket: { priority: string } }>(
      "PATCH",
      `/support/tickets/${open.id}`,
      { priority: "high", assigneeUserId: member.id },
      member,
    );
    assert.equal(patched.body.ticket.priority, "high");

    const article = await call(
      "POST",
      "/support/articles",
      { title: "How?", body: "Like so.", status: "published" },
      member,
    );
    assert.equal(article.status, 201);
    const saved = await call(
      "POST",
      "/support/saved-replies",
      { name: "Hello", body: "Hi {{customer.first_name}}" },
      member,
    );
    assert.equal(saved.status, 201);
  });

  test("a Member can read how Support runs and change none of it", async () => {
    const created = await inbox();
    assert.equal((await call("GET", "/support/inboxes", undefined, member)).status, 200);
    assert.equal((await call("GET", "/support/settings", undefined, member)).status, 200);
    for (const [method, path, body] of [
      ["POST", "/support/inboxes", { accountId: account.id, name: "x", addresses: [] }],
      ["PATCH", `/support/inboxes/${created.id}`, { aiMode: "auto" }],
      ["POST", `/support/inboxes/${created.id}/import`, { days: 7 }],
      ["DELETE", `/support/inboxes/${created.id}`, undefined],
      ["PATCH", "/support/settings", { ratingsEnabled: true }],
      ["PUT", `/support/ai-access/${member.id}`, { accessLevel: "reply" }],
      ["DELETE", `/support/ai-access/${member.id}`, undefined],
    ] as const) {
      const response = await call(method, path, body, member);
      assert.equal(response.status, 403, `${method} ${path}`);
    }
    assert.equal(
      (await AppDataSource.getRepository(SupportInbox).findOneByOrFail({ id: created.id })).aiMode,
      "draft",
    );
  });

  test("an owner sets how far the AI goes, and it starts at drafts", async () => {
    const created = await inbox();
    assert.equal(created.aiMode, "draft");
    const updated = await call<{ inbox: { aiMode: string } }>(
      "PATCH",
      `/support/inboxes/${created.id}`,
      {
        aiMode: "auto",
      },
    );
    assert.equal(updated.body.inbox.aiMode, "auto");
  });

  test("another company's ticket is simply not there", async () => {
    await inbox();
    const mine = await ticket();
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: "x" });
    const outsider = await person("outsider@example.com", other, "owner");
    actingUserId = outsider.id;
    const response = await fetch(`${baseUrl}/api/companies/${other.id}/support/tickets/${mine.id}`);
    assert.equal(response.status, 404);
    const crossing = await fetch(
      `${baseUrl}/api/companies/${company.id}/support/tickets/${mine.id}`,
    );
    assert.equal(crossing.status, 403, "not a Member of this company");
  });
});

describe("the API's answers", () => {
  test("a stale reply says so in a way the page can act on", async () => {
    await inbox();
    const open = await ticket();
    const detail = await call<{ messages: Array<{ id: string }> }>(
      "GET",
      `/support/tickets/${open.id}`,
    );
    await call("POST", `/support/tickets/${open.id}/reply`, { body: "First." });
    const stale = await call("POST", `/support/tickets/${open.id}/reply`, {
      body: "Second.",
      basedOnMessageId: detail.body.messages[0].id,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "stale");
    assert.match(stale.body.error ?? "", /replied while you were writing/);
  });

  test("lists page by cursor and refuse one from other filters", async () => {
    await inbox();
    await ticket("One");
    await ticket("Two");
    const first = await call<{
      total: number;
      hasMore: boolean;
      nextCursor: string;
      rows: unknown[];
    }>("GET", "/support/tickets?view=inbox&limit=1");
    assert.equal(first.body.total, 2);
    assert.equal(first.body.rows.length, 1);
    const wrong = await call("GET", `/support/tickets?view=solved&cursor=${first.body.nextCursor}`);
    assert.equal(wrong.status, 400);
    const next = await call<{ hasMore: boolean; rows: unknown[] }>(
      "GET",
      `/support/tickets?view=inbox&limit=1&cursor=${first.body.nextCursor}`,
    );
    assert.equal(next.body.rows.length, 1);
    assert.equal(next.body.hasMore, false);
  });

  test("a bad address on an inbox is refused with a sentence", async () => {
    const response = await call("POST", "/support/inboxes", {
      accountId: account.id,
      name: "Support",
      addresses: ["not an address"],
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error ?? "", /not an email address/);
  });

  test("another company's mailbox cannot back an inbox", async () => {
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: "x" });
    const theirs = await insert(MailAccount, {
      companyId: other.id,
      connectionId: "theirs",
      provider: "imap",
      address: "their@other.com",
      status: "active",
    });
    const response = await call("POST", "/support/inboxes", {
      accountId: theirs.id,
      name: "Stolen",
      addresses: [],
    });
    assert.equal(response.status, 404);
  });

  test("a bulk change reports what it could not do without stopping", async () => {
    await inbox();
    const open = await ticket();
    const gone = "00000000-0000-4000-8000-000000000000";
    const response = await call<{ succeeded: string[]; skipped: Array<{ id: string }> }>(
      "POST",
      "/support/tickets/bulk",
      { ticketIds: [open.id, gone], status: "solved" },
    );
    assert.deepEqual(response.body.succeeded, [open.id]);
    assert.deepEqual(
      response.body.skipped.map((row) => row.id),
      [gone],
    );
  });

  test("a file that left the mailbox says so", async () => {
    await inbox();
    const open = await ticket();
    const detail = await call<{ messages: Array<{ id: string }> }>(
      "GET",
      `/support/tickets/${open.id}`,
    );
    await AppDataSource.getRepository(MailMessage).clear();
    const response = await call(
      "GET",
      `/support/tickets/${open.id}/messages/${detail.body.messages[0].id}/attachments/0`,
    );
    assert.equal(response.status, 409);
    assert.match(response.body.error ?? "", /no longer in the mailbox/);
  });
});

describe("a customer's rating link", () => {
  async function linkFor(open: SupportTicket) {
    const link = await mintRatingLink(open);
    return decodeURIComponent(link.split("/feedback/")[1]);
  }

  test("needs no account, reaches only the subject and a rating, and is never cached", async () => {
    await inbox();
    const open = await ticket("Private subject");
    const token = await linkFor(open);
    actingUserId = null;
    const response = await fetch(`${baseUrl}/api/feedback/${token}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      "comment",
      "companyName",
      "expired",
      "ratedAt",
      "reference",
      "score",
      "subject",
    ]);
    assert.ok(!JSON.stringify(body).includes("Help me please"), "no conversation");
    assert.ok(!JSON.stringify(body).includes("ada@customer.com"), "no address");
  });

  test("records nothing until a person presses the button", async () => {
    await inbox();
    const open = await ticket();
    const token = await linkFor(open);
    await fetch(`${baseUrl}/api/feedback/${token}`);
    assert.equal(
      (await AppDataSource.getRepository(SupportTicket).findOneByOrFail({ id: open.id }))
        .ratingScore,
      null,
    );
    const rated = await fetch(`${baseUrl}/api/feedback/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: 5, comment: "Great." }),
    });
    assert.equal(rated.status, 200);
    const row = await AppDataSource.getRepository(SupportTicket).findOneByOrFail({ id: open.id });
    assert.equal(row.ratingScore, 5);
    assert.equal(row.ratingComment, "Great.");
  });

  test("a comment with a NUL byte is kept without it", async () => {
    await inbox();
    const open = await ticket();
    const rated = await fetch(`${baseUrl}/api/feedback/${await linkFor(open)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: 4, comment: "Fine\u0000 thanks." }),
    });
    assert.equal(rated.status, 200);
    const row = await AppDataSource.getRepository(SupportTicket).findOneByOrFail({ id: open.id });
    assert.equal(row.ratingComment, "Fine thanks.");
  });

  test("a malformed link and an unknown one answer the same", async () => {
    const malformed = await fetch(`${baseUrl}/api/feedback/nope`);
    const unknown = await fetch(`${baseUrl}/api/feedback/${"a".repeat(43)}`);
    assert.equal(malformed.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await malformed.json(), await unknown.json());
  });

  test("a score outside one to five is refused", async () => {
    await inbox();
    const token = await linkFor(await ticket());
    const response = await fetch(`${baseUrl}/api/feedback/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: 11 }),
    });
    assert.equal(response.status, 400);
  });
});

describe("appointing an AI Employee", () => {
  test("must be someone at this company", async () => {
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: "x" });
    const theirs = await insert(AIEmployee, {
      companyId: other.id,
      name: "T",
      slug: "t",
      role: "R",
    });
    const response = await call("PATCH", "/support/settings", { aiEmployeeId: theirs.id });
    assert.equal(response.status, 404);
    const mine = await insert(AIEmployee, {
      companyId: company.id,
      name: "M",
      slug: "m",
      role: "R",
    });
    const ok = await call<{ settings: { aiEmployeeId: string } }>("PATCH", "/support/settings", {
      aiEmployeeId: mine.id,
    });
    assert.equal(ok.body.settings.aiEmployeeId, mine.id);
  });

  test("a topic keeps its key when it is renamed, and a made-up key is not trusted", async () => {
    const before = await call<{
      settings: { topics: Array<{ key: string; name: string; autoReply: boolean }> };
    }>("GET", "/support/settings");
    const topics = before.body.settings.topics.map((topic) =>
      topic.key === "billing" ? { ...topic, name: "Money" } : topic,
    );
    const after = await call<{ settings: { topics: Array<{ key: string; name: string }> } }>(
      "PATCH",
      "/support/settings",
      { topics: [...topics, { key: "made_up", name: "Refund requests" }] },
    );
    assert.equal(after.status, 200, JSON.stringify(after.body));
    const keys = after.body.settings.topics.map((topic) => topic.key);
    assert.ok(keys.includes("billing"));
    assert.ok(!keys.includes("made_up"));
    assert.ok(keys.includes("refund_requests"));
    assert.equal(
      after.body.settings.topics.find((topic) => topic.key === "billing")?.name,
      "Money",
    );
  });
});
