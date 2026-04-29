import crypto from "node:crypto";
import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  IntegrationScopeGroup,
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
 * single service account) and exposes tools from multiple Google
 * products. The scope set is **user-pickable** at connect/reconnect
 * time: the catalog lists scope groups (`GOOGLE_SCOPE_GROUPS`) like
 * "Mail" or "Calendar", the UI renders them as checkboxes, and the
 * server resolves the chosen keys to the underlying URL scopes. Tools
 * currently ship for Gmail and Drive; the rest are pre-wired so users
 * can grant them now and use them once tool families land.
 *
 * Two auth modes are supported, picked at create-time:
 *
 *   • OAuth (`authMode="oauth2"`): each Connection brings its own
 *     `clientId` + `clientSecret` (registered with Google Cloud) and runs
 *     the standard 3-legged consent dance. Tokens refresh via the stored
 *     refresh_token. Works for any Google account, including personal
 *     `@gmail.com` — though Workspace-only scope groups (Chat, Meet,
 *     Directory) simply won't be granted for personal accounts; we read
 *     the actual granted scope off the token response.
 *
 *   • Service account (`authMode="service_account"`): each Connection
 *     uploads a Google Cloud service-account JSON key. Access tokens are
 *     minted on demand via the JWT-bearer grant (RS256). With an optional
 *     `impersonationEmail`, the SA acts on a Workspace user's behalf via
 *     domain-wide delegation. Does not work with personal `@gmail.com`.
 *
 * OAuth additionally requests `userinfo.email` + `openid` so we know
 * which account just authorised — those are the OAuth baseline and can't
 * be unchecked.
 */

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * User-pickable scope bundles. The connect/reconnect UI renders these as
 * checkboxes; the OAuth start endpoint resolves the keys back to the URL
 * scope list. Adding a new product (say, YouTube) is a single entry here.
 */
export const GOOGLE_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "mail",
    label: "Gmail",
    description: "Read, draft, send, label email; manage filters/forwarding.",
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic",
    ],
  },
  {
    key: "drive",
    label: "Drive",
    description: "Search, read, create, and edit files in Drive.",
    scopes: ["https://www.googleapis.com/auth/drive"],
  },
  {
    key: "calendar",
    label: "Calendar",
    description: "Read and manage events on the user's calendars.",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  },
  {
    key: "docs",
    label: "Docs / Sheets / Slides",
    description: "Read and edit Google Docs, Sheets, and Slides.",
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
    ],
  },
  {
    key: "tasks",
    label: "Tasks",
    description: "Read and manage Google Tasks.",
    scopes: ["https://www.googleapis.com/auth/tasks"],
  },
  {
    key: "contacts",
    label: "Contacts",
    description: "Read and edit personal contacts (People API).",
    scopes: ["https://www.googleapis.com/auth/contacts"],
  },
  {
    key: "directory",
    label: "Directory",
    description: "Read your Workspace org's user directory.",
    scopes: ["https://www.googleapis.com/auth/directory.readonly"],
    workspaceOnly: true,
  },
  {
    key: "chat",
    label: "Chat",
    description: "Read and send messages in Google Chat.",
    scopes: ["https://www.googleapis.com/auth/chat.messages"],
    workspaceOnly: true,
  },
  {
    key: "meet",
    label: "Meet",
    description: "Create Meet spaces.",
    scopes: ["https://www.googleapis.com/auth/meetings.space.created"],
    workspaceOnly: true,
  },
];

/** OAuth requires `openid` + `userinfo.email` regardless of which products
 * the user picked — that's how we identify which Google account just
 * authorised. SA tokens skip these (the JWT identifies the SA itself). */
const GOOGLE_OAUTH_BASELINE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

const GOOGLE_SERVICE_ACCOUNT_BASELINE_SCOPES: string[] = [];

/**
 * Resolve a list of scope-group keys → flat scope URL list. Unknown keys
 * are silently dropped; this matters for forward compatibility (a
 * connection persisted with key "foo" that we later remove won't break
 * reconnect — it just means that group is no longer requested).
 */
export function resolveGoogleScopes(args: {
  scopeGroups: string[];
  baseline: string[];
}): string[] {
  const out = new Set(args.baseline);
  const byKey = new Map(GOOGLE_SCOPE_GROUPS.map((g) => [g.key, g] as const));
  for (const key of args.scopeGroups) {
    const group = byKey.get(key);
    if (!group) continue;
    for (const s of group.scopes) out.add(s);
  }
  return Array.from(out);
}

/** All known group keys — the default selection for fresh connections. */
export const ALL_GOOGLE_SCOPE_GROUP_KEYS = GOOGLE_SCOPE_GROUPS.map((g) => g.key);

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
    category: "Productivity",
    tagline: "Connect Gmail, Drive, Calendar, Docs, and more.",
    description:
      "Connect a Google account so AI employees can triage email, search and edit Drive, manage calendars, draft Docs/Sheets/Slides, work with Tasks and Contacts, and post to Chat/Meet. Each Connection brings its own credentials: an OAuth client (recommended for personal Gmail or small teams) or a service account JSON key (Workspace admin / programmatic access).",
    icon: "Mail",
    authMode: "oauth2",
    oauth: {
      app: "google",
      scopes: GOOGLE_OAUTH_BASELINE_SCOPES,
      scopeGroups: GOOGLE_SCOPE_GROUPS,
      setupDocs:
        "https://developers.google.com/identity/protocols/oauth2/web-server",
    },
    serviceAccount: {
      scopes: GOOGLE_SERVICE_ACCOUNT_BASELINE_SCOPES,
      scopeGroups: GOOGLE_SCOPE_GROUPS,
      // Gmail SAs can't read a mailbox without DWD impersonation, so we
      // surface the field. Drive-only access works without it.
      impersonation: true,
      setupDocs:
        "https://cloud.google.com/iam/docs/service-account-creds#key-types",
    },
    enabled: true,
  },

  tools: ALL_TOOLS,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups }) {
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
      scopeGroups,
    };
    return { config: cfg as unknown as IntegrationConfig, accountHint: email || "Google account" };
  },

  async buildServiceAccountConfig({ keyJson, impersonationEmail, scopeGroups }) {
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
    const resolvedScopes = resolveGoogleScopes({
      scopeGroups,
      baseline: GOOGLE_SERVICE_ACCOUNT_BASELINE_SCOPES,
    });
    if (resolvedScopes.length === 0) {
      throw new Error(
        "Pick at least one Google service (Mail, Drive, Calendar, …) — service-account tokens need a scope to be useful.",
      );
    }
    const trimmedImpersonation = impersonationEmail?.trim() || undefined;
    const cfg: GoogleServiceAccountConfig = {
      clientEmail,
      privateKey,
      privateKeyId,
      projectId,
      scopes: resolvedScopes,
      scopeGroups,
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
