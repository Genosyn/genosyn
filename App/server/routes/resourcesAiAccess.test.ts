import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express, { Router } from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeResourceGrant } from "../db/entities/EmployeeResourceGrant.js";
import { EmployeeResourceLibraryGrant } from "../db/entities/EmployeeResourceLibraryGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Resource } from "../db/entities/Resource.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { getResourceLibraryAccess } from "../services/resourceLibraryAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";
import { resourcesRouter } from "./resources.js";

/**
 * Resources → AI access over HTTP: the list every Member can read, the level
 * only owners and admins can change, and the audit trail a change leaves.
 *
 * The router is booted on a real socket because two of the failures this file
 * guards against only exist there: `GET /resources/ai-access` being answered by
 * `GET /resources/:slug` (registration order), and the admin guard leaking onto
 * the rest of the router or onto a router mounted after it (`onRoutePaths`).
 */

let server: Server;
let baseUrl: string;

/** Whose session the next request carries. Mutated per test. */
let actingUserId: string | null = null;

/** A router mounted *after* resources at the same prefix, as in `server/index.ts`. */
const siblingRouter = Router({ mergeParams: true });
siblingRouter.use(requireAuth);
siblingRouter.use(requireCompanyMember);
siblingRouter.post("/sibling-after-resources", (_req, res) => {
  res.status(201).json({ ok: true });
});

before(async () => {
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
  app.use("/api/companies/:cid", resourcesRouter);
  app.use("/api/companies/:cid", siblingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeTestDb();
});

let companyId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let ada: AIEmployee;
let bob: AIEmployee;
let otherCompany: Company;
let outsider: AIEmployee;

async function user(email: string, name: string) {
  return insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
}

beforeEach(async () => {
  await resetTestDb();
  const owner = await user("owner@example.com", "Owner");
  const admin = await user("admin@example.com", "Admin");
  const member = await user("member@example.com", "Member");
  ownerId = owner.id;
  adminId = admin.id;
  memberId = member.id;
  const company = await insert(Company, { name: "Acme", slug: "acme", ownerId });
  companyId = company.id;
  await insert(Membership, { companyId, userId: ownerId, role: "owner" as Role });
  await insert(Membership, { companyId, userId: adminId, role: "admin" as Role });
  await insert(Membership, { companyId, userId: memberId, role: "member" as Role });
  // Hired out of alphabetical order, so the list's ordering is asserted.
  bob = await insert(AIEmployee, { companyId, name: "Bob", slug: "bob", role: "Researcher" });
  ada = await insert(AIEmployee, { companyId, name: "Ada", slug: "ada", role: "Analyst" });

  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId });
  // The owner belongs to both companies, so a cross-company request is a
  // scoping question, not a membership one.
  await insert(Membership, { companyId: otherCompany.id, userId: ownerId, role: "owner" as Role });
  outsider = await insert(AIEmployee, {
    companyId: otherCompany.id,
    name: "Outsider",
    slug: "outsider",
    role: "Elsewhere",
  });
  actingUserId = ownerId;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  cid = companyId,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}/api/companies/${cid}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

type Row = {
  employee: { id: string; name: string; slug: string; role: string; avatarKey: string | null };
  accessLevel: "read" | "write";
  isDefault: boolean;
};

async function list(): Promise<Row[]> {
  const res = await call<{ rows: Row[] }>("GET", "/resources/ai-access");
  assert.equal(res.status, 200);
  return res.body.rows;
}

async function put(employeeId: string, accessLevel: unknown) {
  return call<{ row: Row; error?: string }>("PUT", `/resources/ai-access/${employeeId}`, {
    accessLevel,
  });
}

async function accessAudits() {
  return AppDataSource.getRepository(AuditEvent).find({
    where: { action: "resource.ai_access.update" },
    order: { createdAt: "ASC" },
  });
}

async function storedRows() {
  return AppDataSource.getRepository(EmployeeResourceLibraryGrant).find();
}

