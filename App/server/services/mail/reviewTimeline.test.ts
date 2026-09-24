import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Approval } from "../../db/entities/Approval.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { Invoice } from "../../db/entities/Invoice.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { initTestDb, closeTestDb, resetTestDb, insert } from "../../test/dbHarness.js";
import { mailReviewTimeline } from "./reviewTimeline.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, seconds));

async function fixtures() {
  const companyId = randomUUID();
  const account = await insert(MailAccount, {
    companyId,
    connectionId: randomUUID(),
    address: "owner@example.com",
  });
  const thread = await insert(MailThread, {
    companyId,
    accountId: account.id,
    gmailThreadId: randomUUID(),
  });
  const employee = await insert(AIEmployee, { companyId, name: "Ada", slug: "ada", role: "Sales" });
  const incoming = await insert(MailMessage, {
    companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: randomUUID(),
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "customer@example.com",
    labelIds: " INBOX ",
    createdAt: at(10),
    sentAt: at(5),
  });
  const args = {
    account,
    thread,
    messages: [incoming],
    analyses: [] as MailInboundAnalysis[],
    handovers: [] as MailHandover[],
    canReadFinance: true,
    canReviewApprovals: true,
  };
  return { args, companyId, account, thread, employee, incoming };
}

test("receipt uses observed arrival rather than a sender-controlled future header", async () => {
  const { args, incoming } = await fixtures();
  incoming.sentAt = at(55);
  const timeline = await mailReviewTimeline(args);
  assert.equal(timeline.events[0].occurredAt, at(10).toISOString());
});

test("re-analysis preserves each attempted review without duplicating the current row", async () => {
  const { args, employee, incoming, companyId, thread, account } = await fixtures();
  const analysis = await insert(MailInboundAnalysis, {
    companyId,
    accountId: account.id,
    threadId: thread.id,
    messageId: incoming.id,
    employeeId: employee.id,
    status: "succeeded",
    createdAt: at(11),
    updatedAt: at(23),
    finishedAt: at(23),
  });
  args.analyses = [analysis];
  for (const [action, seconds] of [
    ["started", 11],
    ["failed", 12],
    ["started", 22],
    ["completed", 23],
  ] as const) {
    await insert(AuditEvent, {
      companyId,
      actorEmployeeId: employee.id,
      actorKind: "ai",
      action: `mail.analysis.${action}`,
      targetType: "mail_inbound_analysis",
      targetId: analysis.id,
      metadataJson: JSON.stringify({ mailThreadId: thread.id, messageId: incoming.id }),
      createdAt: at(seconds),
    });
  }
  const timeline = await mailReviewTimeline(args);
  assert.deepEqual(
    timeline.events.map((event) => event.kind),
    ["received", "review_started", "review_failed", "review_started", "review_completed"],
  );
  assert.equal(timeline.events.filter((event) => event.status === "failed").length, 1);
});

test("a completed email review and its SENT mirror produce one send event", async () => {
  const { args, employee, companyId, account, thread } = await fixtures();
  const sent = await insert(MailMessage, {
    companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: randomUUID(),
    gmailThreadId: thread.gmailThreadId,
    fromEmail: account.address,
    labelIds: " SENT ",
    createdByEmployeeId: employee.id,
    createdAt: at(30),
    sentAt: at(30),
  });
  args.messages.push(sent);
  await insert(Approval, {
    companyId,
    employeeId: employee.id,
    routineId: "",
    kind: "mail_send",
    status: "approved",
    requestedAt: at(20),
    decidedAt: at(29),
    payloadJson: JSON.stringify({ accountId: account.id, threadId: thread.id }),
    resultJson: JSON.stringify({
      sentMessageId: sent.id,
      providerMessageRef: sent.gmailMessageId,
      sentAt: at(30).toISOString(),
    }),
  });
  const events = (await mailReviewTimeline(args)).events;
  const sends = events.filter((event) => event.kind === "sent");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].occurredAt, at(30).toISOString());
  assert.equal(events.filter((event) => event.kind === "draft").length, 1);
});

test("foreign handovers and thread-id text in unrelated metadata cannot attribute an action", async () => {
  const { args, employee, companyId, account, thread } = await fixtures();
  const handover = await insert(MailHandover, {
    companyId,
    accountId: account.id,
    threadId: thread.id,
    employeeId: "another-employee",
  });
  args.handovers.push(handover);
  for (const metadata of [
    { note: thread.id },
    { mailThreadId: thread.id, mailHandoverId: handover.id },
    { mailThreadId: thread.id, mailHandoverId: "unknown" },
  ]) {
    await insert(AuditEvent, {
      companyId,
      actorEmployeeId: employee.id,
      actorKind: "ai",
      action: "finance.estimate.create",
      metadataJson: JSON.stringify(metadata),
      createdAt: at(20),
    });
  }
  assert.equal(
    (await mailReviewTimeline(args)).events.filter((event) => event.kind === "quote").length,
    0,
  );
});

