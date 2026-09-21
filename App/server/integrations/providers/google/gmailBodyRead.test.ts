import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { invokeGmailTool as runGmailTool } from "./gmail-tools.js";

const originalFetch = globalThis.fetch;
const readContext = { assertCapability: async (capability: string) => { assert.equal(capability, "mail.read"); } };
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
  const reply = (await runGmailTool("gmail_get_message", { messageId: message.id }, "token", readContext)) as {
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
    await runGmailTool("gmail_get_message", { messageId: message.id, format: "full" }, "token", readContext),
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
  const result = (await runGmailTool("gmail_get_message", { messageId: "m" }, "token", readContext)) as {
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
  const result = (await runGmailTool("gmail_get_message", { messageId: "html" }, "token", readContext)) as {
    bodyText: string;
    bodyCoverage: { sourceComplete: boolean; quotedHistoryOmitted: boolean };
  };
  assert.equal(result.bodyText, "Useful reply.");
  assert.equal(result.bodyCoverage.sourceComplete, true);
  assert.equal(result.bodyCoverage.quotedHistoryOmitted, true);
});
