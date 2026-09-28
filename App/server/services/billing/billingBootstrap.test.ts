import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AppSetting } from "../../db/entities/AppSetting.js";
import { resetInstanceSecretsCacheForTests } from "../../lib/instanceSecrets.js";
import { closeTestDb, initTestDb, resetTestDb } from "../../test/dbHarness.js";
import { initializeBillingSettings, takeBillingBootstrapJson } from "./billingBootstrap.js";
import {
  BILLING_SETTING_KEY,
  billingEnabled,
  getBillingSettings,
  getStripeSecrets,
  invalidateBillingSettingsCache,
  updateBillingSettings,
} from "./billingSettings.js";

const ENV = "GENOSYN_BILLING_BOOTSTRAP_JSON";
const VALID = {
  enabled: true,
  secretKey: "sk_test_SyntheticBootstrapCredential123",
  webhookSecret: "whsec_SyntheticBootstrapWebhook123",
  growthMonthlyPriceId: "price_growthMonthly123",
  scaleMonthlyPriceId: "price_scaleMonthly123",
};
const original = {
  sessionSecret: config.sessionSecret,
  encryptionSecret: config.security.encryptionSecret,
  multiTenant: config.security.multiTenant,
  bootstrap: process.env[ENV],
};

before(async () => {
  config.sessionSecret = "synthetic-billing-session-secret-123456789";
  config.security.encryptionSecret = "synthetic-billing-encryption-secret-987654321";
  config.security.multiTenant = true;
  resetInstanceSecretsCacheForTests();
  await initTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  invalidateBillingSettingsCache();
  delete process.env[ENV];
});
afterEach(() => {
  delete process.env[ENV];
});
after(async () => {
  await closeTestDb();
  config.sessionSecret = original.sessionSecret;
  config.security.encryptionSecret = original.encryptionSecret;
  config.security.multiTenant = original.multiTenant;
  if (original.bootstrap !== undefined) process.env[ENV] = original.bootstrap;
  resetInstanceSecretsCacheForTests();
});

async function storedRow(): Promise<AppSetting> {
  return AppDataSource.getRepository(AppSetting).findOneByOrFail({ key: BILLING_SETTING_KEY });
}

