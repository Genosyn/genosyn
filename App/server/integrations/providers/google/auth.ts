import crypto from "node:crypto";
import type {
  IntegrationConfig,
  IntegrationRuntimeContext,
  IntegrationScopeGroup,
  OauthTokenSet,
} from "../../types.js";
import { safeJson } from "./util.js";
import { getPublicUrl } from "../../../services/publicUrl.js";

/**
 * Provider-agnostic Google OAuth + Service-Account machinery.
 *
 * Every Google-backed integration (Workspace, Analytics, Search Console, …)
 * shares the same two credential shapes and the same token lifecycle:
 *
 *   • OAuth (`authMode="oauth2"`): each Connection brings its own
 *     `clientId` + `clientSecret` and runs the 3-legged consent dance.
 *     Access tokens refresh via the stored refresh_token.
 *   • Service account (`authMode="service_account"`): each Connection uploads
 *     a Google Cloud service-account JSON key. Access tokens are minted on
 *     demand via the JWT-bearer grant (RS256), optionally impersonating a
 *     Workspace user via domain-wide delegation.
 *
 * This module lives under `google/` (rather than on `google.ts`) so the
 * standalone providers can reuse it without importing the Workspace provider
 * and creating an import cycle. The Workspace provider (`google.ts`) and the
 * `services/oauth.ts` dispatcher both consume these helpers.
 */

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * OAuth requires `openid` + `userinfo.email` regardless of which products a
 * Connection picked — that's how we identify which Google account just
 * authorised. Service-account tokens skip these (the JWT identifies the SA
 * itself), so they use an empty identity baseline.
 */
export const GOOGLE_OAUTH_IDENTITY_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

// ---------- Config shapes (what's stored encrypted on each Connection) ----------

export type GoogleOauthConfig = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** ms epoch. Renewed on refresh. */
  expiresAt: number;
  /** Space-separated granted scopes. */
  scope: string;
  email: string;
  /** Scope-group keys the user selected at consent time. Stored so
   * reconnect can prefill the checkbox state. Older connections written
   * before this feature shipped have an empty array — the UI treats that
   * as "all groups" for the prefill default. */
  scopeGroups?: string[];
};

export type GoogleServiceAccountConfig = {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string;
  projectId: string;
  /** Resolved scope URLs the SA token is minted with. */
  scopes: string[];
  /** Scope-group keys the user picked. Same prefill semantics as above. */
  scopeGroups?: string[];
  /** When set, the SA impersonates this Workspace user (domain-wide
   * delegation). Only some products need it (e.g. Gmail); Analytics and
   * Search Console work by adding the SA email as a property/site user. */
  impersonationEmail?: string;
  /** Cached short-lived access token; re-minted by `ensureFreshGoogleToken`. */
  accessToken?: string;
  expiresAt?: number;
};

/** Shared OAuth callback URI — keyed on the OAuth *app* ("google"), so every
 * Google-backed integration completes its handshake at the same endpoint. */
export function googleRedirectUri(): string {
  const base = getPublicUrl();
  return `${base}/api/integrations/oauth/callback/google`;
}

/**
 * Resolve a list of scope-group keys → flat scope URL list against a
 * provider-supplied group catalog. Unknown keys are silently dropped, which
 * matters for forward compatibility: a Connection persisted with a key we
 * later remove won't break reconnect — that group is simply no longer
 * requested.
 */
export function resolveScopeGroups(args: {
  keys: string[];
  groups: IntegrationScopeGroup[];
  baseline: string[];
}): string[] {
  const out = new Set(args.baseline);
  const byKey = new Map(args.groups.map((g) => [g.key, g] as const));
  for (const key of args.keys) {
    const group = byKey.get(key);
    if (!group) continue;
    for (const s of group.scopes) out.add(s);
  }
  return Array.from(out);
}

// ---------- OAuth helpers (used by services/oauth.ts) ----------

export function buildGoogleAuthorizeUrl(args: {
  state: string;
  scopes: string[];
  clientId: string;
  redirectUri: string;
}): string {
  if (!args.clientId) throw new Error("clientId is required");
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", args.scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  // `prompt=consent` forces Google to return a refresh_token even if the user
  // has already authorised this client once — otherwise we'd silently get
  // only an access token on subsequent connects and fail buildOauthConfig.
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", args.state);
  return u.toString();
}

export async function exchangeGoogleCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{
  tokens: OauthTokenSet;
  userInfo: Record<string, unknown>;
}> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
  });
  const tokRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokText = await tokRes.text();
  const tok = safeJson(tokText) as Record<string, unknown> | null;
  if (!tokRes.ok || !tok) {
    throw new Error(googleErrorMessage(tok, `Token exchange failed: ${tokRes.status}`));
  }
  const access = typeof tok.access_token === "string" ? tok.access_token : "";
  const refresh =
    typeof tok.refresh_token === "string" ? tok.refresh_token : undefined;
  const expiresIn = typeof tok.expires_in === "number" ? tok.expires_in : 3600;
  const scope = typeof tok.scope === "string" ? tok.scope : "";
  if (!access) throw new Error("Google did not return an access token");

  const userRes = await fetch(GOOGLE_USERINFO, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const userInfo = (safeJson(await userRes.text()) ?? {}) as Record<string, unknown>;

  return {
    tokens: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() + expiresIn * 1000,
      scope,
      tokenType: "Bearer",
    },
    userInfo,
  };
}

// ---------- Service-account key parsing + token minting (JWT-bearer / RS256) ----------

