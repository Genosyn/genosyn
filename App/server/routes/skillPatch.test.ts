import assert from "node:assert/strict";
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
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { parseToolset } from "../services/skillToolset.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { skillsRouter } from "./skills.js";

/**
 * `PATCH /skills/:sid` refuses keys it does not handle.
 *
 * Its schema used to strip them, so `{ "body": "..." }` answered 200 while the
 * playbook stayed as it was — the playbook is saved through
 * `PUT /skills/:sid/readme` — and an API client took that 200 for a saved edit.
 * A refusal names the keys and writes nothing, not even the valid settings
 * sent beside them.
 */

let server: Server;
let baseUrl: string;
let administrator: User;
let company: Company;
let skill: Skill;
const originalBody = "# Reconcile Stripe payouts\n\nPreserve the captured steps.\n";

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
  company = await insert(Company, { name: "Patch Co", slug: "patch", ownerId: administrator.id });
  await insert(Membership, { companyId: company.id, userId: administrator.id, role: "admin" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Finance",
  });
  skill = await insert(Skill, {
    employeeId: employee.id,
    name: "Reconcile Stripe payouts",
    slug: "reconcile-stripe-payouts",
    body: originalBody,
    toolsetJson: JSON.stringify(["record_payment"]),
  });
});

async function patch(payload: unknown) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/skills/${skill.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const savedSkill = () => AppDataSource.getRepository(Skill).findOneByOrFail({ id: skill.id });
// The route records no audit event of its own, so a refusal must leave the
// ledger empty: any row at all would be something it wrote.
const auditRows = () => AppDataSource.getRepository(AuditEvent).count();

for (const [label, payload, named] of [
  ["the playbook", { body: "Revised playbook" }, ["body"]],
  [
    "the playbook beside valid settings",
    { name: "Reconcile payouts", toolset: ["send_invoice"], body: "Revised playbook" },
    ["body"],
  ],
  // The field `PUT /skills/:sid/readme` takes, sent to the wrong route.
  ["the readme route's field", { content: "Revised playbook" }, ["content"]],
  [
    "misspelled settings",
    { title: "Reconcile payouts", tools: ["send_invoice"] },
    ["title", "tools"],
  ],
] as const) {
  test(`a PATCH carrying ${label} is a 400 naming the keys, and nothing is written`, async () => {
    const stored = await savedSkill();
    const response = await patch(payload);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
    const issues = response.body.issues as Array<{ code: string; keys?: string[] }>;
    assert.deepEqual(
      issues.map(({ code, keys }) => ({ code, keys })),
      [{ code: "unrecognized_keys", keys: named }],
    );
    assert.deepEqual(await savedSkill(), stored);
    assert.equal(await auditRows(), 0);
  });
}

for (const [label, settings] of [
  ["a rename", { name: "Reconcile payouts" }],
  [
    // Exactly the keys the Settings tab sends on save (`SkillDetail.tsx`).
    // Under a strict schema each must stay listed, or a Member's save is a 400.
    "the Settings tab's whole payload",
    { name: "Reconcile payouts", toolset: ["send_invoice", "record_payment"] },
  ],
] as const) {
  test(`a PATCH carrying ${label} still saves, and the playbook is untouched`, async () => {
    const response = await patch(settings);
    assert.equal(response.status, 200);
    const saved = await savedSkill();
    const columns = { name: saved.name, toolset: parseToolset(saved.toolsetJson) };
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(settings).map((key) => [key, columns[key as keyof typeof columns]]),
      ),
      settings,
    );
    assert.equal(saved.body, originalBody);
  });
}
