import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { invokeGmailTool } from "./gmail-tools.js";
import { GmailApiError } from "../../../services/mail/gmailClient.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const messageId = "message/with spaces";
const body = `Current message\nOn Monday, Pat wrote:\n${"historical context\n".repeat(1_000)}`;
const message = {
  id: messageId,
  threadId: "thread-id",
  payload: {
    mimeType: "text/plain",
    headers: [{ name: "Subject", value: "Read retry fixture" }],
    body: { data: Buffer.from(body).toString("base64url") },
  },
};
const readContext = {
  assertCapability: async (capability: string) => {
    assert.equal(capability, "mail.read");
  },
};

function dnsFailure(): Error {
  return Object.assign(new Error("getaddrinfo EAI_AGAIN www.googleapis.com"), {
    code: "EAI_AGAIN",
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "retry-after": "0" },
  });
}

const readCases = [
  ...["minimal", "metadata", "full"].map((format) => ({
    label: `${format} message`,
    tool: "gmail_get_message",
    args: { messageId, format },
    path: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=${format}`,
    expected: message,
  })),
  {
    label: "search page",
    tool: "gmail_search_messages",
    args: {
      q: "after:2026/09/01 in:anywhere",
      maxResults: 100,
      pageToken: "next+page/=",
      labelIds: ["INBOX", "SENT"],
    },
    path: "/gmail/v1/users/me/messages?q=after%3A2026%2F09%2F01+in%3Aanywhere&maxResults=100&pageToken=next%2Bpage%2F%3D&labelIds=INBOX&labelIds=SENT",
    expected: { messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "remaining-page" },
  },
  {
    label: "labels",
    tool: "gmail_list_labels",
    args: {},
    path: "/gmail/v1/users/me/labels",
    expected: { labels: [{ id: "INBOX", name: "INBOX" }] },
  },
];

for (const scenario of readCases) {
  test(`${scenario.label} recovers from transient DNS without changing the request or native result`, async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://gmail.googleapis.com");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
      assert.equal(init?.method ?? "GET", "GET");
      assert.ok(init?.signal instanceof AbortSignal);
      requests.push(url.pathname + url.search);
      if (requests.length === 1) throw dnsFailure();
      return json(scenario.expected);
    };
    assert.deepEqual(
      await invokeGmailTool(scenario.tool, scenario.args, "synthetic-token", readContext),
      scenario.expected,
    );
    assert.deepEqual(requests, [scenario.path, scenario.path]);
  });
}

test("the exact quoted text read shape already recovers a transient DNS failure and remains bounded", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw dnsFailure();
    return json(message);
  };
  const result = (await invokeGmailTool(
    "gmail_get_message",
    {
      messageId,
      format: "text",
      includeQuoted: true,
      maxBodyChars: 16_000,
    },
    "synthetic-token",
    readContext,
  )) as {
    bodyText: string;
    bodyCoverage: { nextOffset: number; complete: boolean; quotedHistoryOmitted: boolean };
  };
  assert.equal(calls, 2);
  assert.equal(result.bodyText, body.slice(0, 16_000));
  assert.equal(result.bodyCoverage.nextOffset, 16_000);
  assert.equal(result.bodyCoverage.complete, false);
  assert.equal(result.bodyCoverage.quotedHistoryOmitted, false);
});

for (const format of ["metadata", "text"]) {
  test(`${format} reads stop after four DNS failures and preserve the final error`, async () => {
    let calls = 0;
    const failure = dnsFailure();
    globalThis.fetch = async () => {
      calls += 1;
      throw failure;
    };
    await assert.rejects(
      invokeGmailTool(
        "gmail_get_message",
        {
          messageId,
          format,
          includeQuoted: true,
          maxBodyChars: 16_000,
        },
        "synthetic-token",
        readContext,
      ),
      (error: unknown) => error === failure,
    );
    assert.equal(calls, 4);
  });
}

for (const status of [408, 429, 503]) {
  test(`raw message reads recover from HTTP ${status}`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? json({ error: { message: "Temporarily unavailable" } }, status)
        : json(message);
    };
    assert.deepEqual(
      await invokeGmailTool(
        "gmail_get_message",
        { messageId, format: "full" },
        "synthetic-token",
        readContext,
      ),
      message,
    );
    assert.equal(calls, 2);
  });
}

for (const status of [400, 401, 403, 404]) {
  test(`permanent HTTP ${status} message failures are not retried`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return json(
        { error: { message: "Read refused", errors: [{ reason: "forbidden" }] } },
        status,
      );
    };
    await assert.rejects(
      invokeGmailTool(
        "gmail_get_message",
        { messageId, format: "metadata" },
        "synthetic-token",
        readContext,
      ),
      (error: unknown) =>
        error instanceof GmailApiError &&
        error.status === status &&
        error.message === "Read refused",
    );
    assert.equal(calls, 1);
  });
}

test("an inline body retry fetches only that body and preserves quoted text coverage", async () => {
  let messageCalls = 0;
  let bodyCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/attachments/body-handle")) {
      bodyCalls += 1;
      if (bodyCalls === 1) throw dnsFailure();
      return json({ data: Buffer.from(body).toString("base64url") });
    }
    messageCalls += 1;
    assert.equal(url.searchParams.get("format"), "full");
    return json({
      ...message,
      payload: { mimeType: "text/plain", body: { attachmentId: "body-handle" } },
    });
  };
  const result = (await invokeGmailTool(
    "gmail_get_message",
    {
      messageId,
      includeQuoted: true,
      bodyOffset: 16_000,
      maxBodyChars: 16_000,
    },
    "synthetic-token",
    readContext,
  )) as { bodyText: string; bodyCoverage: { complete: boolean; nextOffset: number | null } };
  assert.equal(messageCalls, 1);
  assert.equal(bodyCalls, 2);
  assert.equal(result.bodyText, body.slice(16_000));
  // A final page completes this page sequence, not full coverage on its own.
  assert.equal(result.bodyCoverage.complete, false);
  assert.equal(result.bodyCoverage.nextOffset, null);
});

test("every read entry point still denies a missing or refused mailbox capability before HTTP", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return json({});
  };
  const scenarios = [...readCases, { tool: "gmail_get_message", args: { messageId } }];
  for (const scenario of scenarios) {
    await assert.rejects(
      invokeGmailTool(scenario.tool, scenario.args, "synthetic-token"),
      /mailbox grants/,
    );
    await assert.rejects(
      invokeGmailTool(scenario.tool, scenario.args, "synthetic-token", {
        assertCapability: async () => {
          throw new Error("No mailbox Grant");
        },
      }),
      /No mailbox Grant/,
    );
  }
  assert.equal(calls, 0);
});

for (const tool of ["gmail_send_message", "gmail_create_draft"]) {
  for (const failureKind of ["DNS", "HTTP"]) {
    test(`${tool} stays single-attempt on ${failureKind} failure`, async () => {
      let calls = 0;
      let capability: string | undefined;
      const failure = dnsFailure();
      globalThis.fetch = async (_input, init) => {
        calls += 1;
        assert.equal(init?.method, "POST");
        if (failureKind === "DNS") throw failure;
        return json({ error: { message: "Backend unavailable" } }, 503);
      };
      await assert.rejects(
        invokeGmailTool(
          tool,
          {
            to: "synthetic@example.com",
            subject: "Synthetic",
            body: "Mocked transport only",
          },
          "synthetic-token",
          {
            assertCapability: async (requested) => {
              capability = requested;
            },
          },
        ),
        failureKind === "DNS" ? (error: unknown) => error === failure : /Backend unavailable/,
      );
      assert.equal(calls, 1);
      assert.equal(capability, tool === "gmail_send_message" ? "mail.send" : "mail.draft");
    });
  }
}
