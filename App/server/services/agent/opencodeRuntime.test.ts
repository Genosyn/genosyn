import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AssistantMessage, Event, Part } from "@opencode-ai/sdk/v2";
import type { AIModel } from "../../db/entities/AIModel.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";
import { buildOpenCodeConfig, openCodePromptParts } from "./opencodeConfig.js";
import { openCodeEnvironment, openCodeStartupError } from "./opencodeServer.js";
import { OpenCodeEvents, openCodeActivityError } from "./opencodeEvents.js";
import { openCodeToolNames, serveOpenCodeTools } from "./opencodeMcp.js";
import { runOpenCodeSession, type OpenCodeTurnParams } from "./opencodeRuntime.js";
import { serveOpenCodeModel } from "./opencodeProxy.js";
import { openCodeModelLimits } from "./opencodeModelLimits.js";
import { OpenCodeToolGate } from "./opencodeToolGate.js";

const model = {
  id: "fixture",
  provider: "custom" as const,
  apiKey: "private-key",
  baseURL: "http://127.0.0.1:1000/v1",
  contextWindow: 32000,
};
const configuration = (nativeCoding = false) =>
  buildOpenCodeConfig({
    model,
    maxSteps: 8,
    nativeCoding,
    mcp: { url: "http://127.0.0.1:1234/mcp", token: "bridge-secret" },
  });

test("long MCP tool names stay inside the provider limit without collisions", () => {
  const names = ["short", `${"long_".repeat(13)}a`, `${"long_".repeat(13)}b`];
  const mapped = openCodeToolNames(names);
  assert.equal(mapped.get("short"), "short");
  assert.equal(new Set(mapped.values()).size, 3);
  assert.ok([...mapped.values()].every((name) => `genosyn_${name}`.length <= 64));
  assert.deepEqual(openCodeToolNames(names), mapped);
});

test("OpenCode config confines scoped turns and keeps coding tools an explicit choice", () => {
  const cfg = configuration();
  assert.deepEqual(cfg.enabled_providers, ["genosyn-model"]);
  assert.deepEqual(cfg.permission, { "*": "deny", "genosyn_*": "allow" });
  assert.equal(cfg.agent?.genosyn?.steps, 8);
  assert.equal(cfg.agent?.general?.disable, true);
  assert.equal(cfg.agent?.title?.disable, true);
  assert.equal(cfg.lsp, false);
  assert.equal(cfg.share, "disabled");
  assert.equal(cfg.autoupdate, false);
  assert.equal(cfg.provider?.["genosyn-model"].npm, "@ai-sdk/openai-compatible");
  const native = configuration(true);
  assert.equal((native.permission as Record<string, string>).bash, "ask");
  assert.equal((native.permission as Record<string, string>).task, undefined);
  assert.equal((native.permission as Record<string, string>).question, undefined);
});

test("provider mapping preserves Responses, Anthropic effort and endpoint model IDs", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    const cfg = buildOpenCodeConfig({
      model: { ...model, provider, id: "company/model" },
      effort: "high",
      maxSteps: 4,
      nativeCoding: false,
      mcp: { url: "http://localhost/mcp", token: "secret" },
    });
    const mapped = cfg.provider?.[provider === "openai" ? "openai" : "genosyn-model"];
    assert.equal(mapped?.npm, `@ai-sdk/${provider}`);
    assert.equal(mapped?.models?.["company/model"].id, "company/model");
    if (provider === "openai") assert.equal(mapped?.models?.["company/model"].limit, undefined);
    assert.deepEqual(
      mapped?.models?.["company/model"].options,
      provider === "openai" ? { store: false, reasoningEffort: "high" } : { effort: "high" },
    );
  }
  assert.throws(
    () =>
      buildOpenCodeConfig({
        model,
        effort: "high",
        maxSteps: 1,
        nativeCoding: false,
        mcp: { url: "", token: "" },
      }),
    /default effort/,
  );
});

test("OpenAI limits inherit published output caps and reserve input for small windows", () => {
  assert.deepEqual(openCodeModelLimits({ context: 128000, output: 16384 }, 128000), {
    context: 128000,
    input: 128000,
    output: 16384,
  });
  assert.deepEqual(openCodeModelLimits({ context: 8192, output: 8192 }, 8192), {
    context: 8192,
    input: 8192,
    output: 4096,
  });
  assert.deepEqual(
    openCodeModelLimits({ context: 400000, input: 272000, output: 128000 }, 400000),
    { context: 400000, input: 272000, output: 128000 },
  );
  assert.deepEqual(openCodeModelLimits({ context: 0, output: 0 }, null), { context: 0, output: 0 });
});

