import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "./billing/billingSettings.js";
import { finishSsoLogin, SsoLoginError, startSsoLogin } from "./ssoLogin.js";
import { updateSsoSettings } from "./ssoSettings.js";

type MutableSecurity = { outboundPrivateHostAllowlist: string[] };
const mutableSecurity = config.security as unknown as MutableSecurity;
const originalAllowlist = [...mutableSecurity.outboundPrivateHostAllowlist];
const originalFetch = globalThis.fetch;

let emailVerifiedClaim: unknown = true;
let tokenExchangeBody: URLSearchParams | null = null;
let tokenExchangeCount = 0;

before(async () => {
  await initTestDb();
});

after(async () => {
  globalThis.fetch = originalFetch;
  mutableSecurity.outboundPrivateHostAllowlist = originalAllowlist;
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  mutableSecurity.outboundPrivateHostAllowlist = ["idp.test"];
  emailVerifiedClaim = true;
  tokenExchangeBody = null;
  tokenExchangeCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url === "https://idp.test/.well-known/openid-configuration") {
      return Response.json({
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
        userinfo_endpoint: "https://idp.test/userinfo",
      });
    }
    if (url === "https://idp.test/token") {
      tokenExchangeCount += 1;
      tokenExchangeBody = new URLSearchParams(init?.body as URLSearchParams);
      return Response.json({ access_token: "access-token" });
    }
    if (url === "https://idp.test/userinfo") {
      return Response.json({
        sub: "stable-subject",
        email: "member@example.com",
        email_verified: emailVerifiedClaim,
        name: "SSO Member",
      });
    }
    throw new Error(`Unexpected fetch in SSO test: ${url}`);
  };
  // Instance SSO on a billing-disabled install requires an Enterprise
  // license (M56). These tests exercise the handshake itself, so run them as
  // a billing-enabled install, where the operator's SSO stays ungated.
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      growthMonthlyPriceId: "price_growth",
      scaleMonthlyPriceId: "price_scale",
      encryptedSecretKey: "",
      encryptedWebhookSecret: "",
    }),
  });
  invalidateBillingSettingsCache();
  await updateSsoSettings({
    enabled: true,
    provider: "oidc",
    displayName: "Company SSO",
    issuer: "https://idp.test",
    clientId: "client-id",
    clientSecret: "client-secret",
    autoProvision: true,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("OIDC state is bound to the initiating browser before any code exchange", async () => {
  const started = await startSsoLogin();
  const state = new URL(started.authorizeUrl).searchParams.get("state");
  assert.ok(state);
  await assert.rejects(
    finishSsoLogin({ code: "authorization-code", state, browserBinding: "different-browser" }),
    (error: unknown) => {
      assert.ok(error instanceof SsoLoginError);
      assert.match(error.message, /did not originate in this browser/);
      return true;
    },
  );
  assert.equal(tokenExchangeCount, 0, "a stolen state cannot be exchanged from another browser");
  await assert.rejects(
    finishSsoLogin({
      code: "authorization-code",
      state,
      browserBinding: started.browserBinding,
    }),
    /expired or was already used/,
  );
});

test("OIDC authorization and token exchange use matching S256 PKCE values", async () => {
  const started = await startSsoLogin();
  const authorize = new URL(started.authorizeUrl);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorize.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  const state = authorize.searchParams.get("state");
  assert.ok(state);

  const user = await finishSsoLogin({
    code: "authorization-code",
    state,
    browserBinding: started.browserBinding,
  });
  assert.equal(user.email, "member@example.com");
  assert.ok(user.emailVerifiedAt);
  assert.equal(await AppDataSource.getRepository(User).count(), 1);
  assert.ok(tokenExchangeBody);
  const verifier = tokenExchangeBody.get("code_verifier");
  assert.ok(verifier);
  assert.equal(
    crypto.createHash("sha256").update(verifier).digest("base64url"),
    authorize.searchParams.get("code_challenge"),
  );
  assert.equal(tokenExchangeBody.get("client_secret"), "client-secret");
});

test("OIDC refuses to link or provision unless email verification is affirmative", async () => {
  for (const untrustedClaim of [undefined, false, "true"]) {
    emailVerifiedClaim = untrustedClaim;
    const started = await startSsoLogin();
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    assert.ok(state);
    await assert.rejects(
      finishSsoLogin({
        code: "authorization-code",
        state,
        browserBinding: started.browserBinding,
      }),
      /not a verified address/,
    );
  }
  assert.equal(await AppDataSource.getRepository(User).count(), 0);
});
