import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "../services/billing/billingSettings.js";
import { invalidateLicenseCache } from "../services/license.js";
import { setPublicUrl } from "../services/publicUrl.js";
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
      growthMonthlyPriceId: "price_growth",
      scaleMonthlyPriceId: "price_scale",
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
      interval: null,
      status: null,
      seatCount: null,
      aiEmployeeCount: 0,
      routineCount: 0,
      currentPeriodEnd: null,
      limits: {
        maxAiEmployees: 1,
        maxRoutines: 2,
        maxBases: 1,
        maxBaseTables: 1,
        maxChannels: 3,
        maxProjects: 1,
        maxTodos: 20,
      },
      features: { sso: false, auditLog: false },
      prices: {
        currency: "usd",
        // Annual is unconfigured in this fixture — the shape still carries the
        // list prices so the client can render them as unavailable.
        growth: {
          month: { unitAmount: 1900, configured: true },
          year: { unitAmount: 20520, configured: false },
        },
        scale: {
          month: { unitAmount: 4900, configured: true },
          year: { unitAmount: 52920, configured: false },
        },
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

  test("annual price ids flip the configured flags without changing the amounts", async () => {
    const repo = AppDataSource.getRepository(AppSetting);
    const setting = await repo.findOneByOrFail({ key: BILLING_SETTING_KEY });
    setting.value = JSON.stringify({
      enabled: true,
      growthMonthlyPriceId: "price_growth",
      growthAnnualPriceId: "price_growth_year",
      scaleMonthlyPriceId: "price_scale",
      scaleAnnualPriceId: "",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    });
    await repo.save(setting);
    invalidateBillingSettingsCache();

    const got = await call<{ prices: Record<string, Record<string, unknown>> }>(
      "GET",
      "/billing",
    );
    assert.deepEqual(got.body.prices.growth, {
      month: { unitAmount: 1900, configured: true },
      year: { unitAmount: 20520, configured: true },
    });
    assert.deepEqual(got.body.prices.scale, {
      month: { unitAmount: 4900, configured: true },
      year: { unitAmount: 52920, configured: false },
    });
  });

  test("a company on an annual subscription reports the year interval", async () => {
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "scale",
      billingInterval: "year",
      status: "active",
      seatCount: 3,
    });
    const got = await call<{ plan: string; interval: string | null }>("GET", "/billing");
    assert.equal(got.body.plan, "scale");
    assert.equal(got.body.interval, "year");
  });

  test("a paid row from before annual existed reports monthly, which is what it was", async () => {
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "growth",
      status: "active",
      seatCount: 1,
    });
    const got = await call<{ interval: string | null }>("GET", "/billing");
    assert.equal(got.body.interval, "month");
  });

  test("a lapsed subscription reports Free with no interval at all", async () => {
    // The row still carries "year" from the plan they used to pay for; a
    // canceled company is not billed annually, it is not billed.
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "scale",
      billingInterval: "year",
      status: "canceled",
      seatCount: 3,
    });
    const got = await call<{ plan: string; interval: string | null }>("GET", "/billing");
    assert.equal(got.body.plan, "free");
    assert.equal(got.body.interval, null);
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

/**
 * The checkout route against a captured Stripe `fetch`: a company with a live
 * subscription switches plans in place (never a second Checkout session), and
 * the pre-checkout sync adopts a subscription whose webhook has not landed so
 * a duplicate click is refused instead of double-billing.
 */
