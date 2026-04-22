import type { IntegrationProvider, OauthTokenSet } from "../types.js";
import { config } from "../../../config.js";

/**
 * Gmail — OAuth 2.0 integration.
 *
 * Flow:
 *  1. User clicks "Connect Gmail" in the UI.
 *  2. Frontend hits `GET /api/companies/:cid/integrations/oauth/start/gmail`
 *     which returns Google's consent URL (with state) to redirect to.
 *  3. Google calls back to
 *     `${publicUrl}/api/integrations/oauth/callback/google` — a public route
 *     (auth via the `state` token it carries). We exchange the auth code for
 *     {access, refresh} tokens and create the Connection row.
 *
 * Scopes requested:
 *   - `gmail.modify` — read, draft, send, label. (Broad enough for triage.)
 *   - `userinfo.email` — so we know which account just authorised.
 *
 * Access tokens are short-lived; we refresh on-demand via the refresh token.
 * If the refresh itself fails (user revoked access), the connection flips
 * to `status=expired` and the UI prompts a reconnect.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

type GmailConfig = {
  accessToken: string;
  refreshToken: string;
  /** ms epoch. Renewed on refresh. */
  expiresAt: number;
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

export const gmailProvider: IntegrationProvider = {
  catalog: {
    provider: "gmail",
    name: "Gmail",
    tagline: "Search, read, and send email on behalf of the team.",
    description:
      "Connect a Google account so AI employees can triage, search, and send email. Requires a Google Cloud OAuth client configured in `App/config.ts` under `integrations.google`.",
    icon: "Mail",
    authMode: "oauth2",
    oauth: {
      app: "google",
      scopes: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/userinfo.email",
        "openid",
      ],
      setupDocs:
        "https://developers.google.com/identity/protocols/oauth2/web-server",
    },
    // `enabled` / `disabledReason` are injected by the catalog service at
    // list-time based on `config.integrations.google.clientId`. We default
    // to enabled here so static analysis treats the catalog as a plain
    // literal — no runtime getters.
    enabled: true,
  },

  tools: [
    {
      name: "search_messages",
      description:
        "Search the connected inbox with a Gmail search query (same syntax as the Gmail search bar). Returns message metadata; call `get_message` for full bodies.",
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description:
              'Gmail search expression, e.g. "from:acme.com newer_than:7d".',
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max messages to return (default 20).",
          },
          labelIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional label ids to restrict to (e.g. ['INBOX']).",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_message",
      description:
        "Fetch one message by id, including headers and body text. Use the `format` argument to control verbosity (default 'full').",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string" },
          format: { type: "string", enum: ["minimal", "metadata", "full"] },
        },
        required: ["messageId"],
        additionalProperties: false,
      },
    },
    {
      name: "send_message",
      description:
        "Send an email from the connected account. Body is plain text; provide `html` for richer formatting. Always requires `to` and `subject`.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          cc: { type: "string" },
          bcc: { type: "string" },
          subject: { type: "string" },
          body: { type: "string", description: "Plain-text body." },
          html: {
            type: "string",
            description: "Optional HTML body — sent as multipart/alternative.",
          },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "list_labels",
      description:
        "List the labels configured on the inbox — useful before filtering or labelling.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],

  buildOauthConfig({ tokens, userInfo }) {
    const email = typeof userInfo.email === "string" ? userInfo.email : "";
    if (!tokens.refreshToken) {
      // Google only returns a refresh token on the FIRST consent unless we
      // pass `prompt=consent`. See buildAuthorizeUrl below.
      throw new Error(
        "Google did not return a refresh token. Make sure the consent screen requested offline access and retry.",
      );
    }
    const cfg: GmailConfig = {
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
    const token = (ctx.config as GmailConfig).accessToken;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "search_messages": {
        const qs = new URLSearchParams();
        if (typeof a.q === "string" && a.q.trim()) qs.set("q", a.q);
        qs.set("maxResults", String(clampInt(a.maxResults, 1, 100, 20)));
        if (Array.isArray(a.labelIds)) {
          for (const id of a.labelIds) {
            if (typeof id === "string") qs.append("labelIds", id);
          }
        }
        return gmailFetch(token, `/users/me/messages?${qs.toString()}`);
      }
      case "get_message": {
        if (typeof a.messageId !== "string" || !a.messageId)
          throw new Error("messageId is required");
        const fmt = typeof a.format === "string" ? a.format : "full";
        return gmailFetch(
          token,
          `/users/me/messages/${encodeURIComponent(a.messageId)}?format=${encodeURIComponent(fmt)}`,
        );
      }
      case "send_message": {
        const raw = encodeRfc822({
          to: str(a.to),
          cc: maybeStr(a.cc),
          bcc: maybeStr(a.bcc),
          subject: str(a.subject),
          body: str(a.body),
          html: maybeStr(a.html),
        });
        return gmailFetch(token, "/users/me/messages/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw }),
        });
      }
      case "list_labels":
        return gmailFetch(token, "/users/me/labels");
      default:
        throw new Error(`Unknown Gmail tool: ${name}`);
    }
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

async function ensureFreshToken(
  ctx: Parameters<Required<IntegrationProvider>["checkStatus"]>[0],
): Promise<void> {
  const cfg = ctx.config as GmailConfig;
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
        : null) ?? `Gmail token refresh failed: ${res.status}`;
    throw new Error(msg);
  }
  const access = typeof parsed.access_token === "string" ? parsed.access_token : "";
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  if (!access) throw new Error("Google refresh did not return an access token");
  const next: GmailConfig = {
    ...cfg,
    accessToken: access,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  ctx.setConfig?.(next as unknown as Record<string, unknown>);
  // Mutate locally too so the current request sees the new token.
  ctx.config = next as unknown as Record<string, unknown>;
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  const text = await res.text();
  const parsed = safeJson(text);
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String(
            (parsed as { error?: { message?: unknown } }).error?.message ??
              (parsed as { error?: unknown }).error,
          )
        : null) ?? `Gmail ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

function encodeRfc822(m: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
}): string {
  const headers: string[] = [];
  headers.push(`To: ${m.to}`);
  if (m.cc) headers.push(`Cc: ${m.cc}`);
  if (m.bcc) headers.push(`Bcc: ${m.bcc}`);
  headers.push(`Subject: ${encodeHeader(m.subject)}`);
  headers.push("MIME-Version: 1.0");

  let message: string;
  if (m.html) {
    const boundary = `gsn_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    message = [
      headers.join("\r\n"),
      "",
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      "Content-Transfer-Encoding: 7bit",
      "",
      m.body,
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      "Content-Transfer-Encoding: 7bit",
      "",
      m.html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    headers.push("Content-Transfer-Encoding: 7bit");
    message = `${headers.join("\r\n")}\r\n\r\n${m.body}`;
  }
  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeHeader(s: string): string {
  return /[^\x20-\x7e]/.test(s)
    ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`
    : s;
}

function str(v: unknown): string {
  if (typeof v !== "string" || !v) throw new Error("Missing required field");
  return v;
}
function maybeStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function safeJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
