import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Approval } from "../../db/entities/Approval.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Membership } from "../../db/entities/Membership.js";
import { Routine } from "../../db/entities/Routine.js";
import { Run } from "../../db/entities/Run.js";
import { Standdown } from "../../db/entities/Standdown.js";
import { User } from "../../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { approvePendingApproval, rejectPendingApproval } from "../approvals.js";
import { CHAT_HARD_TIMEOUT_MS } from "../chat.js";
import { refreshStanddowns } from "../standdowns.js";
import {
  createProactiveWorkApproval,
  executeProactiveWorkApproval,
  listProactiveWorkReviews,
  parseProactiveWorkPayload,
  proactiveWorkOutcomeSummary,
  proactiveWorkReviewDetails,
  reconcileProactiveWorkApprovals,
  reviseProactiveWorkApproval,
  validateProactiveRoutineApproval,
  type ProactiveWorkOrigin,
} from "./approvals.js";
import { routineDeliveryPolicy, routineNeedsWorkReview } from "./policy.js";

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  await refreshStanddowns();
});
after(closeTestDb);

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function fixture() {
  const companyId = "company";
  const employee = await insert(AIEmployee, {
    companyId,
    name: "Morgan",
    slug: "morgan",
    role: "Support",
  });
  const member = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 3,
  });
  const membership = await insert(Membership, { companyId, userId: member.id, role: "owner" });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Customer issues",
    slug: "customer-issues",
    cronExpr: "0 9 * * *",
    body: "Review current customer issues.",
    mailDeliveryMode: "draft",
  });
  const run = await insert(Run, {
    startedAt: new Date(),
    routineId: routine.id,
    triggerKind: "schedule",
    status: "completed",
  });
  const origin: ProactiveWorkOrigin = {
    routineId: routine.id,
    runId: run.id,
    mailDeliveryMode: "draft",
  };
  const request = {
    companyId,
    employeeId: employee.id,
    title: "Fix Acme's checkout error",
    context: "Acme reported that checkout returns an error.",
    plan: "Start a narrow Repository work session to fix the checkout error and add a regression test. Leave changes for Member review.",
    origin,
  };
  return { companyId, employee, member, membership, routine, run, origin, request };
}

test("automatic starters and events have review authority independently of routine approvals", () => {
  const normal = { mailDeliveryMode: null, selfReviewOnly: false };
  assert.equal(routineNeedsWorkReview(normal, "manual"), false);
  assert.equal(routineNeedsWorkReview(normal, "event"), true);
  assert.equal(routineNeedsWorkReview(normal, "webhook"), true);
  assert.equal(routineNeedsWorkReview(normal, "retry"), true);
  assert.equal(routineNeedsWorkReview({ ...normal, mailDeliveryMode: "draft" }, "schedule"), true);
  assert.equal(routineDeliveryPolicy(normal, true).allowPrivilegedToolSources, false);
  assert.equal(routineNeedsWorkReview({ ...normal, selfReviewOnly: true }, "schedule"), false);
});

test("work reviews remain inert and repeated polls reuse the exact pending plan", async () => {
  const f = await fixture();
  const approval = await createProactiveWorkApproval(f.request);
  await assert.rejects(
    executeProactiveWorkApproval(approval, async () => assert.fail("Not approved")),
    /human must claim/,
  );
  const nextRun = await insert(Run, {
    startedAt: new Date(),
    routineId: f.routine.id,
    triggerKind: "schedule",
    status: "running",
  });
  const repeated = await createProactiveWorkApproval({
    ...f.request,
    origin: { ...f.origin, runId: nextRun.id },
  });
  assert.equal(repeated.id, approval.id);
  assert.equal(await AppDataSource.getRepository(Approval).count(), 1);
  assert.equal(approval.status, "pending");
  assert.equal(parseProactiveWorkPayload(approval.payloadJson).plan, f.request.plan);
});

