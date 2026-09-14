import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { listApprovalInbox } from "../services/approvalInbox.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { approvalsRouter } from "./approvals.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let authenticatedAt: number | undefined;
let secondFactorAt: number | undefined;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt,
          secondFactorAt,
        }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", approvalsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

let company: Company;
let otherCompany: Company;
let employee: AIEmployee;
let owner: User;
let admin: User;
let member: User;
let outsider: User;

beforeEach(async () => {
  await resetTestDb();
  owner = await createUser("owner@example.com", "Owner");
  admin = await createUser("admin@example.com", "Admin");
  member = await createUser("member@example.com", "Member");
  outsider = await createUser("outsider@example.com", "Outsider");
  company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: owner.id,
  });
  otherCompany = await insert(Company, {
    name: "Other",
    slug: "other",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  await insert(Membership, {
    companyId: otherCompany.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Operator",
    slug: "operator",
    role: "Operations",
  });
  actingUserId = owner.id;
  authenticatedAt = Date.now();
  secondFactorAt = authenticatedAt;
});

async function createUser(email: string, name: string): Promise<User> {
  return insert(User, {
    email,
    name,
    passwordHash: "x",
    sessionVersion: 0,
  });
}

async function createApproval(overrides: Partial<Approval> = {}): Promise<Approval> {
  return insert(Approval, {
    companyId: company.id,
    kind: "browser_action",
    routineId: "",
    employeeId: employee.id,
    title: "Submit the form",
    summary: "Send reviewed data",
    payloadJson: "{}",
    resultJson: null,
    errorMessage: null,
    status: "pending",
    decidedAt: null,
    decidedByUserId: null,
    ...overrides,
  });
}

function exactMailReviewPayload(content: Buffer) {
  return {
    version: 1,
    accountId: company.id,
    threadId: null,
    mailHandoverId: null,
    context: "A customer asked for the reviewed document.",
    workSummary: "Prepared the exact response and attachment for review.",
    steps: [{ title: "Prepared response", detail: "No mailbox draft was created." }],
    attachments: [
      {
        spec: { resourceSlug: "reviewed-document", format: "original" },
        filename: "reviewed.txt",
        contentType: "text/plain",
        sizeBytes: content.length,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        contentBase64: content.toString("base64"),
      },
    ],
    financeAccessLimit: "full",
    draft: {
      to: "customer@example.test",
      cc: "",
      bcc: "",
      subject: "Your reviewed document",
      bodyText: "Here is the exact document we reviewed.",
    },
    threading: { inReplyTo: null, references: null },
    sourceFingerprint: "1".repeat(64),
    inboundEvidenceVersion: 1,
    inboundEvidenceFingerprint: null,
    messageFingerprint: "2".repeat(64),
    origin: { routineId: null, runId: null, conversationId: null },
    dedupeKey: "3".repeat(64),
  };
}

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(args: {
  method: string;
  approvalId?: string;
  action?: "approve" | "reject";
  direct?: boolean;
  companyId?: string;
  bearerToken?: string;
  query?: string;
}): Promise<ApiResponse<T>> {
  const suffix = args.approvalId
    ? args.direct
      ? `/approvals/${args.approvalId}`
      : `/approvals/${args.approvalId}/${args.action}`
    : "/approvals";
  const response = await fetch(
    `${baseUrl}/api/companies/${args.companyId ?? company.id}${suffix}${args.query ? `?${args.query}` : ""}`,
    {
      method: args.method,
      // Each test rebuilds the in-memory schema, which can exceed Express's
      // keep-alive timeout on a loaded CI worker. Do not let undici race a
      // stale pooled socket when the next case begins.
      headers: {
        connection: "close",
        ...(args.bearerToken ? { authorization: `Bearer ${args.bearerToken}` } : {}),
      },
    },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function apiKeyFor(user: User): Promise<string> {
  const body = "A".repeat(43);
  await insert(ApiKey, {
    companyId: company.id,
    userId: user.id,
    name: "Automation",
    prefix: body.slice(0, 8),
    tokenHash: hashApiToken(body),
    lastUsedAt: new Date(),
    expiresAt: null,
    revokedAt: null,
  });
  return `gen_${body}`;
}

async function storedApproval(id: string): Promise<Approval> {
  return AppDataSource.getRepository(Approval).findOneByOrFail({ id });
}

async function auditActions(): Promise<string[]> {
  return (
    await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id },
      order: { createdAt: "ASC" },
    })
  ).map((event) => event.action);
}

