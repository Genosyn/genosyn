import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { AuthRateLimit } from "../db/entities/AuthRateLimit.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Chart } from "../db/entities/Chart.js";
import type { Company } from "../db/entities/Company.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { resetSharedChartCacheForTests } from "../services/dashboardLinks.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { SharedDashboard } from "../../shared/dashboardLinks.js";

/**
 * A Dashboard link shows one Dashboard to whoever holds it, for a TV. These
 * drive the real App — signed session cookies, real API keys, the public
 * router before the session — through the whole life of a link: who may make
 * one, what it shows and never shows, how it is turned off, reset and handed
 * on, and that a wall of screens costs one query.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

type LinkState = {
  enabled: boolean;
  restorable: boolean;
  url: string | null;
  path: string | null;
  refreshSeconds: number;
  enabledBy: { id: string; name: string; member: boolean } | null;
};

let company: Company;
let owner: User;
let ownerCookie: string;
let dashboard: Dashboard;
let wonRevenue: Chart;
let dealList: Chart;
let offBoard: Chart;
let deals: BaseTable;
let fields: Record<"name" | "stage" | "amount" | "closed", BaseField>;
let base: Base;

beforeEach(async () => {
  await resetTestDb();
  resetSharedChartCacheForTests();
  ({ user: owner, company } = await createMemberOfNewCompany("owner", { name: "Olive Owner" }));
  ownerCookie = await sessionCookieFor(owner);

  base = await insert(Base, {
    companyId: company.id,
    name: "Sales",
    slug: "sales",
    description: "",
    icon: "Database",
    color: "emerald",
    createdById: null,
  });
  deals = await insert(BaseTable, { baseId: base.id, name: "Deals", slug: "deals", sortOrder: 1000 });
  const field = (name: string, type: BaseField["type"], sortOrder: number, config = {}) =>
    insert(BaseField, {
      tableId: deals.id,
      name,
      type,
      configJson: JSON.stringify(config),
      isPrimary: sortOrder === 1000,
      sortOrder,
    });
  fields = {
    name: await field("Name", "text", 1000),
    stage: await field("Stage", "select", 2000, {
      options: [
        { id: "lead", label: "Lead", color: "slate" },
        { id: "won", label: "Won", color: "emerald" },
      ],
    }),
    amount: await field("Amount", "number", 3000),
    closed: await field("Closed", "date", 4000),
  };
  await addDeal("Acme", "won", 1200);
  await addDeal("Globex", "lead", 300);
  await addDeal("Initech", "won", 800);

  const chart = (values: Partial<Chart>) =>
    insert(Chart, {
      companyId: company.id,
      description: "",
      connectionId: null,
      sql: "",
      baseId: base.id,
      createdById: owner.id,
      createdByEmployeeId: null,
      ...values,
    });
  wonRevenue = await chart({
    title: "Won revenue",
    slug: "won-revenue",
    baseQueryJson: JSON.stringify({
      tableId: deals.id,
      filters: [{ id: "won", fieldId: fields.stage.id, operator: "is", value: "won" }],
      metrics: [{ aggregate: "sum", fieldId: fields.amount.id }],
    }),
    vizType: "scalar",
    vizConfig: JSON.stringify({ measure: "Sum of Amount", prefix: "$" }),
  });
  dealList = await chart({
    title: "Every deal",
    slug: "every-deal",
    baseQueryJson: JSON.stringify({ tableId: deals.id }),
    vizType: "table",
    vizConfig: JSON.stringify({
      columns: ["Name", "Amount"],
      internalNote: "Do not show the Closed column to the lobby",
    }),
  });
  offBoard = await chart({
    title: "Not on the dashboard",
    slug: "not-on-the-dashboard",
    baseQueryJson: JSON.stringify({ tableId: deals.id }),
    vizType: "table",
    vizConfig: "{}",
  });

  dashboard = await insert(Dashboard, {
    companyId: company.id,
    title: "Sales floor",
    slug: "sales-floor",
    description: "What the team sees on the TV",
    createdById: owner.id,
    createdByEmployeeId: null,
  });
  const revenueCard = await insert(DashboardCard, {
    dashboardId: dashboard.id,
    chartId: wonRevenue.id,
    formulaJson: null,
    x: 0,
    y: 0,
    w: 6,
    h: 3,
    titleOverride: "",
  });
  await insert(DashboardCard, {
    dashboardId: dashboard.id,
    chartId: dealList.id,
    formulaJson: null,
    x: 6,
    y: 0,
    w: 6,
    h: 6,
    titleOverride: "Deals",
  });
  await insert(DashboardCard, {
    dashboardId: dashboard.id,
    chartId: null,
    formulaJson: JSON.stringify({
      expression: "A * 2",
      inputs: [{ name: "A", cardId: revenueCard.id }],
      suffix: " pts",
    }),
    x: 0,
    y: 3,
    w: 6,
    h: 3,
    titleOverride: "Doubled",
  });
});

let dealCount = 0;
async function addDeal(name: string, stage: string, amount: number): Promise<void> {
  dealCount += 1;
  await insert(BaseRecord, {
    tableId: deals.id,
    sortOrder: dealCount * 1000,
    dataJson: JSON.stringify({
      [fields.name.id]: name,
      [fields.stage.id]: stage,
      [fields.amount.id]: amount,
      [fields.closed.id]: "2026-01-12",
    }),
  });
}

type Reply<T> = { status: number; body: T; headers: Headers };

async function send<T>(
  method: string,
  path: string,
  options: { cookie?: string; token?: string; body?: unknown } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) {
    headers.cookie = options.cookie;
    headers.origin = baseUrl;
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

const linkPath = () => `/api/companies/${company.id}/explore/dashboards/${dashboard.slug}/link`;

async function shareAs(cookie = ownerCookie): Promise<LinkState> {
  const response = await send<LinkState>("POST", linkPath(), { cookie, body: {} });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

function tokenOf(state: LinkState): string {
  const match = /^\/dashboards\/([A-Za-z0-9_-]{43})$/.exec(state.path ?? "");
  assert.ok(match, `unexpected link path ${state.path}`);
  return match[1];
}

async function memberOf(role: Role, name: string): Promise<{ user: User; cookie: string }> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.test`,
    name,
    passwordHash: "not-a-real-hash",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  return { user, cookie: await sessionCookieFor(user) };
}

describe("Dashboard links", () => {
  test("an owner shares a dashboard, and whoever holds the link sees it but never its queries", async () => {
    const state = await shareAs();
    assert.equal(state.enabled, true);
    assert.equal(state.restorable, false);
    assert.equal(state.refreshSeconds, 300);
    assert.deepEqual(state.enabledBy, { id: owner.id, name: "Olive Owner", member: true });
    const token = tokenOf(state);
    assert.ok(state.url?.endsWith(`/dashboards/${token}`));

    const shared = await send<SharedDashboard>("GET", `/api/dashboards/${token}`);
    assert.equal(shared.status, 200);
    assert.equal(shared.body.title, "Sales floor");
    assert.equal(shared.body.companyName, company.name);
    assert.equal(shared.body.refreshSeconds, 300);
    assert.deepEqual(
      shared.body.cards.map((card) => card.titleOverride),
      ["", "Deals", "Doubled"],
    );
    assert.deepEqual(
      shared.body.charts.map((chart) => [chart.title, chart.vizType]).sort(),
      [
        ["Every deal", "table"],
        ["Won revenue", "scalar"],
      ],
    );
    const formula = shared.body.cards.find((card) => card.formula)?.formula;
    assert.equal(formula?.expression, "A * 2");

    // The layout never carries where a chart's numbers come from.
    const everything = JSON.stringify(shared.body);
    for (const secret of [base.id, deals.id, fields.amount.id, "baseQuery", "internalNote", "sql"]) {
      assert.ok(!everything.includes(secret), `the shared layout leaked ${secret}`);
    }
    assert.deepEqual(
      shared.body.charts.find((chart) => chart.title === "Every deal")?.vizConfig,
      { columns: ["Name", "Amount"] },
    );

    // Never cached, indexed, or handed on as a referrer.
    assert.match(shared.headers.get("cache-control") ?? "", /no-store/);
    assert.match(shared.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.equal(shared.headers.get("referrer-policy"), "no-referrer");

    // The page that opens it carries the same headers.
    const page = await fetch(`${baseUrl}/dashboards/${token}`);
    assert.match(page.headers.get("cache-control") ?? "", /no-store/);
    assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);

    const detail = await send<{ link: { enabled: boolean } }>(
      "GET",
      `/api/companies/${company.id}/explore/dashboards/${dashboard.slug}`,
      { cookie: ownerCookie },
    );
    assert.deepEqual(detail.body.link, { enabled: true });
  });

  test("a chart answers only for this dashboard, with only the columns it draws", async () => {
    const token = tokenOf(await shareAs());
    const revenue = await send<{ rows: unknown[] }>(
      "GET",
      `/api/dashboards/${token}/charts/${wonRevenue.id}/result`,
    );
    assert.equal(revenue.status, 200);
    assert.deepEqual(revenue.body.rows, [{ "Sum of Amount": 2000 }]);

    const list = await send<{ fields: { name: string }[]; rows: Record<string, unknown>[] }>(
      "GET",
      `/api/dashboards/${token}/charts/${dealList.id}/result`,
    );
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.fields, [{ name: "Name" }, { name: "Amount" }]);
    assert.deepEqual(list.body.rows[0], { Name: "Acme", Amount: 1200 });

    const elsewhere = await send<{ error: string }>(
      "GET",
      `/api/dashboards/${token}/charts/${offBoard.id}/result`,
    );
    assert.equal(elsewhere.status, 404);
    const garbled = await send("GET", `/api/dashboards/${token}/charts/not-a-chart/result`);
    assert.equal(garbled.status, 404);
  });

  test("every screen showing the link shares one answer for a while", async () => {
    const token = tokenOf(await shareAs());
    const path = `/api/dashboards/${token}/charts/${wonRevenue.id}/result`;
    const first = await send<{ rows: unknown[] }>("GET", path);
    assert.deepEqual(first.body.rows, [{ "Sum of Amount": 2000 }]);
    await addDeal("Umbrella", "won", 500);
    const cached = await send<{ rows: unknown[] }>("GET", path);
    assert.deepEqual(cached.body.rows, [{ "Sum of Amount": 2000 }]);
    resetSharedChartCacheForTests();
    const fresh = await send<{ rows: unknown[] }>("GET", path);
    assert.deepEqual(fresh.body.rows, [{ "Sum of Amount": 2500 }]);
  });

  test("a guess, a link turned off and a link reset all answer the same 404", async () => {
    const malformed = await send<{ error: string }>("GET", "/api/dashboards/not-a-token");
    assert.equal(malformed.status, 404);
    const guess = await send<{ error: string }>(
      "GET",
      `/api/dashboards/${randomBytes(32).toString("base64url")}`,
    );
    assert.equal(guess.status, 404);
    assert.equal(guess.body.error, malformed.body.error);
    assert.ok((await AppDataSource.getRepository(AuthRateLimit).count()) > 0, "guesses count");

    const token = tokenOf(await shareAs());
    const off = await send<LinkState>("DELETE", linkPath(), { cookie: ownerCookie });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.restorable, true);
    assert.equal(off.body.path, null);
    const whileOff = await send<{ error: string }>("GET", `/api/dashboards/${token}`);
    assert.equal(whileOff.status, 404);
    assert.equal(whileOff.body.error, malformed.body.error);
    const chartWhileOff = await send(
      "GET",
      `/api/dashboards/${token}/charts/${wonRevenue.id}/result`,
    );
    assert.equal(chartWhileOff.status, 404);

    // Back on: the same link, so every TV that kept it carries on.
    const back = await shareAs();
    assert.equal(tokenOf(back), token);
    assert.equal((await send("GET", `/api/dashboards/${token}`)).status, 200);

    const reset = await send<LinkState>("POST", `${linkPath()}/rotate`, {
      cookie: ownerCookie,
      body: {},
    });
    assert.equal(reset.status, 200);
    const fresh = tokenOf(reset.body);
    assert.notEqual(fresh, token);
    assert.equal((await send("GET", `/api/dashboards/${token}`)).status, 404);
    assert.equal((await send("GET", `/api/dashboards/${fresh}`)).status, 200);

    const audited = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id, targetId: dashboard.id },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      audited.map((event) => event.action),
      ["dashboard.link.enable", "dashboard.link.disable", "dashboard.link.enable", "dashboard.link.rotate"],
    );
    for (const event of audited) {
      assert.ok(!event.metadataJson.includes(token) && !event.metadataJson.includes(fresh));
    }
  });

  test("a link answers as its sharer, and stops once they leave until someone shares it again", async () => {
    const admin = await memberOf("admin", "Ada Admin");
    const state = await shareAs(admin.cookie);
    assert.equal(state.enabledBy?.name, "Ada Admin");
    const token = tokenOf(state);
    assert.equal((await send("GET", `/api/dashboards/${token}`)).status, 200);

    await AppDataSource.getRepository(Membership).delete({
      companyId: company.id,
      userId: admin.user.id,
    });
    assert.equal((await send("GET", `/api/dashboards/${token}`)).status, 404);
    const seen = await send<LinkState>("GET", linkPath(), { cookie: ownerCookie });
    assert.equal(seen.body.enabled, true);
    assert.deepEqual(seen.body.enabledBy, { id: admin.user.id, name: "Ada Admin", member: false });

    const mine = await shareAs();
    assert.equal(tokenOf(mine), token, "sharing again keeps the URL every screen has");
    assert.equal(mine.enabledBy?.id, owner.id);
    assert.equal((await send("GET", `/api/dashboards/${token}`)).status, 200);
  });

  test("only owners and admins at a browser manage a link; members and API keys never do", async () => {
    const member = await memberOf("member", "Max Member");
    assert.equal((await send("GET", linkPath(), { cookie: member.cookie })).status, 403);
    assert.equal(
      (await send("POST", linkPath(), { cookie: member.cookie, body: {} })).status,
      403,
    );

    const { token: apiKey } = await mintTestApiKey(owner.id, company.id);
    assert.equal((await send("GET", linkPath(), { token: apiKey })).status, 403);
    assert.equal((await send("POST", linkPath(), { token: apiKey, body: {} })).status, 403);
    const keyDetail = await send<{ link: { enabled: boolean } }>(
      "GET",
      `/api/companies/${company.id}/explore/dashboards/${dashboard.slug}`,
      { token: apiKey },
    );
    assert.deepEqual(keyDetail.body.link, { enabled: false });

    await shareAs();
    const memberDetail = await send<{ link: { enabled: boolean } }>(
      "GET",
      `/api/companies/${company.id}/explore/dashboards/${dashboard.slug}`,
      { cookie: member.cookie },
    );
    assert.deepEqual(memberDetail.body.link, { enabled: true });
  });

  test("a link refreshes only as often as one of the offered choices", async () => {
    const token = tokenOf(await shareAs());
    const faster = await send<LinkState>("PATCH", linkPath(), {
      cookie: ownerCookie,
      body: { refreshSeconds: 60 },
    });
    assert.equal(faster.status, 200);
    assert.equal(faster.body.refreshSeconds, 60);
    const shared = await send<SharedDashboard>("GET", `/api/dashboards/${token}`);
    assert.equal(shared.body.refreshSeconds, 60);

    const tooFast = await send("PATCH", linkPath(), {
      cookie: ownerCookie,
      body: { refreshSeconds: 5 },
    });
    assert.equal(tooFast.status, 400);
  });
});
