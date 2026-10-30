import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyKeyRefusal } from "./apiKeyRing.js";
import { CodexAppServerError } from "./codexAppServer.js";
import { ModelSetupError } from "../modelCatalog.js";
import { openCodeError } from "./opencodeEvents.js";
import {
  classifyCodexError,
  classifyModelError,
  classifyModelResponse,
  classifyModelTransportError,
  codexErrorKind,
  markModelUnavailable,
  modelUnavailability,
  StreamedErrorScanner,
  type ModelUnavailability,
} from "./modelOutage.js";

/**
 * Telling an unavailable AI Model apart from a refused key and a bad request.
 *
 * The bar: work waits only when waiting is what fixes it. A service that is
 * down, failing, overloaded or rate-limited on every key is unavailable; a key
 * the provider refuses is the key ring's business; a request the service
 * rejects is the work's own failure. Each row below is one real answer a
 * provider, a gateway, a self-hosted server or the network gives.
 */

const anthropic = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message } });
const openai = (type: string | null, message: string, code: string | null = null) =>
  JSON.stringify({ error: { message, type, code, param: null } });

type Row = {
  label: string;
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** The cause when unavailable; null for an answer that is not an outage. */
  cause: ModelUnavailability["cause"] | null;
};

const RESPONSES: Row[] = [
  // ── outages ──
  { label: "Anthropic 529 overloaded_error", status: 529, body: anthropic("overloaded_error", "Overloaded"), cause: "overloaded" },
  { label: "Anthropic 500 api_error", status: 500, body: anthropic("api_error", "Internal server error"), cause: "server_error" },
  { label: "Anthropic 503 overloaded (rare status)", status: 503, body: anthropic("overloaded_error", "Overloaded"), cause: "overloaded" },
  { label: "OpenAI 500 server_error", status: 500, body: openai("server_error", "The server had an error while processing your request."), cause: "server_error" },
  { label: "OpenAI 503 engine overloaded", status: 503, body: openai("server_error", "The engine is currently overloaded, please try again later"), cause: "overloaded" },
  { label: "OpenAI 503 service unavailable", status: 503, body: openai(null, "Service Unavailable"), cause: "server_error" },
  { label: "gateway 502 from a proxy in front of vLLM", status: 502, body: "<html>Bad Gateway</html>", cause: "server_error" },
  { label: "gateway 504 timeout", status: 504, body: "Gateway Timeout", cause: "timeout" },
  { label: "408 request timeout", status: 408, body: "", cause: "timeout" },
  { label: "Cloudflare 520", status: 520, body: "", cause: "server_error" },
  { label: "Cloudflare 524 timeout", status: 524, body: "", cause: "server_error" },
  { label: "Ollama 500 while loading a model", status: 500, body: JSON.stringify({ error: "model is loading" }), cause: "server_error" },
  { label: "429 rate limit with retry-after", status: 429, body: anthropic("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), headers: { "retry-after": "30" }, cause: "rate_limited" },
  { label: "OpenAI 429 rate_limit_exceeded", status: 429, body: openai("requests", "Rate limit reached for requests", "rate_limit_exceeded"), cause: "rate_limited" },
  { label: "vLLM 429 too many requests", status: 429, body: "Too Many Requests", cause: "rate_limited" },
  // ── refused keys: the key ring's business, never an outage ──
  { label: "401 invalid key", status: 401, body: anthropic("authentication_error", "invalid x-api-key"), cause: null },
  { label: "403 permission", status: 403, body: anthropic("permission_error", "Your API key does not have permission"), cause: null },
  { label: "402 billing", status: 402, body: anthropic("billing_error", "Your credit balance is too low"), cause: null },
  { label: "Anthropic 400 credit balance", status: 400, body: anthropic("invalid_request_error", "Your credit balance is too low to access the Anthropic API."), cause: null },
  { label: "OpenAI 429 insufficient_quota", status: 429, body: openai("insufficient_quota", "You exceeded your current quota, please check your plan and billing details.", "insufficient_quota"), cause: null },
  { label: "429 that names a quota in plain words", status: 429, body: "quota exceeded", cause: null },
  // ── bad requests: fail as they always have ──
  { label: "400 invalid request", status: 400, body: anthropic("invalid_request_error", "messages: field required"), cause: null },
  { label: "400 prompt too long", status: 400, body: anthropic("invalid_request_error", "prompt is too long: 220000 tokens > 200000 maximum"), cause: null },
  { label: "404 unknown model", status: 404, body: openai("invalid_request_error", "The model `gpt-9` does not exist", "model_not_found"), cause: null },
  { label: "413 too large", status: 413, body: "Request Entity Too Large", cause: null },
  { label: "422 unprocessable", status: 422, body: "{}", cause: null },
  { label: "501 not implemented", status: 501, body: "", cause: null },
  { label: "505 HTTP version", status: 505, body: "", cause: null },
  // ── success ──
  { label: "200", status: 200, body: "{}", cause: null },
];

describe("HTTP answers", () => {
  for (const row of RESPONSES) {
    test(`${row.label} → ${row.cause ?? "not an outage"}`, () => {
      const result = classifyModelResponse({
        status: row.status,
        body: row.body,
        headers: row.headers ? new Headers(row.headers) : null,
      });
      assert.equal(result?.cause ?? null, row.cause);
      if (result) {
        assert.equal(result.status, row.status);
        assert.equal(result.definite, false, "an HTTP answer is never enough on its own");
      }
    });
  }

  test("a refused key and an outage never overlap: what the key ring moves on is never unavailable", () => {
    for (const row of RESPONSES) {
      const refusal = classifyKeyRefusal({
        status: row.status,
        body: row.body ?? "",
        headers: new Headers(row.headers ?? {}),
      });
      const outage = classifyModelResponse({ status: row.status, body: row.body });
      // A rate limit is both: the ring rests the key, and when every key
      // rests, the service is unavailable for as long as it asked.
      if (refusal && refusal.kind !== "rate_limit") {
        assert.equal(outage, null, `${row.label}: a refused key is not an outage`);
      }
    }
  });

  test("a rate limit honours retry-after, in seconds, milliseconds or as a date", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    assert.equal(
      classifyModelResponse({ status: 429, headers: new Headers({ "retry-after": "12" }) })
        ?.retryAfterMs,
      12_000,
    );
    assert.equal(
      classifyModelResponse({ status: 429, headers: new Headers({ "retry-after-ms": "1500" }) })
        ?.retryAfterMs,
      1_500,
    );
    assert.equal(
      classifyModelResponse({
        status: 503,
        headers: new Headers({ "retry-after": "Fri, 30 Oct 2026 12:02:00 GMT" }),
        now,
      })?.retryAfterMs,
      120_000,
    );
    assert.match(
      classifyModelResponse({ status: 429, headers: new Headers({ "retry-after": "90" }) })!.detail,
      /asked to wait 2m/,
    );
  });

  test("the detail is built from the status and the error type, never the body", () => {
    const secret = "sk-ant-api03-SECRETSECRETSECRETSECRET";
    const result = classifyModelResponse({
      status: 529,
      body: anthropic("overloaded_error", `Overloaded (your key ${secret} is fine)`),
    });
    assert.ok(result);
    assert.doesNotMatch(result.detail, /SECRET|sk-ant/);
    assert.equal(result.detail, "The AI Model is overloaded (HTTP 529, overloaded_error).");
    // A body that is not JSON is read for markers only, never copied.
    const html = classifyModelResponse({ status: 502, body: `<p>${secret}</p>` });
    assert.doesNotMatch(JSON.stringify(html), /SECRET/);
  });
});

/** An error shaped like Node's fetch failing, its code in the cause. */
function fetchFailed(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`connect ${code} 127.0.0.1:9`), { code, ...extra }),
  });
}