test("only the proposing employee can revise the current pending plan", async () => {
  const f = await fixture();
  const approval = await createProactiveWorkApproval(f.request);
  const originalRevision = proactiveWorkReviewDetails(approval)!.revision;
  assert.equal(
    await reviseProactiveWorkApproval({
      companyId: f.companyId,
      employeeId: "another-employee",
      approvalId: approval.id,
      expectedRevision: originalRevision,
      plan: "This must not be saved.",
    }),
    null,
  );

  const revised = await reviseProactiveWorkApproval({
    companyId: f.companyId,
    employeeId: f.employee.id,
    approvalId: approval.id,
    expectedRevision: originalRevision,
    plan: "Investigate the checkout error first, then leave a narrow fix and regression test for Member review.",
  });
  assert.ok(revised);
  const current = parseProactiveWorkPayload(revised.payloadJson);
  assert.notEqual(proactiveWorkReviewDetails(revised)!.revision, originalRevision);
  assert.match(current.plan, /^Investigate the checkout error/);
  assert.equal(
    await reviseProactiveWorkApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      approvalId: approval.id,
      expectedRevision: originalRevision,
      title: "Stale overwrite",
    }),
    null,
  );
});

test("new customer evidence invalidates an email-backed work review", async () => {
  const f = await fixture();
  const account = await insert(MailAccount, {
    companyId: f.companyId,
    connectionId: "connection",
    address: "support@example.test",
    status: "active",
  });
  const thread = await insert(MailThread, {
    companyId: f.companyId,
    accountId: account.id,
    gmailThreadId: "customer-thread",
    subject: "Checkout issue",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: f.employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  await insert(MailMessage, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "customer-message-1",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "customer@example.test",
    toEmails: account.address,
    subject: thread.subject,
    bodyText: "Checkout fails after I enter my card.",
    sentAt: new Date("2026-09-01T09:00:00.000Z"),
    labelIds: " INBOX ",
  });
  const approval = await createProactiveWorkApproval({
    ...f.request,
    origin: { mailThreadId: thread.id, mailDeliveryMode: "review" },
  });
  await insert(MailMessage, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "customer-message-2",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "customer@example.test",
    toEmails: account.address,
    subject: thread.subject,
    bodyText: "Update: the failure only happens with saved cards.",
    sentAt: new Date("2026-09-01T10:00:00.000Z"),
    labelIds: " INBOX ",
  });

  const result = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: approval.id,
    userId: f.member.id,
    execute: (row) =>
      executeProactiveWorkApproval(row, async () => assert.fail("stale work must not start")),
  });

  assert.equal(result.outcome === "decided" && result.approval.status, "execution_failed");
  assert.match(
    result.outcome === "decided" ? (result.sideEffectError ?? "") : "",
    /source instruction changed/i,
  );
});

test("mail-backed pending and executing work collapses across employees and wording", async () => {
  const f = await fixture();
  const otherEmployee = await insert(AIEmployee, {
    companyId: f.companyId,
    name: "Riley",
    slug: "riley",
    role: "Engineering",
  });
  const account = await insert(MailAccount, {
    companyId: f.companyId,
    connectionId: "connection",
    address: "support@example.test",
    status: "active",
  });
  const thread = await insert(MailThread, {
    companyId: f.companyId,
    accountId: account.id,
    gmailThreadId: "shared-customer-thread",
    subject: "Checkout issue",
  });
  for (const employeeId of [f.employee.id, otherEmployee.id]) {
    await insert(EmployeeMailAccountGrant, {
      employeeId,
      accountId: account.id,
      accessLevel: "draft",
    });
  }
  await insert(MailMessage, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "shared-customer-message",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "customer@example.test",
    toEmails: account.address,
    subject: thread.subject,
    bodyText: "Checkout fails after I enter my card.",
    sentAt: new Date("2026-09-01T09:00:00.000Z"),
    labelIds: " INBOX ",
  });
  const origin = { mailThreadId: thread.id, mailDeliveryMode: "review" as const };
  const [supportReview, engineeringReview] = await Promise.all([
    createProactiveWorkApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      title: "Investigate the checkout report",
      context: "A customer cannot complete checkout.",
      plan: "Reproduce the checkout failure and leave a narrow fix for review.",
      origin,
    }),
    createProactiveWorkApproval({
      companyId: f.companyId,
      employeeId: otherEmployee.id,
      title: "Repair Acme's payment flow",
      context: "The payment flow is failing for a customer.",
      plan: "Inspect the payment path, add coverage, and leave the result for review.",
      origin,
    }),
  ]);

  assert.equal(engineeringReview.id, supportReview.id);
  assert.equal(await AppDataSource.getRepository(Approval).count(), 1);
  await AppDataSource.getRepository(Approval).update(
    { id: supportReview.id },
    { status: "executing", decidedAt: new Date(), decidedByUserId: f.member.id },
  );
  const whileExecuting = await createProactiveWorkApproval({
    companyId: f.companyId,
    employeeId: otherEmployee.id,
    title: "Try a different checkout investigation",
    context: "The same customer thread still needs attention.",
    plan: "Start an alternate investigation and prepare a separate fix.",
    origin,
  });
  assert.equal(whileExecuting.id, supportReview.id);
  assert.equal(await AppDataSource.getRepository(Approval).count(), 1);
});

