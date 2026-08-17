import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Decision } from "../db/entities/Decision.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { createDecision } from "../services/decisions.js";
import { decisionsRouter } from "./decisions.js";

/**
 * Route-level contract for the Decision Stack.
 *
 * The interesting cases are all about *who may answer*: a decision is
 * member-level by design, which is the deliberate difference from the
 * admin-gated approvals inbox, so the tests have to pin that down rather than
 * let it drift back to admin-only or open up to a non-member.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    next();
  });
  app.use("/api/companies/:cid", decisionsRouter);
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
let member: User;
let secondMember: User;
let outsider: User;

beforeEach(async () => {
  await resetTestDb();
  owner = await createUser("owner@example.com", "Owner");
  member = await createUser("member@example.com", "Member");
  secondMember = await createUser("second@example.com", "Second");
  outsider = await createUser("outsider@example.com", "Outsider");
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  await insert(Membership, {
    companyId: company.id,
    userId: secondMember.id,
    role: "member" as Role,
  });
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
  actingUserId = member.id;
});

async function createUser(email: string, name: string): Promise<User> {
  return insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
}

async function stack(overrides: Parameters<typeof createDecision>[0] | null = null) {
  const { decision } = await createDecision({
    companyId: company.id,
    employeeId: employee.id,
    title: "Send the pricing reply?",
    body: "Draft goes here.",
    options: [{ label: "Send it", tone: "primary" }, { label: "Hold" }],
    ...(overrides ?? {}),
  });
  return decision;
}

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("decision route authorization", () => {
  test("an unauthenticated caller is rejected", async () => {
    actingUserId = null;
    const response = await call("GET", "/decisions");
    assert.equal(response.status, 401);
  });

  test("a non-member of the company is rejected", async () => {
    actingUserId = outsider.id;
    const response = await call("GET", "/decisions");
    assert.equal(response.status, 403);
  });

  test("an ordinary member may list and answer — this is not an admin gate", async () => {
    const decision = await stack();
    const list = await call<Array<{ id: string; options: Array<{ id: string }> }>>(
      "GET",
      "/decisions",
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.deepEqual(
      list.body[0].options.map((o) => o.id),
      ["send-it", "hold"],
    );

    const decided = await call<{ status: string; chosenOptionLabel: string }>(
      "POST",
      `/decisions/${decision.id}/decide`,
      { optionId: "send-it" },
    );
    assert.equal(decided.status, 200);
    assert.equal(decided.body.status, "decided");
    assert.equal(decided.body.chosenOptionLabel, "Send it");
  });

  test("an assigned decision is 403 for a different member", async () => {
    const decision = await stack();
    await AppDataSource.getRepository(Decision).update(
      { id: decision.id },
      { assigneeUserId: secondMember.id },
    );
    const response = await call("POST", `/decisions/${decision.id}/decide`, {
      optionId: "send-it",
    });
    assert.equal(response.status, 403);
    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id: decision.id }))!;
    assert.equal(row.status, "pending");
  });

  test("another company's decision is 404, not someone else's row", async () => {
    const decision = await stack();
    actingUserId = owner.id;
    const response = await call(
      "POST",
      `/decisions/${decision.id}/decide`,
      { optionId: "send-it" },
      otherCompany.id,
    );
    assert.equal(response.status, 404);
    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id: decision.id }))!;
    assert.equal(row.status, "pending");
  });

  test("another company's stack is not listed", async () => {
    await stack();
    actingUserId = owner.id;
    const response = await call<unknown[]>("GET", "/decisions", undefined, otherCompany.id);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);
  });
});

describe("decision route validation", () => {
  test("a body with unknown fields is rejected", async () => {
    const decision = await stack();
    const response = await call("POST", `/decisions/${decision.id}/decide`, {
      optionId: "send-it",
      status: "decided",
    });
    assert.equal(response.status, 400);
  });

  test("an option the decision does not offer is a 400", async () => {
    const decision = await stack();
    const response = await call<{ error: string }>(
      "POST",
      `/decisions/${decision.id}/decide`,
      { optionId: "wire-the-money" },
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error, /not one this decision offers/);
  });

  test("a non-uuid id is rejected before it reaches the database", async () => {
    const response = await call("POST", "/decisions/not-a-uuid/decide", { optionId: "send-it" });
    assert.equal(response.status, 400);
  });

  test("an unknown status filter is rejected", async () => {
    const response = await call("GET", "/decisions?status=whatever");
    assert.equal(response.status, 400);
  });
});

describe("decision route race handling", () => {
  test("a second answer gets a conflict, not a second decision", async () => {
    const decision = await stack();
    const first = await call("POST", `/decisions/${decision.id}/decide`, { optionId: "send-it" });
    assert.equal(first.status, 200);
    const second = await call<{ error: string }>(
      "POST",
      `/decisions/${decision.id}/decide`,
      { optionId: "hold" },
    );
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already decided/);

    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id: decision.id }))!;
    assert.equal(row.chosenOptionId, "send-it");
  });

  test("dismissing a decided decision conflicts rather than overwriting it", async () => {
    const decision = await stack();
    await call("POST", `/decisions/${decision.id}/decide`, { optionId: "send-it" });
    const dismissed = await call("POST", `/decisions/${decision.id}/dismiss`, {});
    assert.equal(dismissed.status, 409);
    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id: decision.id }))!;
    assert.equal(row.status, "decided");
  });

  test("a member can dismiss a pending decision without choosing", async () => {
    const decision = await stack();
    const response = await call<{ status: string }>(
      "POST",
      `/decisions/${decision.id}/dismiss`,
      { reason: "Handled by hand." },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "cancelled");
  });
});

/**
 * The wire contract the stack renders from, and the pickup the answer starts.
 *
 * There is no AI Model in these fixtures, so a pickup degrades to `skipped`
 * rather than running a model turn — which is itself the behaviour worth
 * pinning: a fresh self-host uses the stack long before anyone connects a
 * brain, and pressing a button there must record why nothing started instead
 * of looking broken. `decisionKickoff.test.ts` covers the sessions that do run.
 */
