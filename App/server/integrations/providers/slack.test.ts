import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { slackErrorSentence, slackFetch, slackProvider } from "./slack.js";
import { ConnectionAuthError, type IntegrationRuntimeContext } from "../types.js";

/**
 * Slack's Web API answers `200 {ok:false,error:"…"}` for nearly everything
 * that goes wrong, so the interesting behaviour of this provider is entirely
 * in how it reads that envelope: which codes kill the Connection, which are
 * one bad call, and whether the operator gets a sentence or a machine string.
 *
 * `fetch` is stubbed rather than reached. Every case below is a payload Slack
 * really sends, and none of them needs a workspace to reproduce.
 */

type StubCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

const realFetch = globalThis.fetch;
let calls: StubCall[] = [];
let responder: (call: StubCall) => { status?: number; statusText?: string; body: string };

function slackMethodOf(call: StubCall): string {
  return call.url.split("/").pop() ?? "";
}

/** Answer each Slack method with a canned envelope. */
function replyWith(byMethod: Record<string, unknown>): void {
  responder = (call) => {
    const payload = byMethod[slackMethodOf(call)];
    return {
      body: JSON.stringify(payload ?? { ok: false, error: "unknown_method" }),
    };
  };
}

function lastCall(): StubCall {
  assert.ok(calls.length > 0, "expected a Slack call");
  return calls[calls.length - 1];
}

function ctxWith(config: Record<string, unknown>): IntegrationRuntimeContext {
  return { authMode: "apikey", config };
}

const AUTH_OK = {
  ok: true,
  url: "https://acme.slack.com/",
  team: "Acme",
  user: "genosyn",
  team_id: "T0ACME",
  user_id: "U0BOT",
  bot_id: "B0BOT",
};

