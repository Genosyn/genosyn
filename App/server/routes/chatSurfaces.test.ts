import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ExternalChatIdentity } from "../db/entities/ExternalChatIdentity.js";
import type { Role } from "../db/entities/Membership.js";
import { matchesRoutePath } from "../middleware/auth.js";
import type { ChatSurfaceAdapter } from "../services/chatSurfaces/types.js";
import { CHAT_SURFACE_WEBHOOK_MOUNT } from "./chatSurfaceWebhooks.js";
import {
  BIND_FAILURE_REASONS,
  CHAT_SURFACE_ADMIN_PATHS,
  bindBodySchema,
  bindFailureResponse,
  canUnbindIdentity,
  chatSurfaceBindRouter,
  chatSurfacesRouter,
  describeWebhookEndpoint,
  identityListQuerySchema,
  serializeBoundIdentity,
  webhookUrlQuerySchema,
} from "./chatSurfaces.js";

/**
 * Both routers here are thin, so these tests go after the four decisions the
 * thinness pushed into pure functions: who may cut a binding, which paths the
 * admin gate covers, what each bind failure tells the browser, and what the
 * bind endpoint refuses to read out of a request body.
 *
 * The last one is the load-bearing case. `bindIdentity` takes the Member's id
 * from the session, and the schema is what stops a caller from offering one of
 * their own — a body-supplied user id would let anybody holding a link hand a
 * stranger's Slack account the company's authority.
 */

const UUID = "6f1c2f2c-4c3b-4f4a-9d3e-2a1b0c9d8e7f";
const OTHER_UUID = "11111111-2222-4333-8444-555555555555";
const THIRD_UUID = "22222222-3333-4444-8555-666666666666";

