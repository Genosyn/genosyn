import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "../services/billing/billingSettings.js";
import { invalidateLicenseCache } from "../services/license.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { billingRouter } from "./billing.js";

/**
 * The company billing endpoints over real HTTP: the frozen GET shape for a
 * Free company, the 400 when Stripe isn't configured, and the role gates —
 * reading is admin-level, spending is owner-only.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let admin: User;
let member: User;

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
  app.use("/api/companies/:cid", billingRouter);
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

async function withRole(email: string, role: Role): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  invalidateBillingSettingsCache();
  invalidateLicenseCache();
  const founder = await insert(User, {
    email: "f@example.com",
    name: "F",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  owner = await withRole("owner@example.com", "owner" as Role);
  admin = await withRole("admin@example.com", "admin" as Role);
  member = await withRole("member@example.com", "member" as Role);
  actingUserId = owner.id;
  // Billing enabled, price ids configured, but no Stripe secret stored.
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      growthPriceId: "price_growth",
      scalePriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    }),
  });
  invalidateBillingSettingsCache();
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("GET /billing", () => {
  test("returns the frozen shape for a Free company", async () => {
    const got = await call("GET", "/billing");
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, {
      enabled: true,
      plan: "free",
      status: null,
      seatCount: null,
      aiEmployeeCount: 0,
      routineCount: 0,
      currentPeriodEnd: null,
      limits: { maxAiEmployees: 1, maxRoutines: 2 },
      features: { sso: false, auditLog: false },
      prices: {
        growth: { unitAmount: 1900, currency: "usd", configured: true },
        scale: { unitAmount: 4900, currency: "usd", configured: true },
      },
      stripeConfigured: false,
      portalAvailable: false,
    });
  });

  test("an admin can read; a plain member cannot", async () => {
    actingUserId = admin.id;
    assert.equal((await call("GET", "/billing")).status, 200);
    actingUserId = member.id;
    assert.equal((await call("GET", "/billing")).status, 403);
  });
});

describe("POST /billing/checkout", () => {
  test("400 with a clear message while Stripe is unconfigured", async () => {
    const got = await call<{ error: string }>("POST", "/billing/checkout", { plan: "growth" });
    assert.equal(got.status, 400);
    assert.match(got.body.error, /Stripe is not configured/);
  });

  test("role gates: member and admin get 403; only the owner reaches the handler", async () => {
    actingUserId = member.id;
    assert.equal((await call("POST", "/billing/checkout", { plan: "growth" })).status, 403);
    actingUserId = admin.id;
    assert.equal((await call("POST", "/billing/checkout", { plan: "growth" })).status, 403);
    actingUserId = owner.id;
    assert.equal((await call("POST", "/billing/checkout", { plan: "growth" })).status, 400);
  });

  test("a bad plan value is a zod 400", async () => {
    const got = await call<{ error: string }>("POST", "/billing/checkout", { plan: "mega" });
    assert.equal(got.status, 400);
    assert.equal(got.body.error, "ValidationError");
  });
});

describe("POST /billing/portal", () => {
  test("owner-only, and 400 while there is no Stripe customer", async () => {
    actingUserId = admin.id;
    assert.equal((await call("POST", "/billing/portal")).status, 403);
    actingUserId = owner.id;
    const got = await call<{ error: string }>("POST", "/billing/portal");
    assert.equal(got.status, 400);
    assert.match(got.body.error, /Stripe is not configured/);
  });
});

describe("POST /billing/sync", () => {
  test("without a subscription it just re-reads the summary", async () => {
    const got = await call<{ plan: string }>("POST", "/billing/sync");
    assert.equal(got.status, 200);
    assert.equal(got.body.plan, "free");
  });
});
