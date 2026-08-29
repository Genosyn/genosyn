import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { CompanyBilling } from "../db/entities/CompanyBilling.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "../services/billing/billingSettings.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { billingWebhookRouter } from "./billingWebhook.js";

/**
 * The webhook receiver end to end with REAL HMAC signatures: a signed
 * `customer.subscription.updated` upserts the local plan/seat state from the
 * subscription RE-FETCHED from Stripe (the embedded snapshot is only trusted
 * to name the subscription and company — Stripe does not guarantee delivery
 * order); a bad signature is a 400 that writes nothing.
 */

const WEBHOOK_SECRET = "whsec_route_test";
const SECRET_KEY = "sk_test_route";

let server: Server;
let baseUrl = "";

// Selective fetch mock: api.stripe.com is served from `stripeSubscriptions`;
// everything else (the test's own requests to the local server) passes
// through to the real fetch.
const originalFetch = globalThis.fetch;
let stripeSubscriptions: Record<string, Record<string, unknown>> = {};
let stripeGetCalls: string[] = [];
let stripeFailure: { status: number } | null = null;

function installStripeFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.stripe.com/v1/subscriptions/")) {
      const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      stripeGetCalls.push(id);
      if (stripeFailure) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: stripeFailure.status,
        });
      }
      const raw = stripeSubscriptions[id];
      if (!raw) {
        return new Response(
          JSON.stringify({ error: { message: `No such subscription: ${id}` } }),
          { status: 404 },
        );
      }
      return new Response(JSON.stringify(raw), { status: 200 });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

