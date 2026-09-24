import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../../../config.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { encryptSecret } from "../../lib/secret.js";
import { closeTestDb, initTestDb, insert } from "../../test/dbHarness.js";
import { CodexAppServer } from "./codexAppServer.js";
import { assertCodexThreadPosture, runCodexSubscriptionTurn } from "./codexRuntime.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";

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

test("unlimited subscription shutdown refuses a queued tool request delivered after abort", async (t) => {
  const mutableConfig = config as unknown as {
    sessionSecret: string;
    security: { multiTenant: boolean; encryptionSecret: string };
    agent: { codingTools: { executionMode: "host" | "bubblewrap" | "disabled" } };
  };
  const original = {
    sessionSecret: mutableConfig.sessionSecret,
    security: { ...mutableConfig.security },
    executionMode: mutableConfig.agent.codingTools.executionMode,
  };
  mutableConfig.sessionSecret = "codex-abort-test-session-secret-2026";
  mutableConfig.security.multiTenant = false;
  mutableConfig.security.encryptionSecret = "codex-abort-test-encryption-secret-2026";
  mutableConfig.agent.codingTools.executionMode = "disabled";
  try {
    await initTestDb();
    const model = await insert(AIModel, {
      employeeId: "test-employee",
      provider: "openai",
      model: expected.model,
      authMode: "subscription",
      connectedAt: new Date(),
      configJson: JSON.stringify({
        codexAccessTokenEncrypted: encryptSecret("test-codex-abort-token"),
      }),
    });
    const controller = new AbortController();
    const runTool = t.mock.fn(async () => ({ content: "A record was changed." }));
    const registry = residentOnlyRegistry([
      {
        name: "write_record",
        description: "Change a test record.",
        inputSchema: { type: "object", properties: {} },
        run: runTool,
      },
    ]);
    const resolveTool = t.mock.method(registry, "resolve");
    let lateResponse: unknown;
    t.mock.method(
      CodexAppServer,
      "start",
      async (options: Parameters<typeof CodexAppServer.start>[0]) => {
        assert.ok(options.onServerRequest);
        return {
          request: async (method: string) => {
            if (method === "thread/start")
              return {
                ...safeResponse,
                cwd: options.cwd,
                thread: { ...safeResponse.thread, cwd: options.cwd },
              };
            if (method === "turn/start") {
              controller.abort();
              return { turn: { id: "turn-id" } };
            }
            if (method === "turn/interrupt") return {};
            throw new Error(`Unexpected test request: ${method}`);
          },
          onNotification: () => () => undefined,
          onExit: () => () => undefined,
          close: async () => {
            // The real app-server may drain another tool request from stdout
            // while close waits for its process to stop.
            assert.equal(controller.signal.aborted, true);
            lateResponse = await options.onServerRequest!("item/tool/call", {
              threadId: "thread-id",
              turnId: "turn-id",
              callId: "late-call",
              namespace: null,
              tool: "write_record",
              arguments: {},
            });
          },
        } as unknown as CodexAppServer;
      },
    );
    await assert.rejects(
      runCodexSubscriptionTurn({
        model,
        system: "Continue the saved work.",
        messages: [{ role: "user", content: [{ type: "text", text: "Review the next record." }] }],
        registry,
        maxSteps: null,
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    assert.equal(resolveTool.mock.callCount(), 0);
    assert.equal(runTool.mock.callCount(), 0);
    assert.equal((lateResponse as { success: boolean }).success, false);
    assert.match(JSON.stringify(lateResponse), /aborted/);
  } finally {
    await closeTestDb();
    mutableConfig.sessionSecret = original.sessionSecret;
    Object.assign(mutableConfig.security, original.security);
    mutableConfig.agent.codingTools.executionMode = original.executionMode;
  }
});

test("subscription turns exceed 100 tool calls only with an unlimited step policy", async (t) => {
  const mutableConfig = config as unknown as {
    sessionSecret: string;
    security: { multiTenant: boolean; encryptionSecret: string };
    agent: { codingTools: { executionMode: "host" | "bubblewrap" | "disabled" } };
  };
  const original = {
    sessionSecret: mutableConfig.sessionSecret,
    security: { ...mutableConfig.security },
    executionMode: mutableConfig.agent.codingTools.executionMode,
  };
  mutableConfig.sessionSecret = "codex-steps-test-session-secret-2026";
  mutableConfig.security.multiTenant = false;
  mutableConfig.security.encryptionSecret = "codex-steps-test-encryption-secret-2026";
  mutableConfig.agent.codingTools.executionMode = "disabled";
  try {
    await initTestDb();
    const model = await insert(AIModel, {
      employeeId: "test-employee",
      provider: "openai",
      model: expected.model,
      authMode: "subscription",
      connectedAt: new Date(),
      configJson: JSON.stringify({
        codexAccessTokenEncrypted: encryptSecret("test-codex-steps-token"),
      }),
    });
    for (const maxSteps of [null, 100]) {
      await t.test(maxSteps === null ? "unlimited" : "finite", async (subtest) => {
        const runTool = subtest.mock.fn(async () => ({ content: "Source reviewed." }));
        const registry = residentOnlyRegistry([
          {
            name: "read_record",
            description: "Read a test record.",
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
            run: runTool,
          },
        ]);
        let interrupts = 0;
        subtest.mock.method(
          CodexAppServer,
          "start",
          async (options: Parameters<typeof CodexAppServer.start>[0]) => {
            assert.ok(options.onServerRequest);
            let notify: Parameters<CodexAppServer["onNotification"]>[0] | undefined;
            return {
              request: async (method: string) => {
                if (method === "thread/start")
                  return {
                    ...safeResponse,
                    cwd: options.cwd,
                    thread: { ...safeResponse.thread, cwd: options.cwd },
                  };
                if (method === "turn/start") {
                  for (let index = 0; index < 125; index++) {
                    const response = (await options.onServerRequest!("item/tool/call", {
                      threadId: "thread-id",
                      turnId: "turn-id",
                      callId: `call-${index}`,
                      namespace: null,
                      tool: "read_record",
                      arguments: {},
                    })) as { success: boolean };
                    if (!response.success) break;
                  }
                  notify?.("turn/completed", {
                    threadId: "thread-id",
                    turn: { id: "turn-id", status: "completed" },
                  });
                  return { turn: { id: "turn-id" } };
                }
                if (method === "turn/interrupt") {
                  interrupts++;
                  return {};
                }
                throw new Error(`Unexpected test request: ${method}`);
              },
              onNotification: (handler: Parameters<CodexAppServer["onNotification"]>[0]) => {
                notify = handler;
                return () => undefined;
              },
              onExit: () => () => undefined,
              close: async () => {},
            } as unknown as CodexAppServer;
          },
        );
        const result = runCodexSubscriptionTurn({
          model,
          system: "Continue reviewing the source records.",
          messages: [{ role: "user", content: [{ type: "text", text: "Review every record." }] }],
          registry,
          maxSteps,
        });
        if (maxSteps === null) {
          assert.equal((await result).steps, 126);
          assert.equal(runTool.mock.callCount(), 125);
          assert.equal(interrupts, 0);
        } else {
          await assert.rejects(result, /stopped this turn after 100 tool calls/);
          assert.equal(runTool.mock.callCount(), 100);
          assert.equal(interrupts, 1);
        }
      });
    }
  } finally {
    await closeTestDb();
    mutableConfig.sessionSecret = original.sessionSecret;
    Object.assign(mutableConfig.security, original.security);
    mutableConfig.agent.codingTools.executionMode = original.executionMode;
  }
});
