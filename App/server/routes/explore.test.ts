import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { Goal } from "../db/entities/Goal.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { exploreRouter } from "./explore.js";
import type { ChartDTO, DashboardCardDTO } from "../services/explore.js";
import { refreshGoalValue } from "../services/goals.js";
import type { ExploreFormula } from "../../shared/exploreFormula.js";

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let connection: IntegrationConnection;
let otherConnection: IntegrationConnection;
let unsupportedConnection: IntegrationConnection;

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
  app.use("/api/companies/:cid", exploreRouter);
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
  const owner = await insert(User, {
    email: "explore-owner@example.com",
    name: "Explore Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Acme Analytics",
    slug: "acme-analytics",
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "postgres",
    label: "Warehouse",
    authMode: "apikey",
    encryptedConfig: "not-needed-until-a-query-runs",
    accountHint: "analytics@example.test",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
  unsupportedConnection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "stripe",
    label: "Billing",
    authMode: "apikey",
    encryptedConfig: "unused",
    accountHint: "acct_test",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
  const otherCompany = await insert(Company, {
    name: "Other Co",
    slug: "other-co",
    ownerId: owner.id,
  });
  otherConnection = await insert(IntegrationConnection, {
    companyId: otherCompany.id,
    provider: "mysql",
    label: "Other Warehouse",
    authMode: "apikey",
    encryptedConfig: "unused",
    accountHint: "other",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
  });
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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

async function createChart(title = "Revenue by month") {
  return call<{
    id: string;
    slug: string;
    title: string;
    description: string;
    vizType: string;
    vizConfig: Record<string, unknown>;
  }>("POST", "/explore/charts", {
    title,
    description: "A saved analytical question",
    connectionId: connection.id,
    sql: "SELECT month, revenue FROM revenue_by_month",
    vizType: "line",
    vizConfig: { dimension: "month", measures: ["revenue"] },
  });
}

async function createDashboard() {
  return call<{ id: string; slug: string; title: string; description: string }>(
    "POST",
    "/explore/dashboards",
    { title: "Company pulse", description: "Metrics the whole company watches" },
  );
}

async function addNumberCard(dashboardSlug: string, title = "Total revenue") {
  const chart = await createChart(title);
  await AppDataSource.getRepository(Chart).update({ id: chart.body.id }, { vizType: "scalar" });
  return call<DashboardCardDTO>("POST", `/explore/dashboards/${dashboardSlug}/cards`, {
    chartId: chart.body.id,
  });
}

function formulaFor(cardId: string): ExploreFormula {
  return { expression: "A * 2", inputs: [{ name: "A", cardId }] };
}

describe("Explore Connection and schema boundaries", () => {
  test("lists only supported Connections in the active company", async () => {
    const response = await call<Array<{ id: string; provider: string; label: string }>>(
      "GET",
      "/explore/connections",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [
      {
        id: connection.id,
        provider: "postgres",
        label: "Warehouse",
        accountHint: "analytics@example.test",
        status: "connected",
      },
    ]);
  });

  test("validates the schema route's Connection id before touching a driver", async () => {
    const response = await call<{ error: string }>("GET", "/explore/connections/not-a-uuid/schema");
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
  });

  test("does not reveal a Connection belonging to another company", async () => {
    const response = await call<{ error: string }>(
      "GET",
      `/explore/connections/${otherConnection.id}/schema`,
    );
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "Connection not found");
  });

  test("rejects a non-database Connection without attempting its credentials", async () => {
    const response = await call<{ error: string }>(
      "GET",
      `/explore/connections/${unsupportedConnection.id}/schema`,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "Connection is not a supported Explore source");
  });
});

describe("Explore chart and dashboard authoring flow", () => {
  test("creates and serializes a Chart's visualization configuration", async () => {
    const response = await createChart();
    assert.equal(response.status, 201);
    assert.equal(response.body.slug, "revenue-by-month");
    assert.equal(response.body.vizType, "line");
    assert.deepEqual(response.body.vizConfig, {
      dimension: "month",
      measures: ["revenue"],
    });
    assert.equal(response.body.description, "A saved analytical question");
  });

  test("rejects unsupported visualizations at the API boundary", async () => {
    const response = await call<{ error: string }>("POST", "/explore/charts", {
      title: "Unsupported",
      connectionId: connection.id,
      sql: "SELECT 1",
      vizType: "funnel",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
  });

  test("creates a described Dashboard and counts its cards", async () => {
    const chart = await createChart();
    const dashboard = await createDashboard();
    assert.equal(dashboard.status, 201);
    assert.equal(dashboard.body.description, "Metrics the whole company watches");

    const added = await call<{ x: number; y: number; w: number; h: number }>(
      "POST",
      `/explore/dashboards/${dashboard.body.slug}/cards`,
      { chartId: chart.body.id },
    );
    assert.equal(added.status, 201);
    assert.deepEqual(
      { x: added.body.x, y: added.body.y, w: added.body.w, h: added.body.h },
      { x: 0, y: 0, w: 6, h: 4 },
    );

    const list = await call<Array<{ slug: string; cardCount: number }>>(
      "GET",
      "/explore/dashboards",
    );
    assert.equal(list.status, 200);
    assert.equal(list.body[0].cardCount, 1);
  });

  test("prevents the same Chart from being added twice", async () => {
    const chart = await createChart();
    const dashboard = await createDashboard();
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    assert.equal((await call("POST", path, { chartId: chart.body.id })).status, 201);
    const duplicate = await call<{ error: string }>("POST", path, { chartId: chart.body.id });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "Chart is already on this dashboard");
    assert.equal(await AppDataSource.getRepository(DashboardCard).count(), 1);
  });

  test("moves, resizes, and relabels a dashboard card", async () => {
    const chart = await createChart();
    const dashboard = await createDashboard();
    const added = await call<{ id: string }>(
      "POST",
      `/explore/dashboards/${dashboard.body.slug}/cards`,
      { chartId: chart.body.id },
    );
    const patched = await call<{
      x: number;
      y: number;
      w: number;
      h: number;
      titleOverride: string;
    }>("PATCH", `/explore/dashboards/${dashboard.body.slug}/cards/${added.body.id}`, {
      x: 3,
      y: 2,
      w: 9,
      h: 5,
      titleOverride: "MRR trend",
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(
      {
        x: patched.body.x,
        y: patched.body.y,
        w: patched.body.w,
        h: patched.body.h,
        titleOverride: patched.body.titleOverride,
      },
      { x: 3, y: 2, w: 9, h: 5, titleOverride: "MRR trend" },
    );
  });

  test("appends a new card below the existing layout", async () => {
    const first = await createChart("First chart");
    const second = await createChart("Second chart");
    const dashboard = await createDashboard();
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    await call("POST", path, { chartId: first.body.id, y: 3, h: 5 });
    const added = await call<{ y: number }>("POST", path, { chartId: second.body.id });
    assert.equal(added.status, 201);
    assert.equal(added.body.y, 8);
  });

  test("rejects card coordinates outside the 12-column grid", async () => {
    const chart = await createChart();
    const dashboard = await createDashboard();
    const response = await call<{ error: string }>(
      "POST",
      `/explore/dashboards/${dashboard.body.slug}/cards`,
      { chartId: chart.body.id, x: 12 },
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "ValidationError");
  });

  test("deleting a Chart detaches its dashboard cards", async () => {
    const chart = await createChart();
    const dashboard = await createDashboard();
    await call("POST", `/explore/dashboards/${dashboard.body.slug}/cards`, {
      chartId: chart.body.id,
    });
    assert.equal(await AppDataSource.getRepository(DashboardCard).count(), 1);

    const removed = await call("DELETE", `/explore/charts/${chart.body.slug}`);
    assert.equal(removed.status, 200);
    assert.equal(await AppDataSource.getRepository(Chart).count(), 0);
    assert.equal(await AppDataSource.getRepository(DashboardCard).count(), 0);
  });

  test("deleting a Chart a goal reads turns that goal manual, keeping its last value", async () => {
    const chart = await createChart("MRR");
    const goal = await insert(Goal, {
      companyId: company.id,
      title: "Reach $50k MRR",
      slug: "reach-50k-mrr",
      targetValue: 50_000,
      metricKind: "chart",
      chartId: chart.body.id,
      currentValue: 41_000,
      currentValueSource: "chart",
    });

    const removed = await call("DELETE", `/explore/charts/${chart.body.slug}`);
    assert.equal(removed.status, 200);
    const after = await AppDataSource.getRepository(Goal).findOneByOrFail({ id: goal.id });
    assert.equal(after.metricKind, "manual");
    assert.equal(after.chartId, null);
    assert.equal(after.currentValue, 41_000);
    assert.equal(after.status, "active");
  });
});

describe("Explore dashboard formulas", () => {
  test("persists a sum, its display formatting, and edits while preserving layout", async () => {
    const dashboard = await createDashboard();
    const first = await addNumberCard(dashboard.body.slug, "Product revenue");
    const second = await addNumberCard(dashboard.body.slug, "Services revenue");
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    const formula: ExploreFormula = {
      expression: "SUM(A, B)",
      inputs: [
        { name: "A", cardId: first.body.id },
        { name: "B", cardId: second.body.id },
      ],
      prefix: "$",
      suffix: " total",
    };
    const added = await call<DashboardCardDTO>("POST", path, {
      formula,
      titleOverride: "Combined revenue",
      w: 4,
      h: 2,
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.chartId, null);
    assert.deepEqual(added.body.formula, formula);
    assert.equal(added.body.y, 8);
    const stored = await AppDataSource.getRepository(DashboardCard).findOneByOrFail({
      id: added.body.id,
    });
    assert.deepEqual(JSON.parse(stored.formulaJson!), formula);

    const editedFormula = { ...formula, expression: "(A - B) / A * 100", prefix: "", suffix: "%" };
    const edited = await call<DashboardCardDTO>("PATCH", `${path}/${added.body.id}`, {
      formula: editedFormula,
      titleOverride: "Margin",
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.formula, editedFormula);
    assert.deepEqual([edited.body.w, edited.body.h, edited.body.y], [4, 2, 8]);
    const board = await call<{ cards: DashboardCardDTO[]; charts: Chart[] }>(
      "GET",
      `/explore/dashboards/${dashboard.body.slug}`,
    );
    assert.equal(board.status, 200);
    assert.equal(board.body.charts.length, 2);
    assert.deepEqual(
      board.body.cards.find((card) => card.id === added.body.id)?.formula,
      editedFormula,
    );
  });

  test("rejects ambiguous, untitled, or malformed formulas and accepts constants", async () => {
    const dashboard = await createDashboard();
    const number = await addNumberCard(dashboard.body.slug);
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    const base = { formula: formulaFor(number.body.id), titleOverride: "Calculated" };
    for (const invalid of [
      {},
      { ...base, chartId: number.body.chartId },
      { ...base, titleOverride: "   " },
      { ...base, formula: { ...base.formula, expression: "A +" } },
      { ...base, formula: { ...base.formula, expression: "A + B" } },
      { ...base, formula: { expression: "1", inputs: base.formula.inputs } },
      {
        ...base,
        formula: { expression: "A", inputs: [...base.formula.inputs, ...base.formula.inputs] },
      },
      { ...base, formula: { expression: "globalThis.process.exit()", inputs: [] } },
    ]) {
      assert.equal((await call("POST", path, invalid)).status, 400);
    }
    const constant = await call<DashboardCardDTO>("POST", path, {
      titleOverride: "Monthly target",
      formula: { expression: "1000 * 12", inputs: [] },
    });
    assert.equal(constant.status, 201);
    // Syntax is checked independently of query values, including zero values.
    assert.equal(
      (
        await call("POST", path, {
          ...base,
          formula: { ...base.formula, expression: "10 / A" },
        })
      ).status,
      201,
    );
    assert.equal(
      (await call("PATCH", `${path}/${constant.body.id}`, { titleOverride: "" })).status,
      400,
    );
    assert.equal((await call("PATCH", `${path}/${number.body.id}`, base)).status, 400);
  });

  test("scopes inputs to this dashboard and company and requires Number cards", async () => {
    const dashboard = await createDashboard();
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    const line = await createChart();
    const lineCard = await call<DashboardCardDTO>("POST", path, { chartId: line.body.id });
    const otherDashboard = await createDashboard();
    const elsewhere = await addNumberCard(otherDashboard.body.slug);
    const foreignChart = await insert(Chart, {
      companyId: otherConnection.companyId,
      slug: "private",
      title: "Private",
      connectionId: otherConnection.id,
      sql: "SELECT 1",
      vizType: "scalar",
    });
    const foreignCard = await insert(DashboardCard, {
      dashboardId: dashboard.body.id,
      chartId: foreignChart.id,
    });
    for (const sourceId of [
      lineCard.body.id,
      elsewhere.body.id,
      foreignCard.id,
      crypto.randomUUID(),
    ]) {
      const response = await call("POST", path, {
        titleOverride: "Calculated",
        formula: formulaFor(sourceId),
      });
      assert.equal(response.status, 400);
    }
    const foreignDashboard = await insert(Dashboard, {
      companyId: otherConnection.companyId,
      slug: "private-dashboard",
      title: "Private",
    });
    assert.equal(
      (
        await call("POST", `/explore/dashboards/${foreignDashboard.slug}/cards`, {
          titleOverride: "Calculated",
          formula: { expression: "1", inputs: [] },
        })
      ).status,
      404,
    );
  });

  test("allows nested formulas and rejects self references and indirect cycles without saving", async () => {
    const dashboard = await createDashboard();
    const number = await addNumberCard(dashboard.body.slug);
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    const first = await call<DashboardCardDTO>("POST", path, {
      titleOverride: "First",
      formula: formulaFor(number.body.id),
    });
    const second = await call<DashboardCardDTO>("POST", path, {
      titleOverride: "Second",
      formula: formulaFor(first.body.id),
    });
    assert.equal(second.status, 201);
    for (const sourceId of [first.body.id, second.body.id]) {
      const response = await call<{ error: string }>("PATCH", `${path}/${first.body.id}`, {
        formula: formulaFor(sourceId),
      });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /cycle/);
    }
    const stored = await AppDataSource.getRepository(DashboardCard).findOneByOrFail({
      id: first.body.id,
    });
    assert.deepEqual(JSON.parse(stored.formulaJson!), first.body.formula);

    const sibling = await addNumberCard(dashboard.body.slug, "Sibling");
    assert.equal(
      (
        await call("PATCH", `${path}/${second.body.id}`, {
          formula: {
            expression: "A + B",
            inputs: [
              { name: "A", cardId: first.body.id },
              { name: "B", cardId: sibling.body.id },
            ],
          },
        })
      ).status,
      200,
    );
    assert.equal((await call("DELETE", `${path}/${sibling.body.id}`)).status, 200);
    // A removed sibling in an existing dependent does not block this edit.
    assert.equal(
      (
        await call("PATCH", `${path}/${first.body.id}`, {
          formula: { ...formulaFor(number.body.id), expression: "A * 3" },
        })
      ).status,
      200,
    );
  });

  test("bounds shared dependency paths and existing dependents when editing a formula", async () => {
    const dashboard = await createDashboard();
    const number = await addNumberCard(dashboard.body.slug);
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    let previousId = number.body.id;
    // This stored chain is exactly the allowed 32 cards, including Number.
    for (let index = 0; index < 31; index++) {
      const card = await insert(DashboardCard, {
        dashboardId: dashboard.body.id,
        chartId: null,
        formulaJson: JSON.stringify(formulaFor(previousId)),
        titleOverride: `Chain ${index}`,
      });
      previousId = card.id;
    }
    assert.equal(
      (
        await call("POST", path, {
          titleOverride: "Too deep",
          formula: formulaFor(previousId),
        })
      ).status,
      400,
    );

    const root = await call<DashboardCardDTO>("POST", path, {
      titleOverride: "Root",
      formula: { expression: "1", inputs: [] },
    });
    const dependent = await call<DashboardCardDTO>("POST", path, {
      titleOverride: "Dependent",
      formula: formulaFor(root.body.id),
    });
    assert.equal(dependent.status, 201);
    const shorter = await AppDataSource.getRepository(DashboardCard).findOneByOrFail({
      id: previousId,
    });
    const inputId = (JSON.parse(shorter.formulaJson!) as ExploreFormula).inputs[0].cardId;
    // Root would be 32 cards; its existing dependent would become 33.
    const edited = await call<{ error: string }>("PATCH", `${path}/${root.body.id}`, {
      formula: formulaFor(inputId),
    });
    assert.equal(edited.status, 400);
    assert.match(edited.body.error, /32/);
  });

  test("serializes concurrent edits so they cannot introduce a formula cycle", async () => {
    const dashboard = await createDashboard();
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    const first = await call<DashboardCardDTO>("POST", path, {
      titleOverride: "First",
      formula: { expression: "1", inputs: [] },
    });
    const second = await call<DashboardCardDTO>("POST", path, {
      titleOverride: "Second",
      formula: { expression: "2", inputs: [] },
    });
    const responses = await Promise.all([
      call("PATCH", `${path}/${first.body.id}`, { formula: formulaFor(second.body.id) }),
      call("PATCH", `${path}/${second.body.id}`, { formula: formulaFor(first.body.id) }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  });

  test("keeps a formula when an input is removed so the dashboard can report the missing input", async () => {
    const dashboard = await createDashboard();
    const number = await addNumberCard(dashboard.body.slug);
    const path = `/explore/dashboards/${dashboard.body.slug}/cards`;
    const added = await call<DashboardCardDTO>("POST", path, {
      titleOverride: "Calculated",
      formula: formulaFor(number.body.id),
    });
    assert.equal((await call("DELETE", `${path}/${number.body.id}`)).status, 200);
    const moved = await call<DashboardCardDTO>("PATCH", `${path}/${added.body.id}`, { x: 2 });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.formula, added.body.formula);
    const board = await call<{ cards: DashboardCardDTO[] }>(
      "GET",
      `/explore/dashboards/${dashboard.body.slug}`,
    );
    assert.equal(board.body.cards.length, 1);
    assert.deepEqual(board.body.cards[0].formula, added.body.formula);
  });
});

/** A small CRM Base: a Deals table with a stage, an amount, and a close date. */
async function seedDealsBase(companyId: string, name = "Sales") {
  const base = await insert(Base, {
    companyId,
    name,
    slug: name.toLowerCase(),
    description: "",
    icon: "Database",
    color: "emerald",
    createdById: null,
  });
  const deals = await insert(BaseTable, {
    baseId: base.id,
    name: "Deals",
    slug: "deals",
    sortOrder: 1000,
  });
  const archived = await insert(BaseTable, {
    baseId: base.id,
    name: "Old deals",
    slug: "old-deals",
    sortOrder: 2000,
    archivedAt: new Date(),
  });
  const field = (name: string, type: BaseField["type"], sortOrder: number, config = {}) =>
    insert(BaseField, {
      tableId: deals.id,
      name,
      type,
      configJson: JSON.stringify(config),
      isPrimary: sortOrder === 1000,
      sortOrder,
    });
  const nameField = await field("Name", "text", 1000);
  const stage = await field("Stage", "select", 2000, {
    options: [
      { id: "lead", label: "Lead", color: "slate" },
      { id: "won", label: "Won", color: "emerald" },
    ],
  });
  const amount = await field("Amount", "number", 3000);
  const closed = await field("Closed", "date", 4000);
  const rows: Array<[string, string | null, number, string]> = [
    ["Acme", "won", 1200, "2026-01-12"],
    ["Globex", "lead", 300, "2026-01-30"],
    ["Initech", "won", 800, "2026-02-03"],
  ];
  for (const [index, [label, stageId, value, date]] of rows.entries()) {
    await insert(BaseRecord, {
      tableId: deals.id,
      sortOrder: (index + 1) * 1000,
      dataJson: JSON.stringify({
        [nameField.id]: label,
        ...(stageId ? { [stage.id]: stageId } : {}),
        [amount.id]: value,
        [closed.id]: date,
      }),
    });
  }
  return { base, deals, archived, fields: { name: nameField, stage, amount, closed } };
}

type QueryRows = { fields: { name: string }[]; rows: Record<string, unknown>[]; rowCount: number };

describe("Explore charts over a Base", () => {
  test("lists the company's Bases and their tables as data sources", async () => {
    const { base, deals, archived } = await seedDealsBase(company.id);
    const response = await call<unknown[]>("GET", "/explore/bases");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [
      {
        id: base.id,
        name: "Sales",
        slug: "sales",
        icon: "Database",
        color: "emerald",
        tables: [
          { id: deals.id, name: "Deals", archived: false },
          { id: archived.id, name: "Old deals", archived: true },
        ],
      },
    ]);
  });

  test("describes a table's columns to the builder, but never another company's", async () => {
    const { base, deals } = await seedDealsBase(company.id);
    const schema = await call<{ fields: { name: string; type: string }[] }>(
      "GET",
      `/explore/bases/${base.id}/tables/${deals.id}/schema`,
    );
    assert.equal(schema.status, 200);
    assert.deepEqual(
      schema.body.fields.map((field) => [field.name, field.type]),
      [
        ["Name", "text"],
        ["Stage", "select"],
        ["Amount", "number"],
        ["Closed", "date"],
      ],
    );

    const other = await insert(Company, { name: "Rival", slug: "rival", ownerId: actingUserId! });
    const theirs = await seedDealsBase(other.id, "Theirs");
    const hidden = await call<{ error: string }>(
      "GET",
      `/explore/bases/${theirs.base.id}/tables/${theirs.deals.id}/schema`,
    );
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.error, "The chart's Base no longer exists");
  });

  test("answers a query as it is built, grouped and measured", async () => {
    const { base, deals, fields } = await seedDealsBase(company.id);
    const response = await call<QueryRows>("POST", `/explore/bases/${base.id}/run`, {
      query: {
        tableId: deals.id,
        groupBy: { fieldId: fields.stage.id },
        metrics: [{ aggregate: "count" }, { aggregate: "sum", fieldId: fields.amount.id }],
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.rows, [
      { Stage: "Lead", Count: 1, "Sum of Amount": 300 },
      { Stage: "Won", Count: 2, "Sum of Amount": 2000 },
    ]);
  });

  test("saves a Base chart that runs, pins to a dashboard, and feeds a goal", async () => {
    const { base, deals, fields } = await seedDealsBase(company.id);
    const created = await call<ChartDTO>("POST", "/explore/charts", {
      title: "Won revenue",
      baseId: base.id,
      baseQuery: {
        tableId: deals.id,
        filters: [{ id: "won", fieldId: fields.stage.id, operator: "is", value: "won" }],
        metrics: [{ aggregate: "sum", fieldId: fields.amount.id }],
      },
      vizType: "scalar",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.source, "base");
    assert.equal(created.body.connectionId, null);
    assert.equal(created.body.baseId, base.id);
    assert.equal(created.body.baseQuery?.metrics[0].aggregate, "sum");

    const ran = await call<QueryRows>("POST", `/explore/charts/${created.body.slug}/run`, {});
    assert.equal(ran.status, 200);
    assert.deepEqual(ran.body.rows, [{ "Sum of Amount": 2000 }]);

    const dashboard = await createDashboard();
    const card = await call("POST", `/explore/dashboards/${dashboard.body.slug}/cards`, {
      chartId: created.body.id,
    });
    assert.equal(card.status, 201);
    const board = await call<{ charts: ChartDTO[] }>(
      "GET",
      `/explore/dashboards/${dashboard.body.slug}`,
    );
    assert.deepEqual(
      board.body.charts.map((chart) => [chart.title, chart.source]),
      [["Won revenue", "base"]],
    );

    const goal = await insert(Goal, {
      companyId: company.id,
      title: "Win $5k",
      slug: "win-5k",
      targetValue: 5_000,
      metricKind: "chart",
      chartId: created.body.id,
    });
    const refreshed = await refreshGoalValue(goal);
    assert.equal(refreshed.currentValue, 2000);
    assert.equal(refreshed.currentValueSource, "chart");
  });

  test("refuses two sources at once, a field the table lacks, or another company's Base", async () => {
    const { base, deals, fields } = await seedDealsBase(company.id);
    const both = await call<{ error: string }>("POST", "/explore/charts", {
      title: "Both",
      connectionId: connection.id,
      sql: "SELECT 1",
      baseId: base.id,
      baseQuery: { tableId: deals.id },
    });
    assert.equal(both.status, 400);
    assert.equal(both.body.error, "ValidationError");

    const missingField = await call<{ error: string }>("POST", "/explore/charts", {
      title: "Ghost",
      baseId: base.id,
      baseQuery: { tableId: deals.id, groupBy: { fieldId: connection.id } },
    });
    assert.equal(missingField.status, 400);
    assert.match(missingField.body.error, /groups by a field this table no longer has/);

    const wrongType = await call<{ error: string }>("POST", "/explore/charts", {
      title: "Average name",
      baseId: base.id,
      baseQuery: { tableId: deals.id, metrics: [{ aggregate: "avg", fieldId: fields.name.id }] },
    });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.error, 'Average needs a number field, and "Name" is a text field.');

    const other = await insert(Company, { name: "Rival", slug: "rival", ownerId: actingUserId! });
    const theirs = await seedDealsBase(other.id, "Theirs");
    const foreign = await call<{ error: string }>("POST", "/explore/charts", {
      title: "Theirs",
      baseId: theirs.base.id,
      baseQuery: { tableId: theirs.deals.id },
    });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.error, "The chart's Base no longer exists");
    assert.equal(await AppDataSource.getRepository(Chart).count(), 0);
  });

  test("moves a chart from a database to a Base and back", async () => {
    const { base, deals } = await seedDealsBase(company.id);
    const chart = await createChart("Pipeline");
    const toBase = await call<ChartDTO>("PATCH", `/explore/charts/${chart.body.slug}`, {
      baseId: base.id,
      baseQuery: { tableId: deals.id },
    });
    assert.equal(toBase.status, 200);
    assert.equal(toBase.body.source, "base");
    assert.equal(toBase.body.connectionId, null);
    assert.equal(toBase.body.sql, "");

    const sqlWithoutConnection = await call<{ error: string }>(
      "PATCH",
      `/explore/charts/${chart.body.slug}`,
      { sql: "SELECT 2" },
    );
    assert.equal(sqlWithoutConnection.status, 400);
    assert.equal(sqlWithoutConnection.body.error, "Choose the database Connection the chart reads");

    const back = await call<ChartDTO>("PATCH", `/explore/charts/${chart.body.slug}`, {
      connectionId: connection.id,
      sql: "SELECT 2",
    });
    assert.equal(back.status, 200);
    assert.equal(back.body.source, "connection");
    assert.equal(back.body.baseId, null);
    assert.equal(back.body.baseQuery, null);
    assert.equal(back.body.sql, "SELECT 2");
  });

  test("says when a saved chart's table is gone instead of charting nothing", async () => {
    const { base, deals } = await seedDealsBase(company.id);
    const created = await call<ChartDTO>("POST", "/explore/charts", {
      title: "Every deal",
      baseId: base.id,
      baseQuery: { tableId: deals.id },
    });
    await AppDataSource.getRepository(BaseTable).delete({ id: deals.id });
    const ran = await call<{ error: string }>(
      "POST",
      `/explore/charts/${created.body.slug}/run`,
      {},
    );
    assert.equal(ran.status, 400);
    assert.equal(ran.body.error, "The chart's table no longer exists in its Base");
  });
});
