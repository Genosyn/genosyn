import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  createDraft,
  decodeHtmlEntities,
  deleteDraft,
  GmailApiError,
  gmailFetch,
  gmailReadRetryDelayMs,
  gmailSyncErrorMessage,
  isGmailTimeoutError,
  isRetryableGmailReadError,
  sendMessage,
  stripHtml,
  updateDraft,
} from "./gmailClient.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers,
  });
}

describe("Gmail sync read retries", () => {
  test("classifies every supported transient response and network failure", () => {
    const cases: Array<{ label: string; error: unknown; retryable: boolean }> = [
      { label: "request timeout", error: new GmailApiError(408, "timeout"), retryable: true },
      { label: "rate limit", error: new GmailApiError(429, "quota"), retryable: true },
      { label: "internal error", error: new GmailApiError(500, "internal"), retryable: true },
      { label: "service unavailable", error: new GmailApiError(503, "busy"), retryable: true },
      { label: "gateway timeout", error: new GmailApiError(504, "timeout"), retryable: true },
      {
        label: "403 backend error",
        error: new GmailApiError(403, "busy", null, ["backendError"]),
        retryable: true,
      },
      {
        label: "403 project rate limit",
        error: new GmailApiError(403, "quota", null, ["rateLimitExceeded"]),
        retryable: true,
      },
      {
        label: "403 user rate limit among several reasons",
        error: new GmailApiError(403, "quota", null, ["forbidden", "userRateLimitExceeded"]),
        retryable: true,
      },
      {
        label: "timeout exception",
        error: Object.assign(new Error("request expired"), { name: "TimeoutError" }),
        retryable: true,
      },
      {
        label: "abort exception",
        error: Object.assign(new Error("request cancelled"), { name: "AbortError" }),
        retryable: true,
      },
      { label: "undici fetch failure", error: new TypeError("fetch failed"), retryable: true },
      { label: "network message", error: new Error("network connection lost"), retryable: true },
      {
        label: "nested socket code",
        error: Object.assign(new Error("request failed"), { cause: { code: "ECONNRESET" } }),
        retryable: true,
      },
      {
        label: "nested DNS code",
        error: Object.assign(new Error("request failed"), { cause: { code: "EAI_AGAIN" } }),
        retryable: true,
      },
      { label: "bad request", error: new GmailApiError(400, "bad input"), retryable: false },
      { label: "revoked credentials", error: new GmailApiError(401, "revoked"), retryable: false },
      {
        label: "permanent forbidden",
        error: new GmailApiError(403, "forbidden", null, ["forbidden"]),
        retryable: false,
      },
      {
        label: "daily limit",
        error: new GmailApiError(403, "daily quota", null, ["dailyLimitExceeded"]),
        retryable: false,
      },
      { label: "not found", error: new GmailApiError(404, "gone"), retryable: false },
      { label: "conflict", error: new GmailApiError(409, "conflict"), retryable: false },
      { label: "ordinary error", error: new Error("bad response"), retryable: false },
      { label: "string failure", error: "bad response", retryable: false },
      { label: "null failure", error: null, retryable: false },
    ];

    for (const item of cases) {
      assert.equal(isRetryableGmailReadError(item.error), item.retryable, item.label);
    }
  });

  test("retries a transient Gmail response and honors Retry-After", async () => {
    let calls = 0;
    const waits: number[] = [];
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return json(
          { error: { message: "Backend busy" } },
          { status: 503, headers: { "retry-after": "2" } },
        );
      }
      return json({ ok: true });
    }) as typeof fetch;

    const result = await gmailFetch(
      "token",
      "/test",
      {},
      {
        retry: "read",
        maxAttempts: 2,
        sleep: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2_000]);
  });

  test("retries timeout failures with a fresh request attempt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3)
        throw Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        });
      return json({ ok: true });
    }) as typeof fetch;

    await gmailFetch(
      "token",
      "/test",
      {},
      {
        retry: "read",
        maxAttempts: 3,
        sleep: async () => {},
        rng: () => 0,
      },
    );
    assert.equal(calls, 3);
  });

  test("uses the exact retry budget, fresh timeout signals, and preserves the final error", async () => {
    const finalError = new GmailApiError(503, "Still unavailable");
    const waits: number[] = [];
    const signals: AbortSignal[] = [];
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      assert.ok(init?.signal instanceof AbortSignal);
      signals.push(init.signal);
      throw finalError;
    }) as typeof fetch;

    await assert.rejects(
      gmailFetch(
        "token",
        "/test",
        {},
        {
          retry: "read",
          maxAttempts: 4,
          sleep: async (delayMs) => {
            waits.push(delayMs);
          },
          rng: () => 0,
        },
      ),
      (error: unknown) => error === finalError,
    );

    assert.equal(calls, 4);
    assert.deepEqual(waits, [375, 750, 1_500]);
    assert.equal(new Set(signals).size, 4);
    assert.ok(signals.every((signal) => !signal.aborted));
  });

  test("fails permanent read errors immediately", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return json({ error: { message: "Invalid credentials" } }, { status: 401 });
    }) as typeof fetch;

    await assert.rejects(
      gmailFetch(
        "token",
        "/test",
        {},
        {
          retry: "read",
          maxAttempts: 4,
          sleep: async () => {},
        },
      ),
      (error: unknown) => error instanceof GmailApiError && error.status === 401,
    );
    assert.equal(calls, 1);
  });

  test("retries Gmail's transient 403 rate-limit reason", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return json(
          {
            error: {
              message: "User rate limit exceeded",
              errors: [{ reason: "userRateLimitExceeded" }],
            },
          },
          { status: 403 },
        );
      }
      return json({ ok: true });
    }) as typeof fetch;

    await gmailFetch(
      "token",
      "/test",
      {},
      {
        retry: "read",
        maxAttempts: 2,
        sleep: async () => {},
      },
    );
    assert.equal(calls, 2);
  });

  test("does not retry a permanent 403 reason or a not-found response", async () => {
    for (const response of [
      json(
        {
          error: {
            message: "Gmail access is forbidden",
            errors: [{ reason: "forbidden" }],
          },
        },
        { status: 403 },
      ),
      json({ error: { message: "Message vanished" } }, { status: 404 }),
    ]) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return response.clone();
      }) as typeof fetch;

      await assert.rejects(
        gmailFetch("token", "/test", {}, { retry: "read", maxAttempts: 4, sleep: async () => {} }),
        GmailApiError,
      );
      assert.equal(calls, 1);
    }
  });

  test("never retries representative POST, PUT, or DELETE writes", async () => {
    const writes: Array<{
      label: string;
      method: string;
      path: string;
      run: () => Promise<unknown>;
    }> = [
      {
        label: "send message POST",
        method: "POST",
        path: "/users/me/messages/send",
        run: () => sendMessage("token", "raw"),
      },
      {
        label: "create draft POST",
        method: "POST",
        path: "/users/me/drafts",
        run: () => createDraft("token", "raw"),
      },
      {
        label: "update draft PUT",
        method: "PUT",
        path: "/users/me/drafts/draft-1",
        run: () => updateDraft("token", "draft-1", "raw"),
      },
      {
        label: "delete draft DELETE",
        method: "DELETE",
        path: "/users/me/drafts/draft-1",
        run: () => deleteDraft("token", "draft-1"),
      },
    ];

    for (const write of writes) {
      let calls = 0;
      globalThis.fetch = (async (input, init) => {
        calls += 1;
        assert.equal(new URL(String(input)).pathname, `/gmail/v1${write.path}`, write.label);
        assert.equal(init?.method, write.method, write.label);
        return json({ error: { message: "Backend busy" } }, { status: 503 });
      }) as typeof fetch;

      await assert.rejects(write.run(), GmailApiError, write.label);
      assert.equal(calls, 1, write.label);
    }
  });

  test("uses numeric and date Retry-After values and caps excessive waits", () => {
    const nowMs = Date.parse("2026-08-14T12:00:00.000Z");
    assert.equal(
      gmailReadRetryDelayMs(new GmailApiError(429, "quota", "2.5"), 1, { nowMs }),
      2_500,
    );
    assert.equal(
      gmailReadRetryDelayMs(new GmailApiError(503, "busy", "Fri, 14 Aug 2026 12:00:03 GMT"), 1, {
        nowMs,
      }),
      3_000,
    );
    assert.equal(
      gmailReadRetryDelayMs(new GmailApiError(429, "quota", "60"), 1, { nowMs }),
      10_000,
    );
    assert.equal(
      gmailReadRetryDelayMs(new GmailApiError(503, "busy", "Fri, 14 Aug 2026 12:01:00 GMT"), 1, {
        nowMs,
      }),
      10_000,
    );
    assert.equal(
      gmailReadRetryDelayMs(new GmailApiError(503, "busy", "Fri, 14 Aug 2026 11:59:00 GMT"), 1, {
        nowMs,
      }),
      0,
    );
  });

  test("falls back from invalid Retry-After and keeps jitter inside its capped envelope", () => {
    const invalid = new GmailApiError(503, "busy", "not-a-date");
    assert.equal(gmailReadRetryDelayMs(invalid, 2, { rng: () => 0 }), 750);
    assert.equal(gmailReadRetryDelayMs(invalid, 2, { rng: () => 1 }), 1_000);

    assert.equal(gmailReadRetryDelayMs(new Error("busy"), 1, { rng: () => 0 }), 375);
    assert.equal(gmailReadRetryDelayMs(new Error("busy"), 1, { rng: () => 1 }), 500);
    assert.equal(gmailReadRetryDelayMs(new Error("busy"), 4, { rng: () => 0 }), 3_000);
    assert.equal(gmailReadRetryDelayMs(new Error("busy"), 4, { rng: () => 1 }), 4_000);
    assert.equal(gmailReadRetryDelayMs(new Error("busy"), 99, { rng: () => -1 }), 3_000);
    assert.equal(gmailReadRetryDelayMs(new Error("busy"), 99, { rng: () => 2 }), 4_000);
    assert.equal(gmailReadRetryDelayMs(new Error("busy"), 99, { rng: () => Number.NaN }), 3_000);
  });

  test("returns null for empty and malformed successful response bodies", async () => {
    for (const response of [new Response(null, { status: 204 }), new Response("not-json")]) {
      globalThis.fetch = (async () => response.clone()) as typeof fetch;
      assert.equal(await gmailFetch("token", "/test"), null);
    }
  });

  test("reports a stable Gmail error when an error body is empty or malformed", async () => {
    for (const response of [
      new Response(null, { status: 502, statusText: "Bad Gateway" }),
      new Response("upstream proxy failure", { status: 502, statusText: "Bad Gateway" }),
    ]) {
      globalThis.fetch = (async () => response.clone()) as typeof fetch;
      await assert.rejects(
        gmailFetch("token", "/test"),
        (error: unknown) =>
          error instanceof GmailApiError &&
          error.status === 502 &&
          error.message === "Gmail 502 Bad Gateway" &&
          error.retryAfter === null &&
          error.reasons.length === 0,
      );
    }
  });

  test("turns exhausted transient failures into useful sync copy", () => {
    assert.equal(
      gmailSyncErrorMessage(new GmailApiError(429, "quota")),
      "Gmail is rate-limiting sync. Genosyn will retry automatically.",
    );
    assert.equal(
      gmailSyncErrorMessage(Object.assign(new Error("raw abort"), { name: "TimeoutError" })),
      "Gmail did not respond in time. Genosyn will retry automatically.",
    );
    assert.equal(gmailReadRetryDelayMs(new GmailApiError(503, "busy"), 1, { rng: () => 0 }), 375);
  });

  test("does not fan a Gmail outage or quota response into per-message reads", () => {
    assert.equal(isGmailTimeoutError(new GmailApiError(429, "quota")), false);
    assert.equal(isGmailTimeoutError(new GmailApiError(503, "busy")), false);
    assert.equal(isGmailTimeoutError(new GmailApiError(504, "gateway timeout")), true);
    assert.equal(
      isGmailTimeoutError(Object.assign(new Error("request timed out"), { name: "TimeoutError" })),
      true,
    );
  });
});

describe("decodeHtmlEntities", () => {
  test("decodes Gmail snippet character references as plain text", () => {
    assert.equal(
      decodeHtmlEntities("Letting me know. If there&#39;s anything &amp; everything"),
      "Letting me know. If there's anything & everything",
    );
    assert.equal(
      decodeHtmlEntities("&quot;hello&quot; &lt;tag&gt; &apos;ok&apos;&nbsp;"),
      `"hello" <tag> 'ok' `,
    );
  });

  test("decodes decimal and hexadecimal Unicode references", () => {
    assert.equal(decodeHtmlEntities("Ready &#128640; &#x1F680;"), "Ready 🚀 🚀");
  });

  test("preserves unknown and invalid references", () => {
    assert.equal(
      decodeHtmlEntities("Keep &copy; &#x110000; &#55296;"),
      "Keep &copy; &#x110000; &#55296;",
    );
  });

  test("keeps HTML stripping entity decoding behavior", () => {
    assert.equal(stripHtml("<p>Tom &amp; Jerry. It&#39;s fine.</p>"), "Tom & Jerry. It's fine.");
  });
});
