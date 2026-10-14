import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeChartGrant } from "../db/entities/EmployeeChartGrant.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { Goal } from "../db/entities/Goal.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { Routine } from "../db/entities/Routine.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * What an AI Employee can do to the Goals that grade it, through the tools it
 * actually holds. It may report a number on a Goal it owns or one of its
 * Routines serves, and that report never settles the Goal; it may not change
 * what a Goal-bound Chart computes, or delete it, even with `write` on the
 * Chart and a Grant on its Connection.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let warehouse: IntegrationConnection;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: testId("founder") });
  await insert(Membership, { companyId: company.id, userId: testId("owner"), role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Growth analyst",
    soulBody: "",
  });
  warehouse = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "postgres",
    label: "Warehouse",
    authMode: "apikey",
    encryptedConfig: "unused-in-these-tests",
    accountHint: "warehouse.example.test",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function aiCall<T = Record<string, unknown>>(
  tool: string,
  body: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function goal(over: Partial<Goal> = {}): Promise<Goal> {
  return insert(Goal, {
    companyId: company.id,
    title: "Signups",
    slug: "signups",
    targetValue: 10,
    ...over,
  });
}

async function stored(id: string): Promise<Goal> {
  return AppDataSource.getRepository(Goal).findOneByOrFail({ id });
}

type ReportResponse = {
  goal: { status: string; currentValue: number | null; awaitingConfirmation: boolean };
  note?: string;
  error?: string;
};

describe("update_goal_progress", () => {
  test("refuses a goal the employee neither owns nor serves", async () => {
    const northStar = await goal();
    const refused = await aiCall<ReportResponse>("update_goal_progress", {
      goal: northStar.slug,
      value: 12,
    });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error ?? "", /own or that one of your routines serves/);
    assert.equal((await stored(northStar.id)).currentValue, null);
  });

  test("a met number on an owned goal is recorded but waits for a person", async () => {
    const owned = await goal({ ownerEmployeeId: employee.id });
    const reported = await aiCall<ReportResponse>("update_goal_progress", {
      goal: owned.slug,
      value: 12,
      note: "Counted from the signup export",
    });
    assert.equal(reported.status, 200);
    assert.equal(reported.body.goal.status, "active");
    assert.equal(reported.body.goal.currentValue, 12);
    assert.equal(reported.body.goal.awaitingConfirmation, true);
    assert.match(reported.body.note ?? "", /until a person confirms it/);

    const after = await stored(owned.id);
    assert.equal(after.status, "active");
    assert.equal(after.settledAt, null);
    assert.equal(after.currentValueSource, "employee");
    const bells = await AppDataSource.getRepository(Notification).find();
    assert.deepEqual(
      bells.map((bell) => bell.kind),
      ["goal_confirmation_pending"],
    );
  });

  test("accepts a goal one of the employee's routines serves", async () => {
    const served = await goal();
    await insert(Routine, {
      employeeId: employee.id,
      name: "Weekly growth report",
      slug: "weekly-growth-report",
      cronExpr: "0 9 * * 1",
      goalId: served.id,
    });
    const reported = await aiCall<ReportResponse>("update_goal_progress", {
      goal: served.id,
      value: 4,
    });
    assert.equal(reported.status, 200);
    assert.equal(reported.body.goal.awaitingConfirmation, false);
    assert.equal(reported.body.note, undefined);
    assert.equal((await stored(served.id)).currentValue, 4);
  });
});

describe("Charts a goal reads", () => {
  const ORIGINAL_SQL = "SELECT count(*) FROM signups";

  async function writableChart(slug: string): Promise<Chart> {
    const chart = await insert(Chart, {
      companyId: company.id,
      title: slug,
      slug,
      connectionId: warehouse.id,
      sql: ORIGINAL_SQL,
    });
    await insert(EmployeeChartGrant, {
      employeeId: employee.id,
      chartId: chart.id,
      accessLevel: "write",
    });
    return chart;
  }

  beforeEach(async () => {
    // Every other requirement for changing SQL is met, so a refusal is the
    // goal rule and nothing else.
    await insert(EmployeeConnectionGrant, {
      employeeId: employee.id,
      connectionId: warehouse.id,
    });
  });

  test("update_chart refuses new SQL but keeps presentation edits", async () => {
    const chart = await writableChart("signups");
    await goal({ title: "Reach 10 signups", metricKind: "chart", chartId: chart.id });

    const refused = await aiCall<{ error: string }>("update_chart", {
      chartSlug: chart.slug,
      sql: "SELECT 1000000",
    });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /goal "Reach 10 signups"/);
    assert.match(refused.body.error, /only a person can change its SQL/);

    const retitled = await aiCall<{ chart: { title: string } }>("update_chart", {
      chartSlug: chart.slug,
      title: "Signups to date",
      sql: ORIGINAL_SQL,
    });
    assert.equal(retitled.status, 200);
    const after = await AppDataSource.getRepository(Chart).findOneByOrFail({ id: chart.id });
    assert.equal(after.sql, ORIGINAL_SQL);
    assert.equal(after.title, "Signups to date");
  });

  test("update_chart still changes the SQL of a chart no goal reads", async () => {
    const chart = await writableChart("pageviews");
    const changed = await aiCall("update_chart", {
      chartSlug: chart.slug,
      sql: "SELECT count(*) FROM pageviews",
    });
    assert.equal(changed.status, 200);
  });

  test("delete_chart refuses a chart a goal reads, even an archived one", async () => {
    const chart = await writableChart("signups");
    const bound = await goal({
      metricKind: "chart",
      chartId: chart.id,
      status: "archived",
    });
    const refused = await aiCall<{ error: string }>("delete_chart", { chartSlug: chart.slug });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /only a person can delete it/);
    assert.ok(await AppDataSource.getRepository(Chart).findOneBy({ id: chart.id }));
    assert.equal((await stored(bound.id)).chartId, chart.id);

    const unbound = await writableChart("pageviews");
    const deleted = await aiCall("delete_chart", { chartSlug: unbound.slug });
    assert.equal(deleted.status, 200);
    assert.equal(await AppDataSource.getRepository(Chart).findOneBy({ id: unbound.id }), null);
  });
});