describe("network failures", () => {
  const rows: Array<[code: string, cause: ModelUnavailability["cause"], definite: boolean]> = [
    ["ECONNREFUSED", "unreachable", true],
    ["ENOTFOUND", "unreachable", true],
    ["EHOSTUNREACH", "unreachable", true],
    ["ENETUNREACH", "unreachable", true],
    ["EAI_AGAIN", "unreachable", false],
    ["ECONNRESET", "unreachable", false],
    ["EPIPE", "unreachable", false],
    ["ECONNABORTED", "unreachable", false],
    ["ETIMEDOUT", "timeout", false],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout", false],
    ["UND_ERR_HEADERS_TIMEOUT", "timeout", false],
    ["UND_ERR_BODY_TIMEOUT", "timeout", false],
    ["UND_ERR_SOCKET", "unreachable", false],
    ["UND_ERR_CLOSED", "unreachable", false],
    ["CERT_HAS_EXPIRED", "unreachable", true],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unreachable", true],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "unreachable", true],
    ["SELF_SIGNED_CERT_IN_CHAIN", "unreachable", true],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "unreachable", true],
  ];
  for (const [code, cause, definite] of rows) {
    test(`${code} → ${cause}${definite ? ", on its own" : ""}`, () => {
      const result = classifyModelTransportError(fetchFailed(code));
      assert.equal(result?.cause, cause);
      assert.equal(result?.code, code);
      assert.equal(result?.definite, definite);
    });
  }

  test("an abort is somebody stopping the work, never an outage", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    assert.equal(classifyModelTransportError(abort), null);
    assert.equal(classifyModelTransportError(fetchFailed("UND_ERR_ABORTED")), null);
    assert.equal(classifyModelError(abort), null);
  });

  test("the outbound policy refusing a private address is this host's rule, not an outage", () => {
    assert.equal(classifyModelTransportError(fetchFailed("EACCES")), null);
  });

  test("the SDKs' connection errors classify by name when there is no code", () => {
    assert.equal(
      classifyModelTransportError(
        Object.assign(new Error("Connection error."), { name: "APIConnectionError" }),
      )?.cause,
      "unreachable",
    );
    assert.equal(
      classifyModelTransportError(
        Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }),
      )?.cause,
      "timeout",
    );
  });

  test("an error with no network sign at all is not an outage", () => {
    assert.equal(classifyModelTransportError(new Error("Unexpected token < in JSON")), null);
    assert.equal(classifyModelTransportError(null), null);
  });
});

