import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationRuntimeContext,
} from "../types.js";
import { maskSecret } from "../../lib/secret.js";
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
 */

const GITHUB_API = "https://api.github.com";

/** Persisted shape for `authMode="apikey"` connections. */
export type GithubApiKeyConfig = {
  apiKey: string;
  login?: string;
  userId?: number;
  userName?: string;
  userType?: string;
  repos?: GithubRepoRef[];
};

type FetchInit = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

async function githubFetch(
  accessToken: string,
  path: string,
  init: FetchInit = {},
): Promise<unknown> {
  const qs = init.query
    ? "?" +
      Object.entries(init.query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
        )
        .join("&")
    : "";
  const url = `${GITHUB_API}${path}${qs}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "genosyn",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      (parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof (parsed as { message?: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : null) ?? `GitHub ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

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

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

function requireOwnerRepo(args: Record<string, unknown>): {
  owner: string;
  repo: string;
} {
  return {
    owner: requireString(args.owner, "owner"),
    repo: requireString(args.repo, "repo"),
  };
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

  tools: [
    {
      name: "get_authenticated_user",
      description:
        "Return the GitHub user this connection is authenticated as (login, name, email if visible).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_repos",
      description:
        "List repositories the authenticated user has access to. Sorted by `sort` (default: updated desc).",
      inputSchema: {
        type: "object",
        properties: {
          visibility: {
            type: "string",
            enum: ["all", "public", "private"],
            description: "Filter by visibility.",
          },
          affiliation: {
            type: "string",
            description:
              "Comma-separated: owner, collaborator, organization_member. Default covers all three.",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "pushed", "full_name"],
          },
          direction: { type: "string", enum: ["asc", "desc"] },
          per_page: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max rows per page (1-100, default 30).",
          },
          page: { type: "integer", minimum: 1, description: "1-indexed page." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_repo",
      description: "Fetch one repository by owner + name.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Org or user login." },
          repo: { type: "string", description: "Repo name." },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
    },
    {
      name: "search_repos",
      description:
        "Search repositories by GitHub search syntax (e.g. `language:typescript stars:>100`).",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "GitHub search query." },
          sort: {
            type: "string",
            enum: ["stars", "forks", "help-wanted-issues", "updated"],
          },
          order: { type: "string", enum: ["asc", "desc"] },
          per_page: { type: "integer", minimum: 1, maximum: 100 },
          page: { type: "integer", minimum: 1 },
        },
        required: ["q"],
        additionalProperties: false,
      },
    },
    {
      name: "get_file_contents",
      description:
        "Read a file or list a directory at `path` in the given repo. For files, the `content` field is base64; decode before showing.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: {
            type: "string",
            description: "Relative path inside the repo. Empty for repo root.",
          },
          ref: {
            type: "string",
            description: "Branch, tag, or commit SHA. Defaults to the repo's default branch.",
          },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
    },
    {
      name: "list_issues",
      description:
        "List issues in a repo. Excludes pull requests by default. Use `state` to filter.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          labels: {
            type: "string",
            description: "Comma-separated list of label names.",
          },
          assignee: { type: "string", description: "Login, `none`, or `*`." },
          creator: { type: "string" },
          since: {
            type: "string",
            description: "ISO 8601 timestamp; only issues updated at/after this time.",
          },
          per_page: { type: "integer", minimum: 1, maximum: 100 },
          page: { type: "integer", minimum: 1 },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
    },
    {
      name: "get_issue",
      description: "Fetch one issue by number, including labels and assignees.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer", minimum: 1 },
        },
        required: ["owner", "repo", "number"],
        additionalProperties: false,
      },
    },
    {
      name: "create_issue",
      description: "Create a new issue in the given repo. Requires `issues:write` on the token.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string", description: "Markdown body." },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Existing label names to apply.",
          },
          assignees: {
            type: "array",
            items: { type: "string" },
            description: "GitHub logins to assign.",
          },
        },
        required: ["owner", "repo", "title"],
        additionalProperties: false,
      },
    },
    {
      name: "add_issue_comment",
      description:
        "Comment on an existing issue or pull request. Requires `issues:write` on the token.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer", minimum: 1 },
          body: { type: "string", description: "Markdown comment body." },
        },
        required: ["owner", "repo", "number", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "list_pull_requests",
      description: "List pull requests in a repo. Use `state` to filter.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          head: {
            type: "string",
            description: "Filter by head branch (`user:branch` or `org:branch`).",
          },
          base: { type: "string", description: "Filter by base branch." },
          sort: {
            type: "string",
            enum: ["created", "updated", "popularity", "long-running"],
          },
          direction: { type: "string", enum: ["asc", "desc"] },
          per_page: { type: "integer", minimum: 1, maximum: 100 },
          page: { type: "integer", minimum: 1 },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
    },
    {
      name: "get_pull_request",
      description: "Fetch one pull request by number, including merge state and review counts.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer", minimum: 1 },
        },
        required: ["owner", "repo", "number"],
        additionalProperties: false,
      },
    },
    {
      name: "create_pull_request",
      description:
        "Open a pull request from `head` (a branch the agent already pushed) into `base`. The agent is expected to have committed and pushed the head branch via plain `git` from inside its `repos/<owner>/<name>/` working tree before calling this tool. Set `draft: true` to open a draft PR.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repo owner (org or user)." },
          repo: { type: "string", description: "Repo name." },
          title: { type: "string", description: "PR title." },
          body: {
            type: "string",
            description: "Markdown PR description. Optional but strongly recommended.",
          },
          head: {
            type: "string",
            description:
              "Source branch. For same-repo PRs, just the branch name; for forks use `user:branch`.",
          },
          base: {
            type: "string",
            description: "Target branch (usually the repo's default branch).",
          },
          draft: {
            type: "boolean",
            description: "Open as a draft PR.",
          },
          maintainer_can_modify: {
            type: "boolean",
            description:
              "Allow maintainers to push to the head branch. Defaults to true.",
          },
        },
        required: ["owner", "repo", "title", "head", "base"],
        additionalProperties: false,
      },
    },
    {
      name: "list_commits",
      description: "List commits in a repo. Filter by branch (`sha`), path, author, or `since`.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          sha: { type: "string", description: "Branch name, tag, or commit SHA." },
          path: { type: "string", description: "Only commits touching this path." },
          author: { type: "string", description: "GitHub login or email." },
          since: { type: "string", description: "ISO 8601 timestamp." },
          until: { type: "string", description: "ISO 8601 timestamp." },
          per_page: { type: "integer", minimum: 1, maximum: 100 },
          page: { type: "integer", minimum: 1 },
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
    },
    {
      name: "search_code",
      description:
        "Search code across repos the token can see. Use GitHub code-search syntax (e.g. `repo:org/name path:src/ encryptSecret`).",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "GitHub code-search query." },
          per_page: { type: "integer", minimum: 1, maximum: 100 },
          page: { type: "integer", minimum: 1 },
        },
        required: ["q"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("Personal access token is required");
    const user = (await githubFetch(apiKey, "/user")) as {
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
      await githubFetch(token, "/user");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const accessToken = await ensureGithubAccessToken(ctx);
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_authenticated_user":
        return githubFetch(accessToken, "/user");

      case "list_repos": {
        const query: Record<string, string | number> = {
          per_page: clampInt(a.per_page, 1, 100, 30),
          page: clampInt(a.page, 1, 1_000_000, 1),
          sort: typeof a.sort === "string" ? a.sort : "updated",
          direction: typeof a.direction === "string" ? a.direction : "desc",
        };
        if (typeof a.visibility === "string") query.visibility = a.visibility;
        if (typeof a.affiliation === "string") query.affiliation = a.affiliation;
        return githubFetch(accessToken, "/user/repos", { query });
      }

      case "get_repo": {
        const { owner, repo } = requireOwnerRepo(a);
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        );
      }

      case "search_repos": {
        const q = requireString(a.q, "q");
        const query: Record<string, string | number> = {
          q,
          per_page: clampInt(a.per_page, 1, 100, 30),
          page: clampInt(a.page, 1, 1_000_000, 1),
        };
        if (typeof a.sort === "string") query.sort = a.sort;
        if (typeof a.order === "string") query.order = a.order;
        return githubFetch(accessToken, "/search/repositories", { query });
      }

      case "get_file_contents": {
        const { owner, repo } = requireOwnerRepo(a);
        const path = typeof a.path === "string" ? a.path.replace(/^\/+/, "") : "";
        const query: Record<string, string> = {};
        if (typeof a.ref === "string" && a.ref.trim()) query.ref = a.ref.trim();
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
          { query },
        );
      }

      case "list_issues": {
        const { owner, repo } = requireOwnerRepo(a);
        const query: Record<string, string | number> = {
          per_page: clampInt(a.per_page, 1, 100, 30),
          page: clampInt(a.page, 1, 1_000_000, 1),
          state: typeof a.state === "string" ? a.state : "open",
        };
        if (typeof a.labels === "string") query.labels = a.labels;
        if (typeof a.assignee === "string") query.assignee = a.assignee;
        if (typeof a.creator === "string") query.creator = a.creator;
        if (typeof a.since === "string") query.since = a.since;
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          { query },
        );
      }

      case "get_issue": {
        const { owner, repo } = requireOwnerRepo(a);
        const number = clampInt(a.number, 1, Number.MAX_SAFE_INTEGER, 0);
        if (!number) throw new Error("number is required");
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
        );
      }

      case "create_issue": {
        const { owner, repo } = requireOwnerRepo(a);
        const title = requireString(a.title, "title");
        const body: Record<string, unknown> = { title };
        if (typeof a.body === "string") body.body = a.body;
        if (Array.isArray(a.labels)) body.labels = a.labels;
        if (Array.isArray(a.assignees)) body.assignees = a.assignees;
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          { method: "POST", body },
        );
      }

      case "add_issue_comment": {
        const { owner, repo } = requireOwnerRepo(a);
        const number = clampInt(a.number, 1, Number.MAX_SAFE_INTEGER, 0);
        if (!number) throw new Error("number is required");
        const commentBody = requireString(a.body, "body");
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
          { method: "POST", body: { body: commentBody } },
        );
      }

      case "list_pull_requests": {
        const { owner, repo } = requireOwnerRepo(a);
        const query: Record<string, string | number> = {
          per_page: clampInt(a.per_page, 1, 100, 30),
          page: clampInt(a.page, 1, 1_000_000, 1),
          state: typeof a.state === "string" ? a.state : "open",
        };
        if (typeof a.head === "string") query.head = a.head;
        if (typeof a.base === "string") query.base = a.base;
        if (typeof a.sort === "string") query.sort = a.sort;
        if (typeof a.direction === "string") query.direction = a.direction;
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          { query },
        );
      }

      case "get_pull_request": {
        const { owner, repo } = requireOwnerRepo(a);
        const number = clampInt(a.number, 1, Number.MAX_SAFE_INTEGER, 0);
        if (!number) throw new Error("number is required");
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
        );
      }

      case "create_pull_request": {
        const { owner, repo } = requireOwnerRepo(a);
        const title = requireString(a.title, "title");
        const head = requireString(a.head, "head");
        const base = requireString(a.base, "base");
        const body: Record<string, unknown> = { title, head, base };
        if (typeof a.body === "string") body.body = a.body;
        if (typeof a.draft === "boolean") body.draft = a.draft;
        if (typeof a.maintainer_can_modify === "boolean") {
          body.maintainer_can_modify = a.maintainer_can_modify;
        }
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          { method: "POST", body },
        );
      }

      case "list_commits": {
        const { owner, repo } = requireOwnerRepo(a);
        const query: Record<string, string | number> = {
          per_page: clampInt(a.per_page, 1, 100, 30),
          page: clampInt(a.page, 1, 1_000_000, 1),
        };
        if (typeof a.sha === "string") query.sha = a.sha;
        if (typeof a.path === "string") query.path = a.path;
        if (typeof a.author === "string") query.author = a.author;
        if (typeof a.since === "string") query.since = a.since;
        if (typeof a.until === "string") query.until = a.until;
        return githubFetch(
          accessToken,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
          { query },
        );
      }

      case "search_code": {
        const q = requireString(a.q, "q");
        const query: Record<string, string | number> = {
          q,
          per_page: clampInt(a.per_page, 1, 100, 30),
          page: clampInt(a.page, 1, 1_000_000, 1),
        };
        return githubFetch(accessToken, "/search/code", { query });
      }

      default:
        throw new Error(`Unknown GitHub tool: ${name}`);
    }
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
type GithubAuthMode =
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
