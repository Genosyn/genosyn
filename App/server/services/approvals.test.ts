import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../test/dbHarness.js";
import {
  approvalArgsPreview,
  approvePendingApproval,
  browserApprovalWasExecuted,
  claimApprovedBrowserAction,
  completeClaimedBrowserAction,
  createBrowserActionApproval,
  rejectPendingApproval,
} from "./approvals.js";
import { notifyApprovalPending } from "./notifications.js";

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

async function pendingApproval(companyId = testCompanyId()): Promise<Approval> {
  return insert(Approval, {
    companyId,
    kind: "browser_action",
    routineId: "",
    employeeId: testId("employee"),
    title: "Submit the form",
    summary: "Send the reviewed form",
    payloadJson: "{}",
    resultJson: null,
    errorMessage: null,
    status: "pending",
    decidedAt: null,
    decidedByUserId: null,
  });
}

async function approvedBrowserApproval(companyId = testCompanyId()): Promise<Approval> {
  return insert(Approval, {
    companyId,
    kind: "browser_action",
    routineId: "",
    employeeId: testId("employee"),
    title: "Submit the form",
    summary: "Send the reviewed form",
    payloadJson: JSON.stringify({
      selector: "aria-ref=e7",
      key: null,
      pageUrl: "https://example.test/checkout?step=review",
    }),
    resultJson: null,
    errorMessage: null,
    status: "approved",
    decidedAt: new Date(),
    decidedByUserId: testId("reviewer"),
  });
}

async function auditRows(companyId: string): Promise<AuditEvent[]> {
  return AppDataSource.getRepository(AuditEvent).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
}

