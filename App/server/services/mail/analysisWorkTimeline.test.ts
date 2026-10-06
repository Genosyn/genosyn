import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { mailAnalysisWorkTimeline } from "./analysisWorkTimeline.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const companyId = "analysis-timeline-company";
const employeeId = "analysis-timeline-employee";
const startedAt = new Date("2026-09-25T10:00:00.000Z");
const finishedAt = new Date("2026-09-25T10:00:12.000Z");
const auditAt = new Date("2026-09-25T10:00:12.003Z");

async function fixture() {
  const account = await insert(MailAccount, {
    companyId,
    connectionId: "connection",
    address: "support@acme.test",
  });
  const thread = await insert(MailThread, {
    companyId,
    accountId: account.id,
    gmailThreadId: "provider-thread",
    subject: "Thread subject is not the specific message",
  });
  const message = await insert(MailMessage, {
    companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "provider-message",
    gmailThreadId: thread.gmailThreadId,
    subject: "Quote for three seats",
    fromName: "Alex",
    fromEmail: "alex@example.test",
    bodyText: "Private message body must not be copied",
    bodyHtml: "<p>Private HTML body</p>",
    toEmails: "private-to@example.test",
    ccEmails: "private-cc@example.test",
    bccEmails: "private-bcc@example.test",
  });
  const analysis = await insert(MailInboundAnalysis, {
    companyId,
    accountId: account.id,
    threadId: thread.id,
    messageId: message.id,
    employeeId,
    status: "succeeded",
    category: "quote_request",
    summary: "The customer asks for three seats.",
    actionsJson: JSON.stringify([
      { id: "0", kind: "draft_reply", label: "Prepare a reply", bodyText: "Private reply body" },
    ]),
    finishedAt,
    updatedAt: finishedAt,
  });
  const event = await insert(AuditEvent, {
    companyId,
    actorEmployeeId: employeeId,
    actorKind: "ai",
    targetType: "mail_inbound_analysis",
    targetId: analysis.id,
    targetLabel: "Do not use this unscoped audit label",
    action: "mail.analysis.completed",
    createdAt: auditAt,
    metadataJson: JSON.stringify({
      accountId: account.id,
      mailThreadId: thread.id,
      messageId: message.id,
      attemptStartedAt: startedAt.toISOString(),
      analysisSnapshot: {
        version: 1,
        status: "completed",
        durationMs: 12_000,
        category: "quote_request",
        summary: "The customer asks for three seats.",
        suggestedActions: ["Prepare a reply"],
      },
    }),
  });
  return { account, thread, message, analysis, event };
}

function metadata(event: AuditEvent, changes: Record<string, unknown>): AuditEvent {
  return {
    ...event,
    metadataJson: JSON.stringify({ ...JSON.parse(event.metadataJson), ...changes }),
  };
}

async function context(event: AuditEvent) {
  return (await mailAnalysisWorkTimeline(companyId, [event])).get(event.id)!;
}

function assertHidden(value: Awaited<ReturnType<typeof context>>) {
  assert.equal(value.subject, "");
  assert.equal(value.source, null);
  assert.equal(value.analysis.summary, null);
  assert.equal(value.analysis.error, null);
  assert.deepEqual(value.analysis.suggestedActions, []);
  assert.equal(value.analysis.resultAvailable, false);
  assert.doesNotMatch(
    JSON.stringify(value),
    /Quote for three seats|Alex|alex@example|support@acme|Do not use|customer asks/,
  );
}

test("completed analysis names the specific incoming message and gives safe source and result", async () => {
  const { event, thread, account } = await fixture();
  const value = await context(event);
  assert.equal(value.subject, "Quote for three seats");
  assert.deepEqual(value.source, {
    kind: "mail_thread",
    id: thread.id,
    accountId: account.id,
    label: "Email from Alex <alex@example.test>",
    detail: "support@acme.test · Incoming email analysis",
  });
  assert.equal(value.analysis.status, "completed");
  assert.equal(value.analysis.resultAvailable, true);
  assert.equal(value.analysis.category, "quote_request");
  assert.equal(value.analysis.summary, "The customer asks for three seats.");
  assert.deepEqual(value.analysis.suggestedActions, ["Prepare a reply"]);
  assert.equal(value.analysis.durationMs, 12_000);
  assert.match(value.analysis.purpose, /Classifies.*summarizes.*suggests/);
  assert.match(value.analysis.purpose, /does not send email or carry out/);
  assert.doesNotMatch(JSON.stringify(value), /Private|private-|bodyHtml|actionsJson|targetLabel/);
});