beforeEach(() => {
  calls = [];
  responder = () => ({ body: JSON.stringify({ ok: true }) });
  globalThis.fetch = (async (input: unknown, init?: Record<string, unknown>) => {
    const call: StubCall = {
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const answer = responder(call);
    return new Response(answer.body, {
      status: answer.status ?? 200,
      statusText: answer.statusText ?? "OK",
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("slackFetch", () => {
  test("posts JSON to the named method under a bearer token", async () => {
    replyWith({ "chat.postMessage": { ok: true, ts: "1.1" } });
    await slackFetch("chat.postMessage", "xoxb-token", { channel: "C1", text: "hi" });
    const call = lastCall();
    assert.equal(call.url, "https://slack.com/api/chat.postMessage");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.Authorization, "Bearer xoxb-token");
    assert.equal(call.headers["Content-Type"], "application/json; charset=utf-8");
    assert.deepEqual(call.body, { channel: "C1", text: "hi" });
  });

  test("sends an empty object when the method takes no arguments", async () => {
    replyWith({ "auth.test": AUTH_OK });
    await slackFetch("auth.test", "xoxb-token");
    assert.deepEqual(lastCall().body, {});
  });

  test("returns the whole envelope, because Slack puts results at the top level", async () => {
    replyWith({ "auth.test": AUTH_OK });
    const result = await slackFetch<typeof AUTH_OK>("auth.test", "xoxb-token");
    assert.equal(result.team, "Acme");
    assert.equal(result.user_id, "U0BOT");
  });

  for (const code of ["invalid_auth", "token_revoked", "account_inactive"]) {
    test(`${code} kills the Connection rather than the call`, async () => {
      replyWith({ "auth.test": { ok: false, error: code } });
      const err = await slackFetch("auth.test", "xoxb-token").catch((e: unknown) => e);
      assert.ok(err instanceof ConnectionAuthError, `${code} must be a ConnectionAuthError`);
      assert.equal(err.connectionStatus, "error");
      assert.match(err.message, new RegExp(code));
    });
  }

  test("token_expired marks the Connection expired, not broken", async () => {
    replyWith({ "auth.test": { ok: false, error: "token_expired" } });
    const err = await slackFetch("auth.test", "xoxb-token").catch((e: unknown) => e);
    assert.ok(err instanceof ConnectionAuthError);
    assert.equal(err.connectionStatus, "expired");
  });

  test("an ordinary refusal stays an ordinary Error", async () => {
    replyWith({ "chat.postMessage": { ok: false, error: "not_in_channel" } });
    const err = await slackFetch("chat.postMessage", "xoxb-token", {}).catch((e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof ConnectionAuthError), "a missing invite must not red-flag the row");
    assert.match(err.message, /not_in_channel/);
    assert.match(err.message, /invite/i);
  });

  test("an unrecognised code still reaches the operator verbatim", async () => {
    replyWith({ "chat.postMessage": { ok: false, error: "some_future_slack_code" } });
    const err = await slackFetch("chat.postMessage", "xoxb-token", {}).catch((e: unknown) => e);
    assert.match((err as Error).message, /some_future_slack_code/);
  });

  test("ok:false with no error field is reported rather than swallowed", async () => {
    replyWith({ "chat.postMessage": { ok: false } });
    const err = await slackFetch("chat.postMessage", "xoxb-token", {}).catch((e: unknown) => e);
    assert.match((err as Error).message, /unknown_error/);
  });

  test("an HTML rate-limit page names the HTTP status instead of crashing", async () => {
    responder = () => ({ status: 429, statusText: "Too Many Requests", body: "<html>nope</html>" });
    const err = await slackFetch("chat.postMessage", "xoxb-token", {}).catch((e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /429/);
    assert.match(err.message, /Too Many Requests/);
  });

  test("an empty body is a failure, not a silent success", async () => {
    responder = () => ({ status: 502, statusText: "Bad Gateway", body: "" });
    const err = await slackFetch("chat.postMessage", "xoxb-token", {}).catch((e: unknown) => e);
    assert.match((err as Error).message, /502/);
  });
});

describe("slackErrorSentence", () => {
  test("a known code gets both the code and a sentence about it", () => {
    const sentence = slackErrorSentence("auth.test", "missing_scope");
    assert.match(sentence, /missing_scope/);
    assert.match(sentence, /OAuth & Permissions/);
  });

  test("an unknown code still carries the code, which is the searchable part", () => {
    assert.equal(
      slackErrorSentence("conversations.list", "nonsense"),
      "Slack conversations.list failed (nonsense).",
    );
  });
});

describe("catalog", () => {
  test("is an API-key Communication connector that is switched on", () => {
    assert.equal(slackProvider.catalog.provider, "slack");
    assert.equal(slackProvider.catalog.name, "Slack");
    assert.equal(slackProvider.catalog.category, "Communication");
    assert.equal(slackProvider.catalog.authMode, "apikey");
    assert.equal(slackProvider.catalog.enabled, true);
    assert.match(slackProvider.catalog.icon, /^[A-Z][A-Za-z0-9]*$/);
  });

  test("asks for exactly one required secret and two optional ones", () => {
    const fields = slackProvider.catalog.fields ?? [];
    assert.deepEqual(
      fields.map((f) => [f.key, f.type, f.required]),
      [
        ["botToken", "password", true],
        ["appToken", "password", false],
        ["signingSecret", "password", false],
      ],
    );
  });

  test("each hint says where in Slack the secret comes from", () => {
    const byKey = new Map((slackProvider.catalog.fields ?? []).map((f) => [f.key, f.hint ?? ""]));
    assert.match(byKey.get("botToken")!, /xoxb-/);
    assert.match(byKey.get("botToken")!, /OAuth & Permissions/);
    assert.match(byKey.get("appToken")!, /xapp-/);
    assert.match(byKey.get("appToken")!, /connections:write/);
    assert.match(byKey.get("appToken")!, /Socket Mode/);
    assert.match(byKey.get("signingSecret")!, /Events API/);
  });

  /** "AI Employee" is the product noun; the roster is never a bot. */
  test("the copy calls the responder an AI Employee", () => {
    const copy = `${slackProvider.catalog.tagline} ${slackProvider.catalog.description ?? ""}`;
    assert.match(copy, /AI Employee/);
    assert.doesNotMatch(copy, /\bassistant\b/i);
    assert.doesNotMatch(copy, /\bchatbot\b/i);
    assert.doesNotMatch(copy, /\bagent\b/i);
  });
});

describe("tools", () => {
  const byName = new Map(slackProvider.tools.map((t) => [t.name, t]));

  test("exposes the four a conversation actually needs", () => {
    assert.deepEqual(
      slackProvider.tools.map((t) => t.name).sort(),
      ["add_reaction", "list_channels", "send_message", "update_message"],
    );
  });

  test("send_message requires a channel and text and offers a thread", () => {
    const tool = byName.get("send_message")!;
    assert.deepEqual(tool.inputSchema.required, ["channel", "text"]);
    assert.ok(tool.inputSchema.properties.thread_ts);
    assert.equal(tool.inputSchema.additionalProperties, false);
  });

  test("send_message warns the model that Slack is not markdown", () => {
    assert.match(byName.get("send_message")!.description, /mrkdwn/);
  });

  test("update_message and add_reaction both key off channel + ts", () => {
    assert.deepEqual(byName.get("update_message")!.inputSchema.required, ["channel", "ts", "text"]);
    assert.deepEqual(byName.get("add_reaction")!.inputSchema.required, ["channel", "ts", "name"]);
  });

  test("list_channels needs no arguments at all", () => {
    assert.equal(byName.get("list_channels")!.inputSchema.required, undefined);
  });

  test("every description is a sentence a model can plan against", () => {
    for (const tool of slackProvider.tools) {
      assert.ok(tool.description.length > 60, `${tool.name} description is too thin`);
      assert.match(tool.description, /\.$/, `${tool.name} description should read as prose`);
    }
  });
});

describe("validateApiKey", () => {
  test("refuses an empty bot token before touching the network", async () => {
    await assert.rejects(() => slackProvider.validateApiKey!({ botToken: "  " }), /required/i);
    assert.equal(calls.length, 0);
  });

  test("catches an app-level token pasted into the bot-token box", async () => {
    await assert.rejects(
      () => slackProvider.validateApiKey!({ botToken: "xapp-1-A-1-abc" }),
      /app-level token/i,
    );
    assert.equal(calls.length, 0);
  });

  test("catches a bot token pasted into the app-token box", async () => {
    await assert.rejects(
      () => slackProvider.validateApiKey!({ botToken: "xoxb-1", appToken: "xoxb-2" }),
      /starts with `xapp-`/,
    );
    assert.equal(calls.length, 0);
  });

  test("captures the bot user id the inbound path cannot work without", async () => {
    replyWith({ "auth.test": AUTH_OK });
    const result = await slackProvider.validateApiKey!({ botToken: "xoxb-real-token" });
    assert.equal(lastCall().url, "https://slack.com/api/auth.test");
    assert.equal(lastCall().headers.Authorization, "Bearer xoxb-real-token");
    assert.equal(result.config.botUserId, "U0BOT");
    assert.equal(result.config.botId, "B0BOT");
    assert.equal(result.config.teamId, "T0ACME");
    assert.equal(result.config.teamName, "Acme");
    assert.equal(result.config.teamUrl, "https://acme.slack.com/");
  });

  test("stores the optional secrets only when they were given", async () => {
    replyWith({ "auth.test": AUTH_OK });
    const bare = await slackProvider.validateApiKey!({ botToken: "xoxb-real-token" });
    assert.ok(!("appToken" in bare.config));
    assert.ok(!("signingSecret" in bare.config));

    const full = await slackProvider.validateApiKey!({
      botToken: "  xoxb-real-token  ",
      appToken: "  xapp-1-A-1-abc  ",
      signingSecret: "  s3cr3t  ",
    });
    assert.equal(full.config.botToken, "xoxb-real-token");
    assert.equal(full.config.appToken, "xapp-1-A-1-abc");
    assert.equal(full.config.signingSecret, "s3cr3t");
  });

  test("the account hint names the workspace and never the whole token", async () => {
    replyWith({ "auth.test": AUTH_OK });
    const result = await slackProvider.validateApiKey!({ botToken: "xoxb-super-secret-1234" });
    assert.match(result.accountHint, /Acme/);
    assert.match(result.accountHint, /@genosyn/);
    assert.ok(!result.accountHint.includes("xoxb-super-secret-1234"));
    assert.match(result.accountHint, /1234$/);
  });

  test("a user token that names no bot user is refused with a reason", async () => {
    replyWith({ "auth.test": { ok: true, team: "Acme", user: "sam" } });
    await assert.rejects(
      () => slackProvider.validateApiKey!({ botToken: "xoxp-user-token" }),
      /bot token/i,
    );
  });

  test("Slack's own rejection reaches the connect form", async () => {
    replyWith({ "auth.test": { ok: false, error: "invalid_auth" } });
    const err = await slackProvider
      .validateApiKey!({ botToken: "xoxb-wrong" })
      .catch((e: unknown) => e);
    assert.ok(err instanceof ConnectionAuthError);
    assert.match(err.message, /invalid_auth/);
  });
});

describe("checkStatus", () => {
  test("green when auth.test answers", async () => {
    replyWith({ "auth.test": AUTH_OK });
    assert.deepEqual(await slackProvider.checkStatus!(ctxWith({ botToken: "xoxb-t" })), {
      ok: true,
    });
  });

  test("a revoked token reports error, not merely not-ok", async () => {
    replyWith({ "auth.test": { ok: false, error: "token_revoked" } });
    const result = await slackProvider.checkStatus!(ctxWith({ botToken: "xoxb-t" }));
    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    assert.match(result.message!, /token_revoked/);
  });

  test("a rotated-out token reports expired so the UI asks for a reconnect", async () => {
    replyWith({ "auth.test": { ok: false, error: "token_expired" } });
    const result = await slackProvider.checkStatus!(ctxWith({ botToken: "xoxb-t" }));
    assert.equal(result.status, "expired");
  });

  test("a transport failure is reported without claiming the credential is dead", async () => {
    responder = () => ({ status: 500, statusText: "Server Error", body: "" });
    const result = await slackProvider.checkStatus!(ctxWith({ botToken: "xoxb-t" }));
    assert.equal(result.ok, false);
    assert.equal(result.status, undefined);
    assert.match(result.message!, /500/);
  });
});

describe("invokeTool", () => {
  const ctx = ctxWith({ botToken: "xoxb-t" });

  test("send_message posts to the channel", async () => {
    replyWith({ "chat.postMessage": { ok: true, ts: "9.9" } });
    await slackProvider.invokeTool("send_message", { channel: "C1", text: "shipped" }, ctx);
    assert.equal(lastCall().url, "https://slack.com/api/chat.postMessage");
    assert.deepEqual(lastCall().body, { channel: "C1", text: "shipped" });
  });

  test("send_message threads only when a thread was named", async () => {
    replyWith({ "chat.postMessage": { ok: true } });
    await slackProvider.invokeTool(
      "send_message",
      { channel: "C1", text: "shipped", thread_ts: " 1.1 " },
      ctx,
    );
    assert.equal(lastCall().body!.thread_ts, "1.1");
    await slackProvider.invokeTool(
      "send_message",
      { channel: "C1", text: "shipped", thread_ts: "   " },
      ctx,
    );
    assert.ok(!("thread_ts" in lastCall().body!));
  });

  test("send_message refuses to post nothing", async () => {
    await assert.rejects(
      () => slackProvider.invokeTool("send_message", { channel: "C1", text: "  " }, ctx),
      /text is required/,
    );
    assert.equal(calls.length, 0);
  });

  test("update_message edits in place", async () => {
    replyWith({ "chat.update": { ok: true } });
    await slackProvider.invokeTool(
      "update_message",
      { channel: "C1", ts: "9.9", text: "corrected" },
      ctx,
    );
    assert.equal(lastCall().url, "https://slack.com/api/chat.update");
    assert.deepEqual(lastCall().body, { channel: "C1", ts: "9.9", text: "corrected" });
  });

  test("add_reaction speaks Slack's field names and strips the colons models add", async () => {
    replyWith({ "reactions.add": { ok: true } });
    await slackProvider.invokeTool("add_reaction", { channel: "C1", ts: "9.9", name: ":eyes:" }, ctx);
    assert.equal(lastCall().url, "https://slack.com/api/reactions.add");
    assert.deepEqual(lastCall().body, { channel: "C1", timestamp: "9.9", name: "eyes" });
  });

  test("list_channels has usable defaults", async () => {
    replyWith({ "conversations.list": { ok: true, channels: [] } });
    await slackProvider.invokeTool("list_channels", {}, ctx);
    assert.deepEqual(lastCall().body, {
      types: "public_channel",
      limit: 100,
      exclude_archived: true,
    });
  });

  test("list_channels clamps a limit a model made up", async () => {
    replyWith({ "conversations.list": { ok: true } });
    await slackProvider.invokeTool("list_channels", { limit: 100_000 }, ctx);
    assert.equal(lastCall().body!.limit, 200);
    await slackProvider.invokeTool("list_channels", { limit: 0 }, ctx);
    assert.equal(lastCall().body!.limit, 1);
    await slackProvider.invokeTool("list_channels", { limit: "many" }, ctx);
    assert.equal(lastCall().body!.limit, 100);
  });

  test("an unknown tool name is refused by name", async () => {
    await assert.rejects(
      () => slackProvider.invokeTool("delete_workspace", {}, ctx),
      /Unknown Slack tool: delete_workspace/,
    );
  });
});
