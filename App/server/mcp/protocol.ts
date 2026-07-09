import { config } from "../../config.js";
import { appVersion } from "../lib/version.js";
import { STATIC_TOOLS } from "./toolManifest.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";

/**
 * JSON-RPC (Model Context Protocol) message handling for the built-in `genosyn`
 * server, used by the *external* Streamable-HTTP endpoint (`routes/mcpConnect.ts`)
 * so outside MCP clients (Claude Desktop, Cursor, another agent, ...) can act as
 * one of this company's employees. (The in-process agent doesn't go through this
 * — it calls the tools directly; see `services/agent/tools/genosyn.ts`.)
 *
 * This shares ONE tool catalogue (`toolManifest.ts`) and ONE set of handlers
 * (`routes/mcpInternal.ts`) with the rest of the app. Here we terminate the
 * JSON-RPC protocol and dispatch each `tools/call` back through the internal
 * HTTP surface over loopback, authenticated by a freshly-minted short-lived MCP
 * token bound to the acting employee. That keeps every tool's zod validation,
 * audit trail, and journal write in one place instead of forking a second
 * implementation.
 */

/** The newest protocol revision we implement. We echo the client's requested
 * version back on initialize when they send one, so an older client still
 * negotiates a version it understands. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const MCP_SERVER_INFO = {
  name: "genosyn",
  get version() {
    return appVersion();
  },
};

export const MCP_CAPABILITIES = { tools: {} };

/** Loopback base for the internal MCP surface — the same process, dialed over
 * 127.0.0.1 so we reuse every handler in `routes/mcpInternal.ts`. */
function internalApiBase(): string {
  return `http://127.0.0.1:${config.port}/api/internal/mcp`;
}

type JsonRpcId = string | number | null;

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type McpContext = {
  employeeId: string;
  companyId: string;
};

/**
 * Handle a batch of JSON-RPC messages for one authenticated employee. Mints a
 * single short-lived token for the whole batch, dispatches each message, then
 * revokes. Notifications (id-less requests) and peer responses produce no
 * reply, so the returned array may be shorter than the input.
 */
export async function runMcpBatch(
  messages: unknown[],
  ctx: McpContext,
): Promise<JsonRpcResponse[]> {
  const token = issueMcpToken(ctx.employeeId, ctx.companyId);
  try {
    const out: JsonRpcResponse[] = [];
    for (const msg of messages) {
      const res = await handleMessage(msg, token);
      if (res) out.push(res);
    }
    return out;
  } finally {
    // External sessions are stateless: the token exists only for the life of
    // this request. Revoking immediately keeps the in-memory token map small
    // and shrinks the blast radius if a response is somehow intercepted.
    revokeMcpToken(token);
  }
}

async function handleMessage(
  msg: unknown,
  token: string,
): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg as {
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (method === undefined) return null; // a response from the peer
  const rpcId: JsonRpcId = id ?? null;

  try {
    switch (method) {
      case "initialize": {
        const requested =
          typeof params?.protocolVersion === "string"
            ? (params.protocolVersion as string)
            : MCP_PROTOCOL_VERSION;
        return ok(rpcId, {
          protocolVersion: requested,
          capabilities: MCP_CAPABILITIES,
          serverInfo: {
            name: MCP_SERVER_INFO.name,
            version: MCP_SERVER_INFO.version,
          },
        });
      }
      case "notifications/initialized":
      case "initialized":
        return null; // handshake-complete notification — no reply
      case "ping":
        return ok(rpcId, {});
      case "tools/list": {
        const integration = await loadIntegrationTools(token);
        const tools: Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }> = [
          ...STATIC_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          ...integration.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        ];
        return ok(rpcId, { tools });
      }
      case "tools/call": {
        const name = params?.name;
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        if (typeof name !== "string") {
          return err(rpcId, -32602, "Missing tool name");
        }
        if (STATIC_NAMES.has(name)) {
          return ok(rpcId, await callInternal(token, `/tools/${name}`, args));
        }
        const integration = await loadIntegrationTools(token);
        const match = integration.find((t) => t.name === name);
        if (match) {
          return ok(
            rpcId,
            await callInternal(token, "/integrations/invoke", {
              connectionId: match.connectionId,
              toolName: match.providerToolName,
              args,
            }),
          );
        }
        return err(rpcId, -32602, `Unknown tool: ${name}`);
      }
      default:
        // Notifications (id undefined) get swallowed; requests get an error.
        if (id === undefined) return null;
        return err(rpcId, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (id === undefined) return null;
    return err(rpcId, -32000, e instanceof Error ? e.message : String(e));
  }
}

const STATIC_NAMES = new Set(STATIC_TOOLS.map((t) => t.name));

type IntegrationTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  connectionId: string;
  providerToolName: string;
};

/** Fetch the acting employee's integration-backed tools over loopback. */
async function loadIntegrationTools(token: string): Promise<IntegrationTool[]> {
  const parsed = await postInternalJson(token, "/integrations/_list", {});
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  return tools.filter(
    (t: unknown): t is IntegrationTool =>
      !!t &&
      typeof t === "object" &&
      typeof (t as IntegrationTool).name === "string" &&
      typeof (t as IntegrationTool).description === "string" &&
      typeof (t as IntegrationTool).inputSchema === "object" &&
      typeof (t as IntegrationTool).connectionId === "string" &&
      typeof (t as IntegrationTool).providerToolName === "string",
  );
}

/**
 * POST to an internal endpoint and wrap the reply in the MCP tool-call result
 * shape. Any failure (network, non-2xx, bad JSON) comes back as an
 * `isError: true` content block so the model sees the failure text instead of
 * a silent hang — mirrors `callGenosyn` in the stdio binary.
 */
async function callInternal(
  token: string,
  endpoint: string,
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  const url = internalApiBase() + endpoint;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args ?? {}),
    });
  } catch (e) {
    return toolError(
      `Could not reach Genosyn API: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return toolError(
      `Genosyn API returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error: unknown }).error
        : `HTTP ${response.status}`;
    return toolError(
      typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
    );
  }

  return {
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
  };
}

/** POST to an internal endpoint and return parsed JSON, throwing on failure.
 * Used for control surfaces (integration list) where we want a hard error. */
async function postInternalJson(
  token: string,
  endpoint: string,
  body: unknown,
): Promise<{ tools?: unknown[] } & Record<string, unknown>> {
  const url = internalApiBase() + endpoint;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function toolError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
