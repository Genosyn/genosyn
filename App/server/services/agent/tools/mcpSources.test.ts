import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../../../../config.js";
import type { McpServer } from "../../../db/entities/McpServer.js";
import { specForMcpServerRow, userStdioMcpAvailableFor } from "./mcpSources.js";

test("user stdio MCP is available only in trusted single-tenant host mode", () => {
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

test("MCP transport resolution honors the configured execution and tenant modes", () => {
  const http = {
    transport: "http",
    url: "https://mcp.example.test/rpc",
  } as McpServer;
  const stdio = {
    transport: "stdio",
    command: "/usr/bin/example-mcp",
    argsJson: "[]",
    envJson: "{}",
  } as McpServer;
  const originalMultiTenant = config.security.multiTenant;
  const originalExecutionMode = config.agent.codingTools.executionMode;
  try {
    for (const multiTenant of [false, true]) {
      Object.assign(config.security, { multiTenant });
      for (const executionMode of ["disabled", "host", "bubblewrap"] as const) {
        Object.assign(config.agent.codingTools, { executionMode });
        assert.deepEqual(specForMcpServerRow(http), {
          transport: "http",
          url: "https://mcp.example.test/rpc",
        });
        assert.deepEqual(
          specForMcpServerRow(stdio),
          !multiTenant && executionMode === "host"
            ? { transport: "stdio", command: "/usr/bin/example-mcp", args: [], env: {} }
            : null,
          `${multiTenant ? "multi-tenant" : "self-hosted"}/${executionMode}`,
        );
      }
    }
  } finally {
    Object.assign(config.security, { multiTenant: originalMultiTenant });
    Object.assign(config.agent.codingTools, { executionMode: originalExecutionMode });
  }
});
