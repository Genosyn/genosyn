import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

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
 * `customer.subscription.updated` (which embeds the subscription object, so
 * no Stripe fetch is involved) upserts the local plan/seat state; a bad
 * signature is a 400 that writes nothing.
 */

const WEBHOOK_SECRET = "whsec_route_test";

let server: Server;
let baseUrl = "";

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
      encryptedSecretKey: "",
      encryptedWebhookSecret: encryptSecret(WEBHOOK_SECRET),
    }),
  });
  invalidateBillingSettingsCache();
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

function subscriptionEvent(companyId: string): string {
  return JSON.stringify({
    id: "evt_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        object: "subscription",
        status: "active",
        customer: "cus_9",
        current_period_end: 1_900_000_000,
        items: { data: [{ id: "si_1", price: { id: "price_scale" }, quantity: 4 }] },
        metadata: { companyId },
      },
    },
  });
}

describe("POST /api/billing/stripe/webhook", () => {
  test("a signed subscription.updated upserts plan, seats and period end", async () => {
    const cid = testCompanyId();
    const raw = subscriptionEvent(cid);
    const got = await post(raw, stripeHeader(raw));
    assert.equal(got.status, 200);
    assert.deepEqual(JSON.parse(got.body), { received: true });

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
    const first = subscriptionEvent(cid);
    await post(first, stripeHeader(first));
    const second = first
      .replace('"status":"active"', '"status":"canceled"')
      .replace('"quantity":4', '"quantity":1');
    await post(second, stripeHeader(second));
    const rows = await AppDataSource.getRepository(CompanyBilling).findBy({ companyId: cid });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "canceled");
    assert.equal(rows[0].seatCount, 1);
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
    assert.equal(await AppDataSource.getRepository(CompanyBilling).count(), 0);
  });
});
