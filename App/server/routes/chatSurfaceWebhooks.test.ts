import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHAT_SURFACE_PROVIDER_IDS,
  type ChatSurfaceAdapter,
  type ChatSurfaceWebhookResult,
  type InboundChatTurn,
} from "../services/chatSurfaces/types.js";
import {
  CHAT_SURFACE_WEBHOOK_MOUNT,
  chatSurfaceWebhookParamsSchema,
  chatSurfaceWebhookUrl,
  chatSurfaceWebhooksRouter,
  normalizeWebhookHeaders,
  resolveWebhookTarget,
  shapeWebhookResult,
} from "./chatSurfaceWebhooks.js";

/**
 * This router is the only part of an external chat surface an unauthenticated
 * stranger can reach, and it answers before any session middleware has run. So
 * what is worth testing here is not that a happy path returns 200 — it is the
 * three properties that make the endpoint safe to expose at all:
 *
 *  - every way of being wrong looks identical from outside (404, no body), so
 *    the URL cannot be used to enumerate Connection ids;
 *  - the status a platform sees matches the retry contract it will act on,
 *    because a wrong one turns one message into a redelivery storm;
 *  - nothing the caller controls — a duplicated header, a `__proto__` header,
 *    a provider segment full of path traversal — reaches a lookup intact.
 *
 * All of it is reachable without a database, which is the point of the route
 * being this thin.
 */

const UUID = "6f1c2f2c-4c3b-4f4a-9d3e-2a1b0c9d8e7f";
const OTHER_UUID = "11111111-2222-4333-8444-555555555555";

function fakeAdapter(overrides: Partial<ChatSurfaceAdapter> = {}): ChatSurfaceAdapter {
  return {
    provider: "slack",
    transport: "webhook",
    textLimit: 3000,
    requiresPublicUrl: true,
    async send() {
      /* never called by the pure decisions under test */
    },
    webhook: {
      async verifyAndNormalize() {
        return { kind: "turns", turns: [] };
      },
    },
    ...overrides,
  };
}

function fakeTurn(text: string): InboundChatTurn {
  return {
    provider: "slack",
    connectionId: UUID,
    companyId: OTHER_UUID,
    externalKey: "C123:1700000000.000100",
    externalUserId: "U123",
    externalUserLabel: "Ada",
    threadTitle: null,
    text,
    group: false,
    externalMessageId: "1700000000.000100",
    replyTo: { channel: "C123" },
  };
}

describe("webhook path params", () => {
  test("every registered chat surface is a legal provider segment", () => {
    assert.equal(CHAT_SURFACE_PROVIDER_IDS.length, 4);
    for (const provider of CHAT_SURFACE_PROVIDER_IDS) {
      const parsed = chatSurfaceWebhookParamsSchema.safeParse({
        provider,
        connectionId: UUID,
      });
      assert.equal(parsed.success, true, provider);
      if (parsed.success) assert.equal(parsed.data.provider, provider);
    }
  });

  test("Microsoft Teams is addressed by its hyphenated id, never by 'teams'", () => {
    assert.equal(
      chatSurfaceWebhookParamsSchema.safeParse({
        provider: "microsoft-teams",
        connectionId: UUID,
      }).success,
      true,
    );
    // "Teams" alone is the org-chart entity. A URL that accepted it would put
    // two unrelated nouns on the same path segment.
    assert.equal(
      chatSurfaceWebhookParamsSchema.safeParse({ provider: "teams", connectionId: UUID }).success,
      false,
    );
    assert.equal(
      chatSurfaceWebhookParamsSchema.safeParse({
        provider: "microsoft teams",
        connectionId: UUID,
      }).success,
      false,
    );
  });

  test("an unknown or hostile provider segment never parses", () => {
    for (const provider of [
      "discord",
      "Slack",
      "SLACK",
      " slack",
      "slack ",
      "",
      "../../etc/passwd",
      "slack/../telegram",
      "__proto__",
      "constructor",
      "slаck",
    ]) {
      assert.equal(
        chatSurfaceWebhookParamsSchema.safeParse({ provider, connectionId: UUID }).success,
        false,
        JSON.stringify(provider),
      );
    }
  });

  test("the connection segment must be a uuid, so a probe cannot walk ids", () => {
    for (const connectionId of [
      "1",
      "abc",
      "",
      `${UUID} `,
      ` ${UUID}`,
      `${UUID}/extra`,
      "00000000-0000-0000-0000-00000000000",
      "'; drop table integration_connections; --",
    ]) {
      assert.equal(
        chatSurfaceWebhookParamsSchema.safeParse({ provider: "slack", connectionId }).success,
        false,
        JSON.stringify(connectionId),
      );
    }
  });

  test("an extra path key is a different route, not this one", () => {
    assert.equal(
      chatSurfaceWebhookParamsSchema.safeParse({
        provider: "slack",
        connectionId: UUID,
        companyId: OTHER_UUID,
      }).success,
      false,
    );
  });

  test("a missing segment fails rather than defaulting", () => {
    assert.equal(chatSurfaceWebhookParamsSchema.safeParse({ provider: "slack" }).success, false);
    assert.equal(
      chatSurfaceWebhookParamsSchema.safeParse({ connectionId: UUID }).success,
      false,
    );
    assert.equal(chatSurfaceWebhookParamsSchema.safeParse({}).success, false);
  });
});

