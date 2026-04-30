import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
  IntegrationScopeGroup,
  OauthTokenSet,
} from "../types.js";
import { config as appConfig } from "../../../config.js";

/**
 * LinkedIn — OAuth 2.0 integration.
 *
 * Each Connection represents one LinkedIn account. The user registers an
 * OAuth 2.0 app at linkedin.com/developers/apps, adds the redirect URL,
 * enables the "Sign In with LinkedIn using OpenID Connect" product (for the
 * `openid` / `profile` / `email` scopes used to identify the account), and
 * — to actually post — the "Share on LinkedIn" product (`w_member_social`).
 * Each Connection brings its own clientId + clientSecret.
 *
 * Access tokens last 60 days. Refresh tokens are not enabled by default —
 * LinkedIn only issues them to apps that have specifically requested the
 * "Refresh Tokens" capability and been approved. We persist whatever
 * LinkedIn returns; if no refresh token comes back the user is prompted to
 * reconnect when the access token expires (same model as `github-oauth.ts`
 * with token expiration disabled).
 *
 * Posting goes through the modern `/rest/posts` endpoint with
 * `LinkedIn-Version: 202402` and `X-Restli-Protocol-Version: 2.0.0` rather
 * than the older `/v2/ugcPosts` shape. The author is the OpenID `sub`
 * wrapped in a `urn:li:person:` URN.
 */

const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_API = "https://api.linkedin.com";
/** Pinned API version. Bump when LinkedIn deprecates this string — they
 *  publish 12 months of backward-compatibility per version. */
const LINKEDIN_API_VERSION = "202402";

/** Always-included baseline scopes (OpenID Connect identity). `openid` is
 *  what unlocks `/v2/userinfo`; `profile` and `email` round out the account
 *  hint. */
const LINKEDIN_OAUTH_BASELINE_SCOPES = ["openid", "profile", "email"];

export const LINKEDIN_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "post_member",
    label: "Post on member's behalf",
    description:
      "Create, retrieve, and delete posts and comments on the connected member's feed. Requires the 'Share on LinkedIn' product.",
    scopes: ["w_member_social"],
  },
  {
    key: "post_org",
    label: "Post as company pages",
    description:
      "Manage and publish content on LinkedIn company pages the member administers. Requires the 'Marketing Developer Platform' product.",
    scopes: ["w_organization_social", "rw_organization_admin"],
  },
];

export function resolveLinkedinScopes(args: {
  scopeGroups: string[];
  baseline: string[];
}): string[] {
  const out = new Set(args.baseline);
  const byKey = new Map(LINKEDIN_SCOPE_GROUPS.map((g) => [g.key, g] as const));
  for (const key of args.scopeGroups) {
    const group = byKey.get(key);
    if (!group) continue;
    for (const s of group.scopes) out.add(s);
  }
  return Array.from(out);
}

// ---------- Config shape ----------

export type LinkedinOauthConfig = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  /** Empty string when LinkedIn did not issue a refresh token (the default
   *  for apps without the "Refresh Tokens" capability). */
  refreshToken: string;
  /** ms epoch. */
  expiresAt: number;
  /** Space-separated granted scopes. */
  scope: string;
  /** OpenID `sub` — used as `urn:li:person:<sub>` when posting. */
  sub: string;
  /** Display name + email captured at connect time. */
  name?: string;
  email?: string;
  /** Scope-group keys the user picked, persisted for reconnect prefill. */
  scopeGroups?: string[];
};

// ---------- OAuth helpers (used by services/oauth.ts) ----------

export function linkedinRedirectUri(): string {
  const base = appConfig.publicUrl.replace(/\/+$/, "");
  return `${base}/api/integrations/oauth/callback/linkedin`;
}

export function buildLinkedinAuthorizeUrl(args: {
  state: string;
  scopes: string[];
  clientId: string;
  redirectUri: string;
}): string {
  if (!args.clientId) throw new Error("clientId is required");
  const u = new URL(LINKEDIN_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("state", args.state);
  u.searchParams.set("scope", args.scopes.join(" "));
  return u.toString();
}

export async function exchangeLinkedinCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ tokens: OauthTokenSet; userInfo: Record<string, unknown> }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
  });
  const tokRes = await fetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const parsed = (await safeJson(tokRes)) as Record<string, unknown> | null;
  if (!tokRes.ok || !parsed) {
    throw new Error(
      linkedinErrorMessage(parsed, `Token exchange failed: ${tokRes.status}`),
    );
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error(
      linkedinErrorMessage(parsed, "LinkedIn did not return an access token"),
    );
  }
  const access = parsed.access_token;
  const refresh =
    typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
  const expiresIn =
    typeof parsed.expires_in === "number" ? parsed.expires_in : 60 * 60 * 24 * 60;
  const scope = typeof parsed.scope === "string" ? parsed.scope : "";

  // Hit /v2/userinfo (OpenID Connect) for identity.
  const meRes = await fetch(`${LINKEDIN_API}/v2/userinfo`, {
    headers: {
      Authorization: `Bearer ${access}`,
      Accept: "application/json",
    },
  });
  const me = ((await safeJson(meRes)) ?? {}) as Record<string, unknown>;

  return {
    tokens: {
      accessToken: access,
      refreshToken: refresh || undefined,
      expiresAt: Date.now() + expiresIn * 1000,
      scope,
      tokenType: "Bearer",
    },
    userInfo: me,
  };
}

