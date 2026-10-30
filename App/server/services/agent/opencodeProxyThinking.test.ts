import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";

import { ApiKeyRing } from "./apiKeyRing.js";
import type { OpenCodeModel } from "./opencodeConfig.js";
import { refusesThinking, serveOpenCodeModel, withoutThinking } from "./opencodeProxy.js";

/**
 * A turn's thinking parameters, refused: the per-turn model proxy sends the
 * same request once more without them, before any reply reaches OpenCode,
 * and the rest of the turn goes without them — so a model or endpoint that
 * rejects a level falls back to its own default instead of failing the reply.
 */

describe("which parameters a fallback drops", () => {
  test("Claude: thinking and effort, giving back the room a budget took", () => {
    assert.deepEqual(
      withoutThinking("anthropic", {
        model: "claude-opus-4-7",
        max_tokens: 32_000,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "max" },
        messages: [],
      }),
      { model: "claude-opus-4-7", max_tokens: 32_000, messages: [] },
    );
    assert.deepEqual(
      withoutThinking("anthropic", {
        max_tokens: 8192 + 16_384,
        thinking: { type: "enabled", budget_tokens: 16_384 },
      }),
      { max_tokens: 8192 },
    );
    // Structured output is no thinking parameter; it stays.
    assert.deepEqual(
      withoutThinking("anthropic", {
        output_config: { effort: "high", format: { type: "json_schema" } },
      }),
      { output_config: { format: { type: "json_schema" } } },
    );
    assert.equal(withoutThinking("anthropic", { max_tokens: 8192, messages: [] }), null);
  });

  test("OpenAI: reasoning, and the encrypted reasoning it kept", () => {
    assert.deepEqual(
      withoutThinking("openai", {
        reasoning: { effort: "xhigh", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        store: false,
      }),
      { store: false },
    );
    assert.deepEqual(
      withoutThinking("openai", {
        reasoning: { effort: "high" },
        include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
      }),
      { include: ["message.output_text.logprobs"] },
    );
    assert.equal(withoutThinking("openai", { store: false }), null);
  });

  test("a custom endpoint: reasoning_effort", () => {
    assert.deepEqual(withoutThinking("custom", { reasoning_effort: "high", stream: true }), {
      stream: true,
    });
    assert.equal(withoutThinking("custom", { stream: true }), null);
  });
});

describe("which refusals are about thinking", () => {
  test("a 400 or 422 that names a thinking parameter", () => {
    assert.equal(
      refusesThinking(
        "anthropic",
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"thinking.type: adaptive thinking is not supported on this model"}}',
      ),
      true,
    );
    assert.equal(
      refusesThinking(
        "anthropic",
        400,
        '{"error":{"message":"output_config.effort: Input should be \'low\', \'medium\' or \'high\'"}}',
      ),
      true,
    );
    assert.equal(
      refusesThinking(
        "openai",
        400,
        '{"error":{"message":"Unsupported value: \'xhigh\' is not supported with this model.","param":"reasoning.effort"}}',
      ),
      true,
    );
    assert.equal(
      refusesThinking(
        "custom",
        422,
        '{"detail":[{"loc":["body","reasoning_effort"],"msg":"Extra inputs are not permitted"}]}',
      ),
      true,
    );
  });

  test("anything else is left to fail as it did", () => {
    assert.equal(
      refusesThinking("anthropic", 400, '{"error":{"message":"Your credit balance is too low."}}'),
      false,
    );
    assert.equal(refusesThinking("anthropic", 500, '{"error":{"message":"thinking failed"}}'), false);
    assert.equal(refusesThinking("anthropic", 429, '{"error":{"message":"effort"}}'), false);
    assert.equal(refusesThinking("custom", 400, '{"error":"model not found"}'), false);
    // A reasoning item replayed out of order is about the conversation, not the level.
    assert.equal(
      refusesThinking(
        "openai",
        400,
        '{"error":{"message":"Item \'rs_1\' of type \'reasoning\' was provided without its required following item.","param":"input"}}',
      ),
      false,
    );
  });

  test("a model that takes no reasoning at all is recognised by the parameter it names", () => {
    assert.equal(
      refusesThinking(
        "openai",
        400,
        '{"error":{"message":"Unsupported parameter: \'reasoning.summary\' is not supported with this model.","param":"reasoning.summary"}}',
      ),
      true,
    );
    assert.equal(
      refusesThinking("openai", 400, '{"error":{"message":"Unsupported parameter.","param":"reasoning"}}'),
      true,
    );
  });
});

type Reply = { status: number; body: string };
const OK: Reply = {
  status: 200,
  body: JSON.stringify({ id: "msg", type: "message", content: [{ type: "text", text: "Hi" }] }),
};
const THINKING_REFUSED: Reply = {
  status: 400,
  body: JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "thinking: not supported on this model" },
  }),
};

