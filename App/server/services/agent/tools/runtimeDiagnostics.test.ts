import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeDiagnostics } from "./runtimeDiagnostics.js";
import { buildRegistry } from "./toolRegistry.js";
import type { AgentTool } from "../types.js";

function setup() {
  const forwarded: unknown[] = [];
  const diagnostics = createRuntimeDiagnostics({
    runtime: "opencode",
    contextWindow: 32000,
    maxSteps: 30,
    bashTimeoutMs: 60000,
    codingMode: "host",
    nativeCoding: true,
    callbacks: { onContextUsage: (usage) => forwarded.push(usage) },
  });
  const read: AgentTool = {
    name: "read_example",
    description: "Read",
    inputSchema: {},
    readOnly: true,
    run: async () => ({ content: "not exposed by diagnostics" }),
  };
  const registry = buildRegistry({
    resident: [read],
    deferred: [diagnostics.tool],
    aliases: [],
    domains: [],
    fromSkills: [],
  });
  diagnostics.setRegistry(registry);
  return { diagnostics, registry, forwarded };
}

test("diagnostics preserve unknown measurements and distinguish registration from authorization", async () => {
  const { diagnostics } = setup();
  const result = JSON.parse(
    (await diagnostics.tool.run({ toolName: "get_runtime_diagnostics" })).content,
  );
  assert.equal(result.context.measured, false);
  assert.equal(result.context.promptTokens, null);
  assert.equal(result.context.percent, null);
  assert.equal(result.context.contextWindow, 32000);
  assert.equal(result.tool.visibility, "deferred");
  assert.equal(result.tool.advertised, false);
  assert.match(result.tool.authorization, /Rechecked/);
  assert.match(result.tools.coverage, /not authorization/);
  const missing = JSON.parse(
    (await diagnostics.tool.run({ toolName: "some_missing_tool" })).content,
  );
  assert.equal(missing.tool.registered, false);
  assert.equal(missing.tool.visibility, null);
});

test("diagnostics observe live callbacks and post-trim tool counts without copying raw errors", async () => {
  const { diagnostics, registry, forwarded } = setup();
  const usage = { promptTokens: 8000, contextWindow: 32000, percent: 25 };
  diagnostics.callbacks.onContextUsage!(usage);
  diagnostics.callbacks.onModelRetry!({
    attempt: 2,
    maxAttempts: 3,
    delayMs: 1000,
    reason: "credential-do-not-copy",
  });
  diagnostics.callbacks.onCompact!({ evicted: 5, freedTokens: 12000, reason: "budget" });
  diagnostics.callbacks.onToolsTrimmed!({ offered: 2, limit: 1, dropped: ["private-name"] });
  registry.resident = [];
  const result = await diagnostics.tool.run({ toolName: "read_example" });
  const body = JSON.parse(result.content);
  assert.equal(body.context.percent, 25);
  assert.equal(body.tools.advertised, 0);
  assert.equal(body.tool.advertised, false);
  assert.equal(body.tool.registered, true);
  assert.equal(body.observed.retries, 1);
  assert.equal(body.observed.compactions, 1);
  assert.equal(body.observed.trimmedTools, 1);
  assert.equal(body.observed.lastCompaction.reason, "budget");
  assert.equal(body.observed.lastRetry.attempt, 2);
  assert.ok(body.context.observedAt);
  assert.deepEqual(forwarded, [usage]);
  assert.doesNotMatch(
    result.content,
    /credential-do-not-copy|private-name|not exposed by diagnostics/,
  );
});

test("diagnostics validate input and do not share observations between turns", async () => {
  const first = setup().diagnostics;
  const second = setup().diagnostics;
  first.callbacks.onContextUsage!({ promptTokens: 100, contextWindow: null, percent: null });
  assert.equal(JSON.parse((await second.tool.run({})).content).context.promptTokens, null);
  assert.equal((await first.tool.run({ toolName: 1 })).isError, true);
  assert.equal((await first.tool.run({ environment: true })).isError, true);
});
