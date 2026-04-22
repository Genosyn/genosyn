#!/usr/bin/env node
// @ts-check
/*
 * Built-in Genosyn MCP server.
 *
 * Spawned by the provider CLI (claude / codex / opencode) as a stdio MCP
 * server. Every tool call is proxied back to the main Genosyn Express server
 * over HTTP, using the short-lived Bearer token we stamped into the env when
 * we materialized `.mcp.json` for this employee.
 *
 * Kept as a dependency-free `.mjs` on purpose: the binary is a child of a
 * child of Node, and asking it to boot tsx or pull in TypeORM just to send a
 * POST would be slow and fragile. We speak MCP + JSON-RPC directly.
 *
 * Protocol surface implemented:
 *   - initialize
 *   - notifications/initialized  (ignored)
 *   - tools/list
 *   - tools/call
 * Anything else gets a "method not found" response.
 */

import readline from "node:readline";

const API_BASE = process.env.GENOSYN_MCP_API ?? "";
const TOKEN = process.env.GENOSYN_MCP_TOKEN ?? "";

if (!API_BASE || !TOKEN) {
  // Abort cleanly so the CLI sees a dead MCP server rather than a hang.
  process.stderr.write(
    "[genosyn-mcp] missing GENOSYN_MCP_API / GENOSYN_MCP_TOKEN env\n",
  );
  process.exit(2);
}

/**
 * @typedef {{
 *   name: string;
 *   description: string;
 *   endpoint: string;
 *   inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
 * }} ToolSpec
 */

