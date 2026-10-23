import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { appVersion } from "../../lib/version.js";
import { logRedactedError } from "../../middleware/error.js";
import { operationCatalogue } from "./appCatalogue.js";
import { availabilityFor } from "./catalogue.js";
import type { CallerContext } from "./context.js";
import { callMistake } from "./results.js";
import { RESIDENT_TOOLS, RESIDENT_TOOLS_BY_NAME, toolDefinition } from "./tools.js";

/**
 * The Genosyn MCP server for one request.
 *
 * The endpoint is stateless — every POST is authenticated on its own and gets
 * a fresh server — so nothing about one caller can reach another, and any
 * replica can answer. The server lists the resident tools and runs them with
 * the caller's context; the instructions it sends on `initialize` say whose
 * authority it carries and how to find an operation.
 */

export const SERVER_INFO = {
  name: "genosyn",
  title: "Genosyn",
};

/** What a client's model reads about this server before its first call. */
export function instructionsFor(context: CallerContext): string {
  const catalogue = operationCatalogue(context.app);
  const available = catalogue.operations.filter(
    (operation) => availabilityFor(operation, context.standing).available,
  ).length;
  const role = context.standing.role === "member" ? "a member" : `an ${context.standing.role}`;
  const finance =
    context.standing.financeAccess === "full"
      ? "full Finance access"
      : context.standing.financeAccess === "read"
        ? "read-only Finance access"
        : "no Finance access";
  return [
    `Genosyn is where ${context.companyName} is run with AI Employees. This server acts as ${context.member.name} — ${role} of ${context.companyName} with ${finance} — through their API key "${context.apiKey.name}". It can do what they can through Genosyn's REST API: ${available} of ${catalogue.operations.length} operations, in ${catalogue.areas.length} areas.`,
    "To act: search_operations finds an operation by what you want to do, or lists the areas; describe_operation shows one operation's inputs; call_read_operation, call_write_operation and call_delete_operation call it by its operationId. whoami says whose authority you carry.",
    "Every call runs through Genosyn's own checks: role and Finance limits apply, operations that need a person at a signed-in browser are not offered, and every change is recorded in the audit log under this Member. Read before you change something, and confirm deletions with the person you work for.",
  ].join("\n\n");
}

export function createCompanyMcpServer(context: CallerContext): Server {
  const server = new Server(
    { ...SERVER_INFO, version: appVersion() },
    { capabilities: { tools: {} }, instructions: instructionsFor(context) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: RESIDENT_TOOLS.map(toolDefinition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = RESIDENT_TOOLS_BY_NAME.get(request.params.name);
    if (!tool) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown tool "${request.params.name}". This server's tools are ${RESIDENT_TOOLS.map((candidate) => candidate.name).join(", ")}; operations are called through call_read_operation, call_write_operation and call_delete_operation.`,
      );
    }
    try {
      return await tool.run(context, request.params.arguments ?? {}, extra.signal);
    } catch (error) {
      logRedactedError(`[mcp] ${tool.name} failed`, error);
      return callMistake(
        `${tool.name} failed inside Genosyn before it could answer. Try again; if it keeps failing, check the server log.`,
      );
    }
  });
  return server;
}