describe("decision route payload", () => {
  test("a listed row carries its provenance and pickup state", async () => {
    await stack();
    const list = await call<Array<Record<string, unknown>>>("GET", "/decisions");
    assert.equal(list.status, 200);
    const row = list.body[0] as unknown as {
      source: { kind: string };
      pickupStatus: string;
      pickupSummary: string | null;
      mailThreadId: string | null;
      decidedBy: unknown;
    };
    assert.equal(row.source.kind, "unknown");
    assert.equal(row.pickupStatus, "none");
    assert.equal(row.pickupSummary, null);
    assert.equal(row.mailThreadId, null);
    assert.equal(row.decidedBy, null);
  });

  test("answering starts a pickup, and it reaches a terminal state", async () => {
    const decision = await stack();
    const decided = await call("POST", `/decisions/${decision.id}/decide`, {
      optionId: "send-it",
    });
    assert.equal(decided.status, 200);

    const row = await waitForPickup(decision.id);
    assert.equal(row.pickupStatus, "skipped", row.pickupSummary ?? "");
    assert.match(row.pickupSummary ?? "", /no AI Model connected/i);
    assert.ok(row.pickupFinishedAt, "a settled pickup records when it finished");
  });

  test("dismissing never starts a pickup", async () => {
    const decision = await stack();
    await call("POST", `/decisions/${decision.id}/dismiss`, { reason: "Handled by hand." });
    // Give a stray kickoff the same window the decide path gets before asserting.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id: decision.id }))!;
    assert.equal(row.pickupStatus, "none");
  });

  test("a losing racer does not start a second pickup", async () => {
    const decision = await stack();
    await call("POST", `/decisions/${decision.id}/decide`, { optionId: "send-it" });
    await waitForPickup(decision.id);
    const second = await call("POST", `/decisions/${decision.id}/decide`, { optionId: "hold" });
    assert.equal(second.status, 409);

    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id: decision.id }))!;
    assert.equal(row.chosenOptionId, "send-it");
    assert.equal(row.pickupStatus, "skipped");
  });
});

/** Poll until the fire-and-forget pickup settles, so the assertions aren't racy. */
async function waitForPickup(id: string): Promise<Decision> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = (await AppDataSource.getRepository(Decision).findOneBy({ id }))!;
    if (row.pickupStatus !== "none" && row.pickupStatus !== "running") return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pickup never settled");
}
