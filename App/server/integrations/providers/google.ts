import crypto from "node:crypto";
import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  OauthTokenSet,
} from "../types.js";
import { config } from "../../../config.js";
import { gmailTools, invokeGmailTool } from "./google/gmail-tools.js";
import { driveTools, invokeDriveTool } from "./google/drive-tools.js";
import { safeJson } from "./google/util.js";

/**
 * Google Workspace — umbrella OAuth + Service Account integration.
 *
 * One `IntegrationConnection` row covers a single Google account (or a
 * single service account) and exposes tools from multiple Google products
 * (Gmail + Drive today; Calendar, Docs, etc. later).
 *
 * Two auth modes are supported, picked at create-time:
 *
 *   • OAuth (`authMode="oauth2"`): each Connection brings its own
 *     `clientId` + `clientSecret` (registered with Google Cloud) and runs
 *     the standard 3-legged consent dance. Tokens refresh via the stored
 *     refresh_token. Works for any Google account, including personal
 *     `@gmail.com`.
 *
 *   • Service account (`authMode="service_account"`): each Connection
 *     uploads a Google Cloud service-account JSON key. Access tokens are
 *     minted on demand via the JWT-bearer grant (RS256). With an optional
 *     `impersonationEmail`, the SA acts on a Workspace user's behalf via
 *     domain-wide delegation. Does not work with personal `@gmail.com`.
 *
 * Scopes requested are the same in both modes:
 *   - `gmail.modify`     — read, draft, send, label.
 *   - `drive.readonly`   — search and read files across Drive.
 *   - `userinfo.email`   — so we know which account just authorised (OAuth).
 *   - `openid`           — required when userinfo.email is requested (OAuth).
 */

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

const GOOGLE_SERVICE_ACCOUNT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.readonly",
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
};

export type GoogleServiceAccountConfig = {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string;
  projectId: string;
  scopes: string[];
  /** When set, the SA impersonates this Workspace user (domain-wide
   * delegation). Required for Gmail since SAs cannot read mail otherwise. */
  impersonationEmail?: string;
  /** Cached short-lived access token; re-minted by `ensureFreshToken`. */
  accessToken?: string;
  expiresAt?: number;
};

export function googleRedirectUri(): string {
  const base = config.publicUrl.replace(/\/+$/, "");
  return `${base}/api/integrations/oauth/callback/google`;
}

const ALL_TOOLS = [...gmailTools, ...driveTools];
const GMAIL_TOOL_NAMES = new Set(gmailTools.map((t) => t.name));
const DRIVE_TOOL_NAMES = new Set(driveTools.map((t) => t.name));

export const googleProvider: IntegrationProvider = {
  catalog: {
    provider: "google",
    name: "Google Workspace",
    tagline: "Connect Gmail + Drive — search, read, send.",
    description:
      "Connect a Google account so AI employees can triage email, search Drive, and send replies. Each Connection brings its own credentials: an OAuth client (recommended for personal Gmail or small teams) or a service account JSON key (Workspace admin / programmatic access).",
    icon: "Mail",
    authMode: "oauth2",
    oauth: {
      app: "google",
      scopes: GOOGLE_OAUTH_SCOPES,
      setupDocs:
        "https://developers.google.com/identity/protocols/oauth2/web-server",
    },
    serviceAccount: {
      scopes: GOOGLE_SERVICE_ACCOUNT_SCOPES,
      // Gmail SAs can't read a mailbox without DWD impersonation, so we
      // surface the field. Drive-only access works without it.
      impersonation: true,
      setupDocs:
        "https://cloud.google.com/iam/docs/service-account-creds#key-types",
    },
    enabled: true,
  },

  tools: ALL_TOOLS,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret }) {
    const email = typeof userInfo.email === "string" ? userInfo.email : "";
    if (!tokens.refreshToken) {
      throw new Error(
        "Google did not return a refresh token. Make sure the consent screen requested offline access and retry.",
      );
    }
    const cfg: GoogleOauthConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      email,
    };
    return { config: cfg as unknown as IntegrationConfig, accountHint: email || "Google account" };
  },

  async buildServiceAccountConfig({ keyJson, impersonationEmail }) {
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
    const trimmedImpersonation = impersonationEmail?.trim() || undefined;
    const cfg: GoogleServiceAccountConfig = {
      clientEmail,
      privateKey,
      privateKeyId,
      projectId,
      scopes: GOOGLE_SERVICE_ACCOUNT_SCOPES,
      impersonationEmail: trimmedImpersonation,
    };
    // Mint once eagerly so the user sees a clear error during connect rather
    // than the first time the AI tries to use it.
    const minted = await mintServiceAccountToken(cfg);
    cfg.accessToken = minted.accessToken;
    cfg.expiresAt = minted.expiresAt;
    const hint = trimmedImpersonation
      ? `${clientEmail} → ${trimmedImpersonation}`
      : clientEmail;
    return { config: cfg as unknown as IntegrationConfig, accountHint: hint };
  },

  async checkStatus(ctx) {
    try {
      await ensureFreshToken(ctx);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    await ensureFreshToken(ctx);
    const accessToken = currentAccessToken(ctx);
    const grantedScope = currentGrantedScope(ctx);
    if (GMAIL_TOOL_NAMES.has(name)) {
      assertScope(grantedScope, "gmail", name);
      return invokeGmailTool(name, args, accessToken);
    }
    if (DRIVE_TOOL_NAMES.has(name)) {
      assertScope(grantedScope, "drive", name);
      return invokeDriveTool(name, args, accessToken);
    }
    throw new Error(`Unknown Google tool: ${name}`);
  },
};

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

// ---------- Service-account token minting (JWT-bearer / RS256) ----------

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

// ---------- Internal helpers: token lifecycle ----------

async function ensureFreshToken(ctx: IntegrationRuntimeContext): Promise<void> {
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

function currentAccessToken(ctx: IntegrationRuntimeContext): string {
  if (ctx.authMode === "oauth2") {
    return (ctx.config as GoogleOauthConfig).accessToken;
  }
  const access = (ctx.config as GoogleServiceAccountConfig).accessToken;
  if (!access) throw new Error("Service-account access token is missing");
  return access;
}

function currentGrantedScope(ctx: IntegrationRuntimeContext): string {
  if (ctx.authMode === "oauth2") {
    return (ctx.config as GoogleOauthConfig).scope;
  }
  // Service accounts always receive exactly the scopes they minted with —
  // no consent screen narrows them down.
  return (ctx.config as GoogleServiceAccountConfig).scopes.join(" ");
}

function assertScope(grantedScope: string, product: "gmail" | "drive", toolName: string): void {
  // `scope` is a space-separated list of full scope URLs. We check the
  // substring "gmail." or "drive." so any granted gmail/drive scope
  // (modify, readonly, …) unlocks the matching tool family.
  const needle = `auth/${product}.`;
  if (!grantedScope.includes(needle)) {
    throw new Error(
      `Tool "${toolName}" requires ${product} access. Reconnect with ${product} scope.`,
    );
  }
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

function googleErrorMessage(parsed: Record<string, unknown> | null, fallback: string): string {
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
