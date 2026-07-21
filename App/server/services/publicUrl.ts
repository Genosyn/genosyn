import type { Request } from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";

/** Database key for the installation-wide browser-facing origin. */
export const PUBLIC_URL_SETTING_KEY = "instance.publicUrl";

const REFRESH_INTERVAL_MS = 30_000;

let cachedPublicUrl = defaultPublicUrl();
let cachedConfigured = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export type PublicUrlSettings = {
  publicUrl: string;
  configured: boolean;
};

/** Local development remains zero-config until an operator saves a real URL. */
export function defaultPublicUrl(): string {
  return `http://localhost:${config.port}`;
}

/**
 * Public URLs are origins, not arbitrary base paths. Keeping the stored value
 * to an origin makes OAuth callbacks, WebAuthn RP ids, and absolute email links
 * agree everywhere that consumes it.
 */
export function normalizePublicUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Public URL must be an absolute http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Public URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Public URL cannot contain credentials");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Public URL must be an origin without a path, query, or fragment");
  }
  return parsed.origin;
}

/** Synchronous read for request middleware and callback builders. */
export function getPublicUrl(): string {
  return cachedPublicUrl;
}

export function isPublicUrlConfigured(): boolean {
  return cachedConfigured;
}

async function refreshPublicUrl(): Promise<PublicUrlSettings> {
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({
    key: PUBLIC_URL_SETTING_KEY,
  });
  if (!row?.value) {
    cachedPublicUrl = defaultPublicUrl();
    cachedConfigured = false;
    return { publicUrl: cachedPublicUrl, configured: false };
  }
  try {
    cachedPublicUrl = normalizePublicUrl(row.value);
    cachedConfigured = true;
  } catch (err) {
    cachedPublicUrl = defaultPublicUrl();
    cachedConfigured = false;
    // A hand-edited/corrupt row must not prevent the server from booting. The
    // Admin form can replace it with a validated value.
    // eslint-disable-next-line no-console
    console.warn(
      `[publicUrl] ignoring invalid database value: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { publicUrl: cachedPublicUrl, configured: cachedConfigured };
}

/** Load before Express is constructed, then keep horizontally-scaled pods fresh. */
export async function bootPublicUrl(): Promise<void> {
  await refreshPublicUrl();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshPublicUrl().catch((err: unknown) => {
      // Keep the last known-good value through a transient database failure.
      // eslint-disable-next-line no-console
      console.warn(
        `[publicUrl] refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

export async function getPublicUrlSettings(): Promise<PublicUrlSettings> {
  return refreshPublicUrl();
}

export async function setPublicUrl(value: string): Promise<PublicUrlSettings> {
  const publicUrl = normalizePublicUrl(value);
  await AppDataSource.getRepository(AppSetting).upsert(
    { key: PUBLIC_URL_SETTING_KEY, value: publicUrl },
    ["key"],
  );
  cachedPublicUrl = publicUrl;
  cachedConfigured = true;
  return { publicUrl, configured: true };
}

/**
 * Resolve the browser-facing origin only from a request that names the same
 * host it reached. The Origin header is preferred because it preserves HTTPS
 * even when a reverse proxy terminates TLS without trusted-proxy configuration.
 */
export function publicOriginFromRequest(req: Request): string | null {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin === "string" && host) {
    try {
      const parsed = new URL(origin);
      if (parsed.host.toLowerCase() === host.toLowerCase()) {
        return normalizePublicUrl(parsed.origin);
      }
    } catch {
      return null;
    }
  }

  if (!host) return null;
  const protocol = req.secure ? "https" : "http";
  try {
    return normalizePublicUrl(`${protocol}://${host}`);
  } catch {
    return null;
  }
}

/** Seed a fresh installation from its first authenticated operator request. */
export async function capturePublicUrlFromMasterAdminRequest(
  req: Request,
): Promise<void> {
  if (cachedConfigured) return;
  // Browser credential submissions carry Origin. Do not guess from a
  // TLS-terminating proxy on callback requests where that header is absent.
  if (typeof req.headers.origin !== "string") return;
  const publicUrl = publicOriginFromRequest(req);
  if (!publicUrl) return;
  await setPublicUrl(publicUrl);
}
