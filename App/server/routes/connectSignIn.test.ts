import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { errorHandler } from "../middleware/error.js";
import { securityHeaders } from "../middleware/httpSecurity.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  compareAndSetAuthFlowState,
  createAuthFlowState,
  readAuthFlowState,
} from "../services/authFlowState.js";
import { saveOauthApp } from "../services/oauthApps.js";
import { getPublicUrl, setPublicUrl } from "../services/publicUrl.js";
import {
  overrideRuntimeSettingsForTests,
  resetRuntimeSettingsCacheForTests,
} from "../services/runtimeSettings.js";
import { canonicalSignInProtocol } from "../services/signInBrokerProtocol.js";
import { googleSignInCookieName } from "../services/googleSignInBroker.js";
import { connectSignInRouter } from "./connectSignIn.js";
import { googleSignInBrokerRouter } from "./googleSignInBroker.js";

const ORIGIN = "https://connect.genosyn.test";
const APP_ORIGIN = "https://app.genosyn.test";
const CANONICAL = "/api/connect/google";
const LEGACY = "/api/google-sign-in";
const PROOF = "b".repeat(43);
const scope =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic";
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");
const realFetch = globalThis.fetch;
let server: Server;
let origin: string;
let calls: URLSearchParams[];

before(async () => {
  await initTestDb();
  const app = express();
  app.use(securityHeaders);
  app.use(express.json());
  app.use("/api/connect", connectSignInRouter);
  app.use(LEGACY, googleSignInBrokerRouter);
  app.use(errorHandler);
  app.use((_req, res) => res.type("html").send("App UI fallback"));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  resetRuntimeSettingsCacheForTests();
  await setPublicUrl(APP_ORIGIN);
  await saveOauthApp("google", {
    clientId: "registered-client",
    clientSecret: "private-client-secret",
  });
  overrideRuntimeSettingsForTests({ oauth: { hostSignIn: true, signInHostUrl: ORIGIN } });
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      calls.push(new URLSearchParams(String(init.body)));
      return Response.json({
        access_token: "private-access",
        refresh_token: "private-refresh",
        expires_in: 3600,
        scope,
        token_type: "Bearer",
      });
    }
    if (String(input) === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({ email: "member@gmail.com", email_verified: true });
    }
    throw new Error("Unexpected provider endpoint");
  };
});

async function post(path: string, body: unknown) {
  return realFetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function start(path = CANONICAL) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const response = await post(`${path}/start`, {
    codeChallenge: digest(verifier),
    browserChallenge: digest(PROOF),
    installationOrigin: "http://localhost:8471",
  });
  assert.equal(response.status, 200);
  return { ...((await response.json()) as { requestId: string; authorizeUrl: string }), verifier };
}
async function authorize(requestId: string, path = CANONICAL) {
  const response = await realFetch(`${origin}${path}/authorize?requestId=${requestId}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const nonce = /name="csrfToken" value="([A-Za-z0-9_-]+)"/.exec(html)![1];
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const result = await realFetch(`${origin}${path}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams({ requestId, csrfToken: nonce, browserProof: PROOF }),
  });
  assert.equal(result.status, 303);
  const url = new URL(result.headers.get("location")!);
  return {
    url,
    state: url.searchParams.get("state")!,
    cookie: result.headers.getSetCookie().at(-1)!.split(";")[0],
    response,
    html,
  };
}

test("canonical Google sign-in completes through the shared host and refreshes only through the adapter", async () => {
  assert.deepEqual(await (await realFetch(`${origin}${CANONICAL}/status`)).json(), {
    version: 1,
    available: true,
  });
  const flow = await start();
  assert.equal(new URL(flow.authorizeUrl).pathname, `${CANONICAL}/authorize`);
  const auth = await authorize(flow.requestId);
  assert.match(auth.html, /genosyn-sign-in-ready/);
  assert.match(auth.html, /genosyn-sign-in-launch/);
  assert.doesNotMatch(auth.html, /genosyn-google-sign-in/);
  assert.match(auth.html, /Continue with Google/);
  assert.equal(auth.response.headers.get("referrer-policy"), "same-origin");
  assert.match(auth.response.headers.get("set-cookie")!, /Path=\/api\/connect\/google/);
  assert.match(auth.response.headers.get("set-cookie")!, /HttpOnly.*Secure.*SameSite=Lax/);
  assert.doesNotMatch(auth.response.headers.get("set-cookie")!, /Domain=/i);
  assert.equal(auth.url.searchParams.get("redirect_uri"), `${ORIGIN}${CANONICAL}/callback`);
  assert.deepEqual(
    new Set(auth.url.searchParams.get("scope")!.split(" ")),
    new Set(scope.split(" ")),
  );
  assert.equal(auth.url.searchParams.get("include_granted_scopes"), "false");
  // A callback from one route must not be consumed by a compatibility alias.
  const wrong = await realFetch(`${origin}${LEGACY}/callback?state=${auth.state}&code=code`, {
    headers: { cookie: auth.cookie },
  });
  assert.equal(wrong.status, 400);
  assert.equal(calls.length, 0);
  const completed = await realFetch(
    `${origin}${CANONICAL}/callback?state=${auth.state}&code=code`,
    { headers: { cookie: auth.cookie } },
  );
  assert.equal(completed.status, 200);
  assert.equal(completed.headers.get("referrer-policy"), "no-referrer");
  assert.doesNotMatch(await completed.text(), /private-access|private-refresh|member@gmail/);
  assert.equal(calls[0].get("redirect_uri"), `${ORIGIN}${CANONICAL}/callback`);
  assert.equal(digest(calls[0].get("code_verifier")!), auth.url.searchParams.get("code_challenge"));
  const results = await Promise.all(
    Array.from(
      { length: 4 },
      async () =>
        (
          await post(`${CANONICAL}/poll`, {
            requestId: flow.requestId,
            codeVerifier: flow.verifier,
          })
        ).json() as Promise<{ status: string; credential?: { refreshToken: string } }>,
    ),
  );
  assert.equal(results.filter((result) => result.status === "complete").length, 1);
  const refresh = await post(`${CANONICAL}/refresh`, {
    clientId: "registered-client",
    refreshToken: "private-refresh",
  });
  assert.equal(refresh.status, 200);
  assert.equal(calls.at(-1)!.get("grant_type"), "refresh_token");
  assert.equal(calls.at(-1)!.get("client_secret"), "private-client-secret");
  assert.equal(getPublicUrl(), APP_ORIGIN);
});

