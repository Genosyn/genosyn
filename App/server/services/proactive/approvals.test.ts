import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Approval } from "../../db/entities/Approval.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
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
  reconcileProactiveWorkApprovals,
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
    /draft-only restriction/,
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
  assert.equal(parseProactiveWorkPayload(triageReview.payloadJson).origin.mailDeliveryMode, "triage");
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
    accessLevel: "send",
  });
  const instruction = "Review incoming code issues.";
  const rule = await insert(MailRule, {
    companyId: f.companyId,
    accountId: account.id,
    name: "Support",
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
  const request = {
    ...f.request,
    origin: {
      mailThreadId: thread.id,
      mailHandoverId: handover.id,
      mailDeliveryMode: "draft" as const,
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
