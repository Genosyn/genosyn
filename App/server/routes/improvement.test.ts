import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { RunLesson } from "../db/entities/RunLesson.js";
import { Skill } from "../db/entities/Skill.js";
import { User } from "../db/entities/User.js";
import { AppDataSource } from "../db/datasource.js";
import { errorHandler } from "../middleware/error.js";
import { createRevisionProposal } from "../services/revisionProposals.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { improvementRouter } from "./improvement.js";

/**
 * The improvement-loop HTTP boundary: any Member may read lessons and the
 * proposal queue, only admins act on them, and a decided proposal stays
 * decided over the wire exactly as it does at the service layer.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let employee: AIEmployee;
let skill: Skill;
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
  app.use("/api/companies/:cid", improvementRouter);
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

async function member(email: string, role: Role, companyId: string): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId, userId: user.id, role });
  return user;
}

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
  owner = await member("owner@example.com", "owner" as Role, company.id);
  viewer = await member("viewer@example.com", "member" as Role, company.id);
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "Be direct.",
  });
  skill = await insert(Skill, {
    employeeId: employee.id,
    name: "Digest writing",
    slug: "digest-writing",
    body: "Write short digests.",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Nightly digest",
    slug: "nightly-digest",
    cronExpr: "0 3 * * *",
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

async function addLesson(): Promise<RunLesson> {
  return insert(RunLesson, {
    companyId: company.id,
    employeeId: employee.id,
    routineId: routine.id,
    runId: "3b241101-e2bb-4255-8caf-4136c566a962",
    cause: "Wrong channel",
    advice: "Resolve the channel by name",
  });
}

describe("lessons over HTTP", () => {
  test("any member reads a routine's lessons; only admins dismiss", async () => {
    const lesson = await addLesson();
    actingUserId = viewer.id;
    const listed = await call<Array<{ id: string; dismissedAt: string | null }>>(
      "GET",
      `/run-lessons/routine/${routine.id}`,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].id, lesson.id);
    assert.equal((await call("POST", `/run-lessons/${lesson.id}/dismiss`)).status, 403);
    actingUserId = owner.id;
    assert.equal((await call("POST", `/run-lessons/${lesson.id}/dismiss`)).status, 200);
    const after = await AppDataSource.getRepository(RunLesson).findOneByOrFail({ id: lesson.id });
    assert.ok(after.dismissedAt);
  });
});

describe("revision proposals over HTTP", () => {
  async function propose() {
    return createRevisionProposal(company.id, employee.id, {
      kind: "skill",
      targetId: skill.id,
      proposedBody: "Write short digests. Name sources.",
      rationale: "Two off-goal runs missed the source thread.",
    });
  }

  test("members read the queue; only admins apply or reject", async () => {
    const proposal = await propose();
    actingUserId = viewer.id;
    const listed = await call<Array<{ id: string; status: string }>>(
      "GET",
      "/revision-proposals?status=pending",
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].id, proposal.id);
    assert.equal((await call("POST", `/revision-proposals/${proposal.id}/apply`, {})).status, 403);
    assert.equal((await call("POST", `/revision-proposals/${proposal.id}/reject`, {})).status, 403);
  });

  test("apply writes the body and reports the applied row", async () => {
    const proposal = await propose();
    const applied = await call<{ status: string }>(
      "POST",
      `/revision-proposals/${proposal.id}/apply`,
      { note: "Good." },
    );
    assert.equal(applied.status, 200);
    assert.equal(applied.body.status, "applied");
    const fresh = await AppDataSource.getRepository(Skill).findOneByOrFail({ id: skill.id });
    assert.match(fresh.body, /Name sources/);
  });

  test("drift surfaces as a 400 whose message says what happened", async () => {
    const proposal = await propose();
    skill.body = "Edited by a human meanwhile.";
    await AppDataSource.getRepository(Skill).save(skill);
    const refused = await call<{ error: string }>(
      "POST",
      `/revision-proposals/${proposal.id}/apply`,
      {},
    );
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /changed since/);
  });

  test("an unknown status filter is refused, and a decided row refuses a second decision", async () => {
    const proposal = await propose();
    assert.equal((await call("GET", "/revision-proposals?status=weird")).status, 400);
    assert.equal(
      (await call("POST", `/revision-proposals/${proposal.id}/reject`, { note: "No." })).status,
      200,
    );
    assert.equal(
      (await call("POST", `/revision-proposals/${proposal.id}/apply`, {})).status,
      400,
    );
  });
});
