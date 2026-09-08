import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import {
  getPublicUrlSettings,
  normalizePublicUrl,
  PUBLIC_URL_SETTING_KEY,
  type PublicUrlSettings,
} from "./publicUrl.js";

export const PUBLIC_URL_SETUP_MESSAGE =
  "This instance needs its public HTTPS URL configured before registration or verification emails are available. Ask the operator to complete initial setup.";

/** Read the shared row, not a replica's potentially stale bootstrap cache. */
export async function publicUrlSetupRequired(): Promise<boolean> {
  if (!config.security.multiTenant) return false;
  const settings = await getPublicUrlSettings();
  return !settings.configured || !settings.publicUrl.startsWith("https://");
}

export function initialPublicUrl(value: string): string {
  const origin = normalizePublicUrl(value);
  if (config.security.multiTenant && !origin.startsWith("https://")) {
    throw new Error("Shared SaaS requires an HTTPS public URL.");
  }
  return origin;
}

/**
 * Host-only setup: the operator supplies the canonical origin explicitly.
 * There is deliberately no unauthenticated HTTP route to this function.
 * The unique AppSetting key makes simultaneous setup commands first-write-only.
 */
export async function initializePublicUrl(value: string): Promise<PublicUrlSettings> {
  const publicUrl = initialPublicUrl(value);
  await AppDataSource.getRepository(AppSetting)
    .createQueryBuilder()
    .insert()
    .values({ key: PUBLIC_URL_SETTING_KEY, value: publicUrl })
    .orIgnore()
    .execute();
  const settings = await getPublicUrlSettings();
  if (!settings.configured || settings.publicUrl !== publicUrl) {
    throw new Error("A different public URL is already stored. Change it at Admin → General.");
  }
  return settings;
}
