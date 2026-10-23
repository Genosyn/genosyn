import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  batchProblem,
  isAllowedOrigin,
  jsonRpcError,
  longestQuotedBase64,
  MAX_BATCH_MESSAGES,
  normalizedAccept,
  oversizedBodyProblem,
  PLAIN_BODY_LIMIT_BYTES,
} from "./transport.js";

/** The Streamable HTTP rules applied before a message reaches the MCP server. */

describe("browser origins", () => {
  const publicUrl = "https://genosyn.example.com";

  test("no Origin is an MCP client, and welcome", () => {
    assert.equal(isAllowedOrigin(undefined, publicUrl), true);
    assert.equal(isAllowedOrigin("", publicUrl), true);
  });

  test("this install's own origin is welcome, compared as an origin", () => {
    assert.equal(isAllowedOrigin("https://genosyn.example.com", publicUrl), true);
    assert.equal(isAllowedOrigin("https://GENOSYN.example.com", publicUrl), true);
    assert.equal(isAllowedOrigin("https://genosyn.example.com:443", publicUrl), true);
    assert.equal(isAllowedOrigin("http://localhost:8471", "http://localhost:8471"), true);
  });

  test("every other origin is refused", () => {
    for (const origin of [
      "https://evil.example",
      "http://genosyn.example.com",
      "https://genosyn.example.com:8443",
      "https://genosyn.example.com.evil.example",
      "null",
      "file://",
      "https://genosyn.example.com, https://evil.example",
      "not a url",
    ]) {
      assert.equal(isAllowedOrigin(origin, publicUrl), false, origin);
    }
  });

  test("a broken public URL refuses every browser origin", () => {
    assert.equal(isAllowedOrigin("https://genosyn.example.com", "not a url"), false);
    assert.equal(isAllowedOrigin(undefined, "not a url"), true);
  });
});

describe("Accept", () => {
  const both = "application/json, text/event-stream";

  test("a client that accepts JSON is treated as accepting both", () => {
    for (const accept of [
      undefined,
      "",
      "*/*",
      "application/*",
      "application/json",
      "Application/JSON",
      "application/json;q=0.9, text/plain",
    ]) {
      assert.equal(normalizedAccept(accept), both, String(accept));
    }
  });

  test("one that already lists both is left alone", () => {
    assert.equal(normalizedAccept("application/json, text/event-stream"), null);
    assert.equal(normalizedAccept("text/event-stream, application/json"), null);
  });

  test("one that rules JSON out is left for the SDK to refuse", () => {
    assert.equal(normalizedAccept("text/html"), null);
    assert.equal(normalizedAccept("text/event-stream"), null);
  });
});

describe("JSON-RPC refusals", () => {
  test("carry no request id, a code and a message", () => {
    assert.deepEqual(jsonRpcError(-32700, "Parse error"), {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
    assert.equal(MAX_BATCH_MESSAGES, 20);
  });
});

describe("bodies past 1 MB", () => {
  const MB = 1024 * 1024;
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));

  test("up to 1 MB, anything goes to the parser", () => {
    assert.equal(
      oversizedBodyProblem(json({ values: Array.from({ length: 1_000 }, () => ({})) })),
      null,
    );
    assert.equal(oversizedBodyProblem(Buffer.alloc(PLAIN_BODY_LIMIT_BYTES, 0x20)), null);
  });

  test("past it, one base64 string must carry all but 1 MB", () => {
    const file = "QUJD".repeat(2 * MB);
    assert.equal(
      oversizedBodyProblem(json({ arguments: { file: { name: "a.pdf", base64: file } } })),
      null,
    );
    // URL-safe base64 counts too.
    assert.equal(oversizedBodyProblem(json({ file: "-_-_".repeat(MB) })), null);
    // Up to 1 MB of other content beside it is fine.
    assert.equal(oversizedBodyProblem(json({ file, notes: "x y".repeat(300_000) })), null);
  });

  test("many small values, prose, or a bare number are refused", () => {
    const message = /past 1 MB, a request may carry only a file/;
    assert.match(
      String(oversizedBodyProblem(json(Array.from({ length: 500_000 }, () => ({}))))),
      message,
    );
    assert.match(
      String(oversizedBodyProblem(json({ text: 'say "hi"\n'.repeat(200_000) }))),
      message,
    );
    assert.match(
      String(oversizedBodyProblem(Buffer.from(`{"n": ${"1".repeat(2 * MB)}}`))),
      message,
    );
    // Two medium strings are not one file.
    const half = "QUJD".repeat(MB / 4 + 1);
    assert.match(String(oversizedBodyProblem(json({ a: half, b: half, c: half }))), message);
  });

  test("the longest base64 run counts only when quoted on both sides", () => {
    assert.equal(longestQuotedBase64(Buffer.from('{"a":"QUJD","b":"QUJDQUJD"}')), 8);
    assert.equal(longestQuotedBase64(Buffer.from("[QUJDQUJD]")), 0);
    assert.equal(longestQuotedBase64(Buffer.from('"QUJD')), 0);
    assert.equal(longestQuotedBase64(Buffer.from('"QUJD\\nQUJD"')), 0, "an escape breaks the run");
    assert.equal(longestQuotedBase64(Buffer.from("")), 0);
  });
});

describe("batches", () => {
  test("a single message, or a batch of distinct ids, is fine", () => {
    assert.equal(batchProblem({ jsonrpc: "2.0", id: 1, method: "ping" }), null);
    assert.equal(
      batchProblem([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: "1", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 1, result: {} },
      ]),
      null,
      "a number and a string are different ids; notifications and responses carry none to clash",
    );
  });

  test("a repeated id or an oversized batch is refused", () => {
    assert.match(
      String(
        batchProblem([
          { jsonrpc: "2.0", id: "a", method: "ping" },
          { jsonrpc: "2.0", id: "a", method: "tools/list" },
        ]),
      ),
      /a is repeated/,
    );
    assert.match(
      String(
        batchProblem(
          Array.from({ length: 21 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" })),
        ),
      ),
      /at most 20/,
    );
  });
});
