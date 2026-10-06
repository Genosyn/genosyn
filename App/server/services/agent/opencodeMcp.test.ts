import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Part } from "@opencode-ai/sdk/v2";
import { serveOpenCodeTools } from "./opencodeMcp.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";
import { createCallTool } from "./tools/discovery.js";
import { collapseStaticTools } from "./tools/genosynFamilies.js";
import {
  createParallelResultStore,
  createParallelWorkResultTool,
} from "./tools/parallelWorkerResults.js";
import { OpenCodeToolGate } from "./opencodeToolGate.js";
import type { AgentTool } from "./types.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Fail on an early request result instead of waiting for an unreachable signal. */
async function waitForBarrier(ready: Promise<void>, request?: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      ...(request
        ? [
            request.then(() => {
              throw new Error("MCP request settled before its expected server barrier.");
            }),
          ]
        : []),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Expected MCP server barrier was not reached.")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function expectRejection(request: Promise<unknown>, pattern?: RegExp) {
  const result = pattern ? assert.rejects(request, pattern) : assert.rejects(request);
  // A barrier failure still owns cleanup even if this assertion rejects first.
  void result.catch(() => {});
  return result;
}

function tool(name: string, run: AgentTool["run"]): AgentTool {
  return { name, description: name, inputSchema: { type: "object" }, run };
}

async function fixture(
  tools: AgentTool[],
  options: Omit<Parameters<typeof serveOpenCodeTools>[0], "registry"> = {},
) {
  const endpoint = await serveOpenCodeTools({ registry: residentOnlyRegistry(tools), ...options });
  const client = new Client({ name: "queue-regression", version: "1" });
  const canceled = barrier();
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (
          typeof init?.body === "string" &&
          JSON.parse(init.body).method === "notifications/cancelled"
        )
          canceled.resolve();
        return response;
      },
    }),
  );
  return {
    client,
    endpoint,
    canceled: canceled.promise,
    async close() {
      await client.close();
      await endpoint.close();
    },
  };
}

test("OpenCode advertises Decision option-detail limits unchanged through tools/list", async () => {
  const request = collapseStaticTools().passthrough.find(
    (candidate) => candidate.name === "request_decision",
  );
  assert.ok(request);
  const runtime = await fixture([
    { ...request, run: async () => assert.fail("Listing must not request a Decision") },
  ]);
  try {
    const { tools } = await runtime.client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "request_decision");
    assert.deepEqual(tools[0].inputSchema, request.inputSchema);
    const options = tools[0].inputSchema.properties?.options as {
      items: { properties: { detail: { type: string; maxLength?: number } } };
    };
    assert.equal(options.items.properties.detail.type, "string");
    assert.equal(options.items.properties.detail.maxLength, 240);
  } finally {
    await runtime.close();
  }
});

for (const deferred of [false, true])
  test(`a canceled ${deferred ? "deferred" : "direct"} delegation does not block parent reads or recovery`, async () => {
    const started = barrier();
    const finish = barrier();
    const completed = barrier();
    const request = new AbortController();
    let didStart = false;
    const calls: string[] = [];
    const delegationTool = {
      ...tool("delegate_parallel_work", async () => {
        didStart = true;
        started.resolve();
        await finish.promise;
        completed.resolve();
        return { content: "workers completed" };
      }),
      executionLane: "delegation" as const,
    };
    const registry = residentOnlyRegistry([delegationTool]);
    const runtime = await fixture([
      delegationTool,
      createCallTool({
        searchable: [delegationTool],
        resolve: registry.resolve,
        grantDead: new Set(),
      }),
      ...["list_workstreams", "get_parallel_work_result"].map((name) =>
        tool(name, async () => {
          calls.push(name);
          return { content: "available" };
        }),
      ),
    ]);
    try {
      const delegation = runtime.client.callTool(
        deferred
          ? { name: "call_tool", arguments: { name: " delegate_parallel_work ", args_json: "{}" } }
          : { name: "delegate_parallel_work", arguments: {} },
        undefined,
        { signal: request.signal },
      );
      const canceled = expectRejection(delegation);
      await waitForBarrier(started.promise, delegation);
      request.abort();
      await canceled;
      await waitForBarrier(runtime.canceled);
      await runtime.client.callTool({ name: "list_workstreams", arguments: {} }, undefined, {
        timeout: 5000,
      });
      await runtime.client.callTool(
        { name: "get_parallel_work_result", arguments: {} },
        undefined,
        { timeout: 5000 },
      );
      assert.deepEqual(calls, ["list_workstreams", "get_parallel_work_result"]);
    } finally {
      request.abort();
      finish.resolve();
      try {
        if (didStart) await waitForBarrier(completed.promise);
      } finally {
        await runtime.close();
      }
    }
  });

