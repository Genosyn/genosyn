import { z } from "zod";
import { defaultSecurity, registry } from "./registry.js";

/**
 * The Streamable HTTP MCP endpoint — an AI Employee's built-in `genosyn`
 * tools, reachable by any MCP client with an API key. Its body is JSON-RPC
 * rather than a zod-validated resource, so the router cannot describe it; this
 * page does. Access comes from the router like every other operation.
 */

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
