import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeWakeup } from "../db/entities/EmployeeWakeup.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { Workstream } from "../db/entities/Workstream.js";
import { AppDataSource } from "../db/datasource.js";
import { errorHandler } from "../middleware/error.js";
import { proposeInitiative } from "../services/initiatives.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { reactivityRouter } from "./reactivity.js";

/**
 * M54's HTTP boundary: member reads throughout, admin-gated mutations, kind
 * validation on Triggers, and an Initiative accepted over the wire creating
 * the Routine it promised.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let employee: AIEmployee;
let routine: Routine;

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
  app.use("/api/companies/:cid", reactivityRouter);
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

let owner: User;
let viewer: User;

beforeEach(async () => {
  await resetTestDb();
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

describe("triggers over HTTP", () => {
  test("admin creates with a validated kind; member reads with the vocabulary; member cannot write", async () => {
    const refused = await call<{ error: string }>("POST", "/routine-triggers", {
      routineId: routine.id,
      kind: "keystrokes",
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Unknown event kind/);

    const created = await call<{ id: string }>("POST", "/routine-triggers", {
      routineId: routine.id,
      kind: "deal",
    });
    assert.equal(created.status, 200);

    actingUserId = viewer.id;
    const listed = await call<{ kinds: string[]; triggers: Array<{ id: string }> }>(
      "GET",
      `/routine-triggers/routine/${routine.id}`,
    );
    assert.equal(listed.status, 200);
    assert.ok(listed.body.kinds.includes("deal"));
    assert.equal(listed.body.triggers.length, 1);
    assert.equal(
      (await call("POST", "/routine-triggers", { routineId: routine.id, kind: "deal" })).status,
      403,
    );
    assert.equal((await call("DELETE", `/routine-triggers/${created.body.id}`)).status, 403);
  });
});

describe("wakeups over HTTP", () => {
  test("member reads; admin cancels a pending one exactly once", async () => {
    const wakeup = await insert(EmployeeWakeup, {
      companyId: company.id,
      employeeId: employee.id,
      at: new Date(Date.now() + 60 * 60 * 1000),
      brief: "check the invoice",
      status: "pending",
    });
    actingUserId = viewer.id;
    const listed = await call<Array<{ id: string }>>("GET", `/wakeups/employee/${employee.id}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].id, wakeup.id);
    assert.equal((await call("POST", `/wakeups/${wakeup.id}/cancel`)).status, 403);
    actingUserId = owner.id;
    assert.equal((await call("POST", `/wakeups/${wakeup.id}/cancel`)).status, 200);
    assert.equal((await call("POST", `/wakeups/${wakeup.id}/cancel`)).status, 409);
  });
});

describe("workstreams over HTTP", () => {
  test("member reads; admin closes with a reason", async () => {
    const workstream = await insert(Workstream, {
      companyId: company.id,
      employeeId: employee.id,
      title: "Overdue invoices",
      stateDoc: "12 of 40",
      status: "active",
    });
    actingUserId = viewer.id;
    const listed = await call<Array<{ id: string }>>("GET", "/workstreams");
    assert.equal(listed.body[0].id, workstream.id);
    assert.equal(
      (
        await call("POST", `/workstreams/${workstream.id}/close`, {
          status: "done",
          reason: "x",
        })
      ).status,
      403,
    );
    actingUserId = owner.id;
    const closed = await call<{ status: string; closeReason: string }>(
      "POST",
      `/workstreams/${workstream.id}/close`,
      { status: "abandoned", reason: "Superseded by the new billing flow." },
    );
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "abandoned");
    assert.match(closed.body.closeReason, /Superseded/);
  });
});

describe("initiatives over HTTP", () => {
  test("accept creates the promised routine; a second decision conflicts", async () => {
    const initiative = await proposeInitiative({
      companyId: company.id,
      employeeId: employee.id,
      title: "Stale deals go unchased",
      evidence: "Eleven deals sat untouched past 14 days.",
      proposal: "A weekly sweep pays for itself.",
      routineSpec: {
        name: "Weekly stale-deal sweep",
        cronExpr: "0 9 * * 1",
        body: "Chase every stale deal.",
      },
    });
    actingUserId = viewer.id;
    assert.equal((await call("POST", `/initiatives/${initiative.id}/accept`, {})).status, 403);
    actingUserId = owner.id;
    const accepted = await call<{ status: string; createdRoutineId: string }>(
      "POST",
      `/initiatives/${initiative.id}/accept`,
      { note: "Do it." },
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, "accepted");
    const created = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: accepted.body.createdRoutineId,
    });
    assert.equal(created.name, "Weekly stale-deal sweep");
    assert.equal(
      (await call("POST", `/initiatives/${initiative.id}/decline`, {})).status,
      400,
    );
  });
});
