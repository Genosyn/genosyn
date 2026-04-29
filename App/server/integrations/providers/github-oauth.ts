import type {
  IntegrationConfig,
  IntegrationScopeGroup,
  OauthTokenSet,
} from "../types.js";
import { config as appConfig } from "../../../config.js";

/**
 * GitHub — OAuth 2.0 helpers.
 *
 * Lives next to the main `github.ts` provider so the pure URL/code-exchange
 * functions stay separate from the catalog + tool-dispatch code. Mirrors the
 * `google.ts` / `x.ts` shape so `services/oauth.ts` can dispatch on
 * `oauth.app === "github"` the same way it already does for Google and X.
 *
 * Each Connection brings its own OAuth App (`clientId` + `clientSecret`,
 * registered at github.com/settings/developers). The standard 3-legged
 * consent flow runs against `https://github.com/login/oauth/authorize` and
 * exchanges at `https://github.com/login/oauth/access_token` with
 * `Accept: application/json` so we get a JSON token response (the legacy
 * default is querystring-encoded).
 *
 * **Refresh tokens.** GitHub OAuth Apps only return refresh tokens when
 * "Expire user authorization tokens" is enabled in the app's settings. With
 * expiration off, the access token is long-lived (PAT-equivalent) and there
 * is no refresh — we treat that as `expiresAt = 0` and skip refresh attempts.
 * With expiration on, access tokens last 8 hours and refresh tokens last 6
 * months.
 */

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";

/**
 * Always-included baseline scopes (declared on the github catalog's
 * `oauth.scopes`). `repo` covers private-repo clone + push, issues, and PR
 * creation; `read:user` is required to call `/user` for the account hint.
 * `workflow` is not in the baseline — pushes touching `.github/workflows/`
 * reject without it, but most agents don't need that scope, so it's the
 * opt-in `actions` scope group below.
 */

/**
 * User-pickable scope bundles. The Settings → Integrations connect modal
 * renders these as checkboxes; the start endpoint resolves the keys back to
 * the underlying scope strings. Adding a new bundle is a single entry.
 */
export const GITHUB_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "actions",
    label: "GitHub Actions",
    description:
      "Allow pushes that touch `.github/workflows/`. Required if the AI edits CI workflows.",
    scopes: ["workflow"],
  },
  {
    key: "org",
    label: "Org access",
    description:
      "Read org membership and private org repos. Required to clone repos from an organization the user belongs to.",
    scopes: ["read:org"],
  },
];

export const ALL_GITHUB_SCOPE_GROUP_KEYS = GITHUB_SCOPE_GROUPS.map((g) => g.key);

/**
 * Resolve scope-group keys → flat scope list. Unknown keys are silently
 * dropped (forward-compat: a connection persisted with key "foo" we later
 * remove won't break reconnect — it just means that group is no longer
 * requested).
 */
export function resolveGithubScopes(args: {
  scopeGroups: string[];
  baseline: string[];
}): string[] {
  const out = new Set(args.baseline);
  const byKey = new Map(GITHUB_SCOPE_GROUPS.map((g) => [g.key, g] as const));
  for (const key of args.scopeGroups) {
    const group = byKey.get(key);
    if (!group) continue;
    for (const s of group.scopes) out.add(s);
  }
  return Array.from(out);
}

// ---------- Config shape (stored encrypted on the Connection) ----------

export type GithubOauthConfig = {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  /** Empty string when the OAuth App does not expire tokens — there is no
   * refresh token in that case. */
  refreshToken: string;
  /** ms epoch. `0` means "no expiration / cannot refresh" (long-lived
   * access token issued by an OAuth App with expiration disabled). */
  expiresAt: number;
  /** Space-separated granted scopes. */
  scope: string;
  /** Authenticated user's GitHub login + numeric id. Captured at connect time. */
  login: string;
  userId: number;
  userName?: string;
  /** Which repos the runner is allowed to materialize on disk for granted
   * employees. `[]` means "no repos selected yet" — the connection is
   * authenticated but won't clone anything until the operator picks repos. */
  repos: GithubRepoRef[];
  /** Scope-group keys the user picked, persisted for reconnect prefill. */
  scopeGroups?: string[];
};

/**
 * One repo entry on the Connection's allowlist. `defaultBranch` is captured
 * once at pick time so the runner doesn't need a round-trip to GitHub to know
 * what to fast-forward to before each spawn — staleness is OK here, the
 * agent can always `git fetch` and switch branches itself.
 */