async function upstream(answer: (body: Record<string, unknown>, index: number) => Reply) {
  const seen: Array<{ key: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    seen.push({ key: String(req.headers["x-api-key"] ?? ""), body });
    const reply = answer(body, seen.length - 1);
    res.writeHead(reply.status, { "Content-Type": "application/json" }).end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    seen,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const THOUGHTFUL = {
  model: "claude-opus-4-7",
  max_tokens: 32_000,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "high" },
  messages: [{ role: "user", content: "hi" }],
};

async function claudeProxy(
  baseURL: string,
  options: { ring?: boolean } = {},
): Promise<{
  send: (body?: Record<string, unknown>) => Promise<Response>;
  refusals: number[];
  close: () => Promise<void>;
}> {
  const keys = [
    { id: "k1", apiKey: "sk-ant-api03-thinking-key-aaaaaaaa0001", preview: "sk-…0001" },
    { id: "k2", apiKey: "sk-ant-api03-thinking-key-bbbbbbbb0002", preview: "sk-…0002" },
  ];
  const model: OpenCodeModel = {
    id: "claude-opus-4-7",
    provider: "anthropic",
    apiKey: keys[0].apiKey,
    baseURL,
    contextWindow: null,
    ...(options.ring ? { keys: new ApiKeyRing("thinking-ring", keys) } : {}),
  };
  const refusals: number[] = [];
  const proxy = await serveOpenCodeModel(model, undefined, {
    onThinkingRefused: ({ status }) => refusals.push(status),
  });
  return {
    refusals,
    send: (body = THOUGHTFUL) =>
      fetch(`${proxy.model.baseURL}/messages`, {
        method: "POST",
        headers: { "x-api-key": proxy.model.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: () => proxy.close(),
  };
}

describe("the proxy falls back when the level is refused", () => {
  for (const ring of [false, true]) {
    test(`resends without the level and keeps the session without it${ring ? " (key pool)" : ""}`, async () => {
      const fake = await upstream((body) => (body.thinking ? THINKING_REFUSED : OK));
      const proxy = await claudeProxy(fake.baseURL, { ring });
      try {
        const first = await proxy.send();
        assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), JSON.parse(OK.body));
        assert.equal(fake.seen.length, 2);
        assert.ok(fake.seen[0].body.thinking);
        assert.equal(Object.hasOwn(fake.seen[1].body, "thinking"), false);
        assert.equal(Object.hasOwn(fake.seen[1].body, "output_config"), false);
        // The same key carries the resend: the refusal was about the request.
        assert.equal(fake.seen[1].key, fake.seen[0].key);
        assert.deepEqual(proxy.refusals, [400]);

        // The next request of the turn goes without the level from the start.
        const second = await proxy.send();
        assert.equal(second.status, 200);
        assert.equal(fake.seen.length, 3);
        assert.equal(Object.hasOwn(fake.seen[2].body, "thinking"), false);
        assert.deepEqual(proxy.refusals, [400], "heard once");
      } finally {
        await proxy.close();
        await fake.close();
      }
    });
  }

  test("a refusal about something else reaches OpenCode unchanged, without a resend", async () => {
    const credit: Reply = {
      status: 400,
      body: JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Your request is too large." },
      }),
    };
    const fake = await upstream(() => credit);
    const proxy = await claudeProxy(fake.baseURL);
    try {
      const response = await proxy.send();
      assert.equal(response.status, 400);
      assert.match(await response.text(), /too large/);
      assert.equal(fake.seen.length, 1);
      assert.deepEqual(proxy.refusals, []);
    } finally {
      await proxy.close();
      await fake.close();
    }
  });

  test("a request with nothing to drop is not sent twice", async () => {
    const fake = await upstream(() => THINKING_REFUSED);
    const proxy = await claudeProxy(fake.baseURL);
    try {
      const response = await proxy.send({
        model: "claude-opus-4-7",
        max_tokens: 8192,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(response.status, 400);
      assert.equal(fake.seen.length, 1);
      assert.deepEqual(proxy.refusals, []);
    } finally {
      await proxy.close();
      await fake.close();
    }
  });

  test("a resend that is refused too ends there, with the provider's answer", async () => {
    const fake = await upstream(() => THINKING_REFUSED);
    const proxy = await claudeProxy(fake.baseURL);
    try {
      const response = await proxy.send();
      assert.equal(response.status, 400);
      assert.equal(fake.seen.length, 2, "one resend, never a loop");
      assert.deepEqual(proxy.refusals, [400]);
    } finally {
      await proxy.close();
      await fake.close();
    }
  });
});
