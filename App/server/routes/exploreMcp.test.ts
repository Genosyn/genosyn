import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { EmployeeBaseGrant } from "../db/entities/EmployeeBaseGrant.js";
import { EmployeeChartGrant } from "../db/entities/EmployeeChartGrant.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { EmployeeDashboardGrant } from "../db/entities/EmployeeDashboardGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let postgres: IntegrationConnection;
let stripe: IntegrationConnection;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
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
  company = await insert(Company, {
    name: "Acme Analytics",
    slug: "acme-analytics",
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Data analyst",
    slug: "data-analyst",
    role: "Data analyst",
    soulBody: "",
  });
  postgres = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "postgres",
    label: "Warehouse",
    authMode: "apikey",
    encryptedConfig: "unused-in-these-tests",
    accountHint: "warehouse.example.test · analytics",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
  stripe = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "stripe",
    label: "Billing",
    authMode: "apikey",
    encryptedConfig: "unused-in-these-tests",
    accountHint: "acct_test",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function aiCall<T = Record<string, unknown>>(
  tool: string,
  body: unknown = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

async function grant(connection: IntegrationConnection): Promise<void> {
  await insert(EmployeeConnectionGrant, {
    employeeId: employee.id,
    connectionId: connection.id,
  });
}

async function createChart(): Promise<ApiResponse<{ chart: { id: string; slug: string } }>> {
  return aiCall("create_chart", {
    title: "Revenue by month",
    connectionId: postgres.id,
    sql: "SELECT month, revenue FROM revenue_by_month",
    vizType: "line",
    vizConfig: { dimension: "month", measures: ["revenue"] },
  });
}

describe("Explore AI Connection access", () => {
  test("marks database tools grant-dead until an Explore Connection is granted", async () => {
    let dead = await deadToolNames(employee.id);
    for (const tool of ["get_explore_schema", "run_explore_query", "create_chart"]) {
      assert.equal(dead.has(tool), true, `${tool} should be grant-dead`);
    }
    assert.equal(dead.has("list_explore_connections"), false);
    assert.equal(dead.has("create_dashboard"), false);

    await grant(stripe);
    dead = await deadToolNames(employee.id);
    assert.equal(dead.has("run_explore_query"), true, "a non-Explore Connection must not count");

    await grant(postgres);
    dead = await deadToolNames(employee.id);
    for (const tool of ["get_explore_schema", "run_explore_query", "create_chart"]) {
      assert.equal(dead.has(tool), false, `${tool} should be live after the Grant`);
    }
  });

  test("lists only granted, Explore-compatible Connections", async () => {
    await grant(postgres);
    await grant(stripe);

    const response = await aiCall<{
      connections: Array<{
        id: string;
        provider: string;
        label: string;
        status: string;
        statusMessage: string;
      }>;
    }>("list_explore_connections");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.connections, [
      {
        id: postgres.id,
        provider: "postgres",
        label: "Warehouse",
        accountHint: "warehouse.example.test · analytics",
        status: "connected",
        statusMessage: "",
      },
    ]);
  });

  test("blocks schema inspection, ad-hoc SQL, and Chart creation without a Connection Grant", async () => {
    for (const [tool, body] of [
      ["get_explore_schema", { connectionId: postgres.id }],
      ["run_explore_query", { connectionId: postgres.id, sql: "SELECT 1" }],
      [
        "create_chart",
        { title: "Secret query", connectionId: postgres.id, sql: "SELECT * FROM secrets" },
      ],
    ] as const) {
      const response = await aiCall<{ error: string }>(tool, body);
      assert.equal(response.status, 403, tool);
      assert.match(response.body.error, /No grant/, tool);
    }
    assert.equal(await AppDataSource.getRepository(Chart).count(), 0);
  });
});