function identityRow(overrides: Partial<ExternalChatIdentity> = {}): ExternalChatIdentity {
  return {
    id: UUID,
    companyId: OTHER_UUID,
    provider: "slack",
    connectionId: THIRD_UUID,
    externalUserId: "U0A1B2C3",
    externalUserLabel: "Ada Lovelace",
    userId: null,
    boundAt: null,
    boundVia: null,
    linkTokenHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    linkExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as ExternalChatIdentity;
}

function fakeAdapter(overrides: Partial<ChatSurfaceAdapter> = {}): ChatSurfaceAdapter {
  return {
    provider: "slack",
    transport: "webhook",
    textLimit: 3000,
    requiresPublicUrl: true,
    async send() {
      /* not reached by the pure shaping under test */
    },
    webhook: {
      async verifyAndNormalize() {
        return { kind: "turns", turns: [] };
      },
    },
    ...overrides,
  };
}

describe("admin gate scoping", () => {
  test("the identity list and the webhook URL are admin reads", () => {
    assert.equal(matchesRoutePath("/chat-surfaces/identities", CHAT_SURFACE_ADMIN_PATHS), true);
    assert.equal(matchesRoutePath("/chat-surfaces/identities/", CHAT_SURFACE_ADMIN_PATHS), true);
    assert.equal(matchesRoutePath("/chat-surfaces/webhook-url", CHAT_SURFACE_ADMIN_PATHS), true);
  });

  test("cutting one binding is not covered, so a Member can cut their own", () => {
    // A plain string matcher would swallow this child path — which is exactly
    // the bug the anchored regex exists to prevent.
    assert.equal(
      matchesRoutePath(`/chat-surfaces/identities/${UUID}`, CHAT_SURFACE_ADMIN_PATHS),
      false,
    );
    assert.equal(
      matchesRoutePath("/chat-surfaces/identities/anything", CHAT_SURFACE_ADMIN_PATHS),
      false,
    );
  });

  test("the gate is case-insensitive, the way Express routing is", () => {
    assert.equal(matchesRoutePath("/CHAT-SURFACES/IDENTITIES", CHAT_SURFACE_ADMIN_PATHS), true);
    assert.equal(matchesRoutePath("/Chat-Surfaces/Webhook-Url", CHAT_SURFACE_ADMIN_PATHS), true);
  });

  test("routers sharing the /api/companies/:cid mount are left alone", () => {
    for (const path of [
      "/routines",
      "/standdowns",
      "/integrations/connections",
      "/chat-surfaces",
      "/chat-surfaces/bind",
      "/chat-surfaces-identities",
      "/chat-surfaces/webhook-urls",
    ]) {
      assert.equal(matchesRoutePath(path, CHAT_SURFACE_ADMIN_PATHS), false, path);
    }
  });
});

describe("canUnbindIdentity", () => {
  const bound = "user-ada";
  const other = "user-grace";

  test("an admin or owner may revoke anyone's binding", () => {
    for (const role of ["admin", "owner"] as Role[]) {
      assert.equal(
        canUnbindIdentity({ role, actorUserId: other, boundUserId: bound }),
        true,
        role,
      );
      assert.equal(canUnbindIdentity({ role, actorUserId: other, boundUserId: null }), true, role);
    }
  });

  test("a Member may always cut their own link", () => {
    assert.equal(
      canUnbindIdentity({ role: "member", actorUserId: bound, boundUserId: bound }),
      true,
    );
  });

  test("a Member may not cut a colleague's", () => {
    assert.equal(
      canUnbindIdentity({ role: "member", actorUserId: other, boundUserId: bound }),
      false,
    );
  });

  test("an unbound row belongs to nobody, so nobody claims it by having no id", () => {
    assert.equal(
      canUnbindIdentity({ role: "member", actorUserId: null, boundUserId: null }),
      false,
    );
    assert.equal(
      canUnbindIdentity({ role: "member", actorUserId: bound, boundUserId: null }),
      false,
    );
    assert.equal(
      canUnbindIdentity({ role: "member", actorUserId: null, boundUserId: bound }),
      false,
    );
  });

  test("no resolved role means no Membership was proved", () => {
    assert.equal(
      canUnbindIdentity({ role: undefined, actorUserId: bound, boundUserId: bound }),
      false,
    );
    assert.equal(
      canUnbindIdentity({ role: undefined, actorUserId: bound, boundUserId: null }),
      false,
    );
  });
});

describe("bind outcome to HTTP status", () => {
  test("every reason the service can return is mapped", () => {
    assert.deepEqual(
      [...BIND_FAILURE_REASONS].sort(),
      ["already_bound", "expired", "forbidden", "not_found"],
    );
  });

  test("each reason gets the status its situation deserves", () => {
    assert.equal(bindFailureResponse("not_found").status, 404);
    assert.equal(bindFailureResponse("expired").status, 410);
    assert.equal(bindFailureResponse("already_bound").status, 409);
    assert.equal(bindFailureResponse("forbidden").status, 403);
  });

  test("no reason can produce a success", () => {
    for (const reason of BIND_FAILURE_REASONS) {
      const failure = bindFailureResponse(reason);
      assert.ok(failure.status >= 400, reason);
      assert.ok(failure.status < 500, reason);
      assert.ok(failure.error.length > 0, reason);
    }
  });

  test("the four statuses are distinct, because the page has four things to say", () => {
    const statuses = BIND_FAILURE_REASONS.map((reason) => bindFailureResponse(reason).status);
    assert.equal(new Set(statuses).size, BIND_FAILURE_REASONS.length);
    const messages = BIND_FAILURE_REASONS.map((reason) => bindFailureResponse(reason).error);
    assert.equal(new Set(messages).size, BIND_FAILURE_REASONS.length);
  });

  test("copy calls it an AI Employee", () => {
    assert.match(bindFailureResponse("expired").error, /AI Employee/);
    assert.match(bindFailureResponse("not_found").error, /AI Employee/);
    for (const reason of BIND_FAILURE_REASONS) {
      assert.doesNotMatch(bindFailureResponse(reason).error, /\b(bot|agent|assistant)\b/i);
    }
  });

  test("a reason nobody mapped becomes a 400, never a 200", () => {
    for (const reason of ["", "banana", "ok", "true", "200"]) {
      const failure = bindFailureResponse(reason);
      assert.equal(failure.status, 400, reason);
      assert.ok(failure.error.length > 0, reason);
    }
  });

  test("a prototype member is not a mapped reason", () => {
    // A plain lookup answers `__proto__` and `constructor` with something
    // truthy, and reading `.status` off it would hand `res.status()` undefined.
    for (const reason of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const failure = bindFailureResponse(reason);
      assert.equal(failure.status, 400, reason);
      assert.equal(typeof failure.error, "string", reason);
    }
  });
});

describe("bind body schema", () => {
  test("accepts an identity id and its single-use token", () => {
    const parsed = bindBodySchema.safeParse({ identityId: UUID, token: "abc123" });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.identityId, UUID);
      assert.equal(parsed.data.token, "abc123");
    }
  });

  test("refuses a body that names the Member — the session does that", () => {
    for (const extra of [
      { userId: OTHER_UUID },
      { user_id: OTHER_UUID },
      { companyId: OTHER_UUID },
      { role: "owner" },
      { boundVia: "link" },
    ]) {
      assert.equal(
        bindBodySchema.safeParse({ identityId: UUID, token: "abc123", ...extra }).success,
        false,
        JSON.stringify(extra),
      );
    }
  });

  test("both fields are required", () => {
    assert.equal(bindBodySchema.safeParse({ identityId: UUID }).success, false);
    assert.equal(bindBodySchema.safeParse({ token: "abc123" }).success, false);
    assert.equal(bindBodySchema.safeParse({}).success, false);
  });

  test("an empty or non-string token is not a token", () => {
    for (const token of ["", null, 1234, true, [], {}, undefined]) {
      assert.equal(
        bindBodySchema.safeParse({ identityId: UUID, token }).success,
        false,
        JSON.stringify(token ?? null),
      );
    }
  });

  test("the identity id must be a uuid", () => {
    for (const identityId of ["", "abc", 1, null, `${UUID} `, [UUID]]) {
      assert.equal(
        bindBodySchema.safeParse({ identityId, token: "abc123" }).success,
        false,
        JSON.stringify(identityId),
      );
    }
  });

  test("the token is bounded, because it arrives from a pasted URL", () => {
    assert.equal(
      bindBodySchema.safeParse({ identityId: UUID, token: "x".repeat(512) }).success,
      true,
    );
    assert.equal(
      bindBodySchema.safeParse({ identityId: UUID, token: "x".repeat(513) }).success,
      false,
    );
    assert.equal(
      bindBodySchema.safeParse({ identityId: UUID, token: "x".repeat(100_000) }).success,
      false,
    );
  });

  test("the token is opaque, so unicode is not the schema's business", () => {
    const parsed = bindBodySchema.safeParse({ identityId: UUID, token: "тоkен☕" });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.token, "тоkен☕");
  });

  test("a non-object body is rejected outright", () => {
    for (const body of [null, undefined, "abc", 42, [{ identityId: UUID, token: "x" }]]) {
      assert.equal(bindBodySchema.safeParse(body).success, false, JSON.stringify(body ?? null));
    }
  });
});