test("a queued write canceled by its MCP timeout never starts after the active write finishes", async () => {
  const started = barrier();
  const finish = barrier();
  const expiredReceived = barrier();
  const calls: string[] = [];
  const runtime = await fixture(
    [
      tool("write_first", async () => {
        started.resolve();
        await finish.promise;
        calls.push("first");
        return { content: "written" };
      }),
      tool("write_expired", async () => {
        calls.push("expired");
        return { content: "must not run" };
      }),
      tool("read_after", async () => ({ content: "ready" })),
    ],
    {
      beforeCall: async (name) => {
        if (name === "write_expired") expiredReceived.resolve();
      },
    },
  );
  try {
    const first = runtime.client.callTool({ name: "write_first", arguments: {} });
    await waitForBarrier(started.promise, first);
    const expired = runtime.client.callTool({ name: "write_expired", arguments: {} }, undefined, {
      timeout: 5000,
    });
    const timedOut = expectRejection(expired, /timed out/);
    await waitForBarrier(expiredReceived.promise, expired);
    await timedOut;
    // The SDK sends cancellation as a separate POST. Its response proves the
    // notification reached the bridge before the write lane is released.
    await waitForBarrier(runtime.canceled);
    finish.resolve();
    await first;
    await runtime.client.callTool({ name: "read_after", arguments: {} });
    assert.deepEqual(calls, ["first"]);
  } finally {
    finish.resolve();
    await runtime.close();
  }
});

test("canceling an active write retains its ordering barrier until its actual effect finishes", async () => {
  const started = barrier();
  const finish = barrier();
  const nextReceived = barrier();
  const request = new AbortController();
  const calls: string[] = [];
  const results: string[] = [];
  const runtime = await fixture(
    [
      tool("write_first", async () => {
        started.resolve();
        await finish.promise;
        calls.push("first");
        return { content: "first persisted" };
      }),
      tool("write_next", async () => {
        calls.push("next");
        return { content: "next persisted" };
      }),
    ],
    {
      beforeCall: async (name) => {
        if (name === "write_next") nextReceived.resolve();
      },
      callbacks: {
        onToolResult: (_name, result) => {
          results.push(result.content);
        },
      },
    },
  );
  try {
    const first = runtime.client.callTool({ name: "write_first", arguments: {} }, undefined, {
      signal: request.signal,
    });
    const rejected = expectRejection(first);
    await waitForBarrier(started.promise, first);
    request.abort();
    await rejected;
    await waitForBarrier(runtime.canceled);
    const next = runtime.client.callTool({ name: "write_next", arguments: {} });
    await waitForBarrier(nextReceived.promise, next);
    assert.deepEqual(calls, []);
    finish.resolve();
    await next;
    assert.deepEqual(calls, ["first", "next"]);
    assert.deepEqual(results, ["first persisted", "next persisted"]);
  } finally {
    request.abort();
    finish.resolve();
    await runtime.close();
  }
});

test("ordinary writes and reads retain order, including misleading describeCall metadata", async () => {
  const started = barrier();
  const finish = barrier();
  const allReceived = barrier();
  const calls: string[] = [];
  let received = 0;
  const runtime = await fixture(
    [
      tool("write_first", async () => {
        started.resolve();
        await finish.promise;
        calls.push("first");
        return { content: "written" };
      }),
      {
        ...tool("write_second", async () => {
          calls.push("second");
          return { content: "written" };
        }),
        describeCall: () => ({ name: "delegate_parallel_work", input: {} }),
      },
      {
        ...tool("read_state", async () => {
          calls.push("read");
          return { content: "read" };
        }),
        readOnly: true,
      },
    ],
    {
      beforeCall: async () => {
        if (++received === 3) allReceived.resolve();
      },
    },
  );
  try {
    const first = runtime.client.callTool({ name: "write_first", arguments: {} });
    await waitForBarrier(started.promise, first);
    const second = runtime.client.callTool({ name: "write_second", arguments: {} });
    const read = runtime.client.callTool({ name: "read_state", arguments: {} });
    await waitForBarrier(allReceived.promise, Promise.all([first, second, read]));
    assert.deepEqual(calls, []);
    finish.resolve();
    await Promise.all([first, second, read]);
    assert.deepEqual(calls, ["first", "second", "read"]);
  } finally {
    finish.resolve();
    await runtime.close();
  }
});

