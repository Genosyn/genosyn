import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test, type TestContext } from "node:test";
import { config } from "../../../config.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { Company } from "../../db/entities/Company.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { issueMcpToken, revokeMcpToken } from "../mcpTokens.js";
import { resetRuntimeSettingsCacheForTests } from "../runtimeSettings.js";
import { agentRuntime } from "./runtime.js";
import {
  runEmployeeAgent,
  runRestrictedEmployeeAgent,
  type EmployeeAgentParams,
} from "./runEmployee.js";
import type { AgentTool } from "./types.js";

const previousCoding = { ...config.agent.codingTools };
const tokens: string[] = [];
let params: EmployeeAgentParams;

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  resetRuntimeSettingsCacheForTests();
  Object.assign(config.agent.codingTools, {
    enabled: true,
    executionMode: "host",
    allowUnsafeHostExecution: true,
  });
  const company = await insert(Company, {
    name: "OpenCode Co",
    slug: "opencode-co",
    ownerId: "owner",
  });
  const employee = await insert(AIEmployee, {
    name: "Avery",
    slug: "avery",
    companyId: company.id,
    role: "Engineer",
    browserEnabled: false,
  });
  const model = Object.assign(new AIModel(), {
    id: "model",
    employeeId: employee.id,
    provider: "openai",
    authMode: "apikey",
    model: "test-model",
    configJson: "{}",
    contextWindow: 32000,
  });
  const token = issueMcpToken(employee.id, company.id, { authority: "employee" });
  tokens.push(token);
  params = {
    model,
    employeeId: employee.id,
    system: "Employee instructions",
    messages: [{ role: "user", content: [{ type: "text", text: "Do the work" }] }],
    cwd: "/tmp/genosyn-runtime-test",
    toolEnv: { PROJECT_SETTING: "value" },
    genosynToken: token,
    bashTimeoutMs: 1000,
    maxSteps: 8,
  };
});
afterEach(() => {
  for (const token of tokens.splice(0)) revokeMcpToken(token);
  Object.assign(config.agent.codingTools, previousCoding);
});
after(closeTestDb);

function capture(t: TestContext) {
  const seen: Parameters<typeof agentRuntime.run>[0][] = [];
  t.mock.method(agentRuntime, "run", async (input: Parameters<typeof agentRuntime.run>[0]) => {
    seen.push(input);
    return { finalText: "Completed through OpenCode", steps: 3, stopReason: "end_turn" };
  });
  return seen;
}

test("ordinary host turns use OpenCode native coding without the retired file wrappers", async (t) => {
  const seen = capture(t);
  const result = await runEmployeeAgent(params);
  assert.deepEqual(result, {
    status: "ok",
    finalText: "Completed through OpenCode",
    steps: 3,
    stopReason: "end_turn",
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].nativeCoding, true);
  assert.equal(seen[0].cwd, params.cwd);
  assert.deepEqual(seen[0].toolEnv, params.toolEnv);
  assert.equal(seen[0].bashTimeoutMs, params.bashTimeoutMs);
  assert.equal(seen[0].model, params.model);
  assert.deepEqual(seen[0].messages, params.messages);
  for (const name of ["bash", "read_file", "write_file", "edit_file", "list_dir", "glob", "grep"]) {
    assert.equal(seen[0].registry.resolve(name), undefined, name);
  }
  assert.ok(seen[0].registry.resolve("get_self"));
  assert.equal(seen[0].registry.visibility("get_runtime_diagnostics"), "deferred");
  assert.equal(seen[0].registry.visibility("get_parallel_work_result"), "deferred");
  const diagnostics = JSON.parse(
    (await seen[0].registry.resolve("get_runtime_diagnostics")!.run({})).content,
  );
  assert.equal(diagnostics.runtime, "opencode");
  assert.equal(diagnostics.coding.nativeToolsEnabled, true);
  assert.equal(diagnostics.tools.workerRecoveryAvailable, true);
});

test("ordinary Members do not gain native coding when the default engine changes", async (t) => {
  const seen = capture(t);
  const result = await runEmployeeAgent({ ...params, allowPrivilegedToolSources: false });
  assert.equal(result.status, "ok");
  assert.equal(seen[0].nativeCoding, false);
  assert.equal(seen[0].registry.resolve("delegate_parallel_work"), undefined);
  assert.equal(seen[0].registry.resolve("get_parallel_work_result"), undefined);
  assert.ok(seen[0].registry.resolve("get_runtime_diagnostics"));
});

