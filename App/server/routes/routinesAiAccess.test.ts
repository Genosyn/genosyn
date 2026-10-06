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
import { EmployeeRoutineGrant } from "../db/entities/EmployeeRoutineGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { getRoutineAccess } from "../services/routineAccess.js";
import { stopStanddowns } from "../services/standdowns.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";
import { routinesRouter } from "./routines.js";

/**
 * Routines → AI access over HTTP: the roster every Member can read, the level
 * only owners and admins can change, and the audit trail a change leaves.
 *
 * The router is booted on a real socket because two of the failures this file
 * guards against only exist there: `GET /routines/ai-access` being answered by
 * `GET /routines/:rid` (registration order), and the admin guard leaking onto a
 * router mounted after this one (`onRoutePaths`).
 */

let server: Server;
let baseUrl: string;

/** Whose session the next request carries. Mutated per test. */
let actingUserId: string | null = null;

/** A router mounted *after* routines at the same prefix, as in `server/index.ts`. */
const siblingRouter = Router({ mergeParams: true });
siblingRouter.use(requireAuth);
siblingRouter.use(requireCompanyMember);
siblingRouter.post("/sibling-after-routines", (_req, res) => {
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
  app.use("/api/companies/:cid", routinesRouter);
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
  stopStanddowns();
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
  accessLevel: "run" | "write";
  isDefault: boolean;
};

async function list(): Promise<Row[]> {
  const res = await call<{ rows: Row[] }>("GET", "/routines/ai-access");
  assert.equal(res.status, 200);
  return res.body.rows;
}

async function put(employeeId: string, accessLevel: unknown) {
  return call<{ row: Row; error?: string }>("PUT", `/routines/ai-access/${employeeId}`, {
    accessLevel,
  });
}

async function accessAudits() {
  return AppDataSource.getRepository(AuditEvent).find({
    where: { action: "routine.ai_access.update" },
    order: { createdAt: "ASC" },
  });
}

async function storedRows() {
  return AppDataSource.getRepository(EmployeeRoutineGrant).find();
}

async function routineFor(employee: AIEmployee, slug = "weekly-report") {
  return insert(Routine, {
    employeeId: employee.id,
    name: "Weekly report",
    slug,
    cronExpr: "0 9 * * 1",
    enabled: true,
    body: "Write the weekly report.",
  });
}

describe("GET /routines/ai-access", () => {
  test("rejects an unauthenticated request", async () => {
    actingUserId = null;
    const res = await call("GET", "/routines/ai-access");
    assert.equal(res.status, 401);
  });

  test("rejects a user who is not a member of the company", async () => {
    const stranger = await user("stranger@example.com", "Stranger");
    actingUserId = stranger.id;
    const res = await call("GET", "/routines/ai-access");
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
    await put(ada.id, "run");
    await call(
      "PUT",
      `/routines/ai-access/${outsider.id}`,
      { accessLevel: "run" },
      otherCompany.id,
    );
    const rows = await list();
    assert.deepEqual(
      rows.map((row) => [row.employee.name, row.accessLevel, row.isDefault]),
      [
        ["Ada", "run", false],
        ["Bob", "write", true],
      ],
    );
    const other = await call<{ rows: Row[] }>(
      "GET",
      "/routines/ai-access",
      undefined,
      otherCompany.id,
    );
    assert.deepEqual(
      other.body.rows.map((row) => [row.employee.name, row.accessLevel]),
      [["Outsider", "run"]],
    );
  });

  test("a company with no AI Employees lists nothing", async () => {
    const empty = await insert(Company, { name: "Empty", slug: "empty", ownerId });
    await insert(Membership, { companyId: empty.id, userId: ownerId, role: "owner" as Role });
    const res = await call<{ rows: Row[] }>("GET", "/routines/ai-access", undefined, empty.id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.rows, []);
  });

  test("is not answered by the Routine detail route", async () => {
    await routineFor(ada);
    const res = await call<{ rows?: Row[]; name?: string; error?: string }>(
      "GET",
      "/routines/ai-access",
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.rows), `expected the roster, got ${JSON.stringify(res.body)}`);
    assert.equal(res.body.name, undefined);
    // And the detail route still answers for a real Routine.
    const [routine] = await AppDataSource.getRepository(Routine).find();
    const detail = await call<{ id: string }>("GET", `/routines/${routine.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, routine.id);
  });

  test("a company id that is not one of the caller's companies never reaches the roster", async () => {
    // Membership is checked before the handler's own validation, so a slug or
    // a stranger's id is refused without listing anything.
    for (const cid of ["acme", "00000000-0000-4000-8000-000000000000"]) {
      const res = await call<{ rows?: Row[] }>("GET", "/routines/ai-access", undefined, cid);
      assert.equal(res.status, 403, cid);
      assert.equal(res.body.rows, undefined);
    }
  });
});

describe("PUT /routines/ai-access/:employeeId", () => {
  test("an owner can hold an employee to read + run", async () => {
    const res = await put(ada.id, "run");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.row, {
      employee: { id: ada.id, name: "Ada", slug: "ada", role: "Analyst", avatarKey: null },
      accessLevel: "run",
      isDefault: false,
    });
    assert.equal(await getRoutineAccess(ada.id), "run");
    assert.equal(await getRoutineAccess(bob.id), "write", "only the named employee moved");
    const rows = await storedRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].companyId, companyId);
  });

  test("an admin can change access too", async () => {
    actingUserId = adminId;
    const res = await put(bob.id, "run");
    assert.equal(res.status, 200);
    assert.equal(res.body.row.accessLevel, "run");
  });

  test("a plain Member cannot change access, and nothing is written or audited", async () => {
    actingUserId = memberId;
    const res = await put(ada.id, "run");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "admin company role required");
    assert.deepEqual(await storedRows(), []);
    assert.deepEqual(await accessAudits(), []);
    assert.equal(await getRoutineAccess(ada.id), "write");
  });

  test("a plain Member cannot restore read + write either", async () => {
    await put(ada.id, "run");
    actingUserId = memberId;
    const res = await put(ada.id, "write");
    assert.equal(res.status, 403);
    assert.equal(await getRoutineAccess(ada.id), "run");
  });

  test("the guard folds case the way Express routing does", async () => {
    actingUserId = memberId;
    const res = await call("PUT", `/ROUTINES/AI-ACCESS/${ada.id}`, { accessLevel: "run" });
    assert.equal(res.status, 403);
    assert.equal(await getRoutineAccess(ada.id), "write");
  });

  test("rejects an unauthenticated request", async () => {
    actingUserId = null;
    const res = await put(ada.id, "run");
    assert.equal(res.status, 401);
    assert.deepEqual(await storedRows(), []);
  });

  for (const accessLevel of [
    "read",
    "full",
    "none",
    "edit",
    "",
    "RUN",
    "Write",
    1,
    null,
    true,
    ["run"],
  ]) {
    test(`rejects accessLevel ${JSON.stringify(accessLevel)} as a validation error`, async () => {
      const res = await put(ada.id, accessLevel);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "ValidationError");
      assert.deepEqual(await storedRows(), []);
      assert.deepEqual(await accessAudits(), []);
    });
  }

  test("rejects a missing accessLevel, unknown keys, and no body", async () => {
    const missing = await call("PUT", `/routines/ai-access/${ada.id}`, {});
    assert.equal(missing.status, 400);
    const extra = await call("PUT", `/routines/ai-access/${ada.id}`, {
      accessLevel: "run",
      companyId: otherCompany.id,
    });
    assert.equal(extra.status, 400);
    const noBody = await call("PUT", `/routines/ai-access/${ada.id}`);
    assert.equal(noBody.status, 400);
    assert.deepEqual(await storedRows(), []);
  });

  test("rejects an employee id that is not a uuid", async () => {
    const res = await put("ada", "run");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "ValidationError");
  });

  test("an employee of another company is a 404, and its access is untouched", async () => {
    const res = await put(outsider.id, "run");
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Employee not found");
    assert.equal(await getRoutineAccess(outsider.id), "write");
    assert.deepEqual(await storedRows(), []);
    assert.deepEqual(await accessAudits(), []);
  });

  test("an unknown employee is a 404", async () => {
    const res = await put("00000000-0000-4000-8000-000000000000", "run");
    assert.equal(res.status, 404);
    assert.deepEqual(await storedRows(), []);
    assert.deepEqual(await accessAudits(), []);
  });

  test("records who changed what in the audit log", async () => {
    await put(ada.id, "run");
    const [event] = await accessAudits();
    assert.equal(event.companyId, companyId);
    assert.equal(event.actorKind, "user");
    assert.equal(event.actorUserId, ownerId);
    assert.equal(event.actorEmployeeId, null);
    assert.equal(event.targetType, "employee");
    assert.equal(event.targetId, ada.id);
    assert.equal(event.targetLabel, "Ada");
    assert.deepEqual(JSON.parse(event.metadataJson ?? "{}"), {
      accessLevel: "run",
      previousAccessLevel: "write",
    });
  });

  test("restoring read + write is audited with the level it replaced", async () => {
    await put(ada.id, "run");
    actingUserId = adminId;
    const restored = await put(ada.id, "write");
    assert.equal(restored.status, 200);
    assert.equal(restored.body.row.accessLevel, "write");
    assert.equal(restored.body.row.isDefault, false);
    // Matched by content, not position: both rows can share a createdAt second.
    const events = (await accessAudits()).map((event) => ({
      actorUserId: event.actorUserId,
      metadata: JSON.parse(event.metadataJson ?? "{}") as Record<string, string>,
    }));
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.find((event) => event.metadata.accessLevel === "write"),
      { actorUserId: adminId, metadata: { accessLevel: "write", previousAccessLevel: "run" } },
    );
    assert.deepEqual(
      events.find((event) => event.metadata.accessLevel === "run"),
      { actorUserId: ownerId, metadata: { accessLevel: "run", previousAccessLevel: "write" } },
    );
  });

  test("repeating a level is a successful no-op that is not audited again", async () => {
    const first = await put(ada.id, "run");
    const second = await put(ada.id, "run");
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

  test("an audit row of another company is never written for this one", async () => {
    await call(
      "PUT",
      `/routines/ai-access/${outsider.id}`,
      { accessLevel: "run" },
      otherCompany.id,
    );
    const [event] = await accessAudits();
    assert.equal(event.companyId, otherCompany.id);
    assert.equal(event.targetId, outsider.id);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({
        companyId,
        action: "routine.ai_access.update",
      }),
      0,
    );
  });
});

describe("Members' own Routine edits are unaffected", () => {
  test("an admin still edits, pauses, and deletes a read + run employee's Routine", async () => {
    await put(ada.id, "run");
    const routine = await routineFor(ada);
    actingUserId = adminId;
    const renamed = await call<{ name: string }>("PATCH", `/routines/${routine.id}`, {
      name: "Weekly summary",
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name, "Weekly summary");
    const paused = await call<{ enabled: boolean }>("PATCH", `/routines/${routine.id}`, {
      enabled: false,
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.enabled, false);
    const brief = await call("PUT", `/routines/${routine.id}/readme`, { content: "New brief." });
    assert.equal(brief.status, 200);
    const removed = await call("DELETE", `/routines/${routine.id}`);
    assert.equal(removed.status, 200);
    assert.equal(await AppDataSource.getRepository(Routine).countBy({ id: routine.id }), 0);
  });

  test("an admin still creates a Routine for a read + run employee", async () => {
    await put(ada.id, "run");
    const created = await call<{ name: string; employeeId: string }>(
      "POST",
      `/employees/${ada.id}/routines`,
      { name: "Monthly close", cronExpr: "0 9 1 * *" },
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.employeeId, ada.id);
  });
});

describe("the admin guard stays on its own paths", () => {
  test("does not leak onto a router mounted after routines", async () => {
    actingUserId = memberId;
    const res = await call("POST", "/sibling-after-routines", {});
    assert.equal(res.status, 201);
  });
});

describe("firing an AI Employee", () => {
  test("takes its Routines access row with it", async () => {
    await put(ada.id, "run");
    await put(bob.id, "run");
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