test("a failed ordinary call releases the ordered lane for its queued successor", async () => {
  const started = barrier();
  const finish = barrier();
  const nextReceived = barrier();
  const calls: string[] = [];
  const runtime = await fixture(
    [
      tool("write_first", async () => {
        calls.push("first:start");
        started.resolve();
        await finish.promise;
        calls.push("first:failed");
        throw new Error("fixture write failure");
      }),
      tool("write_next", async () => {
        calls.push("next");
        return { content: "next persisted" };
      }),
    ],
    {
      beforeCall: async (name) => {
        if (name === "write_next") nextReceived.resolve();
      },
    },
  );
  try {
    const first = runtime.client.callTool({ name: "write_first", arguments: {} }, undefined, {
      timeout: 5000,
    });
    await waitForBarrier(started.promise, first);
    const next = runtime.client.callTool({ name: "write_next", arguments: {} }, undefined, {
      timeout: 5000,
    });
    await waitForBarrier(nextReceived.promise, next);
    assert.deepEqual(calls, ["first:start"]);
    finish.resolve();
    const [failed, succeeded] = await Promise.all([first, next]);
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.content, [{ type: "text", text: "fixture write failure" }]);
    assert.notEqual(succeeded.isError, true);
    assert.deepEqual(succeeded.content, [{ type: "text", text: "next persisted" }]);
    assert.deepEqual(calls, ["first:start", "first:failed", "next"]);
  } finally {
    finish.resolve();
    await runtime.close();
  }
});

test("delegation waits for earlier ordinary writes, then stops holding up later writes", async () => {
  const writeStarted = barrier();
  const finishWrite = barrier();
  const delegateStarted = barrier();
  const finishDelegate = barrier();
  const calls: string[] = [];
  const runtime = await fixture([
    tool("write_first", async () => {
      writeStarted.resolve();
      await finishWrite.promise;
      calls.push("first");
      return { content: "written" };
    }),
    {
      ...tool("delegate_parallel_work", async () => {
        calls.push("delegate");
        delegateStarted.resolve();
        await finishDelegate.promise;
        return { content: "complete" };
      }),
      executionLane: "delegation",
    },
    tool("write_after", async () => {
      calls.push("after");
      return { content: "written" };
    }),
  ]);
  try {
    const first = runtime.client.callTool({ name: "write_first", arguments: {} });
    await waitForBarrier(writeStarted.promise, first);
    const delegated = runtime.client.callTool({ name: "delegate_parallel_work", arguments: {} });
    finishWrite.resolve();
    await first;
    await waitForBarrier(delegateStarted.promise, delegated);
    await runtime.client.callTool({ name: "write_after", arguments: {} }, undefined, {
      timeout: 5000,
    });
    assert.deepEqual(calls, ["first", "delegate", "after"]);
    finishDelegate.resolve();
    await delegated;
  } finally {
    finishWrite.resolve();
    finishDelegate.resolve();
    await runtime.close();
  }
});

