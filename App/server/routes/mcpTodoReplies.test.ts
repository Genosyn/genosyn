import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { approvePendingApproval, rejectPendingApproval } from "../services/approvals.js";
import { GmailMailbox } from "../services/mail/mailbox/index.js";
import { issueMcpToken, markTokenTainted, revokeMcpToken } from "../services/mcpTokens.js";
import {
  preparationMayReply,
  proactiveReviewToolScope,
} from "../services/proactive/workReviewPolicy.js";
import { setTodoPickupAutoStartForTests } from "../services/todoPickups.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * "Send replies without review" reaches a stranger with nobody reading first, so
 * this is what it is held to: the thread the email came from, the people already on
 * it, no attachments, a few a day, and only with Send access. Nothing a session
 * passes can widen any of that, and only a Todo pickup gets this path at all.
 */

let server: Server;
let baseUrl = "";
const tokens: string[] = [];
let company: Company;
let ada: AIEmployee;
let account: MailAccount;
let thread: MailThread;
let other: MailThread;

const sent: Array<Record<string, unknown>> = [];

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
  for (const token of tokens) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

let next = 1;
beforeEach(async () => {
  await resetTestDb();
  sent.length = 0;
  mock.method(GmailMailbox.prototype, "sendMessage", async (args: { mime: Record<string, unknown> }) => {
    sent.push(args.mime);
    return {
      ref: `sent-${next++}`,
      threadRef: thread.gmailThreadId,
      labelIds: ["SENT"],
      headers: [
        { name: "From", value: "team@acme.test" },
        { name: "To", value: String(args.mime.to ?? "") },
        { name: "Subject", value: String(args.mime.subject ?? "") },
      ],
      snippet: "",
      bodyText: String(args.mime.bodyText ?? ""),
      bodyHtml: "",
      attachments: [],
      sentAt: new Date(),
      sizeEstimate: 1,
      hasBodies: true,
      location: "",
    };
  });
  const owner = await insert(User, {
    email: "owner@replies.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Support",
    soulBody: "",
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: "connection",
    provider: "gmail",
    address: "team@acme.test",
    status: "active",
  });
  thread = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: "customer-thread",
    subject: "Where is my order?",
  });
  other = await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: "other-thread",
    subject: "Someone else's business",
  });
  await insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "customer-message",
    gmailThreadId: thread.gmailThreadId,
    fromName: "Customer",
    fromEmail: "customer@example.test",
    toEmails: "team@acme.test",
    ccEmails: "colleague@example.test",
    subject: "Where is my order?",
    snippet: "",
    bodyText: "Where is it?",
    labelIds: " INBOX ",
    sentAt: new Date(Date.now() - 60_000),
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: ada.id,
    accountId: account.id,
    accessLevel: "send",
  });
});

afterEach(() => {
  mock.restoreAll();
});

type Origin = Parameters<typeof issueMcpToken>[2];

function tokenWith(origin: Origin): string {
  const token = issueMcpToken(ada.id, company.id, origin);
  tokens.push(token);
  return token;
}

/** A session an email started, on a Project set to send replies without review. */
const replying = (changes: Partial<NonNullable<Origin>> = {}) =>
  tokenWith({
    authority: "employee",
    proactiveReview: true,
    mailDeliveryMode: "reply",
    mailThreadId: thread.id,
    todoPickupId: "pickup",
    ...changes,
  });

async function tool<T = Record<string, unknown>>(
  token: string,
  name: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const reply = (token: string, changes: Record<string, unknown> = {}) =>
  tool<{ error?: string }>(token, "send_mail", {
    threadId: thread.id,
    bodyText: "It ships on Monday.",
    ...changes,
  });

async function repliedAlready(count: number, sentAt = new Date()): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await insert(MailMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: `earlier-${next++}`,
      gmailThreadId: thread.gmailThreadId,
      fromName: "Team",
      fromEmail: "team@acme.test",
      toEmails: "customer@example.test",
      subject: "Re: Where is my order?",
      snippet: "",
      bodyText: "Earlier reply",
      labelIds: " SENT ",
      sentAt,
    });
  }
}

