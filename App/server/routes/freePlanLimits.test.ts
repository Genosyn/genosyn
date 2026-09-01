import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Company } from "../db/entities/Company.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "../services/billing/billingSettings.js";
import { invalidateLicenseCache } from "../services/license.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { basesRouter } from "./bases.js";
import { projectsRouter } from "./projects.js";
import { workspaceRouter } from "./workspace.js";

/**
 * The Free plan's M56 resource caps at every user-facing create route:
 * Bases (1), Base tables (1), Channels (3, DMs excluded), Projects (1),
 * Todos (20). Each refusal is a 402 with the frozen upgrade message; template
 * seeding and recurrence spawning degrade silently instead of failing the
 * request that triggered them.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
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
  app.use("/api/companies/:cid/workspace", workspaceRouter);
  app.use("/api/companies/:cid", basesRouter);
  app.use("/api/companies/:cid", projectsRouter);
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
  const owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  actingUserId = owner.id;
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      growthMonthlyPriceId: "price_growth",
      scaleMonthlyPriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    }),
  });
  invalidateBillingSettingsCache();
});

type ApiResult = { status: number; body: Record<string, unknown> };

async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const createBase = (name: string, templateId?: string) =>
  api("POST", "/bases", templateId ? { name, templateId } : { name });
const createTable = (baseSlug: string, name: string) =>
  api("POST", `/bases/${baseSlug}/tables`, { name });
const createChannel = (name: string) => api("POST", "/workspace/channels", { name });
const createProject = (name: string) => api("POST", "/projects", { name });
const createTodo = (pSlug: string, body: Record<string, unknown>) =>
  api("POST", `/projects/${pSlug}/todos`, body);

async function disableBilling(): Promise<void> {
  const { AppDataSource } = await import("../db/datasource.js");
  await AppDataSource.getRepository(AppSetting).delete({ key: BILLING_SETTING_KEY });
  invalidateBillingSettingsCache();
}

async function upgradeToGrowth(): Promise<void> {
  await insert(CompanyBilling, { companyId: company.id, plan: "growth", status: "active" });
}

describe("Free plan Base cap", () => {
  test("one Base lands; the second is a 402 with the upgrade message", async () => {
    assert.equal((await createBase("First")).status, 200);
    const refused = await createBase("Second");
    assert.equal(refused.status, 402);
    assert.equal(
      refused.body.error,
      "Your Free plan includes 1 Base. Upgrade to Growth for unlimited Bases.",
    );
  });

  test("Growth plan and billing-disabled installs are uncapped", async () => {
    await upgradeToGrowth();
    assert.equal((await createBase("First")).status, 200);
    assert.equal((await createBase("Second")).status, 200);

    await resetToSelfHosted();
    assert.equal((await createBase("Solo A")).status, 200);
    assert.equal((await createBase("Solo B")).status, 200);
  });
});

/** Re-seed the fixture rows after wiping, then turn billing off. */
async function resetToSelfHosted(): Promise<void> {
  await resetTestDb();
  invalidateBillingSettingsCache();
  invalidateLicenseCache();
  const owner = await insert(User, {
    email: "solo@example.com",
    name: "Solo",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Solo Co", slug: "solo", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Bit",
    slug: "bit",
    role: "Analyst",
    soulBody: "",
  });
  actingUserId = owner.id;
  await disableBilling();
}

describe("Free plan Base table cap", () => {
  test("one table lands; the second is a 402 with the upgrade message", async () => {
    const base = await createBase("Empty");
    assert.equal(base.status, 200);
    const slug = base.body.slug as string;
    assert.equal((await createTable(slug, "One")).status, 200);
    const refused = await createTable(slug, "Two");
    assert.equal(refused.status, 402);
    assert.equal(
      refused.body.error,
      "Your Free plan includes 1 Base table. Upgrade to Growth for unlimited tables.",
    );
  });

  test("a multi-table template seeds capped at 1 table without failing the base create", async () => {
    // The CRM template ships 3 tables — the base itself must still land.
    const base = await createBase("Pipeline", "crm");
    assert.equal(base.status, 200);
    const { AppDataSource } = await import("../db/datasource.js");
    const tables = await AppDataSource.getRepository(BaseTable).countBy({
      baseId: base.body.id as string,
    });
    assert.equal(tables, 1);
  });

  test("without instance billing the whole template seeds", async () => {
    await disableBilling();
    const base = await createBase("Pipeline", "crm");
    assert.equal(base.status, 200);
    const { AppDataSource } = await import("../db/datasource.js");
    const tables = await AppDataSource.getRepository(BaseTable).countBy({
      baseId: base.body.id as string,
    });
    assert.equal(tables, 3);
  });
});

