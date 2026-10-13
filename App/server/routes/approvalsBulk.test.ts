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
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { approvalsRouter } from "./approvals.js";

/**
 * The Decision stack's bulk bar, for email and work reviews: a selection can
 * only discard emails and decline work plans. Each review is still an
 * admin's decision in a browser session, must be the version that was read,
 * and is skipped — never failing the rest — when it is not one to discard.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
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

beforeEach(async () => {
  await resetTestDb();
  owner = await createUser("owner@example.com", "Owner");
  admin = await createUser("admin@example.com", "Admin");
  member = await createUser("member@example.com", "Member");
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  await insert(Membership, { companyId: otherCompany.id, userId: owner.id, role: "owner" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Operator",
    slug: "operator",
    role: "Operations",
  });
  actingUserId = admin.id;
});

async function createUser(email: string, name: string): Promise<User> {
  return insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
}

const hex = (seed: string) => crypto.createHash("sha256").update(seed).digest("hex");

/** An email waiting for review; its revision is its dedupe key. */
async function emailReview(subject: string, companyId = company.id) {
  const revision = hex(`mail:${subject}`);
  const approval = await insert(Approval, {
    companyId,
    kind: "mail_send",
    routineId: "",
    employeeId: employee.id,
    title: `Reply about ${subject}`,
    summary: null,
    payloadJson: JSON.stringify({
      version: 1,
      accountId: crypto.randomUUID(),
      threadId: null,
      mailHandoverId: null,
      context: "A customer asked a question.",
      workSummary: "Prepared the reply.",
      steps: [],
      attachments: [],
      draft: {
        to: "customer@example.test",
        cc: "",
        bcc: "",
        subject,
        bodyText: "Thanks for writing in.",
      },
      sourceFingerprint: hex(`source:${subject}`),
      dedupeKey: revision,
    }),
    resultJson: null,
    errorMessage: null,
    status: "pending",
    decidedAt: null,
    decidedByUserId: null,
  });
  return { approval, revision };
}

/** A work plan waiting for review, carrying its own revision. */
async function workReview(title: string) {
  const revision = hex(`work:${title}`);
  const approval = await insert(Approval, {
    companyId: company.id,
    kind: "proactive_work",
    routineId: "",
    employeeId: employee.id,
    title,
    summary: null,
    payloadJson: JSON.stringify({
      version: 1,
      title,
      context: "A customer reported a failed request.",
      plan: "Reproduce it, fix it, and verify the result.",
      origin: { routineId: null },
      sourceFingerprint: "source-fingerprint",
      dedupeKey: `dedupe:${title}`,
      revision,
    }),
    resultJson: null,
    errorMessage: null,
    status: "pending",
    decidedAt: null,
    decidedByUserId: null,
  });
  return { approval, revision };
}

async function stored(id: string): Promise<Approval> {
  return AppDataSource.getRepository(Approval).findOneByOrFail({ id });
}

type BulkResult = {
  action: string;
  succeeded: string[];
  skipped: Array<{ id: string; reason: string }>;
  error?: string;
};