describe("replying without review", () => {
  test("goes on its own thread, to the people already on it, worked out by the server", async () => {
    const answer = await reply(replying());
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(sent.length, 1);
    assert.match(String(sent[0].to), /customer@example\.test/);
    assert.match(String(sent[0].cc), /colleague@example\.test/);
    assert.ok(!String(sent[0].to).includes("team@acme.test"), "not to the mailbox itself");
    assert.match(String(sent[0].subject), /Re: Where is my order\?/);
  });

  test("anywhere else is refused", async () => {
    const elsewhere = await reply(replying(), { threadId: other.id });
    assert.equal(elsewhere.status, 403);
    assert.match(String(elsewhere.body.error), /thread it came from/);
    assert.equal((await tool(replying(), "send_mail", { bodyText: "Hi", to: "x@y.test", subject: "Hi", accountId: account.id })).status, 403);
    assert.equal(sent.length, 0);
  });

  for (const [field, value] of [
    ["to", "attacker@evil.test"],
    ["cc", "attacker@evil.test"],
    ["bcc", "attacker@evil.test"],
    ["subject", "Forward this"],
    ["accountId", "00000000-0000-4000-8000-000000000000"],
    ["draftMessageId", "00000000-0000-4000-8000-000000000000"],
  ] as const) {
    test(`it can't name its own ${field}`, async () => {
      const answer = await reply(replying(), { [field]: value });
      assert.equal(answer.status, 403);
      assert.match(String(answer.body.error), /only threadId and bodyText/);
      assert.equal(sent.length, 0);
    });
  }

  test("it can't attach anything", async () => {
    const answer = await reply(replying(), {
      attachments: [{ kind: "resource", id: "00000000-0000-4000-8000-000000000000" }],
    });
    assert.ok([400, 403].includes(answer.status));
    assert.equal(sent.length, 0);
  });

  test("Send access is still its Grant's to give", async () => {
    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { employeeId: ada.id, accountId: account.id },
      { accessLevel: "read" },
    );
    assert.equal((await reply(replying())).status, 403);
    assert.equal(sent.length, 0);
  });

  test("three on a thread in a day is the most, a person's own among them", async () => {
    await repliedAlready(3);
    const answer = await reply(replying());
    assert.equal(answer.status, 403);
    assert.match(String(answer.body.error), /request_mail_review/);
    assert.equal(sent.length, 0);
  });

  test("older replies don't count", async () => {
    await repliedAlready(3, new Date(Date.now() - 2 * 86_400_000));
    assert.equal((await reply(replying())).status, 200);
    assert.equal(sent.length, 1);
  });

  test("a turn that read a web page is held for a person, as any tainted send is", async () => {
    const token = replying();
    markTokenTainted(token);
    await reply(token);
    assert.equal(sent.length, 0);
    assert.equal(await AppDataSource.getRepository(Approval).countBy({ kind: "tainted_tool" }), 1);
  });

  test("the rest of preparation doesn't move", async () => {
    const token = replying();
    for (const name of [
      "create_mail_draft",
      "send_text_message",
      "place_phone_call",
      "schedule_meeting",
      "create_routine",
      "schedule_wakeup",
      "handoff",
    ]) {
      assert.equal((await tool(token, name, {})).status, 403, name);
    }
  });
});