describe("resolveWebhookTarget", () => {
  test("a real connection on a webhook surface resolves to that surface's half", () => {
    const adapter = fakeAdapter();
    const target = resolveWebhookTarget({
      provider: "slack",
      connection: { provider: "slack" },
      adapter,
    });
    assert.ok(target);
    assert.equal(target.adapter, adapter);
    assert.equal(target.webhook, adapter.webhook);
    assert.deepEqual(target.connection, { provider: "slack" });
  });

  test("a connection that does not exist is indistinguishable from one that does", () => {
    assert.equal(
      resolveWebhookTarget({ provider: "slack", connection: null, adapter: fakeAdapter() }),
      null,
    );
  });

  test("a Connection belonging to another provider does not answer on this path", () => {
    // The Connection id is real, the URL names the wrong surface. Answering
    // anything other than 404 would confirm the id exists.
    assert.equal(
      resolveWebhookTarget({
        provider: "slack",
        connection: { provider: "telegram" },
        adapter: fakeAdapter(),
      }),
      null,
    );
    assert.equal(
      resolveWebhookTarget({
        provider: "whatsapp",
        connection: { provider: "stripe" },
        adapter: fakeAdapter({ provider: "whatsapp" }),
      }),
      null,
    );
  });

  test("an unregistered adapter resolves to nothing", () => {
    assert.equal(
      resolveWebhookTarget({ provider: "slack", connection: { provider: "slack" }, adapter: null }),
      null,
    );
  });

  test("a surface with no HTTP half is a 404, not an empty 200", () => {
    // Telegram long-polls; there is no delivery URL to be found here, and
    // saying so with the same 404 keeps the shape uniform.
    assert.equal(
      resolveWebhookTarget({
        provider: "telegram",
        connection: { provider: "telegram" },
        adapter: fakeAdapter({ provider: "telegram", transport: "poll", webhook: undefined }),
      }),
      null,
    );
  });

  test("the caller's own connection row is handed back untouched", () => {
    const connection = { provider: "whatsapp", id: UUID, companyId: OTHER_UUID };
    const target = resolveWebhookTarget({
      provider: "whatsapp",
      connection,
      adapter: fakeAdapter({ provider: "whatsapp" }),
    });
    assert.ok(target);
    assert.equal(target.connection, connection);
  });
});

