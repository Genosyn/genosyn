import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../../../config.js";
import { encryptSecret } from "../../lib/secret.js";
import { closeTestDb, initTestDb } from "../../test/dbHarness.js";
import { insertEmployeeModel } from "../../test/modelFixtures.js";
import { withSubscriptionModelLock } from "../codexSubscription.js";
import { CodexAppServer } from "./codexAppServer.js";
import { codexReasoningDelta, runCodexSubscriptionTurn } from "./codexRuntime.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";
import type { RuntimeWait } from "./types.js";

/**
 * What a ChatGPT-subscription turn tells a watching Member: the reasoning
 * summary OpenAI exposes, and — because such a model answers one turn at a
 * time across every AI Employee using it — that a turn is queued behind
 * another rather than silently doing nothing.
 */

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a reasoning summary is the thinking shown; raw text after it is not repeated", () => {
  const seen = new Set<string>();
  assert.equal(
    codexReasoningDelta("item/agentMessage/delta", { itemId: "a", delta: "x" }, seen),
    null,
  );
  assert.deepEqual(
    codexReasoningDelta("item/reasoning/textDelta", { itemId: "r", delta: "raw " }, seen),
    {
      block: "r",
      delta: "raw ",
    },
  );
  assert.deepEqual(
    codexReasoningDelta(
      "item/reasoning/summaryTextDelta",
      { itemId: "r", delta: "**Plan**", summaryIndex: 0 },
      seen,
    ),
    { block: "r", delta: "**Plan**" },
  );
  assert.deepEqual(
    codexReasoningDelta("item/reasoning/textDelta", { itemId: "r", delta: "more raw" }, seen),
    {
      block: "r",
      delta: "",
    },
  );
  assert.deepEqual(
    codexReasoningDelta("item/reasoning/summaryPartAdded", { itemId: "r", summaryIndex: 1 }, seen),
    { block: "r", delta: "\n\n" },
    "a new summary section starts on its own paragraph",
  );
  assert.deepEqual(
    codexReasoningDelta(
      "item/reasoning/summaryPartAdded",
      { itemId: "fresh", summaryIndex: 0 },
      seen,
    ),
    { block: "fresh", delta: "" },
  );
  assert.deepEqual(
    codexReasoningDelta("item/reasoning/summaryTextDelta", { delta: "no item" }, seen),
    {
      block: "",
      delta: "",
    },
  );
});

test("a free subscription model admits a turn without a word; a busy one says it is queued", async () => {
  const freeWaits: string[] = [];
  assert.equal(
    await withSubscriptionModelLock(
      "lock-free",
      undefined,
      async () => "ran",
      (state) => freeWaits.push(state),
    ),
    "ran",
  );
  assert.deepEqual(freeWaits, []);

  let release!: () => void;
  const firstWaits: string[] = [];
  const first = withSubscriptionModelLock(
    "lock-busy",
    undefined,
    () => new Promise<string>((resolve) => (release = () => resolve("first"))),
    (state) => firstWaits.push(state),
  );
  await tick();
  const secondWaits: string[] = [];
  const second = withSubscriptionModelLock(
    "lock-busy",
    undefined,
    async () => "second",
    (state) => secondWaits.push(state),
  );
  await tick();
  await tick();
  assert.deepEqual(secondWaits, ["waiting"]);
  release();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(secondWaits, ["waiting", "done"]);
  assert.deepEqual(firstWaits, [], "the turn that held the model never waited");
});

test("a turn stopped while queued never claims to have got the model", async () => {
  let release!: () => void;
  const held = withSubscriptionModelLock(
    "lock-abort",
    undefined,
    () => new Promise<void>((r) => (release = r)),
  );
  const controller = new AbortController();
  const waits: string[] = [];
  const queued = withSubscriptionModelLock(
    "lock-abort",
    controller.signal,
    async () => "never",
    (s) => waits.push(s),
  );
  await tick();
  await tick();
  controller.abort();
  await assert.rejects(queued, /aborted/);
  assert.deepEqual(waits, ["waiting"]);
  release();
  await held;
});