describe("approval route authorization", () => {
  test("the Decision-stack query omits raw bytes while the API returns the complete safe review", async () => {
    const attachment = Buffer.from("exact reviewed attachment bytes");
    const contentBase64 = attachment.toString("base64");
    const approval = await createApproval({
      kind: "mail_send",
      title: "Review customer email",
      payloadJson: JSON.stringify(exactMailReviewPayload(attachment)),
      resultJson: JSON.stringify({
        sentMessageId: null,
        providerMessageRef: "provider-message-ref",
        sentAt: new Date().toISOString(),
      }),
      status: "approved",
      decidedAt: new Date(),
      decidedByUserId: owner.id,
    });

    const listed = await listApprovalInbox(company.id, "decision_stack");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, approval.id);
    // TypeScript class fields may exist as own properties with `undefined`,
    // but TypeORM must not hydrate either large column for this list row.
    assert.equal(listed[0].payloadJson, undefined);
    assert.equal(listed[0].resultJson, undefined);

    const response = await call<
      Array<{
        id: string;
        review: {
          kind: string;
          draft: { subject: string; bodyText: string };
          attachments: Array<{ filename: string; sizeBytes: number }>;
        };
        mailOutcome: { providerMessageRef: string };
      }>
    >({ method: "GET", query: "kind=decision_stack" });

    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
    assert.equal(response.body[0].id, approval.id);
    assert.equal(response.body[0].review.kind, "mail");
    assert.equal(response.body[0].review.draft.subject, "Your reviewed document");
    assert.equal(response.body[0].review.draft.bodyText, "Here is the exact document we reviewed.");
    assert.deepEqual(response.body[0].review.attachments, [
      { index: 0, filename: "reviewed.txt", contentType: "text/plain", sizeBytes: 31 },
    ]);
    assert.equal(response.body[0].mailOutcome.providerMessageRef, "provider-message-ref");
    const serialized = JSON.stringify(response.body);
    assert.doesNotMatch(serialized, /contentBase64/);
    assert.equal(serialized.includes(contentBase64), false);

    const download = await fetch(
      `${baseUrl}/api/companies/${company.id}/approvals/${approval.id}/mail-review/attachments/0`,
      { headers: { connection: "close" } },
    );
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), attachment);
  });

  test("the Other Approvals filter excludes Decision-stack reviews", async () => {
    const ordinary = await createApproval({ title: "Submit the form" });
    await createApproval({
      kind: "proactive_work",
      title: "Review proposed work",
      status: "rejected",
    });
    await createApproval({
      kind: "mail_send",
      title: "Review customer reply",
      status: "rejected",
    });

    const response = await call<Array<{ id: string; kind: string }>>({
      method: "GET",
      query: "kind=other",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.map(({ id, kind }) => ({ id, kind })),
      [{ id: ordinary.id, kind: "browser_action" }],
    );
  });

  test("an admin can resolve one durable Decision-stack review link", async () => {
    const review = await createApproval({
      kind: "proactive_work",
      title: "Investigate the reported failure",
      payloadJson: JSON.stringify({
        version: 1,
        title: "Investigate the reported failure",
        context: "A customer reported a failed request.",
        plan: "Reproduce it, fix it, and verify the result.",
        origin: { routineId: "routine-source" },
        sourceFingerprint: "source-fingerprint",
        dedupeKey: "dedupe-key",
      }),
    });
    const response = await call<{
      id: string;
      kind: string;
      review: { kind: string; context: string };
    }>({
      method: "GET",
      approvalId: review.id,
      direct: true,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.id, review.id);
    assert.equal(response.body.kind, "proactive_work");
    assert.equal(response.body.review.kind, "work");
    assert.equal(response.body.review.context, "A customer reported a failed request.");

    actingUserId = member.id;
    assert.equal(
      (
        await call({
          method: "GET",
          approvalId: review.id,
          direct: true,
        })
      ).status,
      403,
    );
  });

  test("owner and admin browser sessions may decide approvals", async () => {
    const ownerApproval = await createApproval();
    const ownerResponse = await call<{ status: string; decidedByUserId: string }>({
      method: "POST",
      approvalId: ownerApproval.id,
      action: "approve",
    });
    assert.equal(ownerResponse.status, 200);
    assert.equal(ownerResponse.body.status, "approved");
    assert.equal(ownerResponse.body.decidedByUserId, owner.id);

    const adminApproval = await createApproval();
    actingUserId = admin.id;
    const adminResponse = await call<{ status: string; decidedByUserId: string }>({
      method: "POST",
      approvalId: adminApproval.id,
      action: "reject",
    });
    assert.equal(adminResponse.status, 200);
    assert.equal(adminResponse.body.status, "rejected");
    assert.equal(adminResponse.body.decidedByUserId, admin.id);
    assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 1);
  });

  test("an ordinary Member cannot approve or reject and leaves both rows pending", async () => {
    const toApprove = await createApproval();
    const toReject = await createApproval();
    actingUserId = member.id;

    const approve = await call<{ error: string }>({
      method: "POST",
      approvalId: toApprove.id,
      action: "approve",
    });
    const reject = await call<{ error: string }>({
      method: "POST",
      approvalId: toReject.id,
      action: "reject",
    });
    const list = await call({ method: "GET" });

    assert.equal(approve.status, 403);
    assert.equal(reject.status, 403);
    assert.equal(list.status, 403);
    assert.match(approve.body.error, /admin/i);
    assert.equal((await storedApproval(toApprove.id)).status, "pending");
    assert.equal((await storedApproval(toReject.id)).status, "pending");
    assert.deepEqual(await auditActions(), []);
  });

  test("API keys cannot decide approvals even when owned by an owner", async () => {
    const toApprove = await createApproval();
    const toReject = await createApproval();
    const token = await apiKeyFor(owner);
    actingUserId = null;

    const list = await call<{ error: string }>({ method: "GET", bearerToken: token });
    const approve = await call<{ error: string }>({
      method: "POST",
      approvalId: toApprove.id,
      action: "approve",
      bearerToken: token,
    });
    const reject = await call<{ error: string }>({
      method: "POST",
      approvalId: toReject.id,
      action: "reject",
      bearerToken: token,
    });

    assert.equal(list.status, 403);
    assert.match(list.body.error, /browser session/i);
    assert.equal(approve.status, 403);
    assert.equal(reject.status, 403);
    assert.match(approve.body.error, /browser session/i);
    assert.equal((await storedApproval(toApprove.id)).status, "pending");
    assert.equal((await storedApproval(toReject.id)).status, "pending");
  });

  test("the inbox never returns replay payloads, provider results, or raw failures", async () => {
    await createApproval({
      payloadJson: JSON.stringify({ apiKey: "payload-secret" }),
      resultJson: JSON.stringify({ accessToken: "result-secret" }),
      errorMessage: "provider rejected credential raw-secret",
      title: "Submit with Bearer title-secret",
      summary: JSON.stringify({ apiKey: "summary-secret", operation: "deploy" }),
      status: "execution_failed",
      decidedAt: new Date(),
      decidedByUserId: owner.id,
    });

    const response = await call<Array<Record<string, unknown>>>({ method: "GET" });
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
    assert.equal(Object.hasOwn(response.body[0], "payloadJson"), false);
    assert.equal(Object.hasOwn(response.body[0], "resultJson"), false);
    assert.equal(
      response.body[0].errorMessage,
      "The approved action failed. Review the server logs for details.",
    );
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /payload-secret|result-secret|raw-secret|summary-secret|title-secret/,
    );
    assert.match(JSON.stringify(response.body), /\[redacted\]/);
  });

  test("a valid browser session can decide without recent-authentication evidence", async () => {
    const missing = await createApproval();
    authenticatedAt = undefined;
    secondFactorAt = undefined;
    const missingResponse = await call<{ status: string; decidedByUserId: string }>({
      method: "POST",
      approvalId: missing.id,
      action: "approve",
    });
    assert.equal(missingResponse.status, 200);
    assert.equal(missingResponse.body.status, "approved");
    assert.equal(missingResponse.body.decidedByUserId, owner.id);

    const stale = await createApproval();
    authenticatedAt = Date.now() - 16 * 60_000;
    secondFactorAt = authenticatedAt;
    actingUserId = admin.id;
    const staleResponse = await call<{ status: string; decidedByUserId: string }>({
      method: "POST",
      approvalId: stale.id,
      action: "reject",
    });
    assert.equal(staleResponse.status, 200);
    assert.equal(staleResponse.body.status, "rejected");
    assert.equal(staleResponse.body.decidedByUserId, admin.id);
  });

  test("unauthenticated and non-member callers cannot decide", async () => {
    const approval = await createApproval();
    actingUserId = null;
    assert.equal(
      (
        await call({
          method: "POST",
          approvalId: approval.id,
          action: "approve",
        })
      ).status,
      401,
    );

    actingUserId = outsider.id;
    assert.equal(
      (
        await call({
          method: "POST",
          approvalId: approval.id,
          action: "approve",
        })
      ).status,
      403,
    );
    assert.equal((await storedApproval(approval.id)).status, "pending");
  });

  test("an approval id cannot be used through another company", async () => {
    const approval = await createApproval();
    const response = await call({
      method: "POST",
      companyId: otherCompany.id,
      approvalId: approval.id,
      action: "approve",
    });
    assert.equal(response.status, 404);
    assert.equal((await storedApproval(approval.id)).status, "pending");
    assert.deepEqual(await auditActions(), []);
  });
});