test("Repository work sessions retain their exact domain tool surface", async (t) => {
  const seen = capture(t);
  await runEmployeeAgent({
    ...params,
    toolScope: { surfaceOnly: true, genosynTools: ["repository_read_file", "repository_diff"] },
  });
  assert.equal(seen[0].nativeCoding, false);
  assert.deepEqual(seen[0].registry.resident.map((tool) => tool.name).sort(), [
    "repository_diff",
    "repository_read_file",
  ]);
  assert.equal(seen[0].registry.resolve("find_tools"), undefined);
  assert.equal(seen[0].registry.resolve("get_runtime_diagnostics"), undefined);
  assert.equal(seen[0].registry.resolve("get_parallel_work_result"), undefined);
  assert.equal(seen[0].registry.resolve("delegate_parallel_work"), undefined);
});

test("disabled coding remains disabled with OpenCode", async (t) => {
  const seen = capture(t);
  Object.assign(config.agent.codingTools, { executionMode: "disabled" });
  await runEmployeeAgent(params);
  assert.equal(seen[0].nativeCoding, false);
  assert.equal(seen[0].registry.resolve("bash"), undefined);
});

test("explicit bubblewrap keeps native host tools off", async (t) => {
  const seen = capture(t);
  Object.assign(config.agent.codingTools, { executionMode: "bubblewrap" });
  await runEmployeeAgent(params);
  assert.equal(seen[0].nativeCoding, false);
  assert.equal(seen[0].registry.resolve("read_file"), undefined);
  assert.ok(seen[0].registry.resolve("bash"));
});

test("the live Member authorizer is forwarded to OpenCode native tool permission requests", async (t) => {
  const seen = capture(t);
  const authorize = async () => "Membership revoked";
  await runEmployeeAgent({ ...params, authorizePrivilegedToolCall: authorize });
  assert.equal(seen[0].authorizePrivilegedToolCall, authorize);
});