describe("Codex app-server errors", () => {
  test("its variants arrive as a name or as an object holding an HTTP status", () => {
    assert.deepEqual(codexErrorKind("serverOverloaded"), { kind: "serverOverloaded", status: null });
    assert.deepEqual(codexErrorKind({ httpConnectionFailed: { httpStatusCode: 503 } }), {
      kind: "httpConnectionFailed",
      status: 503,
    });
    assert.deepEqual(codexErrorKind(null), { kind: null, status: null });
  });

  const rows: Array<[info: unknown, cause: ModelUnavailability["cause"] | null]> = [
    ["serverOverloaded", "overloaded"],
    ["internalServerError", "server_error"],
    ["usageLimitExceeded", "rate_limited"],
    ["responseStreamDisconnected", "unreachable"],
    [{ httpConnectionFailed: { httpStatusCode: null } }, "unreachable"],
    [{ httpConnectionFailed: { httpStatusCode: 502 } }, "server_error"],
    [{ responseStreamConnectionFailed: { httpStatusCode: 429 } }, "rate_limited"],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 503 } }, "server_error"],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 401 } }, null],
    ["unauthorized", null],
    ["badRequest", null],
    ["contextWindowExceeded", null],
    ["sandboxError", null],
    ["cyberPolicy", null],
    ["other", null],
  ];
  for (const [info, cause] of rows) {
    test(`${JSON.stringify(info)} → ${cause ?? "not an outage"}`, () => {
      assert.equal(classifyCodexError(info)?.cause ?? null, cause);
    });
  }

  test("a turn's error is read off the CodexAppServerError the runtime throws", () => {
    assert.equal(
      classifyModelError(new CodexAppServerError("Model overloaded", "serverOverloaded", {}))
        ?.cause,
      "overloaded",
    );
    // A failed turn carries its variant on the turn's error object.
    assert.equal(
      classifyModelError(
        new CodexAppServerError("The turn failed.", "failed", {
          message: "stream error",
          codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
        }),
      )?.cause,
      "server_error",
    );
    // A named variant that is not an outage stays one, whatever else is said.
    assert.equal(
      classifyModelError(new CodexAppServerError("timed out? no: unauthorized", "unauthorized")),
      null,
    );
    // The usage limit of a ChatGPT plan is the subscription's own rate limit.
    const limited = classifyModelError(
      new CodexAppServerError("You've hit your usage limit.", "usageLimitExceeded"),
    );
    assert.equal(limited?.cause, "rate_limited");
    assert.equal(limited?.definite, true);
  });
});

