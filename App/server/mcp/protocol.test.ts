import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { STATIC_TOOLS } from "./toolManifest.js";
import {
  MCP_CAPABILITIES,
  MCP_PROTOCOL_VERSION,
  runMcpBatch,
} from "./protocol.js";
import { resolveMcpToken } from "../services/mcpTokens.js";

const realFetch = globalThis.fetch;
let seenTokens: string[] = [];

beforeEach(() => {
  seenTokens = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status: 200, ...init },
  );
}

function captureToken(init?: RequestInit): string {
  const headers = new Headers(init?.headers);
  const authorization = headers.get("authorization") ?? "";
  assert.match(authorization, /^Bearer [a-f0-9]{64}$/);
  const token = authorization.slice("Bearer ".length);
  seenTokens.push(token);
  return token;
}

describe("MCP JSON-RPC envelope", () => {
  test("negotiates the requested protocol and reports server capabilities", async () => {
    const [reply] = await runMcpBatch(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05" },
        },
      ],
      { employeeId: "employee", companyId: "company" },
    );
    assert.equal(reply.id, 1);
    assert.deepEqual(
      (reply.result as { capabilities: unknown }).capabilities,
      MCP_CAPABILITIES,
    );
    assert.equal(
      (reply.result as { protocolVersion: string }).protocolVersion,
      "2024-11-05",
    );
    assert.match(
      (reply.result as { serverInfo: { version: string } }).serverInfo.version,
      /^\d+\.\d+\.\d+/,
    );
  });

  test("uses the current protocol when the client omits one", async () => {
    const [reply] = await runMcpBatch(
      [{ id: "init", method: "initialize", params: {} }],
      { employeeId: "employee", companyId: "company" },
    );
    assert.equal(
      (reply.result as { protocolVersion: string }).protocolVersion,
      MCP_PROTOCOL_VERSION,
    );
  });

  test("answers ping and preserves explicit null ids", async () => {
    const replies = await runMcpBatch(
      [
        { id: "ping", method: "ping" },
        { id: null, method: "ping" },
      ],
      { employeeId: "employee", companyId: "company" },
    );
    assert.deepEqual(replies, [
      { jsonrpc: "2.0", id: "ping", result: {} },
      { jsonrpc: "2.0", id: null, result: {} },
    ]);
  });

  test("never replies to notifications, peer responses, or malformed values", async () => {
    const replies = await runMcpBatch(
      [
        { method: "ping" },
        { method: "initialize", params: {} },
        { method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 3, result: {} },
        null,
        "junk",
      ],
      { employeeId: "employee", companyId: "company" },
    );
    assert.deepEqual(replies, []);
  });

  test("reports unknown methods and invalid tool calls with standard codes", async () => {
    globalThis.fetch = async () => response({ tools: [] });
    const replies = await runMcpBatch(
      [
        { id: 1, method: "unknown" },
        { id: 2, method: "tools/call", params: {} },
        { id: 3, method: "tools/call", params: { name: "missing", arguments: {} } },
      ],
      { employeeId: "employee", companyId: "company" },
    );
    assert.deepEqual(replies.map((reply) => reply.error?.code), [-32601, -32602, -32602]);
    assert.match(replies[2].error?.message ?? "", /Unknown tool: missing/);
  });
});

