import type { IntegrationTool } from "../../types.js";
import {
  ForgeApiError,
  clampInt,
  forgeFetch,
  forgeLabel,
  pageSizeParam,
  pathSegment,
  repoPath,
  requireOwnerRepo,
  requireResourceNumber,
  requireString,
  type ForgeEndpoint,
  type ForgeFlavor,
} from "./client.js";

/**
 * The tools an AI Employee gets from a git forge Connection, written once.
 *
 * The contract the model sees is deliberately the *same* on both flavors: the
 * argument names never change, so a Skill that says "call `list_issues` with
 * `per_page`" is true whether the company runs GitHub or a Forgejo in a
 * cupboard. Where the two APIs genuinely differ the difference is absorbed
 * here — `per_page` becomes Forgejo's `limit`, `creator` becomes its
 * `created_by` — and where a capability simply does not exist the tool or the
 * argument is omitted rather than accepted and ignored. A filter that silently
 * does nothing is worse than one that was never offered, because the model
 * believes the result was filtered.
 *
 * Exactly one tool is GitHub-only: `search_code`. Forgejo has no code-search
 * endpoint at all, and the honest answer is a shorter tool list plus a note in
 * the docs, not an emulation that greps the default branch and calls itself
 * search.
 */

export type ForgeToolContext = {
  endpoint: ForgeEndpoint;
  token: string;
};

/** Page-size and page arguments, identical on both flavors. */
const PAGE_PROPERTIES = {
  per_page: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    description: "Max rows per page (1-100, default 30).",
  },
  page: { type: "integer", minimum: 1, description: "1-indexed page." },
} as const;

/** The wire form of {@link PAGE_PROPERTIES} for one flavor. */
function pageQuery(
  flavor: ForgeFlavor,
  args: Record<string, unknown>,
  defaultPerPage = 30,
): Record<string, string | number> {
  return {
    [pageSizeParam(flavor)]: clampInt(args.per_page, 1, 100, defaultPerPage),
    page: clampInt(args.page, 1, 1_000_000, 1),
  };
}

