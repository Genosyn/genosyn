import assert from "node:assert/strict";
import { test } from "node:test";
import { UpstreamError } from "../src/errors.js";
import {
  createGoogleProvider,
  GOOGLE_SCOPE_GROUPS,
  hasGmailMailboxScope,
} from "../src/providers/google.js";
import { offeredScopes } from "../src/providers/types.js";
import { upstreamJson } from "../src/upstream.js";
import { fakeGoogle } from "./helpers.js";

const registration = { clientId: "client-id", clientSecret: "client-secret" };

function provider(groups = ["gmail"]) {
  const google = fakeGoogle();
  return { google, adapter: createGoogleProvider({ registration, groups, fetch: google.fetch }) };
}

test("the catalog matches the scopes Genosyn's Integrations request, one group per product", () => {
  const keys = GOOGLE_SCOPE_GROUPS.map((group) => group.key);
  assert.deepEqual(keys, [
    "gmail",
    "calendar",
    "drive",
    "docs",
    "tasks",
    "contacts",
    "directory",
    "chat",
    "meet",
    "analytics",
    "search-console",
    "ads",
  ]);
  const scopes = GOOGLE_SCOPE_GROUPS.flatMap((group) => group.scopes);
  assert.equal(new Set(scopes).size, scopes.length, "no scope belongs to two groups");
  for (const scope of scopes)
    assert.match(scope, /^https:\/\/www\.googleapis\.com\/auth\/[a-z.]+$/);
  // These must stay identical to the App's catalog (GOOGLE_SCOPE_GROUPS and the
  // Analytics, Search Console and Ads providers), which asks for scopes by URL.
  assert.deepEqual(GOOGLE_SCOPE_GROUPS[0].scopes, [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
  ]);
  assert.deepEqual(
    GOOGLE_SCOPE_GROUPS.slice(-3).map((group) => group.scopes),
    [
      ["https://www.googleapis.com/auth/analytics.readonly"],
      ["https://www.googleapis.com/auth/webmasters.readonly"],
      ["https://www.googleapis.com/auth/adwords"],
    ],
  );
});

test("only the configured groups are offered", () => {
  assert.deepEqual(offeredScopes(provider(["calendar", "gmail"]).adapter), [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/calendar",
  ]);
  assert.deepEqual(offeredScopes(provider([]).adapter), []);
});

test("Gmail mailbox access means modify or full mail scope, never settings or read-only", () => {
  assert.equal(hasGmailMailboxScope(["https://www.googleapis.com/auth/gmail.modify"]), true);
  assert.equal(hasGmailMailboxScope(["https://mail.google.com/"]), true);
  assert.equal(
    hasGmailMailboxScope(["https://www.googleapis.com/auth/gmail.settings.basic"]),
    false,
  );
  assert.equal(hasGmailMailboxScope(["https://www.googleapis.com/auth/gmail.readonly"]), false);
  assert.equal(hasGmailMailboxScope([]), false);
});