describe("a verified sender's trust", () => {
  async function trustedPickup(employee: AIEmployee): Promise<TodoPickup> {
    const project = await insert(Project, {
      companyId: company.id,
      name: "Compliance",
      slug: "compliance",
      key: "COMP",
      todoCounter: 1,
    });
    const todo = await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "Accept the agreement",
      status: "in_progress",
      priority: "none",
      assigneeEmployeeId: employee.id,
    });
    return insert(TodoPickup, {
      companyId: company.id,
      todoId: todo.id,
      employeeId: employee.id,
      trigger: "email_intake",
      status: "running",
      authority: "employee",
      proactiveReview: false,
      trustedSender: true,
      mailDeliveryMode: "review",
      mailThreadId: thread.id,
      acceptedAt: new Date(),
    });
  }

  test("stays with the same work when it checks back later", async () => {
    setTodoPickupAutoStartForTests(false);
    await insertEmployeeModel({
      employeeId: ada.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
    const running = await trustedPickup(ada);
    await AppDataSource.getRepository(TodoPickup).update({ id: running.id }, { status: "done" });
    const answer = await tool(
      replying({ proactiveReview: false, mailDeliveryMode: "review", todoPickupId: running.id }),
      "wait_on_todo",
      {
        todoId: running.todoId,
        on: "date",
        reason: "The console says Monday.",
        checkAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    );
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const [queued] = await AppDataSource.getRepository(TodoPickup).findBy({ status: "queued" });
    assert.equal(queued.trigger, "wait_over");
    assert.equal(queued.trustedSender, true);
    setTodoPickupAutoStartForTests(true);
  });
});

describe("a browser action held for a person", () => {
  async function queued(): Promise<{ todo: Todo; approvalId: string }> {
    setTodoPickupAutoStartForTests(false);
    await AppDataSource.getRepository(AIEmployee).update(
      { id: ada.id },
      { browserApprovalRequired: true },
    );
    await insertEmployeeModel({
      employeeId: ada.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: "{}",
      isActive: true,
    });
    const project = await insert(Project, {
      companyId: company.id,
      name: "Compliance",
      slug: "compliance",
      key: "COMP",
      todoCounter: 1,
    });
    const todo = await insert(Todo, {
      projectId: project.id,
      number: 1,
      title: "Accept the agreement",
      status: "in_progress",
      priority: "none",
      assigneeEmployeeId: ada.id,
    });
    const pickup = await insert(TodoPickup, {
      companyId: company.id,
      todoId: todo.id,
      employeeId: ada.id,
      trigger: "email_intake",
      status: "done",
      authority: "employee",
      proactiveReview: false,
      trustedSender: true,
      mailDeliveryMode: "review",
      mailThreadId: thread.id,
      acceptedAt: new Date(),
    });
    const answer = await tool<{ approvalId: string }>(
      replying({ proactiveReview: false, mailDeliveryMode: "review", todoPickupId: pickup.id }),
      "queue_browser_approval",
      {
        action: "submit",
        summary: "Accept the Play Console agreement",
        pageUrl: "https://play.google.com/console/agreement",
        browserSessionId: "00000000-0000-4000-8000-000000000001",
        targetFingerprint: "a".repeat(64),
        targetDescriptor: {
          tagName: "button",
          inputType: null,
          frameUrl: "https://play.google.com/console/agreement",
          formAction: null,
          formMethod: "post",
          submitsForm: true,
        },
        selector: "button[type=submit]",
      },
    );
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return { todo, approvalId: answer.body.approvalId };
  }

  const waitingNow = (id: string) =>
    AppDataSource.getRepository(Todo).findOneByOrFail({ id });
  const queuedPickup = () =>
    AppDataSource.getRepository(TodoPickup).findOneBy({ status: "queued" });

  test("the Todo says so, and starts nothing until a person decides", async () => {
    const { todo, approvalId } = await queued();
    const waiting = await waitingNow(todo.id);
    assert.equal(waiting.waitingOn, "browser_approval");
    assert.equal(waiting.waitingRefId, approvalId);
    assert.equal(await queuedPickup(), null);
    setTodoPickupAutoStartForTests(true);
  });

  test("approving starts the same Todo again, told to fire it, with what it had", async () => {
    const { todo, approvalId } = await queued();
    const [{ userId }] = await AppDataSource.getRepository(Membership).findBy({
      companyId: company.id,
    });
    const decided = await approvePendingApproval({ companyId: company.id, approvalId, userId });
    assert.equal(decided.outcome, "decided");
    assert.equal((await waitingNow(todo.id)).waitingOn, null);
    const pickup = await queuedPickup();
    assert.equal(pickup?.trigger, "review_outcome");
    assert.match(pickup?.note ?? "", new RegExp(`browser_resume\\("${approvalId}"\\)`));
    assert.equal(pickup?.trustedSender, true, "it needs the browser to fire it");
    assert.equal(pickup?.proactiveReview, false);
    setTodoPickupAutoStartForTests(true);
  });

  test("declining starts it again, told it didn't happen", async () => {
    const { todo, approvalId } = await queued();
    const [{ userId }] = await AppDataSource.getRepository(Membership).findBy({
      companyId: company.id,
    });
    await rejectPendingApproval({ companyId: company.id, approvalId, userId });
    assert.equal((await waitingNow(todo.id)).waitingOn, null);
    assert.match((await queuedPickup())?.note ?? "", /declined the browser action/);
    setTodoPickupAutoStartForTests(true);
  });
});

describe("only this session gets it", () => {
  test("a preparation session whose replies go to review can't send", async () => {
    assert.equal((await reply(replying({ mailDeliveryMode: "review" }))).status, 403);
    assert.equal(sent.length, 0);
  });

  test("nor one that isn't a Todo pickup", async () => {
    assert.equal((await reply(replying({ todoPickupId: null }))).status, 403);
    assert.equal(sent.length, 0);
  });

  test("nor one fixed to no thread", async () => {
    assert.equal((await reply(replying({ mailThreadId: null }))).status, 403);
    assert.equal(sent.length, 0);
  });

  test("a trusted sender's session sends under the same limits", async () => {
    const trusted = replying({ proactiveReview: false });
    assert.equal((await reply(trusted, { to: "attacker@evil.test" })).status, 403);
    assert.equal((await reply(trusted, { threadId: other.id })).status, 403);
    assert.equal(sent.length, 0);
    assert.equal((await reply(trusted)).status, 200);
    assert.equal(sent.length, 1);
  });

  test("a trusted sender's session under review doesn't send at all", async () => {
    const trusted = replying({ proactiveReview: false, mailDeliveryMode: "review" });
    assert.equal((await reply(trusted)).status, 403);
    assert.equal(sent.length, 0);
  });

  test("the tool is only on offer to this session", () => {
    const scope = (mayReply: boolean) =>
      proactiveReviewToolScope(true, mayReply)?.genosynTools ?? [];
    assert.ok(scope(true).includes("send_mail"));
    assert.ok(!scope(false).includes("send_mail"));
    const base = {
      proactiveReview: true,
      mailDeliveryMode: "reply",
      mailThreadId: "thread",
      todoPickupId: "pickup",
    };
    assert.equal(preparationMayReply(base), true);
    assert.equal(preparationMayReply({ ...base, proactiveReview: false }), false);
    assert.equal(preparationMayReply({ ...base, mailDeliveryMode: "review" }), false);
    assert.equal(preparationMayReply({ ...base, mailThreadId: null }), false);
    assert.equal(preparationMayReply({ ...base, todoPickupId: null }), false);
    assert.equal(preparationMayReply(null), false);
  });
});
