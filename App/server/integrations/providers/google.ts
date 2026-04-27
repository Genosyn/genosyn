import type {
  IntegrationProvider,
  IntegrationRuntimeContext,
  OauthTokenSet,
} from "../types.js";
import { config } from "../../../config.js";
import { gmailTools, invokeGmailTool } from "./google/gmail-tools.js";
import { driveTools, invokeDriveTool } from "./google/drive-tools.js";
import { safeJson } from "./google/util.js";

/**
 * Google Workspace — umbrella OAuth integration.
 *
 * One `IntegrationConnection` row covers a single Google account and exposes
 * tools from multiple Google products (Gmail + Drive today; Calendar, Docs,
 * etc. later). The user grants all scopes in a single consent dance, and the
 * AI sees a unified tool list scoped to whichever products we currently
 * support.
 *
 * Flow:
 *  1. User clicks "Connect Google Workspace" in the UI.
 *  2. Frontend hits `POST /api/companies/:cid/integrations/oauth/start` with
 *     `provider: "google"` and gets back Google's consent URL to redirect to.
 *  3. Google calls back to
 *     `${publicUrl}/api/integrations/oauth/callback/google` — a public route
 *     (auth via the `state` token it carries). We exchange the auth code for
 *     {access, refresh} tokens and create the Connection row.
 *
 * Scopes requested:
 *   - `gmail.modify`     — read, draft, send, label.
 *   - `drive.readonly`   — search and read files across the user's Drive.
 *   - `userinfo.email`   — so we know which account just authorised.
 *   - `openid`           — required when userinfo.email is requested.
 *
 * Access tokens are short-lived; `ensureFreshToken` refreshes on demand via
 * the refresh token. If the refresh itself fails (user revoked access), the
 * connection flips to `status=expired` and the UI prompts a reconnect.
 */

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleConfig = {
  accessToken: string;
  refreshToken: string;
  /** ms epoch. Renewed on refresh. */
  expiresAt: number;
  /** Space-separated granted scopes — used to gate per-product tools. */
  scope: string;
  email: string;
};

export function googleOauthConfigured(): boolean {
  return !!(
    config.integrations.google.clientId && config.integrations.google.clientSecret
  );
}

function redirectUri(): string {
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
    tagline: "Connect Gmail + Drive in one click — search, read, send.",
    description:
      "Connect a Google account so AI employees can triage email, search Drive, and send replies on the team's behalf. Requires a Google Cloud OAuth client configured in `App/config.ts` under `integrations.google`.",
    icon: "Mail",
    authMode: "oauth2",
    oauth: {
      app: "google",
      scopes: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
        "openid",
      ],
      setupDocs:
        "https://developers.google.com/identity/protocols/oauth2/web-server",
    },
    // `enabled` / `disabledReason` are injected by the catalog service at
    // list-time based on `config.integrations.google.clientId`.
    enabled: true,
  },

  tools: ALL_TOOLS,

  buildOauthConfig({ tokens, userInfo }) {
    const email = typeof userInfo.email === "string" ? userInfo.email : "";
    if (!tokens.refreshToken) {
      // Google only returns a refresh token on the FIRST consent unless we
      // pass `prompt=consent`. See buildGoogleAuthorizeUrl below.
      throw new Error(
        "Google did not return a refresh token. Make sure the consent screen requested offline access and retry.",
      );
    }
    const cfg: GoogleConfig = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      email,
    };
    return { config: cfg, accountHint: email || "Google account" };
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
    const cfg = ctx.config as GoogleConfig;
    if (GMAIL_TOOL_NAMES.has(name)) {
      assertScope(cfg.scope, "gmail", name);
      return invokeGmailTool(name, args, cfg.accessToken);
    }
    if (DRIVE_TOOL_NAMES.has(name)) {
      assertScope(cfg.scope, "drive", name);
      return invokeDriveTool(name, args, cfg.accessToken);
    }
    throw new Error(`Unknown Google tool: ${name}`);
  },
};

// ---------- OAuth helpers (used by services/oauth.ts) ----------

export function buildGoogleAuthorizeUrl(state: string, scopes: string[]): string {
  if (!googleOauthConfigured()) {
    throw new Error(
      "Google OAuth is not configured. Set config.integrations.google.clientId and clientSecret first.",
    );
  }
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", config.integrations.google.clientId);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  // `prompt=consent` forces Google to return a refresh_token even if the user
  // has already authorised our app once — otherwise we'd silently get only
  // an access token on subsequent connects and fail buildOauthConfig.
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeGoogleCode(code: string): Promise<{
  tokens: OauthTokenSet;
  userInfo: Record<string, unknown>;
}> {
  if (!googleOauthConfigured()) {
    throw new Error("Google OAuth is not configured.");
  }
  const body = new URLSearchParams({
    code,
    client_id: config.integrations.google.clientId,
    client_secret: config.integrations.google.clientSecret,
    redirect_uri: redirectUri(),
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
    const msg =
      (tok && typeof tok === "object" && "error_description" in tok
        ? String((tok as { error_description?: unknown }).error_description)
        : null) ??
      (tok && typeof tok === "object" && "error" in tok
        ? String((tok as { error?: unknown }).error)
        : null) ??
      `Token exchange failed: ${tokRes.status}`;
    throw new Error(msg);
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

// ---------- internal helpers ----------

async function ensureFreshToken(ctx: IntegrationRuntimeContext): Promise<void> {
  const cfg = ctx.config as GoogleConfig;
  // 60s safety margin so a token doesn't expire mid-request.
  if (cfg.expiresAt > Date.now() + 60_000) return;

  if (!googleOauthConfigured()) {
    throw new Error("Google OAuth is not configured.");
  }
  const body = new URLSearchParams({
    client_id: config.integrations.google.clientId,
    client_secret: config.integrations.google.clientSecret,
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
    const msg =
      (parsed && typeof parsed === "object" && "error_description" in parsed
        ? String((parsed as { error_description?: unknown }).error_description)
        : null) ?? `Google token refresh failed: ${res.status}`;
    throw new Error(msg);
  }
  const access = typeof parsed.access_token === "string" ? parsed.access_token : "";
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  if (!access) throw new Error("Google refresh did not return an access token");
  const next: GoogleConfig = {
    ...cfg,
    accessToken: access,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  ctx.setConfig?.(next as unknown as Record<string, unknown>);
  // Mutate locally too so the current request sees the new token.
  ctx.config = next as unknown as Record<string, unknown>;
}

function assertScope(grantedScope: string, product: "gmail" | "drive", toolName: string): void {
  // `scope` from Google is a space-separated list of full scope URLs. We
  // check the substring "gmail." or "drive." so any granted gmail/drive
  // scope (modify, readonly, …) unlocks the matching tool family.
  const needle = `auth/${product}.`;
  if (!grantedScope.includes(needle)) {
    throw new Error(
      `Tool "${toolName}" requires ${product} access. Reconnect Google with ${product} scope.`,
    );
  }
}
