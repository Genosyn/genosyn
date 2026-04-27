import type { IntegrationProvider } from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * GitHub — API-key integration. Users paste a Personal Access Token (classic
 * `ghp_…` or fine-grained `github_pat_…`). We call /user on create to
 * validate the token and capture the login + display name for the account
 * hint. A Company can register multiple GitHub Connections (one per
 * org/account/scope) and grant them independently to AI employees.
 *
 * No SDK dependency — the REST API is JSON over HTTPS and easy to hit with
 * `fetch`. If we later need GraphQL or finer-grained streaming, swapping in
 * `@octokit/rest` becomes a local change.
 */

const GITHUB_API = "https://api.github.com";

type GitHubConfig = {
  apiKey: string;
  login?: string;
  userId?: number;
  userName?: string;
  userType?: string;
};

type FetchInit = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

async function githubFetch(
  apiKey: string,
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
    Authorization: `Bearer ${apiKey}`,
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
    tagline: "Repos, issues, pull requests, code search.",
    description:
      "Connect a GitHub account so AI employees can browse repos, read code, triage issues, and open pull requests. Uses a Personal Access Token — create one at github.com/settings/tokens (classic) or github.com/settings/personal-access-tokens (fine-grained) and grant the scopes you want the employees to have. Add multiple connections to cover several orgs or accounts.",
    icon: "Github",
    authMode: "apikey",
    fields: [
      {
        key: "apiKey",
        label: "Personal Access Token",
        type: "password",
        placeholder: "ghp_… or github_pat_…",
        required: true,
        hint: "Fine-grained tokens scoped to the orgs/repos you trust are recommended.",
      },
    ],
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
    const config: GitHubConfig = {
      apiKey,
      login: user.login,
      userId: user.id,
      userName: user.name ?? undefined,
      userType: user.type ?? undefined,
    };
    const display = user.name ? `${user.name} (@${user.login})` : `@${user.login}`;
    const accountHint = `${display} · ${maskSecret(apiKey)}`;
    return { config, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as GitHubConfig;
    try {
      await githubFetch(cfg.apiKey, "/user");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as GitHubConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_authenticated_user":
        return githubFetch(cfg.apiKey, "/user");

      case "list_repos": {
        const query: Record<string, string | number> = {
          per_page: clampInt(a.per_page, 1, 100, 30),
          page: clampInt(a.page, 1, 1_000_000, 1),
          sort: typeof a.sort === "string" ? a.sort : "updated",
          direction: typeof a.direction === "string" ? a.direction : "desc",
        };
        if (typeof a.visibility === "string") query.visibility = a.visibility;
        if (typeof a.affiliation === "string") query.affiliation = a.affiliation;
        return githubFetch(cfg.apiKey, "/user/repos", { query });
      }

      case "get_repo": {
        const { owner, repo } = requireOwnerRepo(a);
        return githubFetch(
          cfg.apiKey,
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
        return githubFetch(cfg.apiKey, "/search/repositories", { query });
      }

      case "get_file_contents": {
        const { owner, repo } = requireOwnerRepo(a);
        const path = typeof a.path === "string" ? a.path.replace(/^\/+/, "") : "";
        const query: Record<string, string> = {};
        if (typeof a.ref === "string" && a.ref.trim()) query.ref = a.ref.trim();
        return githubFetch(
          cfg.apiKey,
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
          cfg.apiKey,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          { query },
        );
      }

      case "get_issue": {
        const { owner, repo } = requireOwnerRepo(a);
        const number = clampInt(a.number, 1, Number.MAX_SAFE_INTEGER, 0);
        if (!number) throw new Error("number is required");
        return githubFetch(
          cfg.apiKey,
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
          cfg.apiKey,
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
          cfg.apiKey,
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
          cfg.apiKey,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          { query },
        );
      }

      case "get_pull_request": {
        const { owner, repo } = requireOwnerRepo(a);
        const number = clampInt(a.number, 1, Number.MAX_SAFE_INTEGER, 0);
        if (!number) throw new Error("number is required");
        return githubFetch(
          cfg.apiKey,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
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
          cfg.apiKey,
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
        return githubFetch(cfg.apiKey, "/search/code", { query });
      }

      default:
        throw new Error(`Unknown GitHub tool: ${name}`);
    }
  },
};
