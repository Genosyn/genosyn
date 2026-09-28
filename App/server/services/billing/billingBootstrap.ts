import { z } from "zod";

import { AppDataSource } from "../../db/datasource.js";
import { AppSetting } from "../../db/entities/AppSetting.js";
import { encryptSecret } from "../../lib/secret.js";
import { BILLING_SETTING_KEY, invalidateBillingSettingsCache } from "./billingSettings.js";

const BOOTSTRAP_ENV = "GENOSYN_BILLING_BOOTSTRAP_JSON";
const MAX_BOOTSTRAP_BYTES = 16 * 1024;
const priceId = z
  .string()
  .trim()
  .max(512)
  .regex(/^price_[A-Za-z0-9]+$/);
const optionalPriceId = z
  .string()
  .trim()
  .max(512)
  .refine((value) => value === "" || /^price_[A-Za-z0-9]+$/.test(value))
  .default("");
const bootstrapSchema = z
  .object({
    enabled: z.literal(true),
    secretKey: z
      .string()
      .trim()
      .max(512)
      .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/),
    webhookSecret: z
      .string()
      .trim()
      .max(512)
      .regex(/^whsec_[A-Za-z0-9]+$/),
    growthMonthlyPriceId: priceId,
    scaleMonthlyPriceId: priceId,
    growthAnnualPriceId: optionalPriceId,
    scaleAnnualPriceId: optionalPriceId,
  })
  .strict()
  .refine((settings) => {
    const ids = [
      settings.growthMonthlyPriceId,
      settings.scaleMonthlyPriceId,
      settings.growthAnnualPriceId,
      settings.scaleAnnualPriceId,
    ].filter(Boolean);
    return new Set(ids).size === ids.length;
  });

/** Remove plaintext from the inherited environment before startup creates children. */
export function takeBillingBootstrapJson(): string | undefined {
  const value = process.env[BOOTSTRAP_ENV];
  delete process.env[BOOTSTRAP_ENV];
  return value;
}

function parseBootstrap(value: string): z.infer<typeof bootstrapSchema> {
  try {
    if (Buffer.byteLength(value, "utf8") > MAX_BOOTSTRAP_BYTES) throw new Error();
    return bootstrapSchema.parse(JSON.parse(value));
  } catch {
    // JSON and validation errors can contain credential text. Never retain them.
    throw new Error(
      "Invalid billing bootstrap settings. Supply enabled=true, Stripe secret and webhook keys, and distinct price IDs for both monthly Plans and any annual Plans.",
    );
  }
}

/** Initial setup only: any existing row, including disabled settings, belongs to Admin. */
export async function initializeBillingSettings(bootstrapJson: string | undefined): Promise<void> {
  if (!bootstrapJson?.trim()) return;
  const repo = AppDataSource.getRepository(AppSetting);
  let exists: boolean;
  try {
    exists = await repo.existsBy({ key: BILLING_SETTING_KEY });
  } catch {
    throw new Error("Billing bootstrap could not read stored settings.");
  }
  if (exists) return;

  const { secretKey, webhookSecret, ...settings } = parseBootstrap(bootstrapJson);
  try {
    const value = JSON.stringify({
      ...settings,
      encryptedSecretKey: encryptSecret(secretKey),
      encryptedWebhookSecret: encryptSecret(webhookSecret),
    });
    // A concurrent bootstrap or Admin save wins on the primary key; never upsert.
    await repo
      .createQueryBuilder()
      .insert()
      .values({ key: BILLING_SETTING_KEY, value })
      .orIgnore()
      .execute();
  } catch {
    throw new Error("Billing bootstrap could not save initial settings.");
  }
  invalidateBillingSettingsCache();
}