test("terminal mail-backed work stays suppressed until new inbound evidence", async () => {
  const f = await fixture();
  const account = await insert(MailAccount, {
    companyId: f.companyId,
    connectionId: "connection",
    address: "support@example.test",
    status: "active",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: f.employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  const statuses = ["rejected", "approved", "execution_failed"] as const;

  for (const [index, status] of statuses.entries()) {
    const thread = await insert(MailThread, {
      companyId: f.companyId,
      accountId: account.id,
      gmailThreadId: `terminal-thread-${index}`,
      subject: `Customer issue ${index}`,
    });
    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: `customer-${index}-1`,
      gmailThreadId: thread.gmailThreadId,
      fromEmail: "customer@example.test",
      toEmails: account.address,
      subject: thread.subject,
      bodyText: `Initial customer evidence ${index}.`,
      sentAt: new Date(`2026-09-0${index + 1}T09:00:00.000Z`),
      labelIds: " INBOX ",
    });
    const origin = { mailThreadId: thread.id, mailDeliveryMode: "review" as const };
    const original = await createProactiveWorkApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      title: `Investigate customer issue ${index}`,
      context: "The customer reported a reproducible problem.",
      plan: "Investigate the report and leave the bounded result for Member review.",
      origin,
    });
    await AppDataSource.getRepository(Approval).update(
      { id: original.id },
      { status, decidedAt: new Date(), decidedByUserId: f.member.id },
    );

    const rephrased = await createProactiveWorkApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      title: `Take another look at issue ${index}`,
      context: "The same evidence could be described differently.",
      plan: "Approach the same customer problem from another angle.",
      origin,
    });
    assert.equal(rephrased.id, original.id, `${status} rephrasing`);

    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: `employee-${index}-reply`,
      gmailThreadId: thread.gmailThreadId,
      fromEmail: account.address,
      toEmails: "customer@example.test",
      subject: thread.subject,
      bodyText: "We investigated the report and will follow up if anything changes.",
      sentAt: new Date(`2026-09-0${index + 1}T10:00:00.000Z`),
      labelIds: " SENT ",
    });
    const afterOwnReply = await createProactiveWorkApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      title: `Reopen customer issue ${index}`,
      context: "Our sent mirror changed the full email thread.",
      plan: "Repeat the already reviewed work after our own reply.",
      origin,
    });
    assert.equal(afterOwnReply.id, original.id, `${status} own SENT mirror`);

    await insert(MailMessage, {
      companyId: f.companyId,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: `customer-${index}-2`,
      gmailThreadId: thread.gmailThreadId,
      fromEmail: "customer@example.test",
      toEmails: account.address,
      subject: thread.subject,
      bodyText: `New customer evidence ${index}.`,
      sentAt: new Date(`2026-09-0${index + 1}T11:00:00.000Z`),
      labelIds: " INBOX ",
    });
    const afterCustomerReply = await createProactiveWorkApproval({
      companyId: f.companyId,
      employeeId: f.employee.id,
      title: `Review the customer's update ${index}`,
      context: "The customer added material evidence.",
      plan: "Review the new evidence and propose only the newly warranted work.",
      origin,
    });
    assert.notEqual(afterCustomerReply.id, original.id, `${status} new inbound evidence`);
  }
});

