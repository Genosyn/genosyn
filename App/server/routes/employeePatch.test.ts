import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Team } from "../db/entities/Team.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { employeeDir, ensureDir } from "../services/paths.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { employeesRouter } from "./employees.js";

/**
 * `PATCH /employees/:eid` refuses keys it does not handle.
 *
 * Its schema used to strip them, so `{ "soulBody": "..." }` answered 200 while
 * the Soul stayed as it was — the Soul is saved through
 * `PUT /employees/:eid/soul` — and an API client took that 200 for a saved
 * edit. A refusal names the keys and writes nothing, not even the valid
 * settings sent beside them: no row change, no audit event, and no rename of
 * the employee's directory for a slug sent alongside.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl: string;
let administrator: User;
let company: Company;
let team: Team;
let manager: AIEmployee;
let employee: AIEmployee;
const originalSoul = "# Jamie\n\nPreserve the captured voice.\n";

before(async () => {
  // A slug change renames the employee's directory, so keep it off `./data`.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-employee-patch-"));
  mutableConfig.dataDir = path.join(root, "data");
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
  app.use("/api/companies/:cid/employees", employeesRouter);
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
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  fs.rmSync(mutableConfig.dataDir, { recursive: true, force: true });
  administrator = await insert(User, {
    name: "administrator",
    email: "administrator@example.test",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Patch Co", slug: "patch", ownerId: administrator.id });
  await insert(Membership, { companyId: company.id, userId: administrator.id, role: "admin" });
  team = await insert(Team, { companyId: company.id, name: "Operations", slug: "operations" });
  manager = await insert(AIEmployee, {
    companyId: company.id,
    name: "Morgan",
    slug: "morgan",
    role: "Chief of Staff",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operations",
    soulBody: originalSoul,
  });
  ensureDir(employeeDir(company.slug, employee.slug));
});

async function patch(payload: unknown) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/employees/${employee.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const savedEmployee = () =>
  AppDataSource.getRepository(AIEmployee).findOneByOrFail({ id: employee.id });
const updateAudits = () =>
  AppDataSource.getRepository(AuditEvent).countBy({ action: "employee.update" });

for (const [label, payload, named] of [
  ["the Soul", { soulBody: "Revised Soul" }, ["soulBody"]],
  [
    "the Soul beside valid settings",
    { name: "Jordan", slug: "jordan", browserEnabled: true, soulBody: "Revised Soul" },
    ["soulBody"],
  ],
  // The field `PUT /employees/:eid/soul` takes, sent to the wrong route.
  ["the Soul route's field", { content: "Revised Soul" }, ["content"]],
  [
    "misnamed settings",
    { reportsTo: "Morgan", allowedHosts: "*.example.com" },
    ["reportsTo", "allowedHosts"],
  ],
] as const) {
  test(`a PATCH carrying ${label} is a 400 naming the keys, and nothing is written`, async () => {
    const stored = await savedEmployee();
    const response = await patch(payload);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
    const issues = response.body.issues as Array<{ code: string; keys?: string[] }>;
    assert.deepEqual(
      issues.map(({ code, keys }) => ({ code, keys })),
      [{ code: "unrecognized_keys", keys: named }],
    );
    assert.deepEqual(await savedEmployee(), stored);
    assert.equal(await updateAudits(), 0);
    assert.equal(fs.existsSync(employeeDir(company.slug, "jamie")), true);
    assert.equal(fs.existsSync(employeeDir(company.slug, "jordan")), false);
  });
}

// Exactly the payloads the UI sends: each form saves its own slice of the row.
// Under a strict schema each key must stay listed, or that save is a 400.
for (const [label, settings] of [
  // General card (`employeeTabs.tsx`) — only the fields that changed.
  ["the General card's payload", () => ({ name: "Jordan", role: "Head of Ops", slug: "jordan" })],
  // Org chart card (`employeeTabs.tsx`).
  ["the Org chart card's payload", () => ({ teamId: team.id, reportsToEmployeeId: manager.id })],
  // Edit org popover on the AI Employees list (`EmployeesIndex.tsx`).
  [
    "the Edit org popover's payload",
    () => ({ teamId: team.id, reportsToEmployeeId: null, reportsToUserId: administrator.id }),
  ],
  // Browser card (`employeeTabs.tsx`): the toggle, approval mode, and allow list.
  ["the browser toggle's payload", () => ({ browserEnabled: true })],
  ["the approval mode's payload", () => ({ browserApprovalRequired: false })],
  ["the allow list's payload", () => ({ browserAllowedHosts: "*.example.com\nexample.org" })],
] as const) {
  test(`a PATCH carrying ${label} still saves, and the Soul is untouched`, async () => {
    const payload = settings();
    const response = await patch(payload);
    assert.equal(response.status, 200);
    const saved = await savedEmployee();
    assert.deepEqual(
      Object.fromEntries(Object.keys(payload).map((key) => [key, saved[key as keyof AIEmployee]])),
      payload,
    );
    assert.equal(saved.soulBody, originalSoul);
    assert.equal(await updateAudits(), 1);
  });
}
