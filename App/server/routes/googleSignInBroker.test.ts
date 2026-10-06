import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { errorHandler } from "../middleware/error.js";
import { securityHeaders } from "../middleware/httpSecurity.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { googleSignInCookieName } from "../services/googleSignInBroker.js";
import { saveOauthApp } from "../services/oauthApps.js";
import { getPublicUrl, setPublicUrl } from "../services/publicUrl.js";
import {
  overrideRuntimeSettingsForTests,
  resetRuntimeSettingsCacheForTests,
} from "../services/runtimeSettings.js";
import { googleSignInBrokerRouter } from "./googleSignInBroker.js";

const BROWSER_PROOF = "b".repeat(43);
const BROWSER_CHALLENGE = crypto.createHash("sha256").update(BROWSER_PROOF).digest("base64url");
const BROKER_ORIGIN = "https://connect.genosyn.test";
const SCOPE =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic";
const realFetch = globalThis.fetch;
let server: Server;
let baseUrl: string;
let googleCalls: Array<{ url: string; body: string; init: RequestInit }>;
let tokenResponse: Record<string, unknown>;
let tokenStatus: number;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(securityHeaders);
  // Mirrors the App's existing parser before the broker-specific smaller cap.
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/google-sign-in", googleSignInBrokerRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/google-sign-in`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  resetRuntimeSettingsCacheForTests();
  await setPublicUrl(BROKER_ORIGIN);
  await saveOauthApp("google", { clientId: "broker-client", clientSecret: "broker-secret" });
  overrideRuntimeSettingsForTests({ oauth: { hostSignIn: true } });
  googleCalls = [];
  tokenStatus = 200;
  tokenResponse = {
    access_token: "private-access-token",
    refresh_token: "private-refresh-token",
    expires_in: 3600,
    scope: SCOPE,
    token_type: "Bearer",
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      googleCalls.push({ url, body: String(init.body), init });
      return Response.json(tokenResponse, { status: tokenStatus });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      googleCalls.push({ url, body: String(init.body ?? ""), init });
      return Response.json({ email: "member@gmail.com", email_verified: true });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return realFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function start() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const response = await post("/start", {
    codeChallenge: challenge,
    browserChallenge: BROWSER_CHALLENGE,
    installationOrigin: "http://nas.local:3000",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    requestId: string;
    authorizeUrl: string;
    expiresAt: number;
  };
  return { ...body, verifier, challenge };
}

async function prepare(requestId: string) {
  const response = await realFetch(`${baseUrl}/authorize?requestId=${requestId}`);
  assert.equal(response.status, 200);
  const page = await response.text();
  const nonce = /name="csrfToken" value="([A-Za-z0-9_-]+)"/.exec(page)?.[1];
  assert.ok(nonce);
  const cookie = `${googleSignInCookieName(requestId)}=${nonce}`;
  return { page, nonce, cookie, response };
}

async function consent(requestId: string) {
  const prepared = await prepare(requestId);
  const response = await realFetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BROKER_ORIGIN,
      cookie: prepared.cookie,
    },
    body: new URLSearchParams({
      requestId,
      csrfToken: prepared.nonce,
      browserProof: BROWSER_PROOF,
    }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const url = new URL(response.headers.get("location")!);
  const state = url.searchParams.get("state")!;
  const cookie = `${googleSignInCookieName(state)}=${prepared.nonce}`;
  return { url, state, cookie, prepared };
}

async function callback(state: string, cookie: string, query = "code=google-code") {
  return realFetch(`${baseUrl}/callback?state=${state}&${query}`, { headers: { cookie } });
}

test("host mode is opt-in and requires actual credentials plus a secure configured origin", async () => {
  overrideRuntimeSettingsForTests({ oauth: { hostSignIn: false } });
  assert.deepEqual(await (await realFetch(`${baseUrl}/status`)).json(), {
    version: 1,
    available: false,
  });
  const denied = await post("/start", {
    codeChallenge: "a".repeat(43),
    browserChallenge: BROWSER_CHALLENGE,
    installationOrigin: "http://localhost:3000",
  });
  assert.equal(denied.status, 503);
  overrideRuntimeSettingsForTests({ oauth: { hostSignIn: true } });
  await setPublicUrl("http://broker.example.com");
  assert.equal(
    ((await (await realFetch(`${baseUrl}/status`)).json()) as { available: boolean }).available,
    false,
  );
  await setPublicUrl("http://127.0.0.1:3000");
  assert.equal(
    ((await (await realFetch(`${baseUrl}/status`)).json()) as { available: boolean }).available,
    true,
  );
  await AppDataSource.getRepository(
    (await import("../db/entities/AppSetting.js")).AppSetting,
  ).delete({ key: "oauth.apps" });
  assert.equal(
    ((await (await realFetch(`${baseUrl}/status`)).json()) as { available: boolean }).available,
    false,
  );
});

test("consent displays the exact installation, sets private cookies, and requests only the fixed Gmail scopes", async () => {
  const flow = await start();
  assert.equal(new URL(flow.authorizeUrl).origin, BROKER_ORIGIN);
  assert.ok(flow.expiresAt <= Date.now() + 600_000);
  const prepared = await prepare(flow.requestId);
  assert.match(prepared.page, /http:\/\/nas.local:3000/);
  assert.match(prepared.page, /Continue with Google/);
  assert.equal(prepared.response.headers.get("cache-control"), "no-store");
  assert.equal(prepared.response.headers.get("referrer-policy"), "same-origin");
  assert.match(prepared.response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(prepared.response.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(prepared.response.headers.get("set-cookie")!, /SameSite=Lax/);
  assert.match(prepared.response.headers.get("set-cookie")!, /Secure/);
  assert.match(prepared.page, /id="continue" type="submit" disabled/);
  assert.match(prepared.page, /event.source!==window.opener\|\|event.origin!==origin/);
  assert.match(prepared.response.headers.get("content-security-policy")!, /script-src 'nonce-/);
  assert.equal(prepared.response.headers.get("cross-origin-opener-policy"), "unsafe-none");
  const authorization = await consent(flow.requestId);
  assert.equal(authorization.url.origin, "https://accounts.google.com");
  assert.equal(
    authorization.url.searchParams.get("redirect_uri"),
    `${BROKER_ORIGIN}/api/google-sign-in/callback`,
  );
  assert.deepEqual(
    new Set(authorization.url.searchParams.get("scope")!.split(" ")),
    new Set(SCOPE.split(" ")),
  );
  assert.equal(authorization.url.searchParams.get("include_granted_scopes"), "false");
  assert.equal(authorization.url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.url.toString().includes("broker-secret"), false);
});

test("a separate broker host completes consent and refresh without changing the App origin", async () => {
  const appOrigin = "https://app.genosyn.test";
  await setPublicUrl(appOrigin);
  overrideRuntimeSettingsForTests({
    oauth: {
      hostSignIn: true,
      signInHostUrl: BROKER_ORIGIN,
      // Choosing a service as a consumer must not change this broker's identity.
      hostedSignInUrl: "https://another-service.example.com",
    },
  });
  const flow = await start();
  assert.equal(new URL(flow.authorizeUrl).origin, BROKER_ORIGIN);
  const prepared = await prepare(flow.requestId);
  assert.match(prepared.response.headers.get("set-cookie")!, /Secure/);
  assert.doesNotMatch(prepared.response.headers.get("set-cookie")!, /Domain=/i);
  for (const origin of [appOrigin, "https://attacker.test"]) {
    const rejected = await realFetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        host: new URL(origin).host,
        "sec-fetch-site": "same-site",
        cookie: prepared.cookie,
      },
      body: new URLSearchParams({
        requestId: flow.requestId,
        csrfToken: prepared.nonce,
        browserProof: BROWSER_PROOF,
      }),
    });
    assert.equal(rejected.status, 403);
  }
  assert.equal(googleCalls.length, 0);
  const authorization = await consent(flow.requestId);
  assert.equal(
    authorization.url.searchParams.get("redirect_uri"),
    `${BROKER_ORIGIN}/api/google-sign-in/callback`,
  );
  const completed = await callback(authorization.state, authorization.cookie);
  assert.equal(completed.status, 200);
  assert.equal(completed.headers.get("referrer-policy"), "no-referrer");
  assert.match(await completed.text(), /sign-in is complete/);
  const exchanged = new URLSearchParams(
    googleCalls.find((call) => call.url.endsWith("/token"))!.body,
  );
  assert.equal(exchanged.get("redirect_uri"), `${BROKER_ORIGIN}/api/google-sign-in/callback`);
  const result = (await (
    await post("/poll", { requestId: flow.requestId, codeVerifier: flow.verifier })
  ).json()) as { status: string; credential: { clientId: string; refreshToken: string } };
  assert.equal(result.status, "complete");
  tokenResponse.access_token = "renewed-access-token";
  const refreshed = await post("/refresh", {
    clientId: result.credential.clientId,
    refreshToken: result.credential.refreshToken,
  });
  assert.equal(refreshed.status, 200);
  assert.equal(
    ((await refreshed.json()) as { accessToken: string }).accessToken,
    "renewed-access-token",
  );
  const renewal = new URLSearchParams(googleCalls.at(-1)!.body);
  assert.equal(renewal.get("grant_type"), "refresh_token");
  assert.equal(renewal.get("client_id"), "broker-client");
  assert.equal(getPublicUrl(), appOrigin);
  assert.equal(await AppDataSource.getRepository(AuthFlowState).count(), 0);
});

test("flow cookies follow the broker protocol independently of the App public URL", async () => {
  for (const { appOrigin, brokerOrigin, secure } of [
    { appOrigin: "http://localhost:8471", brokerOrigin: BROKER_ORIGIN, secure: true },
    { appOrigin: "https://app.genosyn.test", brokerOrigin: "http://127.0.0.1:3000", secure: false },
  ]) {
    await setPublicUrl(appOrigin);
    overrideRuntimeSettingsForTests({
      oauth: { hostSignIn: true, signInHostUrl: brokerOrigin },
    });
    const flow = await start();
    assert.equal(new URL(flow.authorizeUrl).origin, brokerOrigin);
    const prepared = await prepare(flow.requestId);
    const cookie = prepared.response.headers.get("set-cookie")!;
    assert.equal(/; Secure(?:;|$)/.test(cookie), secure);
    assert.doesNotMatch(cookie, /Domain=/i);
  }
});

test("interstitial POST rejects cross-origin requests and mismatched cookies without burning the flow", async () => {
  const flow = await start();
  const page = await prepare(flow.requestId);
  for (const headers of [
    { origin: "https://attacker.test", cookie: page.cookie },
    {
      origin: BROKER_ORIGIN,
      cookie: `${googleSignInCookieName(flow.requestId)}=${"a".repeat(43)}`,
    },
  ]) {
    const response = await realFetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({
        requestId: flow.requestId,
        csrfToken: page.nonce,
        browserProof: BROWSER_PROOF,
      }),
    });
    assert.equal(response.status, 403);
  }
  assert.equal(
    (
      (await (
        await post("/poll", { requestId: flow.requestId, codeVerifier: flow.verifier })
      ).json()) as { status: string }
    ).status,
    "pending",
  );
  await consent(flow.requestId);
});