test("one human approval starts one bounded session with the original draft ceiling", async () => {
  const f = await fixture();
  const approval = await createProactiveWorkApproval(f.request);
  let calls = 0;
  const execute = (row: Approval) =>
    executeProactiveWorkApproval(
      row,
      async () => assert.fail("Routine approvals must run Checks"),
      async (routine, options) => {
        calls++;
        assert.equal(options.proactiveApprovalId, approval.id);
        assert.equal(options.triggerKind, "approval");
        const proof = await validateProactiveRoutineApproval(approval.id, routine, f.companyId);
        assert.match(proof.brief, /Do only the approved scope/);
        assert.match(proof.brief, /checkout error/);
        assert.equal(proof.payload.origin.mailDeliveryMode, "draft");
        assert.equal(proof.user.id, f.member.id);
        return insert(Run, {
          routineId: routine.id,
          startedAt: new Date(),
          status: "completed",
          checksVerdict: "passed",
          outcomeVerdict: "achieved",
          outcomeNote: "Prepared a branch for review.",
        });
      },
    );
  const first = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: approval.id,
    userId: f.member.id,
    execute,
  });
  assert.equal(first.outcome, "decided");
  assert.equal(first.outcome === "decided" && first.approval.status, "approved");
  const second = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: approval.id,
    userId: f.member.id,
    execute,
  });
  assert.equal(second.outcome, "conflict");
  assert.equal(calls, 1);
  const saved = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
  assert.match(saved.resultJson!, /Prepared a branch/);
});

test("approved Routine work requires positive Check and graded outcome evidence", async () => {
  const f = await fixture();
  await AppDataSource.getRepository(Routine).update(
    { id: f.routine.id },
    {
      acceptanceCriteria: "The checkout regression is reproduced and the proposed fix is verified.",
    },
  );
  const cases: Array<{
    label: string;
    checksVerdict: Run["checksVerdict"];
    outcomeVerdict: Run["outcomeVerdict"];
  }> = [
    { label: "missing Checks", checksVerdict: null, outcomeVerdict: "achieved" },
    { label: "unclear outcome", checksVerdict: "passed", outcomeVerdict: "unclear" },
    { label: "unverified outcome", checksVerdict: "passed", outcomeVerdict: "unverified" },
    { label: "missing graded outcome", checksVerdict: "passed", outcomeVerdict: null },
  ];

  for (const candidate of cases) {
    const approval = await createProactiveWorkApproval({
      ...f.request,
      title: `Review ${candidate.label}`,
    });
    const result = await approvePendingApproval({
      companyId: f.companyId,
      approvalId: approval.id,
      userId: f.member.id,
      execute: (row) =>
        executeProactiveWorkApproval(
          row,
          async () => assert.fail("Routine approvals must run through the Routine runner"),
          async (routine) =>
            insert(Run, {
              routineId: routine.id,
              startedAt: new Date(),
              status: "completed",
              checksVerdict: candidate.checksVerdict,
              outcomeVerdict: candidate.outcomeVerdict,
              outcomeNote: `Result for ${candidate.label}`,
            }),
        ),
    });
    assert.equal(
      result.outcome === "decided" && result.approval.status,
      "execution_failed",
      candidate.label,
    );
    assert.match(
      result.outcome === "decided" ? (result.sideEffectError ?? "") : "",
      /required Checks and outcome satisfied/,
      candidate.label,
    );
  }
});

test("approved Routine work accepts a null outcome only when no criteria exist", async () => {
  const f = await fixture();
  const approval = await createProactiveWorkApproval(f.request);
  const result = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: approval.id,
    userId: f.member.id,
    execute: (row) =>
      executeProactiveWorkApproval(
        row,
        async () => assert.fail("Routine approvals must run through the Routine runner"),
        async (routine) =>
          insert(Run, {
            routineId: routine.id,
            startedAt: new Date(),
            status: "completed",
            checksVerdict: "not_run",
            outcomeVerdict: null,
            outcomeNote: null,
          }),
      ),
  });
  assert.equal(result.outcome === "decided" && result.approval.status, "approved");
});

