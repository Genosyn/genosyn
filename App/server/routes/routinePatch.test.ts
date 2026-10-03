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
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { routinesRouter } from "./routines.js";

/**
 * `PATCH /routines/:rid` refuses keys it does not handle.
 *
 * Its schema used to strip them, so `{ "body": "..." }` answered 200 while the
 * brief stayed as it was — the brief is saved through `PUT /routines/:rid/readme`
 * — and an API client took that 200 for a saved edit. A refusal names the keys
 * and writes nothing, not even the valid settings sent beside them.
 */

let server: Server;
let baseUrl: string;
let administrator: User;
let company: Company;
let routine: Routine;
const originalBody = "# Daily review\n\nPreserve the captured scope.\n";

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
  app.use("/api/companies/:cid", routinesRouter);
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
    role: "Operations",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Daily review",
    slug: "daily-review",
    cronExpr: "0 9 * * *",
    body: originalBody,
  });
});

async function patch(payload: unknown) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/routines/${routine.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const savedRoutine = () => AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
const updateAudits = () =>
  AppDataSource.getRepository(AuditEvent).countBy({ action: "routine.update" });

for (const [label, payload, named] of [
  ["the brief", { body: "Revised brief" }, ["body"]],
  [
    "the brief beside valid settings",
    { name: "Weekly review", enabled: false, body: "Revised brief" },
    ["body"],
  ],
  [
    "misspelled settings",
    { cronExpression: "0 10 * * *", timeout: 900 },
    ["cronExpression", "timeout"],
  ],
] as const) {
  test(`a PATCH carrying ${label} is a 400 naming the keys, and nothing is written`, async () => {
    const stored = await savedRoutine();
    const response = await patch(payload);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
    const issues = response.body.issues as Array<{ code: string; keys?: string[] }>;
    assert.deepEqual(
      issues.map(({ code, keys }) => ({ code, keys })),
      [{ code: "unrecognized_keys", keys: named }],
    );
    assert.deepEqual(await savedRoutine(), stored);
    assert.equal(await updateAudits(), 0);
  });
}

for (const [label, settings] of [
  ["a single setting", { enabled: false }],
  [
    // Exactly the keys the Settings form sends on save (`RoutineDetail.tsx`).
    // Under a strict schema each must stay listed, or a Member's save is a 400.
    "the Settings form's whole payload",
    {
      name: "Weekly review",
      cronExpr: "0 10 * * 1",
      enabled: false,
      timeoutSec: 900,
      requiresApproval: true,
      folderId: null,
      goalId: null,
      modelId: null,
      browserEnabledOverride: false,
      memberBrowserId: null,
      catchUpPolicy: "skip",
      maxAttempts: 3,
      retryBackoffSec: 120,
      retryOnTimeout: true,
      acceptanceCriteria: "Every record is reviewed.",
    },
  ],
] as const) {
  test(`a PATCH carrying ${label} still saves, and the brief is untouched`, async () => {
    const response = await patch(settings);
    assert.equal(response.status, 200);
    const saved = await savedRoutine();
    assert.deepEqual(
      Object.fromEntries(Object.keys(settings).map((key) => [key, saved[key as keyof Routine]])),
      settings,
    );
    assert.equal(saved.body, originalBody);
    assert.equal(await updateAudits(), 1);
  });
}
