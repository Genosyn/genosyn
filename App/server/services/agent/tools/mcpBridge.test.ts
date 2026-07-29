import assert from "node:assert/strict";
import test from "node:test";
import { mcpChildEnvironment } from "./mcpBridge.js";

test("stdio MCP children inherit only runtime essentials and explicit server env", () => {
  process.env.GENOSYN_TEST_PARENT_SECRET = "do-not-inherit";
  try {
    const env = mcpChildEnvironment({ MCP_SERVER_SETTING: "explicit" });
    assert.equal(env.GENOSYN_TEST_PARENT_SECRET, undefined);
    assert.equal(env.MCP_SERVER_SETTING, "explicit");
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    delete process.env.GENOSYN_TEST_PARENT_SECRET;
  }
});
