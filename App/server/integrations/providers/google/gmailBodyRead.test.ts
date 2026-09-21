import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { invokeGmailTool as runGmailTool } from "./gmail-tools.js";

const originalFetch = globalThis.fetch;
const readContext = {
  assertCapability: async (capability: string) => {
    assert.equal(capability, "mail.read");
  },
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const message = {
  id: "gmail-message",
  threadId: "gmail-thread",
  snippet: "preview",
  payload: {
    mimeType: "text/plain",
    headers: [{ name: "Subject", value: "Request" }],
    body: {
      data: Buffer.from(`Proceed.\nOn Monday, Pat wrote:\n${"old\n".repeat(10_000)}`).toString(
        "base64url",
      ),
    },
  },
};

test("Gmail defaults to bounded decoded replies and preserves explicit raw/full reads", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(message));
  };
  const reply = (await runGmailTool(
    "gmail_get_message",
    { messageId: message.id },
    "token",
    readContext,
  )) as {
    bodyText: string;
    bodyCoverage: { quotedHistoryOmitted: boolean };
    payload?: unknown;
  };
  assert.equal(reply.bodyText, "Proceed.");
  assert.equal(reply.bodyCoverage.quotedHistoryOmitted, true);
  assert.equal(reply.payload, undefined);
  assert.match(calls[0], /format=full$/);
  const page = (await runGmailTool(
    "gmail_get_message",
    { messageId: message.id, includeQuoted: true, bodyOffset: 4_000, maxBodyChars: 500 },
    "token",
    readContext,
  )) as { bodyText: string; bodyCoverage: { nextOffset: number } };
  assert.equal(page.bodyText.length, 500);
  assert.equal(page.bodyCoverage.nextOffset, 4_500);
  assert.deepEqual(
    await runGmailTool(
      "gmail_get_message",
      { messageId: message.id, format: "full" },
      "token",
      readContext,
    ),
    message,
  );
});

test("Gmail snippet fallback is incomplete, and the mailbox capability still gates reads", async () => {
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    return new Response(JSON.stringify({ id: "snippet", snippet: "preview" }));
  };
  await assert.rejects(
    runGmailTool("gmail_get_message", { messageId: "m" }, "token", {
      assertCapability: async () => {
        throw new Error("No mailbox Grant");
      },
    }),
    /No mailbox Grant/,
  );
  assert.equal(fetched, 0);
  const result = (await runGmailTool(
    "gmail_get_message",
    { messageId: "m" },
    "token",
    readContext,
  )) as {
    bodyCoverage: { complete: boolean; sourceComplete: boolean };
  };
  assert.equal(result.bodyCoverage.complete, false);
  assert.equal(result.bodyCoverage.sourceComplete, false);
});

test("Gmail HTML-only content is decoded to text without returning MIME", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "html",
        payload: {
          mimeType: "text/html",
          body: {
            data: Buffer.from(
              "<p>Useful reply.</p><div>On Monday, Pat wrote:</div><p>Old mail</p>",
            ).toString("base64url"),
          },
        },
      }),
    );
  const result = (await runGmailTool(
    "gmail_get_message",
    { messageId: "html" },
    "token",
    readContext,
  )) as {
    bodyText: string;
    bodyCoverage: { sourceComplete: boolean; quotedHistoryOmitted: boolean };
  };
  assert.equal(result.bodyText, "Useful reply.");
  assert.equal(result.bodyCoverage.sourceComplete, true);
  assert.equal(result.bodyCoverage.quotedHistoryOmitted, true);
});

test("Gmail follows an inline body handle without downloading named file attachments", async () => {
  const fetched: string[] = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(
      JSON.stringify(
        String(url).includes("/attachments/")
          ? {
              data: Buffer.from("Full inline body recovered.").toString("base64url"),
            }
          : {
              id: "large",
              threadId: "thread",
              payload: {
                mimeType: "multipart/mixed",
                parts: [
                  { mimeType: "text/plain", body: { attachmentId: "inline-body", size: 600_000 } },
                  {
                    mimeType: "text/plain",
                    filename: "notes.txt",
                    body: { attachmentId: "file-body", size: 100 },
                  },
                ],
              },
            },
      ),
    );
  };
  const result = (await runGmailTool(
    "gmail_get_message",
    { messageId: "large" },
    "token",
    readContext,
  )) as { bodyText: string; bodyCoverage: { sourceComplete: boolean } };
  assert.equal(result.bodyText, "Full inline body recovered.");
  assert.equal(result.bodyCoverage.sourceComplete, true);
  assert.equal(fetched.length, 2);
  assert.match(fetched[1], /attachments\/inline-body$/);
});

test("Gmail body continuation reaches the end of a body beyond the former offset ceiling", async () => {
  const offset = 10_000_010;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "long-message",
        payload: {
          mimeType: "text/plain",
          body: { data: Buffer.from("x".repeat(offset) + "Final sentence.").toString("base64url") },
        },
      }),
    );
  const result = (await runGmailTool(
    "gmail_get_message",
    { messageId: "long-message", includeQuoted: true, bodyOffset: offset, maxBodyChars: 500 },
    "token",
    readContext,
  )) as {
    bodyText: string;
    bodyCoverage: { offset: number; nextOffset: number | null; hasMore: boolean };
  };
  assert.equal(result.bodyText, "Final sentence.");
  assert.equal(result.bodyCoverage.offset, offset);
  assert.equal(result.bodyCoverage.nextOffset, null);
  assert.equal(result.bodyCoverage.hasMore, false);
});
