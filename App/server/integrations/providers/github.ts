import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
} from "../types.js";
import { maskSecret } from "../../lib/secret.js";
import { GITHUB_ENDPOINT, forgeFetch } from "./forge/client.js";
import { forgeToolDefinitions, invokeForgeTool } from "./forge/tools.js";
import {
  GITHUB_SCOPE_GROUPS,
  refreshGithubToken,
  type GithubOauthConfig,
  type GithubRepoRef,
} from "./github-oauth.js";
import {
  buildGithubAppConfig as buildGithubAppConfigImpl,
  ensureInstallationToken,
  type GithubAppConfig,
} from "./github-app.js";
/**
 * GitHub — repos, issues, pull requests, code search.
 *
 * Two auth modes are supported, picked at create-time:
 *
 *   • Personal Access Token (`authMode="apikey"`): user pastes a classic
 *     `ghp_…` or fine-grained `github_pat_…`. We call /user on create to
 *     validate the token and capture the login + display name. Tokens are
 *     long-lived; nothing to refresh.
 *
 *   • OAuth 2.0 (`authMode="oauth2"`): each Connection brings its own OAuth
 *     App (`clientId` + `clientSecret`, registered at
 *     github.com/settings/developers) and runs the standard 3-legged
 *     consent dance. Refresh tokens are only issued when the OAuth App has
 *     "Expire user authorization tokens" enabled — otherwise the access
 *     token is long-lived. We handle both cases transparently.
 *
 * On both modes the Connection persists a `repos[]` allowlist — the subset
 * of accessible repos that engineering AI employees with a grant on this
 * Connection can clone into their working directory. The allowlist is
 * editable from Settings → Integrations and lives inside the encrypted
 * config blob (no schema change).
 *
 * The tools themselves live in `forge/`, shared with the Forgejo/Gitea
 * connector: the two REST surfaces differ only in where the API root is, how
 * a token is presented, and what the page-size parameter is called, and one
 * implementation of `list_issues` is worth more than two that agree until
 * somebody edits one. What stays here is everything GitHub does not share —
 * three auth modes, OAuth refresh, App installation tokens, and the repo
 * allowlist those modes each persist differently.
 */

/** Persisted shape for `authMode="apikey"` connections. */
export type GithubApiKeyConfig = {
  apiKey: string;
  login?: string;
  userId?: number;
  userName?: string;
  userType?: string;
  repos?: GithubRepoRef[];
};

/**
 * Resolve the access token for the current request, refreshing the OAuth
 * token in-place if it's near expiry. Used by every tool handler.
 */
async function ensureGithubAccessToken(
  ctx: IntegrationRuntimeContext,
): Promise<string> {
  if (ctx.authMode === "apikey") {
    const cfg = ctx.config as GithubApiKeyConfig;
    if (!cfg.apiKey) throw new Error("GitHub Connection is missing its API key.");
    return cfg.apiKey;
  }
  if (ctx.authMode === "oauth2") {
    const cfg = ctx.config as GithubOauthConfig;
    if (!cfg.accessToken) {
      throw new Error("GitHub Connection is missing its OAuth access token.");
    }
    // expiresAt === 0 → OAuth App without expiration; access token is
    // long-lived, no refresh needed/possible.
    if (cfg.expiresAt > 0 && cfg.expiresAt < Date.now() + 60_000) {
      const refreshed = await refreshGithubToken(cfg);
      const next: GithubOauthConfig = {
        ...cfg,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope,
      };
      ctx.setConfig?.(next as unknown as IntegrationConfig);
      ctx.config = next as unknown as IntegrationConfig;
      return next.accessToken;
    }
    return cfg.accessToken;
  }
  if (ctx.authMode === "github_app") {
    const cfg = ctx.config as GithubAppConfig;
    const { accessToken, refreshedConfig } = await ensureInstallationToken(cfg);
    if (refreshedConfig) {
      ctx.setConfig?.(refreshedConfig as unknown as IntegrationConfig);
      ctx.config = refreshedConfig as unknown as IntegrationConfig;
    }
    return accessToken;
  }
  throw new Error(`GitHub connector does not support authMode "${ctx.authMode}"`);
}

