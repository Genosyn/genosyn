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
  assert.ok(bash, "host coding must include the shell");
  const result = await bash.run({ command: "printf 'host coding works'" });
  assert.equal(result.isError, false);
  assert.equal(result.content, "host coding works");
});

test("a retired execution mode fails closed and exposes no coding adapters", () => {
  // An old config.ts or chart overlay can still say "bubblewrap" until boot
  // narrows it; anything but "host" must expose nothing.
  const retired = "bubblewrap" as unknown as Parameters<
    typeof filterCodingToolsForExecutionMode
  >[1];
  assert.deepEqual(
    filterCodingToolsForExecutionMode(tools, retired).map((tool) => tool.name),
    [],
  );
});

test("disabled installations omit all coding adapters", () => {
  assert.deepEqual(
    filterCodingToolsForExecutionMode(tools, "disabled").map((tool) => tool.name),
    [],
  );
});
