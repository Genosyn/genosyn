import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AppSetting } from "../../db/entities/AppSetting.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  BILLING_SETTING_KEY,
  getBillingSettings,
  invalidateBillingSettingsCache,
  updateBillingSettings,
} from "./billingSettings.js";

/**
 * Annual billing added two price ids and renamed the two that existed.
 * The rename is only safe because the stored row is still read under its old
 * keys — an install that upgrades must keep charging without an operator
 * touching Admin → Billing, so that fallback is pinned here.
 */

async function storeRaw(value: Record<string, unknown>): Promise<void> {
  await insert(AppSetting, { key: BILLING_SETTING_KEY, value: JSON.stringify(value) });
  invalidateBillingSettingsCache();
}

async function readRaw(): Promise<Record<string, unknown>> {
  const row = await AppDataSource.getRepository(AppSetting).findOneByOrFail({
    key: BILLING_SETTING_KEY,
  });
  return JSON.parse(row.value) as Record<string, unknown>;
}

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  invalidateBillingSettingsCache();
});

describe("reading settings written before annual billing existed", () => {
  test("the superseded price ids are read as the monthly ids", async () => {
    await storeRaw({
      enabled: true,
      growthPriceId: "price_legacy_growth",
      scalePriceId: "price_legacy_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    });

    const settings = await getBillingSettings();
    assert.equal(settings.growthMonthlyPriceId, "price_legacy_growth");
    assert.equal(settings.scaleMonthlyPriceId, "price_legacy_scale");
    assert.equal(settings.growthAnnualPriceId, "", "annual is simply not configured yet");
    assert.equal(settings.scaleAnnualPriceId, "");
    assert.equal(settings.enabled, true, "billing keeps running across the upgrade");
  });

  test("a current key wins over the legacy key it replaced", async () => {
    await storeRaw({
      enabled: true,
      growthMonthlyPriceId: "price_current",
      growthPriceId: "price_legacy",
      scaleMonthlyPriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    });

    assert.equal((await getBillingSettings()).growthMonthlyPriceId, "price_current");
  });

  test("the next save rewrites the row under the current names", async () => {
    await storeRaw({
      enabled: false,
      growthPriceId: "price_legacy_growth",
      scalePriceId: "price_legacy_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    });

    await updateBillingSettings({
      enabled: false,
      growthMonthlyPriceId: "price_legacy_growth",
      growthAnnualPriceId: "price_growth_year",
      scaleMonthlyPriceId: "price_legacy_scale",
      scaleAnnualPriceId: "price_scale_year",
    });

    const raw = await readRaw();
    assert.equal(raw.growthMonthlyPriceId, "price_legacy_growth");
    assert.equal(raw.growthAnnualPriceId, "price_growth_year");
    assert.ok(!("growthPriceId" in raw), "the superseded key is gone");
    assert.ok(!("scalePriceId" in raw), "the superseded key is gone");
  });
});

describe("enabling billing", () => {
  const MONTHLY_ONLY = {
    growthMonthlyPriceId: "price_growth",
    growthAnnualPriceId: "",
    scaleMonthlyPriceId: "price_scale",
    scaleAnnualPriceId: "",
  };

  test("annual ids are optional — an install may sell monthly only", async () => {
    const saved = await updateBillingSettings({
      enabled: true,
      ...MONTHLY_ONLY,
      secretKey: "sk_test_x",
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.growthAnnualPriceId, "");
    assert.equal(saved.hasSecretKey, true);
  });

  test("a missing monthly id still refuses to enable", async () => {
    await assert.rejects(
      updateBillingSettings({
        enabled: true,
        ...MONTHLY_ONLY,
        scaleMonthlyPriceId: "",
        secretKey: "sk_test_x",
      }),
      /monthly price IDs/,
    );
  });

  test("secrets are never echoed back, only their presence", async () => {
    const saved = await updateBillingSettings({
      enabled: false,
      ...MONTHLY_ONLY,
      secretKey: "sk_test_x",
      webhookSecret: "whsec_x",
    });
    assert.deepEqual(Object.keys(saved).sort(), [
      "enabled",
      "growthAnnualPriceId",
      "growthMonthlyPriceId",
      "hasSecretKey",
      "hasWebhookSecret",
      "scaleAnnualPriceId",
      "scaleMonthlyPriceId",
    ]);
    assert.equal(saved.hasWebhookSecret, true);
  });

  test("a blank secret on a later save keeps the stored one", async () => {
    await updateBillingSettings({ enabled: false, ...MONTHLY_ONLY, secretKey: "sk_test_x" });
    const saved = await updateBillingSettings({ enabled: true, ...MONTHLY_ONLY });
    assert.equal(saved.hasSecretKey, true, "enabling did not need the key re-entered");
  });
});