describe("shapeWebhookResult", () => {
  test("verified turns are acknowledged with a bare 200 and handed on", () => {
    const turns = [fakeTurn("what's our runway"), fakeTurn("and last month's burn")];
    const shaped = shapeWebhookResult({ kind: "turns", turns });
    assert.equal(shaped.response.status, 200);
    assert.equal(shaped.response.body, "");
    assert.equal(shaped.turns.length, 2);
    assert.equal(shaped.turns[0], turns[0]);
    assert.equal(shaped.turns[1], turns[1]);
  });

  test("a verified delivery carrying nothing to do is still a 200", () => {
    // Slack sends events this surface ignores — a bot's own message, a
    // reaction. Anything but 200 asks for the same event again in 3 seconds.
    const shaped = shapeWebhookResult({ kind: "turns", turns: [] });
    assert.equal(shaped.response.status, 200);
    assert.deepEqual(shaped.turns, []);
  });

  test("a platform-specified body is returned verbatim", () => {
    const shaped = shapeWebhookResult({
      kind: "respond",
      response: { status: 200, body: "3f8a2b", contentType: "text/plain" },
    });
    assert.deepEqual(shaped.response, { status: 200, body: "3f8a2b", contentType: "text/plain" });
    assert.deepEqual(shaped.turns, []);
  });

  test("a respond verdict keeps whatever status the adapter chose", () => {
    for (const status of [200, 201, 400, 403, 500]) {
      const shaped = shapeWebhookResult({
        kind: "respond",
        response: { status, body: "x" },
      });
      assert.equal(shaped.response.status, status);
      assert.deepEqual(shaped.turns, []);
    }
  });

  test("a rejection answers its own status and nothing else", () => {
    for (const status of [400, 401, 403, 404, 408, 429, 500, 503]) {
      const shaped = shapeWebhookResult({ kind: "reject", status });
      assert.equal(shaped.response.status, status);
      assert.equal(shaped.response.body, "");
      assert.equal(shaped.response.contentType, undefined);
      assert.deepEqual(shaped.turns, []);
    }
  });

  test("a rejection can never come out as a success", () => {
    // A 2xx tells the platform the delivery landed. A refusal that said so
    // would drop the message silently instead of getting it redelivered.
    for (const status of [0, 100, 200, 204, 302, 399]) {
      const shaped = shapeWebhookResult({ kind: "reject", status });
      assert.equal(shaped.response.status, 400, `reject(${status})`);
      assert.ok(shaped.response.status >= 400);
    }
  });

  test("a verdict this router does not recognise is not an acknowledgement", () => {
    const shaped = shapeWebhookResult({ kind: "maybe" } as unknown as ChatSurfaceWebhookResult);
    assert.equal(shaped.response.status, 500);
    assert.deepEqual(shaped.turns, []);
    assert.ok(shaped.response.status >= 400);
  });

  test("no verdict ever produces turns alongside a non-2xx", () => {
    const verdicts: ChatSurfaceWebhookResult[] = [
      { kind: "turns", turns: [fakeTurn("hi")] },
      { kind: "respond", response: { status: 401, body: "no" } },
      { kind: "reject", status: 401 },
    ];
    for (const verdict of verdicts) {
      const shaped = shapeWebhookResult(verdict);
      if (shaped.turns.length > 0) assert.equal(shaped.response.status, 200);
    }
  });
});

describe("chatSurfaceWebhookUrl", () => {
  test("builds the URL an operator pastes into Slack, Meta, or Azure", () => {
    assert.equal(
      chatSurfaceWebhookUrl("https://genosyn.example.com", "microsoft-teams", UUID),
      `https://genosyn.example.com${CHAT_SURFACE_WEBHOOK_MOUNT}/microsoft-teams/${UUID}`,
    );
  });

  test("a public URL saved with a trailing slash does not produce a double slash", () => {
    assert.equal(
      chatSurfaceWebhookUrl("https://genosyn.example.com/", "slack", UUID),
      `https://genosyn.example.com${CHAT_SURFACE_WEBHOOK_MOUNT}/slack/${UUID}`,
    );
    assert.equal(
      chatSurfaceWebhookUrl("https://genosyn.example.com///", "slack", UUID),
      `https://genosyn.example.com${CHAT_SURFACE_WEBHOOK_MOUNT}/slack/${UUID}`,
    );
  });

  test("segments are encoded, so nothing can be smuggled into the path", () => {
    const url = chatSurfaceWebhookUrl("https://x.test", "slack/../admin", "a b?c=d");
    assert.ok(url.startsWith(`https://x.test${CHAT_SURFACE_WEBHOOK_MOUNT}/`));
    assert.ok(!url.includes("../"));
    assert.ok(!url.includes("?"));
    assert.ok(url.endsWith("/slack%2F..%2Fadmin/a%20b%3Fc%3Dd"));
  });

  test("the mount constant is the path the URL is built from", () => {
    assert.equal(CHAT_SURFACE_WEBHOOK_MOUNT, "/api/chat-surfaces/webhook");
    assert.ok(chatSurfaceWebhookUrl("http://localhost:3000", "whatsapp", UUID).includes(
      CHAT_SURFACE_WEBHOOK_MOUNT,
    ));
  });

  test("a localhost default still renders — the caller decides whether it is usable", () => {
    assert.equal(
      chatSurfaceWebhookUrl("http://localhost:5173", "whatsapp", UUID),
      `http://localhost:5173${CHAT_SURFACE_WEBHOOK_MOUNT}/whatsapp/${UUID}`,
    );
  });
});

