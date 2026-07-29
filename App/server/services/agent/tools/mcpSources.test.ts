import assert from "node:assert/strict";
import test from "node:test";
import { userStdioMcpAvailableFor } from "./mcpSources.js";

test("user stdio MCP is omitted anywhere subscription credentials can be active", () => {
  assert.equal(
    userStdioMcpAvailableFor({
      multiTenant: false,
      codingToolsExecutionMode: "bubblewrap",
    }),
    false,
  );
  assert.equal(
    userStdioMcpAvailableFor({
      multiTenant: true,
      codingToolsExecutionMode: "host",
    }),
    false,
  );
  assert.equal(
    userStdioMcpAvailableFor({
      multiTenant: false,
      codingToolsExecutionMode: "host",
    }),
    true,
  );
});
