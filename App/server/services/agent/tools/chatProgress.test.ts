import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createChatProgressTool } from "./chatProgress.js";

describe("chat progress tool", () => {
  test("publishes valid monotonic updates", async () => {
    const updates: { percent: number; label: string }[] = [];
    const tool = createChatProgressTool((progress) => updates.push(progress));

    const first = await tool.run({ percent: 10, label: "  Reading source files  " });
    const second = await tool.run({ percent: 65, label: "Running checks" });

    assert.equal(first.isError, undefined);
    assert.equal(second.isError, undefined);
    assert.deepEqual(updates, [
      { percent: 10, label: "Reading source files" },
      { percent: 65, label: "Running checks" },
    ]);
  });

  test("rejects invalid and decreasing updates without publishing them", async () => {
    const updates: { percent: number; label: string }[] = [];
    const tool = createChatProgressTool((progress) => updates.push(progress));

    assert.equal((await tool.run({ percent: 40, label: "Building" })).isError, undefined);
    assert.equal((await tool.run({ percent: 25, label: "Going backwards" })).isError, true);
    assert.equal((await tool.run({ percent: 100, label: "Done" })).isError, true);
    assert.equal((await tool.run({ percent: 50, label: "" })).isError, true);
    assert.deepEqual(updates, [{ percent: 40, label: "Building" }]);
  });

  test("does not let a consumer callback fail the turn", async () => {
    const tool = createChatProgressTool(() => {
      throw new Error("stream closed");
    });

    const result = await tool.run({ percent: 20, label: "Checking records" });
    assert.equal(result.isError, undefined);
  });
});
