import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "./loop.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";
import type { AssistantTurn, ModelClient, ModelRetryInfo } from "./types.js";

const successfulTurn: AssistantTurn = {
  blocks: [{ type: "text", text: "recovered" }],
  stopReason: "end_turn",
};

function client(streamTurn: ModelClient["streamTurn"]): ModelClient {
  return { model: "test-model", maxTools: null, streamTurn };
}

test("retries a transient provider failure and reports the attempt", async () => {
  let calls = 0;
  const retries: ModelRetryInfo[] = [];
  const result = await runAgentLoop({
    client: client(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("temporary failure"), {
          status: 500,
          headers: new Headers({ "retry-after": "0" }),
        });
      }
      return successfulTurn;
    }),
    system: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    registry: residentOnlyRegistry([]),
    maxSteps: 1,
    callbacks: { onModelRetry: (info) => retries.push(info) },
  });

  assert.equal(calls, 2);
  assert.equal(result.finalText, "recovered");
  assert.deepEqual(retries, [{ attempt: 2, maxAttempts: 5, delayMs: 0, reason: "HTTP 500" }]);
});

test("stops after five transient attempts", async () => {
  let calls = 0;
  await assert.rejects(
    runAgentLoop({
      client: client(async () => {
        calls += 1;
        throw Object.assign(new Error("still failing"), {
          status: 503,
          headers: new Headers({ "retry-after": "0" }),
        });
      }),
      system: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      registry: residentOnlyRegistry([]),
      maxSteps: 1,
    }),
    /still failing/,
  );
  assert.equal(calls, 5);
});

test("does not retry a permanent error or replay a partial streamed answer", async () => {
  let permanentCalls = 0;
  await assert.rejects(
    runAgentLoop({
      client: client(async () => {
        permanentCalls += 1;
        throw Object.assign(new Error("bad request"), { status: 400 });
      }),
      system: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      registry: residentOnlyRegistry([]),
      maxSteps: 1,
    }),
    /bad request/,
  );
  assert.equal(permanentCalls, 1);

  let partialCalls = 0;
  await assert.rejects(
    runAgentLoop({
      client: client(async ({ onText }) => {
        partialCalls += 1;
        onText?.("half an answer");
        throw Object.assign(new Error("stream failed"), { status: 500 });
      }),
      system: "test",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      registry: residentOnlyRegistry([]),
      maxSteps: 1,
    }),
    /stream failed/,
  );
  assert.equal(partialCalls, 1);
});
