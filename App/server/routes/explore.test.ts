import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Chart } from "../db/entities/Chart.js";
import { Company } from "../db/entities/Company.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { exploreRouter } from "./explore.js";

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
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
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