// ---------- Tool list ----------

const LINKEDIN_TOOLS = [
  {
    name: "get_me",
    description:
      "Return the authenticated LinkedIn member (sub, name, email) this connection is signed in as.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "share_post",
    description:
      "Post text content to the connected member's feed. `visibility` is PUBLIC (default) or CONNECTIONS. Requires the 'Post on member's behalf' scope.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Post body (LinkedIn auto-detects URLs; max ~3000 chars).",
        },
        visibility: {
          type: "string",
          enum: ["PUBLIC", "CONNECTIONS"],
          description: "Who can see the post. Default PUBLIC.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "share_org_post",
    description:
      "Post text content as a LinkedIn company page. `organizationId` is the numeric id (find it via list_admin_organizations). Requires the 'Post as company pages' scope.",
    inputSchema: {
      type: "object" as const,
      properties: {
        organizationId: { type: "string" },
        text: { type: "string" },
        visibility: {
          type: "string",
          enum: ["PUBLIC", "LOGGED_IN"],
          description: "Audience. Default PUBLIC.",
        },
      },
      required: ["organizationId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "get_post",
    description:
      "Fetch a post by its full URN (e.g. 'urn:li:share:1234567890' or 'urn:li:ugcPost:…').",
    inputSchema: {
      type: "object" as const,
      properties: {
        postUrn: { type: "string" },
      },
      required: ["postUrn"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_post",
    description: "Delete one of the authenticated member's own posts by URN.",
    inputSchema: {
      type: "object" as const,
      properties: {
        postUrn: { type: "string" },
      },
      required: ["postUrn"],
      additionalProperties: false,
    },
  },
  {
    name: "list_admin_organizations",
    description:
      "List company pages the authenticated member can post on behalf of. Returns each org's id and name. Requires the 'Post as company pages' scope.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
];

// ---------- Provider ----------

export const linkedinProvider: IntegrationProvider = {
  catalog: {
    provider: "linkedin",
    name: "LinkedIn",
    category: "Communication",
    tagline: "Post to a member's feed and to company pages.",
    description:
      "Connect a LinkedIn account so AI employees can publish posts on the member's feed or on company pages they administer. Each Connection brings its own OAuth 2.0 client (linkedin.com/developers/apps → 'Auth' → add redirect URL → 'Products' → enable 'Sign In with LinkedIn using OpenID Connect' and 'Share on LinkedIn'). LinkedIn issues 60-day access tokens; refresh tokens are only available to apps approved for the 'Refresh Tokens' capability.",
    icon: "Linkedin",
    authMode: "oauth2",
    oauth: {
      app: "linkedin",
      scopes: LINKEDIN_OAUTH_BASELINE_SCOPES,
      scopeGroups: LINKEDIN_SCOPE_GROUPS,
      setupDocs:
        "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow",
    },
    enabled: true,
  },

  tools: LINKEDIN_TOOLS,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups }) {
    const sub = typeof userInfo.sub === "string" ? userInfo.sub : "";
    if (!sub) {
      throw new Error(
        "LinkedIn did not return identity on /v2/userinfo — is the 'Sign In with LinkedIn using OpenID Connect' product enabled on the app?",
      );
    }
    const name = typeof userInfo.name === "string" ? userInfo.name : undefined;
    const email = typeof userInfo.email === "string" ? userInfo.email : undefined;
    const cfg: LinkedinOauthConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? "",
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 24 * 60 * 1000,
      scope: tokens.scope ?? "",
      sub,
      name,
      email,
      scopeGroups,
    };
    const display = name ?? email ?? sub;
    const hint = email && name ? `${name} · ${email}` : display;
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: hint,
    };
  },

  async checkStatus(ctx) {
    try {
      await ensureFreshToken(ctx);
      const cfg = ctx.config as LinkedinOauthConfig;
      await linkedinFetch(cfg.accessToken, "/v2/userinfo");
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
    const cfg = ctx.config as LinkedinOauthConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_me":
        return linkedinFetch(cfg.accessToken, "/v2/userinfo");

      case "share_post": {
        const text = requireString(a.text, "text");
        const visibility = strEnum(a.visibility, ["PUBLIC", "CONNECTIONS"], "PUBLIC")!;
        const author = `urn:li:person:${cfg.sub}`;
        return linkedinPostsCreate(cfg.accessToken, {
          author,
          text,
          visibility,
        });
      }

      case "share_org_post": {
        const orgId = requireString(a.organizationId, "organizationId");
        const text = requireString(a.text, "text");
        const visibility = strEnum(a.visibility, ["PUBLIC", "LOGGED_IN"], "PUBLIC")!;
        const author = `urn:li:organization:${orgId}`;
        return linkedinPostsCreate(cfg.accessToken, {
          author,
          text,
          visibility,
        });
      }

      case "get_post": {
        const urn = requireString(a.postUrn, "postUrn");
        return linkedinFetch(
          cfg.accessToken,
          `/rest/posts/${encodeURIComponent(urn)}`,
          { rest: true },
        );
      }

      case "delete_post": {
        const urn = requireString(a.postUrn, "postUrn");
        return linkedinFetch(
          cfg.accessToken,
          `/rest/posts/${encodeURIComponent(urn)}`,
          { rest: true, method: "DELETE" },
        );
      }

      case "list_admin_organizations": {
        // ACLs by member. `q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`
        // returns the orgs the connected member is an approved admin of.
        const url =
          "/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organizationalTarget~(id,localizedName)))";
        return linkedinFetch(cfg.accessToken, url);
      }

      default:
        throw new Error(`Unknown LinkedIn tool: ${name}`);
    }
  },
};

// ---------- Token lifecycle ----------

async function ensureFreshToken(ctx: IntegrationRuntimeContext): Promise<void> {
  if (ctx.authMode !== "oauth2") {
    throw new Error(
      `LinkedIn connector does not support authMode "${ctx.authMode}"`,
    );
  }
  const cfg = ctx.config as LinkedinOauthConfig;
  if (cfg.expiresAt > Date.now() + 60_000) return;
  if (!cfg.refreshToken) {
    // No refresh token (default for apps without the Refresh Tokens
    // capability). The 60-day access token is valid until expiry; once it
    // expires the user must reconnect.
    if (cfg.expiresAt <= Date.now()) {
      throw new Error(
        "LinkedIn access token has expired. Reconnect from Settings → Integrations.",
      );
    }
    return;
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Connection is missing OAuth client credentials — disconnect and reconnect.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const res = await fetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new Error(
      linkedinErrorMessage(parsed, `LinkedIn token refresh failed: ${res.status}`),
    );
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error(
      linkedinErrorMessage(parsed, "Refresh did not return an access token"),
    );
  }
  const access = parsed.access_token;
  const refresh =
    typeof parsed.refresh_token === "string" ? parsed.refresh_token : cfg.refreshToken;
  const expiresIn =
    typeof parsed.expires_in === "number" ? parsed.expires_in : 60 * 60 * 24 * 60;
  const scope = typeof parsed.scope === "string" ? parsed.scope : cfg.scope;
  const next: LinkedinOauthConfig = {
    ...cfg,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
  };
  ctx.setConfig?.(next as unknown as IntegrationConfig);
  ctx.config = next as unknown as IntegrationConfig;
}

// ---------- HTTP helpers ----------

async function linkedinFetch(
  accessToken: string,
  path: string,
  init: { method?: "GET" | "DELETE"; rest?: boolean } = {},
): Promise<unknown> {
  const url = `${LINKEDIN_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (init.rest) {
    headers["LinkedIn-Version"] = LINKEDIN_API_VERSION;
    headers["X-Restli-Protocol-Version"] = "2.0.0";
  }
  const res = await fetch(url, { method: init.method ?? "GET", headers });
  const parsed = await safeJson(res);
  if (!res.ok) {
    throw new Error(
      linkedinErrorMessage(
        parsed as Record<string, unknown> | null,
        `LinkedIn ${res.status} ${res.statusText}`,
      ),
    );
  }
  return parsed;
}

/**
 * Wrap a plain text body in the `/rest/posts` envelope LinkedIn expects.
 * The endpoint returns `201 Created` with the new post's URN in the
 * `x-restli-id` header (or `x-linkedin-id`); we surface that to the caller.
 */
async function linkedinPostsCreate(
  accessToken: string,
  args: { author: string; text: string; visibility: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN" },
): Promise<unknown> {
  const url = `${LINKEDIN_API}/rest/posts`;
  const body = {
    author: args.author,
    commentary: args.text,
    visibility: args.visibility,
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "LinkedIn-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      "content-type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await safeJson(res)) as Record<string, unknown> | null;
    throw new Error(
      linkedinErrorMessage(parsed, `LinkedIn ${res.status} ${res.statusText}`),
    );
  }
  const postUrn =
    res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id") ?? null;
  // 201 Created has no body. Hand back the URN so the caller can act on it.
  return { postUrn, status: res.status };
}

// ---------- Low-level helpers ----------

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

function strEnum<T extends string>(
  v: unknown,
  options: readonly T[],
  fallback?: T,
): T | undefined {
  if (typeof v === "string" && (options as readonly string[]).includes(v)) {
    return v as T;
  }
  return fallback;
}

function linkedinErrorMessage(
  parsed: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  // OAuth: { error, error_description }. REST: { message } or
  // { serviceErrorCode, message }.
  const desc = (parsed as { error_description?: unknown }).error_description;
  if (typeof desc === "string" && desc) return desc;
  const msg = (parsed as { message?: unknown }).message;
  if (typeof msg === "string" && msg) return msg;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === "string" && err) return err;
  return fallback;
}
