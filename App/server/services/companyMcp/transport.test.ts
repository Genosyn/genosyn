import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isAllowedOrigin,
  jsonRpcError,
  MAX_BATCH_MESSAGES,
  normalizedAccept,
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
