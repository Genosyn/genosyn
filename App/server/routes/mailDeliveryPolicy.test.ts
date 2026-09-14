import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { Project } from "../db/entities/Project.js";
import { Routine } from "../db/entities/Routine.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import type { MailDeliveryMode } from "../services/mail/deliveryPolicy.js";
import { createMailReviewApproval, mailReviewDetails } from "../services/mail/reviewApprovals.js";
import {
  createProactiveWorkApproval,
  proactiveWorkReviewDetails,
} from "../services/proactive/approvals.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let url = "";
let token = "";
let employee: AIEmployee;
let company: Company;
let account: MailAccount;
before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mcp`;
});
beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, {
    name: "Draft Company",
    slug: "draft-company",
    ownerId: "owner",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Morgan",
    slug: "morgan",
    role: "Support",
    soulBody: "",
  });
  await insert(IntegrationConnection, {
    id: "connection",
    companyId: company.id,
    provider: "google",
    label: "Team inbox",
    authMode: "oauth2",
    encryptedConfig: "unused-in-this-test",
    accountHint: "team@example.com",
    status: "connected",
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    address: "team@example.com",
    connectionId: "connection",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "send",
  });
  token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    mailDeliveryMode: "draft",
  });
});
after(async () => {
  revokeMcpToken(token);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});
afterEach(() => mock.restoreAll());

function setDeliveryMode(mode: MailDeliveryMode | null) {
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    ...(mode ? { mailDeliveryMode: mode } : {}),
  });
}

async function call(tool: string, body: unknown) {
  const response = await fetch(`${url}/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}

async function useMemberAuthority(role: "owner" | "admin" | "member") {
  const user = await insert(User, {
    email: `${role}@review-authority.example.test`,
    passwordHash: "hash",
    name: `${role} reviewer`,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: user.id,
    role,
    financeAccess: "full",
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: user.id,
    requesterSessionVersion: user.sessionVersion,
  });
  return user;
}

