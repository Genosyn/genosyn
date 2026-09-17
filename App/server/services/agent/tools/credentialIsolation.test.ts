import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTool } from "../types.js";
import { filterCodingToolsForExecutionMode } from "./index.js";
import { codingTools } from "./coding.js";

const tools = [{ name: "bash" }, { name: "read_file" }] as AgentTool[];

test("host deployments expose the Codex shell and file adapters", () => {
  assert.deepEqual(
    filterCodingToolsForExecutionMode(tools, "host").map((tool) => tool.name),
    ["bash", "read_file"],
  );
});

test("the default host surface runs a command through the Codex subscription adapter", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-host-codex-tool-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const available = filterCodingToolsForExecutionMode(
    codingTools({ cwd, env: {}, bashTimeoutMs: 10_000 }),
  );
  const bash = available.find((tool) => tool.name === "bash");
  assert.ok(bash, "host coding must include the shell without bubblewrap");
  const result = await bash.run({ command: "printf 'host coding works'" });
  assert.equal(result.isError, false);
  assert.equal(result.content, "host coding works");
});

test("optional bubblewrap keeps every coding operation inside its namespace", () => {
  assert.deepEqual(
    filterCodingToolsForExecutionMode(tools, "bubblewrap").map((tool) => tool.name),
    ["bash"],
  );
});

test("disabled installations omit all coding adapters", () => {
  assert.deepEqual(
    filterCodingToolsForExecutionMode(tools, "disabled").map((tool) => tool.name),
    [],
  );
});