test("proof and callback cookie failures do not consume state; concurrent complete polls release credentials once", async () => {
  const flow = await start();
  const auth = await consent(flow.requestId);
  assert.equal((await callback(auth.state, "")).status, 403);
  assert.equal(
    (await callback(auth.state, `${googleSignInCookieName(auth.state)}=${"a".repeat(43)}`)).status,
    403,
  );
  assert.equal(googleCalls.length, 0);
  const completed = await callback(auth.state, auth.cookie);
  const page = await completed.text();
  assert.equal(completed.status, 200);
  assert.match(page, /sign-in is complete/);
  assert.equal(page.includes("private-access-token"), false);
  assert.equal(page.includes("private-refresh-token"), false);
  assert.equal(page.includes("member@gmail.com"), false);
  assert.equal(completed.headers.get("location"), null);
  const raw = JSON.stringify(await AppDataSource.getRepository(AuthFlowState).find());
  assert.equal(raw.includes("private-refresh-token"), false);
  assert.equal(raw.includes("private-access-token"), false);
  assert.equal(raw.includes("broker-secret"), false);
  const tokenCall = googleCalls.find((call) => call.url.endsWith("/token"))!;
  const tokenBody = new URLSearchParams(tokenCall.body);
  assert.equal(tokenBody.get("client_secret"), "broker-secret");
  assert.equal(
    crypto.createHash("sha256").update(tokenBody.get("code_verifier")!).digest("base64url"),
    auth.url.searchParams.get("code_challenge"),
  );
  assert.equal(tokenCall.init.redirect, "error");
  assert.ok(tokenCall.init.signal);
  assert.equal((await post("/poll", { requestId: flow.requestId })).status, 400);
  assert.equal(
    (await post("/poll", { requestId: flow.requestId, codeVerifier: "x".repeat(43) })).status,
    403,
  );
  const polls = await Promise.all(
    Array.from(
      { length: 6 },
      async () =>
        (
          await post("/poll", { requestId: flow.requestId, codeVerifier: flow.verifier })
        ).json() as Promise<{ status: string; credential?: Record<string, unknown> }>,
    ),
  );
  const winner = polls.filter((result) => result.status === "complete");
  assert.equal(winner.length, 1);
  assert.deepEqual(Object.keys(winner[0].credential!).sort(), [
    "accessToken",
    "clientId",
    "email",
    "expiresAt",
    "refreshToken",
    "scope",
  ]);
  assert.equal(winner[0].credential!.email, "member@gmail.com");
  assert.equal((await callback(auth.state, auth.cookie)).status, 400);
  assert.equal(await AppDataSource.getRepository(AuthFlowState).count(), 0);
});

