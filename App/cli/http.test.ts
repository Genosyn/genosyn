import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CliError } from "./errors.js";
import {
  errorFromResponse,
  networkError,
  redactHeaders,
  sendRequest,
  USER_AGENT,
  type HttpOptions,
  type HttpRequest,
} from "./http.js";
import { API_KEY, json } from "./test/support.js";

function options(fetch: typeof globalThis.fetch, extra: Partial<HttpOptions> = {}): HttpOptions {
  return { fetch, timeoutMs: 5_000, now: () => 0, sleep: async () => {}, ...extra };
}

const GET: HttpRequest = {
  method: "GET",
  url: "https://g.test/api/x",
  headers: { authorization: `Bearer ${API_KEY}` },
  operationId: "getX",
};

function scripted(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function failure(code: string, message = code): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });
}

describe("sendRequest", () => {
  test("sends the headers, never follows redirects, and parses JSON", async () => {
    const { fetch, calls } = scripted([json({ ok: true })]);
    const response = await sendRequest(GET, options(fetch));
    assert.equal(response.status, 200);
    assert.equal(response.isJson, true);
    assert.deepEqual(response.json, { ok: true });
    assert.equal(response.mediaType, "application/json");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.equal(headers.get("user-agent"), USER_AGENT);
    assert.equal(calls[0].init.redirect, "manual");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  test("keeps a non-JSON body as bytes and text", async () => {
    const { fetch } = scripted([
      new Response("a,b\n1,2\n", { headers: { "content-type": "text/csv; charset=utf-8" } }),
    ]);
    const response = await sendRequest(GET, options(fetch));
    assert.equal(response.isJson, false);
    assert.equal(response.mediaType, "text/csv");
    assert.equal(response.text(), "a,b\n1,2\n");
    assert.equal(response.bytes.byteLength, 8);
  });

  test("treats broken JSON as text rather than failing", async () => {
    const { fetch } = scripted([
      new Response("{nope", { headers: { "content-type": "application/json" } }),
    ]);
    const response = await sendRequest(GET, options(fetch));
    assert.equal(response.isJson, false);
    assert.equal(response.text(), "{nope");
  });

  test("reports a redirect instead of following it with the key", async () => {
    const { fetch, calls } = scripted([
      new Response(null, { status: 301, headers: { location: "https://other.test/api/x" } }),
    ]);
    await assert.rejects(
      sendRequest(GET, options(fetch)),
      (error: unknown) =>
        error instanceof CliError &&
        error.kind === "network" &&
        error.exitCode === 9 &&
        /redirected to https:\/\/other\.test\/api\/x/.test(error.message),
    );
    assert.equal(calls.length, 1);
  });

  test("hands back a 304 Not Modified rather than treating it as a redirect", async () => {
    const { fetch } = scripted([new Response(null, { status: 304 })]);
    const response = await sendRequest(GET, options(fetch));
    assert.equal(response.status, 304);
    assert.equal(response.bytes.byteLength, 0);
  });

  test("retries a GET twice on a gateway error, then answers", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = scripted([
      new Response("bad", { status: 503 }),
      new Response("bad", { status: 502 }),
      json({ ok: true }),
    ]);
    const response = await sendRequest(GET, options(fetch, { sleep: async (ms) => void sleeps.push(ms) }));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [500, 1500]);
  });

  test("gives back the last gateway error once retries run out", async () => {
    const { fetch, calls } = scripted([
      new Response("x", { status: 504 }),
      new Response("x", { status: 504 }),
      new Response("x", { status: 504 }),
    ]);
    const response = await sendRequest(GET, options(fetch));
    assert.equal(response.status, 504);
    assert.equal(calls.length, 3);
  });

  test("never repeats a write", async () => {
    const { fetch, calls } = scripted([new Response("x", { status: 503 }), failure("ECONNRESET")]);
    const response = await sendRequest({ ...GET, method: "POST" }, options(fetch));
    assert.equal(response.status, 503);
    assert.equal(calls.length, 1);
    const second = scripted([failure("ECONNREFUSED")]);
    await assert.rejects(sendRequest({ ...GET, method: "DELETE" }, options(second.fetch)), /refused/);
    assert.equal(second.calls.length, 1);
  });

  test("retries a GET that could not connect", async () => {
    const { fetch, calls } = scripted([failure("ECONNREFUSED"), json({ ok: 1 })]);
    const response = await sendRequest(GET, options(fetch));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
  });

  test("does not retry a timeout", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { fetch, calls } = scripted([timeout, json({})]);
    await assert.rejects(
      sendRequest(GET, options(fetch, { timeoutMs: 2_000 })),
      (error: unknown) => error instanceof CliError && error.kind === "network" && /within 2s/.test(error.message),
    );
    assert.equal(calls.length, 1);
  });

  test("logs both directions with the key cut to its prefix", async () => {
    const lines: string[] = [];
    const { fetch } = scripted([json({ ok: true })]);
    await sendRequest(
      { ...GET, method: "POST", body: JSON.stringify({ a: 1 }) },
      options(fetch, { log: (line) => lines.push(line) }),
    );
    const log = lines.join("\n");
    assert.match(log, /→ POST https:\/\/g\.test\/api\/x/);
    assert.match(log, /authorization: Bearer gen_TestKeyA…/);
    assert.match(log, /\{"a":1\}/);
    assert.match(log, /← 200/);
    assert.ok(!log.includes(API_KEY), "the full key never reaches a log");
  });

  test("logs a multipart form by field, without file contents", async () => {
    const lines: string[] = [];
    const form = new FormData();
    form.append("file", new Blob(["secret-bytes"]), "a.txt");
    form.append("folderId", "f1");
    const { fetch } = scripted([json({})]);
    await sendRequest({ ...GET, method: "POST", body: form }, options(fetch, { log: (line) => lines.push(line) }));
    const log = lines.join("\n");
    assert.match(log, /file=@a\.txt \(12 B\)/);
    assert.match(log, /folderId=f1/);
    assert.ok(!log.includes("secret-bytes"));
  });
});

