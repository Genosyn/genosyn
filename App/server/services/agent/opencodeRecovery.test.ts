import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { createOpencodeClient, type AssistantMessage, type Part } from "@opencode-ai/sdk/v2";
import { recoverOpenCodePrompt } from "./opencodeRecovery.js";

type RecoveryParams = Parameters<typeof recoverOpenCodePrompt>[0];

const transportError = () =>
  new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });

function completedMessage(): { info: AssistantMessage; parts: Part[] } {
  return {
    info: {
      id: "assistant",
      sessionID: "session",
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "user",
      modelID: "fixture",
      providerID: "genosyn-model",
      mode: "genosyn",
      agent: "genosyn",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [
      {
        id: "reply",
        sessionID: "session",
        messageID: "assistant",
        type: "text",
        text: "The existing work finished.",
      },
    ],
  };
}

function clock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  t.mock.method(Math, "random", () => 0);
}

async function advance(t: TestContext, milliseconds: number): Promise<void> {
  t.mock.timers.tick(milliseconds);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("lost prompt responses recover the existing session with exponential backoff", async (t) => {
  clock(t);
  const final = completedMessage();
  let reads = 0;
  const status = t.mock.fn(async () => {
    reads++;
    return {
      data:
        reads === 1
          ? { session: { type: "busy" } }
          : reads === 2
            ? { session: { type: "retry", attempt: 1, message: "Retrying", next: 1 } }
            : {},
    };
  });
  const messages = t.mock.fn(async () => ({ data: [final] }));
  const prompt = t.mock.fn(async () => assert.fail("The original prompt must never be replayed"));
  const retries: Array<{ attempt: number; maxAttempts: number | null; delayMs: number }> = [];
  const result = recoverOpenCodePrompt({
    session: { status, messages, prompt } as unknown as RecoveryParams["session"],
    sessionID: "session",
    error: transportError(),
    signal: new AbortController().signal,
    callbacks: { onModelRetry: (retry) => retries.push(retry) },
  });

  assert.equal(status.mock.callCount(), 0);
  await advance(t, 749);
  assert.equal(status.mock.callCount(), 0);
  await advance(t, 1);
  assert.equal(status.mock.callCount(), 1);
  assert.equal(messages.mock.callCount(), 0);
  await advance(t, 1499);
  assert.equal(status.mock.callCount(), 1);
  await advance(t, 1);
  assert.equal(status.mock.callCount(), 2);
  await advance(t, 3000);

  assert.deepEqual(await result, { data: final });
  assert.deepEqual(
    retries.map((retry) => retry.delayMs),
    [750, 1500, 3000],
  );
  assert.deepEqual(
    retries.map((retry) => retry.attempt),
    [2, 3, 4],
  );
  assert.ok(retries.every((retry) => retry.maxAttempts === null));
  assert.equal(messages.mock.callCount(), 1);
  assert.equal(prompt.mock.callCount(), 0);
});

test("transient recovery reads retry without restarting completed work", async (t) => {
  clock(t);
  const final = completedMessage();
  let statusReads = 0;
  let messageReads = 0;
  const status = t.mock.fn(async () => {
    if (++statusReads === 1)
      throw new Error("request failed", { cause: { cause: { code: "UND_ERR_SOCKET" } } });
    return { data: { session: { type: "idle" } } };
  });
  const messages = t.mock.fn(async () => {
    if (++messageReads === 1) throw transportError();
    return { data: [final] };
  });
  const result = recoverOpenCodePrompt({
    session: { status, messages } as unknown as RecoveryParams["session"],
    sessionID: "session",
    error: transportError(),
    signal: new AbortController().signal,
  });
  for (const delay of [750, 1500, 3000]) await advance(t, delay);
  assert.deepEqual(await result, { data: final });
  assert.equal(status.mock.callCount(), 3);
  assert.equal(messages.mock.callCount(), 2);
});

test("healthy busy sessions outlive the failed-read budget and cap their backoff", async (t) => {
  clock(t);
  const final = completedMessage();
  let reads = 0;
  const status = t.mock.fn(async () => ({
    data: ++reads <= 12 ? { session: { type: "busy" } } : {},
  }));
  const messages = t.mock.fn(async () => ({ data: [final] }));
  const delays: number[] = [];
  const result = recoverOpenCodePrompt({
    session: { status, messages } as unknown as RecoveryParams["session"],
    sessionID: "session",
    error: transportError(),
    signal: new AbortController().signal,
    callbacks: { onModelRetry: (retry) => delays.push(retry.delayMs) },
  });
  for (let attempt = 0; attempt < 13; attempt += 1)
    await advance(t, [750, 1500, 3000, 6000, 12_000, 22_500][Math.min(attempt, 5)]);
  assert.deepEqual(await result, { data: final });
  assert.equal(status.mock.callCount(), 13);
  assert.equal(messages.mock.callCount(), 1);
  assert.deepEqual(delays.slice(0, 6), [750, 1500, 3000, 6000, 12_000, 22_500]);
  assert.ok(delays.slice(6).every((delay) => delay === 22_500));
});

test("cancellation interrupts backoff before any recovery request", async (t) => {
  clock(t);
  const controller = new AbortController();
  const status = t.mock.fn(async () => assert.fail("Cancelled recovery must not read status"));
  const messages = t.mock.fn(async () => assert.fail("Cancelled recovery must not read messages"));
  const result = recoverOpenCodePrompt({
    session: { status, messages } as unknown as RecoveryParams["session"],
    sessionID: "session",
    error: transportError(),
    signal: controller.signal,
  });
  const rejected = assert.rejects(result, { name: "AbortError" });
  controller.abort();
  await rejected;
  await advance(t, 30_000);
  assert.equal(status.mock.callCount(), 0);
  assert.equal(messages.mock.callCount(), 0);
});

test("permanent prompt and recovery failures fail immediately", async (t) => {
  clock(t);
  const permanent = Object.assign(new Error("The model rejected its credentials"), { status: 401 });
  const status = t.mock.fn(async () => {
    throw permanent;
  });
  const messages = t.mock.fn(async () => assert.fail("Permanent failures must not read messages"));
  const params = {
    session: { status, messages } as unknown as RecoveryParams["session"],
    sessionID: "session",
    signal: new AbortController().signal,
  };
  await assert.rejects(
    recoverOpenCodePrompt({ ...params, error: permanent }),
    (error) => error === permanent,
  );
  assert.equal(status.mock.callCount(), 0);
  const rejected = assert.rejects(
    recoverOpenCodePrompt({ ...params, error: transportError() }),
    (error) => error === permanent,
  );
  await advance(t, 750);
  await rejected;
  assert.equal(status.mock.callCount(), 1);
  assert.equal(messages.mock.callCount(), 0);
});

test("idle sessions cannot turn absent, incomplete, or interrupted messages into success", async (t) => {
  clock(t);
  for (const state of ["absent", "incomplete", "tool-calls", "unknown", "aborted"] as const) {
    const final = completedMessage();
    if (state === "incomplete") delete final.info.time.completed;
    if (state === "tool-calls" || state === "unknown") final.info.finish = state;
    if (state === "aborted")
      final.info.error = { name: "MessageAbortedError", data: { message: "Aborted" } };
    const status = t.mock.fn(async () => ({ data: {} }));
    const messages = t.mock.fn(async () => ({ data: state === "absent" ? [] : [final] }));
    const original = transportError();
    const rejected = assert.rejects(
      recoverOpenCodePrompt({
        session: { status, messages } as unknown as RecoveryParams["session"],
        sessionID: "session",
        error: original,
        signal: new AbortController().signal,
      }),
    );
    await advance(t, 750);
    await rejected;
    assert.equal(status.mock.callCount(), 1, state);
    assert.equal(messages.mock.callCount(), 1, state);
  }
});

test("terminal model errors are preserved for normal error reporting", async (t) => {
  clock(t);
  const final = completedMessage();
  delete final.info.finish;
  final.info.error = {
    name: "APIError",
    data: { message: "Model unavailable", statusCode: 503, isRetryable: false },
  };
  const status = t.mock.fn(async () => ({ data: {} }));
  const messages = t.mock.fn(async () => ({ data: [final] }));
  const result = recoverOpenCodePrompt({
    session: { status, messages } as unknown as RecoveryParams["session"],
    sessionID: "session",
    error: transportError(),
    signal: new AbortController().signal,
  });
  await advance(t, 750);
  assert.deepEqual(await result, { data: final });
});

test("consecutive failed status reads stop at the recovery limit", async (t) => {
  clock(t);
  const failure = transportError();
  const status = t.mock.fn(async () => {
    throw failure;
  });
  const messages = t.mock.fn(async () => assert.fail("Failed status must not fetch messages"));
  let settled = false;
  const rejected = assert
    .rejects(
      recoverOpenCodePrompt({
        session: { status, messages } as unknown as RecoveryParams["session"],
        sessionID: "session",
        error: transportError(),
        signal: new AbortController().signal,
      }),
    )
    .then(() => {
      settled = true;
    });
  for (let attempt = 0; attempt < 10; attempt += 1)
    await advance(t, [750, 1500, 3000, 6000, 12_000, 22_500][Math.min(attempt, 5)]);
  assert.equal(settled, true);
  await rejected;
  assert.equal(status.mock.callCount(), 10);
  assert.equal(messages.mock.callCount(), 0);
});

test("real SDK status failures preserve HTTP retryability through their error wrapper", async (t) => {
  clock(t);
  const final = completedMessage();
  const requests: string[] = [];
  const client = createOpencodeClient({
    baseUrl: "http://opencode.test",
    throwOnError: true,
    fetch: async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      requests.push(pathname);
      if (requests.length === 1)
        return Response.json({ name: "UnknownError", data: { message: "busy" } }, { status: 503 });
      return Response.json(pathname === "/session/status" ? {} : [final]);
    },
  });
  const result = recoverOpenCodePrompt({
    session: client.session,
    sessionID: "session",
    error: transportError(),
    signal: new AbortController().signal,
  });
  await advance(t, 750);
  assert.deepEqual(requests, ["/session/status"]);
  await advance(t, 1500);
  assert.deepEqual(await result, { data: final });
  assert.deepEqual(requests, ["/session/status", "/session/status", "/session/session/message"]);
});

test("real SDK validation failures mentioning timeout are permanent", async (t) => {
  clock(t);
  let requests = 0;
  const client = createOpencodeClient({
    baseUrl: "http://opencode.test",
    throwOnError: true,
    fetch: async () => {
      requests++;
      return Response.json(
        { name: "UnknownError", data: { message: "Invalid timeout parameter" } },
        { status: 400 },
      );
    },
  });
  let settled = false;
  const rejected = assert
    .rejects(
      recoverOpenCodePrompt({
        session: client.session,
        sessionID: "session",
        error: transportError(),
        signal: new AbortController().signal,
      }),
      /Invalid timeout parameter/,
    )
    .then(() => {
      settled = true;
    });
  await advance(t, 750);
  assert.equal(settled, true);
  await rejected;
  await advance(t, 30_000);
  assert.equal(requests, 1);
});
