import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  decodeHtmlEntities,
  GmailApiError,
  gmailFetch,
  gmailReadRetryDelayMs,
  gmailSyncErrorMessage,
  isGmailTimeoutError,
  sendMessage,
  stripHtml,
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

  test("does not retry an ambiguous outbound send", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return json({ error: { message: "Backend busy" } }, { status: 503 });
    }) as typeof fetch;

    await assert.rejects(sendMessage("token", "raw"), GmailApiError);
    assert.equal(calls, 1);
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