export const githubProvider: IntegrationProvider = {
  catalog: {
    provider: "github",
    name: "GitHub",
    category: "Developer",
    tagline: "Repos, issues, pull requests, code search, and PRs from AI employees.",
    description:
      "Connect a GitHub account so AI employees can browse repos, read code, triage issues, and open pull requests against the repos you allowlist on the Connection. OAuth is recommended for a one-click connect; a Personal Access Token still works for headless setups. Engineering employees with a grant on this Connection get a fresh `git clone` of each allowlisted repo materialized into their working directory before every spawn — they can branch, commit, push, and call the `create_pull_request` tool to ship work.",
    icon: "Github",
    authMode: "oauth2",
    fields: [
      {
        key: "apiKey",
        label: "Personal Access Token",
        type: "password",
        placeholder: "ghp_… or github_pat_…",
        required: true,
        hint: "Fine-grained tokens scoped to the orgs/repos you trust are recommended. Needs `repo` scope to clone + push.",
      },
    ],
    oauth: {
      app: "github",
      // `repo` covers private clone/push/issues/PRs; `read:user` is
      // required for the /user lookup we do for the account hint. The
      // optional scope groups (`workflow`, `read:org`) are user-pickable.
      scopes: ["repo", "read:user"],
      scopeGroups: GITHUB_SCOPE_GROUPS,
      setupDocs:
        "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
    },
    githubApp: {
      setupDocs:
        "https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app",
    },
    enabled: true,
  },

  tools: forgeToolDefinitions("github"),

  async validateApiKey(input) {
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("Personal access token is required");
    const user = (await forgeFetch(GITHUB_ENDPOINT, apiKey, "/user")) as {
      id?: number;
      login?: string;
      name?: string;
      type?: string;
    };
    if (!user?.login) {
      throw new Error("GitHub returned no user — token may be invalid.");
    }
    const config: GithubApiKeyConfig = {
      apiKey,
      login: user.login,
      userId: user.id,
      userName: user.name ?? undefined,
      userType: user.type ?? undefined,
      repos: [],
    };
    const display = user.name ? `${user.name} (@${user.login})` : `@${user.login}`;
    const accountHint = `${display} · ${maskSecret(apiKey)}`;
    return { config: config as unknown as IntegrationConfig, accountHint };
  },

  async buildGithubAppConfig(args) {
    return buildGithubAppConfigImpl(args);
  },

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups }) {
    const login = typeof userInfo.login === "string" ? userInfo.login : "";
    const userId = typeof userInfo.id === "number" ? userInfo.id : 0;
    const userName = typeof userInfo.name === "string" ? userInfo.name : undefined;
    if (!login || !userId) {
      throw new Error(
        "GitHub did not return user identity on /user — token may be missing read:user scope.",
      );
    }
    const cfg: GithubOauthConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      // Empty string is a valid state for OAuth Apps that don't expire
      // tokens — refresh attempts are skipped when this is empty.
      refreshToken: tokens.refreshToken ?? "",
      expiresAt: tokens.expiresAt ?? 0,
      scope: tokens.scope ?? "",
      login,
      userId,
      userName,
      repos: [],
      scopeGroups,
    };
    const display = userName ? `${userName} (@${login})` : `@${login}`;
    return {
      config: cfg as unknown as IntegrationConfig,
      accountHint: display,
    };
  },

  async checkStatus(ctx) {
    try {
      const token = await ensureGithubAccessToken(ctx);
      await forgeFetch(GITHUB_ENDPOINT, token, "/user");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    return invokeForgeTool(name, args as Record<string, unknown> | undefined, {
      endpoint: GITHUB_ENDPOINT,
      token: await ensureGithubAccessToken(ctx),
    });
  },
};

/**
 * Resolve the access token + login for a GitHub Connection's persisted
 * config, refreshing in-place if necessary. Used by the repo-sync service
 * (which needs a token to materialize `git clone` credential helpers) — not
 * just the in-band tool dispatcher.
 *
 * Returns `null` when the config is missing the credentials we need (e.g. an
 * OAuth row whose access token was never saved). Callers should treat that as
 * a hard skip.
 */
export type GithubAuthMode =
  | "apikey"
  | "oauth2"
  | "service_account"
  | "github_app"
  | "browser";

export async function resolveGithubCredentials(
  cfg: IntegrationConfig,
  authMode: GithubAuthMode,
): Promise<{
  accessToken: string;
  login: string;
  /** When non-null, the caller should re-encrypt + persist the updated
   * config (refresh-token / installation-token rotation). */
  refreshedConfig: IntegrationConfig | null;
} | null> {
  if (authMode === "apikey") {
    const c = cfg as GithubApiKeyConfig;
    if (!c.apiKey) return null;
    return {
      accessToken: c.apiKey,
      login: c.login ?? "",
      refreshedConfig: null,
    };
  }
  if (authMode === "oauth2") {
    const c = cfg as GithubOauthConfig;
    if (!c.accessToken) return null;
    if (c.expiresAt > 0 && c.expiresAt < Date.now() + 60_000 && c.refreshToken) {
      const refreshed = await refreshGithubToken(c);
      const next: GithubOauthConfig = {
        ...c,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        scope: refreshed.scope,
      };
      return {
        accessToken: next.accessToken,
        login: next.login,
        refreshedConfig: next as unknown as IntegrationConfig,
      };
    }
    return { accessToken: c.accessToken, login: c.login, refreshedConfig: null };
  }
  if (authMode === "github_app") {
    const c = cfg as GithubAppConfig;
    const { accessToken, refreshedConfig } = await ensureInstallationToken(c);
    return {
      accessToken,
      // GitHub App installation tokens authenticate as the App, not a user.
      // The "login" here is informational for the credential helper /
      // accountHint surfaces; an empty string is fine — git push uses the
      // x-access-token literal regardless of this value.
      login: c.account ?? c.appSlug ?? "",
      refreshedConfig: refreshedConfig
        ? (refreshedConfig as unknown as IntegrationConfig)
        : null,
    };
  }
  return null;
}

/** Read the persisted repo allowlist regardless of auth mode. */
export function readGithubRepos(
  cfg: IntegrationConfig,
  authMode: GithubAuthMode,
): GithubRepoRef[] {
  if (authMode === "apikey") {
    return (cfg as GithubApiKeyConfig).repos ?? [];
  }
  if (authMode === "oauth2") {
    return (cfg as GithubOauthConfig).repos ?? [];
  }
  if (authMode === "github_app") {
    return (cfg as GithubAppConfig).repos ?? [];
  }
  return [];
}

/** Write a new repo allowlist back into the config blob. */
export function writeGithubRepos(
  cfg: IntegrationConfig,
  authMode: GithubAuthMode,
  repos: GithubRepoRef[],
): IntegrationConfig {
  if (authMode === "apikey") {
    return { ...(cfg as GithubApiKeyConfig), repos } as unknown as IntegrationConfig;
  }
  if (authMode === "oauth2") {
    return { ...(cfg as GithubOauthConfig), repos } as unknown as IntegrationConfig;
  }
  if (authMode === "github_app") {
    return { ...(cfg as GithubAppConfig), repos } as unknown as IntegrationConfig;
  }
  return cfg;
}
