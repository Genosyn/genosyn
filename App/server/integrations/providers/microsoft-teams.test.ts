import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  botFrameworkCacheKey,
  botFrameworkErrorMessage,
  botFrameworkFetch,
  botFrameworkToken,
  botFrameworkTokenUrl,
  cacheBotFrameworkToken,
  clearBotFrameworkTokenCache,
  isUsableServiceUrl,
  microsoftErrorMessage,
  microsoftTeamsProvider,
  normalizeServiceUrl,
  readCachedBotFrameworkToken,
  summarizeMembers,
  TOKEN_REFRESH_SKEW_MS,
  type MicrosoftTeamsConfig,
} from "./microsoft-teams.js";
import type { IntegrationRuntimeContext } from "../types.js";

/**
 * Everything here runs without a socket. The two things this connector can
 * get wrong in a way a type will not catch are both offline facts: which
 * Entra authority a bot authenticates against, and whether a cached token
 * lets a revoked secret keep reporting Connected.
 */

const CONFIG: MicrosoftTeamsConfig = {
  appId: "11111111-2222-3333-4444-555555555555",
  appPassword: "s3cret-value",
};

function ctx(overrides: Partial<IntegrationRuntimeContext> = {}): IntegrationRuntimeContext {
  return {
    authMode: "apikey",
    config: CONFIG as unknown as Record<string, unknown>,
    ...overrides,
  };
}

beforeEach(() => {
  clearBotFrameworkTokenCache();
});

describe("catalog", () => {
  test("declares the ids the chat-surface registry expects", () => {
    assert.equal(microsoftTeamsProvider.catalog.provider, "microsoft-teams");
    assert.equal(microsoftTeamsProvider.catalog.name, "Microsoft Teams");
    assert.equal(microsoftTeamsProvider.catalog.category, "Communication");
    assert.equal(microsoftTeamsProvider.catalog.authMode, "apikey");
    assert.equal(microsoftTeamsProvider.catalog.enabled, true);
  });

  test("collects the client-credentials triple, secret masked and tenant optional", () => {
    const fields = microsoftTeamsProvider.catalog.fields ?? [];
    assert.deepEqual(
      fields.map((f) => f.key),
      ["appId", "appPassword", "tenantId"],
    );
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    assert.equal(byKey.appId.required, true);
    assert.equal(byKey.appId.type, "text");
    assert.equal(byKey.appPassword.required, true);
    assert.equal(byKey.appPassword.type, "password");
    assert.equal(byKey.tenantId.required, false);
    assert.match(byKey.tenantId.hint ?? "", /single-tenant/i);
  });

  /**
   * "Teams" on its own is Genosyn's org-chart entity. Every mention in this
   * connector's copy has to be the product, spelled out.
   */
  test("never says Teams without Microsoft in front of it", () => {
    const copy = [
      microsoftTeamsProvider.catalog.name,
      microsoftTeamsProvider.catalog.tagline,
      microsoftTeamsProvider.catalog.description ?? "",
      ...microsoftTeamsProvider.tools.map((t) => t.description),
    ].join("\n");
    for (const match of copy.matchAll(/Teams/g)) {
      const before = copy.slice(Math.max(0, match.index - 10), match.index);
      assert.ok(before.endsWith("Microsoft "), `bare "Teams" near: ${before}Teams`);
    }
  });

  test("calls the responder an AI Employee", () => {
    const copy = `${microsoftTeamsProvider.catalog.tagline} ${microsoftTeamsProvider.catalog.description ?? ""}`;
    assert.match(copy, /AI Employee/);
    assert.doesNotMatch(copy, /\bassistant\b/i);
    assert.doesNotMatch(copy, /\bagent\b/i);
  });

  test("says out loud that the surface needs a public URL", () => {
    assert.match(microsoftTeamsProvider.catalog.description ?? "", /publicly reachable/i);
  });
});

describe("tools", () => {
  test("exposes exactly send_message and list_conversation_members", () => {
    assert.deepEqual(
      microsoftTeamsProvider.tools.map((t) => t.name).sort(),
      ["list_conversation_members", "send_message"],
    );
  });

  test("both refuse unknown arguments and require a conversationId", () => {
    for (const tool of microsoftTeamsProvider.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.ok(tool.inputSchema.required?.includes("conversationId"), tool.name);
    }
    const send = microsoftTeamsProvider.tools.find((t) => t.name === "send_message")!;
    assert.deepEqual(send.inputSchema.required, ["conversationId", "text"]);
  });

  /**
   * The model plans around what the description says. "Message this person"
   * is a plan that cannot work until Microsoft Teams has spoken to us first,
   * so the constraint belongs in the text rather than in a runtime error.
   */
  test("each description explains that the endpoint is learned from inbound traffic", () => {
    for (const tool of microsoftTeamsProvider.tools) {
      assert.match(tool.description, /serviceUrl/, tool.name);
      assert.match(tool.description, /learned from inbound traffic/, tool.name);
      assert.match(tool.description, /already received a message from/, tool.name);
    }
  });
});