test("immutable earlier completion survives later failed re-analysis and employee reassignment", async () => {
  const { event, analysis } = await fixture();
  await AppDataSource.getRepository(MailInboundAnalysis).update(analysis.id, {
    employeeId: "another-employee",
    status: "failed",
    summary: "",
    category: "",
    actionsJson: "[]",
    errorMessage: "A later failure",
    updatedAt: new Date(auditAt.getTime() + 60_000),
  });
  const value = await context(event);
  assert.equal(value.analysis.summary, "The customer asks for three seats.");
  assert.deepEqual(value.analysis.suggestedActions, ["Prepare a reply"]);
  assert.equal(value.analysis.error, null);
});

test("a failure keeps its recorded reason after a successful retry", async () => {
  const { event } = await fixture();
  const failed = metadata(
    { ...event, action: "mail.analysis.failed" },
    {
      analysisSnapshot: {
        version: 1,
        status: "failed",
        durationMs: 9_000,
        error: "The AI Model exceeded its quota.",
      },
    },
  );
  const value = await context(failed);
  assert.equal(value.analysis.error, "The AI Model exceeded its quota.");
  assert.equal(value.analysis.summary, null);
  assert.deepEqual(value.analysis.suggestedActions, []);
  assert.equal(value.analysis.durationMs, 9_000);
});

test("a started event explains the read without claiming the live row's later success", async () => {
  const { event } = await fixture();
  const started = metadata(
    { ...event, action: "mail.analysis.started", createdAt: startedAt },
    {
      analysisSnapshot: { version: 1, status: "started", durationMs: null },
    },
  );
  const value = await context(started);
  assert.equal(value.analysis.status, "started");
  assert.equal(value.analysis.resultAvailable, false);
  assert.equal(value.analysis.summary, null);
  assert.deepEqual(value.analysis.suggestedActions, []);
  assert.equal(value.analysis.durationMs, null);
  assert.ok(value.source);
});

test("legacy current terminal can show the exact final row, but its duration stays unknown", async () => {
  const { event } = await fixture();
  const value = await context(
    metadata(event, {
      analysisSnapshot: undefined,
      attemptStartedAt: undefined,
      accountId: undefined,
    }),
  );
  assert.equal(value.analysis.resultAvailable, true);
  assert.equal(value.analysis.summary, "The customer asks for three seats.");
  assert.deepEqual(value.analysis.suggestedActions, ["Prepare a reply"]);
  assert.equal(value.analysis.durationMs, null);
});

test("legacy earlier completions never borrow the current result after a same-status same-employee retry", async () => {
  const { event, analysis } = await fixture();
  await AppDataSource.getRepository(MailInboundAnalysis).update(analysis.id, {
    summary: "This belongs to a newer attempt",
    updatedAt: new Date(auditAt.getTime() + 1),
    finishedAt: new Date(auditAt.getTime() + 1),
  });
  const value = await context(metadata(event, { analysisSnapshot: undefined }));
  assert.equal(value.analysis.resultAvailable, false);
  assert.equal(value.analysis.summary, null);
  assert.ok(value.source);
  assert.doesNotMatch(JSON.stringify(value), /newer attempt/);
});

test("legacy terminal result requires matching employee, status, and completed persistence", async () => {
  const { event, analysis } = await fixture();
  const legacy = metadata(event, { analysisSnapshot: undefined });
  for (const changed of [
    { employeeId: "another-employee" },
    { status: "running" as const },
    { status: "failed" as const },
    { finishedAt: null },
    { finishedAt: auditAt },
    { finishedAt: new Date(auditAt.getTime() + 1) },
    { updatedAt: auditAt },
    { updatedAt: new Date(auditAt.getTime() + 1) },
  ]) {
    await AppDataSource.getRepository(MailInboundAnalysis).update(analysis.id, {
      employeeId,
      status: "succeeded",
      finishedAt,
      updatedAt: finishedAt,
      ...changed,
    });
    assert.equal((await context(legacy)).analysis.resultAvailable, false);
  }
});

test("only one matching legacy terminal can acquire the current row's result", async () => {
  const { event } = await fixture();
  const first = metadata(event, { analysisSnapshot: undefined });
  const second = { ...first, id: "later-audit", createdAt: new Date(auditAt.getTime() + 1000) };
  const values = await mailAnalysisWorkTimeline(companyId, [second, first]);
  assert.equal(values.get(first.id)?.analysis.resultAvailable, true);
  assert.equal(values.get(second.id)?.analysis.resultAvailable, false);
});

