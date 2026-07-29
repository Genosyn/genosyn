import assert from "node:assert/strict";
import test from "node:test";
import { toolsBriefing } from "../systemPrompt.js";
import { supportsParallelDelegation } from "./parallelDelegation.js";

test("subscription turns do not advertise delegation that would wait on their model lock", () => {
  assert.equal(supportsParallelDelegation("subscription"), false);
  assert.equal(supportsParallelDelegation("apikey"), true);
  assert.equal(supportsParallelDelegation("customEndpoint"), true);
});

test("the employee briefing promises only tools the runtime offers", () => {
  assert.doesNotMatch(toolsBriefing("chat", false), /delegate_parallel_work/);
  assert.match(toolsBriefing("chat", true), /delegate_parallel_work/);
  assert.doesNotMatch(toolsBriefing("chat", false, false), /`bash`/);
  assert.match(toolsBriefing("chat", false, true, true), /isolated `bash`/);
  assert.doesNotMatch(toolsBriefing("chat", false, true, true), /`read_file`/);
  assert.match(toolsBriefing("chat", false, true, true), /bubblewrap deployment/);
});
