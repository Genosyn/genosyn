#!/usr/bin/env node
// @ts-check
/*
 * Built-in Genosyn MCP server (stdio transport).
 *
 * Spawned by the provider CLI (claude / codex / opencode / goose / openclaw)
 * as a stdio MCP server. Every tool call is proxied back to the main Genosyn
 * Express server over HTTP, using the short-lived Bearer token we stamped into
 * the env when we materialized the provider's MCP config for this employee.
 *
 * Kept as a dependency-free `.mjs` on purpose: the binary is a child of a
 * child of Node, and asking it to boot tsx or pull in TypeORM just to send a
 * POST would be slow and fragile. We speak MCP + JSON-RPC directly.
 *
 * The tool catalogue is NOT hardcoded here. It is fetched once from
 * `POST {API_BASE}/manifest` (see `routes/mcpInternal.ts` +
 * `mcp/toolManifest.ts`) so there is a single source of truth shared with the
 * external Streamable-HTTP endpoint. Integration-backed tools are discovered
 * per-employee via `POST {API_BASE}/integrations/_list`.
 *
 * Protocol surface implemented:
 *   - initialize
 *   - notifications/initialized  (ignored)
 *   - ping
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
 *   inputSchema: object;
 * }} ToolSpec
 */

/**
 * The static tool catalogue, fetched from the server on first use. The
 * server-side handler for each tool lives at `POST {API_BASE}/tools/<name>`,
 * so the endpoint is always derived from the name — nothing tool-specific is
 * hardcoded in this binary any more.
 *
 * @type {ToolSpec[]}
 */
let STATIC_TOOLS = [];
/** @type {Set<string>} */
let STATIC_NAMES = new Set();
let manifestLoaded = false;
/** @type {Promise<void> | null} */
let manifestPromise = null;

/**
 * Fetch the tool catalogue once. Concurrent callers share a single in-flight
 * request (so a burst of messages before the first `tools/list` completes
 * doesn't fire N fetches, and a `tools/call` never races ahead of a
 * half-populated catalogue). Only success latches; a transient failure clears
 * the promise so the next call retries instead of caching an empty list.
 */
async function loadManifest() {
  if (manifestLoaded) return;
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        const parsed = await postJson("/manifest", {});
        const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
        STATIC_TOOLS = tools.filter(
          (t) =>
            t &&
            typeof t.name === "string" &&
            typeof t.description === "string" &&
            typeof t.inputSchema === "object",
        );
        STATIC_NAMES = new Set(STATIC_TOOLS.map((t) => t.name));
        manifestLoaded = true;
      } catch (err) {
        process.stderr.write(
          `[genosyn-mcp] failed to load tool manifest: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      } finally {
        manifestPromise = null;
      }
    })();
  }
  return manifestPromise;
}

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
/** @type {Promise<void> | null} */
let integrationsPromise = null;

async function loadIntegrationTools() {
  if (integrationsLoaded) return;
  if (!integrationsPromise) {
    integrationsPromise = (async () => {
      try {
        const parsed = await postJson("/integrations/_list", {});
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
        integrationsLoaded = true;
      } catch (err) {
        process.stderr.write(
          `[genosyn-mcp] failed to load integration tools: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      } finally {
        integrationsPromise = null;
      }
    })();
  }
  return integrationsPromise;
}

/** Minimal MCP server info. `tools` capability is all we advertise. */
const SERVER_INFO = {
  name: "genosyn",
  version: process.env.GENOSYN_MCP_VERSION || "1.0.0",
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
    if (method === "ping") {
      // MCP health check — an empty result is the whole contract.
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      await Promise.all([loadManifest(), loadIntegrationTools()]);
      const staticTools = STATIC_TOOLS.map((t) => ({
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
      await loadManifest();
      if (STATIC_NAMES.has(name)) {
        const result = await callGenosyn(`/tools/${name}`, args);
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
 * POST a JSON body to the Genosyn internal API and return the parsed JSON.
 * Throws on network failure, non-2xx, or invalid JSON. Used for the control
 * surfaces (manifest / integration list) where we want a hard failure the
 * caller can log rather than an MCP tool-result wrapper.
 *
 * @param {string} endpoint
 * @param {any} body
 * @returns {Promise<any>}
 */
async function postJson(endpoint, body) {
  const url = API_BASE.replace(/\/+$/, "") + endpoint;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
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