test("unknown or mismatched immutable snapshots do not silently fall back to the current row", async () => {
  const { event } = await fixture();
  for (const analysisSnapshot of [
    { version: 2 },
    [],
    null,
    { version: 1, status: "failed", error: "wrong phase" },
  ]) {
    const value = await context(metadata(event, { analysisSnapshot }));
    assert.equal(value.analysis.resultAvailable, false);
    assert.equal(value.analysis.summary, null);
  }
});

describe("deleted or cross-company mail sources", () => {
  for (const entity of [MailInboundAnalysis, MailMessage, MailThread, MailAccount]) {
    test(`withholds all email details when ${entity.name} belongs to another company`, async () => {
      const values = await fixture();
      const id =
        entity === MailInboundAnalysis
          ? values.analysis.id
          : entity === MailMessage
            ? values.message.id
            : entity === MailThread
              ? values.thread.id
              : values.account.id;
      await AppDataSource.getRepository(entity as typeof MailAccount).update(id, {
        companyId: "another-company",
      });
      assertHidden(await context(values.event));
    });
    test(`withholds all email details after ${entity.name} is deleted`, async () => {
      const values = await fixture();
      const id =
        entity === MailInboundAnalysis
          ? values.analysis.id
          : entity === MailMessage
            ? values.message.id
            : entity === MailThread
              ? values.thread.id
              : values.account.id;
      await AppDataSource.getRepository(entity as typeof MailAccount).delete(id);
      assertHidden(await context(values.event));
    });
  }
});

test("the message, thread, and analysis must resolve to the same mailbox", async () => {
  const { event, thread, message } = await fixture();
  await AppDataSource.getRepository(MailMessage).update(message.id, { accountId: "wrong-mailbox" });
  assertHidden(await context(event));
  await AppDataSource.getRepository(MailMessage).update(message.id, {
    accountId: thread.accountId,
    threadId: "wrong-thread",
  });
  assertHidden(await context(event));
  await AppDataSource.getRepository(MailMessage).update(message.id, { threadId: thread.id });
  await AppDataSource.getRepository(MailThread).update(thread.id, { accountId: "wrong-mailbox" });
  assertHidden(await context(event));
});

test("metadata cannot attach another message, thread, or mailbox to an analysis", async () => {
  const { event } = await fixture();
  for (const changes of [
    { messageId: "wrong-message" },
    { mailThreadId: "wrong-thread" },
    { accountId: "wrong-mailbox" },
    { messageId: null },
  ]) {
    assertHidden(await context(metadata(event, changes)));
  }
  assertHidden(await context({ ...event, metadataJson: "{malformed" }));
});

test("does not enrich unrelated actions or same-id targets of another kind", async () => {
  const { event } = await fixture();
  for (const changed of [
    { action: "mail.analysis.create_invoice" },
    { targetType: "invoice" },
    { companyId: "another-company" },
  ]) {
    assert.equal((await mailAnalysisWorkTimeline(companyId, [{ ...event, ...changed }])).size, 0);
  }
});

test("safe fallbacks cover empty headers and malformed action lists without copying source bodies", async () => {
  const { event, analysis, message } = await fixture();
  await AppDataSource.getRepository(MailMessage).update(message.id, {
    subject: "",
    fromName: "",
    fromEmail: "",
  });
  await AppDataSource.getRepository(MailInboundAnalysis).update(analysis.id, {
    actionsJson: "{bad",
    updatedAt: finishedAt,
  });
  const value = await context(metadata(event, { analysisSnapshot: undefined }));
  assert.equal(value.subject, "Email without a subject");
  assert.equal(value.source?.label, "Incoming email");
  assert.equal(value.analysis.resultAvailable, false);
  assert.deepEqual(value.analysis.suggestedActions, []);
  assert.doesNotMatch(JSON.stringify(value), /Private/);
});

test("redacts and bounds headers, result labels, and failures at the response boundary", async () => {
  const { event, message, account } = await fixture();
  await AppDataSource.getRepository(MailMessage).update(message.id, {
    subject: "password=subject-secret " + "s".repeat(2000),
    fromName: "token=sender-secret",
    fromEmail: "https://name:email-secret@example.test/?key=key-secret",
  });
  await AppDataSource.getRepository(MailAccount).update(account.id, {
    address: "token=mailbox-secret",
  });
  const value = await context(
    metadata(event, {
      analysisSnapshot: {
        version: 1,
        status: "completed",
        durationMs: 1000,
        category: "quote_request",
        summary: "token=summary-secret",
        suggestedActions: ["password=action-secret"],
      },
    }),
  );
  assert.equal(value.subject.length, 300);
  assert.doesNotMatch(
    JSON.stringify(value),
    /subject-secret|sender-secret|email-secret|key-secret|mailbox-secret|summary-secret|action-secret/,
  );
});