export type GithubRepoRef = {
  owner: string;
  name: string;
  defaultBranch: string;
};

export function githubRedirectUri(): string {
  const base = appConfig.publicUrl.replace(/\/+$/, "");
  return `${base}/api/integrations/oauth/callback/github`;
}

// ---------- OAuth helpers ----------

export function buildGithubAuthorizeUrl(args: {
  state: string;
  scopes: string[];
  clientId: string;
  redirectUri: string;
}): string {
  if (!args.clientId) throw new Error("clientId is required");
  const u = new URL(GITHUB_AUTHORIZE_URL);
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("scope", args.scopes.join(" "));
  u.searchParams.set("state", args.state);
  // `allow_signup=true` is the default; explicit so behavior survives a
  // GitHub policy change.
  u.searchParams.set("allow_signup", "true");
  return u.toString();
}

export async function exchangeGithubCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ tokens: OauthTokenSet; userInfo: Record<string, unknown> }> {
  const tokRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  const tokParsed = (await safeJson(tokRes)) as Record<string, unknown> | null;
  if (!tokRes.ok || !tokParsed) {
    throw new Error(githubErrorMessage(tokParsed, `Token exchange failed: ${tokRes.status}`));
  }
  // GitHub returns OAuth errors as 200 with `{ error, error_description }` —
  // success requires an access_token field.
  if (typeof tokParsed.access_token !== "string" || !tokParsed.access_token) {
    throw new Error(githubErrorMessage(tokParsed, "GitHub did not return an access token"));
  }
  const access = tokParsed.access_token;
  const refresh =
    typeof tokParsed.refresh_token === "string" ? tokParsed.refresh_token : "";
  // `expires_in` only present when the OAuth App has token expiration enabled.
  // Otherwise the token is long-lived; `expiresAt: 0` signals "do not refresh".
  const expiresIn =
    typeof tokParsed.expires_in === "number" ? tokParsed.expires_in : 0;
  const scope = typeof tokParsed.scope === "string" ? tokParsed.scope : "";

  // Hit /user for the account hint. Always available with `read:user` (or
  // any of the broader scopes we request) on the token.
  const meRes = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Authorization: `Bearer ${access}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "genosyn",
    },
  });
  const me = ((await safeJson(meRes)) ?? {}) as Record<string, unknown>;

  return {
    tokens: {
      accessToken: access,
      refreshToken: refresh || undefined,
      expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
      scope,
      tokenType: "Bearer",
    },
    userInfo: me,
  };
}

/**
 * Refresh an OAuth access token using the stored refresh token. Only callable
 * when `cfg.refreshToken` is non-empty (i.e. the OAuth App has token
 * expiration enabled). Throws if GitHub rejects the refresh — caller turns
 * that into a connection-status update.
 */
export async function refreshGithubToken(cfg: GithubOauthConfig): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}> {
  if (!cfg.refreshToken) {
    throw new Error(
      "GitHub OAuth App does not issue refresh tokens (token expiration is disabled). The access token does not expire.",
    );
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Connection is missing OAuth client credentials — disconnect and reconnect.",
    );
  }
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok || !parsed) {
    throw new Error(githubErrorMessage(parsed, `GitHub token refresh failed: ${res.status}`));
  }
  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new Error(githubErrorMessage(parsed, "Refresh did not return an access token"));
  }
  const access = parsed.access_token;
  const refresh =
    typeof parsed.refresh_token === "string" ? parsed.refresh_token : cfg.refreshToken;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 0;
  const scope = typeof parsed.scope === "string" ? parsed.scope : cfg.scope;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    scope,
  };
}

// ---------- Internal helpers ----------

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function githubErrorMessage(
  parsed: Record<string, unknown> | null,
  fallback: string,
): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  // OAuth errors: { error, error_description }. REST errors: { message }.
  const desc = (parsed as { error_description?: unknown }).error_description;
  if (typeof desc === "string" && desc) return desc;
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === "string" && err) return err;
  const msg = (parsed as { message?: unknown }).message;
  if (typeof msg === "string" && msg) return msg;
  return fallback;
}

// Cast helper for callers that need to narrow `IntegrationConfig` to the
// GitHub OAuth shape without sprinkling `as unknown as` at every call site.
export function asGithubOauthConfig(cfg: IntegrationConfig): GithubOauthConfig {
  return cfg as unknown as GithubOauthConfig;
}
