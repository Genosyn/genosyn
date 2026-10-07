import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../../../config.js";
import type { AIModel } from "../../db/entities/AIModel.js";
import type { AgentMessage, AgentTool, ModelOutage } from "./types.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";
import { buildOpenCodeConfig, type OpenCodeModel } from "./opencodeConfig.js";
import { serveOpenCodeTools } from "./opencodeMcp.js";
import { serveOpenCodeModel } from "./opencodeProxy.js";
import {
  launchOpenCodeServer,
  OpenCodePortTakenError,
  startOpenCodeServer,
  type OpenCodeServer,
} from "./opencodeServer.js";
import {
  runOpenCodeSession,
  SILENT_STOP_NUDGE,
  SILENT_STOP_NUDGES,
  type OpenCodeTurnParams,
} from "./opencodeRuntime.js";
import { OpenCodeToolGate } from "./opencodeToolGate.js";

type ToolCall = { name: string; input: Record<string, unknown>; rawArguments?: string };
/** Text the provider stops early, the way a server ends a response at max_tokens. */
type TruncatedReply = { truncated: string };
/** A reply that is all reasoning, the way vLLM's reasoning parser returns a silent stop. */
type ReasoningOnlyReply = { reasoningOnly: string };
/** Several tool calls in one reply, as Qwen makes when it has a batch of records to write. */
type ParallelToolCalls = { parallel: ToolCall[] };
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const imageMessages: AgentMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Verify this tiny PNG and the supplied tools." },
      { type: "image", mimeType: "image/png", data: png, sourceLabel: "fixture.png" },
    ],
  },
];
function assertWireImage(body: Record<string, unknown>, provider: OpenCodeModel["provider"]) {
  const messages = (provider === "openai" ? body.input : body.messages) as Array<{
    content?: Array<Record<string, unknown>>;
  }>;
  const parts = messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  if (provider === "anthropic")
    assert.ok(
      parts.some(
        (part) =>
          part.type === "image" &&
          (part.source as { media_type?: string; data?: string })?.media_type === "image/png" &&
          Boolean((part.source as { data?: string }).data),
      ),
    );
  else if (provider === "openai")
    assert.ok(
      parts.some(
        (part) =>
          part.type === "input_image" &&
          String(part.image_url).startsWith("data:image/png;base64,"),
      ),
    );
  else
    assert.ok(
      parts.some(
        (part) =>
          part.type === "image_url" &&
          (part.image_url as { url?: string })?.url?.startsWith("data:image/png;base64,"),
      ),
    );
}
async function fakeProvider(
  script: (
    request: Record<string, unknown>,
    index: number,
  ) => string | ToolCall | TruncatedReply | ReasoningOnlyReply | ParallelToolCalls | "hang",
) {
  const requests: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString()) as Record<string, unknown>;
    requests.push({
      url: req.url!,
      auth: req.headers.authorization ?? req.headers["x-api-key"]?.toString(),
      body,
    });
    if (requests.length > 8) {
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message: "Fixture exceeded request count" } }));
      return;
    }
    const result = script(body, requests.length - 1);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (req.url?.endsWith("/chat/completions")) chatResponse(res, result);
    else if (req.url?.endsWith("/messages"))
      anthropicResponse(res, typeof result === "string" ? result : "Verified");
    else if (req.url?.endsWith("/responses"))
      responsesResponse(res, typeof result === "string" ? result : "Verified");
    else {
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function chatResponse(
  res: ServerResponse,
  value: string | ToolCall | TruncatedReply | ReasoningOnlyReply | ParallelToolCalls,
) {
  const send = (
    delta: Record<string, unknown>,
    finish: string | null = null,
    usage?: Record<string, number>,
  ) =>
    res.write(
      `data: ${JSON.stringify({ id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
    );
  if (typeof value === "string") {
    send({ role: "assistant", content: value === "hang" ? "Working" : value });
    if (value === "hang") return;
    send({}, "stop", { prompt_tokens: 29, completion_tokens: 5, total_tokens: 34 });
  } else if ("reasoningOnly" in value) {
    send({ role: "assistant", reasoning_content: value.reasoningOnly });
    send({}, "stop", { prompt_tokens: 29, completion_tokens: 18334, total_tokens: 18363 });
  } else if ("truncated" in value) {
    send({ role: "assistant", content: value.truncated });
    send({}, "length", { prompt_tokens: 29, completion_tokens: 8192, total_tokens: 8221 });
  } else {
    const calls = "parallel" in value ? value.parallel : [value];
    send({
      role: "assistant",
      tool_calls: calls.map((call, index) => ({
        index,
        id: `tool-fixture-${index}`,
        type: "function",
        function: {
          name: call.name,
          arguments: call.rawArguments ?? JSON.stringify(call.input),
        },
      })),
    });
    send({}, "tool_calls", { prompt_tokens: 23, completion_tokens: 4, total_tokens: 27 });
  }
  res.end("data: [DONE]\n\n");
}
function anthropicResponse(res: ServerResponse, text: string) {
  const send = (type: string, value: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send("message_start", {
    message: {
      id: "msg-fixture",
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 29, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  send("message_stop", {});
  res.end();
}
function responsesResponse(res: ServerResponse, text: string) {
  let sequence = 0;
  const send = (type: string, value: Record<string, unknown>) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
    );
  const item = {
    id: "msg-fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "resp-fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "fixture",
    output: [item],
    usage: {
      input_tokens: 29,
      output_tokens: 5,
      total_tokens: 34,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  };
  send("response.created", { response: { ...response, status: "in_progress", output: [] } });
  send("response.output_item.added", {
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  send("response.content_part.added", {
    item_id: "msg-fixture",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  send("response.output_text.delta", {
    item_id: "msg-fixture",
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  send("response.output_text.done", {
    item_id: "msg-fixture",
    output_index: 0,
    content_index: 0,
    text,
  });
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response });
  res.end();
}

async function realTurn(
  model: OpenCodeModel,
  tools: AgentTool[],
  overrides: Partial<OpenCodeTurnParams> = {},
  onServer?: (server: OpenCodeServer) => void,
  proxyOptions?: Parameters<typeof serveOpenCodeModel>[2],
) {
  const params: OpenCodeTurnParams = {
    model: { provider: model.provider, contextWindow: model.contextWindow } as AIModel,
    system: "Complete the requested work with the supplied tools.",
    messages: [{ role: "user", content: [{ type: "text", text: "Verify the fixture" }] }],
    registry: residentOnlyRegistry(tools),
    maxSteps: 4,
    signal: AbortSignal.timeout(150_000),
    ...overrides,
  };
  const gate = new OpenCodeToolGate(params.signal);
  const bridge = await serveOpenCodeTools({ ...params, beforeCall: (name) => gate.enter(name) });
  const proxy = await serveOpenCodeModel(model, params.signal, proxyOptions);
  let server: Awaited<ReturnType<typeof startOpenCodeServer>> | undefined;
  try {
    server = await startOpenCodeServer({
      config: buildOpenCodeConfig({
        model: proxy.model,
        maxSteps: params.maxSteps,
        nativeCoding: params.nativeCoding ?? false,
        mcp: bridge,
        effort: params.effort,
      }),
      cwd: params.cwd,
      signal: params.signal,
    });
    onServer?.(server);
    return await runOpenCodeSession(server, model.id, params, gate);
  } finally {
    gate.close();
    await server?.close();
    await proxy.close();
    await bridge.close();
  }
}

test(
  "pinned OpenCode performs a real custom-model MCP roundtrip with streamed usage",
  { timeout: 180_000 },
  async () => {
    let called = 0;
    const usage: unknown[] = [];
    const fixture = await fakeProvider((_body, index) =>
      index === 0 ? { name: "genosyn_fixture_echo", input: { value: "actual tool" } } : "Verified",
    );
    try {
      const result = await realTurn(
        {
          id: "fixture",
          provider: "custom",
          apiKey: "upstream-private-key",
          baseURL: fixture.baseURL,
          contextWindow: 32000,
        },
        [
          {
            name: "fixture_echo",
            description: "Verify actual tool execution",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
            async run(input) {
              assert.equal(input.value, "actual tool");
              called++;
              return { content: "Actual tool confirmed" };
            },
          },
        ],
        { messages: imageMessages, callbacks: { onUsage: (value) => usage.push(value) } },
      );
      assert.equal(called, 1);
      assert.equal(result.finalText, "Verified");
      assert.equal(result.stopReason, "end_turn");
      assert.equal(fixture.requests.length, 2);
      assert.ok(
        fixture.requests.every(
          (request) =>
            request.url === "/v1/chat/completions" &&
            request.auth === "Bearer upstream-private-key",
        ),
      );
      assert.ok(JSON.stringify(fixture.requests[1].body).includes("Actual tool confirmed"));
      assertWireImage(fixture.requests[0].body, "custom");
      assert.ok(usage.length >= 1);
    } finally {
      await fixture.close();
    }
  },
);

for (const provider of ["openai", "anthropic"] as const)
  test(
    `pinned OpenCode uses ${provider === "openai" ? "OpenAI Responses" : "Anthropic Messages"} with selected effort`,
    { timeout: 180_000 },
    async () => {
      const fixture = await fakeProvider(() => "Verified");
      const usage: Array<{ inputTokens: number; outputTokens: number }> = [];
      try {
        const result = await realTurn(
          {
            id: provider === "anthropic" ? "claude-3-haiku-20240307" : "fixture",
            provider,
            apiKey: "upstream-private-key",
            baseURL: fixture.baseURL,
            contextWindow: 200000,
          },
          [],
          {
            effort: "high",
            messages: imageMessages,
            callbacks: { onUsage: (value) => usage.push(value) },
          },
        );
        assert.equal(result.finalText, "Verified");
        assertWireImage(fixture.requests[0].body, provider);
        assert.deepEqual(usage, [{ inputTokens: 29, outputTokens: 5 }]);
        assert.equal(
          fixture.requests[0].url,
          provider === "openai" ? "/v1/responses" : "/v1/messages",
        );
        if (provider === "openai") {
          assert.equal((fixture.requests[0].body.reasoning as { effort?: string })?.effort, "high");
          assert.equal(fixture.requests[0].body.store, false);
          assert.ok(Number(fixture.requests[0].body.max_output_tokens) > 8192);
        } else {
          assert.equal(fixture.requests[0].body.max_tokens, 4096);
          assert.equal(
            (fixture.requests[0].body.output_config as { effort?: string })?.effort,
            "high",
          );
        }
      } finally {
        await fixture.close();
      }
    },
  );

for (const legacy of [
  { id: "gpt-4o", context: 128000, output: 16384 },
  { id: "gpt-4", context: 8192, output: 4096 },
])
  test(
    `pinned OpenCode respects ${legacy.id} output metadata without repeated compaction`,
    { timeout: 180_000 },
    async () => {
      const fixture = await fakeProvider(() => "Verified");
      try {
        const result = await realTurn(
          {
            id: legacy.id,
            provider: "openai",
            apiKey: "private",
            baseURL: fixture.baseURL,
            contextWindow: legacy.context,
          },
          [],
        );
        assert.equal(result.finalText, "Verified");
        assert.equal(fixture.requests.length, 1);
        assert.equal(fixture.requests[0].body.max_output_tokens, legacy.output);
      } finally {
        await fixture.close();
      }
    },
  );

test(
  "pinned OpenCode native coding writes a file and executes a command after live authorization",
  { timeout: 180_000 },
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "genosyn-opencode-code-test-"));
    let authorizations = 0;
    const calls: string[] = [];
    const fixture = await fakeProvider((_body, index) =>
      index === 0
        ? {
            name: "write",
            input: { filePath: path.join(cwd, "result.txt"), content: "changed by OpenCode" },
          }
        : index === 1
          ? {
              name: "bash",
              input: { command: "cat result.txt", description: "Read the changed file" },
            }
          : "Verified",
    );
    try {
      const result = await realTurn(
        {
          id: "fixture",
          provider: "custom",
          apiKey: "private",
          baseURL: fixture.baseURL,
          contextWindow: 32000,
        },
        [],
        {
          nativeCoding: true,
          cwd,
          authorizePrivilegedToolCall: async () => {
            authorizations++;
            return null;
          },
          callbacks: { onToolUse: (name) => calls.push(name) },
        },
      );
      assert.equal(result.finalText, "Verified");
      assert.equal(await readFile(path.join(cwd, "result.txt"), "utf8"), "changed by OpenCode");
      assert.ok(authorizations >= 2);
      assert.ok(calls.includes("write") && calls.includes("bash"));
    } finally {
      await fixture.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "pinned OpenCode cancellation stops an active stream and removes its private state",
  { timeout: 180_000 },
  async () => {
    let ownedServer: OpenCodeServer | undefined;
    const controller = new AbortController();
    const fixture = await fakeProvider(() => "hang");
    try {
      const result = await realTurn(
        {
          id: "fixture",
          provider: "custom",
          apiKey: "private",
          baseURL: fixture.baseURL,
          contextWindow: 32000,
        },
        [],
        {
          signal: controller.signal,
          callbacks: {
            onText: (text) => {
              if (text.includes("Working")) controller.abort();
            },
          },
        },
        (server) => {
          ownedServer = server;
        },
      );
      assert.equal(result.stopReason, "aborted");
      assert.ok(ownedServer);
      await assert.rejects(access(path.dirname(ownedServer.directory)), { code: "ENOENT" });
      await assert.rejects(fetch(ownedServer.url, { signal: AbortSignal.timeout(2000) }));
    } finally {
      controller.abort();
      await fixture.close();
    }
  },
);

test(
  "pinned OpenCode exits and removes private state when its parent exits normally",
  { timeout: 180_000 },
  async () => {
    const script = `
    import { startOpenCodeServer } from './server/services/agent/opencodeServer.ts';
    process.on('SIGTERM', () => process.exit(1));
    const server = await startOpenCodeServer({ config: { share: 'disabled', autoupdate: false, plugin: [], permission: { '*': 'deny' } }, signal: AbortSignal.timeout(120000) });
    process.stdout.write(JSON.stringify({ url: server.url, directory: server.directory, processId: server.processId }), () => process.exit(0));
  `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        signal: AbortSignal.timeout(150_000),
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.resume();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0);
    const owned = JSON.parse(output) as { url: string; directory: string; processId: number };
    // Parent exit does not wait for child reaping. Linux may retain a terminated
    // orphan as a zombie, for which kill(pid, 0) still succeeds.
    const stopDeadline = Date.now() + 5000;
    for (;;) {
      try {
        process.kill(owned.processId, 0);
        if (process.platform === "linux") {
          const status = await readFile(`/proc/${owned.processId}/status`, "utf8");
          if (/^State:\s+[ZX]\b/m.test(status)) break;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH" || (process.platform === "linux" && code === "ENOENT")) break;
        throw error;
      }
      assert.ok(Date.now() < stopDeadline, "OpenCode remained running after its parent exited.");
      await delay(25);
    }
    await assert.rejects(access(path.dirname(owned.directory)), { code: "ENOENT" });
    await assert.rejects(fetch(owned.url, { signal: AbortSignal.timeout(2000) }));
  },
);

test(
  "pinned OpenCode consecutive turns have isolated local transports and server ports",
  { timeout: 300_000 },
  async () => {
    const fixture = await fakeProvider(() => "Verified");
    const ports: string[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const result = await realTurn(
          {
            id: "fixture",
            provider: "custom",
            apiKey: "private",
            baseURL: fixture.baseURL,
            contextWindow: 32000,
          },
          [],
          {},
          (server) => {
            ports.push(new URL(server.url).port);
          },
        );
        assert.equal(result.finalText, "Verified");
      }
      assert.equal(new Set(ports).size, 2);
      assert.equal(fixture.requests.length, 2);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "pinned OpenCode names a port another socket already holds as taken",
  { timeout: 180_000 },
  async () => {
    // A port is free when chosen but can be taken before OpenCode binds it;
    // startOpenCodeServer retries only on this error, so it must be recognized.
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const address = holder.address();
    assert.ok(address && typeof address !== "string");
    try {
      await assert.rejects(
        launchOpenCodeServer(
          {
            config: {
              share: "disabled",
              autoupdate: false,
              plugin: [],
              permission: { "*": "deny" },
            },
            signal: AbortSignal.timeout(150_000),
          },
          address.port,
        ),
        (error) => {
          assert.ok(error instanceof OpenCodePortTakenError);
          assert.match(error.message, /already in use/);
          return true;
        },
      );
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  },
);

const customFixtureModel = (baseURL: string): OpenCodeModel => ({
  id: "fixture",
  provider: "custom",
  apiKey: "private",
  baseURL,
  contextWindow: 32000,
});

function echoTool(calls: Array<Record<string, unknown>>): AgentTool {
  return {
    name: "fixture_echo",
    description: "Verify actual tool execution",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    async run(input) {
      calls.push(input);
      return { content: "Actual tool confirmed" };
    },
  };
}

// Small models get tool calls wrong in two ways OpenCode can repair: a name it
// does not know (Genosyn's prompts say `call_tool`; OpenCode says
// `genosyn_call_tool`) and arguments that are not JSON. Both must come back to
// the model as an explanation it can act on.
for (const mistake of [
  {
    label: "an unprefixed tool name",
    call: { name: "fixture_echo", input: { value: "actual tool" } },
    mentions: "unavailable tool 'fixture_echo'",
  },
  {
    label: "unparseable tool arguments",
    call: { name: "genosyn_fixture_echo", input: {}, rawArguments: '{"value": "unterminated' },
    mentions: "genosyn_fixture_echo",
  },
])
  test(
    `pinned OpenCode explains ${mistake.label} back to the model`,
    { timeout: 180_000 },
    async () => {
      const calls: Array<Record<string, unknown>> = [];
      const fixture = await fakeProvider((_body, index) =>
        index === 0 ? mistake.call : "Recovered",
      );
      try {
        const result = await realTurn(customFixtureModel(fixture.baseURL), [echoTool(calls)]);
        assert.equal(result.finalText, "Recovered");
        assert.equal(calls.length, 0, "a malformed call never runs a Genosyn tool");
        assert.equal(fixture.requests.length, 2);
        const followUp = JSON.stringify(fixture.requests[1].body);
        assert.match(followUp, /The arguments provided to the tool are invalid/);
        assert.ok(followUp.includes(mistake.mentions), followUp);
        assert.doesNotMatch(followUp, /unavailable tool 'invalid'/);
      } finally {
        await fixture.close();
      }
    },
  );

test(
  "pinned OpenCode shows a Run's time check beside a Genosyn tool result",
  { timeout: 180_000 },
  async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fixture = await fakeProvider((_body, index) =>
      index === 0 ? { name: "genosyn_fixture_echo", input: { value: "actual tool" } } : "Verified",
    );
    try {
      const registry = residentOnlyRegistry([echoTool(calls)]);
      registry.resultNotice = () =>
        "[Time check] Under 3 minutes remain before this Run's hard deadline (13:00 UTC).";
      const result = await realTurn(customFixtureModel(fixture.baseURL), [], { registry });
      assert.equal(result.finalText, "Verified");
      assert.equal(calls.length, 1);
      const followUp = JSON.stringify(fixture.requests[1].body);
      assert.ok(followUp.includes("Actual tool confirmed"));
      assert.ok(followUp.includes("[Time check] Under 3 minutes remain"));
    } finally {
      await fixture.close();
    }
  },
);

test(
  "pinned OpenCode reports a response cut off at its output limit as a length stop",
  { timeout: 180_000 },
  async () => {
    const fixture = await fakeProvider(() => ({ truncated: "First I will check the ledger and" }));
    try {
      const result = await realTurn(customFixtureModel(fixture.baseURL), []);
      assert.equal(result.stopReason, "length");
      assert.equal(fixture.requests.length, 1, "OpenCode does not continue a truncated reply");
      assert.equal(fixture.requests[0].body.max_tokens, 8000, "a quarter of the 32K window");
    } finally {
      await fixture.close();
    }
  },
);

// 2026-10-02: a YouTube prospecting Run on Qwen thought for 18,334 tokens,
// then ended its turn with no reply and no tool call, and was recorded as
// Completed with nothing done.
test(
  "pinned OpenCode asks a work turn that stopped silently to continue in the same session",
  { timeout: 180_000 },
  async () => {
    const fixture = await fakeProvider((_body, index) =>
      index === 0
        ? { reasoningOnly: "Next I should research the channels." }
        : "Researched 4 channels.",
    );
    try {
      const silentStops: number[] = [];
      const result = await realTurn(customFixtureModel(fixture.baseURL), [], {
        maxSteps: null,
        callbacks: { onSilentStop: () => silentStops.push(fixture.requests.length) },
      });
      assert.equal(result.finalText, "Researched 4 channels.");
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(silentStops, [1]);
      assert.equal(fixture.requests.length, 2);
      const nudge = JSON.stringify(fixture.requests[1].body);
      assert.ok(nudge.includes(SILENT_STOP_NUDGE.slice(0, 60)));
      assert.ok(nudge.includes("Verify the fixture"), "the nudge continues the same conversation");
    } finally {
      await fixture.close();
    }
  },
);

test(
  "pinned OpenCode asks a silent work turn once and leaves a bounded turn alone",
  { timeout: 180_000 },
  async () => {
    const silent = await fakeProvider(() => ({ reasoningOnly: "Still thinking." }));
    try {
      const result = await realTurn(customFixtureModel(silent.baseURL), [], { maxSteps: null });
      assert.equal(result.finalText, "");
      assert.equal(silent.requests.length, 1 + SILENT_STOP_NUDGES);
    } finally {
      await silent.close();
    }
    const bounded = await fakeProvider(() => ({ reasoningOnly: "Noted." }));
    try {
      const result = await realTurn(customFixtureModel(bounded.baseURL), [], { maxSteps: 4 });
      assert.equal(result.finalText, "");
      assert.equal(bounded.requests.length, 1, "a bounded turn such as grading is not nudged");
    } finally {
      await bounded.close();
    }
  },
);

// 2026-10-02: restarting the vLLM server behind the self-hosted Qwen model
// ended both Runs working on it with "The AI Model request failed (HTTP 502)"
// once OpenCode's minute of retries ran out; the server was back minutes later.
test(
  "pinned OpenCode waits out a self-hosted model server that stops answering mid-turn",
  { timeout: 180_000 },
  async () => {
    let down = true;
    let restart: NodeJS.Timeout | undefined;
    const posts: boolean[] = [];
    const upstream = createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      if (req.method === "POST") posts.push(down);
      // The server comes back 1.5s after the turn's first model request.
      if (req.method === "POST") restart ??= setTimeout(() => (down = false), 1_500);
      if (down) {
        res.writeHead(502, { "Content-Type": "text/plain" }).end("upstream unavailable");
        return;
      }
      if (req.method === "GET") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      chatResponse(res, "Recovered after the restart.");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    try {
      const outages: ModelOutage[] = [];
      const retries: number[] = [];
      const result = await realTurn(
        customFixtureModel(`http://127.0.0.1:${address.port}/v1`),
        [],
        { maxSteps: null, callbacks: { onModelRetry: (retry) => retries.push(retry.attempt) } },
        undefined,
        { holdOutages: true, probeMs: 100, onOutage: (outage) => outages.push(outage) },
      );
      assert.equal(result.finalText, "Recovered after the restart.");
      assert.deepEqual(
        outages.map((outage) => outage.state),
        ["waiting", "answered"],
      );
      assert.ok(outages[1].waitedMs >= 1_000);
      assert.deepEqual(posts, [true, false], "the held request was sent again, once");
      assert.deepEqual(retries, [], "OpenCode never saw the outage, so it spent no retries");
    } finally {
      if (restart) clearTimeout(restart);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);

// 2026-10-02: a Daily Partner Prospecting Run asked for five partnership records
// at once with an unlisted tool name. OpenCode repairs each call into the same
// `invalid` call, and three identical calls in a row trip its repeat guard,
// which fell under "*": "deny": the denial failed the turn after 52 minutes.
for (const repeated of [
  {
    label: "three calls to an unlisted tool",
    calls: ["Acme", "Globex", "Initech"].map((value) => ({
      name: "fixture_create",
      input: { value },
    })),
    runs: 0,
  },
  {
    label: "three identical calls to a Genosyn tool",
    calls: [1, 2, 3].map(() => ({ name: "genosyn_fixture_echo", input: { value: "same" } })),
    runs: 3,
  },
])
  test(
    `pinned OpenCode lets a work turn make ${repeated.label} in one reply and carry on`,
    { timeout: 180_000 },
    async () => {
      const calls: Array<Record<string, unknown>> = [];
      const fixture = await fakeProvider((_body, index) =>
        index === 0 ? { parallel: repeated.calls } : "Recovered after repeating.",
      );
      try {
        const result = await realTurn(customFixtureModel(fixture.baseURL), [echoTool(calls)], {
          maxSteps: null,
        });
        assert.equal(result.finalText, "Recovered after repeating.");
        assert.equal(result.stopReason, "end_turn");
        assert.equal(calls.length, repeated.runs);
        assert.equal(fixture.requests.length, 2);
      } finally {
        await fixture.close();
      }
    },
  );

// 2026-10-02: an operator asked that Genosyn pick up a new model when vLLM is
// restarted with one; the old id is answered "The model … does not exist".
test(
  "pinned OpenCode carries a turn onto the one model a restarted server now serves",
  { timeout: 180_000 },
  async () => {
    const posted: string[] = [];
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.method === "GET") {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ object: "list", data: [{ id: "fixture-next", object: "model" }] }));
        return;
      }
      const model = (JSON.parse(Buffer.concat(chunks).toString()) as { model: string }).model;
      posted.push(model);
      if (model !== "fixture-next") {
        res.writeHead(404, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            error: { message: `The model \`${model}\` does not exist.`, param: "model", code: 404 },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      chatResponse(res, "Answered by the new model.");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const changes: string[] = [];
    // The server's model list is read through the outbound address check.
    const privateHosts = [...config.security.outboundPrivateHostAllowlist];
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
    try {
      const result = await realTurn(
        customFixtureModel(`http://127.0.0.1:${address.port}/v1`),
        [],
        {},
        undefined,
        { onServedModelChange: ({ from, to }) => changes.push(`${from} -> ${to.id}`) },
      );
      assert.equal(result.finalText, "Answered by the new model.");
      assert.deepEqual(changes, ["fixture -> fixture-next"]);
      assert.deepEqual(posted, ["fixture", "fixture-next"]);
    } finally {
      config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...privateHosts);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);