describe("POST /billing/checkout with Stripe configured", () => {
  const originalFetch = globalThis.fetch;
  type StripeCall = { method: string; url: string; body: string };
  let stripeCalls: StripeCall[] = [];
  let stripeHandler: (call: StripeCall) => Response = () =>
    new Response(JSON.stringify({}), { status: 200 });

  function rawSubscription(
    overrides: Partial<{ id: string; status: string; priceId: string; quantity: number }> = {},
  ): Record<string, unknown> {
    return {
      id: overrides.id ?? "sub_1",
      object: "subscription",
      status: overrides.status ?? "active",
      current_period_end: 1_900_000_000,
      items: {
        data: [
          {
            id: "si_1",
            price: { id: overrides.priceId ?? "price_growth" },
            quantity: overrides.quantity ?? 1,
          },
        ],
      },
      metadata: { companyId: company.id },
    };
  }

  beforeEach(async () => {
    const repo = AppDataSource.getRepository(AppSetting);
    const setting = await repo.findOneByOrFail({ key: BILLING_SETTING_KEY });
    setting.value = JSON.stringify({
      enabled: true,
      growthMonthlyPriceId: "price_growth",
      scaleMonthlyPriceId: "price_scale",
      encryptedSecretKey: encryptSecret("sk_test_route"),
      encryptedWebhookSecret: "",
    });
    await repo.save(setting);
    invalidateBillingSettingsCache();
    await setPublicUrl("https://app.example.com");
    stripeCalls = [];
    stripeHandler = () => new Response(JSON.stringify({}), { status: 200 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.stripe.com/")) {
        const stripeCall: StripeCall = {
          method: init?.method ?? "GET",
          url,
          body: init?.body ? String(init.body) : "",
        };
        stripeCalls.push(stripeCall);
        return stripeHandler(stripeCall);
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a live subscription on the other paid plan is switched in place, never re-checked-out", async () => {
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "growth",
      status: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionItemId: "si_1",
      seatCount: 1,
    });
    stripeHandler = (stripeCall) => {
      if (stripeCall.method === "GET" && stripeCall.url.includes("/v1/subscriptions/sub_1")) {
        return new Response(JSON.stringify(rawSubscription()), { status: 200 });
      }
      if (stripeCall.method === "POST" && stripeCall.url.endsWith("/v1/subscriptions/sub_1")) {
        return new Response(JSON.stringify(rawSubscription({ priceId: "price_scale" })), {
          status: 200,
        });
      }
      throw new Error(`unexpected Stripe call: ${stripeCall.method} ${stripeCall.url}`);
    };

    const got = await call<{ url: string }>("POST", "/billing/checkout", { plan: "scale" });

    assert.equal(got.status, 200);
    assert.equal(
      got.body.url,
      "https://app.example.com/c/acme/settings/billing?checkout=success",
    );
    const switchCall = stripeCalls.find((c) => c.method === "POST");
    assert.ok(switchCall, "the existing subscription was updated");
    const params = new URLSearchParams(switchCall.body);
    assert.equal(params.get("items[0][id]"), "si_1");
    assert.equal(params.get("items[0][price]"), "price_scale");
    assert.equal(params.get("proration_behavior"), "create_prorations");
    assert.ok(
      !stripeCalls.some((c) => c.url.includes("/v1/checkout/sessions")),
      "no second subscription is minted via Checkout",
    );
    const row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(row.plan, "scale");
  });

  test("a duplicate click after checkout adopts the fresh subscription and is refused", async () => {
    // The webhook has not landed: the row knows the customer but no
    // subscription, and the local plan still reads free.
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "free",
      stripeCustomerId: "cus_1",
    });
    stripeHandler = (stripeCall) => {
      if (stripeCall.method === "GET" && stripeCall.url.includes("customer=cus_1")) {
        return new Response(JSON.stringify({ data: [rawSubscription()] }), { status: 200 });
      }
      throw new Error(`unexpected Stripe call: ${stripeCall.method} ${stripeCall.url}`);
    };

    const got = await call<{ error: string }>("POST", "/billing/checkout", { plan: "growth" });

    assert.equal(got.status, 400);
    assert.match(got.body.error, /already on the growth plan/);
    assert.ok(!stripeCalls.some((c) => c.url.includes("/v1/checkout/sessions")));
    const row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(row.stripeSubscriptionId, "sub_1");
    assert.equal(row.plan, "growth");
  });

  test("a first checkout still creates customer and session; a failed pre-sync is best-effort", async () => {
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "free",
      stripeCustomerId: "cus_1",
    });
    stripeHandler = (stripeCall) => {
      if (stripeCall.method === "GET" && stripeCall.url.includes("customer=cus_1")) {
        // The pre-checkout sync fails — it must not block the checkout.
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      }
      if (stripeCall.url.includes("/v1/checkout/sessions")) {
        return new Response(JSON.stringify({ url: "https://checkout.stripe.com/pay/cs_1" }), {
          status: 200,
        });
      }
      throw new Error(`unexpected Stripe call: ${stripeCall.method} ${stripeCall.url}`);
    };

    const got = await call<{ url: string }>("POST", "/billing/checkout", { plan: "growth" });

    assert.equal(got.status, 200);
    assert.equal(got.body.url, "https://checkout.stripe.com/pay/cs_1");
    const sessionCall = stripeCalls.find((c) => c.url.includes("/v1/checkout/sessions"));
    assert.ok(sessionCall);
    const params = new URLSearchParams(sessionCall.body);
    assert.equal(params.get("customer"), "cus_1");
    assert.equal(params.get("line_items[0][price]"), "price_growth");
  });

  /** Add the annual price ids the base fixture deliberately leaves blank. */
  async function configureAnnualPrices(): Promise<void> {
    const repo = AppDataSource.getRepository(AppSetting);
    const setting = await repo.findOneByOrFail({ key: BILLING_SETTING_KEY });
    setting.value = JSON.stringify({
      enabled: true,
      growthMonthlyPriceId: "price_growth",
      growthAnnualPriceId: "price_growth_year",
      scaleMonthlyPriceId: "price_scale",
      scaleAnnualPriceId: "price_scale_year",
      encryptedSecretKey: encryptSecret("sk_test_route"),
      encryptedWebhookSecret: "",
    });
    await repo.save(setting);
    invalidateBillingSettingsCache();
  }

  test("asking for annual on an install that never configured it is a named 400", async () => {
    const got = await call<{ error: string }>("POST", "/billing/checkout", {
      plan: "growth",
      interval: "year",
    });
    assert.equal(got.status, 400);
    assert.match(got.body.error, /Annual billing is not configured for the growth plan/);
    assert.equal(stripeCalls.length, 0, "nothing is sent to Stripe");
  });

  test("a first annual checkout sells the annual price", async () => {
    await configureAnnualPrices();
    stripeHandler = (stripeCall) => {
      if (stripeCall.url.includes("/v1/customers")) {
        return new Response(JSON.stringify({ id: "cus_new" }), { status: 200 });
      }
      if (stripeCall.url.includes("/v1/checkout/sessions")) {
        return new Response(JSON.stringify({ url: "https://checkout.stripe.com/pay/cs_2" }), {
          status: 200,
        });
      }
      throw new Error(`unexpected Stripe call: ${stripeCall.method} ${stripeCall.url}`);
    };

    const got = await call<{ url: string }>("POST", "/billing/checkout", {
      plan: "scale",
      interval: "year",
    });

    assert.equal(got.status, 200);
    const sessionCall = stripeCalls.find((c) => c.url.includes("/v1/checkout/sessions"));
    assert.ok(sessionCall);
    assert.equal(
      new URLSearchParams(sessionCall.body).get("line_items[0][price]"),
      "price_scale_year",
    );
  });

  // The bug this whole change exists to fix: before intervals, "same plan"
  // was the only comparison, so a monthly subscriber asking for annual was
  // told they were already on it.
  test("moving from monthly to annual on the same plan switches in place instead of being refused", async () => {
    await configureAnnualPrices();
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "growth",
      billingInterval: "month",
      status: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionItemId: "si_1",
      seatCount: 1,
    });
    stripeHandler = (stripeCall) => {
      if (stripeCall.method === "GET" && stripeCall.url.includes("/v1/subscriptions/sub_1")) {
        return new Response(JSON.stringify(rawSubscription()), { status: 200 });
      }
      if (stripeCall.method === "POST" && stripeCall.url.endsWith("/v1/subscriptions/sub_1")) {
        return new Response(
          JSON.stringify(rawSubscription({ priceId: "price_growth_year" })),
          { status: 200 },
        );
      }
      throw new Error(`unexpected Stripe call: ${stripeCall.method} ${stripeCall.url}`);
    };

    const got = await call<{ url: string }>("POST", "/billing/checkout", {
      plan: "growth",
      interval: "year",
    });

    assert.equal(got.status, 200);
    const switchCall = stripeCalls.find((c) => c.method === "POST");
    assert.ok(switchCall, "the existing subscription was repriced");
    const params = new URLSearchParams(switchCall.body);
    assert.equal(params.get("items[0][price]"), "price_growth_year");
    assert.equal(params.get("proration_behavior"), "create_prorations");
    assert.ok(
      !stripeCalls.some((c) => c.url.includes("/v1/checkout/sessions")),
      "no second subscription is minted",
    );
    const row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(row.plan, "growth");
    assert.equal(row.billingInterval, "year");
  });

  test("asking for the plan and interval already held is still refused", async () => {
    await configureAnnualPrices();
    await insert(CompanyBilling, {
      companyId: company.id,
      plan: "growth",
      billingInterval: "year",
      status: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionItemId: "si_1",
      seatCount: 1,
    });
    stripeHandler = (stripeCall) => {
      if (stripeCall.method === "GET" && stripeCall.url.includes("/v1/subscriptions/sub_1")) {
        return new Response(JSON.stringify(rawSubscription({ priceId: "price_growth_year" })), {
          status: 200,
        });
      }
      throw new Error(`unexpected Stripe call: ${stripeCall.method} ${stripeCall.url}`);
    };

    const got = await call<{ error: string }>("POST", "/billing/checkout", {
      plan: "growth",
      interval: "year",
    });

    assert.equal(got.status, 400);
    assert.match(got.body.error, /already on the growth plan, billed annually/);
  });

  test("a bad interval value is a zod 400", async () => {
    const got = await call<{ error: string }>("POST", "/billing/checkout", {
      plan: "growth",
      interval: "fortnight",
    });
    assert.equal(got.status, 400);
    assert.equal(got.body.error, "ValidationError");
  });
});