describe("Explore AI authoring", () => {
  test("creates a Chart and grants its AI author write access", async () => {
    await grant(postgres);
    const response = await createChart();

    assert.equal(response.status, 200);
    assert.equal(response.body.chart.slug, "revenue-by-month");
    const chart = await AppDataSource.getRepository(Chart).findOneByOrFail({
      id: response.body.chart.id,
    });
    assert.equal(chart.createdByEmployeeId, employee.id);
    assert.equal(chart.connectionId, postgres.id);
    const chartGrant = await AppDataSource.getRepository(EmployeeChartGrant).findOneByOrFail({
      employeeId: employee.id,
      chartId: chart.id,
    });
    assert.equal(chartGrant.accessLevel, "write");
  });

  test("requires the Connection Grant when changing a Chart's SQL", async () => {
    await grant(postgres);
    const created = await createChart();
    await AppDataSource.getRepository(EmployeeConnectionGrant).delete({
      employeeId: employee.id,
      connectionId: postgres.id,
    });

    const response = await aiCall<{ error: string }>("update_chart", {
      chartSlug: created.body.chart.slug,
      sql: "SELECT * FROM a_different_table",
    });

    assert.equal(response.status, 403);
    assert.match(response.body.error, /No grant/);
    const chart = await AppDataSource.getRepository(Chart).findOneByOrFail({
      id: created.body.chart.id,
    });
    assert.equal(chart.sql, "SELECT month, revenue FROM revenue_by_month");
  });

  test("creates a Dashboard and pins an AI-authored Chart", async () => {
    await grant(postgres);
    const chart = await createChart();
    const dashboardResponse = await aiCall<{ dashboard: { id: string; slug: string } }>(
      "create_dashboard",
      { title: "Company pulse", description: "The metrics leadership watches" },
    );
    assert.equal(dashboardResponse.status, 200);

    const cardResponse = await aiCall<{ card: { id: string; chartId: string } }>(
      "add_dashboard_card",
      {
        dashboardSlug: dashboardResponse.body.dashboard.slug,
        chartSlug: chart.body.chart.slug,
      },
    );
    assert.equal(cardResponse.status, 200);
    assert.equal(cardResponse.body.card.chartId, chart.body.chart.id);

    const dashboard = await AppDataSource.getRepository(Dashboard).findOneByOrFail({
      id: dashboardResponse.body.dashboard.id,
    });
    assert.equal(dashboard.createdByEmployeeId, employee.id);
    assert.equal(
      await AppDataSource.getRepository(DashboardCard).countBy({ dashboardId: dashboard.id }),
      1,
    );
    const dashboardGrant = await AppDataSource.getRepository(
      EmployeeDashboardGrant,
    ).findOneByOrFail({
      employeeId: employee.id,
      dashboardId: dashboard.id,
    });
    assert.equal(dashboardGrant.accessLevel, "write");
  });

  test("dashboard access keeps formula bindings hidden from the Chart-granted AI surface", async () => {
    await grant(postgres);
    const chart = await createChart();
    const created = await aiCall<{ dashboard: { id: string; slug: string } }>("create_dashboard", {
      title: "Company pulse",
    });
    const card = await aiCall<{ card: { id: string } }>("add_dashboard_card", {
      dashboardSlug: created.body.dashboard.slug,
      chartSlug: chart.body.chart.slug,
    });
    await insert(DashboardCard, {
      dashboardId: created.body.dashboard.id,
      chartId: null,
      titleOverride: "Private calculation",
      formulaJson: JSON.stringify({
        expression: "A * 2",
        inputs: [{ name: "A", cardId: card.body.card.id }],
      }),
    });
    const visible = await aiCall<{ cards: { id: string }[] }>("get_dashboard", {
      dashboardSlug: created.body.dashboard.slug,
    });
    assert.equal(visible.status, 200);
    assert.deepEqual(
      visible.body.cards.map((entry) => entry.id),
      [card.body.card.id],
    );

    await AppDataSource.getRepository(EmployeeChartGrant).delete({
      employeeId: employee.id,
      chartId: chart.body.chart.id,
    });
    const hidden = await aiCall<{ cards: unknown[]; charts: unknown[] }>("get_dashboard", {
      dashboardSlug: created.body.dashboard.slug,
    });
    assert.equal(hidden.status, 200);
    assert.deepEqual(hidden.body.cards, []);
    assert.deepEqual(hidden.body.charts, []);
  });
});

/** A Base with one Deals table: two won deals and one lead. */
async function seedDeals() {
  const base = await insert(Base, {
    companyId: company.id,
    name: "Sales",
    slug: "sales",
    description: "",
    icon: "Database",
    color: "indigo",
    createdById: null,
  });
  const deals = await insert(BaseTable, {
    baseId: base.id,
    name: "Deals",
    slug: "deals",
    sortOrder: 1000,
  });
  const stage = await insert(BaseField, {
    tableId: deals.id,
    name: "Stage",
    type: "select",
    configJson: JSON.stringify({
      options: [
        { id: "lead", label: "Lead", color: "slate" },
        { id: "won", label: "Won", color: "emerald" },
      ],
    }),
    isPrimary: true,
    sortOrder: 1000,
  });
  for (const [index, value] of ["won", "won", "lead"].entries()) {
    await insert(BaseRecord, {
      tableId: deals.id,
      sortOrder: (index + 1) * 1000,
      dataJson: JSON.stringify({ [stage.id]: value }),
    });
  }
  const query = {
    tableId: deals.id,
    groupBy: { fieldId: stage.id },
    metrics: [{ aggregate: "count" }],
  };
  return { base, deals, stage, query };
}

