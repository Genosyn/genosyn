import type { IntegrationProvider } from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * Linear — API-key integration. Users paste a personal API key (`lin_api_…`)
 * created at linear.app/settings/api. We hit the GraphQL endpoint with a
 * `viewer` query on create to validate the key and capture the user +
 * organization name for the account hint.
 *
 * Linear's only API surface is GraphQL, so the helpers below all POST to
 * `/graphql`. We expose a small set of high-leverage operations (issues,
 * teams, comments, projects) plus a `graphql` escape hatch for anything
 * the curated tools don't cover.
 */

const LINEAR_API = "https://api.linear.app/graphql";

type LinearConfig = {
  apiKey: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  organizationId?: string;
  organizationName?: string;
  organizationUrlKey?: string;
};

type GraphQLError = { message?: string };

async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg =
      (parsed &&
      typeof parsed === "object" &&
      "errors" in parsed &&
      Array.isArray((parsed as { errors?: unknown }).errors) &&
      ((parsed as { errors: GraphQLError[] }).errors[0]?.message ?? null)) ||
      `Linear ${res.status} ${res.statusText}`;
    throw new Error(typeof msg === "string" ? msg : `Linear ${res.status}`);
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "errors" in parsed &&
    Array.isArray((parsed as { errors?: unknown }).errors) &&
    (parsed as { errors: GraphQLError[] }).errors.length > 0
  ) {
    const first = (parsed as { errors: GraphQLError[] }).errors[0];
    throw new Error(first?.message ?? "Linear GraphQL error");
  }
  return (parsed as { data: T }).data;
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

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  priorityLabel
  estimate
  createdAt
  updatedAt
  completedAt
  dueDate
  state { id name type color }
  assignee { id name email displayName }
  creator { id name displayName }
  team { id key name }
  project { id name }
  labels { nodes { id name color } }