describe("approval decision claims", () => {
  test("MCP argument previews redact nested and inline credentials", () => {
    const preview = approvalArgsPreview({
      apiKey: "top-secret-api-key",
      headers: {
        Authorization: "Bearer top-secret-bearer",
        accept: "application/json",
      },
      nested: [{ refresh_token: "top-secret-refresh" }],
      url: "https://example.test/callback?code=top-secret-code&view=summary",
      safe: "visible",
    });

    assert.doesNotMatch(
      preview,
      /top-secret-api-key|top-secret-bearer|top-secret-refresh|top-secret-code/,
    );
    assert.match(preview, /\[redacted\]/);
    assert.match(preview, /application\/json/);
    assert.match(preview, /visible/);
  });

  test("browser approval and notification storage redact model and legacy credential copy", async () => {
    const owner = await insert(User, {
      email: "owner@example.test",
      passwordHash: "x",
      name: "Owner",
    });
    const company = await insert(Company, {
      name: "Acme",
      slug: `acme-${testId("slug")}`,
      ownerId: owner.id,
    });
    await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Operator",
      slug: "operator",
      role: "Operations",
    });

    const newSecrets = [
      "new-api-secret",
      "nested-password-secret",
      "page-user",
      "page-password",
      "page-token-secret",
      "fragment-secret",
    ];
    const created = await createBrowserActionApproval({
      companyId: company.id,
      employeeId: employee.id,
      selector: "aria-ref=e9",
      key: null,
      summary: JSON.stringify({
        apiKey: newSecrets[0],
        nested: { password: newSecrets[1] },
        action: "Submit the reviewed checkout",
      }),
      pageUrl:
        `https://${newSecrets[2]}:${newSecrets[3]}@shop.example.test/checkout` +
        `?step=review&access_token=${newSecrets[4]}#access_token=${newSecrets[5]}`,
    });

    const storedCopy = `${created.title ?? ""}\n${created.summary ?? ""}`;
    for (const secret of newSecrets) assert.doesNotMatch(storedCopy, new RegExp(secret));
    assert.match(storedCopy, /\[redacted\]|%5Bredacted%5D/);
    assert.match(storedCopy, /Submit the reviewed checkout/);

    let createdNotifications: Notification[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      createdNotifications = await AppDataSource.getRepository(Notification).find({
        where: { entityId: created.id },
      });
      if (createdNotifications.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(createdNotifications.length, 1);
    const createdNotificationCopy = createdNotifications
      .map((row) => `${row.title}\n${row.body}`)
      .join("\n");
    for (const secret of newSecrets) {
      assert.doesNotMatch(createdNotificationCopy, new RegExp(secret));
    }

    const legacySecrets = [
      "legacy-bearer-secret",
      "legacy-user",
      "legacy-password",
      "legacy-refresh-secret",
      "legacy-query-secret",
    ];
    const legacy = await insert(Approval, {
      companyId: company.id,
      kind: "browser_action",
      routineId: "",
      employeeId: employee.id,
      status: "pending",
      title:
        `Submit with Bearer ${legacySecrets[0]} at ` +
        `https://${legacySecrets[1]}:${legacySecrets[2]}@legacy.example.test/confirm`,
      summary: JSON.stringify({
        nested: { refresh_token: legacySecrets[3] },
        url: `https://legacy.example.test/confirm?code=${legacySecrets[4]}&view=review`,
      }),
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      decidedAt: null,
      decidedByUserId: null,
    });

    await notifyApprovalPending(legacy);
    const legacyNotifications = await AppDataSource.getRepository(Notification).find({
      where: { entityId: legacy.id },
    });
    assert.equal(legacyNotifications.length, 1);
    const legacyNotificationCopy = legacyNotifications
      .map((row) => `${row.title}\n${row.body}`)
      .join("\n");
    for (const secret of legacySecrets) {
      assert.doesNotMatch(legacyNotificationCopy, new RegExp(secret));
    }
    assert.match(legacyNotificationCopy, /\[redacted\]|%5Bredacted%5D/);
  });

  test("twenty concurrent approvals invoke the downstream action exactly once", async () => {
    const approval = await pendingApproval();
    const reviewerId = testId("reviewer");
    let executions = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        approvePendingApproval({
          companyId: approval.companyId,
          approvalId: approval.id,
          userId: reviewerId,
          execute: async () => {
            executions += 1;
            await Promise.resolve();
          },
        }),
      ),
    );

    assert.equal(results.filter((result) => result.outcome === "decided").length, 1);
    assert.equal(results.filter((result) => result.outcome === "conflict").length, 19);
    assert.equal(executions, 1);

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(stored.status, "approved");
    assert.equal(stored.decidedByUserId, reviewerId);
    assert.ok(stored.decidedAt instanceof Date);

    const events = await auditRows(approval.companyId);
    assert.deepEqual(
      events.map((event) => event.action),
      ["approval.approve"],
    );
    assert.equal(events[0].actorUserId, reviewerId);
  });

  test("twenty concurrent rejections record the rejection hook exactly once", async () => {
    const approval = await pendingApproval();
    const reviewerId = testId("reviewer");
    let rejectionRecords = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rejectPendingApproval({
          companyId: approval.companyId,
          approvalId: approval.id,
          userId: reviewerId,
          recordRejection: async () => {
            rejectionRecords += 1;
            await Promise.resolve();
          },
        }),
      ),
    );

    assert.equal(results.filter((result) => result.outcome === "decided").length, 1);
    assert.equal(results.filter((result) => result.outcome === "conflict").length, 19);
    assert.equal(rejectionRecords, 1);

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(stored.status, "rejected");
    assert.equal(stored.decidedByUserId, reviewerId);
    assert.deepEqual(
      (await auditRows(approval.companyId)).map((event) => event.action),
      ["approval.reject"],
    );
  });

  test("a simultaneous approve/reject race has one winner and one side effect", async () => {
    const approval = await pendingApproval();
    let executions = 0;
    let rejectionRecords = 0;

    const [approved, rejected] = await Promise.all([
      approvePendingApproval({
        companyId: approval.companyId,
        approvalId: approval.id,
        userId: "approver",
        execute: async () => {
          executions += 1;
        },
      }),
      rejectPendingApproval({
        companyId: approval.companyId,
        approvalId: approval.id,
        userId: "rejector",
        recordRejection: async () => {
          rejectionRecords += 1;
        },
      }),
    ]);

    assert.equal([approved, rejected].filter((result) => result.outcome === "decided").length, 1);
    assert.equal([approved, rejected].filter((result) => result.outcome === "conflict").length, 1);
    assert.equal(executions + rejectionRecords, 1);

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.ok(stored.status === "approved" || stored.status === "rejected");
    assert.equal(executions, stored.status === "approved" ? 1 : 0);
    assert.equal(rejectionRecords, stored.status === "rejected" ? 1 : 0);
    assert.equal((await auditRows(approval.companyId)).length, 1);
  });

  test("execution failure is terminal and cannot replay the downstream action", async () => {
    const approval = await pendingApproval();
    let executions = 0;
    const execute = async () => {
      executions += 1;
      throw new Error("provider timed out after accepting the request");
    };

    const first = await approvePendingApproval({
      companyId: approval.companyId,
      approvalId: approval.id,
      userId: "reviewer",
      execute,
    });
    assert.equal(first.outcome, "decided");
    if (first.outcome !== "decided") assert.fail("expected a recorded decision");
    assert.equal(first.approval.status, "execution_failed");
    assert.equal(first.sideEffectError, "provider timed out after accepting the request");

    const duplicate = await approvePendingApproval({
      companyId: approval.companyId,
      approvalId: approval.id,
      userId: "reviewer",
      execute,
    });
    assert.equal(duplicate.outcome, "conflict");
    assert.equal(executions, 1);

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(stored.status, "execution_failed");
    assert.equal(stored.errorMessage, "provider timed out after accepting the request");
    assert.deepEqual(
      (await auditRows(approval.companyId)).map((event) => event.action),
      ["approval.approve", "approval.execute_failed"],
    );
  });

  test("a company mismatch is not found and never invokes a side effect", async () => {
    const approval = await pendingApproval();
    let executions = 0;

    const result = await approvePendingApproval({
      companyId: testCompanyId(),
      approvalId: approval.id,
      userId: "reviewer",
      execute: async () => {
        executions += 1;
      },
    });

    assert.equal(result.outcome, "not_found");
    assert.equal(executions, 0);
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id })).status,
      "pending",
    );
  });

  test("a rejection-recording failure stays rejected and is not retried", async () => {
    const approval = await pendingApproval();
    let attempts = 0;
    const recordRejection = async () => {
      attempts += 1;
      throw new Error("journal unavailable");
    };

    const first = await rejectPendingApproval({
      companyId: approval.companyId,
      approvalId: approval.id,
      userId: "reviewer",
      recordRejection,
    });
    assert.equal(first.outcome, "decided");
    if (first.outcome !== "decided") assert.fail("expected a recorded decision");
    assert.equal(first.approval.status, "rejected");
    assert.equal(first.sideEffectError, "journal unavailable");

    const duplicate = await rejectPendingApproval({
      companyId: approval.companyId,
      approvalId: approval.id,
      userId: "reviewer",
      recordRejection,
    });
    assert.equal(duplicate.outcome, "conflict");
    assert.equal(attempts, 1);
    assert.deepEqual(
      (await auditRows(approval.companyId)).map((event) => event.action),
      ["approval.reject", "approval.rejection_record_failed"],
    );
  });
});

