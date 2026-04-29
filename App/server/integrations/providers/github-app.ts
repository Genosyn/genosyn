import crypto from "node:crypto";
import type { IntegrationConfig } from "../types.js";
import type { GithubRepoRef } from "./github-oauth.js";

/**
 * GitHub App auth — installation tokens.
 *
 * Each Connection stores an App's `appId`, encrypted `privateKey` (PEM),
 * and the chosen `installationId`. We mint short-lived installation tokens
 * on demand via the JWT-bearer flow:
 *
 *   1. Sign a JWT with RS256 using the private key, claims:
 *      `{ iss: appId, iat: now-60, exp: now+540 }` (10 minute max ttl).
 *   2. POST to /app/installations/<id>/access_tokens with the JWT as the
 *      Bearer token. Response: `{ token, expires_at }`. Tokens last 1 hour
 *      and have no refresh — we re-mint when within 60s of expiry.
 *
 * The installation token is what the runner and tool dispatcher hand to
 * `git` and the REST client. Permission scope is whatever the App was
 * granted on its install — finer-grained than OAuth tokens, which is
 * exactly why orgs prefer this mode for AI access.
 */

const GITHUB_API = "https://api.github.com";

/** Persisted shape for `authMode="github_app"` connections. */
export type GithubAppConfig = {
  appId: string;
  /** PEM-encoded RSA private key. AES-256-GCM-encrypted at rest via the
   * outer `IntegrationConnection.encryptedConfig` blob. */
  privateKey: string;
  installationId: string;
  /** Optional human label captured from /app at connect time. */
  appName?: string;
  appSlug?: string;
  /** The org/user the installation targets — surfaced in the UI. */
  account?: string;
  /** Cached short-lived installation token; re-minted by refresh helpers. */
  accessToken?: string;
  /** ms epoch. `0` / undefined → no token cached yet. */
  expiresAt?: number;
  repos?: GithubRepoRef[];
};

/**
 * Sign a JWT for GitHub App authentication. Used to bootstrap installation
 * token minting and to call `/app/installations` for discovery.
 */
export function signAppJwt(args: {
  appId: string;
  privateKey: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: args.appId,
    iat: now - 60,
    exp: now + 9 * 60,
  };
  const headerSeg = b64url(JSON.stringify(header));
  const claimsSeg = b64url(JSON.stringify(claims));
  const signingInput = `${headerSeg}.${claimsSeg}`;
  let signature: Buffer;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), args.privateKey);
  } catch (err) {
    throw new Error(
      `Could not sign with the GitHub App private key — paste the .pem file verbatim. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return `${signingInput}.${b64urlBuf(signature)}`;
}

/**
 * Mint a fresh installation token. Called eagerly at connect time (so the
 * user gets an immediate error if the appId/privateKey/installationId
 * triple is wrong) and lazily before each spawn / tool call.
 */
export async function mintInstallationToken(args: {
  appId: string;
  privateKey: string;
  installationId: string;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const jwt = signAppJwt({ appId: args.appId, privateKey: args.privateKey });
  const res = await fetch(
    `${GITHUB_API}/app/installations/${encodeURIComponent(args.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "genosyn",
      },
    },
  );
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(githubAppErrorMessage(parsed, `GitHub App token request failed: ${res.status}`));
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token : "";
  const expiresAtIso = typeof obj.expires_at === "string" ? obj.expires_at : "";
  if (!token) {
    throw new Error(githubAppErrorMessage(obj, "GitHub did not return an installation token"));
  }
  const expiresAt = expiresAtIso ? Date.parse(expiresAtIso) : Date.now() + 60 * 60 * 1000;
  return { accessToken: token, expiresAt };
}

/**
 * Discover the authenticated App's installations + the App's own metadata.
 * Used by the connect form so the user picks a single installation from a
 * list rather than copying the numeric id out of github.com URLs.
 */
