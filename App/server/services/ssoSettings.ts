import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { config } from "../../config.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";

/**
 * Instance-wide single sign-on (SSO) settings.
 *
 * Operators configure SSO from Admin → SSO: pick Google or any OpenID
 * Connect provider, paste an OAuth client id + secret, and flip the toggle.
 * **Disabled by default** — a fresh install only offers email + password
 * until a master admin turns this on.
 *
 * Persisted as a single JSON `AppSetting` row (the same mechanism the global
 * SMTP override and the sign-ups toggle use), so there is no new entity. The
 * client secret is encrypted at rest with the same key that protects every
 * other stored secret (see `lib/secret.ts`) and is never returned to the
 * client — the admin form's blank secret field means "keep the stored one".
 *
 * The login handshake itself lives in `ssoLogin.ts`; this module only owns
 * persistence and the shapes the admin + login surfaces read.
 */

export const SSO_SETTING_KEY = "sso.settings";

/** Google's fixed OIDC issuer — filled in automatically when the provider is
 *  "google" so operators don't need to know the discovery URL. */
export const GOOGLE_ISSUER = "https://accounts.google.com";

export type SsoProvider = "google" | "oidc";

/** Shape persisted in the `AppSetting` value column (JSON). */
type StoredSso = {
  enabled: boolean;
  provider: SsoProvider;
  /** Login-button label override; blank means the provider default. */
  displayName: string;
  /** OIDC issuer URL. Ignored (fixed) when provider is "google". */
  issuer: string;
  clientId: string;
  /** Encrypted; empty string when no secret has been saved yet. */
  encryptedClientSecret: string;
  /** Create a Genosyn account on first SSO sign-in when no user matches. */
  autoProvision: boolean;
};

/** Fully-resolved runtime settings for the handshake. The client secret is in
 *  the clear and must never leave the server process. */
export type ResolvedSso = {
  enabled: boolean;
  provider: SsoProvider;
  issuer: string;
  clientId: string;
  clientSecret: string;
  autoProvision: boolean;
  buttonLabel: string;
};

/** Non-secret view returned to the admin client. */
export type SsoDescriptor = {
  enabled: boolean;
  provider: SsoProvider;
  displayName: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  autoProvision: boolean;
  /** True when issuer + client id + client secret are all present. */
  configured: boolean;
  /** The redirect URI operators must register with their identity provider. */
  callbackUrl: string;
};

/** Payload the admin form submits. */
export type SsoInput = {
  enabled: boolean;
  provider: SsoProvider;
  displayName: string;
  issuer: string;
  clientId: string;
  /** Blank means "keep the client secret currently stored". */
  clientSecret: string;
  autoProvision: boolean;
};

const DEFAULTS: StoredSso = {
  enabled: false,
  provider: "google",
  displayName: "",
  issuer: "",
  clientId: "",
  encryptedClientSecret: "",
  autoProvision: true,
};

/** The redirect URI the identity provider bounces the browser back to. */
export function ssoCallbackUrl(): string {
  const base = config.publicUrl.replace(/\/+$/, "");
  return `${base}/api/auth/sso/callback`;
}

function effectiveIssuer(stored: StoredSso): string {
  return stored.provider === "google" ? GOOGLE_ISSUER : stored.issuer;
}

function defaultButtonLabel(provider: SsoProvider): string {
  return provider === "google" ? "Continue with Google" : "Continue with SSO";
}

