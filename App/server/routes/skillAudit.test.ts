import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Skill } from "../db/entities/Skill.js";
import { Tag } from "../db/entities/Tag.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { skillsRouter } from "./skills.js";

/**
 * Creating or deleting a skill writes a row to the company audit log.
 *
 * Both routes are admin-gated, and a skill's declared toolset decides what its
 * AI Employee loads, yet neither used to record anything: the log showed
 * routines and employees arriving and leaving while skills came and went
 * unseen. Each now writes one row once its write has landed, and a refusal
 * writes none. The `skill.update` row is covered beside the PATCH route's
 * refusals, in `skillPatch.test.ts`.
 */

let server: Server;
let baseUrl: string;
let administrator: User;
let company: Company;
let employee: AIEmployee;
let tag: Tag;
let skill: Skill;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      userId: administrator.id,
      sessionVersion: 0,
      authenticatedAt: Date.now(),
    };
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", skillsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  administrator = await insert(User, {
    name: "administrator",
    email: "administrator@example.test",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Audit Co", slug: "audit", ownerId: administrator.id });
  await insert(Membership, { companyId: company.id, userId: administrator.id, role: "admin" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Finance",
  });
  tag = await insert(Tag, {
    companyId: company.id,
    name: "Billing",
    normalizedName: "billing",
    color: "indigo",
  });
  skill = await insert(Skill, {
    employeeId: employee.id,
    name: "Reconcile Stripe payouts",
    slug: "reconcile-stripe-payouts",
    toolsetJson: JSON.stringify(["record_payment"]),
  });
});

async function create(payload: unknown, employeeId = employee.id) {
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/employees/${employeeId}/skills`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function remove(skillId: string) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/skills/${skillId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** An AI Employee of a different company, which this company's admin cannot reach. */
async function foreignEmployee() {
  const other = await insert(Company, {
    name: "Other Co",
    slug: "other",
    ownerId: administrator.id,
  });
  return insert(AIEmployee, { companyId: other.id, name: "Riley", slug: "riley", role: "Finance" });
}

const skillIds = async () =>
  (await AppDataSource.getRepository(Skill).find()).map((s) => s.id).sort();
// Nothing but the routes writes to the ledger here, so a refusal must leave it
// empty: any row at all would be one they wrote.
const auditRows = () => AppDataSource.getRepository(AuditEvent).count();
// Every row, minus the id and timestamp the ledger generates for itself.
const ledger = async () =>
  (await AppDataSource.getRepository(AuditEvent).find()).map((row) => ({
    companyId: row.companyId,
    actorKind: row.actorKind,
    actorUserId: row.actorUserId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    metadata: JSON.parse(row.metadataJson) as unknown,
  }));

for (const [label, payload, toolset] of [
  // Exactly what the New skill page sends (`SkillNew.tsx`).
  ["the New skill page's payload", () => ({ name: "Send dunning emails", tagIds: [tag.id] }), []],
  // The API also takes a toolset at create time. The row records it, or the log
  // could never say which tools a skill that was never edited declares.
  [
    "a toolset declared up front",
    () => ({ name: "Send dunning emails", toolset: ["send_invoice"] }),
    ["send_invoice"],
  ],
] as const) {
  test(`creating a skill from ${label} writes one skill.create row`, async () => {
    const response = await create(payload());
    assert.equal(response.status, 200);
    assert.deepEqual(await ledger(), [
      {
        companyId: company.id,
        actorKind: "user",
        actorUserId: administrator.id,
        action: "skill.create",
        targetType: "skill",
        targetId: response.body.id,
        targetLabel: "Send dunning emails",
        metadata: { employeeId: employee.id, slug: "send-dunning-emails", toolset },
      },
    ]);
  });
}

// Every refusal returns before the skill is saved: no new skill, and no row.
for (const [label, status, request] of [
  // Names are unique per employee regardless of case.
  ["a name the employee already has", 409, () => create({ name: "reconcile stripe payouts" })],
  [
    "a misspelled tool",
    400,
    () => create({ name: "Send dunning emails", toolset: ["send_invoce"] }),
  ],
  [
    "a tag from outside the company",
    400,
    () => create({ name: "Send dunning emails", tagIds: [randomUUID()] }),
  ],
  [
    "another company's AI Employee",
    404,
    async () => create({ name: "Send dunning emails" }, (await foreignEmployee()).id),
  ],
] as const) {
  test(`creating a skill with ${label} is a ${status}, and nothing is written`, async () => {
    const response = await request();
    assert.equal(response.status, status);
    assert.deepEqual(await skillIds(), [skill.id]);
    assert.equal(await auditRows(), 0);
  });
}

test("deleting a skill writes one skill.delete row naming what was removed", async () => {
  const response = await remove(skill.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await skillIds(), []);
  assert.deepEqual(await ledger(), [
    {
      companyId: company.id,
      actorKind: "user",
      actorUserId: administrator.id,
      action: "skill.delete",
      targetType: "skill",
      targetId: skill.id,
      targetLabel: "Reconcile Stripe payouts",
      metadata: { employeeId: employee.id, slug: "reconcile-stripe-payouts" },
    },
  ]);
});

test("deleting a skill that is already gone is a 404, and adds no second row", async () => {
  assert.equal((await remove(skill.id)).status, 200);
  assert.equal((await remove(skill.id)).status, 404);
  assert.equal(await auditRows(), 1);
});

test("deleting another company's skill is a 404, and nothing is written", async () => {
  const foreign = await insert(Skill, {
    employeeId: (await foreignEmployee()).id,
    name: "Reconcile Stripe payouts",
    slug: "reconcile-stripe-payouts",
  });
  const response = await remove(foreign.id);
  assert.equal(response.status, 404);
  assert.deepEqual(await skillIds(), [skill.id, foreign.id].sort());
  assert.equal(await auditRows(), 0);
});
