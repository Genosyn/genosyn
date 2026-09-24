import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { Decision } from "../db/entities/Decision.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { Estimate } from "../db/entities/Estimate.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailHandover } from "../db/entities/MailHandover.js";
import { MailInboundAnalysis } from "../db/entities/MailInboundAnalysis.js";
import { MailInboundAutomation } from "../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { mailRouter } from "./mail.js";
import { mcpInternalRouter } from "./mcpInternal.js";

type ReviewSummary = {
  status: "not_reviewed" | "queued" | "reviewing" | "reviewed" | "needs_attention";
  latestMessageId: string | null;
  employee: { id: string; name: string; slug: string; avatarKey: string | null } | null;
  updatedAt: string | null;
};
type TimelineEvent = {
  id: string;
  kind: string;
  occurredAt: string;
  title: string;
  description: string | null;
  employee: ReviewSummary["employee"];
  href: string | null;
  status: "complete" | "running" | "pending" | "failed";
};
type ThreadResponse = {
  thread: { id: string; aiReview: ReviewSummary };
  reviewTimeline: { events: TimelineEvent[]; truncated: boolean };
};
type ListResponse = { threads: Array<ThreadResponse["thread"]>; nextBefore: string | null };

let server: Server;
let origin = "";
let actingUserId: string | null = null;
let company: Company;
let account: MailAccount;
let employee: AIEmployee;
let owner: User;
let thread: MailThread;
let inbound: MailMessage;
const tokens: string[] = [];
const time = (minute: number) => new Date(Date.UTC(2026, 8, 24, 10, minute));

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
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
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const token of tokens) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  for (const token of tokens.splice(0)) revokeMcpToken(token);
  await resetTestDb();
  owner = await insert(User, {
    email: `mail-review-owner-${randomUUID()}@example.test`,
    name: "Mailbox owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Northwind",
    slug: `northwind-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "support@northwind.example",
    status: "paused",
    aiAnalysisEnabled: false,
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada Ledger",
    slug: "ada-ledger",
    role: "Customer success",
  });
  thread = await createThread();
  inbound = await createMessage();
});

async function get<T>(path: string, companyId = company.id) {
  const response = await fetch(`${origin}/api/companies/${companyId}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

async function view(target = thread) {
  const response = await get<ThreadResponse>(`/mail/threads/${target.id}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.thread.aiReview, "Thread response must carry current review status");
  assert.ok(response.body.reviewTimeline, "Thread response must carry persisted evidence");
  return response.body;
}

async function list(target = account) {
  const response = await get<ListResponse>(`/mail/accounts/${target.id}/threads`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

async function createThread(changes: Partial<MailThread> = {}) {
  return insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: randomUUID(),
    subject: "Quote for two surveys",
    labelIds: " INBOX ",
    messageCount: 1,
    lastMessageAt: time(0),
    ...changes,
  });
}

async function createMessage(changes: Partial<MailMessage> = {}) {
  return insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: randomUUID(),
    gmailThreadId: thread.gmailThreadId,
    fromName: "Nadia Okafor",
    fromEmail: "nadia@customer.example",
    toEmails: account.address,
    subject: thread.subject,
    bodyText: "Please quote for two surveys.",
    labelIds: " INBOX ",
    sentAt: time(0),
    createdAt: time(0),
    ...changes,
  });
}

async function analysis(changes: Partial<MailInboundAnalysis> = {}) {
  return insert(MailInboundAnalysis, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    messageId: inbound.id,
    employeeId: employee.id,
    status: "succeeded",
    summary: "A customer requested a quote.",
    category: "quote_request",
    createdAt: time(1),
    finishedAt: time(2),
    ...changes,
  });
}

async function handover(changes: Partial<MailHandover> = {}) {
  return insert(MailHandover, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    employeeId: employee.id,
    mode: "work",
    status: "running",
    createdAt: time(1),
    startedAt: time(2),
    ...changes,
  });
}

async function becomeMember(role: Role = "member", financeAccess: FinanceAccess = "none") {
  const member = await insert(User, {
    email: `mail-review-member-${randomUUID()}@example.test`,
    name: "Mailbox member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: member.id, role, financeAccess });
  actingUserId = member.id;
  return member;
}

async function callTool<T>(name: string, args: unknown, threadId: string | null = thread.id) {
  const token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    mailThreadId: threadId,
  });
  tokens.push(token);
  const response = await fetch(`${origin}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const body = (await response.json()) as T;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

describe("mail review timeline HTTP boundaries", () => {
  test("requires authentication and company membership for both list and detail", async () => {
    const paths = [`/mail/accounts/${account.id}/threads`, `/mail/threads/${thread.id}`];
    actingUserId = null;
    for (const path of paths) assert.equal((await get(path)).status, 401);
    const outsider = await insert(User, {
      email: `outsider-${randomUUID()}@example.test`,
      name: "Outsider",
      passwordHash: "x",
    });
    actingUserId = outsider.id;
    for (const path of paths) assert.equal((await get(path)).status, 403);
  });

  test("ordinary Members can read review status and evidence without the audit entitlement", async () => {
    await becomeMember();
    await analysis();
    assert.equal((await view()).thread.aiReview.status, "reviewed");
    assert.equal((await list()).threads[0].aiReview.status, "reviewed");
  });

  test("missing and foreign mailbox or thread identifiers reveal no timeline", async () => {
    const foreignCompany = await insert(Company, {
      name: "Foreign company",
      slug: `foreign-${randomUUID()}`,
      ownerId: owner.id,
    });
    const foreignAccount = await insert(MailAccount, {
      companyId: foreignCompany.id,
      connectionId: randomUUID(),
      address: "private@foreign.example",
    });
    const foreignThread = await createThread({
      companyId: foreignCompany.id,
      accountId: foreignAccount.id,
    });
    for (const id of [randomUUID(), foreignAccount.id]) {
      assert.equal((await get(`/mail/accounts/${id}/threads`)).status, 404);
    }
    for (const id of [randomUUID(), foreignThread.id]) {
      assert.equal((await get(`/mail/threads/${id}`)).status, 404);
    }
  });

  test("list enriches only the selected mailbox and preserves pagination", async () => {
    const secondAccount = await insert(MailAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      address: "finance@northwind.example",
    });
    await createThread({ accountId: secondAccount.id, lastMessageAt: time(4) });
    await createThread({ lastMessageAt: time(3) });
    const response = await get<ListResponse>(`/mail/accounts/${account.id}/threads?limit=1`);
    assert.equal(response.status, 200);
    assert.equal(response.body.threads.length, 1);
    assert.equal(response.body.nextBefore, time(3).toISOString());
    assert.ok(response.body.threads[0].aiReview);
    const rest = await get<ListResponse>(
      `/mail/accounts/${account.id}/threads?before=${encodeURIComponent(response.body.nextBefore!)}`,
    );
    assert.deepEqual(
      rest.body.threads.map((row) => row.id),
      [thread.id],
    );
    assert.equal(rest.body.nextBefore, null);
  });
});

describe("mail review state follows the newest inbound message", () => {
  test("an untouched inbound email is not reviewed on list and detail", async () => {
    const detail = await view();
    assert.equal(detail.thread.aiReview.status, "not_reviewed");
    assert.equal(detail.thread.aiReview.latestMessageId, inbound.id);
    assert.equal(detail.thread.aiReview.employee, null);
    assert.deepEqual((await list()).threads[0].aiReview, detail.thread.aiReview);
    assert.equal(detail.reviewTimeline.events.filter((row) => row.kind === "received").length, 1);
  });

  test("real analysis transitions from reviewing to reviewed with the responsible employee", async () => {
    const row = await analysis({ status: "running", finishedAt: null });
    const during = await view();
    assert.equal(during.thread.aiReview.status, "reviewing");
    assert.equal(during.thread.aiReview.employee?.id, employee.id);
    assert.equal(during.thread.aiReview.employee?.name, employee.name);
    assert.ok(during.reviewTimeline.events.some((event) => event.status === "running"));
    await AppDataSource.getRepository(MailInboundAnalysis).update(row.id, {
      status: "succeeded",
      finishedAt: time(3),
    });
    const afterReview = await view();
    assert.equal(afterReview.thread.aiReview.status, "reviewed");
    assert.equal((await list()).threads[0].aiReview.status, "reviewed");
    assert.ok(afterReview.reviewTimeline.events.some((event) => event.kind === "review_completed"));
    assert.equal(
      afterReview.reviewTimeline.events.some((event) => event.status === "running"),
      false,
    );
  });

  test("a newer inbound email resets review while retaining the earlier evidence", async () => {
    await analysis();
    const newer = await createMessage({ createdAt: time(5), sentAt: time(5) });
    const detail = await view();
    assert.equal(detail.thread.aiReview.status, "not_reviewed");
    assert.equal(detail.thread.aiReview.latestMessageId, newer.id);
    assert.ok(detail.reviewTimeline.events.some((event) => event.kind === "review_completed"));
    assert.equal(
      detail.reviewTimeline.events.filter((event) => event.kind === "received").length,
      2,
    );
    assert.equal((await list()).threads[0].aiReview.status, "not_reviewed");
  });

  test("a newly ingested reply with an old sender Date still requires its own review", async () => {
    await analysis();
    const newer = await createMessage({ createdAt: time(5), sentAt: time(-30) });
    const detail = await view();
    assert.equal(detail.thread.aiReview.status, "not_reviewed");
    assert.equal(detail.thread.aiReview.latestMessageId, newer.id);
    assert.equal((await list()).threads[0].aiReview.latestMessageId, newer.id);
  });

  test("a newer outgoing email or draft does not invalidate the inbound review", async () => {
    await analysis();
    for (const [minute, labels] of [
      [5, " SENT "],
      [6, " DRAFT "],
    ] as const) {
      await createMessage({
        fromEmail: account.address,
        toEmails: inbound.fromEmail,
        createdByEmployeeId: employee.id,
        labelIds: labels,
        createdAt: time(minute),
        sentAt: time(minute),
      });
    }
    const detail = await view();
    assert.equal(detail.thread.aiReview.status, "reviewed");
    assert.equal(detail.thread.aiReview.latestMessageId, inbound.id);
    assert.equal(
      detail.reviewTimeline.events.filter((event) => event.kind === "received").length,
      1,
    );
    assert.ok(detail.reviewTimeline.events.some((event) => event.kind === "draft"));
    assert.ok(detail.reviewTimeline.events.some((event) => event.kind === "sent"));
  });

  test("failed analysis needs attention and never exposes provider error details", async () => {
    await analysis({
      status: "failed",
      errorMessage: "Provider API key sk-do-not-expose and account password must stay private",
    });
    const detail = await view();
    assert.equal(detail.thread.aiReview.status, "needs_attention");
    assert.ok(detail.reviewTimeline.events.some((event) => event.kind === "review_failed"));
    assert.doesNotMatch(JSON.stringify(detail.reviewTimeline), /sk-do-not-expose|account password/);
    assert.equal((await list()).threads[0].aiReview.status, "needs_attention");
  });

  test("automation queue status never claims that an AI Employee reviewed an email", async () => {
    await AppDataSource.getRepository(MailAccount).update(account.id, { aiAnalysisEnabled: true });
    const automation = await insert(MailInboundAutomation, {
      companyId: company.id,
      accountId: account.id,
      messageId: inbound.id,
      gmailMessageId: inbound.gmailMessageId,
      status: "queued",
    });
    assert.equal((await view()).thread.aiReview.status, "queued");
    await AppDataSource.getRepository(MailInboundAutomation).update(automation.id, {
      status: "running",
    });
    assert.equal((await view()).thread.aiReview.status, "queued");
    await AppDataSource.getRepository(MailInboundAutomation).update(automation.id, {
      status: "succeeded",
    });
    assert.equal((await view()).thread.aiReview.status, "not_reviewed");
    await AppDataSource.getRepository(MailInboundAutomation).update(automation.id, {
      status: "queued",
    });
    await AppDataSource.getRepository(MailAccount).update(account.id, { aiAnalysisEnabled: false });
    assert.equal((await view()).thread.aiReview.status, "not_reviewed");
  });

  test("pending handover, current work, and a finished handover have distinct states", async () => {
    const row = await handover({ status: "pending", startedAt: null });
    assert.equal((await view()).thread.aiReview.status, "queued");
    await AppDataSource.getRepository(MailHandover).update(row.id, {
      status: "running",
      startedAt: time(2),
    });
    assert.equal((await view()).thread.aiReview.status, "reviewing");
    await AppDataSource.getRepository(MailHandover).update(row.id, {
      status: "completed",
      finishedAt: time(3),
      resultSummary: "Unverified narrative: I created a quote and sent it.",
    });
    const detail = await view();
    assert.equal(detail.thread.aiReview.status, "reviewed");
    assert.equal(
      detail.reviewTimeline.events.some((event) => ["quote", "sent"].includes(event.kind)),
      false,
    );
    assert.doesNotMatch(JSON.stringify(detail.reviewTimeline), /Unverified narrative/);
  });

  test("handover that started before a new reply cannot review that reply retroactively", async () => {
    const row = await handover();
    const newer = await createMessage({ createdAt: time(4), sentAt: time(4) });
    await AppDataSource.getRepository(MailHandover).update(row.id, {
      status: "completed",
      finishedAt: time(5),
    });
    const detail = await view();
    assert.equal(detail.thread.aiReview.latestMessageId, newer.id);
    assert.equal(detail.thread.aiReview.status, "not_reviewed");
    assert.ok(detail.reviewTimeline.events.some((event) => event.kind === "handover_completed"));
  });

  test("a newer active handover takes precedence over a failed analysis", async () => {
    await analysis({ status: "failed" });
    await handover({ startedAt: time(4) });
    assert.equal((await view()).thread.aiReview.status, "reviewing");
  });
});

describe("mail work timeline records proved effects with scoped access", () => {
  test("unexecuted analysis suggestions never appear as completed actions", async () => {
    await analysis({
      actionsJson: JSON.stringify([
        { id: "0", kind: "create_estimate", label: "Create a quote", customerName: "Customer" },
        {
          id: "1",
          kind: "draft_reply",
          label: "Draft the quote email",
          bodyText: "Suggested text",
        },
      ]),
    });
    const detail = await view();
    assert.equal(
      detail.reviewTimeline.events.some((event) => ["quote", "draft", "sent"].includes(event.kind)),
      false,
    );
  });

  test("real AI tools create a linked quote and Decision only on their originating email", async () => {
    await insert(EmployeeFinanceGrant, {
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: "invoice",
    });
    const customer = await insert(Customer, {
      companyId: company.id,
      name: "Northwind customer",
      slug: "northwind-customer",
      currency: "GBP",
    });
    const quote = await callTool<{ estimate: { id: string; slug: string } }>("create_estimate", {
      customerSlug: customer.slug,
      lines: [{ description: "Two surveys", quantity: 2, unitPriceCents: 15_000 }],
    });
    const choice = await callTool<{ decisionId: string }>("request_decision", {
      title: "Commit to fixed pricing for three years?",
      body: "The customer requests a three-year price guarantee.",
      humanDecisionReason:
        "A three-year price guarantee exceeds the employee's delegated authority.",
      options: [{ label: "Offer a one-year guarantee" }, { label: "Accept three years" }],
    });
    const persistedQuote = await AppDataSource.getRepository(Estimate).findOneByOrFail({
      id: quote.estimate.id,
    });
    const persistedDecision = await AppDataSource.getRepository(Decision).findOneByOrFail({
      id: choice.decisionId,
    });
    assert.equal(persistedDecision.mailThreadId, thread.id);
    const detail = await view();
    const quoteEvent = detail.reviewTimeline.events.find((event) => event.kind === "quote");
    const decisionEvent = detail.reviewTimeline.events.find((event) => event.kind === "decision");
    assert.ok(quoteEvent, "The quote tool's persisted audit must become email evidence");
    assert.ok(decisionEvent, "The Decision tool's persisted provenance must become email evidence");
    assert.equal(quoteEvent.employee?.id, employee.id);
    assert.ok(quoteEvent.href?.includes(persistedQuote.slug));
    assert.ok(decisionEvent.href?.includes(choice.decisionId));
    assert.equal(
      detail.reviewTimeline.events.filter((event) => event.kind === "decision").length,
      1,
    );
    const adjacent = await createThread();
    const unrelated = await view(adjacent);
    assert.equal(
      unrelated.reviewTimeline.events.some((event) => ["quote", "decision"].includes(event.kind)),
      false,
    );
  });

  test("quote evidence hides its details and destination from Members without Finance access", async () => {
    await insert(EmployeeFinanceGrant, {
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: "invoice",
    });
    const customer = await insert(Customer, {
      companyId: company.id,
      name: "Confidential customer",
      slug: "confidential-customer",
    });
    const quote = await callTool<{ estimate: { id: string; slug: string } }>("create_estimate", {
      customerSlug: customer.slug,
      lines: [{ description: "Confidential pricing", quantity: 1, unitPriceCents: 987_654 }],
    });
    await becomeMember("member", "none");
    const restricted = await view();
    const event = restricted.reviewTimeline.events.find((row) => row.kind === "quote");
    assert.ok(event, "The fact that work happened remains visible");
    assert.equal(event.href, null);
    assert.match(event.description ?? "", /Finance access/);
    assert.doesNotMatch(
      JSON.stringify(restricted.reviewTimeline),
      /Confidential customer|Confidential pricing|987654/,
    );
    assert.equal(JSON.stringify(restricted.reviewTimeline).includes(quote.estimate.slug), false);
    await becomeMember("member", "read");
    assert.ok((await view()).reviewTimeline.events.find((row) => row.kind === "quote")?.href);
  });

  test("foreign or adjacent-thread evidence cannot contaminate a timeline", async () => {
    const foreignCompanyId = randomUUID();
    const unrelatedThreadId = randomUUID();
    for (const [companyId, mailThreadId] of [
      [foreignCompanyId, thread.id],
      [company.id, unrelatedThreadId],
    ]) {
      await insert(Decision, {
        companyId,
        employeeId: employee.id,
        mailThreadId,
        title: "Unrelated private Decision",
        optionsJson: "[]",
      });
      await insert(AuditEvent, {
        companyId,
        actorKind: "ai",
        actorEmployeeId: employee.id,
        action: "finance.estimate.create",
        targetType: "estimate",
        targetId: randomUUID(),
        targetLabel: "Unrelated private quote",
        metadataJson: JSON.stringify({ mailThreadId }),
      });
    }
    await analysis({ companyId: foreignCompanyId, summary: "Unrelated private analysis" });
    const detail = await view();
    assert.equal(detail.thread.aiReview.status, "not_reviewed");
    assert.equal(
      detail.reviewTimeline.events.some((event) =>
        ["quote", "decision", "review_completed"].includes(event.kind),
      ),
      false,
    );
    assert.doesNotMatch(JSON.stringify(detail.reviewTimeline), /Unrelated private/);
  });

  test("review Approval reveals its existence without its payload or admin destination to a Member", async () => {
    await insert(Approval, {
      companyId: company.id,
      employeeId: employee.id,
      routineId: "",
      kind: "mail_send",
      title: "Private approval title",
      summary: "Private approval summary",
      payloadJson: JSON.stringify({
        threadId: thread.id,
        accountId: account.id,
        draft: { bodyText: "Private draft payload", bcc: "private-bcc@example.test" },
      }),
      errorMessage: "Private approval error",
      resultJson: JSON.stringify({ secret: "Private approval result" }),
      requestedAt: time(4),
    });
    await becomeMember();
    const detail = await view();
    const event = detail.reviewTimeline.events.find((row) => row.kind === "draft");
    assert.ok(event);
    assert.equal(event.href, null);
    assert.equal(event.status, "pending");
    assert.doesNotMatch(
      JSON.stringify(detail.reviewTimeline),
      /Private approval|Private draft|private-bcc/,
    );
  });

  test("timeline events are stable and chronological with no duplicate evidence IDs", async () => {
    await analysis();
    await handover({
      createdAt: time(3),
      startedAt: time(4),
      status: "completed",
      finishedAt: time(5),
    });
    await createMessage({
      fromEmail: account.address,
      createdByEmployeeId: employee.id,
      labelIds: " DRAFT ",
      createdAt: time(6),
      sentAt: time(6),
    });
    const first = (await view()).reviewTimeline;
    const second = (await view()).reviewTimeline;
    assert.deepEqual(first, second);
    const timestamps = first.events.map((event) => new Date(event.occurredAt).getTime());
    assert.ok(timestamps.every(Number.isFinite));
    assert.deepEqual(
      timestamps,
      [...timestamps].sort((a, b) => a - b),
    );
    assert.equal(new Set(first.events.map((event) => event.id)).size, first.events.length);
    assert.equal(first.truncated, false);
  });
});