describe("botFrameworkTokenUrl", () => {
  test("a multi-tenant bot authenticates against botframework.com, not its own tenant", () => {
    assert.equal(
      botFrameworkTokenUrl(CONFIG),
      "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    );
  });

  test("a single-tenant bot authenticates against its tenant", () => {
    assert.equal(
      botFrameworkTokenUrl({ ...CONFIG, tenantId: "contoso.onmicrosoft.com" }),
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
    );
  });

  test("a blank tenant is the same as no tenant", () => {
    assert.equal(botFrameworkTokenUrl({ ...CONFIG, tenantId: "   " }), botFrameworkTokenUrl(CONFIG));
  });

  test("a tenant with path characters cannot escape the authority segment", () => {
    const url = botFrameworkTokenUrl({ ...CONFIG, tenantId: "../../evil" });
    assert.equal(
      url,
      "https://login.microsoftonline.com/..%2F..%2Fevil/oauth2/v2.0/token",
    );
  });
});

describe("token cache", () => {
  test("keys on the credential triple, so two Connections on one bot share a token", () => {
    assert.equal(botFrameworkCacheKey(CONFIG), botFrameworkCacheKey({ ...CONFIG }));
  });

  test("rotating any part of the triple invalidates the key", () => {
    const base = botFrameworkCacheKey(CONFIG);
    assert.notEqual(base, botFrameworkCacheKey({ ...CONFIG, appPassword: "rotated" }));
    assert.notEqual(base, botFrameworkCacheKey({ ...CONFIG, appId: "other" }));
    assert.notEqual(base, botFrameworkCacheKey({ ...CONFIG, tenantId: "contoso" }));
  });

  test("the key never carries the secret itself", () => {
    assert.doesNotMatch(botFrameworkCacheKey(CONFIG), /s3cret/);
    assert.match(botFrameworkCacheKey(CONFIG), /^[a-f0-9]{64}$/);
  });

  test("a cached token is returned until the refresh skew catches up with it", () => {
    const now = 1_700_000_000_000;
    cacheBotFrameworkToken("k", "tok", 3600, now);
    assert.equal(readCachedBotFrameworkToken("k", now), "tok");
    assert.equal(readCachedBotFrameworkToken("k", now + 3600_000 - TOKEN_REFRESH_SKEW_MS - 1), "tok");
  });

  test("it is dropped a minute early, so a request in flight still has a live token", () => {
    const now = 1_700_000_000_000;
    cacheBotFrameworkToken("k", "tok", 3600, now);
    assert.equal(readCachedBotFrameworkToken("k", now + 3600_000 - TOKEN_REFRESH_SKEW_MS), null);
    // The expired entry is evicted rather than re-read on every miss.
    assert.equal(readCachedBotFrameworkToken("k", now), null);
  });

  test("a nonsense expires_in falls back to an hour instead of caching forever", () => {
    const now = 1_700_000_000_000;
    cacheBotFrameworkToken("k", "tok", Number.NaN, now);
    assert.equal(readCachedBotFrameworkToken("k", now), "tok");
    assert.equal(readCachedBotFrameworkToken("k", now + 3600_000), null);
  });

  test("clearing empties it", () => {
    cacheBotFrameworkToken("k", "tok", 3600);
    clearBotFrameworkTokenCache();
    assert.equal(readCachedBotFrameworkToken("k"), null);
  });

  test("an unknown key is a miss, not a throw", () => {
    assert.equal(readCachedBotFrameworkToken("never-seen"), null);
  });
});

describe("botFrameworkToken", () => {
  test("refuses an incomplete triple before it opens a socket", async () => {
    await assert.rejects(
      botFrameworkToken({ appId: "", appPassword: "x" }),
      /Application \(client\) ID is required/,
    );
    await assert.rejects(
      botFrameworkToken({ appId: "x", appPassword: "  " }),
      /Client secret is required/,
    );
  });

  test("a cached token satisfies the ordinary path with no network", async () => {
    cacheBotFrameworkToken(botFrameworkCacheKey(CONFIG), "cached-token", 3600);
    assert.equal(await botFrameworkToken(CONFIG), "cached-token");
  });
});

describe("normalizeServiceUrl", () => {
  test("one trailing slash, whichever way Microsoft sent it", () => {
    const expected = "https://smba.trafficmanager.net/emea/";
    assert.equal(normalizeServiceUrl("https://smba.trafficmanager.net/emea"), expected);
    assert.equal(normalizeServiceUrl("https://smba.trafficmanager.net/emea/"), expected);
    assert.equal(normalizeServiceUrl("https://smba.trafficmanager.net/emea///"), expected);
    assert.equal(normalizeServiceUrl("  https://smba.trafficmanager.net/emea  "), expected);
  });

  test("empty stays empty rather than becoming a bare slash", () => {
    assert.equal(normalizeServiceUrl(""), "");
    assert.equal(normalizeServiceUrl("   "), "");
  });
});

describe("isUsableServiceUrl", () => {
  test("https only — the bearer token must not ride a plaintext hop", () => {
    assert.equal(isUsableServiceUrl("https://smba.trafficmanager.net/emea"), true);
    assert.equal(isUsableServiceUrl("http://smba.trafficmanager.net/emea"), false);
    assert.equal(isUsableServiceUrl("ftp://example.com"), false);
    assert.equal(isUsableServiceUrl("javascript:alert(1)"), false);
    assert.equal(isUsableServiceUrl("not a url"), false);
    assert.equal(isUsableServiceUrl(""), false);
  });
});

describe("botFrameworkFetch", () => {
  test("refuses a serviceUrl it would not send a token to, before minting one", async () => {
    await assert.rejects(
      botFrameworkFetch({
        config: CONFIG,
        serviceUrl: "http://attacker.example",
        path: "v3/conversations/x/activities",
      }),
      /not a usable https serviceUrl/,
    );
  });
});

describe("error shaping", () => {
  test("an identity-platform error keeps its first line and drops the correlation block", () => {
    assert.equal(
      microsoftErrorMessage(
        {
          error: "invalid_client",
          error_description:
            "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc\r\nCorrelation ID: def",
        },
        "fallback",
      ),
      "AADSTS7000215: Invalid client secret provided.",
    );
  });

  test("it falls back to the code, then to the caller's sentence", () => {
    assert.equal(microsoftErrorMessage({ error: "unauthorized_client" }, "fallback"), "unauthorized_client");
    assert.equal(microsoftErrorMessage(null, "fallback"), "fallback");
    assert.equal(microsoftErrorMessage("not json at all", "fallback"), "fallback");
  });

  test("a Bot Framework error unwraps the nested object", () => {
    assert.equal(
      botFrameworkErrorMessage({ error: { code: "BotNotInConversationRoster", message: "The bot is not part of the conversation roster." } }, "fallback"),
      "The bot is not part of the conversation roster.",
    );
    assert.equal(botFrameworkErrorMessage({ error: { code: "ServiceError" } }, "fallback"), "ServiceError");
    assert.equal(botFrameworkErrorMessage("<html>502</html>", "fallback"), "<html>502</html>");
    assert.equal(botFrameworkErrorMessage({}, "fallback"), "fallback");
  });
});

describe("summarizeMembers", () => {
  test("keeps the three fields worth reading and drops idless rows", () => {
    assert.deepEqual(
      summarizeMembers([
        { id: "29:abc", name: "Ada Lovelace", aadObjectId: "aad-1", email: "ada@example.com", extra: 1 },
        { id: "29:def", givenName: "Guest" },
        { name: "no id" },
        null,
        "nonsense",
      ]),
      [
        { id: "29:abc", name: "Ada Lovelace", aadObjectId: "aad-1", email: "ada@example.com" },
        { id: "29:def", name: null, aadObjectId: null, email: null },
      ],
    );
  });

  test("a non-array payload is an empty roster, not a throw", () => {
    assert.deepEqual(summarizeMembers({ members: [] }), []);
    assert.deepEqual(summarizeMembers(null), []);
  });
});

describe("validateApiKey", () => {
  test("rejects a missing app id or secret before any network call", async () => {
    await assert.rejects(
      microsoftTeamsProvider.validateApiKey!({}),
      /Application \(client\) ID is required/,
    );
    await assert.rejects(
      microsoftTeamsProvider.validateApiKey!({ appId: CONFIG.appId }),
      /Client secret is required/,
    );
  });
});

describe("invokeTool", () => {
  test("an unknown tool name is named, not silently ignored", async () => {
    await assert.rejects(
      microsoftTeamsProvider.invokeTool("delete_everything", {}, ctx({ connectionId: "conn-1" })),
      /Unknown Microsoft Teams tool: delete_everything/,
    );
  });

  test("arguments are validated before the endpoint is looked up", async () => {
    await assert.rejects(
      microsoftTeamsProvider.invokeTool("send_message", { text: "hi" }, ctx({ connectionId: "conn-1" })),
      /conversationId is required/,
    );
    await assert.rejects(
      microsoftTeamsProvider.invokeTool(
        "send_message",
        { conversationId: "19:x@thread.tacv2", text: "   " },
        ctx({ connectionId: "conn-1" }),
      ),
      /text is required/,
    );
  });

  /**
   * The failure an employee will actually hit. It has to read as a fact about
   * Microsoft Teams rather than as an internal error, because the fix is
   * "ask the human to send a message", not "retry".
   */
  test("a conversation Microsoft Teams has never contacted us about explains itself", async () => {
    await assert.rejects(
      microsoftTeamsProvider.invokeTool(
        "send_message",
        { conversationId: "19:x@thread.tacv2", text: "hi" },
        ctx({ connectionId: "conn-never-seen" }),
      ),
      /has not contacted this Genosyn instance yet/,
    );
  });

  test("a context with no Connection cannot reach anything", async () => {
    await assert.rejects(
      microsoftTeamsProvider.invokeTool(
        "list_conversation_members",
        { conversationId: "19:x@thread.tacv2" },
        ctx(),
      ),
      /need a Connection/,
    );
  });
});