test("rejection, changed instructions, revoked membership and Standdown never start work", async () => {
  const f = await fixture();
  const rejected = await createProactiveWorkApproval(f.request);
  await rejectPendingApproval({
    companyId: f.companyId,
    approvalId: rejected.id,
    userId: f.member.id,
  });
  const unchanged = await createProactiveWorkApproval(f.request);
  assert.equal(unchanged.id, rejected.id);
  assert.equal(unchanged.status, "rejected");
  const refused = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: rejected.id,
    userId: f.member.id,
    execute: async () => assert.fail("Rejected"),
  });
  assert.equal(refused.outcome, "conflict");
  const approval = await createProactiveWorkApproval({
    ...f.request,
    title: "Check the revised checkout report",
  });
  assert.notEqual(approval.id, rejected.id);
  await AppDataSource.getRepository(Routine).update(
    { id: f.routine.id },
    { body: "Different scope" },
  );
  const drift = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: approval.id,
    userId: f.member.id,
    execute: (row) => executeProactiveWorkApproval(row, async () => assert.fail("Changed source")),
  });
  assert.equal(drift.outcome === "decided" && drift.approval.status, "execution_failed");
  assert.match(
    drift.outcome === "decided" ? (drift.sideEffectError ?? "") : "",
    /source instruction changed/,
  );
  const next = await createProactiveWorkApproval({
    ...f.request,
    title: "Investigate another report",
  });
  await AppDataSource.getRepository(Membership).update({ id: f.membership.id }, { role: "member" });
  const denied = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: next.id,
    userId: f.member.id,
    execute: (row) => executeProactiveWorkApproval(row, async () => assert.fail("Demoted")),
  });
  assert.match(
    denied.outcome === "decided" ? (denied.sideEffectError ?? "") : "",
    /owner or admin/,
  );
  await insert(Standdown, {
    placedAt: new Date(),
    companyId: f.companyId,
    scope: "employee",
    scopeId: f.employee.id,
    reason: "Stop",
  });
  await refreshStanddowns();
  await assert.rejects(createProactiveWorkApproval(f.request), /Standdown/);
});

test("source ownership, missing source and delivery scope fail closed", async () => {
  const f = await fixture();
  await assert.rejects(
    createProactiveWorkApproval({ ...f.request, origin: {} }),
    /original Routine or email/,
  );
  await assert.rejects(
    createProactiveWorkApproval({
      ...f.request,
      origin: { ...f.origin, mailDeliveryMode: "reply" },
    }),
    /Decision-stack review restriction/,
  );
  await assert.rejects(
    createProactiveWorkApproval({ ...f.request, origin: { ...f.origin, selfReviewOnly: true } }),
    /Revision proposal/,
  );
  await assert.rejects(
    createProactiveWorkApproval({ ...f.request, employeeId: "other-employee" }),
    /no longer in this company/,
  );
  const triageReview = await createProactiveWorkApproval({
    ...f.request,
    origin: { ...f.origin, mailDeliveryMode: "triage" },
  });
  assert.equal(triageReview.status, "pending");
  assert.equal(
    parseProactiveWorkPayload(triageReview.payloadJson).origin.mailDeliveryMode,
    "triage",
  );
});

test("email reviews retain source restrictions and invalidate edited rules", async () => {
  const f = await fixture();
  const account = await insert(MailAccount, {
    companyId: f.companyId,
    connectionId: "connection",
    address: "team@example.test",
  });
  const thread = await insert(MailThread, {
    companyId: f.companyId,
    accountId: account.id,
    gmailThreadId: "thread",
    subject: "Checkout is broken",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: f.employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  const instruction = "Review incoming code issues.";
  const rule = await insert(MailRule, {
    companyId: f.companyId,
    accountId: account.id,
    name: "Support",
    actionsJson: JSON.stringify([
      { type: "handToEmployee", employeeId: f.employee.id, mode: "reply", instruction },
    ]),
  });
  const handover = await insert(MailHandover, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    employeeId: f.employee.id,
    sourceKind: "rule",
    ruleId: rule.id,
    mode: "reply",
    instruction,
  });
  const request = {
    ...f.request,
    origin: {
      mailThreadId: thread.id,
      mailHandoverId: handover.id,
      mailDeliveryMode: "review" as const,
    },
  };
  const approval = await createProactiveWorkApproval(request);
  await AppDataSource.getRepository(MailRule).update({ id: rule.id }, { enabled: false });
  const result = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: approval.id,
    userId: f.member.id,
    execute: (row) => executeProactiveWorkApproval(row, async () => assert.fail("Rule disabled")),
  });
  assert.match(
    result.outcome === "decided" ? (result.sideEffectError ?? "") : "",
    /rule was disabled/,
  );
});

