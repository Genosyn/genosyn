import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppSetting } from "../db/entities/AppSetting.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "../services/billing/billingSettings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { adminRouter } from "./admin.js";

/**
 * Admin → Billing across the HTTP boundary: the four price ids an operator
 * configures, the two of them that are optional, and the promise that a
 * secret sent up here never comes back down.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

type AdminBillingBody = {
  enabled: boolean;
  growthMonthlyPriceId: string;
  growthAnnualPriceId: string;
  scaleMonthlyPriceId: string;
  scaleAnnualPriceId: string;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
};

const MONTHLY_ONLY = {
  growthMonthlyPriceId: "price_gm",
  growthAnnualPriceId: "",
  scaleMonthlyPriceId: "price_sm",
  scaleAnnualPriceId: "",
};

const ALL_FOUR = {
  growthMonthlyPriceId: "price_gm",
  growthAnnualPriceId: "price_ga",
  scaleMonthlyPriceId: "price_sm",
  scaleAnnualPriceId: "price_sa",
};

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
  app.use("/api/admin", adminRouter);
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
  const operator = await insert(User, {
    email: "op@example.com",
    name: "Operator",
    passwordHash: "x",
    sessionVersion: 0,
    isMasterAdmin: true,
    emailVerifiedAt: new Date(),
  });
  actingUserId = operator.id;
});

async function call<T = AdminBillingBody>(
  method: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/admin/billing`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("GET /api/admin/billing", () => {
  test("an unconfigured install reports four blank ids and no secrets", async () => {
    const got = await call("GET");
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, {
      enabled: false,
      growthMonthlyPriceId: "",
      growthAnnualPriceId: "",
      scaleMonthlyPriceId: "",
      scaleAnnualPriceId: "",
      hasSecretKey: false,
      hasWebhookSecret: false,
    });
  });

  test("an install configured before annual existed reads its ids as the monthly pair", async () => {
    await insert(AppSetting, {
      key: BILLING_SETTING_KEY,
      value: JSON.stringify({
        enabled: true,
        growthPriceId: "price_old_growth",
        scalePriceId: "price_old_scale",
        encryptedSecretKey: "",
        encryptedWebhookSecret: "",
      }),
    });
    invalidateBillingSettingsCache();

    const got = await call("GET");
    assert.equal(got.body.growthMonthlyPriceId, "price_old_growth");
    assert.equal(got.body.scaleMonthlyPriceId, "price_old_scale");
    assert.equal(got.body.growthAnnualPriceId, "");
  });
});

describe("PUT /api/admin/billing", () => {
  test("stores all four price ids", async () => {
    const got = await call("PUT", { enabled: false, ...ALL_FOUR });
    assert.equal(got.status, 200);
    assert.equal(got.body.growthAnnualPriceId, "price_ga");
    assert.equal(got.body.scaleAnnualPriceId, "price_sa");
    assert.deepEqual(
      (await call("GET")).body,
      got.body,
      "a re-read agrees with what the save answered",
    );
  });

  test("the annual ids may be omitted entirely — they default to blank", async () => {
    const got = await call("PUT", {
      enabled: false,
      growthMonthlyPriceId: "price_gm",
      scaleMonthlyPriceId: "price_sm",
    });
    assert.equal(got.status, 200);
    assert.equal(got.body.growthAnnualPriceId, "");
    assert.equal(got.body.scaleAnnualPriceId, "");
  });

  test("billing can be enabled with monthly prices only", async () => {
    const got = await call("PUT", {
      enabled: true,
      ...MONTHLY_ONLY,
      secretKey: "sk_test_admin",
    });
    assert.equal(got.status, 200);
    assert.equal(got.body.enabled, true);
  });

  test("enabling without a monthly price id is a 400 naming what is missing", async () => {
    const got = await call<{ error: string }>("PUT", {
      enabled: true,
      ...ALL_FOUR,
      scaleMonthlyPriceId: "",
      secretKey: "sk_test_admin",
    });
    assert.equal(got.status, 400);
    assert.match(got.body.error, /monthly price IDs/);
  });

  test("annual prices alone are not enough to enable", async () => {
    const got = await call<{ error: string }>("PUT", {
      enabled: true,
      growthMonthlyPriceId: "",
      growthAnnualPriceId: "price_ga",
      scaleMonthlyPriceId: "",
      scaleAnnualPriceId: "price_sa",
      secretKey: "sk_test_admin",
    });
    assert.equal(got.status, 400);
  });

  test("price ids are trimmed, so a pasted id with stray whitespace still matches", async () => {
    const got = await call("PUT", {
      enabled: false,
      ...ALL_FOUR,
      growthAnnualPriceId: "  price_ga  ",
    });
    assert.equal(got.body.growthAnnualPriceId, "price_ga");
  });

  test("secrets are write-only across this boundary", async () => {
    const got = await call<AdminBillingBody & Record<string, unknown>>("PUT", {
      enabled: false,
      ...ALL_FOUR,
      secretKey: "sk_test_admin",
      webhookSecret: "whsec_admin",
    });
    assert.equal(got.body.hasSecretKey, true);
    assert.equal(got.body.hasWebhookSecret, true);
    assert.equal(got.body.secretKey, undefined, "the key is never echoed back");
    assert.equal(got.body.webhookSecret, undefined);
  });

  test("an unknown price field never reaches storage", async () => {
    const got = await call<{ error: string }>("PUT", {
      enabled: false,
      ...ALL_FOUR,
      growthQuarterlyPriceId: "price_gq",
    });
    // The schema is not strict, so the extra key is stripped; what matters is
    // that it never reaches storage as a price id we would later read.
    assert.equal(got.status, 200);
    const reread = (await call("GET")).body as unknown as Record<string, unknown>;
    assert.equal(reread.growthQuarterlyPriceId, undefined);
  });

  test("a price id longer than the column allows is a validation 400", async () => {
    const got = await call<{ error: string }>("PUT", {
      enabled: false,
      ...ALL_FOUR,
      growthAnnualPriceId: "p".repeat(256),
    });
    assert.equal(got.status, 400);
    assert.equal(got.body.error, "ValidationError");
  });
});