before(async () => {
  await initTestDb();
  const app = express();
  // Deliberately no express.json() before the router — production mounts it
  // the same way, and the router needs the raw bytes.
  app.use("/api/billing/stripe/webhook", billingWebhookRouter);
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
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      growthPriceId: "price_growth",
      scalePriceId: "price_scale",
      encryptedSecretKey: encryptSecret(SECRET_KEY),
      encryptedWebhookSecret: encryptSecret(WEBHOOK_SECRET),
    }),
  });
  invalidateBillingSettingsCache();
  stripeSubscriptions = {};
  stripeGetCalls = [];
  stripeFailure = null;
  installStripeFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stripeHeader(rawBody: string, secret = WEBHOOK_SECRET): string {
  const t = Math.floor(Date.now() / 1000);
  const hmac = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${hmac}`;
}

async function post(rawBody: string, header: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}/api/billing/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: rawBody,
  });
  return { status: response.status, body: await response.text() };
}

function rawSubscription(
  companyId: string,
  overrides: Partial<{ status: string; quantity: number }> = {},
): Record<string, unknown> {
  return {
    id: "sub_123",
    object: "subscription",
    status: overrides.status ?? "active",
    customer: "cus_9",
    current_period_end: 1_900_000_000,
    items: {
      data: [{ id: "si_1", price: { id: "price_scale" }, quantity: overrides.quantity ?? 4 }],
    },
    metadata: { companyId },
  };
}

function subscriptionEvent(companyId: string): string {
  return JSON.stringify({
    id: "evt_1",
    type: "customer.subscription.updated",
    data: { object: rawSubscription(companyId) },
  });
}

describe("POST /api/billing/stripe/webhook", () => {
  test("a signed subscription.updated re-fetches and upserts plan, seats and period end", async () => {
    const cid = testCompanyId();
    stripeSubscriptions["sub_123"] = rawSubscription(cid);
    const raw = subscriptionEvent(cid);
    const got = await post(raw, stripeHeader(raw));
    assert.equal(got.status, 200);
    assert.deepEqual(JSON.parse(got.body), { received: true });
    assert.deepEqual(stripeGetCalls, ["sub_123"]);

    const row = await AppDataSource.getRepository(CompanyBilling).findOneBy({ companyId: cid });
    assert.ok(row);
    assert.equal(row.plan, "scale");
    assert.equal(row.status, "active");
    assert.equal(row.seatCount, 4);
    assert.equal(row.stripeSubscriptionId, "sub_123");
    assert.equal(row.stripeSubscriptionItemId, "si_1");
    assert.equal(row.stripeCustomerId, "cus_9");
    assert.equal(row.currentPeriodEnd?.getTime(), 1_900_000_000_000);
  });

  test("a later event updates the same row instead of adding one", async () => {
    const cid = testCompanyId();
    stripeSubscriptions["sub_123"] = rawSubscription(cid);
    const first = subscriptionEvent(cid);
    await post(first, stripeHeader(first));
    stripeSubscriptions["sub_123"] = rawSubscription(cid, { status: "canceled", quantity: 1 });
    const second = first.replace('"evt_1"', '"evt_2"');
    await post(second, stripeHeader(second));
    const rows = await AppDataSource.getRepository(CompanyBilling).findBy({ companyId: cid });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "canceled");
    assert.equal(rows[0].seatCount, 1);
  });

  test("a stale embedded snapshot cannot resurrect a canceled subscription", async () => {
    const cid = testCompanyId();
    // Stripe's current truth: the subscription is canceled. The retried event
    // still embeds the old "active" snapshot — the fetched state must win.
    stripeSubscriptions["sub_123"] = rawSubscription(cid, { status: "canceled", quantity: 1 });
    const staleEvent = subscriptionEvent(cid); // embeds status "active", 4 seats
    const got = await post(staleEvent, stripeHeader(staleEvent));
    assert.equal(got.status, 200);
    const row = await AppDataSource.getRepository(CompanyBilling).findOneBy({ companyId: cid });
    assert.ok(row);
    assert.equal(row.status, "canceled");
    assert.equal(row.seatCount, 1);
  });

  test("a failed re-fetch is a 500 that writes nothing, so Stripe retries", async () => {
    const cid = testCompanyId();
    stripeFailure = { status: 500 };
    const raw = subscriptionEvent(cid);
    const got = await post(raw, stripeHeader(raw));
    assert.equal(got.status, 500);
    assert.equal(
      await AppDataSource.getRepository(CompanyBilling).countBy({ companyId: cid }),
      0,
    );
  });

  test("without a stored secret key the event is acknowledged without effect", async () => {
    const repo = AppDataSource.getRepository(AppSetting);
    const setting = await repo.findOneByOrFail({ key: BILLING_SETTING_KEY });
    setting.value = JSON.stringify({
      enabled: true,
      growthPriceId: "price_growth",
      scalePriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: encryptSecret(WEBHOOK_SECRET),
    });
    await repo.save(setting);
    invalidateBillingSettingsCache();
    const cid = testCompanyId();
    stripeSubscriptions["sub_123"] = rawSubscription(cid);
    const raw = subscriptionEvent(cid);
    const got = await post(raw, stripeHeader(raw));
    assert.equal(got.status, 200);
    assert.deepEqual(stripeGetCalls, []);
    assert.equal(
      await AppDataSource.getRepository(CompanyBilling).countBy({ companyId: cid }),
      0,
    );
  });

  test("a bad signature is a 400 that writes nothing", async () => {
    const cid = testCompanyId();
    const raw = subscriptionEvent(cid);
    const wrongSecret = await post(raw, stripeHeader(raw, "whsec_wrong"));
    assert.equal(wrongSecret.status, 400);
    const noHeader = await post(raw, "");
    assert.equal(noHeader.status, 400);
    assert.equal(
      await AppDataSource.getRepository(CompanyBilling).countBy({ companyId: cid }),
      0,
    );
  });

  test("an unhandled event type is acknowledged without effect", async () => {
    const raw = JSON.stringify({ id: "evt_2", type: "invoice.paid", data: { object: {} } });
    const got = await post(raw, stripeHeader(raw));
    assert.equal(got.status, 200);
    assert.deepEqual(JSON.parse(got.body), { received: true });
  });

  test("an event without a companyId in metadata is ignored, not an error", async () => {
    const raw = subscriptionEvent("").replace('"companyId":""', '"other":"x"');
    const got = await post(raw, stripeHeader(raw));
    assert.equal(got.status, 200);
    // Not this install's subscription — no Stripe fetch, no row.
    assert.deepEqual(stripeGetCalls, []);
    assert.equal(await AppDataSource.getRepository(CompanyBilling).count(), 0);
  });
});