test("Member-confirmed suggested actions have separate attribution and bounded safe links", async () => {
  const { args, companyId, thread } = await fixtures();
  await insert(AuditEvent, {
    companyId,
    actorUserId: "member",
    action: "mail.analysis.create_estimate",
    metadataJson: JSON.stringify({
      mailThreadId: thread.id,
      resultPath: "/finance/estimates/edraft-123/edit",
    }),
    createdAt: at(20),
  });
  const event = (await mailReviewTimeline(args)).events.find((entry) => entry.kind === "quote")!;
  assert.equal(event.employee, null);
  assert.equal(event.description, "Confirmed by a Member.");
  assert.equal(event.href, "/finance/estimates/edraft-123/edit");
  args.canReadFinance = false;
  const redacted = (await mailReviewTimeline(args)).events.find((entry) => entry.kind === "quote")!;
  assert.equal(redacted.href, null);
  assert.equal(JSON.stringify(redacted).includes("edraft-123"), false);
});

test("unsafe model-like result URLs never become links", async () => {
  const { args, companyId, thread } = await fixtures();
  await insert(AuditEvent, {
    companyId,
    actorUserId: "member",
    action: "mail.analysis.create_estimate",
    metadataJson: JSON.stringify({
      mailThreadId: thread.id,
      resultPath: "https://elsewhere.invalid/steal",
    }),
    createdAt: at(20),
  });
  assert.equal(
    (await mailReviewTimeline(args)).events.find((entry) => entry.kind === "quote")!.href,
    null,
  );
});

test("large timelines explicitly report truncation and retain chronological order", async () => {
  const { args } = await fixtures();
  args.messages = Array.from({ length: 260 }, (_, index) => ({
    ...args.messages[0],
    id: `message-${index}`,
    createdAt: at(index),
    sentAt: at(index),
  }));
  const timeline = await mailReviewTimeline(args);
  assert.equal(timeline.truncated, true);
  assert.equal(timeline.events.length, 250);
  assert.equal(timeline.events[0].id, "received:message-10");
  assert.equal(timeline.events.at(-1)?.id, "received:message-259");
});

test("retrying a handover keeps failed attempts and the later successful review", async () => {
  const { args, companyId, employee, account, thread } = await fixtures();
  const handover = await insert(MailHandover, {
    companyId,
    accountId: account.id,
    threadId: thread.id,
    employeeId: employee.id,
    status: "completed",
    createdAt: at(11),
    startedAt: at(22),
    finishedAt: at(25),
  });
  args.handovers = [handover];
  for (const [phase, seconds] of [
    ["create", 11],
    ["started", 12],
    ["fail", 15],
    ["retry", 20],
    ["started", 22],
    ["complete", 25],
  ] as const) {
    await insert(AuditEvent, {
      companyId,
      actorEmployeeId: phase === "create" ? null : employee.id,
      actorKind: phase === "create" ? "system" : "ai",
      action: `mail.handover.${phase}`,
      targetType: "mail_handover",
      targetId: handover.id,
      createdAt: at(seconds),
    });
  }
  const events = (await mailReviewTimeline(args)).events;
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "received",
      "handover_queued",
      "handover_started",
      "handover_failed",
      "handover_queued",
      "handover_started",
      "handover_completed",
    ],
  );
  assert.equal(events.filter((event) => event.status === "failed").length, 1);
});

test("invoice links resolve current company records and respect Finance access", async () => {
  const { args, companyId, thread, employee } = await fixtures();
  const invoices = await Promise.all(
    [companyId, "another-company"].map((scope, index) =>
      insert(Invoice, {
        companyId: scope,
        customerId: randomUUID(),
        slug: `draft-invoice-${index}`,
        number: `INV-${index}`,
        issueDate: at(10),
        dueDate: at(50),
      }),
    ),
  );
  for (const invoice of invoices)
    await insert(AuditEvent, {
      companyId,
      actorEmployeeId: employee.id,
      actorKind: "ai",
      action: "finance.invoice.create",
      targetType: "invoice",
      targetId: invoice.id,
      metadataJson: JSON.stringify({ mailThreadId: thread.id }),
      createdAt: at(20),
    });
  const timeline = await mailReviewTimeline(args);
  assert.equal(
    timeline.events.filter((event) => event.href === "/finance/invoices/draft-invoice-0").length,
    1,
  );
  assert.equal(JSON.stringify(timeline).includes("draft-invoice-1"), false);
  args.canReadFinance = false;
  const redacted = await mailReviewTimeline(args);
  assert.equal(
    redacted.events.some((event) => event.href),
    false,
  );
  assert.equal(JSON.stringify(redacted).includes("INV-0"), false);
});

test("work approval keeps its decision time separate from the current work outcome", async () => {
  const { args, companyId, thread, account, employee } = await fixtures();
  for (const status of ["approved", "execution_failed", "executing"] as const) {
    const approval = await insert(Approval, {
      companyId,
      employeeId: employee.id,
      routineId: "",
      kind: "proactive_work",
      status,
      requestedAt: at(15),
      decidedAt: at(20),
      payloadJson: JSON.stringify({
        origin: { mailThreadId: thread.id, mailAccountId: account.id },
      }),
      resultJson: JSON.stringify({ summary: "Private implementation details" }),
      errorMessage: status === "execution_failed" ? "Private model error" : null,
    });
    const timeline = await mailReviewTimeline(args);
    const event = timeline.events.find((entry) => entry.id === `approval:${approval.id}:outcome`)!;
    assert.equal(event.title, "Work approved");
    assert.equal(event.occurredAt, at(20).toISOString());
    assert.match(event.description!, /^Current status:/);
    assert.equal(
      event.status,
      status === "approved" ? "complete" : status === "executing" ? "running" : "failed",
    );
    assert.equal(JSON.stringify(event).includes("Private"), false);
  }
});