test("unknown context stays unknown and legacy Anthropic models keep their output ceiling", () => {
  const cfg = buildOpenCodeConfig({
    model: { ...model, id: "claude-3-haiku-20240307", provider: "anthropic", contextWindow: null },
    maxSteps: 1,
    nativeCoding: false,
    mcp: { url: "", token: "" },
  });
  assert.deepEqual(cfg.provider?.["genosyn-model"].models?.["claude-3-haiku-20240307"].limit, {
    context: 0,
    output: 4096,
  });
});

test("child environment excludes ambient credentials and repository configuration", () => {
  const env = openCodeEnvironment({
    home: "/private/session",
    password: "server-secret",
    config: configuration(),
    toolEnv: {
      HOME: "/wrong",
      OPENCODE_CONFIG: "/untrusted",
      OPENAI_API_KEY: "ambient",
      PATH: "/bin",
      PROJECT_VALUE: "kept",
    },
  });
  assert.equal(env.HOME, "/private/session");
  assert.equal(env.PROJECT_VALUE, "kept");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, "true");
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, "true");
});

test("conversation history retains roles, tool evidence and actual image parts", () => {
  const parts = openCodePromptParts([
    {
      role: "assistant",
      content: [
        { type: "text", text: "Earlier report" },
        { type: "tool_use", id: "old", name: "read_file", input: { path: "a.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "old", content: "failed read", isError: true },
        { type: "text", text: "Fix this" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=", sourceLabel: "screenshot.png" },
      ],
    },
  ]);
  assert.ok(
    parts.some((part) => part.type === "text" && part.text.includes("history — assistant")),
  );
  assert.ok(
    parts.some((part) => part.type === "text" && part.text.includes("(failed): failed read")),
  );
  assert.ok(
    parts.some((part) => part.type === "file" && part.url === "data:image/png;base64,aGVsbG8="),
  );
});

function assistant(id = "assistant"): AssistantMessage {
  return {
    id,
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
    tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
    finish: "stop",
  };
}
function updated(part: Part): Event {
  return {
    id: `event-${part.id}`,
    type: "message.part.updated",
    properties: { sessionID: "session", part, time: 1 },
  };
}

test("events stream only assistant prose, deduplicate snapshots and preserve actual usage", () => {
  const text: string[] = [];
  const usage: unknown[] = [];
  const events = new OpenCodeEvents(
    "session",
    { onText: (s) => text.push(s), onUsage: (u) => usage.push(u) },
    100,
  );
  events.accept(
    updated({
      id: "user-part",
      type: "text",
      sessionID: "session",
      messageID: "user",
      text: "Do not echo this",
    }),
  );
  events.accept({
    id: "assistant-event",
    type: "message.updated",
    properties: { sessionID: "session", info: assistant() },
  });
  const part = {
    id: "part",
    type: "text" as const,
    sessionID: "session",
    messageID: "assistant",
    text: "Hi",
  };
  events.accept(updated(part));
  events.accept({
    id: "delta",
    type: "message.part.delta",
    properties: {
      sessionID: "session",
      messageID: "assistant",
      partID: "part",
      field: "text",
      delta: " there",
    },
  });
  events.accept(updated({ ...part, text: "Hi there" }));
  const finish: Part = {
    id: "finish",
    type: "step-finish",
    sessionID: "session",
    messageID: "assistant",
    reason: "stop",
    cost: 0,
    tokens: assistant().tokens,
  };
  events.accept(updated(finish));
  events.accept(updated(finish));
  assert.equal(text.join(""), "Hi there");
  assert.equal(events.finalText, "Hi there");
  assert.equal(events.steps, 1);
  assert.deepEqual(usage, [{ inputTokens: 13, outputTokens: 4 }]);
});

test("tool execution waits for streamed ordering and text readiness is fixed for each message", async () => {
  let wasRead = false;
  const text: string[] = [];
  const gate = new OpenCodeToolGate();
  const events = new OpenCodeEvents(
    "session",
    { shouldStreamText: () => wasRead, onText: (value) => text.push(value) },
    null,
    (part) => gate.observe(part),
  );
  const waiting = gate.enter("read_decision").then(() => {
    wasRead = true;
  });
  events.accept({
    id: "first",
    type: "message.updated",
    properties: { sessionID: "session", info: assistant("first") },
  });
  events.part({
    id: "before",
    type: "text",
    sessionID: "session",
    messageID: "first",
    text: "Before the read",
  });
  assert.equal(wasRead, false);
  const tool: Part = {
    id: "read",
    type: "tool",
    sessionID: "session",
    messageID: "first",
    callID: "read",
    tool: "genosyn_read_decision",
    state: { status: "running", input: {}, time: { start: 1 } },
  };
  events.part(tool);
  events.part(tool);
  await waiting;
  events.part({
    id: "late",
    type: "text",
    sessionID: "session",
    messageID: "first",
    text: "Still generated before seeing the read result",
  });
  events.accept({
    id: "next",
    type: "message.updated",
    properties: { sessionID: "session", info: assistant("next") },
  });
  events.part({
    id: "answer",
    type: "text",
    sessionID: "session",
    messageID: "next",
    text: "Grounded answer",
  });
  assert.deepEqual(text, ["Grounded answer"]);
  const queued = gate.enter("read_decision");
  gate.close();
  await assert.rejects(queued, /turn has ended/);
});

test("retries are visible again in later steps and empty final replies do not reuse narration", () => {
  let retries = 0;
  const text: string[] = [];
  const events = new OpenCodeEvents("session", {
    onModelRetry: () => {
      retries++;
    },
    onText: (value) => text.push(value),
  });
  for (const id of ["first", "final"]) {
    events.accept({
      id: `message-${id}`,
      type: "message.updated",
      properties: { sessionID: "session", info: assistant(id) },
    });
    const retry: Event = {
      id: `retry-${id}`,
      type: "session.status",
      properties: {
        sessionID: "session",
        status: { type: "retry", attempt: 2, message: "Retrying", next: Date.now() + 1000 },
      },
    };
    events.accept(retry);
    events.accept(retry);
    if (id === "first")
      events.part({
        id: "narration",
        type: "text",
        sessionID: "session",
        messageID: id,
        text: "I will read the evidence.",
      });
  }
  events.accept({
    id: "summary-message",
    type: "message.updated",
    properties: { sessionID: "session", info: { ...assistant("summary"), summary: true } },
  });
  events.part({
    id: "summary-text",
    type: "text",
    sessionID: "session",
    messageID: "summary",
    text: "Private compaction summary",
  });
  assert.equal(retries, 2);
  assert.equal(events.finalText, "");
  assert.deepEqual(text, ["I will read the evidence."]);
});

test("MCP serves resident tools, dispatches deferred tools, and preserves images and failures", async () => {
  const seen: unknown[] = [];
  const registry = residentOnlyRegistry([
    {
      name: "observe",
      description: "Read fixture",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      async run() {
        return { content: "observed", images: [{ mimeType: "image/png", data: "aGVsbG8=" }] };
      },
    },
  ]);
  registry.all.set("failure", {
    name: "failure",
    description: "Failure",
    inputSchema: { type: "object" },
    async run() {
      throw new Error("fixture failure");
    },
  });
  const endpoint = await serveOpenCodeTools({
    registry,
    callbacks: {
      onToolUse: (name) => seen.push(name),
      onToolResult: (_name, result) => seen.push(result),
    },
  });
  const client = new Client({ name: "fixture", version: "1" });
  try {
    assert.equal((await fetch(endpoint.url, { method: "POST" })).status, 401);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
      }),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["observe"],
    );
    const result = await client.callTool({ name: "observe", arguments: {} });
    assert.ok(
      Array.isArray(result.content) &&
        result.content.some((part) => (part as { type: string }).type === "image"),
    );
    const failure = await client.callTool({ name: "failure", arguments: {} });
    assert.equal(failure.isError, true);
    assert.equal(seen[0], "observe");
    assert.equal(seen[2], "failure");
  } finally {
    await client.close();
    await endpoint.close();
  }
});