describe("networkError", () => {
  test("explains the usual connection failures", () => {
    const cases: Array<[Error, RegExp]> = [
      [failure("ECONNREFUSED"), /Connection refused by https:\/\/g\.test/],
      [failure("ENOTFOUND"), /Can't find the host g\.test/],
      [failure("ECONNRESET"), /closed the connection/],
      [failure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), /TLS certificate was refused/],
      [failure("EOTHER", "weird"), /Can't reach https:\/\/g\.test: weird/],
    ];
    for (const [cause, pattern] of cases) {
      const error = networkError(cause, GET, 60_000);
      assert.equal(error.kind, "network");
      assert.match(error.message, pattern);
      assert.equal(error.request?.operationId, "getX");
    }
    assert.match(networkError(failure("CERT_HAS_EXPIRED"), GET, 1).hint ?? "", /NODE_EXTRA_CA_CERTS/);
  });

  test("redactHeaders hides the bearer token and nothing else", () => {
    assert.deepEqual(redactHeaders({ authorization: `Bearer ${API_KEY}`, accept: "application/json" }), {
      authorization: "Bearer gen_TestKeyA…",
      accept: "application/json",
    });
  });
});

describe("errorFromResponse", () => {
  async function errorFor(response: Response, context = {}) {
    const { fetch } = scripted([response]);
    const parsed = await sendRequest({ ...GET, method: "POST" }, options(fetch));
    return errorFromResponse(parsed, { ...GET, method: "POST" }, context);
  }

  test("uses the server's own message and the status's kind", async () => {
    const error = await errorFor(json({ error: "Not found" }, 404));
    assert.equal(error.kind, "not_found");
    assert.equal(error.exitCode, 5);
    assert.equal(error.message, "Not found");
    assert.equal(error.status, 404);
    assert.deepEqual(error.response, { error: "Not found" });
    assert.equal(error.request?.operationId, "getX");
  });

  test("turns a validation error's issues into flags", async () => {
    const error = await errorFor(
      json({ error: "ValidationError", issues: [{ path: ["title"], message: "Required" }] }, 400),
      { flagFor: (path: string) => (path === "title" ? "--title" : undefined), describeCommand: "genosyn-api describe createGoal" },
    );
    assert.equal(error.kind, "validation");
    assert.equal(error.message, "The request didn't pass the server's validation.");
    assert.deepEqual(error.issues, [{ path: "title", message: "Required", flag: "--title" }]);
    assert.match(error.hint ?? "", /genosyn-api describe createGoal/);
  });

  test("points a 401 at whoami and login, and a 403 at describe", async () => {
    assert.match((await errorFor(json({ error: "Unauthorized" }, 401))).hint ?? "", /whoami.*login/);
    const forbidden = await errorFor(json({ error: "Admins only" }, 403), { describeCommand: "genosyn-api describe deleteGoal" });
    assert.equal(forbidden.message, "Admins only");
    assert.match(forbidden.hint ?? "", /describe deleteGoal/);
  });

  test("reads Retry-After on a 429 and suggests a retry on a 5xx", async () => {
    const limited = await errorFor(json({ error: "Slow down" }, 429, { "retry-after": "30" }));
    assert.equal(limited.kind, "rate_limited");
    assert.equal(limited.exitCode, 7);
    assert.match(limited.hint ?? "", /30 seconds/);
    const server = await errorFor(json({ error: "Internal error" }, 500));
    assert.equal(server.exitCode, 8);
    assert.match(server.hint ?? "", /Try again/);
  });

  test("falls back to the status for an HTML error page and keeps short text", async () => {
    const html = await errorFor(
      new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway", headers: { "content-type": "text/html" } }),
    );
    assert.equal(html.message, "HTTP 502 Bad Gateway");
    assert.equal(html.response, undefined);
    const text = await errorFor(new Response("Payload too large", { status: 413, headers: { "content-type": "text/plain" } }));
    assert.equal(text.message, "Payload too large");
    assert.equal(text.kind, "client_error");
  });

  test("reads a body's message field when there is no error field", async () => {
    assert.equal((await errorFor(json({ message: "Conflict here" }, 409))).message, "Conflict here");
  });
});