describe("browser action execution claims", () => {
  test("twenty concurrent browser resumes produce exactly one claim", async () => {
    const approval = await approvedBrowserApproval();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimApprovedBrowserAction({
          companyId: approval.companyId,
          employeeId: approval.employeeId,
          approvalId: approval.id,
        }),
      ),
    );

    const winners = results.filter((result) => result.outcome === "claimed");
    assert.equal(winners.length, 1);
    assert.equal(results.filter((result) => result.outcome === "conflict").length, 19);
    if (winners[0]?.outcome !== "claimed") assert.fail("expected one claim winner");
    assert.equal(winners[0].action.selector, "aria-ref=e7");
    assert.equal(winners[0].action.pageUrl, "https://example.test/checkout?step=review");
    assert.ok(winners[0].claimToken.length >= 32);

    const stored = await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id });
    assert.equal(stored.status, "executing");
    assert.match(stored.resultJson ?? "", /"state":"claimed"/);
    assert.doesNotMatch(stored.resultJson ?? "", new RegExp(winners[0].claimToken));
  });

  test("a successful claim gets a durable receipt and can never be claimed again", async () => {
    const approval = await approvedBrowserApproval();
    const claimed = await claimApprovedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
    });
    assert.equal(claimed.outcome, "claimed");
    if (claimed.outcome !== "claimed") assert.fail("expected claim");

    const wrongToken = await completeClaimedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
      claimToken: "x".repeat(43),
      outcome: "executed",
    });
    assert.equal(wrongToken.outcome, "conflict");
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id })).status,
      "executing",
    );

    const completed = await completeClaimedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
      claimToken: claimed.claimToken,
      outcome: "executed",
    });
    assert.equal(completed.outcome, "completed");
    if (completed.outcome !== "completed") assert.fail("expected completion");
    assert.equal(completed.approval.status, "approved");
    assert.equal(browserApprovalWasExecuted(completed.approval), true);

    const repeatedCompletion = await completeClaimedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
      claimToken: claimed.claimToken,
      outcome: "executed",
    });
    assert.equal(repeatedCompletion.outcome, "already_completed");

    const replay = await claimApprovedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
    });
    assert.equal(replay.outcome, "conflict");
  });

  test("a browser failure is terminal and a retry cannot replay it", async () => {
    const approval = await approvedBrowserApproval();
    const claimed = await claimApprovedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
    });
    assert.equal(claimed.outcome, "claimed");
    if (claimed.outcome !== "claimed") assert.fail("expected claim");

    const failed = await completeClaimedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
      claimToken: claimed.claimToken,
      outcome: "failed",
      errorMessage: "click timed out after dispatch",
    });
    assert.equal(failed.outcome, "completed");
    if (failed.outcome !== "completed") assert.fail("expected terminal failure");
    assert.equal(failed.approval.status, "execution_failed");
    assert.equal(failed.approval.errorMessage, "click timed out after dispatch");
    assert.equal(browserApprovalWasExecuted(failed.approval), false);

    const replay = await claimApprovedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
    });
    assert.equal(replay.outcome, "conflict");
  });

  test("a crash after claim stays executing and is never made replayable", async () => {
    const approval = await approvedBrowserApproval();
    const first = await claimApprovedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
    });
    assert.equal(first.outcome, "claimed");

    // Simulate the MCP child disappearing without a completion callback.
    const afterCrash = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
    });
    assert.equal(afterCrash.status, "executing");

    const laterTurn = await claimApprovedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
    });
    assert.equal(laterTurn.outcome, "conflict");
    assert.equal(
      (await AppDataSource.getRepository(Approval).findOneByOrFail({ id: approval.id })).status,
      "executing",
    );
  });

  test("claiming validates company, employee, payload, and legacy execution receipts", async () => {
    const approval = await approvedBrowserApproval();
    assert.equal(
      (
        await claimApprovedBrowserAction({
          companyId: "another-company",
          employeeId: approval.employeeId,
          approvalId: approval.id,
        })
      ).outcome,
      "not_found",
    );
    assert.equal(
      (
        await claimApprovedBrowserAction({
          companyId: approval.companyId,
          employeeId: "another-employee",
          approvalId: approval.id,
        })
      ).outcome,
      "forbidden",
    );

    approval.payloadJson = "not-json";
    await AppDataSource.getRepository(Approval).save(approval);
    assert.equal(
      (
        await claimApprovedBrowserAction({
          companyId: approval.companyId,
          employeeId: approval.employeeId,
          approvalId: approval.id,
        })
      ).outcome,
      "invalid_payload",
    );

    approval.payloadJson = JSON.stringify({
      selector: "aria-ref=e7",
      key: null,
      pageUrl: "https://example.test/checkout",
      executedAt: new Date().toISOString(),
    });
    await AppDataSource.getRepository(Approval).save(approval);
    const legacyReplay = await claimApprovedBrowserAction({
      companyId: approval.companyId,
      employeeId: approval.employeeId,
      approvalId: approval.id,
    });
    assert.equal(legacyReplay.outcome, "conflict");
    assert.equal(browserApprovalWasExecuted(approval), true);
  });
});