for (const stop of ["abort", "close"] as const)
  test(`${stop} prevents both queued ordinary calls and delegation from starting`, async () => {
    const started = barrier();
    const finish = barrier();
    const queued = barrier();
    const controller = new AbortController();
    let received = 0;
    let unwanted = 0;
    const runtime = await fixture(
      [
        tool("write_first", async () => {
          started.resolve();
          await finish.promise;
          return { content: "done" };
        }),
        tool("write_queued", async () => {
          unwanted++;
          return { content: "must not run" };
        }),
        {
          ...tool("delegate_parallel_work", async () => {
            unwanted++;
            return { content: "must not run" };
          }),
          executionLane: "delegation",
        },
      ],
      {
        signal: controller.signal,
        beforeCall: async () => {
          if (++received === 3) queued.resolve();
        },
      },
    );
    try {
      const first = runtime.client.callTool({ name: "write_first", arguments: {} });
      const firstSettled = first.catch(() => undefined);
      await waitForBarrier(started.promise, first);
      const write = runtime.client.callTool({ name: "write_queued", arguments: {} });
      const delegate = runtime.client.callTool({ name: "delegate_parallel_work", arguments: {} });
      const rejected = [expectRejection(write), expectRejection(delegate)];
      await waitForBarrier(queued.promise, Promise.all([write, delegate]));
      if (stop === "abort") controller.abort();
      else await runtime.endpoint.close();
      finish.resolve();
      await Promise.all([firstSettled, ...rejected]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(unwanted, 0);
    } finally {
      finish.resolve();
      await runtime.close();
    }
  });

test("canceled calls consume their own streamed gate observation without lending it to a later call", async () => {
  const gate = new OpenCodeToolGate();
  const firstReceived = barrier();
  const secondReceived = barrier();
  const request = new AbortController();
  let received = 0;
  let executed = 0;
  const runtime = await fixture(
    [
      tool("write_record", async () => {
        executed++;
        return { content: "written" };
      }),
    ],
    {
      beforeCall: (name) => {
        if (++received === 1) firstReceived.resolve();
        else if (received === 2) secondReceived.resolve();
        return gate.enter(name);
      },
    },
  );
  const observe = (id: string) =>
    gate.observe({
      id,
      callID: id,
      sessionID: "session",
      messageID: id,
      type: "tool",
      tool: "genosyn_write_record",
      state: { status: "running", input: {}, time: { start: 1 } },
    } as Part);
  try {
    const first = runtime.client.callTool({ name: "write_record", arguments: {} }, undefined, {
      signal: request.signal,
    });
    const rejected = expectRejection(first);
    await waitForBarrier(firstReceived.promise, first);
    request.abort();
    await rejected;
    await waitForBarrier(runtime.canceled);
    const second = runtime.client.callTool({ name: "write_record", arguments: {} });
    await waitForBarrier(secondReceived.promise, second);
    observe("expired");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(executed, 0);
    observe("current");
    await second;
    assert.equal(executed, 1);
  } finally {
    request.abort();
    gate.close();
    await runtime.close();
  }
});

test("a describeCall failure cannot prevent its actual authorized tool from running", async () => {
  let executed = 0;
  const names: string[] = [];
  const runtime = await fixture(
    [
      {
        ...tool("read_record", async () => {
          executed++;
          return { content: "read" };
        }),
        describeCall: () => {
          throw new Error("broken logging metadata");
        },
      },
    ],
    {
      callbacks: {
        onToolUse: (name) => {
          names.push(name);
        },
      },
    },
  );
  try {
    const response = await runtime.client.callTool({ name: "read_record", arguments: {} });
    assert.equal(response.isError, undefined);
    assert.equal(executed, 1);
    assert.deepEqual(names, ["read_record"]);
  } finally {
    await runtime.close();
  }
});

for (const deferred of [false, true])
  test(`actual ${deferred ? "deferred" : "direct"} worker-result waits leave ordinary reads and writes available`, async () => {
    const store = createParallelResultStore();
    const resultId = store.reserve("Pending source")!;
    const polling = barrier();
    const finishRead = barrier();
    const controller = new AbortController();
    let reads = 0;
    let returned = false;
    const calls: string[] = [];
    const recovery = createParallelWorkResultTool(
      {
        ...store,
        async read(id, offset, maxChars) {
          if (++reads > 1) {
            polling.resolve();
            await finishRead.promise;
          }
          return store.read(id, offset, maxChars);
        },
      },
      { signal: controller.signal },
    );
    const registry = residentOnlyRegistry([recovery]);
    const runtime = await fixture([
      recovery,
      createCallTool({ searchable: [recovery], resolve: registry.resolve, grantDead: new Set() }),
      {
        ...tool("read_company", async () => {
          calls.push("read");
          return { content: "current state" };
        }),
        readOnly: true,
      },
      tool("write_company", async () => {
        calls.push("write");
        return { content: "written" };
      }),
    ]);
    const args = { resultId, waitMs: 10_000 };
    const waiting = runtime.client
      .callTool(
        deferred
          ? {
              name: "call_tool",
              arguments: { name: recovery.name, args_json: JSON.stringify(args) },
            }
          : { name: recovery.name, arguments: args },
      )
      .then((result) => {
        returned = true;
        return result;
      });
    void waiting.catch(() => {});
    try {
      // The first read returned pending. Hold the next authorized poll so this
      // exercises the real wait path without sleeping for its maximum duration.
      await waitForBarrier(polling.promise, waiting);
      await runtime.client.callTool({ name: "read_company", arguments: {} }, undefined, {
        timeout: 5000,
      });
      await runtime.client.callTool({ name: "write_company", arguments: {} }, undefined, {
        timeout: 5000,
      });
      assert.equal(returned, false);
      assert.deepEqual(calls, ["read", "write"]);
      store.finish(resultId, { status: "completed", output: "verified worker evidence" });
      finishRead.resolve();
      const result = await waiting;
      assert.equal(result.isError, undefined);
      assert.match(JSON.stringify(result.content), /verified worker evidence/);
    } finally {
      controller.abort();
      finishRead.resolve();
      await waiting.catch(() => {});
      await runtime.close();
    }
  });

test("canceling actual worker-result recovery cannot release a queued expired write", async () => {
  const store = createParallelResultStore();
  const resultId = store.reserve("Pending source")!;
  const polling = barrier();
  const finishRead = barrier();
  const writeStarted = barrier();
  const finishWrite = barrier();
  const expiredReceived = barrier();
  const lifetime = new AbortController();
  const request = new AbortController();
  const expiredRequest = new AbortController();
  let reads = 0;
  const calls: string[] = [];
  const recovery = createParallelWorkResultTool(
    {
      ...store,
      async read(id, offset, maxChars) {
        if (++reads > 1) {
          polling.resolve();
          await finishRead.promise;
        }
        return store.read(id, offset, maxChars);
      },
    },
    { signal: lifetime.signal },
  );
  const runtime = await fixture(
    [
      recovery,
      tool("write_active", async () => {
        writeStarted.resolve();
        await finishWrite.promise;
        calls.push("active");
        return { content: "written" };
      }),
      tool("write_expired", async () => {
        calls.push("expired");
        return { content: "must not run" };
      }),
      tool("read_after", async () => ({ content: "current state" })),
    ],
    {
      beforeCall: async (name) => {
        if (name === "write_expired") expiredReceived.resolve();
      },
    },
  );
  const waiting = runtime.client.callTool(
    {
      name: recovery.name,
      arguments: { resultId, waitMs: 10_000 },
    },
    undefined,
    { signal: request.signal },
  );
  const canceledRecovery = expectRejection(waiting);
  let active: Promise<unknown> | undefined;
  try {
    await waitForBarrier(polling.promise, waiting);
    active = runtime.client.callTool({ name: "write_active", arguments: {} }, undefined, {
      timeout: 5000,
    });
    void active.catch(() => {});
    await waitForBarrier(writeStarted.promise, active);
    const expired = runtime.client.callTool({ name: "write_expired", arguments: {} }, undefined, {
      signal: expiredRequest.signal,
    });
    const canceledWrite = expectRejection(expired);
    await waitForBarrier(expiredReceived.promise, expired);
    expiredRequest.abort();
    await canceledWrite;
    await waitForBarrier(runtime.canceled);
    request.abort();
    await canceledRecovery;
    assert.deepEqual(calls, []);
    finishWrite.resolve();
    await active;
    store.finish(resultId, { status: "completed", output: "still recoverable evidence" });
    finishRead.resolve();
    await runtime.client.callTool({ name: "read_after", arguments: {} }, undefined, {
      timeout: 5000,
    });
    const recovered = await runtime.client.callTool(
      { name: recovery.name, arguments: { resultId } },
      undefined,
      { timeout: 5000 },
    );
    assert.match(JSON.stringify(recovered.content), /still recoverable evidence/);
    assert.deepEqual(calls, ["active"]);
  } finally {
    lifetime.abort();
    request.abort();
    expiredRequest.abort();
    finishRead.resolve();
    finishWrite.resolve();
    await Promise.allSettled([waiting, ...(active ? [active] : [])]);
    await runtime.close();
  }
});