describe("Free plan Channel cap", () => {
  test("three Channels land; the fourth is a 402; DMs still open at the cap", async () => {
    assert.equal((await createChannel("general")).status, 201);
    assert.equal((await createChannel("random")).status, 201);
    assert.equal((await createChannel("ops")).status, 201);
    const refused = await createChannel("overflow");
    assert.equal(refused.status, 402);
    assert.equal(
      refused.body.error,
      "Your Free plan includes 3 Channels. Upgrade to Growth for unlimited Channels.",
    );
    // DMs are how AI Employees talk to humans — never capped.
    const dm = await api("POST", "/workspace/dms", { targetEmployeeId: employee.id });
    assert.equal(dm.status, 200);
  });

  test("a Growth-plan company is uncapped", async () => {
    await upgradeToGrowth();
    for (const name of ["a", "b", "c", "d"]) {
      assert.equal((await createChannel(name)).status, 201);
    }
  });
});

describe("Free plan Project cap", () => {
  test("one Project lands; the second is a 402 with the upgrade message", async () => {
    assert.equal((await createProject("Launch")).status, 200);
    const refused = await createProject("Second");
    assert.equal(refused.status, 402);
    assert.equal(
      refused.body.error,
      "Your Free plan includes 1 Project. Upgrade to Growth for unlimited Projects.",
    );
  });
});

describe("Free plan Todo cap", () => {
  test("twenty Todos land; the twenty-first is a 402 with the upgrade message", async () => {
    const project = await createProject("Launch");
    assert.equal(project.status, 200);
    const pSlug = project.body.slug as string;
    for (let i = 1; i <= 20; i += 1) {
      assert.equal((await createTodo(pSlug, { title: `Todo ${i}` })).status, 200);
    }
    const refused = await createTodo(pSlug, { title: "Todo 21" });
    assert.equal(refused.status, 402);
    assert.equal(
      refused.body.error,
      "Your Free plan includes 20 Todos. Upgrade to Growth for unlimited Todos.",
    );
  });

  test("completing a recurring Todo at the cap skips the spawn but the PATCH succeeds", async () => {
    const project = await createProject("Launch");
    const pSlug = project.body.slug as string;
    for (let i = 1; i <= 19; i += 1) {
      assert.equal((await createTodo(pSlug, { title: `Filler ${i}` })).status, 200);
    }
    const recurring = await createTodo(pSlug, {
      title: "Weekly report",
      recurrence: "weekly",
      dueAt: new Date().toISOString(),
    });
    assert.equal(recurring.status, 200);

    const done = await api("PATCH", `/todos/${recurring.body.id as string}`, {
      status: "done",
    });
    assert.equal(done.status, 200);
    const { AppDataSource } = await import("../db/datasource.js");
    // Still exactly 20 — the next occurrence was silently skipped.
    assert.equal(await AppDataSource.getRepository(Todo).count(), 20);
  });

  test("below the cap the recurrence still spawns", async () => {
    const project = await createProject("Launch");
    const pSlug = project.body.slug as string;
    const recurring = await createTodo(pSlug, {
      title: "Weekly report",
      recurrence: "weekly",
      dueAt: new Date().toISOString(),
    });
    assert.equal(recurring.status, 200);
    const done = await api("PATCH", `/todos/${recurring.body.id as string}`, {
      status: "done",
    });
    assert.equal(done.status, 200);
    const { AppDataSource } = await import("../db/datasource.js");
    assert.equal(await AppDataSource.getRepository(Todo).count(), 2);
  });

  test("without instance billing there is no cap", async () => {
    await disableBilling();
    const project = await createProject("Launch");
    const pSlug = project.body.slug as string;
    for (let i = 1; i <= 21; i += 1) {
      assert.equal((await createTodo(pSlug, { title: `Todo ${i}` })).status, 200);
    }
  });
});
