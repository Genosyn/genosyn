import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AIModel } from "../../db/entities/AIModel.js";
import type { AgentMessage, AgentTool } from "./types.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";
import { buildOpenCodeConfig, type OpenCodeModel } from "./opencodeConfig.js";
import { serveOpenCodeTools } from "./opencodeMcp.js";
import { serveOpenCodeModel } from "./opencodeProxy.js";
import { startOpenCodeServer, type OpenCodeServer } from "./opencodeServer.js";
import { runOpenCodeSession, type OpenCodeTurnParams } from "./opencodeRuntime.js";
import { OpenCodeToolGate } from "./opencodeToolGate.js";

type ToolCall = { name: string; input: Record<string, unknown> };
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
  script: (request: Record<string, unknown>, index: number) => string | ToolCall | "hang",
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
function chatResponse(res: ServerResponse, value: string | ToolCall) {
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
  } else {
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "tool-fixture",
          type: "function",
          function: { name: value.name, arguments: JSON.stringify(value.input) },
        },
      ],
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
  const proxy = await serveOpenCodeModel(model, params.signal);
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
    await assert.rejects(access(path.dirname(owned.directory)), { code: "ENOENT" });
    await assert.rejects(fetch(owned.url, { signal: AbortSignal.timeout(2000) }));
    assert.throws(() => process.kill(owned.processId, 0), { code: "ESRCH" });
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