describe("GET /resources/ai-access", () => {
  test("rejects an unauthenticated request", async () => {
    actingUserId = null;
    const res = await call("GET", "/resources/ai-access");
    assert.equal(res.status, 401);
  });

  test("rejects a user who is not a member of the company", async () => {
    const stranger = await user("stranger@example.com", "Stranger");
    actingUserId = stranger.id;
    const res = await call("GET", "/resources/ai-access");
    assert.equal(res.status, 403);
  });

  test("any Member can see every AI Employee, alphabetically, at read + write by default", async () => {
    actingUserId = memberId;
    assert.deepEqual(await list(), [
      {
        employee: { id: ada.id, name: "Ada", slug: "ada", role: "Analyst", avatarKey: null },
        accessLevel: "write",
        isDefault: true,
      },
      {
        employee: { id: bob.id, name: "Bob", slug: "bob", role: "Researcher", avatarKey: null },
        accessLevel: "write",
        isDefault: true,
      },
    ]);
  });

  test("lists only this company's employees and reflects stored levels", async () => {
    await put(ada.id, "read");
    await call(
      "PUT",
      `/resources/ai-access/${outsider.id}`,
      { accessLevel: "read" },
      otherCompany.id,
    );
    const rows = await list();
    assert.deepEqual(
      rows.map((row) => [row.employee.name, row.accessLevel, row.isDefault]),
      [
        ["Ada", "read", false],
        ["Bob", "write", true],
      ],
    );
  });

  test("a company with no AI Employees lists nothing", async () => {
    const empty = await insert(Company, { name: "Empty", slug: "empty", ownerId });
    await insert(Membership, { companyId: empty.id, userId: ownerId, role: "owner" as Role });
    const res = await call<{ rows: Row[] }>("GET", "/resources/ai-access", undefined, empty.id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows, []);
  });

  test("is not answered by the Resource detail route, even beside a Resource slugged ai-access", async () => {
    // Slugs minted from now on skip `ai-access`, but an install upgraded from
    // before this page existed may still hold one.
    await insert(Resource, {
      companyId,
      title: "AI access",
      slug: "ai-access",
      sourceKind: "text",
      bodyText: "A policy document.",
      status: "ready",
    });
    const res = await call<{ rows?: Row[]; title?: string }>("GET", "/resources/ai-access");
    assert.equal(res.status, 200);
    assert.ok(
      Array.isArray(res.body.rows),
      `expected the access list, got ${JSON.stringify(res.body)}`,
    );
    assert.equal(res.body.title, undefined);
  });
});

describe("PUT /resources/ai-access/:employeeId", () => {
  test("an owner can set an employee to read only", async () => {
    const res = await put(ada.id, "read");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.row, {
      employee: { id: ada.id, name: "Ada", slug: "ada", role: "Analyst", avatarKey: null },
      accessLevel: "read",
      isDefault: false,
    });
    assert.equal(await getResourceLibraryAccess(ada.id), "read");
    assert.equal(await getResourceLibraryAccess(bob.id), "write", "only the named employee moved");
    const rows = await storedRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].companyId, companyId);
  });

  test("an admin can change access too", async () => {
    actingUserId = adminId;
    const res = await put(bob.id, "read");
    assert.equal(res.status, 200);
    assert.equal(res.body.row.accessLevel, "read");
  });

  test("a plain Member cannot change access, and nothing is written or audited", async () => {
    actingUserId = memberId;
    const res = await put(ada.id, "read");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin company role required");
    assert.deepEqual(await storedRows(), []);
    assert.deepEqual(await accessAudits(), []);
    assert.equal(await getResourceLibraryAccess(ada.id), "write");
  });

  test("a plain Member cannot restore read + write either", async () => {
    await put(ada.id, "read");
    actingUserId = memberId;
    const res = await put(ada.id, "write");
    assert.equal(res.status, 403);
    assert.equal(await getResourceLibraryAccess(ada.id), "read");
  });

  test("the guard folds case the way Express routing does", async () => {
    actingUserId = memberId;
    const res = await call("PUT", `/RESOURCES/AI-ACCESS/${ada.id}`, { accessLevel: "read" });
    assert.equal(res.status, 403);
    assert.equal(await getResourceLibraryAccess(ada.id), "write");
  });

  test("rejects an unauthenticated request", async () => {
    actingUserId = null;
    const res = await put(ada.id, "read");
    assert.equal(res.status, 401);
    assert.deepEqual(await storedRows(), []);
  });

  for (const accessLevel of ["edit", "delete", "none", "", "READ", "Write", 1, null, true]) {
    test(`rejects accessLevel ${JSON.stringify(accessLevel)} as a validation error`, async () => {
      const res = await put(ada.id, accessLevel);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "ValidationError");
      assert.deepEqual(await storedRows(), []);
    });
  }

  test("rejects a missing accessLevel and unknown keys", async () => {
    const missing = await call("PUT", `/resources/ai-access/${ada.id}`, {});
    assert.equal(missing.status, 400);
    const extra = await call("PUT", `/resources/ai-access/${ada.id}`, {
      accessLevel: "read",
      companyId: otherCompany.id,
    });
    assert.equal(extra.status, 400);
    const noBody = await call("PUT", `/resources/ai-access/${ada.id}`);
    assert.equal(noBody.status, 400);
    assert.deepEqual(await storedRows(), []);
  });

  test("rejects an employee id that is not a uuid", async () => {
    const res = await put("ada", "read");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "ValidationError");
  });

  test("an employee of another company is a 404, and its access is untouched", async () => {
    const res = await put(outsider.id, "read");
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Employee not found");
    assert.equal(await getResourceLibraryAccess(outsider.id), "write");
    assert.deepEqual(await storedRows(), []);
    assert.deepEqual(await accessAudits(), []);
  });

  test("an unknown employee is a 404", async () => {
    const res = await put("00000000-0000-4000-8000-000000000000", "read");
    assert.equal(res.status, 404);
    assert.deepEqual(await storedRows(), []);
  });

  test("records who changed what in the audit log", async () => {
    await put(ada.id, "read");
    const [event] = await accessAudits();
    assert.equal(event.companyId, companyId);
    assert.equal(event.actorKind, "user");
    assert.equal(event.actorUserId, ownerId);
    assert.equal(event.actorEmployeeId, null);
    assert.equal(event.targetType, "employee");
    assert.equal(event.targetId, ada.id);
    assert.equal(event.targetLabel, "Ada");
    assert.deepEqual(JSON.parse(event.metadataJson ?? "{}"), {
      accessLevel: "read",
      previousAccessLevel: "write",
    });
  });

  test("restoring read + write is audited with the level it replaced", async () => {
    await put(ada.id, "read");
    actingUserId = adminId;
    const restored = await put(ada.id, "write");
    assert.equal(restored.status, 200);
    assert.equal(restored.body.row.accessLevel, "write");
    assert.equal(restored.body.row.isDefault, false);
    const events = await accessAudits();
    assert.equal(events.length, 2);
    assert.equal(events[1].actorUserId, adminId);
    assert.deepEqual(JSON.parse(events[1].metadataJson ?? "{}"), {
      accessLevel: "write",
      previousAccessLevel: "read",
    });
  });

  test("repeating a level is a successful no-op that is not audited again", async () => {
    const first = await put(ada.id, "read");
    const second = await put(ada.id, "read");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.row, first.body.row);
    assert.equal((await accessAudits()).length, 1);
    assert.equal((await storedRows()).length, 1);
  });

  test("asking for read + write on an untouched employee writes and audits nothing", async () => {
    const res = await put(bob.id, "write");
    assert.equal(res.status, 200);
    assert.equal(res.body.row.accessLevel, "write");
    assert.equal(res.body.row.isDefault, true);
    assert.deepEqual(await storedRows(), []);
    assert.deepEqual(await accessAudits(), []);
  });

  test("changing access leaves every per-Resource Share grant exactly as it was", async () => {
    const resource = await insert(Resource, {
      companyId,
      title: "Handbook",
      slug: "handbook",
      sourceKind: "text",
      bodyText: "…",
      status: "ready",
    });
    await insert(EmployeeResourceGrant, {
      employeeId: ada.id,
      resourceId: resource.id,
      accessLevel: "delete",
    });
    await put(ada.id, "read");
    await put(ada.id, "write");
    const grants = await AppDataSource.getRepository(EmployeeResourceGrant).find({
      where: { employeeId: ada.id },
    });
    assert.deepEqual(
      grants.map((grant) => [grant.resourceId, grant.accessLevel]),
      [[resource.id, "delete"]],
    );
  });
});