/** @type {ToolSpec[]} */
const TOOLS = [
  {
    name: "get_self",
    description:
      "Return your own employee profile (id, name, slug, role) and the company you belong to. Call this first when you need to orient yourself.",
    endpoint: "/tools/get_self",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_employees",
    description:
      "List every AI employee in this company — useful for finding a teammate to delegate work to, or to answer questions about the team.",
    endpoint: "/tools/list_employees",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_skills",
    description:
      "List the Skill playbooks attached to an AI employee. Pass `employeeSlug` to inspect a teammate; omit it to list your own.",
    endpoint: "/tools/list_skills",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: {
          type: "string",
          description: "Slug of the target employee. Defaults to yourself.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_routines",
    description:
      "List Routines (scheduled recurring AI work) for an employee. Pass `employeeSlug` to inspect a teammate; omit it to list your own.",
    endpoint: "/tools/list_routines",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: {
          type: "string",
          description: "Slug of the target employee. Defaults to yourself.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_routine",
    description:
      "Create a new Routine for an AI employee. A Routine is a recurring piece of work scheduled via a cron expression. Use this when a teammate (human or AI) asks you to set up a recurring report, check-in, or scheduled task. Genosyn deliberately uses 'Routine' — never 'Task' — for this scheduled work.",
    endpoint: "/tools/create_routine",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: {
          type: "string",
          description: "Slug of the employee who will own the routine. Defaults to yourself.",
        },
        name: {
          type: "string",
          description: "Short human-readable name, e.g. 'Weekly revenue report'.",
        },
        cronExpr: {
          type: "string",
          description:
            "5-field cron expression (minute hour day-of-month month day-of-week). Examples: '0 9 * * 1' = every Monday at 9:00, '*/15 * * * *' = every 15 minutes.",
        },
        brief: {
          type: "string",
          description:
            "Optional markdown brief describing what the routine should do on each run. If omitted a starter template is written in.",
        },
      },
      required: ["name", "cronExpr"],
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    description:
      "List every Project (task manager container) in this company. Projects hold Todos.",
    endpoint: "/tools/list_projects",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_project",
    description:
      "Create a new Project (a container for Todos). Choose a short uppercase key (e.g. 'ENG' or 'OPS') used to prefix todo numbers; the server derives one from the name if you omit it.",
    endpoint: "/tools/create_project",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name, e.g. 'Engineering'." },
        description: { type: "string", description: "One-line summary." },
        key: {
          type: "string",
          description: "Short uppercase key (1–6 chars, alphanumeric). Optional.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_todos",
    description: "List the Todos in a Project, by project slug.",
    endpoint: "/tools/list_todos",
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string", description: "Slug of the project (e.g. 'engineering')." },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_todo",
    description:
      "Add a Todo to a Project. Defaults the assignee to yourself so you can take ownership of follow-through; pass `assigneeEmployeeSlug` to delegate, or `null` to leave it unassigned. Pass `reviewerEmployeeSlug` to nominate a reviewer — when the assignee marks the todo `in_review`, that reviewer is expected to sign it off.",
    endpoint: "/tools/create_todo",
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
        },
        priority: {
          type: "string",
          enum: ["none", "low", "medium", "high", "urgent"],
        },
        assigneeEmployeeSlug: {
          type: ["string", "null"],
          description: "Slug of the assignee employee, or null to unassign.",
        },
        reviewerEmployeeSlug: {
          type: ["string", "null"],
          description:
            "Slug of the AI employee who should review this todo when it moves to in_review. Null = no reviewer yet.",
        },
        dueAt: {
          type: ["string", "null"],
          description: "Due date as an ISO-8601 timestamp, or null.",
        },
        recurrence: {
          type: "string",
          enum: ["none", "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"],
        },
      },
      required: ["projectSlug", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_todo",
    description:
      "Update a Todo by id — change status, priority, title, description, assignee, reviewer, or due date. When you finish work on a todo assigned to you, set `status: \"in_review\"` (and optionally set `reviewerEmployeeSlug`) so a reviewer can sign it off instead of marking it done yourself.",
    endpoint: "/tools/update_todo",
    inputSchema: {
      type: "object",
      properties: {
        todoId: { type: "string", description: "UUID of the todo." },
        title: { type: "string" },
        description: { type: "string" },
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
        },
        priority: {
          type: "string",
          enum: ["none", "low", "medium", "high", "urgent"],
        },
        assigneeEmployeeSlug: { type: ["string", "null"] },
        reviewerEmployeeSlug: {
          type: ["string", "null"],
          description:
            "Slug of the AI employee who should review this todo, or null to clear. Set this when you move a todo to `in_review`.",
        },
        dueAt: { type: ["string", "null"] },
      },
      required: ["todoId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_journal",
    description:
      "List recent Journal entries for an AI employee (runs, system events, and notes). Omit `employeeSlug` to list your own.",
    endpoint: "/tools/list_journal",
    inputSchema: {
      type: "object",
      properties: {
        employeeSlug: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_journal_entry",
    description:
      "Write a free-form note into your own Journal. Use this to log decisions, observations, or summaries a human might read later. The journal is an append-only feed; the last ~7 days are auto-injected into every prompt you receive, so future-you will see this.",
    endpoint: "/tools/add_journal_entry",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_memory",
    description:
      "List your own Memory items — durable facts/preferences you previously saved. These are already injected into every prompt; use this tool when you need exact ids to update or delete them.",
    endpoint: "/tools/list_memory",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_memory",
    description:
      "Save a durable fact into your own Memory so future prompts automatically recall it. Use this for preferences, stable context about teammates, conventions, or learnings that should influence every future conversation. Keep `title` under ~100 chars — it's the memory headline. `body` is optional elaboration.",
    endpoint: "/tools/add_memory",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short fact headline, e.g. 'Prefers ARR over MRR'.",
        },
        body: {
          type: "string",
          description: "Optional elaboration or reasoning.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_memory",
    description:
      "Update an existing Memory item's title or body. Use when a previously-saved fact has evolved, not for small typo fixes.",
    endpoint: "/tools/update_memory",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "UUID from list_memory." },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_memory",
    description:
      "Remove a Memory item. Use sparingly — only when the fact is definitively wrong or obsolete.",
    endpoint: "/tools/delete_memory",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_bases",
    description:
      "List every Base (Airtable-style structured data workspace) you have been granted access to. Each base contains tables; use `get_base` to inspect their schema.",
    endpoint: "/tools/list_bases",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_base",
    description:
      "Return the full schema of a Base you have access to — its tables, fields, and field types. Pass `baseSlug` from `list_bases`. Use this before reading or writing rows so you know the field ids.",
    endpoint: "/tools/get_base",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string", description: "Slug of the base (e.g. 'crm')." },
      },
      required: ["baseSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_base_rows",
    description:
      "Read rows from a table inside a Base. Returns fields, records, and link-option labels so you can reason about the data. Defaults to 100 rows; pass `limit` up to 500.",
    endpoint: "/tools/list_base_rows",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["baseSlug", "tableSlug"],
      additionalProperties: false,
    },
  },
  {
    name: "create_base_row",
    description:
      "Insert a new row into a Base table. `data` is a map from field id → value. Call `get_base` first if you need field ids. Select/multiselect values use option ids; link values are arrays of target row ids.",
    endpoint: "/tools/create_base_row",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        data: {
          type: "object",
          description: "Map from field id to cell value.",
          additionalProperties: true,
        },
      },
      required: ["baseSlug", "tableSlug", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "update_base_row",
    description:
      "Update specific cells on an existing row. `data` is a partial map from field id → value. Setting a value to null/empty clears that cell.",
    endpoint: "/tools/update_base_row",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        rowId: { type: "string", description: "UUID of the row." },
        data: { type: "object", additionalProperties: true },
      },
      required: ["baseSlug", "tableSlug", "rowId", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_base_row",
    description: "Delete a row from a Base table by id.",
    endpoint: "/tools/delete_base_row",
    inputSchema: {
      type: "object",
      properties: {
        baseSlug: { type: "string" },
        tableSlug: { type: "string" },
        rowId: { type: "string" },
      },
      required: ["baseSlug", "tableSlug", "rowId"],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Integration tools are discovered at runtime: the set depends on which
 * IntegrationConnection grants the acting employee holds, and a single
 * company can have multiple Stripe accounts with different tool name
 * prefixes. On first `tools/list` we fetch them from the server and keep
 * them in `INTEGRATION_TOOLS`, keyed by MCP tool name in
 * `INTEGRATION_BY_NAME`.
 *
 * Shape returned by the server (see mcpInternal.ts):
 *   {
 *     name: "stripe_list_customers",
 *     description: "...",
 *     inputSchema: { type: "object", ... },
 *     connectionId: "…",
 *     providerToolName: "list_customers"
 *   }
 *
 * @typedef {{
 *   name: string;
 *   description: string;
 *   inputSchema: object;
 *   connectionId: string;
 *   providerToolName: string;
 * }} IntegrationToolSpec
 */

/** @type {IntegrationToolSpec[]} */
let INTEGRATION_TOOLS = [];
/** @type {Map<string, IntegrationToolSpec>} */
let INTEGRATION_BY_NAME = new Map();
let integrationsLoaded = false;

async function loadIntegrationTools() {
  if (integrationsLoaded) return;
  integrationsLoaded = true;
  try {
    const url = API_BASE.replace(/\/+$/, "") + "/integrations/_list";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: "{}",
    });
    if (!res.ok) return;
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    INTEGRATION_TOOLS = tools.filter(
      (t) =>
        t &&
        typeof t.name === "string" &&
        typeof t.description === "string" &&
        typeof t.inputSchema === "object" &&
        typeof t.connectionId === "string" &&
        typeof t.providerToolName === "string",
    );
    INTEGRATION_BY_NAME = new Map(INTEGRATION_TOOLS.map((t) => [t.name, t]));
  } catch (err) {
    process.stderr.write(
      `[genosyn-mcp] failed to load integration tools: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

/** Minimal MCP server info. `tools` capability is all we advertise. */
const SERVER_INFO = {
  name: "genosyn",
  version: "0.1.0",
};
const CAPABILITIES = {
  tools: {},
};

/**
 * Dispatch an incoming JSON-RPC message. Responses go through `send`; notifs
 * (id-less) produce nothing.
 *
 * @param {any} msg
 * @param {(response: any) => void} send
 */
async function handle(msg, send) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  if (method === undefined) return; // response from peer — we don't initiate

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") {
      return; // handshake-complete notification, no reply
    }
    if (method === "tools/list") {
      await loadIntegrationTools();
      const staticTools = TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      const integrationTools = INTEGRATION_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      send({
        jsonrpc: "2.0",
        id,
        result: { tools: staticTools.concat(integrationTools) },
      });
      return;
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== "string") {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name" },
        });
        return;
      }
      const staticTool = TOOL_BY_NAME.get(name);
      if (staticTool) {
        const result = await callGenosyn(staticTool.endpoint, args);
        send({ jsonrpc: "2.0", id, result });
        return;
      }
      await loadIntegrationTools();
      const integrationTool = INTEGRATION_BY_NAME.get(name);
      if (integrationTool) {
        const result = await callGenosyn("/integrations/invoke", {
          connectionId: integrationTool.connectionId,
          toolName: integrationTool.providerToolName,
          args,
        });
        send({ jsonrpc: "2.0", id, result });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      });
      return;
    }
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}

/**
 * POST tool arguments to the Genosyn internal API and wrap the reply in the
 * MCP tool-call result shape. Errors — network, HTTP !=2xx, JSON parse — are
 * returned as `isError: true` content so the model sees the failure instead
 * of a silent hang.
 *
 * @param {string} endpoint
 * @param {any} args
 */
async function callGenosyn(endpoint, args) {
  const url = API_BASE.replace(/\/+$/, "") + endpoint;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(args ?? {}),
    });
  } catch (err) {
    return toolError(
      `Could not reach Genosyn API at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return toolError(
      `Genosyn API returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  if (!response.ok) {
    const detail =
      (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) ||
      `HTTP ${response.status}`;
    return toolError(
      typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
    );
  }

  return {
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
  };
}

/**
 * Shape an MCP "something went wrong" result. We keep `isError: true` so a
 * well-behaved host (Claude Code, Codex, etc.) surfaces the text to the model
 * as an error rather than a successful reply.
 *
 * @param {string} message
 */
function toolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// ---------- stdio framing ----------

/** MCP stdio framing is newline-delimited JSON (one message per line). */
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`[genosyn-mcp] ignored non-JSON line: ${trimmed.slice(0, 200)}\n`);
    return;
  }
  handle(msg, write).catch((err) => {
    process.stderr.write(
      `[genosyn-mcp] dispatch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
});

rl.on("close", () => {
  process.exit(0);
});

/**
 * Write a single JSON-RPC response frame. Wrap in try/catch so a slow peer
 * or closed pipe doesn't crash the server while a reply is in flight.
 *
 * @param {any} obj
 */
function write(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    process.stderr.write(
      `[genosyn-mcp] failed to write response: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}