export function forgeToolDefinitions(flavor: ForgeFlavor): IntegrationTool[] {
  const label = forgeLabel(flavor);
  const github = flavor === "github";
  const tools: IntegrationTool[] = [
    {
      name: "get_authenticated_user",
      description: `Return the ${label} user this connection is authenticated as (login, name, email if visible).`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_repos",
      description: github
        ? "List repositories the authenticated user has access to. Sorted by `sort` (default: updated desc)."
        : "List repositories the authenticated user has access to, most recently updated first.",
      inputSchema: {
        type: "object",
        properties: {
          // Forgejo's /user/repos takes no visibility, affiliation, or sort
          // arguments — it returns every repository the token can see, newest
          // activity first. Offering the filters anyway would mean accepting
          // them and returning an unfiltered list.
          ...(github
            ? {
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
              }
            : {}),
          ...PAGE_PROPERTIES,
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
      description: github
        ? "Search repositories by GitHub search syntax (e.g. `language:typescript stars:>100`). Returns `{total_count, items}`."
        : "Search repositories on this Forgejo/Gitea server by keyword. `q` is matched against the repository name and description — this server has no qualifier syntax, so `language:typescript` is treated as literal text. Returns `{items}`.",
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description: github
              ? "GitHub search query."
              : "Keyword to match in name or description.",
          },
          sort: github
            ? { type: "string", enum: ["stars", "forks", "help-wanted-issues", "updated"] }
            : {
                type: "string",
                enum: ["alpha", "created", "updated", "size", "stars", "forks", "id"],
              },
          order: { type: "string", enum: ["asc", "desc"] },
          ...PAGE_PROPERTIES,
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
      description: "List issues in a repo. Excludes pull requests. Use `state` to filter.",
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
          assignee: {
            type: "string",
            description: github ? "Login, `none`, or `*`." : "Login of the assignee.",
          },
          creator: { type: "string" },
          since: {
            type: "string",
            description: "ISO 8601 timestamp; only issues updated at/after this time.",
          },
          ...PAGE_PROPERTIES,
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
      description: github
        ? "Create a new issue in the given repo. Requires `issues:write` on the token."
        : "Create a new issue in the given repo. Label names must already exist on the repository — this server cannot create one on the fly.",
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
            description: `${label} logins to assign.`,
          },
        },
        required: ["owner", "repo", "title"],
        additionalProperties: false,
      },
    },
    {
      name: "add_issue_comment",
      description: github
        ? "Comment on an existing issue or pull request. Requires `issues:write` on the token."
        : "Comment on an existing issue or pull request.",
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
      description: github
        ? "List pull requests in a repo. Use `state` to filter."
        : "List pull requests in a repo. Use `state` to filter. Passing `head` and `base` together looks up the single pull request for that exact branch pair; this server cannot filter by one of them alone.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          head: {
            type: "string",
            description: github
              ? "Filter by head branch (`user:branch` or `org:branch`)."
              : "Head branch. Must be given together with `base`.",
          },
          base: {
            type: "string",
            description: github
              ? "Filter by base branch."
              : "Base branch. Must be given together with `head`.",
          },
          // Forgejo sorts pull requests by its own vocabulary
          // (`recentupdate`, `leastcomment`, …) and has no direction
          // argument, so neither is offered rather than mapped onto values
          // that mean something else.
          ...(github
            ? {
                sort: {
                  type: "string",
                  enum: ["created", "updated", "popularity", "long-running"],
                },
                direction: { type: "string", enum: ["asc", "desc"] },
              }
            : {}),
          ...PAGE_PROPERTIES,
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
        "Open a pull request from `head` (a branch you already pushed) into `base`. First use the built-in coding tools and plain `git` to edit, test, commit, and push from the matching `repos/<owner>/<name>/` or `repositories/<slug>/` checkout, then call this tool to finish the requested delivery." +
        (github ? " Set `draft: true` to open a draft PR." : "") +
        " Never claim a PR exists unless this call succeeds.",
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
          // Neither exists in Forgejo's CreatePullRequestOption.
          ...(github
            ? {
                draft: { type: "boolean", description: "Open as a draft PR." },
                maintainer_can_modify: {
                  type: "boolean",
                  description: "Allow maintainers to push to the head branch. Defaults to true.",
                },
              }
            : {}),
        },
        required: ["owner", "repo", "title", "head", "base"],
        additionalProperties: false,
      },
    },
    {
      name: "list_commits",
      description: github
        ? "List commits in a repo. Filter by branch (`sha`), path, author, or `since`."
        : "List commits in a repo. Filter by branch (`sha`) or path.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          sha: { type: "string", description: "Branch name, tag, or commit SHA." },
          path: { type: "string", description: "Only commits touching this path." },
          // Forgejo's commit listing has no author or date filters.
          ...(github
            ? {
                author: { type: "string", description: "GitHub login or email." },
                since: { type: "string", description: "ISO 8601 timestamp." },
                until: { type: "string", description: "ISO 8601 timestamp." },
              }
            : {}),
          ...PAGE_PROPERTIES,
        },
        required: ["owner", "repo"],
        additionalProperties: false,
      },
    },
  ];

  if (github) {
    tools.push({
      name: "search_code",
      description:
        "Search code across repos the token can see. Use GitHub code-search syntax (e.g. `repo:org/name path:src/ encryptSecret`).",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "GitHub code-search query." },
          ...PAGE_PROPERTIES,
        },
        required: ["q"],
        additionalProperties: false,
      },
    });
  }

  return tools;
}

/**
 * A repository's issues endpoint also returns pull requests on both flavors.
 * Forgejo can exclude them server-side with `type=issues`; GitHub cannot, and
 * distinguishes them by adding a `pull_request` property to the payload. The
 * filter runs on both so the tool's issue-only contract is explicit at this
 * boundary rather than trusting a query parameter.
 */
function issueRows(flavor: ForgeFlavor, payload: unknown): unknown[] {
  if (!Array.isArray(payload)) {
    throw new Error(
      `${forgeLabel(flavor)} returned an invalid response while listing issues (expected an array).`,
    );
  }
  return payload.filter(
    (item) =>
      !(
        item !== null &&
        typeof item === "object" &&
        Object.prototype.hasOwnProperty.call(item, "pull_request")
      ),
  );
}

const MAX_ISSUE_API_PAGES_PER_REQUEST = 10;

/**
 * Return a logical page of issues even though GitHub paginates issues and pull
 * requests together. Scan only the API pages needed to fill the requested
 * issue page, with a hard cap so a PR-only repository cannot create an
 * unbounded request fan-out.
 *
 * Forgejo does not need any of this — it filters server-side — so it takes the
 * single-request path and the scan is GitHub's alone.
 */
async function listIssues(
  ctx: ForgeToolContext,
  owner: string,
  repo: string,
  query: Record<string, string | number>,
  perPage: number,
  logicalPage: number,
): Promise<unknown[]> {
  const { flavor } = ctx.endpoint;
  const path = `${repoPath(owner, repo)}/issues`;
  if (flavor === "forgejo") {
    const payload = await forgeFetch(ctx.endpoint, ctx.token, path, {
      query: { ...query, type: "issues", limit: perPage, page: logicalPage },
    });
    return issueRows(flavor, payload);
  }

  const apiPerPage = 100;
  const start = (logicalPage - 1) * perPage;
  const end = start + perPage;
  const issues: unknown[] = [];
  for (let apiPage = 1; apiPage <= MAX_ISSUE_API_PAGES_PER_REQUEST; apiPage += 1) {
    const payload = await forgeFetch(ctx.endpoint, ctx.token, path, {
      query: { ...query, per_page: apiPerPage, page: apiPage },
    });
    const rows = payload as unknown[];
    issues.push(...issueRows(flavor, rows));
    if (issues.length >= end || rows.length < apiPerPage) break;
  }
  return issues.slice(start, end);
}