test("a copied sign-in link cannot continue without the initiating installation browser proof", async () => {
  const flow = await start();
  const page = await prepare(flow.requestId);
  for (const browserProof of [undefined, "x".repeat(43)]) {
    const body = new URLSearchParams({ requestId: flow.requestId, csrfToken: page.nonce });
    if (browserProof) body.set("browserProof", browserProof);
    const response = await realFetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BROKER_ORIGIN,
        cookie: page.cookie,
      },
      body,
    });
    assert.equal(response.status, browserProof ? 403 : 400);
  }
  assert.equal(googleCalls.length, 0);
  await consent(flow.requestId);
});

test("Google cancellation and incomplete grants return a safe denial to the installation", async () => {
  const cancelled = await start();
  const auth = await consent(cancelled.requestId);
  const response = await callback(
    auth.state,
    auth.cookie,
    "error=access_denied&error_description=private-upstream-detail",
  );
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes("private-upstream-detail"), false);
  const result = (await (
    await post("/poll", { requestId: cancelled.requestId, codeVerifier: cancelled.verifier })
  ).json()) as { status: string };
  assert.equal(result.status, "denied");
  assert.equal(googleCalls.length, 0);
  tokenResponse.scope = "openid https://www.googleapis.com/auth/userinfo.email";
  const missingScope = await start();
  const nextAuth = await consent(missingScope.requestId);
  await callback(nextAuth.state, nextAuth.cookie);
  assert.equal(
    (
      (await (
        await post("/poll", {
          requestId: missingScope.requestId,
          codeVerifier: missingScope.verifier,
        })
      ).json()) as { status: string }
    ).status,
    "denied",
  );
});