test("the authorization URL asks for offline access with PKCE and exactly the requested scopes", () => {
  const url = new URL(
    provider().adapter.authorizeUrl({
      clientId: "client-id",
      redirectUri: "https://connect.example.com/api/connect/google/callback",
      scopes: ["openid", "https://www.googleapis.com/auth/calendar"],
      codeChallenge: "challenge",
      state: "state",
    }),
  );
  assert.equal(`${url.origin}${url.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: "client-id",
    redirect_uri: "https://connect.example.com/api/connect/google/callback",
    response_type: "code",
    scope: "openid https://www.googleapis.com/auth/calendar",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    state: "state",
  });
});

test("an exchange sends the secret and verifier, then confirms a verified address", async () => {
  const { google, adapter } = provider();
  const credential = await adapter.exchange({
    ...registration,
    code: "code",
    codeVerifier: "verifier",
    redirectUri: "https://connect.example.com/cb",
  });
  assert.deepEqual(Object.fromEntries(google.calls[0].body), {
    client_id: "client-id",
    client_secret: "client-secret",
    code: "code",
    code_verifier: "verifier",
    redirect_uri: "https://connect.example.com/cb",
    grant_type: "authorization_code",
  });
  assert.equal(google.calls[1].url, "https://openidconnect.googleapis.com/v1/userinfo");
  assert.equal(google.calls[1].headers.get("authorization"), "Bearer google-access-token");
  assert.equal(credential.email, "member@gmail.com");
  assert.equal(credential.account, "member@gmail.com");
  assert.equal(credential.refreshToken, "google-refresh-token");
  assert.ok(credential.expiresAt! > Date.now() + 3_500_000);
  assert.equal(JSON.stringify(credential).includes("client-secret"), false);
});

test("malformed or incomplete token responses never become a credential", async () => {
  const exchange = (adapter: ReturnType<typeof provider>["adapter"]) =>
    adapter.exchange({ ...registration, code: "c", codeVerifier: "v", redirectUri: "r" });
  for (const tokenBody of [
    { access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "mac" },
    { access_token: "a", refresh_token: "r", expires_in: 999_999, token_type: "Bearer" },
    { access_token: "", refresh_token: "r", expires_in: 3600, token_type: "Bearer" },
    { refresh_token: "r", expires_in: 3600, token_type: "Bearer" },
  ]) {
    const { google, adapter } = provider();
    google.state.tokenBody = tokenBody;
    await assert.rejects(exchange(adapter), UpstreamError, JSON.stringify(tokenBody));
  }
  const missingRefresh = provider();
  missingRefresh.google.state.tokenBody = {
    access_token: "a",
    expires_in: 3600,
    token_type: "bearer",
  };
  await assert.rejects(exchange(missingRefresh.adapter), /offline access/);
  for (const profile of [
    { email: "member@gmail.com", email_verified: false },
    { email: "member@gmail.com" },
    { email: "not-an-address", email_verified: true },
  ]) {
    const { google, adapter } = provider();
    google.state.profile = profile;
    await assert.rejects(exchange(adapter), /verified email/);
  }
  const profileDown = provider();
  profileDown.google.state.profileStatus = 500;
  await assert.rejects(exchange(profileDown.adapter), /verified email/);
});

test("renewal reports revocation distinctly and hides every other upstream failure", async () => {
  const { google, adapter } = provider();
  const renewed = await adapter.refresh({ ...registration, refreshToken: "refresh" });
  assert.equal(renewed.accessToken, "refreshed-access");
  assert.equal(renewed.refreshToken, undefined);
  assert.equal(Object.fromEntries(google.calls[0].body).grant_type, "refresh_token");

  google.state.refreshStatus = 400;
  google.state.refreshBody = { error: "invalid_grant", error_description: "Bad Request" };
  await assert.rejects(adapter.refresh({ ...registration, refreshToken: "revoked" }), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 401);
    assert.equal(error.message, "Google access expired or was revoked. Connect again.");
    return true;
  });
  google.state.refreshBody = {
    error: "invalid_client",
    error_description: "The OAuth client was deleted.",
  };
  await assert.rejects(adapter.refresh({ ...registration, refreshToken: "x" }), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 502);
    assert.doesNotMatch(error.message, /deleted|invalid_client/);
    return true;
  });
});

test("upstream calls refuse redirects, cap the body, time out, and hide network errors", async () => {
  const seen: RequestInit[] = [];
  const ok = await upstreamJson(
    async (_url, init) => {
      seen.push(init!);
      return Response.json({ fine: true });
    },
    "https://oauth2.googleapis.com/token",
    { method: "POST" },
  );
  assert.deepEqual(ok, { ok: true, status: 200, body: { fine: true } });
  assert.equal(seen[0].redirect, "error");
  assert.ok(seen[0].signal instanceof AbortSignal);

  const huge = "x".repeat(70 * 1024);
  await assert.rejects(
    upstreamJson(async () => new Response(JSON.stringify({ huge })), "https://x", {}),
    UpstreamError,
  );
  await assert.rejects(
    upstreamJson(async () => new Response("<html>not json"), "https://x", {}),
    UpstreamError,
  );
  await assert.rejects(
    upstreamJson(
      async () => {
        throw new Error("connect ECONNREFUSED with secret detail");
      },
      "https://x",
      {},
    ),
    (error) => error instanceof UpstreamError && !/secret detail/.test(error.message),
  );
  const started = Date.now();
  await assert.rejects(
    upstreamJson(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
        }),
      "https://x",
      {},
      50,
    ),
    UpstreamError,
  );
  assert.ok(Date.now() - started < 5_000);
});
