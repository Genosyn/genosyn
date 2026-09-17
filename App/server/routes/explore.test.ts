import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { exploreRouter } from "./explore.js";
import type { DashboardCardDTO } from "../services/explore.js";
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