test("expired flows cannot authorize or be redeemed", async () => {
  const flow = await start();
  const rows = await AppDataSource.getRepository(AuthFlowState).find();
  for (const row of rows)
    await AppDataSource.getRepository(AuthFlowState).update(row.id, { expiresAt: new Date(0) });
  assert.equal((await realFetch(`${baseUrl}/authorize?requestId=${flow.requestId}`)).status, 400);
  assert.equal(
    (
      (await (
        await post("/poll", { requestId: flow.requestId, codeVerifier: flow.verifier })
      ).json()) as { status: string }
    ).status,
    "denied",
  );
});

test("refresh uses only the registered app, does not persist tokens, and hides upstream details", async () => {
  const wrong = await post("/refresh", { clientId: "other-client", refreshToken: "secret" });
  assert.equal(wrong.status, 401);
  assert.equal(googleCalls.length, 0);
  const refreshed = await post("/refresh", {
    clientId: "broker-client",
    refreshToken: "old-refresh-token",
  });
  assert.equal(refreshed.status, 200);
  const body = (await refreshed.json()) as Record<string, unknown>;
  assert.equal(body.accessToken, "private-access-token");
  assert.equal(body.refreshToken, "private-refresh-token");
  assert.equal(JSON.stringify(body).includes("broker-secret"), false);
  assert.equal(await AppDataSource.getRepository(AuthFlowState).count(), 0);
  tokenStatus = 400;
  tokenResponse = {
    error: "invalid_grant",
    error_description: "private-access-token broker-secret",
  };
  const rejected = await post("/refresh", {
    clientId: "broker-client",
    refreshToken: "expired-token",
  });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.text()).includes("broker-secret"), false);
});

