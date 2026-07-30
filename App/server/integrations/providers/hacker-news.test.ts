import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { IntegrationRuntimeContext } from "../types.js";
import { hackerNewsProvider } from "./hacker-news.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function runtime(username?: string): IntegrationRuntimeContext {
  return {
    authMode: "apikey",
    config: username ? { username } : {},
    connectionId: "connection-1",
    companyId: "company-1",
    employeeId: "employee-1",
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Hacker News Integration", () => {
  test("creates a public Connection without credentials and validates an optional profile", async () => {
    let calls = 0;
    globalThis.fetch = (async (input) => {
      calls += 1;
      assert.equal(String(input), "https://hacker-news.firebaseio.com/v0/user/pg.json");
      return json({
        id: "pg",
        created: 1_000,
        karma: 123,
        submitted: [1, 2],
      });
    }) as typeof fetch;

    assert.deepEqual(await hackerNewsProvider.validateApiKey!({ username: "" }), {
      config: {},
      accountHint: "Public API",
    });
    assert.equal(calls, 0);
    assert.deepEqual(await hackerNewsProvider.validateApiKey!({ username: " pg " }), {
      config: { username: "pg" },
      accountHint: "pg",
    });
    assert.equal(calls, 1);
  });

  test("lists a selected official feed and normalizes item text", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/beststories.json")) return json([101, 102, 103]);
      if (url.endsWith("/item/102.json")) {
        return json({
          id: 102,
          type: "story",
          by: "alice",
          time: 1_700_000_000,
          title: "Second",
          text: "Hello <b>world</b> &amp; friends",
          score: 42,
          kids: [201],
        });
      }
      if (url.endsWith("/item/103.json")) {
        return json({
          id: 103,
          type: "story",
          by: "bob",
          time: 1_700_000_001,
          title: "Third",
          url: "https://example.com/third",
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = (await hackerNewsProvider.invokeTool(
      "list_stories",
      { feed: "best", offset: 1, limit: 2 },
      runtime(),
    )) as {
      feed: string;
      totalAvailable: number;
      items: Array<{ id: number; text: string | null; webUrl: string }>;
    };

    assert.equal(result.feed, "best");
    assert.equal(result.totalAvailable, 3);
    assert.deepEqual(
      result.items.map((item) => item.id),
      [102, 103],
    );
    assert.equal(result.items[0]?.text, "Hello world & friends");
    assert.equal(result.items[0]?.webUrl, "https://news.ycombinator.com/item?id=102");
  });

  test("reads a bounded comment tree breadth-first with depth metadata", async () => {
    const items = new Map<number, unknown>([
      [
        10,
        {
          id: 10,
          type: "story",
          by: "root",
          time: 1_700_000_000,
          title: "Story",
          kids: [11, 12],
        },
      ],
      [
        11,
        {
          id: 11,
          type: "comment",
          by: "one",
          time: 1_700_000_001,
          text: "First<p>paragraph",
          parent: 10,
          kids: [13],
        },
      ],
      [
        12,
        {
          id: 12,
          type: "comment",
          by: "two",
          time: 1_700_000_002,
          text: "Second",
          parent: 10,
        },
      ],
      [
        13,
        {
          id: 13,
          type: "comment",
          by: "three",
          time: 1_700_000_003,
          text: "Nested",
          parent: 11,
        },
      ],
    ]);
    globalThis.fetch = (async (input) => {
      const match = String(input).match(/\/item\/(\d+)\.json$/);
      if (!match) throw new Error(`Unexpected URL: ${String(input)}`);
      return json(items.get(Number(match[1])) ?? null);
    }) as typeof fetch;

    const result = (await hackerNewsProvider.invokeTool(
      "get_thread",
      { itemId: 10, maxDepth: 2, maxComments: 3 },
      runtime(),
    )) as {
      comments: Array<{ id: number; depth: number; text: string | null }>;
      truncated: boolean;
    };

    assert.deepEqual(
      result.comments.map(({ id, depth }) => ({ id, depth })),
      [
        { id: 11, depth: 1 },
        { id: 12, depth: 1 },
        { id: 13, depth: 2 },
      ],
    );
    assert.equal(result.comments[0]?.text, "First paragraph");
    assert.equal(result.truncated, false);
  });

  test("uses the Connection profile for public activity and filters by item type", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/user/alice.json")) {
        return json({
          id: "alice",
          created: 1_600_000_000,
          karma: 99,
          about: "Builder &amp; reader",
          submitted: [21, 22, 23],
        });
      }
      if (url.endsWith("/item/21.json")) return json({ id: 21, type: "comment", by: "alice" });
      if (url.endsWith("/item/22.json")) {
        return json({ id: 22, type: "story", by: "alice", title: "A story" });
      }
      if (url.endsWith("/item/23.json")) return json({ id: 23, type: "comment", by: "alice" });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = (await hackerNewsProvider.invokeTool(
      "list_user_activity",
      { type: "comment", limit: 2, scanLimit: 3 },
      runtime("alice"),
    )) as {
      user: { id: string; about: string };
      items: Array<{ id: number; type: string }>;
    };

    assert.equal(result.user.id, "alice");
    assert.equal(result.user.about, "Builder & reader");
    assert.deepEqual(
      result.items.map((item) => item.id),
      [21, 23],
    );
  });

  test("keeps all publication actions human-only and exposes the reason", async () => {
    assert.equal(
      hackerNewsProvider.tools.some((tool) =>
        ["post", "comment", "publish"].some((verb) => tool.name.includes(verb)),
      ),
      false,
    );

    const prepared = (await hackerNewsProvider.invokeTool(
      "prepare_link_submission_for_human",
      {
        title: "Original title",
        url: "https://example.com/article",
        reviewNotes: "Check relevance",
      },
      runtime(),
    )) as {
      draft: { title: string; url: string };
      publicationPolicy: {
        apiAccess: string;
        automatedPublishingSupported: boolean;
        guidelinesUrl: string;
      };
    };

    assert.equal(prepared.draft.title, "Original title");
    assert.equal(prepared.draft.url, "https://example.com/article");
    assert.equal(prepared.publicationPolicy.apiAccess, "read-only");
    assert.equal(prepared.publicationPolicy.automatedPublishingSupported, false);
    assert.equal(
      prepared.publicationPolicy.guidelinesUrl,
      "https://news.ycombinator.com/newsguidelines.html",
    );
  });

  test("surfaces official API failures and missing items clearly", async () => {
    globalThis.fetch = (async () => json(null)) as typeof fetch;
    await assert.rejects(
      hackerNewsProvider.invokeTool("get_item", { itemId: 999 }, runtime()),
      /item 999 was not found/,
    );

    globalThis.fetch = (async () => json({ error: "down" }, 503)) as typeof fetch;
    await assert.rejects(
      hackerNewsProvider.invokeTool("get_updates", {}, runtime()),
      /Hacker News API 503/,
    );
  });
});