describe("Explore AI charts over a Base", () => {
  test("offers create_chart to an employee holding only a Base Grant", async () => {
    const { base } = await seedDeals();
    assert.equal((await deadToolNames(employee.id)).has("create_chart"), true);
    await insert(EmployeeBaseGrant, { employeeId: employee.id, baseId: base.id });
    const dead = await deadToolNames(employee.id);
    assert.equal(dead.has("create_chart"), false);
    assert.equal(dead.has("run_explore_query"), true, "SQL tools still need a Connection Grant");
  });

  test("creates a Base chart only with a Grant on that Base, then runs it", async () => {
    const { base, query } = await seedDeals();
    const body = { title: "Deals by stage", baseSlug: "sales", baseQuery: query, vizType: "bar" };

    const refused = await aiCall<{ error: string }>("create_chart", body);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /No grant/);
    assert.equal(await AppDataSource.getRepository(Chart).count(), 0);

    await insert(EmployeeBaseGrant, { employeeId: employee.id, baseId: base.id });
    const created = await aiCall<{ chart: { slug: string; source: string; baseId: string } }>(
      "create_chart",
      body,
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.chart.source, "base");
    assert.equal(created.body.chart.baseId, base.id);

    const ran = await aiCall<{ rows: Record<string, unknown>[] }>("run_chart", {
      chartSlug: created.body.chart.slug,
    });
    assert.equal(ran.status, 200);
    assert.deepEqual(ran.body.rows, [
      { Stage: "Lead", Count: 1 },
      { Stage: "Won", Count: 2 },
    ]);
  });

  test("runs a teammate's Base chart it may read, but not over an archived table", async () => {
    const { base, deals, query } = await seedDeals();
    const chart = await insert(Chart, {
      companyId: company.id,
      title: "Deals by stage",
      slug: "deals-by-stage",
      description: "",
      connectionId: null,
      sql: "",
      baseId: base.id,
      baseQueryJson: JSON.stringify({ ...query, filters: [], sort: null, limit: null }),
      vizType: "bar",
      vizConfig: "{}",
      createdById: "owner-1",
      createdByEmployeeId: null,
    });
    await insert(EmployeeChartGrant, {
      employeeId: employee.id,
      chartId: chart.id,
      accessLevel: "read",
    });
    const ran = await aiCall<{ rows: unknown[] }>("run_chart", { chartSlug: chart.slug });
    assert.equal(ran.status, 200);
    assert.equal(ran.body.rows.length, 2);

    await AppDataSource.getRepository(BaseTable).update(
      { id: deals.id },
      { archivedAt: new Date() },
    );
    const archived = await aiCall<{ error: string }>("run_chart", { chartSlug: chart.slug });
    assert.equal(archived.status, 400);
    assert.match(archived.body.error, /archived/);
  });

  test("re-queries a Base chart only with the Base Grant, and never as SQL", async () => {
    const { base, stage, query } = await seedDeals();
    await insert(EmployeeBaseGrant, { employeeId: employee.id, baseId: base.id });
    const created = await aiCall<{ chart: { slug: string } }>("create_chart", {
      title: "Deals by stage",
      baseSlug: "sales",
      baseQuery: query,
    });
    const slug = created.body.chart.slug;

    const asSql = await aiCall<{ error: string }>("update_chart", {
      chartSlug: slug,
      sql: "SELECT 1",
    });
    assert.equal(asSql.status, 400);
    assert.match(asSql.body.error, /reads a Base, not SQL/);

    await AppDataSource.getRepository(EmployeeBaseGrant).delete({ employeeId: employee.id });
    const sorted = { ...query, sort: { by: "metric", direction: "desc" } };
    const refused = await aiCall<{ error: string }>("update_chart", {
      chartSlug: slug,
      baseQuery: sorted,
    });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /No grant/);

    await insert(EmployeeBaseGrant, { employeeId: employee.id, baseId: base.id });
    const updated = await aiCall<{ chart: { baseQuery: { sort: { by: string } } } }>(
      "update_chart",
      { chartSlug: slug, baseQuery: sorted },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.chart.baseQuery.sort.by, "metric");
    const ran = await aiCall<{ rows: Record<string, unknown>[] }>("run_chart", { chartSlug: slug });
    assert.deepEqual(ran.body.rows[0], { [stage.name]: "Won", Count: 2 });
  });
});
