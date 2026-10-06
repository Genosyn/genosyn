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
 *
 * A save that lands writes one `skill.update` audit row carrying the name and
 * declared toolset before and after. A refusal, at any status, writes no row.
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

async function patch(payload: unknown, skillId = skill.id) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/skills/${skillId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const savedSkill = (id = skill.id) => AppDataSource.getRepository(Skill).findOneByOrFail({ id });
// A refusal must leave the ledger empty, not merely free of `skill.update`:
// nothing else writes to it here, so any row at all would be the route's.
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
  test(`a PATCH carrying ${label} still saves, is audited once, and the playbook is untouched`, async () => {
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
    assert.deepEqual(await ledger(), [
      {
        companyId: company.id,
        actorKind: "user",
        actorUserId: administrator.id,
        action: "skill.update",
        targetType: "skill",
        targetId: skill.id,
        targetLabel: saved.name,
        metadata: {
          employeeId: skill.employeeId,
          slug: "reconcile-stripe-payouts",
          before: { name: "Reconcile Stripe payouts", toolset: ["record_payment"] },
          after: columns,
        },
      },
    ]);
  });
}

// Refusals the handler makes after the schema has passed. Each one returns
// before the save, so the stored skill and the ledger stay exactly as they were.
for (const [label, status, payload, target] of [
  [
    "a PATCH carrying a name another of the employee's skills has",
    409,
    { name: "send dunning emails" },
    async () => {
      await insert(Skill, {
        employeeId: skill.employeeId,
        name: "Send dunning emails",
        slug: "send-dunning-emails",
      });
      return skill;
    },
  ],
  // The handler renames the loaded row before it checks the toolset, and
  // neither change may land.
  [
    "a PATCH carrying a misspelled tool beside a rename",
    400,
    { name: "Reconcile payouts", toolset: ["send_invoce"] },
    async () => skill,
  ],
  [
    "a PATCH to another company's skill",
    404,
    { name: "Reconcile payouts" },
    async () => {
      const other = await insert(Company, {
        name: "Other Co",
        slug: "other",
        ownerId: administrator.id,
      });
      const owner = await insert(AIEmployee, {
        companyId: other.id,
        name: "Riley",
        slug: "riley",
        role: "Finance",
      });
      return insert(Skill, {
        employeeId: owner.id,
        name: "Reconcile Stripe payouts",
        slug: "reconcile-stripe-payouts",
        body: originalBody,
      });
    },
  ],
] as const) {
  test(`${label} is a ${status}, and nothing is written`, async () => {
    const { id } = await target();
    const stored = await savedSkill(id);
    const response = await patch(payload, id);
    assert.equal(response.status, status);
    assert.deepEqual(await savedSkill(id), stored);
    assert.equal(await auditRows(), 0);
  });
}
