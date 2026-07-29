import assert from "node:assert/strict";
import test from "node:test";
import { assertCodexThreadPosture } from "./codexRuntime.js";

const expected = { cwd: "/tmp/genosyn-work", model: "gpt-5.6-terra" };
const safeResponse = {
  thread: {
    id: "thread-id",
    cwd: expected.cwd,
    ephemeral: true,
    parentThreadId: null,
  },
  model: expected.model,
  modelProvider: "openai",
  cwd: expected.cwd,
  approvalPolicy: "never",
  sandbox: { type: "readOnly", networkAccess: false },
  runtimeWorkspaceRoots: [],
  instructionSources: [],
};

test("subscription turns verify the app-server isolation posture", () => {
  assert.equal(assertCodexThreadPosture(safeResponse, expected), "thread-id");
  assert.throws(
    () =>
      assertCodexThreadPosture(
        {
          ...safeResponse,
          sandbox: { type: "workspaceWrite", networkAccess: true },
        },
        expected,
      ),
    /did not honor Genosyn's requested thread isolation/,
  );
  assert.throws(
    () =>
      assertCodexThreadPosture(
        {
          ...safeResponse,
          instructionSources: ["/workspace/AGENTS.md"],
        },
        expected,
      ),
    /did not honor Genosyn's requested thread isolation/,
  );
});
