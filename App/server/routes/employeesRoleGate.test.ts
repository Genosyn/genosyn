import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";

/**
 * Who may change an AI Employee, however the path is spelled.
 *
 * The employees router keeps reads collaborative and reserves every mutation —
 * hiring, editing, deleting, the Soul, the avatar, applying onboarding
 * Routines — for owners and admins, through one `onRoutePaths` guard with
 * anchored matchers such as `/^\/[^/]+(?:\/soul|\/avatar)?$/`.
 *
 * The regression this file exists for: Express routes non-strictly, so
 * `PATCH /employees/:eid/` reaches the handler registered at `/:eid`, but the
 * anchored matchers missed the slash and the guard skipped itself. A plain
 * member could rewrite an AI Employee's Soul, or delete the employee, by ending
 * the path with "/". The router runs for real over an in-memory database, as
 * in `meetingsRoleGate.test.ts`, because guard scoping is invisible to a
 * service test.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl: string;

/** Whose session the next request carries. Mutated per test. */
let actingUserId: string | null = null;

before(async () => {
  // A gate that failed open would let the avatar and delete handlers touch the
  // employee's files, so keep them off `./data`.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-employees-role-gate-"));
  mutableConfig.dataDir = path.join(root, "data");
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid/employees", employeesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

let companyId: string;
let adminId: string;
let memberId: string;
let employee: AIEmployee;
const originalSoul = "# Nova\n\nKeep the captured voice.\n";

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "employees-owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const admin = await insert(User, {
    email: "employees-admin@example.com",
    name: "Admin",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const member = await insert(User, {
    email: "employees-member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  // Mission and vision are set so a hire would get past `hasCompanyDirection`
  // if it got past the guard.
  const company = await insert(Company, {
    name: "Northwind Staffing",
    slug: "northwind-staffing",
    ownerId: owner.id,
    mission: "Help every customer adopt reliable software.",
    vision: "A world where preventable churn disappears.",
  });
  companyId = company.id;
  adminId = admin.id;
  memberId = member.id;
  await insert(Membership, { companyId, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId, userId: adminId, role: "admin" as Role });
  await insert(Membership, { companyId, userId: memberId, role: "member" as Role });
  employee = await insert(AIEmployee, {
    companyId,
    name: "Nova",
    slug: "nova",
    role: "Account executive",
    soulBody: originalSoul,
    avatarKey: "existing-avatar.png",
  });
  actingUserId = memberId;
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}/api/companies/${companyId}/employees${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** Everything a mutation on this router could have changed. */
async function snapshot() {
  return {
    employees: await AppDataSource.getRepository(AIEmployee).find({ order: { id: "ASC" } }),
    routines: await AppDataSource.getRepository(Routine).count(),
  };
}

// Paths are relative to the `/employees` mount, written without a trailing
// slash; each test also sends them with one. The hire route is the mount
// itself, so its spellings are `/employees` and `/employees/`.
const MUTATIONS: ReadonlyArray<{
  label: string;
  method: string;
  path: () => string;
  body?: () => unknown;
}> = [
  {
    label: "hire an AI Employee",
    method: "POST",
    path: () => "",
    body: () => ({ name: "Avery", role: "Analyst" }),
  },
  {
    label: "edit an AI Employee",
    method: "PATCH",
    path: () => `/${employee.id}`,
    body: () => ({ role: "Renamed by a member" }),
  },
  { label: "delete an AI Employee", method: "DELETE", path: () => `/${employee.id}` },
  {
    label: "rewrite the Soul",
    method: "PUT",
    path: () => `/${employee.id}/soul`,
    body: () => ({ content: "# Rewritten by a member" }),
  },
  // No file is needed: the guard answers before multer reads the body, and a
  // gate that failed open would answer 400 "No file uploaded" instead.
  { label: "replace the avatar", method: "POST", path: () => `/${employee.id}/avatar` },
  { label: "remove the avatar", method: "DELETE", path: () => `/${employee.id}/avatar` },
  {
    label: "apply onboarding Routines",
    method: "POST",
    path: () => `/${employee.id}/onboarding-recommendations/routines`,
    body: () => ({ recommendationIds: ["daily-priority-check"] }),
  },
];

describe("employees routes — mutations are admin-only, with or without a trailing slash", () => {
  for (const mutation of MUTATIONS) {
    test(`a plain member cannot ${mutation.label}`, async () => {
      const stored = await snapshot();
      for (const spelling of [mutation.path(), `${mutation.path()}/`]) {
        const res = await call<{ error: string }>(mutation.method, spelling, mutation.body?.());
        const request = `${mutation.method} /employees${spelling}`;
        assert.equal(res.status, 403, request);
        assert.equal(res.body.error, "admin company role required", request);
        // The point of the guard: nothing was written on the way to the 403.
        assert.deepEqual(await snapshot(), stored, request);
      }
    });
  }

  test("an admin's edits through the slash spellings reach their handlers", async () => {
    // So the member's 403 above is the guard, not a spelling no route serves.
    actingUserId = adminId;
    const patched = await call<{ role: string }>("PATCH", `/${employee.id}/`, {
      role: "Head of Accounts",
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.role, "Head of Accounts");

    const soul = await call("PUT", `/${employee.id}/soul/`, { content: "# Revised Soul" });
    assert.equal(soul.status, 200);
    const saved = await AppDataSource.getRepository(AIEmployee).findOneByOrFail({
      id: employee.id,
    });
    assert.equal(saved.role, "Head of Accounts");
    assert.equal(saved.soulBody, "# Revised Soul");
  });

  test("a plain member may still read through the slash spellings", async () => {
    // Trimming the slash must not turn a collaborative read into a 403.
    const list = await call<unknown[]>("GET", "/");
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const one = await call<{ id: string }>("GET", `/${employee.id}/`);
    assert.equal(one.status, 200);
    assert.equal(one.body.id, employee.id);

    const soul = await call<{ content: string }>("GET", `/${employee.id}/soul/`);
    assert.equal(soul.status, 200);
    assert.equal(soul.body.content, originalSoul);
  });
});