describe("a turn's final error", () => {
  test("OpenCode's APIError keeps its status and provider detail, which classify it", () => {
    const overloaded = openCodeError({
      name: "APIError",
      data: {
        message: "Overloaded",
        statusCode: 529,
        isRetryable: true,
        responseBody: anthropic("overloaded_error", "Overloaded"),
      },
    } as never);
    assert.equal(classifyModelError(overloaded)?.cause, "overloaded");

    const quota = openCodeError({
      name: "APIError",
      data: {
        message: "quota",
        statusCode: 429,
        isRetryable: true,
        responseBody: openai("insufficient_quota", "You exceeded your current quota", "insufficient_quota"),
      },
    } as never);
    assert.equal(classifyModelError(quota), null, "out of quota is the key's problem");

    const auth = openCodeError({ name: "ProviderAuthError", data: { providerID: "x", message: "no" } } as never);
    assert.equal(classifyModelError(auth), null);

    const context = openCodeError({ name: "ContextOverflowError", data: { message: "too long" } } as never);
    assert.equal(classifyModelError(context), null);
  });

  test("what the proxy saw wins over the status OpenCode reports", () => {
    // OpenCode only says "HTTP 502"; the proxy saw nothing listening.
    const error = Object.assign(new Error("The AI Model request failed (HTTP 502)."), {
      status: 502,
    });
    const refused = classifyModelTransportError(fetchFailed("ECONNREFUSED"))!;
    markModelUnavailable(error, refused);
    assert.equal(classifyModelError(error), refused);
    // Marked through a wrapper's cause as well.
    assert.equal(classifyModelError(new Error("wrapped", { cause: error })), refused);
    // The mark is not enumerable: it never reaches a log or a response.
    assert.doesNotMatch(JSON.stringify({ ...error }), /ECONNREFUSED/);
  });

  test("an overload streamed after a 200 is found by the provider's words when there is no status", () => {
    const streamed = openCodeError({
      name: "APIError",
      data: { message: "Overloaded", isRetryable: true },
    } as never);
    assert.equal(classifyModelError(streamed)?.cause, "overloaded");
    // Words alone, from anything but the service, say nothing about the model.
    assert.equal(classifyModelError(new Error("provider returned 529 overloaded")), null);
  });

  test("Genosyn's own errors carry HTTP statuses that say nothing about the AI Model", () => {
    // The status a route answers with: a letter the writer did not submit is a 502.
    class LetterError extends Error {
      readonly status = 502;
    }
    assert.equal(classifyModelError(new LetterError("Ada did not submit a letter.")), null);
    assert.equal(
      classifyModelError(new ModelSetupError("ChatGPT disconnected during its connection test.", 502)),
      null,
    );
    assert.equal(classifyModelError(Object.assign(new Error("Service Unavailable"), { status: 503 })), null);
    assert.equal(classifyModelError(Object.assign(new Error("boom"), { statusCode: 500 })), null);

    // The service's own answer, as OpenCode reports it, is read — through a wrapper too.
    const gateway = openCodeError({
      name: "APIError",
      data: { message: "Bad Gateway", statusCode: 502, isRetryable: true },
    } as never);
    assert.equal(classifyModelError(gateway)?.cause, "server_error");
    assert.equal(
      classifyModelError(new LetterError("The letter could not be written.", { cause: gateway }))
        ?.cause,
      "server_error",
    );
  });

  test("the runtime's own problems are not outages", () => {
    for (const message of [
      "OpenCode did not start within 30s.",
      "OpenCode's activity stream ended before the turn finished.",
      "The AI Model returned no Run result.",
      "No API key is set for this AI Model.",
    ]) {
      assert.equal(classifyModelError(new Error(message)), null, message);
    }
  });

  test("a built unavailability reads as one plain sentence", () => {
    assert.equal(
      modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }).detail,
      "The AI Model could not be reached (ECONNREFUSED).",
    );
  });
});

describe("errors streamed after a 200", () => {
  test("Anthropic's overloaded_error event", () => {
    const scanner = new StreamedErrorScanner();
    assert.equal(scanner.push('event: message_start\ndata: {"type":"message_start"}\n\n'), null);
    const found = scanner.push(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    );
    assert.equal(found?.cause, "overloaded");
    assert.equal(scanner.found?.cause, "overloaded");
  });

  test("an event split across chunks is still found", () => {
    const scanner = new StreamedErrorScanner();
    assert.equal(scanner.push('data: {"type":"error","error":{"type":"api_'), null);
    assert.equal(scanner.push('error","message":"x"}}\n')?.cause, "server_error");
  });

  test("OpenAI's response.failed with a server_error", () => {
    const scanner = new StreamedErrorScanner();
    const found = scanner.push(
      'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"x"}}}\n',
    );
    assert.equal(found?.cause, "server_error");
  });

  test("ordinary deltas, and an error about the request, are not outages", () => {
    const scanner = new StreamedErrorScanner();
    assert.equal(
      scanner.push('data: {"type":"content_block_delta","delta":{"text":"error handling"}}\n'),
      null,
    );
    assert.equal(
      scanner.push(
        'data: {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}\n',
      ),
      null,
    );
    assert.equal(scanner.found, null);
  });
});
