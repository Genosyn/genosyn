import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { api } from "./api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Forms API client requests", () => {
  test("loads a public Form without adding session-only headers", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({ title: "Contact us" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    assert.deepEqual(await api.get<{ title: string }>("/api/forms/public-token"), {
      title: "Contact us",
    });
    assert.equal(seenUrl, "/api/forms/public-token");
    assert.equal(seenInit?.method, "GET");
    assert.equal(seenInit?.credentials, "same-origin");
    assert.equal(seenInit?.headers, undefined);
    assert.equal(seenInit?.body, undefined);
  });

  test("serializes response values and the idempotency id as JSON", async () => {
    let seenInit: RequestInit | undefined;
    globalThis.fetch = async (_input, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const body = {
      submissionId: "00000000-0000-4000-8000-000000000001",
      values: { name: "Ada", score: 10, consent: true, topics: ["sales"] },
    };

    assert.deepEqual(await api.post<{ ok: true }>("/api/forms/token/responses", body), {
      ok: true,
    });
    assert.equal(seenInit?.method, "POST");
    assert.deepEqual(seenInit?.headers, { "content-type": "application/json" });
    assert.equal(seenInit?.body, JSON.stringify(body));
  });

  test("surfaces the server's field or closed-Form error verbatim", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "This Form is not accepting responses" }), {
        status: 409,
        statusText: "Conflict",
      });
    await assert.rejects(
      api.post("/api/forms/token/responses", {}),
      /This Form is not accepting responses/,
    );
  });

  test("also understands APIs that answer with a message property", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "Check the highlighted answer" }), {
        status: 422,
        statusText: "Unprocessable Entity",
      });
    await assert.rejects(
      api.post("/api/forms/token/responses", {}),
      /Check the highlighted answer/,
    );
  });

  test("does not leak an HTML proxy page into the public error surface", async () => {
    globalThis.fetch = async () =>
      new Response("<html><h1>upstream exploded</h1></html>", {
        status: 502,
        statusText: "Bad Gateway",
      });
    await assert.rejects(
      api.post("/api/forms/token/responses", {}),
      /The server did not respond \(502\)/,
    );
  });

  test("falls back to status text for a malformed non-proxy error", async () => {
    globalThis.fetch = async () =>
      new Response("not JSON", { status: 422, statusText: "Unprocessable Entity" });
    await assert.rejects(
      api.post("/api/forms/token/responses", {}),
      /Unprocessable Entity \(422\)/,
    );
  });

  test("accepts a successful empty response without trying to parse it", async () => {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await api.del("/api/forms/token"), null);
  });
});
