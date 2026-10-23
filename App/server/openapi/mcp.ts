import { z } from "zod";
import { defaultSecurity, registry } from "./registry.js";

/**
 * The Streamable HTTP MCP endpoints: the Genosyn MCP server for the whole
 * company, and an AI Employee's built-in `genosyn` tools, each reachable by any
 * MCP client with an API key. Their bodies are JSON-RPC rather than a
 * zod-validated resource, so the router cannot describe them; these pages do.
 * Access comes from the router like every other operation.
 */

const companyParam = z.object({
  cid: z.string().uuid().describe("The company id. The API key must be one minted for it."),
});

const cidEid = z.object({
  cid: z.string().uuid().describe("The company id."),
  eid: z.string().uuid().describe("The AI Employee whose tools the client uses."),
});

const JsonRpcMessage = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional().describe("Absent on a notification."),
    method: z
      .string()
      .describe("`initialize`, `tools/list`, `tools/call`, `ping`, or a notification."),
    params: z.record(z.unknown()).optional(),
  })
  .openapi("JsonRpcMessage");

const JsonRpcResponse = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).nullable(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .optional(),
  })
  .openapi("JsonRpcResponse");

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/mcp",
  operationId: "sendCompanyMcpMessage",
  summary: "Send MCP messages to the Genosyn MCP server",
  description:
    "The Genosyn MCP server: every operation in this reference that an API key may call, offered " +
    "to any MCP client (Claude Desktop, Claude Code, Cursor, n8n, your own agent) over the Streamable " +
    "HTTP transport of the Model Context Protocol. POST one JSON-RPC message, or a batch of up to 20, " +
    "and read the reply as JSON. The server is stateless: it issues no session id and pushes nothing, " +
    "so every POST stands alone.\n\n" +
    "`tools/list` returns six resident tools: `whoami`, `search_operations`, `describe_operation`, and " +
    "`call_read_operation`, `call_write_operation` and `call_delete_operation`, which call an " +
    "operation by its `operationId` with its path, query and body. Each call is sent back through the " +
    "App's own router with the same key, so it acts as the key's Member, under the same role, Finance " +
    "and company limits as a REST request, and lands in the audit log the same way. Operations that " +
    "need a signed-in browser are not offered.\n\n" +
    "A request whose `Origin` is not this install's public URL is refused with 403, and the body may " +
    "be up to 10 MB so a file can travel as base64.",
  tags: ["MCP"],
  request: {
    params: companyParam,
    body: {
      required: true,
      content: {
        "application/json": { schema: z.union([JsonRpcMessage, z.array(JsonRpcMessage)]) },
      },
    },
  },
  responses: {
    200: {
      description: "The JSON-RPC reply, or an array of replies for a batch.",
      content: {
        "application/json": { schema: z.union([JsonRpcResponse, z.array(JsonRpcResponse)]) },
      },
    },
    202: { description: "The payload held only notifications, so there is nothing to reply." },
    400: { description: "The body is not JSON-RPC, or a batch holds more than 20 messages." },
    401: {
      description: "No API key, or one that is unknown, revoked, expired or for another company.",
    },
    403: {
      description:
        "A browser `Origin` other than this install's, or the key's Member is no longer in the company.",
    },
    406: { description: "`Accept` rules out JSON." },
    413: { description: "The body is larger than 10 MB." },
  },
});

for (const method of ["get", "delete"] as const) {
  registry.registerPath({
    method,
    path: "/api/companies/{cid}/mcp",
    operationId: method === "get" ? "openCompanyMcpStream" : "endCompanyMcpSession",
    summary:
      method === "get"
        ? "Open a Genosyn MCP event stream (not offered)"
        : "End a Genosyn MCP session (not offered)",
    description:
      "The Genosyn MCP server is stateless and never pushes server-initiated messages, so it " +
      "answers 405 with `Allow: POST`, as the transport specification asks of such a server.",
    tags: ["MCP"],
    request: { params: companyParam },
    responses: { 405: { description: "Only POST is accepted." } },
  });
}

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/employees/{eid}/mcp/connect",
  summary: "Send MCP messages to an AI Employee's tools",
  description:
    "The Streamable HTTP transport of the Model Context Protocol. POST one JSON-RPC message, " +
    "or an array of them, and read the reply as JSON. The server is stateless: it issues no " +
    "session id and pushes nothing, so every POST stands alone. Point any MCP client here " +
    "with an API key in the `Authorization` header to act as this AI Employee.",
  tags: ["MCP"],
  security: defaultSecurity,
  request: {
    params: cidEid,
    body: {
      required: true,
      content: {
        "application/json": { schema: z.union([JsonRpcMessage, z.array(JsonRpcMessage)]) },
      },
    },
  },
  responses: {
    200: {
      description: "The JSON-RPC reply, or an array of replies for a batch.",
      content: {
        "application/json": { schema: z.union([JsonRpcResponse, z.array(JsonRpcResponse)]) },
      },
    },
    202: { description: "The payload held only notifications, so there is nothing to reply." },
    400: { description: "An empty batch." },
    404: { description: "No such AI Employee in this company." },
  },
});

for (const method of ["get", "delete"] as const) {
  registry.registerPath({
    method,
    path: "/api/companies/{cid}/employees/{eid}/mcp/connect",
    summary:
      method === "get"
        ? "Open an MCP event stream (not offered)"
        : "End an MCP session (not offered)",
    description:
      "The endpoint is stateless and never pushes server-initiated messages, so it answers " +
      "405 with `Allow: POST, OPTIONS`, as the transport specification asks of such a server.",
    tags: ["MCP"],
    security: defaultSecurity,
    request: { params: cidEid },
    responses: { 405: { description: "Only POST is accepted." } },
  });
}
