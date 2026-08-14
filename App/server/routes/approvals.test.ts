import assert from "node:assert/strict";
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
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt,
          secondFactorAt,
        }
      : null;
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

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(args: {
  method: string;
  approvalId?: string;
  action?: "approve" | "reject";
  companyId?: string;
  bearerToken?: string;
}): Promise<ApiResponse<T>> {
  const suffix = args.approvalId ? `/approvals/${args.approvalId}/${args.action}` : "/approvals";
  const response = await fetch(
    `${baseUrl}/api/companies/${args.companyId ?? company.id}${suffix}`,
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

  test("missing or stale primary authentication cannot decide an approval", async () => {
    const missing = await createApproval();
    authenticatedAt = undefined;
    secondFactorAt = undefined;
    const missingResponse = await call<{ code: string }>({
      method: "POST",
      approvalId: missing.id,
      action: "approve",
    });
    assert.equal(missingResponse.status, 403);
    assert.equal(missingResponse.body.code, "REAUTHENTICATION_REQUIRED");
    assert.equal((await storedApproval(missing.id)).status, "pending");

    const stale = await createApproval();
    authenticatedAt = Date.now() - 16 * 60_000;
    secondFactorAt = authenticatedAt;
    const staleResponse = await call<{ code: string }>({
      method: "POST",
      approvalId: stale.id,
      action: "reject",
    });
    assert.equal(staleResponse.status, 403);
    assert.equal(staleResponse.body.code, "REAUTHENTICATION_REQUIRED");
    assert.equal((await storedApproval(stale.id)).status, "pending");
  });

  test("missing, stale, or pre-primary second-factor evidence cannot decide", async () => {
    const missing = await createApproval();
    authenticatedAt = Date.now();
    secondFactorAt = undefined;
    const missingResponse = await call<{ code: string }>({
      method: "POST",
      approvalId: missing.id,
      action: "approve",
    });
    assert.equal(missingResponse.status, 403);
    assert.equal(missingResponse.body.code, "SECOND_FACTOR_REQUIRED");

    const stale = await createApproval();
    authenticatedAt = Date.now();
    secondFactorAt = Date.now() - 16 * 60_000;
    const staleResponse = await call<{ code: string }>({
      method: "POST",
      approvalId: stale.id,
      action: "approve",
    });
    assert.equal(staleResponse.status, 403);
    assert.equal(staleResponse.body.code, "SECOND_FACTOR_REQUIRED");

    const beforePrimary = await createApproval();
    authenticatedAt = Date.now();
    secondFactorAt = authenticatedAt - 1;
    const beforePrimaryResponse = await call<{ code: string }>({
      method: "POST",
      approvalId: beforePrimary.id,
      action: "reject",
    });
    assert.equal(beforePrimaryResponse.status, 403);
    assert.equal(beforePrimaryResponse.body.code, "SECOND_FACTOR_REQUIRED");
    assert.equal((await storedApproval(missing.id)).status, "pending");
    assert.equal((await storedApproval(stale.id)).status, "pending");
    assert.equal((await storedApproval(beforePrimary.id)).status, "pending");
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