test("concurrent MCP calls preserve company write ordering and do not run queued calls after abort", async () => {
  const sequence: string[] = [];
  let finishWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const controller = new AbortController();
  const endpoint = await serveOpenCodeTools({
    signal: controller.signal,
    registry: residentOnlyRegistry([
      {
        name: "write_record",
        description: "Write",
        inputSchema: { type: "object" },
        async run() {
          sequence.push("write:start");
          await writing;
          sequence.push("write:end");
          return { content: "written" };
        },
      },
      {
        name: "read_record",
        description: "Read",
        inputSchema: { type: "object" },
        readOnly: true,
        async run() {
          sequence.push("read");
          return { content: "read" };
        },
      },
      {
        name: "abort_record",
        description: "Stop",
        inputSchema: { type: "object" },
        async run() {
          sequence.push("abort");
          controller.abort();
          return { content: "stopped" };
        },
      },
    ]),
  });
  const client = new Client({ name: "ordering", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
      }),
    );
    const first = client.callTool({ name: "write_record", arguments: {} });
    await waitFor(() => sequence.length === 1);
    const second = client.callTool({ name: "read_record", arguments: {} });
    finishWrite();
    await Promise.all([first, second]);
    assert.deepEqual(sequence, ["write:start", "write:end", "read"]);
    const aborting = client.callTool({ name: "abort_record", arguments: {} });
    const queued = client.callTool({ name: "read_record", arguments: {} });
    const [stop, skipped] = await Promise.allSettled([aborting, queued]);
    assert.equal(stop.status, "fulfilled");
    assert.equal(skipped.status, "rejected");
    assert.deepEqual(sequence, ["write:start", "write:end", "read", "abort"]);
  } finally {
    finishWrite();
    await client.close();
    await endpoint.close();
  }
});