describe("approval route race handling", () => {
  test("duplicate sequential approval returns conflict without another audit", async () => {
    const approval = await createApproval();
    const first = await call({ method: "POST", approvalId: approval.id, action: "approve" });
    const duplicate = await call<{ error: string }>({
      method: "POST",
      approvalId: approval.id,
      action: "approve",
    });

    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /already approved/i);
    assert.deepEqual(await auditActions(), ["approval.approve"]);
  });

  test("twelve concurrent approve requests produce one decision", async () => {
    const approval = await createApproval();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        call({ method: "POST", approvalId: approval.id, action: "approve" }),
      ),
    );

    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.equal(responses.filter((response) => response.status === 409).length, 11);
    assert.equal((await storedApproval(approval.id)).status, "approved");
    assert.deepEqual(await auditActions(), ["approval.approve"]);
  });

  test("twelve concurrent reject requests write one journal entry", async () => {
    const approval = await createApproval();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        call({ method: "POST", approvalId: approval.id, action: "reject" }),
      ),
    );

    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.equal(responses.filter((response) => response.status === 409).length, 11);
    assert.equal((await storedApproval(approval.id)).status, "rejected");
    assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 1);
    assert.deepEqual(await auditActions(), ["approval.reject"]);
  });

  test("simultaneous approve and reject requests cannot both win", async () => {
    const approval = await createApproval();
    const responses = await Promise.all([
      call({ method: "POST", approvalId: approval.id, action: "approve" }),
      call({ method: "POST", approvalId: approval.id, action: "reject" }),
    ]);

    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.equal(responses.filter((response) => response.status === 409).length, 1);
    const stored = await storedApproval(approval.id);
    assert.ok(stored.status === "approved" || stored.status === "rejected");
    assert.deepEqual(await auditActions(), [
      stored.status === "approved" ? "approval.approve" : "approval.reject",
    ]);
    assert.equal(
      await AppDataSource.getRepository(JournalEntry).count(),
      stored.status === "rejected" ? 1 : 0,
    );
  });

  test("an execution error is terminal, visible, and cannot be retried", async () => {
    const approval = await createApproval({
      kind: "lightning_payment",
      payloadJson: null,
    });
    const first = await call<{
      status: string;
      errorMessage: string;
      executeError: string;
    }>({ method: "POST", approvalId: approval.id, action: "approve" });

    assert.equal(first.status, 200);
    assert.equal(first.body.status, "execution_failed");
    assert.equal(
      first.body.executeError,
      "The approved action failed. Review the server logs for details.",
    );
    assert.equal(
      first.body.errorMessage,
      "The approved action failed. Review the server logs for details.",
    );

    const duplicate = await call({
      method: "POST",
      approvalId: approval.id,
      action: "approve",
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await storedApproval(approval.id)).status, "execution_failed");
    assert.deepEqual(await auditActions(), ["approval.approve", "approval.execute_failed"]);
  });
});