test("approved Rule triage preserves its filing-only delivery ceiling", async () => {
  const f = await fixture();
  const account = await insert(MailAccount, {
    companyId: f.companyId,
    connectionId: "connection",
    address: "triage@example.test",
  });
  const thread = await insert(MailThread, {
    companyId: f.companyId,
    accountId: account.id,
    gmailThreadId: "triage-thread",
    subject: "Newsletter",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: f.employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  const instruction = "File newsletters as read and archived.";
  const rule = await insert(MailRule, {
    companyId: f.companyId,
    accountId: account.id,
    name: "Newsletter triage",
    actionsJson: JSON.stringify([
      { type: "handToEmployee", employeeId: f.employee.id, mode: "triage", instruction },
    ]),
  });
  const handover = await insert(MailHandover, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    employeeId: f.employee.id,
    sourceKind: "rule",
    ruleId: rule.id,
    mode: "triage",
    instruction,
  });
  const approval = await createProactiveWorkApproval({
    ...f.request,
    title: "File the newsletter",
    context: "A configured Rule matched a newsletter.",
    plan: "Mark this exact thread read and archive it.",
    origin: {
      mailThreadId: thread.id,
      mailHandoverId: handover.id,
      mailDeliveryMode: "triage",
    },
  });
  const result = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: approval.id,
    userId: f.member.id,
    execute: (row) =>
      executeProactiveWorkApproval(
        row,
        async (_companyId, _employeeId, _prompt, _files, options) => {
          assert.equal(options?.mailDeliveryMode, "triage");
          return {
            status: "ok",
            stopReason: "end_turn",
            reply: "Filed the approved thread without composing mail.",
            attachmentIds: [],
            sidecars: {},
          };
        },
      ),
  });
  assert.equal(result.outcome === "decided" && result.approval.status, "approved");
});