describe("server enforced mail delivery ceiling", () => {
  for (const mode of ["draft", "triage", "reply", null] as const) {
    test(`${mode ?? "ordinary"} turns save Todos with the correct Pipeline follow-on authority`, async () => {
      setDeliveryMode(mode);
      const project = await insert(Project, {
        companyId: company.id,
        name: "Customer follow-up",
        slug: "follow-up",
        key: "FOLLOW",
      });
      // Observe the actual event-dispatch boundary without starting an unrelated
      // Pipeline. The restricted branch must never even discover workers.
      const pipelineReads = mock.method(
        AppDataSource.getRepository(Pipeline),
        "findBy",
        async () => [],
      );
      const result = await call("create_todo", {
        projectSlug: project.slug,
        title: "Prepare a customer follow-up",
        description: "Review the saved draft with the customer context.",
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const todo = await AppDataSource.getRepository(Todo).findOneByOrFail({
        projectId: project.id,
      });
      assert.equal(todo.assigneeEmployeeId, employee.id);
      assert.equal(todo.description, "Review the saved draft with the customer context.");
      // Fire-and-forget dispatch performs a few database reads first.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(pipelineReads.mock.callCount(), mode === "reply" || mode === null ? 1 : 0);
    });

    test(`${mode ?? "ordinary"} turns retain review status without starting an unauthorized reviewer`, async () => {
      setDeliveryMode(mode);
      const project = await insert(Project, {
        companyId: company.id,
        name: "Customer follow-up",
        slug: "follow-up",
        key: "FOLLOW",
      });
      const reviewer = await insert(AIEmployee, {
        companyId: company.id,
        name: "Reviewer",
        slug: "reviewer",
        role: "Review",
        soulBody: "",
      });
      const todo = await insert(Todo, {
        projectId: project.id,
        number: 1,
        title: "Check the draft",
        assigneeEmployeeId: employee.id,
        reviewerEmployeeId: reviewer.id,
      });
      // A real kickoff resolves the reviewer's model; returning no models
      // makes the permitted control path finish without an external call.
      const modelReads = mock.method(AppDataSource.getRepository(AIModel), "find", async () => []);
      const result = await call("update_todo", { todoId: todo.id, status: "in_review" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(
        (await AppDataSource.getRepository(Todo).findOneByOrFail({ id: todo.id })).status,
        "in_review",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(modelReads.mock.callCount(), mode === "reply" || mode === null ? 1 : 0);
    });
  }

  test("a Send-granted employee cannot send drafts, replies, fresh mail or Finance mail from a preparation turn", async () => {
    for (const body of [
      { draftMessageId: "draft" },
      { threadId: "thread", bodyText: "reply" },
      { to: "any@example.com", subject: "new", bodyText: "new", mailDeliveryMode: "reply" },
    ]) {
      const result = await call("send_mail", body);
      assert.equal(result.status, 403);
      assert.match(result.body.error!, /request_mail_review/);
    }
    for (const name of ["send_invoice", "send_signature_envelope", "remind_signature_recipient"]) {
      assert.equal((await call(name, {})).status, 403, name);
    }
  });

  test("a legacy draft token can create only a Decision-stack email review", async () => {
    for (const tool of ["create_mail_draft", "edit_mail_draft"]) {
      const result = await call(tool, {});
      assert.equal(result.status, 403);
      assert.match(result.body.error!, /Decision stack/);
    }
    const result = await call("request_mail_review", {
      accountId: account.id,
      to: "customer@example.test",
      subject: "Reviewed update",
      context: "A legacy Routine prepared an update.",
      bodyText: "This exists only in the Decision stack.",
    });
    assert.equal(result.status, 200, result.body.error);
    assert.equal(
      await AppDataSource.getRepository(Approval).countBy({
        companyId: company.id,
        kind: "mail_send",
      }),
      1,
    );
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 0);
  });

  test("triage is enforced before native draft handlers and request parameters cannot raise it", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailDeliveryMode: "triage",
    });
    for (const name of [
      "create_mail_draft",
      "edit_mail_draft",
      "request_mail_review",
      "revise_mail_review",
    ]) {
      const result = await call(name, { bodyText: "send this", mailDeliveryMode: "reply" });
      assert.equal(result.status, 403);
      assert.match(result.body.error!, /triage only/);
    }
  });

  test("a triage token reaches the filing seam only with a Draft Grant", async () => {
    const thread = await insert(MailThread, {
      companyId: company.id,
      accountId: account.id,
      gmailThreadId: "triage-grant-thread",
      subject: "Newsletter",
    });
    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { employeeId: employee.id, accountId: account.id },
      { accessLevel: "read" },
    );
    setDeliveryMode("triage");
    const readOnly = await call("update_mail_thread", { threadId: thread.id });
    assert.equal(readOnly.status, 403);
    assert.match(readOnly.body.error ?? "", /needs the "draft" access level/);

    await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
      { employeeId: employee.id, accountId: account.id },
      { accessLevel: "draft" },
    );
    const draftGranted = await call("update_mail_thread", { threadId: thread.id });
    assert.equal(draftGranted.status, 400);
    assert.match(draftGranted.body.error ?? "", /Nothing to do/);
  });

  test("review mode holds a fresh outbound compose without creating a mailbox draft", async () => {
    setDeliveryMode("review");
    const result = await call("request_mail_review", {
      accountId: account.id,
      to: "customer@example.test",
      cc: "owner@example.test",
      subject: "Your requested update",
      context: "The customer is due a scheduled update.",
      bodyText: "Here is the requested update.",
    });
    assert.equal(result.status, 200, result.body.error);
    const approval = await AppDataSource.getRepository(Approval).findOneByOrFail({
      companyId: company.id,
      kind: "mail_send",
    });
    const review = mailReviewDetails(approval)!;
    assert.equal(review.source.accountId, account.id);
    assert.equal(review.source.threadId, null);
    assert.deepEqual(review.draft, {
      to: "customer@example.test",
      cc: "owner@example.test",
      bcc: "",
      subject: "Your requested update",
      bodyText: "Here is the requested update.",
    });
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 0);
  });

  test("restricted turns cannot export authority to separate automation", async () => {
    for (const name of [
      "schedule_wakeup",
      "create_routine",
      "create_handoff",
      "run_pipeline",
      "enroll_in_sequence",
    ]) {
      const result = await call(name, {});
      assert.equal(result.status, 403, name);
      assert.match(result.body.error!, /separate automation|delegate/);
    }
  });

  test("reply mode permits a direct send but never creates a provider draft", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailDeliveryMode: "reply",
    });
    assert.equal((await call("send_mail", { injected: "bad" })).status, 400);
    for (const tool of ["create_mail_draft", "edit_mail_draft"]) {
      const result = await call(tool, {});
      assert.equal(result.status, 403);
      assert.match(result.body.error!, /must not create/i);
    }
  });

  test("sender tools cannot be steered to a different email from a bound handover", async () => {
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailDeliveryMode: "draft",
      mailThreadId: "00000000-0000-4000-8000-000000000001",
    });
    for (const tool of ["mail_block_sender", "mail_unsubscribe"]) {
      const result = await call(tool, { threadId: "00000000-0000-4000-8000-000000000002" });
      assert.equal(result.status, 403);
      assert.match(result.body.error!, /own email thread/);
    }
  });

  test("email review revisions require exact mail provenance or an owner/admin discussion", async () => {
    const thread = await insert(MailThread, {
      companyId: company.id,
      accountId: account.id,
      gmailThreadId: "review-thread",
      subject: "Customer issue",
    });
    await insert(MailMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: "review-message",
      gmailThreadId: thread.gmailThreadId,
      fromEmail: "customer@example.test",
      toEmails: account.address,
      subject: thread.subject,
      bodyText: "Please take another look.",
      sentAt: new Date(),
    });
    const created = await createMailReviewApproval({
      companyId: company.id,
      employeeId: employee.id,
      threadId: thread.id,
      context: "The customer asked for another look.",
      bodyText: "Thanks. We are reviewing this now.",
    });

    await useMemberAuthority("owner");
    let result = await call("revise_mail_review", {
      approvalId: created.approval.id,
      expectedRevision: mailReviewDetails(created.approval)!.revision,
      bodyText: "Thanks. We reviewed this and have an update.",
    });
    assert.equal(result.status, 403);

    let current = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: created.approval.id,
    });
    assert.equal(mailReviewDetails(current)?.draft.bodyText, "Thanks. We are reviewing this now.");
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    result = await call("revise_mail_review", {
      approvalId: created.approval.id,
      expectedRevision: mailReviewDetails(current)!.revision,
      bodyText: "An ambient employee turn must not replace the review.",
    });
    assert.equal(result.status, 403);

    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailDeliveryMode: "review",
      mailThreadId: thread.id,
    });
    result = await call("revise_mail_review", {
      approvalId: created.approval.id,
      expectedRevision: mailReviewDetails(current)!.revision,
      bodyText: "The bound email work may revise its own exact review.",
    });
    assert.equal(result.status, 200, result.body.error);

    current = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: created.approval.id,
    });
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      mailDeliveryMode: "review",
      mailThreadId: thread.id,
      mailHandoverId: "00000000-0000-4000-8000-000000000099",
    });
    result = await call("revise_mail_review", {
      approvalId: created.approval.id,
      expectedRevision: mailReviewDetails(current)!.revision,
      bodyText: "A different handover must not revise this review.",
    });
    assert.equal(result.status, 409);

    await useMemberAuthority("member");
    result = await call("revise_mail_review", {
      approvalId: created.approval.id,
      expectedRevision: mailReviewDetails(current)!.revision,
      bodyText: "A regular Member discussion must not revise this review.",
    });
    assert.equal(result.status, 403);
  });

  test("work review revisions require a live owner/admin Member discussion", async () => {
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Review customer follow-up",
      slug: "review-customer-follow-up",
      cronExpr: "0 9 * * 1",
      body: "Review the customer follow-up.",
    });
    const approval = await createProactiveWorkApproval({
      companyId: company.id,
      employeeId: employee.id,
      title: "Follow up with the customer",
      context: "The customer needs an update.",
      plan: "Verify the fix and prepare a reviewed reply.",
      origin: { routineId: routine.id },
    });

    await useMemberAuthority("admin");
    let result = await call("revise_work_review", {
      approvalId: approval.id,
      expectedRevision: proactiveWorkReviewDetails(approval)!.revision,
      plan: "Verify the fix, document the result, and prepare a reviewed reply.",
    });
    assert.equal(result.status, 403);

    const current = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
    });
    assert.equal(
      proactiveWorkReviewDetails(current)?.plan,
      "Verify the fix and prepare a reviewed reply.",
    );
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    result = await call("revise_work_review", {
      approvalId: approval.id,
      expectedRevision: proactiveWorkReviewDetails(current)!.revision,
      plan: "Ambient employee rewrite.",
    });
    assert.equal(result.status, 403);

    await useMemberAuthority("member");
    result = await call("revise_work_review", {
      approvalId: approval.id,
      expectedRevision: proactiveWorkReviewDetails(current)!.revision,
      plan: "Regular Member rewrite.",
    });
    assert.equal(result.status, 403);
  });
});
