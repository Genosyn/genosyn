import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { applyRoutineRecommendations } from "../services/onboardingRecommendations.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

type RecommendationResponse = {
  context: {
    companyName: string;
    mission: string;
    vision: string;
    employeeName: string;
    employeeRole: string;
  };
  routines: Array<{
    id: string;
    name: string;
    summary: string;
    cronExpr: string;
    body: string;
    reasons: string[];
    status: "suggested" | "ready";
    routineId: string | null;
  }>;
  integrations: Array<{
    provider: string;
    name: string;
    tagline: string;
    icon: string;
    authMode: string;
    enabled: boolean;
    reason: string;
    status: "ready" | "grant_needed" | "connection_attention" | "connect_needed";
    connections: Array<{
      id: string;
      label: string;
      status: string;
      granted: boolean;
    }>;
  }>;
};

type ApplyResponse = {
  created: Array<Routine & { recommendationId: string }>;
  existing: Array<{ recommendationId: string; routineId: string }>;
};

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let owner: User;
let company: Company;
let employee: AIEmployee;

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
  app.use("/api/companies/:cid/employees", employeesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
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
  owner = await insert(User, {
    email: "onboarding-owner@example.com",
    name: "Onboarding Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Orbit Labs",
    slug: "orbit-labs",
    ownerId: owner.id,
    mission: "Help every customer adopt reliable software.",
    vision: "A world where preventable churn disappears.",
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ivy",
    slug: "ivy",
    role: "Software Engineer",
    soulBody: "# Ivy's Soul",
  });
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}/employees${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

async function apply(recommendationIds: string[]) {
  return call<ApplyResponse>("POST", `/${employee.id}/onboarding-recommendations/routines`, {
    recommendationIds,
  });
}

describe("AI Employee onboarding recommendation read route", () => {
  test("requires authentication", async () => {
    actingUserId = null;
    const response = await call<{ error: string }>(
      "GET",
      `/${employee.id}/onboarding-recommendations`,
    );

    assert.equal(response.status, 401);
    assert.equal(response.body.error, "Unauthorized");
  });

  test("returns exact company and employee context with actionable suggestions", async () => {
    const github = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "github",
      label: "Engineering",
      authMode: "oauth2",
      encryptedConfig: "encrypted",
      accountHint: "orbit-labs",
      status: "connected",
      statusMessage: "",
      lastCheckedAt: null,
    });
    await insert(EmployeeConnectionGrant, {
      employeeId: employee.id,
      connectionId: github.id,
    });

    const response = await call<RecommendationResponse>(
      "GET",
      `/${employee.id}/onboarding-recommendations?templateId=engineer`,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.context, {
      companyName: "Orbit Labs",
      mission: "Help every customer adopt reliable software.",
      vision: "A world where preventable churn disappears.",
      employeeName: "Ivy",
      employeeRole: "Software Engineer",
    });
    assert.equal(response.body.routines.length, 4);
    assert.equal(response.body.routines[0]?.id, "engineering-issue-triage");
    assert(response.body.routines.every((item) => item.status === "suggested"));
    assert(response.body.routines.every((item) => item.routineId === null));
    assert(response.body.routines.every((item) => item.body.includes("Orbit Labs")));
    assert(response.body.routines.every((item) => item.reasons.length > 0));
    assert(response.body.integrations.length <= 3);
    const githubRecommendation = response.body.integrations.find(
      (item) => item.provider === "github",
    );
    assert(githubRecommendation);
    assert.equal(githubRecommendation.status, "ready");
    assert.deepEqual(githubRecommendation.connections, [
      {
        id: github.id,
        label: "Engineering",
        status: "connected",
        granted: true,
      },
    ]);
    assert.equal(githubRecommendation.enabled, true);
    assert(githubRecommendation.name.length > 0);
    assert(githubRecommendation.tagline.length > 0);
    assert(githubRecommendation.icon.length > 0);
    assert(githubRecommendation.authMode.length > 0);
    assert(githubRecommendation.reason.length > 0);
  });

  test("rejects an unknown or malformed template hint", async () => {
    const unknown = await call<{ error: string }>(
      "GET",
      `/${employee.id}/onboarding-recommendations?templateId=not-a-template`,
    );
    const malformed = await call<{ error: string }>(
      "GET",
      `/${employee.id}/onboarding-recommendations?templateId=`,
    );

    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "Unknown template");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, "ValidationError");
  });

  test("validates the AI Employee route identifier", async () => {
    const badEmployee = await call<{ error: string }>(
      "GET",
      "/not-a-uuid/onboarding-recommendations",
    );

    assert.equal(badEmployee.status, 400);
    assert.equal(badEmployee.body.error, "ValidationError");
  });

  test("does not reveal an AI Employee from another company", async () => {
    const otherCompany = await insert(Company, {
      name: "Other Company",
      slug: "other-company",
      ownerId: owner.id,
      mission: "Other mission",
      vision: "Other vision",
    });
    await insert(Membership, {
      companyId: otherCompany.id,
      userId: owner.id,
      role: "owner" as Role,
    });
    const otherEmployee = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Other Employee",
      slug: "other-employee",
      role: "Research Analyst",
      soulBody: "",
    });

    const response = await call<{ error: string }>(
      "GET",
      `/${otherEmployee.id}/onboarding-recommendations`,
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.error, "Not found");
  });
});

