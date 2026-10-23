/**
 * What Settings → API keys tells someone connecting an MCP client to the
 * Genosyn MCP server: the endpoint's address, and the setup each client takes,
 * ready to paste.
 *
 * Every client authenticates the same way — an API key as a Bearer token —
 * and differs only in where the URL and that header go: Claude Desktop reaches
 * a remote server through the `mcp-remote` bridge, Claude Code takes one
 * command, Cursor a JSON entry, and anything else a plain HTTP POST. The setup
 * is built with the company's real endpoint and, right after a key is
 * generated, the real key; otherwise a placeholder stands in for it.
 */

import { companyApiBaseUrl } from "./apiAccess";

export type McpClientId = "claude-desktop" | "claude-code" | "cursor" | "http";

export const MCP_CLIENTS: ReadonlyArray<{ id: McpClientId; label: string }> = [
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "http", label: "Other clients" },
];

/** Stands in for a key in setup shown before one is generated. */
export const API_KEY_PLACEHOLDER = "gen_YOUR_API_KEY";

/** The name each client lists the server under; its tools appear as `genosyn`'s. */
export const MCP_SERVER_NAME = "genosyn";

/** `https://host/api/companies/<id>/mcp`: the Genosyn MCP server for one company. */
export function companyMcpUrl(origin: string, companyId: string): string {
  return `${companyApiBaseUrl(origin, companyId)}/mcp`;
}

export type McpClientSetup = {
  /** The language the snippet is in, for its label. */
  language: "json" | "bash";
  /** Where the snippet goes, in a few words. */
  where: string;
  snippet: string;
  /** One more sentence the client needs. */
  note: string;
};

/** The setup for one client, with `token` in place of the placeholder when there is one. */
export function mcpClientSetup(
  client: McpClientId,
  options: { url: string; token?: string | null },
): McpClientSetup {
  const token = options.token?.trim() || API_KEY_PLACEHOLDER;
  const bearer = `Bearer ${token}`;
  switch (client) {
    case "claude-desktop":
      return {
        language: "json",
        where: "claude_desktop_config.json",
        snippet: json({
          mcpServers: {
            [MCP_SERVER_NAME]: {
              command: "npx",
              args: ["-y", "mcp-remote", options.url, "--header", "Authorization:${GENOSYN_AUTH}"],
              env: { GENOSYN_AUTH: bearer },
            },
          },
        }),
        note: "Open Settings → Developer → Edit Config, add this to the file, and restart Claude Desktop. It runs the mcp-remote bridge through npx, so Node.js must be installed.",
      };
    case "claude-code":
      return {
        language: "bash",
        where: "your terminal",
        snippet:
          `claude mcp add --transport http ${MCP_SERVER_NAME} ${options.url} \\\n` +
          `  --header "Authorization: ${bearer}"`,
        note: "Add --scope user to use it in every project. claude mcp list shows whether it connected.",
      };
    case "cursor":
      return {
        language: "json",
        where: "~/.cursor/mcp.json",
        snippet: json({
          mcpServers: {
            [MCP_SERVER_NAME]: { url: options.url, headers: { Authorization: bearer } },
          },
        }),
        note: "Or .cursor/mcp.json in one project. Cursor picks the server up once the file is saved, and lists it in its MCP settings.",
      };
    case "http":
      return {
        language: "bash",
        where: "any Streamable HTTP client",
        snippet:
          `curl -X POST ${options.url} \\\n` +
          `  -H "Authorization: ${bearer}" \\\n` +
          `  -H "Content-Type: application/json" \\\n` +
          `  -H "Accept: application/json, text/event-stream" \\\n` +
          `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
        note: "Point any MCP client that speaks Streamable HTTP at the URL with the key as a Bearer token. The server is stateless — no session to keep — and answers with JSON.",
      };
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