test("a subscription turn streams its thinking and reports waiting for the model's lock", async (t) => {
  const mutableConfig = config as unknown as {
    sessionSecret: string;
    security: { multiTenant: boolean; encryptionSecret: string };
    agent: { codingTools: { executionMode: "host" | "disabled" } };
  };
  const original = {
    sessionSecret: mutableConfig.sessionSecret,
    security: { ...mutableConfig.security },
    executionMode: mutableConfig.agent.codingTools.executionMode,
  };
  mutableConfig.sessionSecret = "codex-activity-test-session-secret-2026";
  mutableConfig.security.multiTenant = false;
  mutableConfig.security.encryptionSecret = "codex-activity-test-encryption-secret-2026";
  mutableConfig.agent.codingTools.executionMode = "disabled";
  try {
    await initTestDb();
    const model = await insertEmployeeModel({
      employeeId: "test-employee",
      provider: "openai",
      model: "gpt-5.6-terra",
      authMode: "subscription",
      connectedAt: new Date(),
      configJson: JSON.stringify({
        codexAccessTokenEncrypted: encryptSecret("test-codex-activity-token"),
      }),
    });
    t.mock.method(
      CodexAppServer,
      "start",
      async (options: Parameters<typeof CodexAppServer.start>[0]) => {
        let notify: Parameters<CodexAppServer["onNotification"]>[0] | undefined;
        return {
          request: async (method: string) => {
            if (method === "thread/start") {
              return {
                thread: {
                  id: "thread-id",
                  cwd: options.cwd,
                  ephemeral: true,
                  parentThreadId: null,
                },
                model: "gpt-5.6-terra",
                modelProvider: "openai",
                cwd: options.cwd,
                approvalPolicy: "never",
                sandbox: { type: "readOnly", networkAccess: false },
                runtimeWorkspaceRoots: [],
                instructionSources: [],
              };
            }
            if (method === "turn/start") {
              setImmediate(() => {
                const base = { threadId: "thread-id", turnId: "turn-id" };
                notify?.("item/started", { ...base, item: { type: "reasoning", id: "rs_1" } });
                notify?.("item/reasoning/summaryTextDelta", {
                  ...base,
                  itemId: "rs_1",
                  delta: "**Reading",
                  summaryIndex: 0,
                });
                notify?.("item/reasoning/summaryTextDelta", {
                  ...base,
                  itemId: "rs_1",
                  delta: " the books**",
                  summaryIndex: 0,
                });
                notify?.("item/completed", { ...base, item: { type: "reasoning", id: "rs_1" } });
                notify?.("item/agentMessage/delta", { ...base, itemId: "msg_1", delta: "Done." });
                notify?.("item/completed", {
                  ...base,
                  item: { type: "agentMessage", id: "msg_1", text: "Done." },
                });
                notify?.("turn/completed", {
                  threadId: "thread-id",
                  turn: { id: "turn-id", status: "completed" },
                });
              });
              return { turn: { id: "turn-id" } };
            }
            return {};
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

    // Another AI Employee's turn holds the shared model.
    let release!: () => void;
    const otherTurn = withSubscriptionModelLock(
      model.id,
      undefined,
      () => new Promise<void>((r) => (release = r)),
    );
    await tick();

    const thinking: Array<[string, string]> = [];
    const ended: string[] = [];
    const waits: RuntimeWait[] = [];
    const text: string[] = [];
    const turn = runCodexSubscriptionTurn({
      model,
      system: "Answer briefly.",
      messages: [{ role: "user", content: [{ type: "text", text: "How are the books?" }] }],
      registry: residentOnlyRegistry([]),
      maxSteps: 10,
      callbacks: {
        onReasoning: (delta, block) => thinking.push([delta, block]),
        onReasoningEnd: (block) => ended.push(block),
        onRuntimeWait: (wait) => waits.push(wait),
        onText: (delta) => text.push(delta),
      },
    });
    await tick();
    await tick();
    assert.deepEqual(waits, [{ cause: "model_lock", state: "waiting" }]);
    release();
    await otherTurn;
    const result = await turn;
    assert.equal(result.finalText, "Done.");
    assert.deepEqual(waits, [
      { cause: "model_lock", state: "waiting" },
      { cause: "model_lock", state: "done" },
    ]);
    assert.deepEqual(thinking, [
      ["**Reading", "rs_1"],
      [" the books**", "rs_1"],
    ]);
    assert.deepEqual(ended, ["rs_1"]);
    assert.deepEqual(text, ["Done."], "thinking never leaks into the reply");
  } finally {
    await closeTestDb();
    mutableConfig.sessionSecret = original.sessionSecret;
    Object.assign(mutableConfig.security, original.security);
    mutableConfig.agent.codingTools.executionMode = original.executionMode;
  }
});