describe("AI Employee onboarding recommendation apply route", () => {
  test("requires an admin role for mutation while keeping reads collaborative", async () => {
    const membership = await AppDataSource.getRepository(Membership).findOneByOrFail({
      companyId: company.id,
      userId: owner.id,
    });
    membership.role = "member";
    await AppDataSource.getRepository(Membership).save(membership);

    const read = await call<RecommendationResponse>(
      "GET",
      `/${employee.id}/onboarding-recommendations`,
    );
    const write = await apply(["daily-priority-check"]);

    assert.equal(read.status, 200);
    assert.equal(write.status, 403);
    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
  });

  test("rejects bad identifiers atomically before creating anything", async () => {
    const response = await apply(["daily-priority-check", "invented-recommendation"]);

    assert.equal(response.status, 400);
    assert.match((response.body as unknown as { error: string }).error, /invented-recommendation/);
    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  });

  test("validates non-empty batches and the five-id limit", async () => {
    const empty = await apply([]);
    const tooMany = await apply([
      "daily-priority-check",
      "weekly-outcome-review",
      "monthly-mission-check",
      "engineering-issue-triage",
      "weekly-metrics-digest",
      "daily-executive-brief",
    ]);

    assert.equal(empty.status, 400);
    assert.equal(tooMany.status, 400);
    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
  });

  test("creates full server-owned Routine bodies, schedules, and audit events", async () => {
    const response = await apply(["engineering-issue-triage", "weekly-outcome-review"]);

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.created.map((item) => item.recommendationId),
      ["engineering-issue-triage", "weekly-outcome-review"],
    );
    assert.deepEqual(response.body.existing, []);
    assert(response.body.created.every((item) => item.enabled));
    assert(response.body.created.every((item) => item.nextRunAt !== null));
    assert(response.body.created.every((item) => item.body.includes("## Company context")));
    assert(response.body.created.every((item) => item.body.includes(company.mission)));
    assert(response.body.created.every((item) => item.body.includes(company.vision)));

    const rows = await AppDataSource.getRepository(Routine).find({
      where: { employeeId: employee.id },
      order: { name: "ASC" },
    });
    assert.equal(rows.length, 2);
    assert(rows.every((item) => item.body.length > 300));
    assert(rows.every((item) => item.nextRunAt instanceof Date));

    const audits = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id, action: "routine.create" },
    });
    assert.equal(audits.length, 2);
    assert(
      audits.every((item) => JSON.parse(item.metadataJson).source === "onboarding-recommendation"),
    );
  });

  test("is idempotent across duplicate ids and repeated requests", async () => {
    const first = await apply([
      "daily-priority-check",
      "daily-priority-check",
      "weekly-outcome-review",
    ]);
    const second = await apply(["daily-priority-check", "weekly-outcome-review"]);

    assert.equal(first.status, 200);
    assert.equal(first.body.created.length, 2);
    assert.equal(first.body.existing.length, 0);
    assert.equal(second.status, 200);
    assert.equal(second.body.created.length, 0);
    assert.deepEqual(
      second.body.existing.map((item) => item.recommendationId),
      ["daily-priority-check", "weekly-outcome-review"],
    );
    assert.equal(await AppDataSource.getRepository(Routine).count(), 2);
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 2);
  });

  test("serializes concurrent SQLite applies without false failures or duplicate audits", async () => {
    const recommendationIds = ["daily-priority-check", "weekly-outcome-review"];
    const [first, second] = await Promise.all([apply(recommendationIds), apply(recommendationIds)]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual([first.body.created.length, second.body.created.length].sort(), [0, 2]);
    assert.deepEqual([first.body.existing.length, second.body.existing.length].sort(), [0, 2]);
    assert.equal(await AppDataSource.getRepository(Routine).count(), 2);
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 2);
  });

  test("never reports success from inside an unrelated SQLite transaction", async () => {
    let applyReturned = false;

    await assert.rejects(
      AppDataSource.transaction(async () => {
        await applyRoutineRecommendations({
          company,
          employee,
          recommendationIds: ["daily-priority-check"],
          actorUserId: owner.id,
        });
        applyReturned = true;
      }),
      /another SQLite transaction is active/,
    );

    assert.equal(applyReturned, false);
    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  });

  test("rolls Routine creation back when its audit row cannot be written", async () => {
    await AppDataSource.query(`
      CREATE TRIGGER fail_onboarding_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'routine.create'
      BEGIN
        SELECT RAISE(FAIL, 'audit failure');
      END
    `);

    await assert.rejects(
      applyRoutineRecommendations({
        company,
        employee,
        recommendationIds: ["daily-priority-check"],
        actorUserId: owner.id,
      }),
      /audit failure/,
    );

    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
    await AppDataSource.query("DROP TRIGGER fail_onboarding_audit");
  });

  test("deduplicates a legacy same-name Routine without replacing its content", async () => {
    const existing = await insert(Routine, {
      employeeId: employee.id,
      name: "Weekly pipeline hygiene",
      slug: "weekly-pipeline-hygiene",
      cronExpr: "0 7 * * 1",
      enabled: false,
      lastRunAt: null,
      nextRunAt: null,
      body: "Member-authored legacy body",
    });

    const response = await apply(["weekly-deal-hygiene"]);
    const preserved = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: existing.id,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.created, []);
    assert.deepEqual(response.body.existing, [
      { recommendationId: "weekly-deal-hygiene", routineId: existing.id },
    ]);
    assert.equal(preserved.body, "Member-authored legacy body");
    assert.equal(preserved.enabled, false);
  });

  test("does not create a Routine for an AI Employee outside the URL company", async () => {
    const otherCompany = await insert(Company, {
      name: "Other Company",
      slug: "other-company-apply",
      ownerId: owner.id,
      mission: "Other mission",
      vision: "Other vision",
    });
    await insert(Membership, {
      companyId: otherCompany.id,
      userId: owner.id,
      role: "owner" as Role,
    });
    const otherEmployee = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Other Employee",
      slug: "other-employee-apply",
      role: "Research Analyst",
      soulBody: "",
    });

    const response = await call<{ error: string }>(
      "POST",
      `/${otherEmployee.id}/onboarding-recommendations/routines`,
      { recommendationIds: ["competitive-research-scan"] },
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.error, "Not found");
    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
  });
});