test("released callbacks with legacy payload fields and cookie paths survive the refactor", async () => {
  const nonce = "n".repeat(43);
  const verifier = "v".repeat(43);
  const requestId = await createAuthFlowState(
    "hosted-google-sign-in",
    {
      codeChallenge: digest(verifier),
      browserChallenge: digest(PROOF),
      installationOrigin: "http://localhost:8471",
      clientId: "registered-client",
      redirectUri: `${ORIGIN}${LEGACY}/callback`,
      status: "authorizing",
      browserNonceHash: digest(nonce),
    },
    600_000,
  );
  const state = await createAuthFlowState(
    "hosted-google-sign-in-callback",
    {
      requestId,
      browserNonceHash: digest(nonce),
      googleCodeVerifier: "legacy-provider-verifier",
    },
    600_000,
  );
  const cookie = `${googleSignInCookieName(state)}=${nonce}`;
  const wrong = await realFetch(`${origin}${CANONICAL}/callback?state=${state}&code=code`, {
    headers: { cookie },
  });
  assert.equal(wrong.status, 400);
  assert.equal(calls.length, 0);
  const completed = await realFetch(`${origin}${LEGACY}/callback?state=${state}&code=code`, {
    headers: { cookie },
  });
  assert.equal(completed.status, 200);
  assert.match(completed.headers.get("set-cookie")!, /Path=\/api\/google-sign-in/);
  assert.equal(calls[0].get("code_verifier"), "legacy-provider-verifier");
  assert.equal(calls[0].get("redirect_uri"), `${ORIGIN}${LEGACY}/callback`);
  assert.equal(
    (
      (await (await post(`${LEGACY}/poll`, { requestId, codeVerifier: verifier })).json()) as {
        status: string;
      }
    ).status,
    "complete",
  );
  const newLegacy = await start(LEGACY);
  const legacyAuth = await authorize(newLegacy.requestId, LEGACY);
  assert.match(legacyAuth.html, /genosyn-google-sign-in-ready/);
  assert.equal(legacyAuth.url.searchParams.get("redirect_uri"), `${ORIGIN}${LEGACY}/callback`);
});

test("canonical state checks provider and path bindings before consuming callbacks", async () => {
  const protocol = canonicalSignInProtocol("google");
  for (const changed of [{ provider: "github" }, { brokerPath: LEGACY }]) {
    const flow = await start();
    const auth = await authorize(flow.requestId);
    const original = await readAuthFlowState<Record<string, unknown>>(
      protocol.callbackKind,
      auth.state,
    );
    assert.ok(original);
    assert.equal(original.payload.provider, "google");
    assert.equal(original.payload.brokerPath, CANONICAL);
    assert.ok(
      await compareAndSetAuthFlowState(protocol.callbackKind, auth.state, original, {
        ...original.payload,
        ...changed,
      }),
    );
    const response = await realFetch(
      `${origin}${CANONICAL}/callback?state=${auth.state}&code=code`,
      { headers: { cookie: auth.cookie } },
    );
    assert.equal(response.status, 400);
    assert.ok(await readAuthFlowState(protocol.callbackKind, auth.state));
  }
  assert.equal(calls.length, 0);
});

test("unknown providers and endpoints terminate with JSON404 instead of the App UI", async () => {
  for (const path of [
    "/api/connect",
    "/api/connect/github/status",
    "/api/connect/GOOGLE/status",
    `${CANONICAL}/unknown`,
  ]) {
    const response = await realFetch(`${origin}${path}`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type")!, /application\/json/);
    assert.doesNotMatch(await response.text(), /App UI fallback/);
  }
  assert.equal(calls.length, 0);
});

test("canonical and legacy start routes share a single throttle budget", async () => {
  for (let i = 0; i < 10; i++) await start(i % 2 ? LEGACY : CANONICAL);
  for (const path of [CANONICAL, LEGACY]) {
    const response = await post(`${path}/start`, {
      codeChallenge: digest("verifier"),
      browserChallenge: digest(PROOF),
      installationOrigin: "http://localhost:8471",
    });
    assert.equal(response.status, 429);
  }
});