describe("normalizeWebhookHeaders", () => {
  test("string headers survive with lowercased names", () => {
    const headers = normalizeWebhookHeaders({
      "X-Slack-Signature": "v0=abc",
      "X-Slack-Request-Timestamp": "1700000000",
      "content-type": "application/json",
    });
    assert.equal(headers["x-slack-signature"], "v0=abc");
    assert.equal(headers["x-slack-request-timestamp"], "1700000000");
    assert.equal(headers["content-type"], "application/json");
  });

  test("a header sent twice is dropped rather than joined", () => {
    // Verification computes over one value. Handing an adapter either half of
    // an ambiguous pair would let the second copy ride along unverified.
    const headers = normalizeWebhookHeaders({
      "x-hub-signature-256": ["sha256=aaa", "sha256=bbb"],
    });
    assert.equal(headers["x-hub-signature-256"], undefined);
    assert.equal(Object.keys(headers).length, 0);
  });

  test("absent headers stay absent", () => {
    const headers = normalizeWebhookHeaders({ "x-signature": undefined });
    assert.equal(headers["x-signature"], undefined);
    assert.deepEqual(Object.keys(headers), []);
  });

  test("the map has a null prototype, so a __proto__ header cannot reach one", () => {
    // Written as a computed key on purpose: `{ __proto__: … }` in a literal is
    // the prototype setter, not an own property, and would test nothing.
    const headers = normalizeWebhookHeaders({
      ["__proto__"]: "polluted",
      authorization: "Bearer x",
    });
    assert.equal(Object.getPrototypeOf(headers), null);
    assert.equal(headers["authorization"], "Bearer x");
    assert.equal(headers["__proto__"], "polluted");
    assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  test("a header named like a prototype member reads back as itself", () => {
    const headers = normalizeWebhookHeaders({ constructor: "nope", toString: "also nope" });
    assert.equal(headers["constructor"], "nope");
    // Lowercased like every other name, so this is the key an adapter asks for.
    assert.equal(headers["tostring"], "also nope");
    assert.equal(typeof headers["hasOwnProperty"], "undefined");
  });

  test("unicode and empty values are preserved as sent", () => {
    const headers = normalizeWebhookHeaders({ "x-label": "café ☕", "x-empty": "" });
    assert.equal(headers["x-label"], "café ☕");
    assert.equal(headers["x-empty"], "");
    assert.equal(Object.keys(headers).length, 2);
  });

  test("an empty header set produces an empty map, not a throw", () => {
    assert.deepEqual(Object.keys(normalizeWebhookHeaders({})), []);
  });
});

describe("router shape", () => {
  type RouteLayer = { path?: unknown; methods?: Record<string, boolean> };
  const stack = (
    chatSurfaceWebhooksRouter as unknown as {
      stack?: Array<{ route?: RouteLayer }>;
    }
  ).stack;

  test("the raw body parser is installed ahead of every route", () => {
    // Signature verification needs the bytes as sent. A route that ran before
    // the parser would see no body at all.
    assert.ok(stack);
    const firstRouteIndex = stack.findIndex((layer) => layer.route);
    assert.ok(firstRouteIndex > 0, "no middleware is installed before the routes");
    for (let i = 0; i < firstRouteIndex; i += 1) {
      assert.equal(stack[i].route, undefined);
    }
  });

  test("exactly two routes exist, both on the provider/connection path", () => {
    assert.ok(stack);
    const routes = stack
      .map((layer) => layer.route)
      .filter((route): route is RouteLayer => Boolean(route));
    assert.equal(routes.length, 2);
    for (const route of routes) {
      assert.equal(route.path, "/:provider/:connectionId");
    }
    assert.equal(routes.some((route) => route.methods?.get === true), true);
    assert.equal(routes.some((route) => route.methods?.post === true), true);
  });

  test("nothing else is reachable on this mount", () => {
    assert.ok(stack);
    const methods = stack
      .map((layer) => layer.route?.methods ?? {})
      .flatMap((entry) => Object.keys(entry));
    assert.deepEqual([...new Set(methods)].sort(), ["get", "post"]);
  });
});