async function fakeOpenCode(
  action: (
    emit: (event: Event) => void,
    body: Record<string, unknown>,
  ) => Promise<{ info: AssistantMessage; parts: Part[] }>,
  options: {
    hangControl?: boolean;
    openAiModel?: { id: string; limit: { context: number; output: number } };
  } = {},
) {
  let stream: ServerResponse | undefined;
  let globalStream: ServerResponse | undefined;
  let configurationPending = false;
  const permissions: Record<string, unknown>[] = [];
  const globalConfigs: Record<string, unknown>[] = [];
  let aborts = 0;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    const emit = (event: Event) => stream?.write(`data: ${JSON.stringify(event)}\n\n`);
    if (pathname === "/global/event") {
      globalStream = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ directory: "global", payload: { id: "connected", type: "server.connected", properties: {} } })}\n\n`,
      );
      return;
    }
    if (pathname === "/provider") {
      const model = options.openAiModel;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          all: model ? [{ id: "openai", models: { [model.id]: { limit: model.limit } } }] : [],
          default: {},
          connected: ["openai"],
        }),
      );
      return;
    }
    if (pathname === "/global/config") {
      globalConfigs.push(body);
      configurationPending = true;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
      setTimeout(() => {
        configurationPending = false;
        globalStream?.write(
          `data: ${JSON.stringify({ directory: "global", payload: { id: "disposed", type: "global.disposed", properties: {} } })}\n\n`,
        );
      }, 100);
      return;
    }
    if (pathname === "/event") {
      stream = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      emit({ id: "connected", type: "server.connected", properties: {} });
      return;
    }
    if (pathname === "/session" && req.method === "POST") {
      assert.equal(configurationPending, false, "session must wait for global config disposal");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "session" }));
      return;
    }
    if (pathname === "/session/session/message") {
      const result = await action(emit, body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    if (pathname.startsWith("/permission/")) {
      permissions.push(body);
      if (options.hangControl) return;
    }
    if (pathname.endsWith("/abort")) aborts++;
    res.setHeader("Content-Type", "application/json");
    res.end("true");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return {
    permissions,
    globalConfigs,
    get aborts() {
      return aborts;
    },
    connection: {
      url: `http://127.0.0.1:${addr.port}`,
      directory: "/tmp",
      authorization: "Basic fixture",
      exited: new Promise<never>(() => {}),
      close: async () => {},
    },
    close: async () => {
      stream?.end();
      globalStream?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const turnParams = (): OpenCodeTurnParams => ({
  model: { contextWindow: 32000 } as AIModel,
  system: "Company policy",
  messages: [{ role: "user", content: [{ type: "text", text: "Do the work" }] }],
  registry: residentOnlyRegistry([]),
  maxSteps: 4,
});

test("SDK session streams a completed turn and passes policy plus current request", async () => {
  const seen: string[] = [];
  const runtime = await fakeOpenCode(async (emit, body) => {
    assert.match(String(body.system), /Company policy/);
    assert.match(JSON.stringify(body.parts), /Do the work/);
    emit({
      id: "message",
      type: "message.updated",
      properties: { sessionID: "session", info: assistant() },
    });
    const part: Part = {
      id: "reply",
      sessionID: "session",
      messageID: "assistant",
      type: "text",
      text: "Finished",
    };
    const finish: Part = {
      id: "finish",
      sessionID: "session",
      messageID: "assistant",
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: assistant().tokens,
    };
    emit(updated(part));
    emit(updated(finish));
    return { info: assistant(), parts: [part, finish] };
  });
  try {
    const result = await runOpenCodeSession(runtime.connection, "fixture", {
      ...turnParams(),
      callbacks: { onText: (s) => seen.push(s) },
    });
    assert.deepEqual(result, { finalText: "Finished", steps: 1, stopReason: "end_turn" });
    assert.equal(seen.join(""), "Finished");
  } finally {
    await runtime.close();
  }
});

test("OpenAI sessions reconcile catalog limits through disposable global config before prompting", async () => {
  const runtime = await fakeOpenCode(
    async (_emit, body) => {
      assert.equal((body.model as { providerID: string }).providerID, "openai");
      assert.deepEqual(runtime.globalConfigs, [
        {
          provider: {
            openai: {
              models: { "gpt-4": { limit: { context: 8192, input: 8192, output: 4096 } } },
            },
          },
        },
      ]);
      return { info: assistant(), parts: [] };
    },
    { openAiModel: { id: "gpt-4", limit: { context: 8192, output: 8192 } } },
  );
  try {
    await runOpenCodeSession(runtime.connection, "gpt-4", {
      ...turnParams(),
      model: { provider: "openai", contextWindow: 8192 } as AIModel,
    });
  } finally {
    await runtime.close();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Fixture action did not arrive.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test("native permissions recheck Member authority, and scoped turns deny them", async () => {
  for (const nativeCoding of [false, true]) {
    let checked = 0;
    const runtime = await fakeOpenCode(async (emit) => {
      emit({
        id: "permission",
        type: "permission.asked",
        properties: {
          id: "request",
          sessionID: "session",
          permission: "bash",
          patterns: ["echo example"],
          metadata: {},
          always: [],
        },
      });
      await waitFor(() => runtime.permissions.length === 1);
      return { info: assistant(), parts: [] };
    });
    try {
      await runOpenCodeSession(runtime.connection, "fixture", {
        ...turnParams(),
        nativeCoding,
        authorizePrivilegedToolCall: async () => {
          checked++;
          return "Member authority was removed.";
        },
      });
      assert.equal(runtime.permissions[0].reply, "reject");
      assert.equal(checked, nativeCoding ? 1 : 0);
    } finally {
      await runtime.close();
    }
  }
});

test("step limit aborts the external session and reports unfinished work", async () => {
  const runtime = await fakeOpenCode(async (emit) => {
    emit(
      updated({
        id: "limit",
        sessionID: "session",
        messageID: "assistant",
        type: "step-finish",
        reason: "tool-calls",
        cost: 0,
        tokens: assistant().tokens,
      }),
    );
    await waitFor(() => runtime.aborts === 1);
    return { info: assistant(), parts: [] };
  });
  try {
    const result = await runOpenCodeSession(runtime.connection, "fixture", {
      ...turnParams(),
      maxSteps: 1,
    });
    assert.equal(result.stopReason, "max_steps");
    assert.equal(result.steps, 1);
  } finally {
    await runtime.close();
  }
});

test("cancellation reaches the headless session and returns an aborted result", async () => {
  const controller = new AbortController();
  const runtime = await fakeOpenCode(async () => {
    controller.abort();
    await waitFor(() => runtime.aborts === 1);
    return { info: assistant(), parts: [] };
  });
  try {
    const result = await runOpenCodeSession(runtime.connection, "fixture", {
      ...turnParams(),
      signal: controller.signal,
    });
    assert.equal(result.stopReason, "aborted");
  } finally {
    await runtime.close();
  }
});

test(
  "cancellation also interrupts a native permission reply that never completes",
  { timeout: 15_000 },
  async () => {
    const controller = new AbortController();
    const runtime = await fakeOpenCode(
      async (emit) => {
        emit({
          id: "permission",
          type: "permission.asked",
          properties: {
            id: "request",
            sessionID: "session",
            permission: "bash",
            patterns: ["echo example"],
            metadata: {},
            always: [],
          },
        });
        await waitFor(() => runtime.permissions.length === 1);
        controller.abort();
        await waitFor(() => runtime.aborts === 1);
        return { info: assistant(), parts: [] };
      },
      { hangControl: true },
    );
    try {
      const result = await runOpenCodeSession(runtime.connection, "fixture", {
        ...turnParams(),
        signal: controller.signal,
        nativeCoding: true,
      });
      assert.equal(result.stopReason, "aborted");
    } finally {
      await runtime.close();
    }
  },
);

test("context overflow can recover through compaction, while terminal overflow still fails", () => {
  const events = new OpenCodeEvents("session");
  const error = { name: "ContextOverflowError" as const, data: { message: "overflow" } };
  events.accept({
    id: "overflow",
    type: "session.error",
    properties: { sessionID: "session", error },
  });
  assert.equal(events.error, null);
  events.accept({
    id: "success",
    type: "message.updated",
    properties: { sessionID: "session", info: assistant("recovered") },
  });
  events.part({
    id: "recovered-text",
    type: "text",
    sessionID: "session",
    messageID: "recovered",
    text: "Complete after compaction",
  });
  assert.equal(events.finalText, "Complete after compaction");
  assert.equal(events.error, null);
  events.accept({
    id: "failure",
    type: "message.updated",
    properties: { sessionID: "session", info: { ...assistant("failed"), error } },
  });
  assert.match(events.error!.message, /context window/);
});

test("missing upstream usage stays unknown and provider errors preserve safe status", () => {
  let usages = 0;
  const events = new OpenCodeEvents("session", {
    onUsage: () => {
      usages++;
    },
  });
  events.part({
    id: "zero",
    sessionID: "session",
    messageID: "assistant",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  events.accept({
    id: "failure",
    type: "session.error",
    properties: {
      sessionID: "session",
      error: {
        name: "APIError",
        data: {
          message: "private response",
          responseBody: "secret",
          statusCode: 401,
          isRetryable: false,
        },
      },
    },
  });
  assert.equal(usages, 0);
  assert.equal((events.error as Error & { status: number }).status, 401);
  assert.doesNotMatch(events.error!.message, /private|secret/);
});

test("provider forwarding keeps the stored key out of child configuration and preserves retry headers", async () => {
  const observed: string[] = [];
  const upstream = createServer((req, res) => {
    observed.push(req.headers.authorization ?? "");
    req.resume();
    res
      .writeHead(503, { "Content-Type": "application/json", "Retry-After": "2" })
      .end(JSON.stringify({ error: { message: "retry" } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await serveOpenCodeModel({
    ...model,
    apiKey: "stored-key-stays-in-genosyn",
    baseURL: `http://127.0.0.1:${address.port}`,
  });
  try {
    assert.notEqual(proxy.model.apiKey, "stored-key-stays-in-genosyn");
    assert.doesNotMatch(
      JSON.stringify(
        buildOpenCodeConfig({
          model: proxy.model,
          maxSteps: 1,
          nativeCoding: true,
          mcp: { url: "http://localhost/mcp", token: "temporary" },
        }),
      ),
      /stored-key-stays-in-genosyn/,
    );
    assert.equal(
      (await fetch(`${proxy.model.baseURL}/chat/completions`, { method: "POST" })).status,
      401,
    );
    const headers = {
      Authorization: `Bearer ${proxy.model.apiKey}`,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(`${proxy.model.baseURL}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "another-model" }),
        })
      ).status,
      403,
    );
    const response = await fetch(`${proxy.model.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fixture" }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "2");
    await response.text();
    assert.deepEqual(observed, ["Bearer stored-key-stays-in-genosyn"]);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("startup diagnostics explain installation errors without exposing raw output", () => {
  assert.match(
    openCodeStartupError("Error: opencode-ai's postinstall script was not run. secret", 1),
    /install scripts enabled/,
  );
  assert.doesNotMatch(openCodeStartupError("ConfigInvalidError secret", 1), /secret/);
  assert.match(
    openCodeActivityError({ message: "secret", cause: { code: "ECONNRESET" } }).message,
    /ECONNRESET/,
  );
  assert.doesNotMatch(
    openCodeActivityError({ message: "secret", cause: { code: "private-secret" } }).message,
    /secret/,
  );
});
