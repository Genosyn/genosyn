import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentTool } from "../types.js";
import { guardPrivilegedTools, selectSurfaceTools } from "./index.js";
import { residentOnlyRegistry } from "./toolRegistry.js";
import { createCallTool } from "./discovery.js";

function fakeTool(onRun: () => void): AgentTool {
  return {
    name: "local_tool",
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
    executionLane: "delegation",
    describeCall: (input) => ({ name: "real_local_tool", input }),
    run: async () => {
      onRun();
      return { content: "ran" };
    },
  };
}

describe("privileged ambient tool guards", () => {
  test("checks live authority before every call and preserves call descriptions", async () => {
    let checks = 0;
    let runs = 0;
    const [guarded] = guardPrivilegedTools([fakeTool(() => runs++)], async () => {
      checks += 1;
      return checks === 1 ? null : "revoked mid-turn";
    });

    assert.deepEqual(guarded.describeCall?.({ value: 1 }), {
      name: "real_local_tool",
      input: { value: 1 },
    });
    assert.equal(guarded.executionLane, "delegation");
    assert.deepEqual(await guarded.run({}), { content: "ran" });
    assert.deepEqual(await guarded.run({}), {
      content: "revoked mid-turn",
      isError: true,
    });
    assert.equal(checks, 2);
    assert.equal(runs, 1);
  });

  test("delegation scheduling metadata survives registry resolution without bypassing live authority", async () => {
    let checks = 0;
    let runs = 0;
    const [guarded] = guardPrivilegedTools([fakeTool(() => runs++)], async () => {
      checks++;
      return "revoked before dispatch";
    });
    const registry = residentOnlyRegistry([guarded]);
    assert.equal(registry.resolve("local_tool")?.executionLane, "delegation");
    assert.deepEqual(await registry.resolve("local_tool")!.run({}), {
      content: "revoked before dispatch",
      isError: true,
    });
    const deferred = createCallTool({
      searchable: [guarded],
      resolve: registry.resolve,
      grantDead: new Set(),
    });
    assert.deepEqual(await deferred.run({ name: "local_tool", args_json: "{}" }), {
      content: "revoked before dispatch",
      isError: true,
    });
    assert.equal(checks, 2);
    assert.equal(runs, 0);
  });

  test("fails closed without leaking an authority lookup error", async () => {
    let runs = 0;
    const [guarded] = guardPrivilegedTools([fakeTool(() => runs++)], async () => {
      throw new Error("database password and topology");
    });
    const result = await guarded.run({});
    assert.equal(result.isError, true);
    assert.match(result.content, /could not be verified/);
    assert.doesNotMatch(result.content, /database password/);
    assert.equal(runs, 0);
  });

  test("omits unclassified local tools from ordinary Member turns", () => {
    const selected = selectSurfaceTools([fakeTool(() => undefined)], {
      allowPrivileged: false,
    });
    assert.deepEqual(selected, []);
  });

  test("keeps explicitly Member-safe Help tools without invoking an admin gate", async () => {
    let checks = 0;
    let runs = 0;
    const [selected] = selectSurfaceTools([fakeTool(() => runs++)], {
      authority: "member",
      allowPrivileged: false,
      authorizePrivilegedToolCall: async () => {
        checks += 1;
        return "not admin";
      },
    });
    assert.deepEqual(await selected.run({}), { content: "ran" });
    assert.equal(runs, 1);
    assert.equal(checks, 0);
  });

  test("defaults a new admin-visible local tool to the live privileged guard", async () => {
    let runs = 0;
    const [selected] = selectSurfaceTools([fakeTool(() => runs++)], {
      allowPrivileged: true,
      authorizePrivilegedToolCall: async () => "demoted",
    });
    assert.deepEqual(await selected.run({}), { content: "demoted", isError: true });
    assert.equal(runs, 0);
  });
});