describe("identity list and webhook URL queries", () => {
  test("the connection filter is optional", () => {
    const parsed = identityListQuerySchema.safeParse({});
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.connectionId, undefined);
  });

  test("a connection filter must be a uuid", () => {
    assert.equal(identityListQuerySchema.safeParse({ connectionId: UUID }).success, true);
    for (const connectionId of ["", "all", "1", [UUID], null]) {
      assert.equal(
        identityListQuerySchema.safeParse({ connectionId }).success,
        false,
        JSON.stringify(connectionId),
      );
    }
  });

  test("an unrecognised query parameter is rejected rather than ignored", () => {
    assert.equal(
      identityListQuerySchema.safeParse({ connectionId: UUID, companyId: OTHER_UUID }).success,
      false,
    );
    assert.equal(identityListQuerySchema.safeParse({ bound: "true" }).success, false);
  });

  test("the webhook URL query names exactly one connection", () => {
    assert.equal(webhookUrlQuerySchema.safeParse({ connectionId: UUID }).success, true);
    assert.equal(webhookUrlQuerySchema.safeParse({}).success, false);
    assert.equal(webhookUrlQuerySchema.safeParse({ connectionId: "nope" }).success, false);
    assert.equal(
      webhookUrlQuerySchema.safeParse({ connectionId: [UUID, OTHER_UUID] }).success,
      false,
    );
    assert.equal(
      webhookUrlQuerySchema.safeParse({ connectionId: UUID, provider: "slack" }).success,
      false,
    );
  });
});

describe("describeWebhookEndpoint", () => {
  const connection = { id: THIRD_UUID, provider: "microsoft-teams" };

  test("reports the pasteable URL alongside whether it will actually work", () => {
    const described = describeWebhookEndpoint({
      publicUrl: "https://genosyn.example.com",
      publicUrlConfigured: true,
      connection,
      adapter: fakeAdapter({ provider: "microsoft-teams" }),
    });
    assert.deepEqual(described, {
      provider: "microsoft-teams",
      connectionId: THIRD_UUID,
      url: `https://genosyn.example.com${CHAT_SURFACE_WEBHOOK_MOUNT}/microsoft-teams/${THIRD_UUID}`,
      publicUrlConfigured: true,
      requiresPublicUrl: true,
      supportsWebhook: true,
    });
  });

  test("an unconfigured public URL still renders a URL, and says it is not real", () => {
    // The operator needs both facts: a localhost URL is a perfectly valid
    // string and a completely useless thing to hand Meta.
    const described = describeWebhookEndpoint({
      publicUrl: "http://localhost:3000",
      publicUrlConfigured: false,
      connection,
      adapter: fakeAdapter({ provider: "microsoft-teams" }),
    });
    assert.equal(described.publicUrlConfigured, false);
    assert.equal(described.requiresPublicUrl, true);
    assert.ok(described.url.startsWith("http://localhost:3000/"));
  });

  test("a poll-only surface says the URL is decoration", () => {
    const described = describeWebhookEndpoint({
      publicUrl: "https://genosyn.example.com",
      publicUrlConfigured: true,
      connection: { id: THIRD_UUID, provider: "telegram" },
      adapter: fakeAdapter({
        provider: "telegram",
        transport: "poll",
        requiresPublicUrl: false,
        webhook: undefined,
      }),
    });
    assert.equal(described.supportsWebhook, false);
    assert.equal(described.requiresPublicUrl, false);
    assert.equal(described.provider, "telegram");
  });
});

