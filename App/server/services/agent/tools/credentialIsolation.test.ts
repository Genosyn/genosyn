import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "../types.js";
import { filterCodingToolsForCredentialIsolation } from "./index.js";

const tools = [{ name: "bash" }, { name: "read_file" }] as AgentTool[];

test("bubblewrap deployments expose coding only through sandboxed bash for every turn", () => {
  assert.deepEqual(
    filterCodingToolsForCredentialIsolation(tools, true, "host").map((tool) => tool.name),
    [],
  );
  assert.deepEqual(
    filterCodingToolsForCredentialIsolation(tools, true, "bubblewrap").map((tool) => tool.name),
    ["bash"],
  );
  assert.deepEqual(
    filterCodingToolsForCredentialIsolation(tools, false, "host").map((tool) => tool.name),
    ["bash", "read_file"],
  );
  assert.deepEqual(
    filterCodingToolsForCredentialIsolation(tools, false, "bubblewrap").map((tool) => tool.name),
    ["bash"],
  );
});
