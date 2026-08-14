import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentTool } from "../types.js";
import { guardPrivilegedTools, selectSurfaceTools } from "./index.js";

function fakeTool(onRun: () => void): AgentTool {
  return {
    name: "local_tool",
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
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
    assert.deepEqual(await guarded.run({}), { content: "ran" });
    assert.deepEqual(await guarded.run({}), {
      content: "revoked mid-turn",
      isError: true,
    });
    assert.equal(checks, 2);
    assert.equal(runs, 1);
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