describe("serializeBoundIdentity", () => {
  test("returns only what the confirmation screen needs", () => {
    const serialized = serializeBoundIdentity(
      identityRow({ userId: "user-ada", boundAt: new Date("2026-02-03T04:05:06.000Z") }),
    );
    assert.deepEqual(Object.keys(serialized).sort(), [
      "boundAt",
      "connectionId",
      "externalUserLabel",
      "id",
      "provider",
    ]);
    assert.equal(serialized.boundAt, "2026-02-03T04:05:06.000Z");
    assert.equal(serialized.provider, "slack");
    assert.equal(serialized.externalUserLabel, "Ada Lovelace");
  });

  test("never carries the link token hash or the Member's id", () => {
    const serialized = serializeBoundIdentity(identityRow({ userId: "user-ada" })) as Record<
      string,
      unknown
    >;
    assert.equal(serialized.linkTokenHash, undefined);
    assert.equal(serialized.linkExpiresAt, undefined);
    assert.equal(serialized.userId, undefined);
    assert.equal(serialized.companyId, undefined);
  });

  test("a sender with no display name serializes as null, not as an empty string", () => {
    const serialized = serializeBoundIdentity(
      identityRow({ externalUserLabel: null, boundAt: null }),
    );
    assert.equal(serialized.externalUserLabel, null);
    assert.equal(serialized.boundAt, null);
  });
});

describe("router shape", () => {
  type RouteLayer = { path?: unknown; methods?: Record<string, boolean> };
  type StackLayer = { route?: RouteLayer };

  function routesOf(router: unknown): RouteLayer[] {
    const stack = (router as { stack?: StackLayer[] }).stack;
    assert.ok(stack, "router exposes no route stack");
    return stack.map((layer) => layer.route).filter((route): route is RouteLayer => Boolean(route));
  }

  test("the company router owns three routes and every one is under /chat-surfaces", () => {
    const routes = routesOf(chatSurfacesRouter);
    assert.equal(routes.length, 3);
    for (const route of routes) {
      assert.equal(typeof route.path, "string");
      assert.ok(String(route.path).startsWith("/chat-surfaces"), String(route.path));
    }
  });

  test("each company route is registered with the method it is meant to have", () => {
    const routes = routesOf(chatSurfacesRouter);
    const byPath = new Map(routes.map((route) => [String(route.path), route.methods ?? {}]));
    assert.equal(byPath.get("/chat-surfaces/identities")?.get, true);
    assert.equal(byPath.get("/chat-surfaces/identities")?.post, undefined);
    assert.equal(byPath.get("/chat-surfaces/identities/:id")?.delete, true);
    assert.equal(byPath.get("/chat-surfaces/webhook-url")?.get, true);
    assert.equal(byPath.get("/chat-surfaces/webhook-url")?.delete, undefined);
  });

  test("the bind router is the preview and the bind, and nothing else", () => {
    const routes = routesOf(chatSurfaceBindRouter);
    // Two, deliberately. The preview exists so the page can name the chat
    // account before anybody confirms it — binding on page load made a
    // forwarded URL enough to attach the opener's authority to somebody
    // else's account. Both are POSTs: neither belongs in a URL a browser
    // will prefetch, replay, or leave in history.
    assert.deepEqual(
      routes.map((route) => String(route.path)).sort(),
      ["/chat-surfaces/bind", "/chat-surfaces/bind/preview"],
    );
    for (const route of routes) {
      assert.equal(route.methods?.post, true, String(route.path));
      assert.equal(route.methods?.get, undefined, String(route.path));
    }
  });

  test("the bind router installs no router-level middleware", () => {
    // It is mounted at bare `/api`. A `.use()` here would also run on every
    // route of every other router sharing that mount, so its auth is attached
    // to the route instead.
    const stack = (chatSurfaceBindRouter as unknown as { stack?: StackLayer[] }).stack;
    assert.ok(stack);
    for (const layer of stack) {
      assert.ok(layer.route, "the bind router has a layer that is not a route");
    }
  });
});
