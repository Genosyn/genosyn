import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "../../../db/entities/McpServer.js";
import { specForMcpServerRow, userStdioMcpAvailableFor } from "./mcpSources.js";

test("user stdio MCP is omitted anywhere subscription credentials can be active", () => {
  for (const multiTenant of [false, true]) {
    for (const codingToolsExecutionMode of ["disabled", "host", "bubblewrap"] as const) {
      assert.equal(
        userStdioMcpAvailableFor({ multiTenant, codingToolsExecutionMode }),
        !multiTenant && codingToolsExecutionMode === "host",
        `${multiTenant ? "multi-tenant" : "self-hosted"}/${codingToolsExecutionMode}`,
      );
    }
  }
});

test("safe disabled mode keeps HTTP MCP while omitting same-UID stdio children", () => {
  const http = specForMcpServerRow({
    transport: "http",
    url: "https://mcp.example.test/rpc",
  } as McpServer);
  assert.deepEqual(http, { transport: "http", url: "https://mcp.example.test/rpc" });

  const stdio = specForMcpServerRow({
    transport: "stdio",
    command: "/usr/bin/example-mcp",
    argsJson: "[]",
    envJson: "{}",
  } as McpServer);
  assert.equal(stdio, null);
});
