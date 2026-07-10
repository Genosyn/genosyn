import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";

/**
 * Instance-level toggle for self-service sign-ups.
 *
 * When an operator disables sign-ups from Admin → Sign-ups, the public
 * `POST /api/auth/signup` endpoint is refused for everyone — except the very
 * first account on a fresh install (the master-admin bootstrap), which is
 * always allowed through so an operator can never lock themselves out of a box
 * that has no users yet.
 *
 * Persisted as a single boolean `AppSetting` row — the same key/value mechanism
 * the Web Push VAPID keypair and the global SMTP override use — so there is no
 * new entity and no migration. Absent row means the default: sign-ups enabled.
 */

export const SIGNUP_DISABLED_KEY = "signup.disabled";

export type SignupSettings = { signupsDisabled: boolean };

/** Raw setting read: has an operator turned sign-ups off? */
export async function areSignupsDisabled(): Promise<boolean> {
  const repo = AppDataSource.getRepository(AppSetting);
  const row = await repo.findOneBy({ key: SIGNUP_DISABLED_KEY });
  return row?.value === "true";
}

export async function getSignupSettings(): Promise<SignupSettings> {
  return { signupsDisabled: await areSignupsDisabled() };
}

/** Persist the toggle (upserting the single row) and echo the new state. */
export async function setSignupsDisabled(
  disabled: boolean,
): Promise<SignupSettings> {
  const repo = AppDataSource.getRepository(AppSetting);
  const existing = await repo.findOneBy({ key: SIGNUP_DISABLED_KEY });
  const value = disabled ? "true" : "false";
  if (existing) {
    existing.value = value;
    await repo.save(existing);
  } else {
    await repo.save(repo.create({ key: SIGNUP_DISABLED_KEY, value }));
  }
  return { signupsDisabled: disabled };
}
