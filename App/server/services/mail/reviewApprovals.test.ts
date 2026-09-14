import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Approval } from "../../db/entities/Approval.js";
import { Company } from "../../db/entities/Company.js";
import { CompanyPolicy } from "../../db/entities/CompanyPolicy.js";
import { Conversation } from "../../db/entities/Conversation.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeResourceGrant } from "../../db/entities/EmployeeResourceGrant.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { JournalEntry } from "../../db/entities/JournalEntry.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Membership } from "../../db/entities/Membership.js";
import { Resource } from "../../db/entities/Resource.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../../test/dbHarness.js";
import { FakeMailbox } from "../../test/fakeMailbox.js";
import { approvePendingApproval } from "../approvals.js";
import type { MailActionDependencies } from "./actions.js";
import type { MimeFields } from "./mime.js";
import { addSuppression } from "./suppression.js";
import {
  createMailReviewApproval,
  executeMailReviewApproval,
  mailReviewDeliveryStatus,
  mailReviewDetails,
  mailReviewOutcome,
  reconcileMailReviewApprovals,
  recordMailReviewRejection,
  reviseMailReviewApproval,
  updateMailReviewApproval,
} from "./reviewApprovals.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const MAILBOX_ADDRESS = "support@example.test";
const CUSTOMER_ADDRESS = "customer@example.test";

type Fixture = {
  companyId: string;
  employee: AIEmployee;
  reviewerId: string;
  connection: IntegrationConnection;
  account: MailAccount;
  thread: MailThread;
  grant: EmployeeMailAccountGrant;
  mailbox: FakeMailbox;
  dependencies: MailActionDependencies;
};

async function fixture(): Promise<Fixture> {
  const companyId = testCompanyId();
  const employee = await insert(AIEmployee, {
    companyId,
    name: "Support",
    slug: "support",
    role: "Customer support",
  });
  const connection = await insert(IntegrationConnection, {
    companyId,
    provider: "imap",
    label: "Support inbox",
    authMode: "apikey",
    encryptedConfig: "unused-by-the-fake-mailbox",
    accountHint: MAILBOX_ADDRESS,
    status: "connected",
  });
  const account = await insert(MailAccount, {
    companyId,
    // The live Connection is part of the review's authority, but its
    // credential is never decrypted and no provider is contacted at create.
    connectionId: connection.id,
    provider: "imap",
    address: MAILBOX_ADDRESS,
    status: "active",
  });
  const lastMessageAt = new Date("2026-09-01T09:00:00.000Z");
  const thread = await insert(MailThread, {
    companyId,
    accountId: account.id,
    gmailThreadId: "provider-thread-1",
    subject: "Customer cannot sign in",
    messageCount: 1,
    lastMessageAt,
  });
  await insert(MailMessage, {
    companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "provider-message-1",
    gmailThreadId: thread.gmailThreadId,
    fromName: "Customer",
    fromEmail: CUSTOMER_ADDRESS,
    toEmails: MAILBOX_ADDRESS,
    subject: thread.subject,
    bodyText: "I cannot sign in after resetting my password.",
    labelIds: " INBOX ",
    sentAt: lastMessageAt,
    messageIdHeader: "<provider-message-1@example.test>",
  });
  const grant = await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  const mailbox = new FakeMailbox();
  return {
    companyId,
    employee,
    reviewerId: testId("reviewer"),
    connection,
    account,
    thread,
    grant,
    mailbox,
    dependencies: {
      mailbox: async () => mailbox,
      notify: () => undefined,
    },
  };
}

async function createReview(f: Fixture): Promise<Approval> {
  const result = await createMailReviewApproval({
    companyId: f.companyId,
    employeeId: f.employee.id,
    threadId: f.thread.id,
    context: "A customer reported that password-reset sign-in is broken.",
    workSummary: "The reset-token regression was fixed and verified.",
    steps: [
      { title: "Reproduced the bug" },
      { title: "Fixed the token check", detail: "The focused sign-in checks pass." },
    ],
    bodyText: "Thanks for reporting this. We fixed the issue.",
  });
  assert.equal(result.created, true);
  return result.approval;
}

async function routineOrigin(f: Fixture, slug: string) {
  const routine = await insert(Routine, {
    employeeId: f.employee.id,
    name: `Customer update ${slug}`,
    slug: `customer-update-${slug}`,
    cronExpr: "0 9 * * *",
    enabled: true,
    body: "Prepare an accurate customer update for human review.",
    mailDeliveryMode: "draft",
  });
  const run = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    status: "completed",
    triggerKind: "schedule",
  });
  return { routine, run };
}

async function authorizeReviewer(f: Fixture): Promise<void> {
  await insert(Membership, {
    companyId: f.companyId,
    userId: f.reviewerId,
    role: "owner",
  });
}

async function claimedForSend(f: Fixture, approval: Approval): Promise<Approval> {
  await authorizeReviewer(f);
  await AppDataSource.getRepository(Approval).update(
    { id: approval.id, companyId: f.companyId, status: "pending" },
    { status: "executing", decidedAt: new Date(), decidedByUserId: f.reviewerId },
  );
  return AppDataSource.getRepository(Approval).findOneByOrFail({
    id: approval.id,
    companyId: f.companyId,
  });
}

