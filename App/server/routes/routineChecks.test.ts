import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { RunCheckResult } from "../db/entities/RunCheckResult.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { invalidateBillingSettingsCache } from "../services/billing/billingSettings.js";
import { invalidateLicenseCache } from "../services/license.js";
import { MAX_CHECKS_PER_ROUTINE } from "../services/routineChecks.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { auditRouter } from "./audit.js";
import { routineChecksRouter } from "./routineChecks.js";

/**
 * M58's evidence surface at the HTTP boundary.
 *
 * The audit router is mounted alongside deliberately: the one thing this file
 * has to prove that no single-router test could is the asymmetry between the
 * company's whole history (a paid feature) and one Run's own ledger (not),
 * and that only means something if both are asked in the same process, of the
 * same company, by the same person.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let employee: AIEmployee;
let routine: Routine;
let owner: User;
let viewer: User;

/** A second company's Routine, for the cross-company 404. */
let foreignRoutine: Routine;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", routineChecksRouter);
  app.use("/api/companies/:cid", auditRouter);
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
});

beforeEach(async () => {
  await resetTestDb();
  invalidateBillingSettingsCache();
  invalidateLicenseCache();

  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  viewer = await insert(User, {
    email: "viewer@example.com",
    name: "Viewer",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: viewer.id, role: "member" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Collections",
    slug: "collections",
    cronExpr: "0 9 * * *",
    body: "",
  });

  const otherCompany = await insert(Company, {
    name: "Other",
    slug: "other",
    ownerId: founder.id,
  });
  const otherEmployee = await insert(AIEmployee, {
    companyId: otherCompany.id,
    name: "Bob",
    slug: "bob",
    role: "Analyst",
    soulBody: "",
  });
  foreignRoutine = await insert(Routine, {
    employeeId: otherEmployee.id,
    name: "Theirs",
    slug: "theirs",
    cronExpr: "0 9 * * *",
    body: "",
  });

  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type SerializedCheck = {
  id: string;
  name: string;
  kind: string;
  spec: string;
  required: boolean;
  enabled: boolean;
  position: number;
};

/** Every `effect` check in this file — `command` needs a sandbox the tests have no business assuming. */
function effectSpec(action: string, min = 1): string {
  return JSON.stringify({ action, min });
}

async function createCheck(name: string, action = "invoice.send"): Promise<SerializedCheck> {
  const created = await call<SerializedCheck>("POST", `/routines/${routine.id}/checks`, {
    name,
    kind: "effect",
    spec: effectSpec(action),
  });
  assert.equal(created.status, 200);
  return created.body;
}

/**
 * Every audit action this company recorded, sorted rather than in insertion
 * order: `createdAt` has second resolution and the tie-break is a uuid, so a
 * burst of writes inside one test has no stable order to assert on. What
 * matters here is that each mutation wrote exactly one row of the right kind.
 */
async function auditActions(): Promise<string[]> {
  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where: { companyId: company.id },
  });
  return rows.map((r) => r.action).sort();
}