`;

export const linearProvider: IntegrationProvider = {
  catalog: {
    provider: "linear",
    name: "Linear",
    category: "Developer",
    tagline: "Issues, projects, teams, comments.",
    description:
      "Connect a Linear workspace so AI employees can search issues, file new ones, comment, and walk projects. Uses a personal API key — create one at linear.app/settings/api. The connection inherits the key owner's permissions, so use a service account if you don't want employees acting as you.",
    icon: "Workflow",
    authMode: "apikey",
    fields: [
      {
        key: "apiKey",
        label: "Personal API key",
        type: "password",
        placeholder: "lin_api_…",
        required: true,
        hint: "Create at linear.app/settings/api. Treat the key like a password.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "get_viewer",
      description:
        "Return the Linear user this connection is authenticated as, with their organization.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_teams",
      description: "List teams in the workspace, most recent first.",
      inputSchema: {
        type: "object",
        properties: {
          first: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max teams to return (1-100, default 50).",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "list_issues",
      description:
        "List issues. Optional `teamId`, `assigneeId`, `stateType` (`triage|backlog|unstarted|started|completed|canceled`), or `projectId` filters.",
      inputSchema: {
        type: "object",
        properties: {
          first: { type: "integer", minimum: 1, maximum: 100 },
          teamId: { type: "string" },
          assigneeId: { type: "string", description: "User id, or `me` for the viewer." },
          stateType: {
            type: "string",
            enum: ["triage", "backlog", "unstarted", "started", "completed", "canceled"],
          },
          projectId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "search_issues",
      description:
        "Full-text search issues by title and description. Returns up to `first` matches.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search string." },
          first: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_issue",
      description: "Fetch one issue by id or by `identifier` (e.g. `ENG-123`).",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Issue UUID or human identifier like `ENG-123`.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "create_issue",
      description:
        "Create a new issue. `teamId` is required; `description` accepts Markdown.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string" },
          title: { type: "string" },
          description: { type: "string", description: "Markdown body." },
          assigneeId: { type: "string" },
          stateId: { type: "string", description: "Workflow state id." },
          priority: {
            type: "integer",
            minimum: 0,
            maximum: 4,
            description: "0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low.",
          },
          projectId: { type: "string" },
          labelIds: { type: "array", items: { type: "string" } },
        },
        required: ["teamId", "title"],
        additionalProperties: false,
      },
    },
    {
      name: "update_issue",
      description:
        "Update fields on an existing issue. Pass at least one of the optional fields.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Issue UUID (not the identifier)." },
          title: { type: "string" },
          description: { type: "string" },
          assigneeId: { type: "string" },
          stateId: { type: "string" },
          priority: { type: "integer", minimum: 0, maximum: 4 },
          projectId: { type: "string" },
          labelIds: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "list_issue_comments",
      description: "List comments on an issue, oldest first.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue UUID." },
          first: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["issueId"],
        additionalProperties: false,
      },
    },
    {
      name: "create_comment",
      description: "Comment on an issue. `body` accepts Markdown.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          body: { type: "string" },
        },
        required: ["issueId", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "list_projects",
      description: "List projects, most recent first.",
      inputSchema: {
        type: "object",
        properties: {
          first: { type: "integer", minimum: 1, maximum: 100 },
          teamId: { type: "string", description: "Restrict to one team." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "list_users",
      description: "List workspace members.",
      inputSchema: {
        type: "object",
        properties: {
          first: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "graphql",
      description:
        "Escape hatch — run a raw GraphQL query against Linear's API. Use this for anything the curated tools don't cover.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "GraphQL document." },
          variables: {
            type: "object",
            description: "Variables object. Optional.",
            additionalProperties: true,
            properties: {},
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("API key is required");
    const data = await linearGraphql<{
      viewer: {
        id: string;
        name?: string;
        email?: string;
        displayName?: string;
        organization?: { id?: string; name?: string; urlKey?: string };
      };
    }>(
      apiKey,
      `query Viewer {
        viewer {
          id
          name
          email
          displayName
          organization { id name urlKey }
        }
      }`,
    );
    const viewer = data?.viewer;
    if (!viewer?.id) {
      throw new Error("Linear returned no viewer — key may be invalid.");
    }
    const org = viewer.organization;
    const config: LinearConfig = {
      apiKey,
      userId: viewer.id,
      userName: viewer.displayName ?? viewer.name,
      userEmail: viewer.email,
      organizationId: org?.id,
      organizationName: org?.name,
      organizationUrlKey: org?.urlKey,
    };
    const display = org?.name
      ? `${org.name} · ${viewer.displayName ?? viewer.name ?? viewer.email ?? viewer.id}`
      : (viewer.displayName ?? viewer.name ?? viewer.email ?? viewer.id);
    const accountHint = `${display} · ${maskSecret(apiKey)}`;
    return { config, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as LinearConfig;
    try {
      await linearGraphql<{ viewer: { id: string } }>(
        cfg.apiKey,
        `query { viewer { id } }`,
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as LinearConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_viewer":
        return linearGraphql(
          cfg.apiKey,
          `query {
            viewer {
              id
              name
              email
              displayName
              admin
              organization { id name urlKey }
            }
          }`,
        );

      case "list_teams": {
        const first = clampInt(a.first, 1, 100, 50);
        return linearGraphql(
          cfg.apiKey,
          `query Teams($first: Int!) {
            teams(first: $first) {
              nodes { id key name description createdAt }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first },
        );
      }

      case "list_issues": {
        const first = clampInt(a.first, 1, 100, 25);
        const filter: Record<string, unknown> = {};
        if (typeof a.teamId === "string" && a.teamId.trim())
          filter.team = { id: { eq: a.teamId.trim() } };
        if (typeof a.assigneeId === "string" && a.assigneeId.trim()) {
          filter.assignee =
            a.assigneeId.trim() === "me"
              ? { isMe: { eq: true } }
              : { id: { eq: a.assigneeId.trim() } };
        }
        if (typeof a.stateType === "string" && a.stateType.trim())
          filter.state = { type: { eq: a.stateType.trim() } };
        if (typeof a.projectId === "string" && a.projectId.trim())
          filter.project = { id: { eq: a.projectId.trim() } };
        return linearGraphql(
          cfg.apiKey,
          `query Issues($first: Int!, $filter: IssueFilter) {
            issues(first: $first, filter: $filter) {
              nodes { ${ISSUE_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first, filter: Object.keys(filter).length ? filter : undefined },
        );
      }

      case "search_issues": {
        const query = requireString(a.query, "query");
        const first = clampInt(a.first, 1, 50, 25);
        return linearGraphql(
          cfg.apiKey,
          `query Search($query: String!, $first: Int!) {
            searchIssues(term: $query, first: $first) {
              nodes { ${ISSUE_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { query, first },
        );
      }

      case "get_issue": {
        const id = requireString(a.id, "id");
        return linearGraphql(
          cfg.apiKey,
          `query Issue($id: String!) {
            issue(id: $id) { ${ISSUE_FIELDS} }
          }`,
          { id },
        );
      }

      case "create_issue": {
        const teamId = requireString(a.teamId, "teamId");
        const title = requireString(a.title, "title");
        const input: Record<string, unknown> = { teamId, title };
        if (typeof a.description === "string") input.description = a.description;
        if (typeof a.assigneeId === "string" && a.assigneeId.trim())
          input.assigneeId = a.assigneeId.trim();
        if (typeof a.stateId === "string" && a.stateId.trim())
          input.stateId = a.stateId.trim();
        if (typeof a.priority === "number") input.priority = clampInt(a.priority, 0, 4, 0);
        if (typeof a.projectId === "string" && a.projectId.trim())
          input.projectId = a.projectId.trim();
        if (Array.isArray(a.labelIds)) input.labelIds = a.labelIds;
        return linearGraphql(
          cfg.apiKey,
          `mutation Create($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { ${ISSUE_FIELDS} }
            }
          }`,
          { input },
        );
      }

      case "update_issue": {
        const id = requireString(a.id, "id");
        const input: Record<string, unknown> = {};
        if (typeof a.title === "string") input.title = a.title;
        if (typeof a.description === "string") input.description = a.description;
        if (typeof a.assigneeId === "string") input.assigneeId = a.assigneeId;
        if (typeof a.stateId === "string") input.stateId = a.stateId;
        if (typeof a.priority === "number") input.priority = clampInt(a.priority, 0, 4, 0);
        if (typeof a.projectId === "string") input.projectId = a.projectId;
        if (Array.isArray(a.labelIds)) input.labelIds = a.labelIds;
        if (Object.keys(input).length === 0) {
          throw new Error("Pass at least one field to update_issue");
        }
        return linearGraphql(
          cfg.apiKey,
          `mutation Update($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
              issue { ${ISSUE_FIELDS} }
            }
          }`,
          { id, input },
        );
      }

      case "list_issue_comments": {
        const issueId = requireString(a.issueId, "issueId");
        const first = clampInt(a.first, 1, 100, 50);
        return linearGraphql(
          cfg.apiKey,
          `query Comments($id: String!, $first: Int!) {
            issue(id: $id) {
              comments(first: $first) {
                nodes {
                  id
                  body
                  createdAt
                  updatedAt
                  user { id name displayName email }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
          { id: issueId, first },
        );
      }

      case "create_comment": {
        const issueId = requireString(a.issueId, "issueId");
        const body = requireString(a.body, "body");
        return linearGraphql(
          cfg.apiKey,
          `mutation Comment($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              success
              comment { id body createdAt url user { id name } }
            }
          }`,
          { input: { issueId, body } },
        );
      }

      case "list_projects": {
        const first = clampInt(a.first, 1, 100, 50);
        if (typeof a.teamId === "string" && a.teamId.trim()) {
          return linearGraphql(
            cfg.apiKey,
            `query TeamProjects($id: String!, $first: Int!) {
              team(id: $id) {
                projects(first: $first) {
                  nodes { id name description state startDate targetDate progress url }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }`,
            { id: a.teamId.trim(), first },
          );
        }
        return linearGraphql(
          cfg.apiKey,
          `query Projects($first: Int!) {
            projects(first: $first) {
              nodes { id name description state startDate targetDate progress url }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first },
        );
      }

      case "list_users": {
        const first = clampInt(a.first, 1, 100, 50);
        return linearGraphql(
          cfg.apiKey,
          `query Users($first: Int!) {
            users(first: $first) {
              nodes { id name displayName email active admin }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { first },
        );
      }

      case "graphql": {
        const query = requireString(a.query, "query");
        const variables =
          a.variables && typeof a.variables === "object"
            ? (a.variables as Record<string, unknown>)
            : undefined;
        return linearGraphql(cfg.apiKey, query, variables);
      }

      default:
        throw new Error(`Unknown Linear tool: ${name}`);
    }
  },
};