describe("the admin guard stays on its own paths", () => {
  test("a plain Member still files, edits, shares, and deletes Resources", async () => {
    actingUserId = memberId;
    const created = await call<{ slug: string }>("POST", "/resources", {
      sourceKind: "text",
      title: "Member notes",
      body: "Written by a member.",
    });
    assert.equal(created.status, 201);
    const patched = await call("PATCH", `/resources/${created.body.slug}`, { summary: "Edited" });
    assert.equal(patched.status, 200);
    const shared = await call<{ accessLevel: string }>(
      "POST",
      `/resources/${created.body.slug}/grants`,
      { employeeId: ada.id, accessLevel: "edit" },
    );
    assert.equal(shared.status, 200);
    assert.equal(shared.body.accessLevel, "edit");
    const removed = await call("DELETE", `/resources/${created.body.slug}`);
    assert.equal(removed.status, 200);
  });

  test("does not leak onto a router mounted after resources", async () => {
    actingUserId = memberId;
    const res = await call("POST", "/sibling-after-resources", {});
    assert.equal(res.status, 201);
  });
});

describe("Resources filed from now on never take the section's own slugs", () => {
  test("a Resource titled “AI access” is filed as ai-access-2 and stays reachable", async () => {
    const created = await call<{ slug: string }>("POST", "/resources", {
      sourceKind: "text",
      title: "AI access",
      body: "Our policy on AI access.",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.slug, "ai-access-2");
    const detail = await call<{ title: string }>("GET", "/resources/ai-access-2");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.title, "AI access");
    // And the page's own route still answers with the access list.
    assert.ok(
      Array.isArray((await call<{ rows: Row[] }>("GET", "/resources/ai-access")).body.rows),
    );
  });

  test("a Resource titled “Integrations” is filed as integrations-2", async () => {
    const created = await call<{ slug: string }>("POST", "/resources", {
      sourceKind: "text",
      title: "Integrations",
      body: "Which tools we connect.",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.slug, "integrations-2");
  });
});

describe("firing an AI Employee", () => {
  test("takes its Resources access row with it", async () => {
    await put(ada.id, "read");
    await put(bob.id, "read");
    const fired = await call("DELETE", `/employees/${ada.id}`);
    assert.equal(fired.status, 200);
    const rows = await storedRows();
    assert.deepEqual(
      rows.map((row) => row.employeeId),
      [bob.id],
    );
    assert.deepEqual(
      (await list()).map((row) => row.employee.name),
      ["Bob"],
    );
  });
});