/**
 * Turn label names into the numeric ids Forgejo's create-issue payload wants.
 *
 * GitHub takes the names directly and creates any that do not exist. Forgejo
 * takes `[]int64` and has no way to express "make this one", so unknown names
 * are reported by name instead of being dropped — an issue filed without the
 * label someone asked for looks like it worked.
 */
async function resolveForgejoLabelIds(
  ctx: ForgeToolContext,
  owner: string,
  repo: string,
  names: string[],
): Promise<number[]> {
  const wanted = names.map((name) => name.trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  const byName = new Map<string, number>();
  for (let page = 1; page <= 10; page += 1) {
    const payload = await forgeFetch(ctx.endpoint, ctx.token, `${repoPath(owner, repo)}/labels`, {
      query: { limit: 100, page },
    });
    const rows = Array.isArray(payload) ? payload : [];
    for (const row of rows) {
      const entry = row as { id?: unknown; name?: unknown };
      if (typeof entry?.id === "number" && typeof entry?.name === "string") {
        byName.set(entry.name.toLowerCase(), entry.id);
      }
    }
    if (rows.length < 100) break;
  }
  const ids: number[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const id = byName.get(name.toLowerCase());
    if (id === undefined) missing.push(name);
    else ids.push(id);
  }
  if (missing.length > 0) {
    throw new Error(
      `This server has no label called ${missing.map((name) => `"${name}"`).join(", ")} on ${owner}/${repo}. ` +
        `Create the label on the repository first, or leave it off.`,
    );
  }
  return ids;
}

export async function invokeForgeTool(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: ForgeToolContext,
): Promise<unknown> {
  const a = args ?? {};
  const { flavor } = ctx.endpoint;
  const github = flavor === "github";
  const call = (path: string, init?: Parameters<typeof forgeFetch>[3]) =>
    forgeFetch(ctx.endpoint, ctx.token, path, init);

  switch (name) {
    case "get_authenticated_user":
      return call("/user");

    case "list_repos": {
      const query: Record<string, string | number> = pageQuery(flavor, a);
      if (github) {
        query.sort = typeof a.sort === "string" ? a.sort : "updated";
        query.direction = typeof a.direction === "string" ? a.direction : "desc";
        if (typeof a.visibility === "string") query.visibility = a.visibility;
        if (typeof a.affiliation === "string") query.affiliation = a.affiliation;
      }
      return call("/user/repos", { query });
    }

    case "get_repo": {
      const { owner, repo } = requireOwnerRepo(a);
      return call(repoPath(owner, repo));
    }

    case "search_repos": {
      const q = requireString(a.q, "q");
      const query: Record<string, string | number> = { q, ...pageQuery(flavor, a) };
      if (typeof a.sort === "string") query.sort = a.sort;
      if (typeof a.order === "string") query.order = a.order;
      if (github) return call("/search/repositories", { query });
      // Forgejo wraps the rows in an `{ok, data}` envelope that carries no
      // information the caller can use. Unwrapping to `{items}` keeps the
      // result recognisably the same object on both flavors.
      const payload = (await call("/repos/search", { query })) as { data?: unknown };
      return { items: Array.isArray(payload?.data) ? payload.data : [] };
    }

    case "get_file_contents": {
      const { owner, repo } = requireOwnerRepo(a);
      const path = typeof a.path === "string" ? a.path.replace(/^\/+/, "") : "";
      const query: Record<string, string> = {};
      if (typeof a.ref === "string" && a.ref.trim()) query.ref = a.ref.trim();
      return call(
        `${repoPath(owner, repo)}/contents/${path
          .split("/")
          .map((segment) => pathSegment(segment, "path"))
          .join("/")}`,
        { query },
      );
    }

    case "list_issues": {
      const { owner, repo } = requireOwnerRepo(a);
      const query: Record<string, string | number> = {
        state: typeof a.state === "string" ? a.state : "open",
      };
      if (typeof a.labels === "string") query.labels = a.labels;
      if (typeof a.since === "string") query.since = a.since;
      if (github) {
        if (typeof a.assignee === "string") query.assignee = a.assignee;
        if (typeof a.creator === "string") query.creator = a.creator;
      } else {
        // Same question, different spelling.
        if (typeof a.assignee === "string") query.assigned_by = a.assignee;
        if (typeof a.creator === "string") query.created_by = a.creator;
      }
      return listIssues(
        ctx,
        owner,
        repo,
        query,
        clampInt(a.per_page, 1, 100, 30),
        clampInt(a.page, 1, 1_000_000, 1),
      );
    }

    case "get_issue": {
      const { owner, repo } = requireOwnerRepo(a);
      const number = requireResourceNumber(a.number, "number");
      return call(`${repoPath(owner, repo)}/issues/${number}`);
    }

    case "create_issue": {
      const { owner, repo } = requireOwnerRepo(a);
      const title = requireString(a.title, "title");
      const body: Record<string, unknown> = { title };
      if (typeof a.body === "string") body.body = a.body;
      if (Array.isArray(a.assignees)) body.assignees = a.assignees;
      if (Array.isArray(a.labels)) {
        const names = a.labels.filter((value): value is string => typeof value === "string");
        // GitHub takes the names and creates any that do not exist, so they go
        // straight through — including an empty array, which is what it always
        // sent. Forgejo needs ids, and asking for them costs a request, so an
        // empty list skips the lookup entirely.
        body.labels =
          github || names.length === 0
            ? names
            : await resolveForgejoLabelIds(ctx, owner, repo, names);
      }
      return call(`${repoPath(owner, repo)}/issues`, { method: "POST", body });
    }

    case "add_issue_comment": {
      const { owner, repo } = requireOwnerRepo(a);
      const number = requireResourceNumber(a.number, "number");
      const commentBody = requireString(a.body, "body");
      return call(`${repoPath(owner, repo)}/issues/${number}/comments`, {
        method: "POST",
        body: { body: commentBody },
      });
    }

    case "list_pull_requests": {
      const { owner, repo } = requireOwnerRepo(a);
      const head = typeof a.head === "string" ? a.head.trim() : "";
      const base = typeof a.base === "string" ? a.base.trim() : "";
      if (!github && (head || base)) {
        if (!head || !base) {
          throw new Error(
            "This server can only look up a pull request by head and base together — pass both, or neither.",
          );
        }
        // The dedicated pair lookup, which is exact where GitHub's `head=`
        // filter is a scan. A missing pair is an empty list, not an error:
        // "is there a pull request for this branch" has a legitimate no.
        // Only the 404 means that, though — swallowing a 401 as "no pull
        // requests" would tell the model the branch is unproposed when the
        // truth is that the credential cannot see it.
        try {
          const payload = await call(
            `${repoPath(owner, repo)}/pulls/${pathSegment(base, "base")}/${pathSegment(head, "head")}`,
          );
          return payload ? [payload] : [];
        } catch (error) {
          if (error instanceof ForgeApiError && error.status === 404) return [];
          throw error;
        }
      }
      const query: Record<string, string | number> = {
        ...pageQuery(flavor, a),
        state: typeof a.state === "string" ? a.state : "open",
      };
      if (github) {
        if (head) query.head = head;
        if (base) query.base = base;
        if (typeof a.sort === "string") query.sort = a.sort;
        if (typeof a.direction === "string") query.direction = a.direction;
      }
      return call(`${repoPath(owner, repo)}/pulls`, { query });
    }

    case "get_pull_request": {
      const { owner, repo } = requireOwnerRepo(a);
      const number = requireResourceNumber(a.number, "number");
      return call(`${repoPath(owner, repo)}/pulls/${number}`);
    }

    case "create_pull_request": {
      const { owner, repo } = requireOwnerRepo(a);
      const title = requireString(a.title, "title");
      const head = requireString(a.head, "head");
      const base = requireString(a.base, "base");
      const body: Record<string, unknown> = { title, head, base };
      if (typeof a.body === "string") body.body = a.body;
      if (github) {
        if (typeof a.draft === "boolean") body.draft = a.draft;
        if (typeof a.maintainer_can_modify === "boolean") {
          body.maintainer_can_modify = a.maintainer_can_modify;
        }
      }
      return call(`${repoPath(owner, repo)}/pulls`, { method: "POST", body });
    }

    case "list_commits": {
      const { owner, repo } = requireOwnerRepo(a);
      const query: Record<string, string | number> = pageQuery(flavor, a);
      if (typeof a.sha === "string") query.sha = a.sha;
      if (typeof a.path === "string") query.path = a.path;
      if (github) {
        if (typeof a.author === "string") query.author = a.author;
        if (typeof a.since === "string") query.since = a.since;
        if (typeof a.until === "string") query.until = a.until;
      }
      return call(`${repoPath(owner, repo)}/commits`, { query });
    }

    case "search_code": {
      if (!github) {
        throw new Error("This server has no code search API.");
      }
      const q = requireString(a.q, "q");
      return call("/search/code", { query: { q, ...pageQuery(flavor, a) } });
    }

    default:
      throw new Error(`Unknown ${forgeLabel(flavor)} tool: ${name}`);
  }
}