export async function discoverAppInstallations(args: {
  appId: string;
  privateKey: string;
}): Promise<{
  app: { id: number; name: string; slug: string; htmlUrl: string };
  installations: Array<{
    id: number;
    account: string;
    accountType: string;
    targetType: string;
    htmlUrl: string;
  }>;
}> {
  const jwt = signAppJwt({ appId: args.appId, privateKey: args.privateKey });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "genosyn",
  };
  const [appRes, instRes] = await Promise.all([
    fetch(`${GITHUB_API}/app`, { headers }),
    fetch(`${GITHUB_API}/app/installations?per_page=100`, { headers }),
  ]);
  if (!appRes.ok) {
    const t = await appRes.text();
    throw new Error(`GitHub /app returned ${appRes.status}: ${t.slice(0, 200)}`);
  }
  if (!instRes.ok) {
    const t = await instRes.text();
    throw new Error(`GitHub /app/installations returned ${instRes.status}: ${t.slice(0, 200)}`);
  }
  const appJson = (await appRes.json()) as {
    id?: number;
    name?: string;
    slug?: string;
    html_url?: string;
  };
  const instJson = (await instRes.json()) as Array<{
    id?: number;
    account?: { login?: string; type?: string };
    target_type?: string;
    html_url?: string;
  }>;
  return {
    app: {
      id: appJson.id ?? 0,
      name: appJson.name ?? "",
      slug: appJson.slug ?? "",
      htmlUrl: appJson.html_url ?? "",
    },
    installations: instJson
      .filter((i) => typeof i.id === "number" && i.account?.login)
      .map((i) => ({
        id: i.id!,
        account: i.account!.login!,
        accountType: i.account?.type ?? "",
        targetType: i.target_type ?? "",
        htmlUrl: i.html_url ?? "",
      })),
  };
}

/**
 * Build a `GithubAppConfig` from raw form input. Validates the PEM,
 * mints a token eagerly so the user sees credential errors at connect
 * time, and captures the App + account names for the UI.
 */
export async function buildGithubAppConfig(args: {
  appId: string;
  privateKey: string;
  installationId: string;
}): Promise<{ config: IntegrationConfig; accountHint: string }> {
  const appId = args.appId.trim();
  const privateKey = args.privateKey.trim();
  const installationId = args.installationId.trim();
  if (!appId) throw new Error("App ID is required");
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new Error(
      "Private key looks malformed. Paste the entire .pem file you downloaded from the App settings page.",
    );
  }
  if (!installationId) throw new Error("Installation ID is required");

  const minted = await mintInstallationToken({ appId, privateKey, installationId });

  // Capture the App's own metadata + the installation's account name so the
  // accountHint string and connection list show useful labels.
  let appName: string | undefined;
  let appSlug: string | undefined;
  let account: string | undefined;
  try {
    const meta = await discoverAppInstallations({ appId, privateKey });
    appName = meta.app.name || undefined;
    appSlug = meta.app.slug || undefined;
    const matched = meta.installations.find((i) => String(i.id) === installationId);
    account = matched?.account;
  } catch {
    // Token already minted successfully — metadata fetch failures shouldn't
    // block connect. Hint will fall back to the App ID.
  }

  const cfg: GithubAppConfig = {
    appId,
    privateKey,
    installationId,
    appName,
    appSlug,
    account,
    accessToken: minted.accessToken,
    expiresAt: minted.expiresAt,
    repos: [],
  };
  const hint = account
    ? `${appName || `App ${appId}`} → ${account}`
    : `App ${appId} (installation ${installationId})`;
  return { config: cfg as unknown as IntegrationConfig, accountHint: hint };
}

/**
 * Return a fresh installation token, re-minting if the cached one is
 * absent or near expiry. The caller should re-encrypt and persist the
 * returned config when `refreshedConfig` is non-null.
 */
export async function ensureInstallationToken(cfg: GithubAppConfig): Promise<{
  accessToken: string;
  refreshedConfig: GithubAppConfig | null;
}> {
  if (cfg.accessToken && cfg.expiresAt && cfg.expiresAt > Date.now() + 60_000) {
    return { accessToken: cfg.accessToken, refreshedConfig: null };
  }
  const minted = await mintInstallationToken({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    installationId: cfg.installationId,
  });
  const next: GithubAppConfig = {
    ...cfg,
    accessToken: minted.accessToken,
    expiresAt: minted.expiresAt,
  };
  return { accessToken: minted.accessToken, refreshedConfig: next };
}

// ---------- low-level helpers ----------

function b64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlBuf(b: Buffer): string {
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function githubAppErrorMessage(parsed: unknown, fallback: string): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const obj = parsed as Record<string, unknown>;
  const msg = obj.message;
  if (typeof msg === "string" && msg) return msg;
  return fallback;
}