describe("billing bootstrap", () => {
  test("takes the bootstrap JSON out of the environment before any asynchronous work", () => {
    const raw = JSON.stringify(VALID);
    process.env[ENV] = raw;
    assert.equal(takeBillingBootstrapJson(), raw);
    assert.equal(process.env[ENV], undefined);
    assert.equal(takeBillingBootstrapJson(), undefined);
    process.env[ENV] = "malformed synthetic input";
    assert.equal(takeBillingBootstrapJson(), "malformed synthetic input");
    assert.equal(process.env[ENV], undefined);
  });

  test("missing or empty bootstrap leaves the database untouched", async (t) => {
    t.mock.method(AppDataSource.getRepository(AppSetting), "existsBy", () => {
      throw new Error("The bootstrap should not query the database.");
    });
    for (const raw of [undefined, "", " \n\t "]) await initializeBillingSettings(raw);
    assert.equal(await AppDataSource.getRepository(AppSetting).count(), 0);
  });

  test("encrypts credentials, enables billing, and exposes only presence flags", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", () => {
      throw new Error("Billing bootstrap must not contact Stripe.");
    });
    assert.equal(await billingEnabled(), false);
    await initializeBillingSettings(JSON.stringify(VALID));

    const row = await storedRow();
    assert.ok(!row.value.includes(VALID.secretKey));
    assert.ok(!row.value.includes(VALID.webhookSecret));
    const stored = JSON.parse(row.value) as Record<string, unknown>;
    assert.match(String(stored.encryptedSecretKey), /^v2\./);
    assert.match(String(stored.encryptedWebhookSecret), /^v2\./);
    assert.ok(!("secretKey" in stored));
    assert.ok(!("webhookSecret" in stored));
    assert.deepEqual(await getStripeSecrets(), {
      secretKey: VALID.secretKey,
      webhookSecret: VALID.webhookSecret,
    });
    assert.deepEqual(await getBillingSettings(), {
      enabled: true,
      growthMonthlyPriceId: VALID.growthMonthlyPriceId,
      scaleMonthlyPriceId: VALID.scaleMonthlyPriceId,
      growthAnnualPriceId: "",
      scaleAnnualPriceId: "",
      hasSecretKey: true,
      hasWebhookSecret: true,
    });
    assert.equal(await billingEnabled(), true, "initial setup invalidates the enabled cache");
    assert.equal(fetch.mock.callCount(), 0);
  });

  for (const prefix of ["sk_test", "sk_live", "rk_test", "rk_live"]) {
    test(`accepts ${prefix} keys and trims optional annual IDs`, async () => {
      await initializeBillingSettings(
        JSON.stringify({
          ...VALID,
          secretKey: `  ${prefix}_SyntheticCredential123  `,
          webhookSecret: `  ${VALID.webhookSecret}  `,
          growthMonthlyPriceId: ` ${VALID.growthMonthlyPriceId} `,
          growthAnnualPriceId: " price_growthAnnual123 ",
          scaleAnnualPriceId: " \t ",
        }),
      );
      assert.equal((await getStripeSecrets()).secretKey, `${prefix}_SyntheticCredential123`);
      assert.equal((await getStripeSecrets()).webhookSecret, VALID.webhookSecret);
      assert.equal((await getBillingSettings()).growthMonthlyPriceId, VALID.growthMonthlyPriceId);
      assert.equal((await getBillingSettings()).growthAnnualPriceId, "price_growthAnnual123");
      assert.equal((await getBillingSettings()).scaleAnnualPriceId, "");
    });
  }

  test("rejects invalid JSON, credentials, price IDs and duplicate prices without leaking input", async () => {
    const invalid = [
      '{"secretKey":"synthetic-leak-sentinel"',
      "null",
      "[]",
      "{}",
      " ".repeat(16 * 1024) + JSON.stringify(VALID),
      ...[
        { enabled: false },
        { enabled: "true" },
        { secretKey: "pk_test_SyntheticCredential" },
        { secretKey: "sk_test_" },
        { secretKey: "sk_live_Synthetic_Unsupported" },
        { secretKey: 123 },
        { secretKey: `sk_test_${"x".repeat(512)}` },
        { webhookSecret: "sk_test_SyntheticWebhook" },
        { webhookSecret: "whsec_" },
        { webhookSecret: null },
        { growthMonthlyPriceId: "" },
        { scaleMonthlyPriceId: "prod_synthetic" },
        { growthAnnualPriceId: "price_" },
        { scaleAnnualPriceId: null },
        { scaleMonthlyPriceId: VALID.growthMonthlyPriceId },
        { growthAnnualPriceId: ` ${VALID.scaleMonthlyPriceId} ` },
        { growthAnnualPriceId: "price_annual123", scaleAnnualPriceId: "price_annual123" },
        { unexpectedCredential: "synthetic-leak-sentinel" },
      ].map((patch) => JSON.stringify({ ...VALID, ...patch })),
    ];
    for (const raw of invalid) {
      await assert.rejects(initializeBillingSettings(raw), (error: Error) => {
        assert.equal(
          error.message,
          "Invalid billing bootstrap settings. Supply enabled=true, Stripe secret and webhook keys, and distinct price IDs for both monthly Plans and any annual Plans.",
        );
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(await AppDataSource.getRepository(AppSetting).count(), 0);
    }
  });

  test("every existing row wins, including blank, malformed, disabled, or legacy settings", async () => {
    const repo = AppDataSource.getRepository(AppSetting);
    for (const value of [
      "",
      "invalid persisted JSON",
      '{"enabled":false}',
      '{"growthPriceId":"price_legacy"}',
    ]) {
      await repo.save(repo.create({ key: BILLING_SETTING_KEY, value }));
      const before = await storedRow();
      for (const raw of ["malformed input", "x".repeat(20_000), JSON.stringify(VALID)]) {
        await initializeBillingSettings(raw);
        assert.deepEqual(await storedRow(), before);
      }
    }
  });

  test("later Admin changes survive another bootstrap and preserve normal blank-secret saves", async () => {
    await initializeBillingSettings(JSON.stringify(VALID));
    await updateBillingSettings({
      enabled: false,
      growthMonthlyPriceId: "price_adminGrowth",
      scaleMonthlyPriceId: "price_adminScale",
      growthAnnualPriceId: "price_adminGrowthAnnual",
      scaleAnnualPriceId: "",
      secretKey: "sk_test_admin",
      webhookSecret: "",
    });
    const before = await storedRow();
    await initializeBillingSettings(JSON.stringify(VALID));
    assert.deepEqual(await storedRow(), before);
    assert.deepEqual(await getStripeSecrets(), {
      secretKey: "sk_test_admin",
      webhookSecret: VALID.webhookSecret,
    });
  });

  test("an Admin row inserted after the existence check cannot be overwritten", async (t) => {
    const repo = AppDataSource.getRepository(AppSetting);
    const adminValue = '{"enabled":false,"growthMonthlyPriceId":"price_admin"}';
    t.mock.method(repo, "existsBy", async () => {
      await repo.insert({ key: BILLING_SETTING_KEY, value: adminValue });
      return false;
    });
    await initializeBillingSettings(JSON.stringify(VALID));
    assert.equal((await storedRow()).value, adminValue);
    assert.equal(await repo.count(), 1);
  });

  test("concurrent first starts keep one complete configuration", async () => {
    const second = {
      ...VALID,
      secretKey: "rk_test_second",
      webhookSecret: "whsec_SecondSyntheticWebhook123",
      growthMonthlyPriceId: "price_secondGrowth",
      scaleMonthlyPriceId: "price_secondScale",
    };
    await Promise.all(
      [VALID, second].map((settings) => initializeBillingSettings(JSON.stringify(settings))),
    );
    assert.equal(await AppDataSource.getRepository(AppSetting).count(), 1);
    const secrets = await getStripeSecrets();
    const winner = secrets.secretKey === VALID.secretKey ? VALID : second;
    assert.deepEqual(secrets, { secretKey: winner.secretKey, webhookSecret: winner.webhookSecret });
    assert.equal((await getBillingSettings()).growthMonthlyPriceId, winner.growthMonthlyPriceId);
    assert.equal((await getBillingSettings()).scaleMonthlyPriceId, winner.scaleMonthlyPriceId);
  });

  test("database failures use fixed errors without attached payloads", async (t) => {
    const repo = AppDataSource.getRepository(AppSetting);
    const read = t.mock.method(repo, "existsBy", () => {
      throw new Error(`synthetic sensitive input: ${VALID.secretKey}`);
    });
    await assert.rejects(initializeBillingSettings(JSON.stringify(VALID)), (error: Error) => {
      assert.equal(error.message, "Billing bootstrap could not read stored settings.");
      assert.equal(error.cause, undefined);
      return true;
    });
    read.mock.restore();
    t.mock.method(repo, "createQueryBuilder", () => {
      throw new Error(`synthetic sensitive input: ${VALID.webhookSecret}`);
    });
    await assert.rejects(initializeBillingSettings(JSON.stringify(VALID)), (error: Error) => {
      assert.equal(error.message, "Billing bootstrap could not save initial settings.");
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});