test("pre-upgrade handover reviews still run, while a revision upgrades them to review mode", async () => {
  const f = await fixture();
  const account = await insert(MailAccount, {
    companyId: f.companyId,
    connectionId: "connection",
    address: "support@example.test",
    status: "active",
  });
  const thread = await insert(MailThread, {
    companyId: f.companyId,
    accountId: account.id,
    gmailThreadId: "legacy-thread",
    subject: "Legacy customer report",
  });
  const legacyMessage = await insert(MailMessage, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "legacy-message",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "customer@example.test",
    toEmails: account.address,
    subject: thread.subject,
    bodyText: "The export button is broken.",
    labelIds: " INBOX ",
    sentAt: new Date("2026-09-01T09:00:00.000Z"),
    createdAt: new Date("2026-09-01T09:00:00.000Z"),
    updatedAt: new Date("2026-09-01T09:00:00.000Z"),
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: f.employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  const instruction = "Review customer product issues.";
  const rule = await insert(MailRule, {
    companyId: f.companyId,
    accountId: account.id,
    name: "Legacy support",
    actionsJson: JSON.stringify([
      { type: "handToEmployee", employeeId: f.employee.id, mode: "work", instruction },
    ]),
  });
  const handover = await insert(MailHandover, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    employeeId: f.employee.id,
    sourceKind: "rule",
    ruleId: rule.id,
    mode: "work",
    instruction,
  });
  const origin = {
    mailThreadId: thread.id,
    mailHandoverId: handover.id,
    mailDeliveryMode: "draft" as const,
  };
  const sourceFingerprint = digest([
    f.employee.id,
    {
      handoverId: handover.id,
      ruleId: rule.id,
      sourceKind: handover.sourceKind,
      instruction,
      mode: handover.mode,
    },
    { threadId: thread.id, accountId: account.id },
  ]);
  const insertLegacy = (title: string, requestedAt = new Date("2026-09-01T09:30:00.000Z")) =>
    insert(Approval, {
      companyId: f.companyId,
      employeeId: f.employee.id,
      kind: "proactive_work",
      routineId: "",
      status: "pending",
      requestedAt,
      title,
      summary: "Legacy customer evidence\n\nProposed work\nInvestigate the reported issue.",
      payloadJson: JSON.stringify({
        version: 1,
        title,
        context: "Legacy customer evidence",
        plan: "Investigate the reported issue.",
        origin,
        sourceFingerprint,
        dedupeKey: digest([null, thread.id, title, "Investigate the reported issue."]),
      }),
    });

  const untouched = await insertLegacy("Investigate the legacy report");
  const executed = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: untouched.id,
    userId: f.member.id,
    execute: (row) =>
      executeProactiveWorkApproval(
        row,
        async (_companyId, _employeeId, _prompt, _files, options) => {
          assert.equal(options?.mailDeliveryMode, "review");
          return {
            status: "ok",
            stopReason: "end_turn",
            reply: "Investigated the issue and prepared the result for review.",
            attachmentIds: [],
            sidecars: {},
          };
        },
      ),
  });
  assert.equal(executed.outcome === "decided" && executed.approval.status, "approved");

  await AppDataSource.getRepository(MailMessage).update(
    { id: legacyMessage.id },
    { labelIds: " INBOX STARRED " },
  );
  const labelUpdated = await AppDataSource.getRepository(MailMessage).findOneByOrFail({
    id: legacyMessage.id,
  });
  assert.ok(labelUpdated.updatedAt.getTime() > untouched.requestedAt.getTime());
  assert.ok(labelUpdated.createdAt.getTime() < untouched.requestedAt.getTime());
  const suppressedAfterLabelOnlyUpdate = await createProactiveWorkApproval({
    ...f.request,
    title: "Repeat after the customer email was starred",
    context: "Only the existing customer's mailbox labels changed.",
    plan: "Repeat the work already approved for the unchanged customer evidence.",
    origin: { ...origin, mailDeliveryMode: "review" },
  });
  assert.equal(suppressedAfterLabelOnlyUpdate.id, untouched.id);

  await insert(MailMessage, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "legacy-sent-mirror",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: account.address,
    toEmails: "customer@example.test",
    subject: thread.subject,
    bodyText: "We investigated the export failure.",
    labelIds: " SENT ",
    sentAt: new Date("2026-09-01T10:00:00.000Z"),
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z"),
  });
  const suppressedAfterSent = await createProactiveWorkApproval({
    ...f.request,
    title: "Repeat the legacy investigation",
    context: "Only our own sent mirror changed the email thread.",
    plan: "Repeat the work already approved for the unchanged customer evidence.",
    origin: { ...origin, mailDeliveryMode: "review" },
  });
  assert.equal(suppressedAfterSent.id, untouched.id);

  await insert(MailMessage, {
    companyId: f.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "legacy-customer-update",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "customer@example.test",
    toEmails: account.address,
    subject: thread.subject,
    bodyText: "The same export failure now affects PDF exports too.",
    labelIds: " INBOX ",
    sentAt: new Date("2026-09-01T11:00:00.000Z"),
    createdAt: new Date("2026-09-01T11:00:00.000Z"),
    updatedAt: new Date("2026-09-01T11:00:00.000Z"),
  });
  const rearmedByInbound = await createProactiveWorkApproval({
    ...f.request,
    title: "Review the customer's export update",
    context: "The customer added new evidence about PDF exports.",
    plan: "Investigate the new PDF-export evidence and leave the result for review.",
    origin: { ...origin, mailDeliveryMode: "review" },
  });
  assert.notEqual(rearmedByInbound.id, untouched.id);

  const toRevise = await insertLegacy(
    "Refine the legacy investigation",
    new Date(labelUpdated.updatedAt.getTime() + 60_000),
  );
  const revised = await reviseProactiveWorkApproval({
    companyId: f.companyId,
    employeeId: f.employee.id,
    approvalId: toRevise.id,
    expectedRevision: proactiveWorkReviewDetails(toRevise)!.revision,
    plan: "Investigate the narrow export failure and leave the verified result for review.",
  });
  assert.ok(revised);
  const revisedPayload = parseProactiveWorkPayload(revised.payloadJson);
  assert.equal(revisedPayload.origin.mailDeliveryMode, "review");
  assert.match(revisedPayload.inboundEvidenceFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.match(revisedPayload.revision ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(revisedPayload.sourceFingerprint, sourceFingerprint);
});