test("an upstream outage across mailboxes does not lock out the installation after Google recovers", async () => {
  const goodResponse = tokenResponse;
  tokenStatus = 503;
  tokenResponse = { error: "unavailable", error_description: "private-upstream-detail" };
  for (let i = 0; i < 10; i++) {
    const response = await post("/refresh", {
      clientId: "broker-client",
      refreshToken: `mailbox-${i}-refresh-token`,
    });
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes("private-upstream-detail"), false);
  }
  tokenStatus = 200;
  tokenResponse = goodResponse;
  assert.equal(
    (
      await post("/refresh", {
        clientId: "broker-client",
        refreshToken: "mailbox-0-refresh-token",
      })
    ).status,
    200,
  );
});

test("API schemas reject caller scopes, arbitrary origins, oversized secrets and browser-origin POSTs", async () => {
  for (const body of [
    {
      codeChallenge: "a".repeat(43),
      browserChallenge: BROWSER_CHALLENGE,
      installationOrigin: "https://example.com",
      scopes: ["drive"],
    },
    {
      codeChallenge: "a".repeat(43),
      browserChallenge: BROWSER_CHALLENGE,
      installationOrigin: "https://user:password@example.com",
    },
    {
      codeChallenge: "a".repeat(43),
      browserChallenge: BROWSER_CHALLENGE,
      installationOrigin: "https://example.com/callback?token=value",
    },
    {
      codeChallenge: "invalid",
      browserChallenge: BROWSER_CHALLENGE,
      installationOrigin: "https://example.com",
    },
  ])
    assert.equal((await post("/start", body)).status, 400);
  assert.equal(
    (
      await post(
        "/start",
        {
          codeChallenge: "a".repeat(43),
          browserChallenge: BROWSER_CHALLENGE,
          installationOrigin: "https://example.com",
        },
        { origin: "https://example.com" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post("/refresh", { clientId: "broker-client", refreshToken: "x".repeat(25_000) }))
      .status,
    413,
  );
  assert.equal(
    (await post("/refresh", { clientId: "broker-client", refreshToken: "x".repeat(17_000) }))
      .status,
    400,
  );
  assert.equal(googleCalls.length, 0);
});

test("repeated start requests are rate limited", async () => {
  for (let i = 0; i < 10; i++) await start();
  const response = await post("/start", {
    codeChallenge: "a".repeat(43),
    browserChallenge: BROWSER_CHALLENGE,
    installationOrigin: "https://example.com",
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
});
