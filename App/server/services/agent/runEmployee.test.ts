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
});

test("ordinary Members do not gain native coding when the default engine changes", async (t) => {
  const seen = capture(t);
  const result = await runEmployeeAgent({ ...params, allowPrivilegedToolSources: false });
  assert.equal(result.status, "ok");
  assert.equal(seen[0].nativeCoding, false);
  assert.equal(seen[0].registry.resolve("delegate_parallel_work"), undefined);
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