async function bulk(
  body: unknown,
  options: { companyId?: string; bearerToken?: string } = {},
): Promise<{ status: number; body: BulkResult }> {
  const response = await fetch(
    `${baseUrl}/api/companies/${options.companyId ?? company.id}/approvals/bulk`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
        ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("discarding a selection of reviews", () => {
  test("emails are discarded and work declined, each with its own journal entry", async () => {
    const first = await emailReview("Pricing");
    const second = await emailReview("Onboarding");
    const plan = await workReview("Fix the checkout error");
    const untouched = await emailReview("Renewal");

    const response = await bulk({
      action: "reject",
      items: [
        { id: first.approval.id, reviewRevision: first.revision },
        { id: second.approval.id, reviewRevision: second.revision },
        { id: plan.approval.id, reviewRevision: plan.revision },
      ],
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.action, "reject");
    assert.deepEqual(response.body.succeeded, [
      first.approval.id,
      second.approval.id,
      plan.approval.id,
    ]);
    assert.deepEqual(response.body.skipped, []);
    for (const id of response.body.succeeded) {
      const row = await stored(id);
      assert.equal(row.status, "rejected");
      assert.equal(row.decidedByUserId, admin.id);
    }
    assert.equal((await stored(untouched.approval.id)).status, "pending");
    const journal = await AppDataSource.getRepository(JournalEntry).find({
      where: { employeeId: employee.id },
    });
    assert.deepEqual(journal.map((entry) => entry.title).sort(), [
      'Email discarded: "Onboarding"',
      'Email discarded: "Pricing"',
      "Proposed work declined: Fix the checkout error",
    ]);
  });

  test("a review that changed since it was read is skipped, and the rest still go", async () => {
    const changed = await emailReview("Pricing");
    const current = await emailReview("Onboarding");

    const response = await bulk({
      action: "reject",
      items: [
        { id: changed.approval.id, reviewRevision: hex("an older copy") },
        { id: current.approval.id, reviewRevision: current.revision },
      ],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.succeeded, [current.approval.id]);
    assert.deepEqual(response.body.skipped, [
      {
        id: changed.approval.id,
        reason: "Changed since you read it. Open it to review the latest version",
      },
    ]);
    assert.equal((await stored(changed.approval.id)).status, "pending");
  });

  test("only Decision-stack reviews of this company that still wait are discarded", async () => {
    const settled = await emailReview("Pricing");
    await AppDataSource.getRepository(Approval).update(
      { id: settled.approval.id },
      { status: "rejected", decidedAt: new Date(), decidedByUserId: owner.id },
    );
    const declined = await workReview("Fix the checkout error");
    await AppDataSource.getRepository(Approval).update(
      { id: declined.approval.id },
      { status: "rejected", decidedAt: new Date(), decidedByUserId: owner.id },
    );
    const sent = await emailReview("Launch");
    await AppDataSource.getRepository(Approval).update(
      { id: sent.approval.id },
      { status: "approved", decidedAt: new Date(), decidedByUserId: owner.id },
    );
    const otherKind = await insert(Approval, {
      companyId: company.id,
      kind: "browser_action",
      routineId: "",
      employeeId: employee.id,
      title: "Submit the form",
      summary: null,
      payloadJson: "{}",
      resultJson: null,
      errorMessage: null,
      status: "pending",
      decidedAt: null,
      decidedByUserId: null,
    });
    const elsewhere = await emailReview("Elsewhere", otherCompany.id);

    const response = await bulk({
      action: "reject",
      items: [
        { id: settled.approval.id, reviewRevision: settled.revision },
        { id: declined.approval.id, reviewRevision: declined.revision },
        { id: sent.approval.id, reviewRevision: sent.revision },
        { id: otherKind.id },
        { id: elsewhere.approval.id, reviewRevision: elsewhere.revision },
      ],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.succeeded, []);
    assert.deepEqual(response.body.skipped, [
      { id: settled.approval.id, reason: "Already discarded" },
      { id: declined.approval.id, reason: "Already declined" },
      { id: sent.approval.id, reason: "Already approved" },
      { id: otherKind.id, reason: "Review not found" },
      { id: elsewhere.approval.id, reason: "Review not found" },
    ]);
    assert.equal((await stored(otherKind.id)).status, "pending", "other Approvals stay put");
    assert.equal((await stored(elsewhere.approval.id)).status, "pending");
    assert.equal((await stored(sent.approval.id)).status, "approved");
  });

  test("a repeated review is discarded once", async () => {
    const review = await emailReview("Pricing");
    const item = { id: review.approval.id, reviewRevision: review.revision };
    const response = await bulk({ action: "reject", items: [item, item] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.succeeded, [review.approval.id]);
    assert.deepEqual(response.body.skipped, []);
    assert.equal(await AppDataSource.getRepository(JournalEntry).count(), 1);
  });
});

describe("who may discard a selection", () => {
  test("owners and admins may; an ordinary Member may not", async () => {
    const forOwner = await emailReview("Pricing");
    const forMember = await emailReview("Onboarding");
    actingUserId = owner.id;
    const ownerResponse = await bulk({
      action: "reject",
      items: [{ id: forOwner.approval.id, reviewRevision: forOwner.revision }],
    });
    assert.equal(ownerResponse.status, 200);
    assert.deepEqual(ownerResponse.body.succeeded, [forOwner.approval.id]);

    actingUserId = member.id;
    const memberResponse = await bulk({
      action: "reject",
      items: [{ id: forMember.approval.id, reviewRevision: forMember.revision }],
    });
    assert.equal(memberResponse.status, 403);
    assert.equal((await stored(forMember.approval.id)).status, "pending");
  });

  test("an API key cannot discard reviews, even an owner's", async () => {
    const review = await emailReview("Pricing");
    const secret = "B".repeat(43);
    await insert(ApiKey, {
      companyId: company.id,
      userId: owner.id,
      name: "Automation",
      prefix: secret.slice(0, 8),
      tokenHash: hashApiToken(secret),
      lastUsedAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    });
    actingUserId = null;
    const response = await bulk(
      { action: "reject", items: [{ id: review.approval.id, reviewRevision: review.revision }] },
      { bearerToken: `gen_${secret}` },
    );
    assert.equal(response.status, 403);
    assert.equal((await stored(review.approval.id)).status, "pending");
  });
});

describe("bulk review validation", () => {
  test("approving is not a bulk action", async () => {
    const review = await emailReview("Pricing");
    const response = await bulk({
      action: "approve",
      items: [{ id: review.approval.id, reviewRevision: review.revision }],
    });
    assert.equal(response.status, 400);
    assert.equal((await stored(review.approval.id)).status, "pending");
  });

  test("items must be one to two hundred, with uuid ids and well-formed revisions", async () => {
    const review = await emailReview("Pricing");
    assert.equal((await bulk({ action: "reject", items: [] })).status, 400);
    assert.equal(
      (await bulk({ action: "reject", items: [{ id: "nope", reviewRevision: review.revision }] }))
        .status,
      400,
    );
    assert.equal(
      (await bulk({ action: "reject", items: [{ id: review.approval.id, reviewRevision: "x" }] }))
        .status,
      400,
    );
    assert.equal(
      (
        await bulk({
          action: "reject",
          items: [{ id: review.approval.id, reviewRevision: review.revision, send: true }],
        })
      ).status,
      400,
    );
    const tooMany = Array.from({ length: 201 }, () => ({ id: crypto.randomUUID() }));
    assert.equal((await bulk({ action: "reject", items: tooMany })).status, 400);
    assert.equal((await stored(review.approval.id)).status, "pending");
  });
});