describe("authoring the bar", () => {
  test("an admin writes checks; a member may read every one of them and write none", async () => {
    const check = await createCheck("An invoice went out");

    actingUserId = viewer.id;
    const listed = await call<{
      checks: SerializedCheck[];
      commandChecks: { available: boolean };
      max: number;
    }>("GET", `/routines/${routine.id}/checks`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.checks.length, 1);
    assert.equal(listed.body.checks[0].id, check.id);
    assert.equal(listed.body.max, MAX_CHECKS_PER_ROUTINE);
    assert.equal(typeof listed.body.commandChecks.available, "boolean");

    // The graded party cannot author the bar, and neither can a Member: every
    // one of these is admin-only.
    assert.equal(
      (
        await call("POST", `/routines/${routine.id}/checks`, {
          name: "mine",
          kind: "effect",
          spec: effectSpec("mail.send"),
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("PATCH", `/routines/${routine.id}/checks/${check.id}`, { enabled: false }))
        .status,
      403,
    );
    assert.equal((await call("DELETE", `/routines/${routine.id}/checks/${check.id}`)).status, 403);
    assert.equal(
      (await call("POST", `/routines/${routine.id}/checks/reorder`, { orderedIds: [check.id] }))
        .status,
      403,
    );
  });

  test("patch, reorder and delete all land, and each writes its audit row", async () => {
    const first = await createCheck("First", "invoice.send");
    const second = await createCheck("Second", "mail.send");
    assert.equal(first.position < second.position, true);

    const patched = await call<SerializedCheck>(
      "PATCH",
      `/routines/${routine.id}/checks/${first.id}`,
      { name: "Renamed", required: false },
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.name, "Renamed");
    assert.equal(patched.body.required, false);

    const reordered = await call<{ checks: SerializedCheck[] }>(
      "POST",
      `/routines/${routine.id}/checks/reorder`,
      { orderedIds: [second.id, first.id] },
    );
    assert.equal(reordered.status, 200);
    assert.deepEqual(
      reordered.body.checks.map((c) => c.id),
      [second.id, first.id],
    );

    assert.equal((await call("DELETE", `/routines/${routine.id}/checks/${first.id}`)).status, 200);
    const remaining = await call<{ checks: SerializedCheck[] }>(
      "GET",
      `/routines/${routine.id}/checks`,
    );
    assert.equal(remaining.body.checks.length, 1);

    assert.deepEqual(await auditActions(), [
      "routine_check.create",
      "routine_check.create",
      "routine_check.delete",
      "routine_check.reorder",
      "routine_check.update",
    ]);
  });

  test("a bad kind and an unreadable effect spec are both refused at the boundary", async () => {
    const badKind = await call<{ error: string }>("POST", `/routines/${routine.id}/checks`, {
      name: "vibes",
      kind: "vibes",
      spec: "anything",
    });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.body.error, "ValidationError");

    const notJson = await call<{ error: string }>("POST", `/routines/${routine.id}/checks`, {
      name: "not json",
      kind: "effect",
      spec: "at least one invoice please",
    });
    assert.equal(notJson.status, 400);
    assert.equal(notJson.body.error, "ValidationError");

    const noAction = await call<{ error: string }>("POST", `/routines/${routine.id}/checks`, {
      name: "no action",
      kind: "effect",
      spec: JSON.stringify({ min: 1 }),
    });
    assert.equal(noAction.status, 400);

    // A window nothing could satisfy is a check that can never pass.
    const impossible = await call<{ error: string }>("POST", `/routines/${routine.id}/checks`, {
      name: "impossible",
      kind: "effect",
      spec: JSON.stringify({ action: "invoice.send", min: 3, max: 1 }),
    });
    assert.equal(impossible.status, 400);

    assert.deepEqual(await auditActions(), []);
  });

  test("the per-Routine cap surfaces as a 400 with the reason", async () => {
    for (let i = 0; i < MAX_CHECKS_PER_ROUTINE; i++) {
      await createCheck(`Check ${i}`);
    }
    const overflow = await call<{ error: string }>("POST", `/routines/${routine.id}/checks`, {
      name: "one too many",
      kind: "effect",
      spec: effectSpec("invoice.send"),
    });
    assert.equal(overflow.status, 400);
    assert.match(overflow.body.error, /at most 10 checks/);
  });

  test("another company's Routine is 404, on reads and writes alike", async () => {
    assert.equal((await call("GET", `/routines/${foreignRoutine.id}/checks`)).status, 404);
    const written = await call("POST", `/routines/${foreignRoutine.id}/checks`, {
      name: "not mine",
      kind: "effect",
      spec: effectSpec("invoice.send"),
    });
    assert.equal(written.status, 404);
    assert.deepEqual(await auditActions(), []);
  });
});

describe("a Run's own evidence", () => {
  async function makeRun(): Promise<Run> {
    return insert(Run, {
      routineId: routine.id,
      startedAt: new Date(),
      status: "completed",
      logContent: "",
      exitCode: 0,
    });
  }

  test("check results come back in attempt order, so the remediation loop is visible", async () => {
    const run = await makeRun();
    await insert(RunCheckResult, {
      companyId: company.id,
      runId: run.id,
      checkId: null,
      name: "An invoice went out",
      kind: "effect",
      required: true,
      passed: false,
      detail: "0 matching effects, wanted at least 1",
      attempt: 1,
    });
    await insert(RunCheckResult, {
      companyId: company.id,
      runId: run.id,
      checkId: null,
      name: "An invoice went out",
      kind: "effect",
      required: true,
      passed: true,
      detail: "1 matching effect",
      attempt: 2,
    });

    actingUserId = viewer.id;
    const got = await call<{ results: Array<{ attempt: number; passed: boolean }> }>(
      "GET",
      `/routines/runs/${run.id}/checks`,
    );
    assert.equal(got.status, 200);
    assert.deepEqual(
      got.body.results.map((r) => [r.attempt, r.passed]),
      [
        [1, false],
        [2, true],
      ],
    );
  });

  test("effects return this Run's ledger rows and nobody else's", async () => {
    const run = await makeRun();
    const otherRun = await makeRun();
    const repo = AppDataSource.getRepository(AuditEvent);
    await repo.save(
      repo.create({
        companyId: company.id,
        actorKind: "ai",
        runId: run.id,
        action: "invoice.send",
        targetType: "invoice",
        targetId: null,
        targetLabel: "INV-1",
        metadataJson: "{}",
      }),
    );
    await repo.save(
      repo.create({
        companyId: company.id,
        actorKind: "ai",
        runId: otherRun.id,
        action: "mail.send",
        targetType: "mail",
        targetId: null,
        targetLabel: "not this Run",
        metadataJson: "{}",
      }),
    );
    // A row with no Run at all — a human's own edit — must not be attributed.
    await repo.save(
      repo.create({
        companyId: company.id,
        actorKind: "user",
        runId: null,
        action: "routine.update",
        targetType: "routine",
        targetId: routine.id,
        targetLabel: "Collections",
        metadataJson: "{}",
      }),
    );

    actingUserId = viewer.id;
    const got = await call<{
      effects: Array<{ action: string; targetLabel: string; at: string }>;
      total: number;
    }>("GET", `/routines/runs/${run.id}/effects`);
    assert.equal(got.status, 200);
    assert.equal(got.body.total, 1);
    assert.equal(got.body.effects.length, 1);
    assert.equal(got.body.effects[0].action, "invoice.send");
    assert.equal(got.body.effects[0].targetLabel, "INV-1");
    assert.ok(!Number.isNaN(Date.parse(got.body.effects[0].at)));

    assert.equal((await call("GET", `/routines/runs/${run.id}/effects?limit=0`)).status, 400);
  });

  test("an unknown Run is 404 on both evidence endpoints", async () => {
    const nowhere = "00000000-0000-4000-8000-000000000000";
    assert.equal((await call("GET", `/routines/runs/${nowhere}/checks`)).status, 404);
    assert.equal((await call("GET", `/routines/runs/${nowhere}/effects`)).status, 404);
  });

  test("one Run's effects are readable without the auditLog entitlement; the company's history is not", async () => {
    const run = await makeRun();
    const repo = AppDataSource.getRepository(AuditEvent);
    await repo.save(
      repo.create({
        companyId: company.id,
        actorKind: "ai",
        runId: run.id,
        action: "invoice.send",
        targetType: "invoice",
        targetId: null,
        targetLabel: "INV-1",
        metadataJson: "{}",
      }),
    );

    // Same company, same admin, same process — the only difference is which
    // question is being asked. Browsing everything is the paid feature (M56);
    // reading what one Run did is part of trusting the Run at all, and M58's
    // whole thesis collapses on a Community install if it is not.
    const history = await call<{ error: string }>("GET", "/audit");
    assert.equal(history.status, 402);

    const evidence = await call<{ effects: unknown[]; total: number }>(
      "GET",
      `/routines/runs/${run.id}/effects`,
    );
    assert.equal(evidence.status, 200);
    assert.equal(evidence.body.total, 1);

    // And it stays reachable for an ordinary Member, who could never read the
    // company-wide log even on a plan that included it.
    actingUserId = viewer.id;
    assert.equal((await call("GET", `/routines/runs/${run.id}/effects`)).status, 200);
    assert.equal((await call("GET", "/audit")).status, 403);
  });
});