/**
 * Validate a downloaded service-account JSON key and pull out the fields we
 * store. Throws a user-friendly error the connect modal surfaces verbatim
 * when the shape is wrong (e.g. the user pasted an OAuth client, not a SA
 * key).
 */
export function parseServiceAccountKey(keyJson: Record<string, unknown>): {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string;
  projectId: string;
} {
  const clientEmail = strField(keyJson, "client_email");
  const privateKey = strField(keyJson, "private_key");
  const privateKeyId = strField(keyJson, "private_key_id");
  const projectId = strField(keyJson, "project_id");
  const type = typeof keyJson.type === "string" ? keyJson.type : "";
  if (type !== "service_account") {
    throw new Error(
      `Expected a service-account JSON key (type="service_account"), got "${type || "missing"}". This looks like a different credential type — make sure you downloaded the key from IAM & Admin → Service Accounts.`,
    );
  }
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new Error(
      "private_key looks malformed. Paste the JSON file verbatim — newlines must be `\\n` inside the quoted string.",
    );
  }
  return { clientEmail, privateKey, privateKeyId, projectId };
}

export async function mintServiceAccountToken(
  cfg: GoogleServiceAccountConfig,
): Promise<{ accessToken: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60; // Google ignores anything > 1h anyway.
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: cfg.privateKeyId || undefined,
  };
  const claim: Record<string, unknown> = {
    iss: cfg.clientEmail,
    scope: cfg.scopes.join(" "),
    aud: GOOGLE_TOKEN,
    iat: now,
    exp,
  };
  if (cfg.impersonationEmail) claim.sub = cfg.impersonationEmail;

  const headerSeg = b64url(JSON.stringify(header));
  const claimSeg = b64url(JSON.stringify(claim));
  const signingInput = `${headerSeg}.${claimSeg}`;

  let signature: Buffer;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), cfg.privateKey);
  } catch (err) {
    throw new Error(
      `Could not sign with the service-account private key — make sure the key was pasted intact. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const assertion = `${signingInput}.${b64urlBuf(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = safeJson(await res.text()) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new Error(googleErrorMessage(parsed, `Service-account token request failed: ${res.status}`));
  }
  const access = typeof parsed.access_token === "string" ? parsed.access_token : "";
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  if (!access) throw new Error("Google did not return an access token (service account)");
  return { accessToken: access, expiresAt: Date.now() + expiresIn * 1000 };
}

// ---------- Token lifecycle (shared by every Google-backed provider) ----------

/**
 * Ensure `ctx.config` carries a fresh access token before a tool call. For
 * OAuth connections this refreshes via the stored refresh_token when the
 * cached token is within 60s of expiry; for service accounts it re-mints a
 * JWT-bearer token. Either way, a rotated token is handed to `ctx.setConfig`
 * so the caller re-encrypts and persists it.
 */
export async function ensureFreshGoogleToken(
  ctx: IntegrationRuntimeContext,
): Promise<void> {
  if (ctx.authMode === "oauth2") {
    return refreshOauthToken(ctx);
  }
  if (ctx.authMode === "service_account") {
    return refreshServiceAccountToken(ctx);
  }
  throw new Error(`Google connector does not support authMode "${ctx.authMode}"`);
}

async function refreshOauthToken(ctx: IntegrationRuntimeContext): Promise<void> {
  const cfg = ctx.config as GoogleOauthConfig;
  if (cfg.expiresAt > Date.now() + 60_000) return;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Connection is missing OAuth client credentials — disconnect and reconnect.",
    );
  }
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = safeJson(await res.text()) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new Error(googleErrorMessage(parsed, `Google token refresh failed: ${res.status}`));
  }
  const access = typeof parsed.access_token === "string" ? parsed.access_token : "";
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  if (!access) throw new Error("Google refresh did not return an access token");
  const next: GoogleOauthConfig = {
    ...cfg,
    accessToken: access,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  ctx.setConfig?.(next as unknown as IntegrationConfig);
  ctx.config = next as unknown as IntegrationConfig;
}

async function refreshServiceAccountToken(
  ctx: IntegrationRuntimeContext,
): Promise<void> {
  const cfg = ctx.config as GoogleServiceAccountConfig;
  if (cfg.accessToken && cfg.expiresAt && cfg.expiresAt > Date.now() + 60_000) {
    return;
  }
  const minted = await mintServiceAccountToken(cfg);
  const next: GoogleServiceAccountConfig = {
    ...cfg,
    accessToken: minted.accessToken,
    expiresAt: minted.expiresAt,
  };
  ctx.setConfig?.(next as unknown as IntegrationConfig);
  ctx.config = next as unknown as IntegrationConfig;
}

export function currentGoogleAccessToken(ctx: IntegrationRuntimeContext): string {
  if (ctx.authMode === "oauth2") {
    return (ctx.config as GoogleOauthConfig).accessToken;
  }
  const access = (ctx.config as GoogleServiceAccountConfig).accessToken;
  if (!access) throw new Error("Service-account access token is missing");
  return access;
}

export function currentGoogleGrantedScope(ctx: IntegrationRuntimeContext): string {
  if (ctx.authMode === "oauth2") {
    return (ctx.config as GoogleOauthConfig).scope;
  }
  // Service accounts always receive exactly the scopes they minted with —
  // no consent screen narrows them down.
  return (ctx.config as GoogleServiceAccountConfig).scopes.join(" ");
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

function strField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`Service-account JSON is missing "${key}".`);
  }
  return v;
}

export function googleErrorMessage(
  parsed: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const desc = parsed.error_description;
  if (typeof desc === "string" && desc) return desc;
  const err = parsed.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}