describe("mail review approvals", () => {
  test("creation stores one Approval without creating a local or provider draft", async () => {
    const f = await fixture();
    const messagesBefore = await AppDataSource.getRepository(MailMessage).countBy({
      accountId: f.account.id,
    });

    const approval = await createReview(f);

    assert.equal(approval.kind, "mail_send");
    assert.equal(approval.status, "pending");
    assert.equal(
      await AppDataSource.getRepository(Approval).countBy({
        companyId: f.companyId,
        kind: "mail_send",
      }),
      1,
    );
    assert.equal(
      await AppDataSource.getRepository(MailMessage).countBy({ accountId: f.account.id }),
      messagesBefore,
    );
    const messages = await AppDataSource.getRepository(MailMessage).findBy({
      accountId: f.account.id,
    });
    assert.equal(
      messages.every((message) => message.gmailDraftId === ""),
      true,
    );
    assert.equal(f.mailbox.calls.length, 0);

    const review = mailReviewDetails(approval);
    assert.match(review?.revision ?? "", /^[0-9a-f]{64}$/);
    assert.equal(review?.draft.to, CUSTOMER_ADDRESS);
    assert.equal(review?.draft.subject, `Re: ${f.thread.subject}`);
    assert.equal(review?.draft.bodyText, "Thanks for reporting this. We fixed the issue.");
  });

  test("candidate lookup excludes unrelated large review payloads before parsing", async (t) => {
    const f = await fixture();
    const marker = "unrelated-large-attachment-snapshot";
    const repo = AppDataSource.getRepository(Approval);
    await repo.save(
      repo.create({
        companyId: f.companyId,
        employeeId: f.employee.id,
        kind: "mail_send",
        routineId: "",
        title: "Unrelated reviewed email",
        summary: "Unrelated",
        status: "pending",
        payloadJson: JSON.stringify({
          marker,
          threadId: null,
          messageFingerprint: "0".repeat(64),
          attachments: [{ contentBase64: "A".repeat(500_000) }],
        }),
      }),
    );
    const originalParse = JSON.parse;
    let parsedUnrelated = false;
    t.mock.method(
      JSON,
      "parse",
      (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
        if (text.includes(marker)) parsedUnrelated = true;
        return originalParse(text, reviver);
      },
    );

    const approval = await createReview(f);

    assert.equal(approval.status, "pending");
    assert.equal(parsedUnrelated, false);
  });

  test("a fresh compose stays in the stack and sends directly without a provider draft", async () => {
    const f = await fixture();
    const { routine, run } = await routineOrigin(f, "send");
    const result = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      accountId: f.account.id,
      routineId: routine.id,
      runId: run.id,
      context: "The customer is due a scheduled service update.",
      workSummary: "The rollout status was verified.",
      to: "customer@example.test",
      cc: "success@example.test",
      bcc: "archive@example.test",
      subject: "Scheduled service update",
      bodyText: "The rollout is complete and service is healthy.",
    });
    const review = mailReviewDetails(result.approval)!;
    assert.equal(result.approval.routineId, routine.id);
    assert.equal(review.source.accountId, f.account.id);
    assert.equal(review.source.threadId, null);
    assert.equal(review.source.routineId, routine.id);
    assert.equal(review.source.runId, run.id);
    assert.deepEqual(review.draft, {
      to: "customer@example.test",
      cc: "success@example.test",
      bcc: "archive@example.test",
      subject: "Scheduled service update",
      bodyText: "The rollout is complete and service is healthy.",
    });
    assert.equal(f.mailbox.calls.length, 0);

    const claimed = await claimedForSend(f, result.approval);
    await executeMailReviewApproval(claimed, f.dependencies);
    const sends = f.mailbox.calls.filter((call) => call.method === "sendMessage");
    assert.equal(sends.length, 1);
    assert.equal(
      f.mailbox.calls.some((call) => call.method === "createDraft"),
      false,
    );
    assert.equal(sends[0].args[1], undefined, "fresh mail has no provider thread binding");
    const mime = sends[0].args[0] as MimeFields;
    assert.equal(mime.to, "customer@example.test");
    assert.equal(mime.subject, "Scheduled service update");
    assert.equal(mime.inReplyTo, undefined);
  });

  test("fresh composes dedupe exact messages inside one Run but not a later Run", async () => {
    const f = await fixture();
    const { routine, run } = await routineOrigin(f, "dedupe");
    const input = {
      companyId: f.companyId,
      employeeId: f.employee.id,
      accountId: f.account.id,
      routineId: routine.id,
      runId: run.id,
      context: "A scheduled account update is due.",
      to: "customer@example.test",
      subject: "Account update",
      bodyText: "Here is this week's account update.",
    };
    const first = await createMailReviewApproval(input);
    const duplicate = await createMailReviewApproval(input);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.approval.id, first.approval.id);

    first.approval.status = "approved";
    first.approval.resultJson = JSON.stringify({
      providerMessageRef: "provider-confirmed",
      sentAt: new Date().toISOString(),
    });
    await AppDataSource.getRepository(Approval).save(first.approval);
    const laterRun = await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(),
      status: "completed",
      triggerKind: "schedule",
    });
    const later = await createMailReviewApproval({ ...input, runId: laterRun.id });
    assert.equal(later.created, true);
    assert.notEqual(later.approval.id, first.approval.id);
  });

  test("a fresh compose without a new server-bound origin stays conservatively suppressed", async () => {
    const f = await fixture();
    const input = {
      companyId: f.companyId,
      employeeId: f.employee.id,
      accountId: f.account.id,
      context: "A one-off email was proposed outside a Routine Run.",
      to: CUSTOMER_ADDRESS,
      subject: "One-off update",
      bodyText: "Here is the requested one-off update.",
    };
    const first = await createMailReviewApproval(input);
    await AppDataSource.getRepository(Approval).update(first.approval.id, {
      status: "approved",
      resultJson: JSON.stringify({
        providerMessageRef: "provider-confirmed",
        sentAt: new Date().toISOString(),
      }),
    });

    const replay = await createMailReviewApproval(input);
    assert.equal(replay.created, false);
    assert.equal(replay.approval.id, first.approval.id);
  });

  test("two employees racing one thread converge on one company-wide reply review", async () => {
    const f = await fixture();
    const other = await insert(AIEmployee, {
      companyId: f.companyId,
      name: "Success",
      slug: "success",
      role: "Customer success",
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: other.id,
      accountId: f.account.id,
      accessLevel: "draft",
    });
    const request = (employeeId: string) =>
      createMailReviewApproval({
        companyId: f.companyId,
        employeeId,
        threadId: f.thread.id,
        context: "The customer needs a sign-in update.",
        bodyText: "Thanks for the report. We are investigating.",
      });
    const [left, right] = await Promise.all([request(f.employee.id), request(other.id)]);
    assert.equal([left, right].filter((result) => result.created).length, 1);
    assert.equal(left.approval.id, right.approval.id);
    assert.equal(
      await AppDataSource.getRepository(Approval).countBy({
        companyId: f.companyId,
        kind: "mail_send",
      }),
      1,
    );
  });

  test("a stale cross-employee card is rechecked under its original Grant", async () => {
    const f = await fixture();
    const other = await insert(AIEmployee, {
      companyId: f.companyId,
      name: "Success",
      slug: "success",
      role: "Customer success",
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: other.id,
      accountId: f.account.id,
      accessLevel: "draft",
    });
    const stale = await createReview(f);
    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { id: f.grant.id },
      { accessLevel: "read" },
    );

    const replacement = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: other.id,
      threadId: f.thread.id,
      context: "Customer success is now responsible for this sign-in issue.",
      bodyText: "Thanks for the report. Customer success is following up.",
    });

    assert.equal(replacement.created, true);
    assert.notEqual(replacement.approval.id, stale.id);
    assert.equal(replacement.approval.employeeId, other.id);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: stale.id })).status,
      "expired",
    );
  });

  test("an edit changes the exact message sent once and the Approval records its outcome", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const edited = {
      to: "primary@example.test",
      cc: "copy@example.test",
      bcc: "archive@example.test",
      subject: "Your sign-in issue is fixed",
      bodyText: "The fix is live. Please try signing in again.",
    };

    const updated = await updateMailReviewApproval({
      companyId: f.companyId,
      approvalId: approval.id,
      userId: f.reviewerId,
      expectedRevision: mailReviewDetails(approval)!.revision,
      ...edited,
    });
    assert.ok(updated);
    assert.deepEqual(mailReviewDetails(updated)?.draft, edited);

    await authorizeReviewer(f);
    const result = await approvePendingApproval({
      companyId: f.companyId,
      approvalId: updated.id,
      userId: f.reviewerId,
      expectedPayloadJson: updated.payloadJson!,
      execute: (claimed) => executeMailReviewApproval(claimed, f.dependencies),
    });
    assert.equal(result.outcome, "decided");

    const sendCalls = f.mailbox.calls.filter((call) => call.method === "sendMessage");
    assert.equal(sendCalls.length, 1);
    assert.equal(
      f.mailbox.calls.some((call) => call.method === "createDraft"),
      false,
    );
    const mime = sendCalls[0].args[0] as MimeFields;
    assert.equal(mime.to, edited.to);
    assert.equal(mime.cc, edited.cc);
    assert.equal(mime.bcc, edited.bcc);
    assert.equal(mime.subject, edited.subject);
    assert.equal(mime.bodyText, edited.bodyText);
    assert.equal(mime.inReplyTo, "<provider-message-1@example.test>");
    assert.equal(mime.references, "<provider-message-1@example.test>");

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
      companyId: f.companyId,
    });
    assert.equal(stored.status, "approved");
    const outcome = mailReviewOutcome(stored);
    assert.match(outcome?.sentMessageId ?? "", /^[0-9a-f-]{36}$/i);
    assert.match(outcome?.sentAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      await AppDataSource.getRepository(MailMessage).countBy({ accountId: f.account.id }),
      2,
    );
  });

  test("only the proposing employee can revise the pending in-stack email", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    assert.equal(
      await reviseMailReviewApproval({
        companyId: f.companyId,
        employeeId: testId("different_employee"),
        approvalId: approval.id,
        expectedRevision: mailReviewDetails(approval)!.revision,
        bodyText: "Wrong employee edit",
      }),
      null,
    );

    const revised = await reviseMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      approvalId: approval.id,
      expectedRevision: mailReviewDetails(approval)!.revision,
      bodyText: "Thanks for the note. The verified fix is now live.",
    });

    assert.equal(
      mailReviewDetails(revised!)?.draft.bodyText,
      "Thanks for the note. The verified fix is now live.",
    );
    assert.deepEqual(f.mailbox.calls, []);
  });

  test("rejects invalid edited recipients before the review can be sent", async () => {
    const f = await fixture();
    const approval = await createReview(f);

    await assert.rejects(
      updateMailReviewApproval({
        companyId: f.companyId,
        approvalId: approval.id,
        userId: f.reviewerId,
        expectedRevision: mailReviewDetails(approval)!.revision,
        to: "not-an-email",
      }),
      /To contains an invalid email address/i,
    );
    assert.deepEqual(f.mailbox.calls, []);
  });

  test("a mail-bound turn cannot revise a review from another source", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const expectedRevision = mailReviewDetails(approval)!.revision;

    assert.equal(
      await reviseMailReviewApproval({
        companyId: f.companyId,
        employeeId: f.employee.id,
        approvalId: approval.id,
        expectedRevision,
        expectedThreadId: testId("different_thread"),
        bodyText: "A different source must not be able to change this reply.",
      }),
      null,
    );
    assert.equal(
      await reviseMailReviewApproval({
        companyId: f.companyId,
        employeeId: f.employee.id,
        approvalId: approval.id,
        expectedRevision,
        expectedThreadId: f.thread.id,
        expectedMailHandoverId: testId("different_handover"),
        bodyText: "A different handover must not be able to change this reply.",
      }),
      null,
    );
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(
      mailReviewDetails(stored)?.draft.bodyText,
      "Thanks for reporting this. We fixed the issue.",
    );
  });

  test("a stale card cannot overwrite or send a newer review revision", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const staleRevision = mailReviewDetails(approval)!.revision;
    const stalePayload = approval.payloadJson!;
    const revised = await reviseMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      approvalId: approval.id,
      expectedRevision: staleRevision,
      bodyText: "This is the newer reviewed wording.",
    });
    assert.ok(revised);

    assert.equal(
      await updateMailReviewApproval({
        companyId: f.companyId,
        approvalId: approval.id,
        userId: f.reviewerId,
        expectedRevision: staleRevision,
        bodyText: "A stale editor must not win.",
      }),
      null,
    );
    await authorizeReviewer(f);
    let executed = false;
    const result = await approvePendingApproval({
      companyId: f.companyId,
      approvalId: approval.id,
      userId: f.reviewerId,
      expectedPayloadJson: stalePayload,
      execute: async () => {
        executed = true;
      },
    });
    assert.equal(result.outcome, "conflict");
    assert.equal(executed, false);
    assert.deepEqual(f.mailbox.calls, []);
  });

  test("the approval claim durably records not-sent before execution begins", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    await authorizeReviewer(f);
    const result = await approvePendingApproval({
      companyId: f.companyId,
      approvalId: approval.id,
      userId: f.reviewerId,
      expectedPayloadJson: approval.payloadJson!,
      execute: async (claimed) => {
        assert.equal(claimed.status, "executing");
        assert.equal(mailReviewDeliveryStatus(claimed), "not_sent");
        const durable = await AppDataSource.getRepository(Approval).findOneByOrFail({
          id: claimed.id,
        });
        assert.equal(mailReviewDeliveryStatus(durable), "not_sent");
        throw new Error("stop before provider setup");
      },
    });

    assert.equal(result.outcome, "decided");
    assert.equal(result.outcome === "decided" && result.approval.status, "execution_failed");
    assert.equal(
      result.outcome === "decided" && mailReviewDeliveryStatus(result.approval),
      "not_sent",
    );
    assert.deepEqual(f.mailbox.calls, []);
  });

  test("discarding a review sends and drafts nothing", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const messagesBefore = await AppDataSource.getRepository(MailMessage).countBy({
      accountId: f.account.id,
    });

    approval.status = "rejected";
    approval.decidedAt = new Date();
    approval.decidedByUserId = f.reviewerId;
    await AppDataSource.getRepository(Approval).save(approval);
    await recordMailReviewRejection(approval);

    assert.equal(approval.status, "rejected");
    assert.deepEqual(f.mailbox.calls, []);
    assert.equal(
      await AppDataSource.getRepository(MailMessage).countBy({ accountId: f.account.id }),
      messagesBefore,
    );
    const journal = await AppDataSource.getRepository(JournalEntry).findOneByOrFail({
      employeeId: f.employee.id,
    });
    assert.match(journal.title, /^Email reply discarded:/);
  });

  test("Discard suppresses the unchanged reply until new inbound evidence arrives", async () => {
    const f = await fixture();
    const discarded = await createReview(f);
    await AppDataSource.getRepository(Approval).update(discarded.id, {
      status: "rejected",
      decidedAt: new Date(),
      decidedByUserId: f.reviewerId,
    });

    const unchanged = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      threadId: f.thread.id,
      context: "An automatic retry must respect the prior Discard.",
      bodyText: "This must not create another Send button.",
    });
    assert.equal(unchanged.created, false);
    assert.equal(unchanged.approval.id, discarded.id);

    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: f.account.id,
      threadId: f.thread.id,
      gmailMessageId: "provider-message-after-discard",
      gmailThreadId: f.thread.gmailThreadId,
      fromName: "Customer",
      fromEmail: CUSTOMER_ADDRESS,
      toEmails: MAILBOX_ADDRESS,
      subject: f.thread.subject,
      bodyText: "There is new information after the discarded reply.",
      labelIds: " INBOX ",
      sentAt: new Date("2026-09-02T10:00:00.000Z"),
    });
    const changed = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      threadId: f.thread.id,
      context: "The customer supplied new information.",
      bodyText: "Thanks for the update. We reviewed the new information.",
    });
    assert.equal(changed.created, true);
    assert.notEqual(changed.approval.id, discarded.id);
  });

  test("an unverified attempt is suppressed, while a known not-sent failure is retryable", async () => {
    const f = await fixture();
    const failed = await createReview(f);
    await AppDataSource.getRepository(Approval).update(failed.id, {
      status: "execution_failed",
      resultJson: JSON.stringify({ deliveryStatus: "attempting" }),
      errorMessage: "Provider outcome lost",
    });
    const request = () =>
      createMailReviewApproval({
        companyId: f.companyId,
        employeeId: f.employee.id,
        threadId: f.thread.id,
        context: "The same source must not create a duplicate send.",
        bodyText: "This must remain suppressed while delivery is unverified.",
      });
    const ambiguous = await request();
    assert.equal(ambiguous.created, false);
    assert.equal(ambiguous.approval.id, failed.id);

    await AppDataSource.getRepository(Approval).update(failed.id, {
      resultJson: JSON.stringify({ deliveryStatus: "not_sent" }),
      errorMessage: "Stopped before provider contact",
    });
    const retry = await request();
    assert.equal(retry.created, true);
    assert.notEqual(retry.approval.id, failed.id);
  });

  test("a sent mirror does not re-arm a reply, but a new inbound message does", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    await authorizeReviewer(f);
    const sent = await approvePendingApproval({
      companyId: f.companyId,
      approvalId: approval.id,
      userId: f.reviewerId,
      expectedPayloadJson: approval.payloadJson!,
      execute: (claimed) => executeMailReviewApproval(claimed, f.dependencies),
    });
    assert.equal(sent.outcome, "decided");
    assert.equal(sent.outcome === "decided" && sent.approval.status, "approved");

    const mirrorOnly = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      threadId: f.thread.id,
      context: "The mailbox now contains only Genosyn's own sent mirror.",
      bodyText: "This must not send a duplicate reply.",
    });
    assert.equal(mirrorOnly.created, false);
    assert.equal(mirrorOnly.approval.id, approval.id);

    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: f.account.id,
      threadId: f.thread.id,
      gmailMessageId: "provider-message-new-inbound",
      gmailThreadId: f.thread.gmailThreadId,
      fromName: "Customer",
      fromEmail: CUSTOMER_ADDRESS,
      toEmails: MAILBOX_ADDRESS,
      subject: f.thread.subject,
      bodyText: "A genuinely new customer reply arrived.",
      labelIds: " INBOX ",
      sentAt: new Date("2026-09-03T10:00:00.000Z"),
      messageIdHeader: "<provider-message-new-inbound@example.test>",
    });
    const newInbound = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      threadId: f.thread.id,
      context: "The customer replied with a new question.",
      bodyText: "Thanks for the new question. Here is the answer.",
    });
    assert.equal(newInbound.created, true);
    assert.notEqual(newInbound.approval.id, approval.id);
  });

  test("a changed source thread fails closed before the mailbox is called", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const newerMessageAt = new Date("2026-09-02T10:00:00.000Z");
    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: f.account.id,
      threadId: f.thread.id,
      gmailMessageId: "provider-message-2",
      gmailThreadId: f.thread.gmailThreadId,
      fromName: "Customer",
      fromEmail: CUSTOMER_ADDRESS,
      toEmails: MAILBOX_ADDRESS,
      subject: f.thread.subject,
      bodyText: "This is still happening on another browser.",
      labelIds: " INBOX ",
      sentAt: newerMessageAt,
      messageIdHeader: "<provider-message-2@example.test>",
    });
    await AppDataSource.getRepository(MailThread).update(
      { id: f.thread.id, companyId: f.companyId },
      { messageCount: 2, lastMessageAt: newerMessageAt },
    );

    const claimed = await claimedForSend(f, approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, f.dependencies),
      /thread changed after this reply was prepared/i,
    );
    assert.deepEqual(f.mailbox.calls, []);
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");

    await reconcileMailReviewApprovals(f.companyId, new Date(Date.now() + 61 * 60_000));
    const reconciled = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
    });
    assert.equal(reconciled.status, "execution_failed");
    assert.match(reconciled.errorMessage ?? "", /not sent/i);
  });

  test("customer mail arriving during provider setup stops the stale reply before send", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const claimed = await claimedForSend(f, approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, {
        ...f.dependencies,
        onSendAttempt: async () => {
          await insert(MailMessage, {
            companyId: f.companyId,
            accountId: f.account.id,
            threadId: f.thread.id,
            gmailMessageId: "provider-message-during-setup",
            gmailThreadId: f.thread.gmailThreadId,
            fromName: "Customer",
            fromEmail: CUSTOMER_ADDRESS,
            toEmails: MAILBOX_ADDRESS,
            subject: f.thread.subject,
            bodyText: "This arrived after MIME setup but before provider contact.",
            labelIds: " INBOX ",
            sentAt: new Date("2026-09-02T10:00:00.000Z"),
          });
        },
      }),
      /changed immediately before sending/i,
    );

    assert.equal(
      f.mailbox.calls.some((call) => call.method === "sendMessage"),
      false,
    );
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");
  });

  test("a Suppression added during provider setup stops the email before send", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const claimed = await claimedForSend(f, approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, {
        ...f.dependencies,
        onSendAttempt: async () => {
          await addSuppression({
            companyId: f.companyId,
            email: CUSTOMER_ADDRESS,
            reason: "unsubscribe",
            source: "test",
          });
        },
      }),
      /do-not-email list/i,
    );

    assert.equal(
      f.mailbox.calls.some((call) => call.method === "sendMessage"),
      false,
    );
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");
  });

  test("a company Policy added during provider setup stops the email before send", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const claimed = await claimedForSend(f, approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, {
        ...f.dependencies,
        onSendAttempt: async () => {
          await insert(CompanyPolicy, {
            companyId: f.companyId,
            title: "No external test mail",
            body: "",
            blockedRecipientDomains: "example.test",
            enabled: true,
          });
        },
      }),
      /blocked by the company policy/i,
    );

    assert.equal(
      f.mailbox.calls.some((call) => call.method === "sendMessage"),
      false,
    );
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");
  });

  test("revoking attachment access during provider setup stops confidential bytes before send", async () => {
    const f = await fixture();
    await insert(Company, {
      id: f.companyId,
      name: "Attachment review company",
      slug: "attachment-review-company",
      ownerId: f.reviewerId,
    });
    const resource = await insert(Resource, {
      companyId: f.companyId,
      title: "Private incident summary",
      slug: "private-incident-summary",
      sourceKind: "text",
      sourceUrl: null,
      sourceFilename: null,
      storageKey: null,
      bodyText: "Confidential incident findings.",
      status: "ready",
    });
    const resourceGrant = await insert(EmployeeResourceGrant, {
      employeeId: f.employee.id,
      resourceId: resource.id,
      accessLevel: "read",
    });
    const approval = (
      await createMailReviewApproval({
        companyId: f.companyId,
        employeeId: f.employee.id,
        threadId: f.thread.id,
        context: "The customer needs the verified incident findings.",
        bodyText: "The requested incident summary is attached.",
        attachments: [{ resourceSlug: resource.slug, format: "txt" }],
      })
    ).approval;
    const claimed = await claimedForSend(f, approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, {
        ...f.dependencies,
        onSendAttempt: async () => {
          await AppDataSource.getRepository(EmployeeResourceGrant).delete(resourceGrant.id);
        },
      }),
      /No access to resource/i,
    );

    assert.equal(
      f.mailbox.calls.some((call) => call.method === "sendMessage"),
      false,
    );
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");
  });

  test("demoting the approving Member during provider setup stops the email before send", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const claimed = await claimedForSend(f, approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, {
        ...f.dependencies,
        onSendAttempt: async () => {
          await AppDataSource.getRepository(Membership).update(
            { companyId: f.companyId, userId: f.reviewerId },
            { role: "member" },
          );
        },
      }),
      /owner or admin must still have access/i,
    );

    assert.equal(
      f.mailbox.calls.some((call) => call.method === "sendMessage"),
      false,
    );
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");
  });

  test("deleting the mailbox Connection during provider setup stops the email before send", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const claimed = await claimedForSend(f, approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, {
        ...f.dependencies,
        onSendAttempt: async () => {
          await AppDataSource.getRepository(IntegrationConnection).delete(f.connection.id);
        },
      }),
      /Connection behind .* is no longer connected/i,
    );

    assert.equal(
      f.mailbox.calls.some((call) => call.method === "sendMessage"),
      false,
    );
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");
  });

  test("new customer mail expires a stale pending card and creates a fresh review", async () => {
    const f = await fixture();
    const stale = await createReview(f);
    const newerMessageAt = new Date("2026-09-02T10:00:00.000Z");
    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: f.account.id,
      threadId: f.thread.id,
      gmailMessageId: "provider-message-2",
      gmailThreadId: f.thread.gmailThreadId,
      fromName: "Customer",
      fromEmail: CUSTOMER_ADDRESS,
      toEmails: MAILBOX_ADDRESS,
      subject: f.thread.subject,
      bodyText: "Update: this also affects passwordless sign-in.",
      labelIds: " INBOX ",
      sentAt: newerMessageAt,
      messageIdHeader: "<provider-message-2@example.test>",
    });

    const fresh = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      threadId: f.thread.id,
      context: "The customer added new evidence about passwordless sign-in.",
      bodyText: "Thanks for the update. We are checking the passwordless path too.",
    });

    assert.equal(fresh.created, true);
    assert.notEqual(fresh.approval.id, stale.id);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: stale.id })).status,
      "expired",
    );
    assert.equal(
      mailReviewDetails(fresh.approval)?.draft.bodyText,
      "Thanks for the update. We are checking the passwordless path too.",
    );
    assert.deepEqual(f.mailbox.calls, []);
  });

  test("list-time reconciliation removes a pending card after its delivery Grant changes", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { id: f.grant.id },
      { accessLevel: "read" },
    );

    await reconcileMailReviewApprovals(f.companyId);

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(stored.status, "expired");
    assert.match(stored.errorMessage ?? "", /delivery authority changed/i);
    assert.deepEqual(f.mailbox.calls, []);
  });

  test("list-time reconciliation expires invalid automatic origins but preserves a manual review", async () => {
    const f = await fixture();
    const manual = await createReview(f);
    const createOriginReview = async (
      label: string,
      origin: { routineId?: string; runId?: string; conversationId?: string },
    ) =>
      (
        await createMailReviewApproval({
          companyId: f.companyId,
          employeeId: f.employee.id,
          accountId: f.account.id,
          ...origin,
          context: `Automatic ${label} customer update.`,
          to: CUSTOMER_ADDRESS,
          subject: `Automatic ${label} update`,
          bodyText: `Reviewed ${label} update.`,
        })
      ).approval;

    const disabled = await routineOrigin(f, "disabled");
    const disabledReview = await createOriginReview("disabled", {
      routineId: disabled.routine.id,
      runId: disabled.run.id,
    });
    const removed = await routineOrigin(f, "removed");
    const removedReview = await createOriginReview("removed", {
      routineId: removed.routine.id,
      runId: removed.run.id,
    });
    const missingRun = await routineOrigin(f, "missing-run");
    const missingRunReview = await createOriginReview("missing Run", {
      routineId: missingRun.routine.id,
      runId: missingRun.run.id,
    });
    const conversation = await insert(Conversation, {
      employeeId: f.employee.id,
      source: "web",
    });
    const missingConversationReview = await createOriginReview("missing conversation", {
      conversationId: conversation.id,
    });

    await AppDataSource.getRepository(Routine).update(disabled.routine.id, { enabled: false });
    await AppDataSource.getRepository(Routine).delete(removed.routine.id);
    await AppDataSource.getRepository(Run).delete(missingRun.run.id);
    await AppDataSource.getRepository(Conversation).delete(conversation.id);

    await reconcileMailReviewApprovals(f.companyId);

    for (const approval of [
      disabledReview,
      removedReview,
      missingRunReview,
      missingConversationReview,
    ]) {
      const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({
        id: approval.id,
      });
      assert.equal(stored.status, "expired");
      assert.match(stored.errorMessage ?? "", /no longer current/i);
    }
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: manual.id })).status,
      "pending",
    );
    assert.deepEqual(f.mailbox.calls, []);
  });

  test("the provider boundary rechecks a source Routine before sending", async () => {
    const f = await fixture();
    const { routine, run } = await routineOrigin(f, "boundary");
    const result = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      accountId: f.account.id,
      routineId: routine.id,
      runId: run.id,
      context: "A scheduled customer update is due.",
      to: CUSTOMER_ADDRESS,
      subject: "Scheduled customer update",
      bodyText: "The scheduled update is ready for review.",
    });
    const claimed = await claimedForSend(f, result.approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, {
        ...f.dependencies,
        onSendAttempt: async () => {
          await AppDataSource.getRepository(Routine).update(routine.id, { enabled: false });
        },
      }),
      /source Routine was disabled or removed/i,
    );

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: result.approval.id,
    });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");
    assert.equal(f.mailbox.calls.filter((call) => call.method === "sendMessage").length, 0);
  });

  test("list-time reconciliation preserves a pending card when database revalidation fails", async (t) => {
    const f = await fixture();
    const approval = await createReview(f);
    t.mock.method(AppDataSource.getRepository(IntegrationConnection), "findOneBy", async () => {
      throw new Error("database temporarily unavailable");
    });

    await assert.rejects(
      reconcileMailReviewApprovals(f.companyId),
      /database temporarily unavailable/i,
    );

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(stored.status, "pending");
    assert.equal(stored.errorMessage, null);
  });

  test("backfilled earlier thread evidence also expires a pending review", async () => {
    const f = await fixture();
    const stale = await createReview(f);
    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: f.account.id,
      threadId: f.thread.id,
      gmailMessageId: "provider-message-backfilled",
      gmailThreadId: f.thread.gmailThreadId,
      fromName: "Customer",
      fromEmail: CUSTOMER_ADDRESS,
      toEmails: MAILBOX_ADDRESS,
      subject: f.thread.subject,
      bodyText: "This earlier message was delayed during sync.",
      labelIds: " INBOX ",
      sentAt: new Date("2026-08-31T10:00:00.000Z"),
      messageIdHeader: "<provider-message-backfilled@example.test>",
    });

    const replacement = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      threadId: f.thread.id,
      context: "Mailbox sync recovered additional customer evidence.",
      bodyText: "Thanks. We also reviewed your earlier message.",
    });

    assert.equal(replacement.created, true);
    assert.notEqual(replacement.approval.id, stale.id);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: stale.id })).status,
      "expired",
    );
  });

  test("new customer mail never replaces a review that is already executing", async () => {
    const f = await fixture();
    const other = await insert(AIEmployee, {
      companyId: f.companyId,
      name: "Success",
      slug: "success",
      role: "Customer success",
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: other.id,
      accountId: f.account.id,
      accessLevel: "draft",
    });
    const executing = await createReview(f);
    await AppDataSource.getRepository(Approval).update(executing.id, {
      status: "executing",
      decidedAt: new Date(),
      decidedByUserId: f.reviewerId,
    });
    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { id: f.grant.id },
      { accessLevel: "read" },
    );
    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: f.account.id,
      threadId: f.thread.id,
      gmailMessageId: "provider-message-while-sending",
      gmailThreadId: f.thread.gmailThreadId,
      fromName: "Customer",
      fromEmail: CUSTOMER_ADDRESS,
      toEmails: MAILBOX_ADDRESS,
      subject: f.thread.subject,
      bodyText: "One more detail arrived while the reply was sending.",
      labelIds: " INBOX ",
      sentAt: new Date("2026-09-02T11:00:00.000Z"),
    });

    const result = await createMailReviewApproval({
      companyId: f.companyId,
      employeeId: other.id,
      threadId: f.thread.id,
      context: "The customer supplied one more detail.",
      bodyText: "This must not become a competing send card.",
    });

    assert.equal(result.created, false);
    assert.equal(result.approval.id, executing.id);
    assert.equal(result.approval.status, "executing");
    assert.equal(
      await AppDataSource.getRepository(Approval).countBy({
        companyId: f.companyId,
        kind: "mail_send",
      }),
      1,
    );
  });

  test("label-only changes do not invalidate the reviewed reply", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    await AppDataSource.getRepository(MailMessage).update(
      { gmailMessageId: "provider-message-1", accountId: f.account.id },
      { labelIds: " INBOX UNREAD STARRED " },
    );

    const claimed = await claimedForSend(f, approval);
    await executeMailReviewApproval(claimed, f.dependencies);

    assert.equal(f.mailbox.calls.filter((call) => call.method === "sendMessage").length, 1);
  });

  test("provider acceptance stays a success when the local mirror refresh fails", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    await authorizeReviewer(f);
    const result = await approvePendingApproval({
      companyId: f.companyId,
      approvalId: approval.id,
      userId: f.reviewerId,
      expectedPayloadJson: approval.payloadJson!,
      execute: (claimed) =>
        executeMailReviewApproval(claimed, {
          ...f.dependencies,
          onSendAccepted: async () => {
            throw new Error("mirror unavailable after provider acceptance");
          },
        }),
    });

    assert.equal(result.outcome, "decided");
    assert.equal(result.outcome === "decided" && result.approval.status, "approved");
    assert.match(
      result.outcome === "decided"
        ? (mailReviewOutcome(result.approval)?.providerMessageRef ?? "")
        : "",
      /^msg-/,
    );
    assert.equal(f.mailbox.calls.filter((call) => call.method === "sendMessage").length, 1);
  });

  test("stale executing sends never retry and reconcile from durable acceptance evidence", async () => {
    const f = await fixture();
    const accepted = await createReview(f);
    const repo = AppDataSource.getRepository(Approval);
    const ambiguous = await repo.save(
      repo.create({
        companyId: f.companyId,
        employeeId: f.employee.id,
        kind: "mail_send",
        routineId: "",
        title: accepted.title,
        summary: accepted.summary,
        payloadJson: accepted.payloadJson,
        resultJson: null,
        errorMessage: null,
        status: "executing",
        decidedAt: new Date("2026-09-01T10:00:00.000Z"),
        decidedByUserId: f.reviewerId,
      }),
    );
    const acceptance = JSON.stringify({
      providerMessageRef: "provider-accepted-before-crash",
      sentAt: "2026-09-01T10:00:01.000Z",
    });
    await repo.update(accepted.id, {
      status: "executing",
      decidedAt: new Date("2026-09-01T10:00:00.000Z"),
      decidedByUserId: f.reviewerId,
      resultJson: acceptance,
    });

    await reconcileMailReviewApprovals(f.companyId, new Date("2026-09-01T10:59:00.000Z"));
    assert.equal((await repo.findOneByOrFail({ id: accepted.id })).status, "executing");
    assert.equal((await repo.findOneByOrFail({ id: ambiguous.id })).status, "executing");

    await reconcileMailReviewApprovals(f.companyId, new Date("2026-09-01T11:01:00.000Z"));

    const recovered = await repo.findOneByOrFail({ id: accepted.id });
    assert.equal(recovered.status, "approved");
    assert.equal(recovered.resultJson, acceptance);
    assert.equal(recovered.errorMessage, null);
    const failed = await repo.findOneByOrFail({ id: ambiguous.id });
    assert.equal(failed.status, "execution_failed");
    assert.equal(failed.resultJson, null);
    assert.match(failed.errorMessage ?? "", /unverified.*not retried/i);
    assert.deepEqual(f.mailbox.calls, []);
  });

  test("a provider-call failure is recorded as unverified and never retried", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    const claimed = await claimedForSend(f, approval);
    f.mailbox.failNext.sendMessage = new Error("provider response lost");

    await assert.rejects(
      executeMailReviewApproval(claimed, f.dependencies),
      /provider response lost/i,
    );
    const attempted = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
    });
    assert.equal(mailReviewDeliveryStatus(attempted), "unverified");
    assert.equal(f.mailbox.calls.filter((call) => call.method === "sendMessage").length, 1);

    await reconcileMailReviewApprovals(f.companyId, new Date(Date.now() + 61 * 60_000));
    const reconciled = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
    });
    assert.equal(reconciled.status, "execution_failed");
    assert.match(reconciled.errorMessage ?? "", /unverified.*not retried/i);
    assert.equal(f.mailbox.calls.filter((call) => call.method === "sendMessage").length, 1);
  });

  test("a revoked draft Grant fails closed before the mailbox is called", async () => {
    const f = await fixture();
    const approval = await createReview(f);
    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { id: f.grant.id },
      { accessLevel: "read" },
    );

    const claimed = await claimedForSend(f, approval);

    await assert.rejects(
      executeMailReviewApproval(claimed, f.dependencies),
      /draft access .* is required/i,
    );
    assert.deepEqual(f.mailbox.calls, []);
    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(mailReviewDeliveryStatus(stored), "not_sent");
  });
});
