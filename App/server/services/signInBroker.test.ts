import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { closeTestDb, initTestDb } from "../test/dbHarness.js";
import { readAuthFlowState } from "./authFlowState.js";
import { setPublicUrl } from "./publicUrl.js";
import {
  overrideRuntimeSettingsForTests,
  resetRuntimeSettingsCacheForTests,
} from "./runtimeSettings.js";
import { createSignInBroker } from "./signInBroker.js";
import { canonicalSignInProtocol } from "./signInBrokerProtocol.js";
import type { SignInExchange, SignInProvider } from "./signInBrokerTypes.js";
import { getSignInProvider } from "./signInProviders/index.js";

const digest = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");

before(initTestDb);
after(async () => {
  resetRuntimeSettingsCacheForTests();
  await closeTestDb();
});

test("shared broker delegates a synthetic integration without Gmail credentials or protocol assumptions", async () => {
  await setPublicUrl("https://app.example.test");
  overrideRuntimeSettingsForTests({
    oauth: { hostSignIn: true, signInHostUrl: "https://connect.example.test" },
  });
  const exchanges: SignInExchange[] = [];
  const refreshes: Parameters<SignInProvider["refresh"]>[0][] = [];
  const credential = {
    clientId: "example-client",
    accessToken: "example-access",
    refreshToken: "example-refresh",
  };
  const provider: SignInProvider = {
    id: "example",
    throttlePrefix: "example-broker",
    authorizationOrigin: "https://identity.example.test",
    page: {
      title: "Connect Example",
      introduction: "Connect this integration.",
      explanation: "The installation receives its credential.",
      continueLabel: "Continue with Example",
    },
    messages: { cancelled: "Cancelled.", completed: "Connected.", failed: "Failed." },
    registration: async () => ({ clientId: credential.clientId, clientSecret: "example-secret" }),
    authorize: (args) => {
      const url = new URL("/consent", provider.authorizationOrigin);
      for (const [key, value] of Object.entries(args)) url.searchParams.set(key, value);
      return url.toString();
    },
    exchange: async (args) => {
      exchanges.push(args);
      return credential;
    },
    refresh: async (args) => {
      refreshes.push(args);
      return { accessToken: "example-refreshed" };
    },
  };
  const protocol = canonicalSignInProtocol(provider.id);
  const broker = createSignInBroker(provider, protocol);
  // Reuse the state kinds deliberately: payload binding still rejects the wrong adapter/path.
  const wrongProvider = createSignInBroker(
    { ...provider, id: "other" },
    { ...protocol, providerId: "other", basePath: "/api/connect/other" },
  );
  const wrongPath = createSignInBroker(provider, {
    ...protocol,
    basePath: "/api/connect/example-v2",
  });
  assert.equal(getSignInProvider(provider.id), undefined, "the fixture is not a public adapter");
  assert.deepEqual(await broker.status(), { version: 1, available: true });
  const verifier = crypto.randomBytes(32).toString("base64url");
  const browserProof = crypto.randomBytes(32).toString("base64url");
  const started = await broker.start({
    codeChallenge: digest(verifier),
    browserChallenge: digest(browserProof),
    installationOrigin: "http://localhost:8471",
  });
  assert.equal(new URL(started.authorizeUrl).pathname, "/api/connect/example/authorize");
  await assert.rejects(wrongProvider.prepare(started.requestId), /expired/);
  await assert.rejects(wrongPath.prepare(started.requestId), /expired/);
  const prepared = await broker.prepare(started.requestId);
  const authorization = await broker.authorize({
    requestId: started.requestId,
    browserNonce: prepared.browserNonce,
    browserProof,
  });
  const providerUrl = new URL(authorization.authorizeUrl);
  assert.equal(providerUrl.origin, provider.authorizationOrigin);
  assert.equal(
    providerUrl.searchParams.get("redirectUri"),
    "https://connect.example.test/api/connect/example/callback",
  );
  const callback = {
    state: authorization.state,
    browserNonce: prepared.browserNonce,
    code: "example-code",
  };
  await assert.rejects(wrongProvider.complete(callback), /expired/);
  await assert.rejects(wrongPath.complete(callback), /expired/);
  assert.equal(exchanges.length, 0);
  assert.ok(await readAuthFlowState(protocol.callbackKind, authorization.state));
  assert.deepEqual(await broker.complete(callback), { connected: true, detail: "Connected." });
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].clientSecret, "example-secret");
  assert.equal(exchanges[0].code, "example-code");
  assert.equal(exchanges[0].redirectUri, providerUrl.searchParams.get("redirectUri"));
  assert.equal(digest(exchanges[0].codeVerifier), providerUrl.searchParams.get("codeChallenge"));
  const poll = { requestId: started.requestId, codeVerifier: verifier };
  assert.equal((await wrongProvider.poll(poll)).status, "denied");
  assert.equal((await wrongPath.poll(poll)).status, "denied");
  assert.deepEqual(await broker.poll(poll), { status: "complete", credential });
  assert.equal((await broker.poll(poll)).status, "denied");
  assert.deepEqual(
    await broker.refresh({ clientId: credential.clientId, refreshToken: credential.refreshToken }),
    { accessToken: "example-refreshed" },
  );
  assert.deepEqual(refreshes, [
    {
      clientId: credential.clientId,
      clientSecret: "example-secret",
      refreshToken: credential.refreshToken,
    },
  ]);
});