test("review history is bounded and redacted; expired work is failed without replay", async () => {
  const f = await fixture();
  const approval = await createProactiveWorkApproval({
    ...f.request,
    context: "Customer sent password=secret-value alongside the report.",
  });
  assert.doesNotMatch(approval.summary!, /secret-value/);
  await AppDataSource.getRepository(Approval).update(
    { id: approval.id },
    {
      status: "executing",
      decidedAt: new Date(Date.now() - CHAT_HARD_TIMEOUT_MS - 11 * 60_000),
      decidedByUserId: f.member.id,
    },
  );
  await reconcileProactiveWorkApprovals(f.companyId);
  const history = await listProactiveWorkReviews({
    companyId: f.companyId,
    employeeId: f.employee.id,
  });
  assert.equal(history[0].status, "execution_failed");
  assert.ok(history[0].summary.length <= 500);
  assert.equal("payloadJson" in history[0], false);
  assert.doesNotMatch(JSON.stringify(history), /secret-value/);
});

test("reconciliation expires a pending work review after its source changes", async () => {
  const f = await fixture();
  const approval = await createProactiveWorkApproval(f.request);

  await reconcileProactiveWorkApprovals(f.companyId);
  assert.equal(
    (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id })).status,
    "pending",
  );

  f.routine.body = "Review current customer issues under the revised operating procedure.";
  await AppDataSource.getRepository(Routine).save(f.routine);
  await reconcileProactiveWorkApprovals(f.companyId);

  const expired = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
  assert.equal(expired.status, "expired");
  assert.equal(expired.decidedAt, null);
  assert.equal(expired.resultJson, null);
});

test("reconciliation preserves pending work when source lookup infrastructure fails", async () => {
  const f = await fixture();
  const approval = await createProactiveWorkApproval(f.request);
  const employeeRepo = AppDataSource.getRepository(AIEmployee);
  const findOneBy = employeeRepo.findOneBy.bind(employeeRepo);
  const unavailable = new Error("database unavailable");
  employeeRepo.findOneBy = async () => {
    throw unavailable;
  };
  try {
    await assert.rejects(reconcileProactiveWorkApprovals(f.companyId), (error) => {
      assert.equal(error, unavailable);
      return true;
    });
  } finally {
    employeeRepo.findOneBy = findOneBy;
  }
  assert.equal(
    (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id })).status,
    "pending",
  );
});

test("an interrupted approved session reports partial work without claiming completion", async () => {
  const f = await fixture();
  const account = await insert(MailAccount, {
    companyId: f.companyId,
    connectionId: "connection",
    address: "team@example.test",
  });
  const thread = await insert(MailThread, {
    companyId: f.companyId,
    accountId: account.id,
    gmailThreadId: "thread",
    subject: "Checkout issue",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: f.employee.id,
    accountId: account.id,
    accessLevel: "send",
  });
  const approval = await createProactiveWorkApproval({
    ...f.request,
    origin: { mailThreadId: thread.id, mailDeliveryMode: "draft" },
  });
  const result = await approvePendingApproval({
    companyId: f.companyId,
    approvalId: approval.id,
    userId: f.member.id,
    execute: (row) =>
      executeProactiveWorkApproval(row, async () => ({
        status: "ok",
        stopReason: "max_steps",
        reply: "Prepared one file; the checks have not run. token=private-value",
        attachmentIds: [],
        sidecars: {},
      })),
  });
  assert.equal(result.outcome === "decided" && result.approval.status, "execution_failed");
  if (result.outcome !== "decided") assert.fail("Expected a durable work outcome");
  assert.match(proactiveWorkOutcomeSummary(result.approval)!, /checks have not run/);
  assert.doesNotMatch(proactiveWorkOutcomeSummary(result.approval)!, /private-value/);
});