async function readStoredSso(): Promise<StoredSso> {
  const repo = AppDataSource.getRepository(AppSetting);
  const row = await repo.findOneBy({ key: SSO_SETTING_KEY });
  if (!row?.value) return { ...DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // Corrupt row — treat as absent (SSO off) rather than breaking login.
    // eslint-disable-next-line no-console
    console.warn("[sso] stored SSO settings are not valid JSON; ignoring them");
    return { ...DEFAULTS };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
  const o = parsed as Record<string, unknown>;
  return {
    enabled: Boolean(o.enabled),
    provider: o.provider === "oidc" ? "oidc" : "google",
    displayName: typeof o.displayName === "string" ? o.displayName : "",
    issuer: typeof o.issuer === "string" ? o.issuer : "",
    clientId: typeof o.clientId === "string" ? o.clientId : "",
    encryptedClientSecret:
      typeof o.encryptedClientSecret === "string" ? o.encryptedClientSecret : "",
    autoProvision: o.autoProvision === undefined ? true : Boolean(o.autoProvision),
  };
}

function decryptStoredSecret(encrypted: string): string {
  if (!encrypted) return "";
  try {
    return decryptSecret(encrypted);
  } catch {
    // A missing encryption-key rotation entry makes old secrets unreadable. Treat as missing so
    // the admin page reports "not configured" instead of the handshake 500ing.
    // eslint-disable-next-line no-console
    console.warn(
      "[sso] could not decrypt the stored SSO client secret (was sessionSecret rotated?) — SSO is unavailable until it is re-entered",
    );
    return "";
  }
}

function isConfigured(stored: StoredSso): boolean {
  return Boolean(effectiveIssuer(stored) && stored.clientId && stored.encryptedClientSecret);
}

/**
 * Resolve settings for the login handshake. Returns null unless SSO is both
 * enabled and fully configured — callers treat null as "SSO is off".
 */
export async function resolveSsoRuntime(): Promise<ResolvedSso | null> {
  const stored = await readStoredSso();
  if (!stored.enabled || !isConfigured(stored)) return null;
  const clientSecret = decryptStoredSecret(stored.encryptedClientSecret);
  if (!clientSecret) return null;
  return {
    enabled: true,
    provider: stored.provider,
    issuer: effectiveIssuer(stored),
    clientId: stored.clientId,
    clientSecret,
    autoProvision: stored.autoProvision,
    buttonLabel: stored.displayName.trim() || defaultButtonLabel(stored.provider),
  };
}

/** Public probe for the login page. Deliberately leaks no more than whether
 *  SSO is on and what the button should say. */
export async function getPublicSsoStatus(): Promise<{
  enabled: boolean;
  buttonLabel: string | null;
}> {
  const runtime = await resolveSsoRuntime();
  if (!runtime) return { enabled: false, buttonLabel: null };
  return { enabled: true, buttonLabel: runtime.buttonLabel };
}

/** Non-secret summary for the admin GET endpoint. */
export async function describeSso(): Promise<SsoDescriptor> {
  const stored = await readStoredSso();
  return {
    enabled: stored.enabled,
    provider: stored.provider,
    displayName: stored.displayName,
    issuer: effectiveIssuer(stored),
    clientId: stored.clientId,
    hasClientSecret: Boolean(stored.encryptedClientSecret),
    autoProvision: stored.autoProvision,
    configured: isConfigured(stored),
    callbackUrl: ssoCallbackUrl(),
  };
}

/**
 * Persist the admin form. A blank client secret keeps the stored one, so
 * operators can edit the client id or flip the toggle without re-pasting the
 * secret. Refuses to enable SSO while the configuration is incomplete —
 * a half-configured provider must never leave password login as the only
 * working path while the login page advertises an SSO button that 500s.
 */
export async function updateSsoSettings(input: SsoInput): Promise<SsoDescriptor> {
  const current = await readStoredSso();
  const next: StoredSso = {
    enabled: input.enabled,
    provider: input.provider,
    displayName: input.displayName.trim(),
    issuer: input.provider === "google" ? "" : input.issuer.trim().replace(/\/+$/, ""),
    clientId: input.clientId.trim(),
    encryptedClientSecret: input.clientSecret
      ? encryptSecret(input.clientSecret)
      : current.encryptedClientSecret,
    autoProvision: input.autoProvision,
  };
  if (next.provider === "oidc" && next.issuer && !/^https:\/\//.test(next.issuer)) {
    throw new Error("Issuer URL must start with https://");
  }
  if (next.enabled && !isConfigured(next)) {
    throw new Error(
      next.provider === "oidc" && !next.issuer
        ? "Enter the issuer URL, client ID, and client secret before enabling SSO."
        : "Enter the client ID and client secret before enabling SSO.",
    );
  }
  const repo = AppDataSource.getRepository(AppSetting);
  const existing = await repo.findOneBy({ key: SSO_SETTING_KEY });
  const value = JSON.stringify(next);
  if (existing) {
    existing.value = value;
    await repo.save(existing);
  } else {
    await repo.save(repo.create({ key: SSO_SETTING_KEY, value }));
  }
  return describeSso();
}

/** Remove the stored settings entirely — back to the disabled default. */
export async function clearSsoSettings(): Promise<SsoDescriptor> {
  const repo = AppDataSource.getRepository(AppSetting);
  await repo.delete({ key: SSO_SETTING_KEY });
  return describeSso();
}
