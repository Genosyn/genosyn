import { AppDataSource } from "../../db/datasource.js";
import { AppSetting } from "../../db/entities/AppSetting.js";
import { decryptSecret, encryptSecret } from "../../lib/secret.js";
import type { BillingPriceIds } from "./plans.js";

/**
 * Instance-wide billing configuration (M56) — whether this install charges
 * companies for Plans, and the Stripe credentials it charges with.
 *
 * Persisted as a single JSON `AppSetting` row, the SSO-settings pattern:
 * secrets encrypted at rest, never echoed back (the admin GET returns
 * `hasSecretKey` / `hasWebhookSecret` flags), blank on save keeps the stored
 * value. Disabled by default — self-hosted installs never see billing.
 *
 * Four price ids (M56), one per paid Plan per billing interval. The two
 * monthly ids were stored as `growthPriceId` / `scalePriceId` before annual
 * existed; {@link readStoredBilling} still reads those keys so an install
 * that upgrades keeps billing without the operator touching anything, and the
 * next save rewrites the row under the current names.
 */

export const BILLING_SETTING_KEY = "billing.settings";

/** Shape persisted in the `AppSetting` value column (JSON). */
type StoredBilling = BillingPriceIds & {
  enabled: boolean;
  encryptedSecretKey: string;
  encryptedWebhookSecret: string;
};

/** Non-secret view returned to the admin client. */
export type BillingSettingsDescriptor = BillingPriceIds & {
  enabled: boolean;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
};

export type BillingSettingsPatch = BillingPriceIds & {
  enabled: boolean;
  /** Blank or omitted keeps the stored secret. */
  secretKey?: string;
  webhookSecret?: string;
};

const DEFAULTS: StoredBilling = {
  enabled: false,
  growthMonthlyPriceId: "",
  growthAnnualPriceId: "",
  scaleMonthlyPriceId: "",
  scaleAnnualPriceId: "",
  encryptedSecretKey: "",
  encryptedWebhookSecret: "",
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readStoredBilling(): Promise<StoredBilling> {
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({
    key: BILLING_SETTING_KEY,
  });
  if (!row?.value) return { ...DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // Corrupt row — treat as absent (billing off) rather than breaking boot.
    // eslint-disable-next-line no-console
    console.warn("[billing] stored billing settings are not valid JSON; ignoring them");
    return { ...DEFAULTS };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
  const o = parsed as Record<string, unknown>;
  return {
    enabled: Boolean(o.enabled),
    // `growthPriceId` / `scalePriceId` are the names the monthly ids were
    // stored under before annual billing existed. Read them as a fallback so
    // an upgraded install keeps charging without the operator re-entering
    // anything.
    growthMonthlyPriceId: str(o.growthMonthlyPriceId) || str(o.growthPriceId),
    growthAnnualPriceId: str(o.growthAnnualPriceId),
    scaleMonthlyPriceId: str(o.scaleMonthlyPriceId) || str(o.scalePriceId),
    scaleAnnualPriceId: str(o.scaleAnnualPriceId),
    encryptedSecretKey: str(o.encryptedSecretKey),
    encryptedWebhookSecret: str(o.encryptedWebhookSecret),
  };
}

function describe(stored: StoredBilling): BillingSettingsDescriptor {
  return {
    enabled: stored.enabled,
    growthMonthlyPriceId: stored.growthMonthlyPriceId,
    growthAnnualPriceId: stored.growthAnnualPriceId,
    scaleMonthlyPriceId: stored.scaleMonthlyPriceId,
    scaleAnnualPriceId: stored.scaleAnnualPriceId,
    hasSecretKey: Boolean(stored.encryptedSecretKey),
    hasWebhookSecret: Boolean(stored.encryptedWebhookSecret),
  };
}

export async function getBillingSettings(): Promise<BillingSettingsDescriptor> {
  return describe(await readStoredBilling());
}

function decryptStored(encrypted: string, what: string): string | null {
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[billing] could not decrypt the stored ${what} (was the encryption key rotated?) — re-enter it at Admin → Billing`,
    );
    return null;
  }
}

/** Decrypted Stripe credentials for server-side calls. Never leaves the process. */
export async function getStripeSecrets(): Promise<{
  secretKey: string | null;
  webhookSecret: string | null;
}> {
  const stored = await readStoredBilling();
  return {
    secretKey: decryptStored(stored.encryptedSecretKey, "Stripe secret key"),
    webhookSecret: decryptStored(stored.encryptedWebhookSecret, "Stripe webhook secret"),
  };
}

/**
 * Persist the admin form. Blank secrets keep what is stored; enabling billing
 * requires the secret key and both monthly price ids to be present (counting
 * stored secrets) so a live install can never advertise checkout it cannot
 * complete. The annual ids stay optional — an operator who only sells monthly
 * leaves them blank and the plan cards simply don't offer annual.
 */
export async function updateBillingSettings(
  patch: BillingSettingsPatch,
): Promise<BillingSettingsDescriptor> {
  const current = await readStoredBilling();
  const next: StoredBilling = {
    enabled: patch.enabled,
    growthMonthlyPriceId: patch.growthMonthlyPriceId.trim(),
    growthAnnualPriceId: patch.growthAnnualPriceId.trim(),
    scaleMonthlyPriceId: patch.scaleMonthlyPriceId.trim(),
    scaleAnnualPriceId: patch.scaleAnnualPriceId.trim(),
    encryptedSecretKey: patch.secretKey?.trim()
      ? encryptSecret(patch.secretKey.trim())
      : current.encryptedSecretKey,
    encryptedWebhookSecret: patch.webhookSecret?.trim()
      ? encryptSecret(patch.webhookSecret.trim())
      : current.encryptedWebhookSecret,
  };
  if (
    next.enabled &&
    (!next.encryptedSecretKey || !next.growthMonthlyPriceId || !next.scaleMonthlyPriceId)
  ) {
    throw new Error(
      "Enter the Stripe secret key and both monthly price IDs before enabling billing.",
    );
  }
  const repo = AppDataSource.getRepository(AppSetting);
  const existing = await repo.findOneBy({ key: BILLING_SETTING_KEY });
  const value = JSON.stringify(next);
  if (existing) {
    existing.value = value;
    await repo.save(existing);
  } else {
    await repo.save(repo.create({ key: BILLING_SETTING_KEY, value }));
  }
  invalidateBillingSettingsCache();
  return describe(next);
}

// The per-request question "is billing on?" is asked by every entitlements
// read — memoize it for 30s (the `publicUrl` pattern).
const CACHE_TTL_MS = 30_000;
let cachedEnabled: boolean | null = null;
let cachedAt = 0;

export function invalidateBillingSettingsCache(): void {
  cachedEnabled = null;
  cachedAt = 0;
}

export async function billingEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedEnabled !== null && now - cachedAt < CACHE_TTL_MS) return cachedEnabled;
  const stored = await readStoredBilling();
  cachedEnabled = stored.enabled;
  cachedAt = now;
  return cachedEnabled;
}