test("runtime diagnostics observe the active model and worker recovery keeps the live authority gate", async (t) => {
  let observed = false;
  const forwarded: number[] = [];
  t.mock.method(agentRuntime, "run", async (input: Parameters<typeof agentRuntime.run>[0]) => {
    input.callbacks?.onContextUsage?.({ promptTokens: 8000, contextWindow: 32000, percent: 25 });
    const result = await input.registry
      .resolve("get_runtime_diagnostics")!
      .run({ toolName: "get_parallel_work_result" });
    const body = JSON.parse(result.content);
    assert.equal(body.context.percent, 25);
    assert.equal(body.tool.visibility, "deferred");
    const denied = await input.registry.resolve("get_parallel_work_result")!.run({});
    assert.equal(denied.isError, true);
    assert.match(denied.content, /Membership revoked/);
    observed = true;
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  await runEmployeeAgent({
    ...params,
    authorizePrivilegedToolCall: async () => "Membership revoked",
    callbacks: { onContextUsage: (usage) => forwarded.push(usage.promptTokens) },
  });
  assert.equal(observed, true);
  assert.deepEqual(forwarded, [8000]);
});

test("restricted model decisions cannot inherit a cwd, environment or native tools", async (t) => {
  const seen = capture(t);
  let called = false;
  const tool: AgentTool = {
    name: "submit_decision",
    description: "Record a decision",
    inputSchema: { type: "object" },
    run: async () => {
      called = true;
      return { content: "OK" };
    },
  };
  const result = await runRestrictedEmployeeAgent({
    model: params.model,
    employeeId: params.employeeId,
    system: params.system,
    messages: params.messages,
    tools: [tool],
    maxSteps: 2,
  });
  assert.equal(result.status, "ok");
  assert.equal(seen[0].nativeCoding, false);
  assert.equal(seen[0].cwd, undefined);
  assert.equal(seen[0].toolEnv, undefined);
  assert.deepEqual(
    seen[0].registry.resident.map((item) => item.name),
    ["submit_decision"],
  );
  await seen[0].registry.resolve("submit_decision")!.run({});
  assert.equal(called, true);
});

test("OpenCode step exhaustion stays unfinished at the employee boundary", async (t) => {
  t.mock.method(agentRuntime, "run", async () => ({
    finalText: "Partial work",
    steps: 8,
    stopReason: "max_steps",
  }));
  const result = await runEmployeeAgent(params);
  assert.deepEqual(result, {
    status: "ok",
    finalText: "Partial work",
    steps: 8,
    stopReason: "max_steps",
  });
});

test("OpenCode failure is surfaced without retrying a second internal harness", async (t) => {
  const run = t.mock.method(agentRuntime, "run", async () => {
    throw Object.assign(new Error("The model is unavailable"), { status: 503 });
  });
  const result = await runEmployeeAgent(params);
  assert.equal(run.mock.callCount(), 1);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.match(result.error, /service failed/);
});

test("parallel workers retain partial step-exhausted evidence as failed, never completed", async (t) => {
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (input: Parameters<typeof agentRuntime.run>[0]) => {
    calls++;
    if (calls === 1) {
      const delegated = await input.registry.resolve("delegate_parallel_work")!.run({
        tasks: [{ label: "Bounded worker", instruction: "Read a large source" }],
      });
      assert.equal(delegated.isError, true);
      assert.match(delegated.content, /step limit|step budget/i);
      assert.match(delegated.content, /partial source evidence/);
      const listed = JSON.parse(
        (await input.registry.resolve("get_parallel_work_result")!.run({})).content,
      );
      assert.equal(listed.results[0].status, "failed");
      return { finalText: "Parent reports incomplete work", steps: 1, stopReason: "end_turn" };
    }
    return { finalText: "partial source evidence", steps: 30, stopReason: "max_steps" };
  });
  const result = await runEmployeeAgent(params);
  assert.equal(result.status, "ok");
  assert.equal(calls, 2);
});

for (const maxSteps of [null, 8, 100]) {
  test(`parallel workers ${maxSteps === null ? "inherit unlimited Routine steps" : `retain their finite ceiling for a ${maxSteps}-step parent`}`, async (t) => {
    const seen: Array<number | null> = [];
    t.mock.method(agentRuntime, "run", async (input: Parameters<typeof agentRuntime.run>[0]) => {
      seen.push(input.maxSteps);
      const diagnostics = JSON.parse(
        (await input.registry.resolve("get_runtime_diagnostics")!.run({})).content,
      );
      assert.equal(diagnostics.limits.maxSteps, input.maxSteps);
      if (seen.length === 1) {
        const delegated = await input.registry.resolve("delegate_parallel_work")!.run({
          tasks: [{ label: "Source review", instruction: "Review the complete source" }],
        });
        assert.notEqual(delegated.isError, true);
        return { finalText: "Reviewed worker evidence", steps: 1, stopReason: "end_turn" };
      }
      assert.equal(input.registry.resolve("delegate_parallel_work"), undefined);
      return { finalText: "Complete source evidence", steps: 125, stopReason: "end_turn" };
    });
    const result = await runEmployeeAgent({ ...params, maxSteps });
    assert.equal(result.status, "ok");
    assert.deepEqual(seen, [maxSteps, maxSteps === null ? null : Math.min(maxSteps, 30)]);
  });
}

test("worker callback IDs stay distinct when providers reuse IDs and labels across sessions", async (t) => {
  const used: string[] = [];
  const returned: string[] = [];
  let calls = 0;
  t.mock.method(agentRuntime, "run", async (input: Parameters<typeof agentRuntime.run>[0]) => {
    calls++;
    if (calls === 1) {
      await input.registry.resolve("delegate_parallel_work")!.run({
        tasks: [
          { label: "Same label", instruction: "Read source A" },
          { label: "Same label", instruction: "Read source B" },
        ],
      });
    } else {
      input.callbacks?.onToolUse?.("read_evidence", {}, "call-1");
      input.callbacks?.onToolResult?.("read_evidence", { content: "evidence" }, "call-1");
    }
    return { finalText: "Done", steps: 1, stopReason: "end_turn" };
  });
  await runEmployeeAgent({
    ...params,
    callbacks: {
      onToolUse: (_name, _input, id) => used.push(id!),
      onToolResult: (_name, _result, id) => returned.push(id!),
    },
  });
  assert.equal(used.length, 2);
  assert.equal(new Set(used).size, 2);
  assert.deepEqual(used, returned);
  assert.ok(used.every((id) => id.endsWith(":call-1") && !id.includes(params.genosynToken)));
});