describe("MCP tool catalogue and dispatch", () => {
  test("combines static tools with valid Connection tools and filters malformed rows", async () => {
    globalThis.fetch = async (_input, init) => {
      captureToken(init);
      return response({
        tools: [
          {
            name: "stripe_us__get_balance",
            description: "Get balance",
            inputSchema: { type: "object" },
            connectionId: "connection",
            providerToolName: "get_balance",
          },
          { name: "broken" },
          null,
        ],
      });
    };
    const [reply] = await runMcpBatch(
      [{ id: 1, method: "tools/list" }],
      { employeeId: "employee", companyId: "company" },
    );
    const tools = (reply.result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, STATIC_TOOLS.length + 1);
    assert.equal(tools.at(-1)?.name, "stripe_us__get_balance");
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    assert.equal(resolveMcpToken(seenTokens[0]), null);
  });

  test("dispatches a static tool to its exact internal endpoint", async () => {
    const tool = STATIC_TOOLS[0];
    let requestedUrl = "";
    let requestedBody = "";
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body);
      captureToken(init);
      return response({ ok: true, tool: tool.name });
    };
    const [reply] = await runMcpBatch(
      [
        {
          id: 1,
          method: "tools/call",
          params: { name: tool.name, arguments: { value: 42 } },
        },
      ],
      { employeeId: "employee", companyId: "company" },
    );
    assert.match(requestedUrl, new RegExp(`/tools/${tool.name}$`));
    assert.deepEqual(JSON.parse(requestedBody), { value: 42 });
    assert.equal(
      JSON.parse(
        ((reply.result as { content: Array<{ text: string }> }).content[0]).text,
      ).tool,
      tool.name,
    );
    assert.equal(resolveMcpToken(seenTokens[0]), null);
  });

  test("resolves and invokes a Connection-backed tool", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      captureToken(init);
      if (String(input).endsWith("/integrations/_list")) {
        return response({
          tools: [
            {
              name: "stripe_us__get_balance",
              description: "Get balance",
              inputSchema: { type: "object" },
              connectionId: "connection",
              providerToolName: "get_balance",
            },
          ],
        });
      }
      return response({ balance: 100 });
    };
    const [reply] = await runMcpBatch(
      [
        {
          id: 1,
          method: "tools/call",
          params: { name: "stripe_us__get_balance", arguments: { currency: "USD" } },
        },
      ],
      { employeeId: "employee", companyId: "company" },
    );
    assert.match(urls[0], /\/integrations\/_list$/);
    assert.match(urls[1], /\/integrations\/invoke$/);
    assert.deepEqual(bodies[1], {
      connectionId: "connection",
      toolName: "get_balance",
      args: { currency: "USD" },
    });
    assert.equal(
      JSON.parse((reply.result as { content: Array<{ text: string }> }).content[0].text)
        .balance,
      100,
    );
    assert.equal(new Set(seenTokens).size, 1, "one short-lived token serves the whole batch");
    assert.equal(resolveMcpToken(seenTokens[0]), null);
  });

  test("turns internal HTTP, JSON, and network failures into model-visible errors", async () => {
    const tool = STATIC_TOOLS[0];
    const cases: Array<{
      fetcher: typeof fetch;
      expected: RegExp;
    }> = [
      {
        fetcher: async () => response({ error: "denied" }, { status: 403 }),
        expected: /denied/,
      },
      {
        fetcher: async () => response("<html>broken</html>", { status: 502 }),
        expected: /non-JSON \(502\)/,
      },
      {
        fetcher: async () => {
          throw new Error("socket closed");
        },
        expected: /Could not reach Genosyn API: socket closed/,
      },
    ];
    for (const entry of cases) {
      globalThis.fetch = entry.fetcher;
      const [reply] = await runMcpBatch(
        [{ id: 1, method: "tools/call", params: { name: tool.name } }],
        { employeeId: "employee", companyId: "company" },
      );
      const result = reply.result as {
        content: Array<{ text: string }>;
        isError?: true;
      };
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, entry.expected);
    }
  });

  test("contains control-surface failures as JSON-RPC errors and continues the batch", async () => {
    globalThis.fetch = async () => response("offline", { status: 503 });
    const replies = await runMcpBatch(
      [
        { id: 1, method: "tools/list" },
        { id: 2, method: "ping" },
      ],
      { employeeId: "employee", companyId: "company" },
    );
    assert.equal(replies[0].error?.code, -32000);
    assert.match(replies[0].error?.message ?? "", /HTTP 503/);
    assert.deepEqual(replies[1].result, {});
  });
});
