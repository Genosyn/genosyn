import assert from "node:assert/strict";
import test from "node:test";
import type { AIModel } from "../db/entities/AIModel.js";
import { decryptSecret } from "../lib/secret.js";
import {
  configWithSubscriptionAccessToken,
  confirmManagedChatgptAccount,
  describeDeviceLoginFailure,
  hasSubscriptionCredential,
  isManagedChatgptAccount,
  parseDeviceVerificationUrl,
  shouldMaterializeRepositoriesForTurnFor,
  subscriptionCredentialKind,
  subscriptionUnavailableReasonFor,
} from "./codexSubscription.js";

test("device sign-in accepts only absolute HTTPS verification URLs", () => {
  assert.equal(
    parseDeviceVerificationUrl("https://auth.openai.com/codex/device"),
    "https://auth.openai.com/codex/device",
  );
  assert.equal(parseDeviceVerificationUrl("javascript:alert(1)"), null);
  assert.equal(parseDeviceVerificationUrl("http://auth.openai.com/codex/device"), null);
  assert.equal(parseDeviceVerificationUrl("/codex/device"), null);
});

test("a token exchange that never reached OpenAI is reported as a network problem", () => {
  const described = describeDeviceLoginFailure(
    "device code exchange failed: error sending request for url (https://auth.openai.com/oauth/token)",
  );
  // The raw upstream wording stays: an operator matching it against the server
  // log should still find the same sentence.
  assert.match(
    described,
    /error sending request for url \(https:\/\/auth\.openai\.com\/oauth\/token\)/,
  );
  assert.match(described, /one-time code was accepted/);
  assert.match(described, /start a new sign-in/);
});

test("a sign-in OpenAI actually rejected is left to speak for itself", () => {
  for (const rejection of [
    "token endpoint returned status 400: invalid_grant",
    "device auth failed with status 403 Forbidden",
    "Login is restricted to workspace(s) acme.",
    "ChatGPT sign-in expired. Start a new sign-in to try again.",
  ]) {
    assert.equal(describeDeviceLoginFailure(rejection), rejection);
  }
});

test("every transport wording Codex can report earns the network guidance", () => {
  for (const transport of [
    "device code exchange failed: error sending request for url (https://auth.openai.com/oauth/token)",
    "device code exchange failed: error trying to connect: tcp connect error",
    "device code exchange failed: dns error: failed to lookup address information",
    "device code exchange failed: connection closed before message completed",
    "device code exchange failed: operation timed out",
  ]) {
    assert.match(
      describeDeviceLoginFailure(transport),
      /network problem between Genosyn and OpenAI/,
    );
  }
});

test("repository materialization follows the coding switch for subscription and API auth", () => {
  assert.equal(
    shouldMaterializeRepositoriesForTurnFor({
      authMode: "subscription",
      codingToolsEnabled: true,
      codingToolsExecutionMode: "disabled",
    }),
    false,
  );
  assert.equal(
    shouldMaterializeRepositoriesForTurnFor({
      authMode: "subscription",
      codingToolsEnabled: true,
      codingToolsExecutionMode: "host",
    }),
    true,
  );
  assert.equal(
    shouldMaterializeRepositoriesForTurnFor({
      authMode: "apikey",
      codingToolsEnabled: false,
      codingToolsExecutionMode: "host",
    }),
    false,
  );
  assert.equal(
    shouldMaterializeRepositoriesForTurnFor({
      authMode: "apikey",
      codingToolsEnabled: true,
      codingToolsExecutionMode: "host",
    }),
    true,
  );
});

function model(configJson = "{}"): AIModel {
  return {
    id: "model-subscription-test",
    provider: "openai",
    authMode: "subscription",
    configJson,
  } as AIModel;
}

test("Codex access tokens are encrypted and replace managed session credentials", () => {
  const original = model(
    JSON.stringify({
      codexAuthEncrypted: "old-managed-session",
      subscriptionCredentialKind: "chatgptSession",
      harmlessSetting: true,
    }),
  );
  const token = "codex-access-token-value-for-test";
  const updated = configWithSubscriptionAccessToken(original, token);
  const parsed = JSON.parse(updated) as Record<string, unknown>;

  assert.equal(updated.includes(token), false);
  assert.equal(parsed.codexAuthEncrypted, undefined);
  assert.equal(parsed.subscriptionCredentialKind, "accessToken");
  assert.equal(parsed.harmlessSetting, true);
  assert.equal(decryptSecret(String(parsed.codexAccessTokenEncrypted)), token);

  const connected = model(updated);
  assert.equal(subscriptionCredentialKind(connected), "accessToken");
  assert.equal(hasSubscriptionCredential(connected), true);
});

test("subscription credential detection fails closed on previews and malformed config", () => {
  assert.equal(
    subscriptionCredentialKind(model('{"subscriptionCredentialKind":"chatgptSession"}')),
    null,
  );
  assert.equal(subscriptionCredentialKind(model("{")), null);
  assert.equal(hasSubscriptionCredential(model('{"codexAuthEncrypted":" "}')), false);
});

test("managed login success follows the ChatGPT account discriminator", () => {
  assert.equal(
    isManagedChatgptAccount({
      account: { type: "chatgpt", email: "member@example.com" },
      requiresOpenaiAuth: true,
    }),
    true,
  );
  assert.equal(isManagedChatgptAccount({ account: null, requiresOpenaiAuth: true }), false);
  assert.equal(
    isManagedChatgptAccount({
      account: { type: "apiKey" },
      requiresOpenaiAuth: true,
    }),
    false,
  );
});

const MANAGED_ACCOUNT = {
  account: { type: "chatgpt", email: "member@example.com", planType: "pro" },
  requiresOpenaiAuth: true,
};
const NO_ACCOUNT = { account: null, requiresOpenaiAuth: true };

test("an account Codex has already announced is confirmed by a single read", async () => {
  let reads = 0;
  const confirmed = await confirmManagedChatgptAccount(Promise.resolve(), async () => {
    reads += 1;
    return MANAGED_ACCOUNT;
  });

  assert.equal(confirmed, true);
  assert.equal(reads, 1);
});

test("the account is read only after Codex announces the session it loaded", async () => {
  // Regression for #59: Codex 0.146.0 reports the login complete before it
  // loads the session it just wrote, and until then answers with the empty
  // account it booted with. Reading on completion failed every fast sign-in.
  let announce!: () => void;
  const announced = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let loaded = false;
  const reads: boolean[] = [];
  const confirming = confirmManagedChatgptAccount(announced, async () => {
    reads.push(loaded);
    return loaded ? MANAGED_ACCOUNT : NO_ACCOUNT;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reads, [], "nothing is read while Codex is still loading the session");
  loaded = true;
  announce();

  assert.equal(await confirming, true);
  assert.deepEqual(reads, [true]);
});

test("an announcement that never comes delays the read by the bound instead of hanging", async () => {
  const startedAt = Date.now();
  let reads = 0;
  const confirmed = await confirmManagedChatgptAccount(
    new Promise<void>(() => undefined),
    async () => {
      reads += 1;
      return MANAGED_ACCOUNT;
    },
    25,
  );

  assert.equal(confirmed, true);
  assert.equal(reads, 1);
  assert.ok(Date.now() - startedAt >= 20, "the read waited for the bound");
});

test("a failed announcement only ends the wait; the read still decides", async () => {
  const confirmed = await confirmManagedChatgptAccount(
    Promise.reject(new Error("OpenAI Codex app-server exited unexpectedly (code 3).")),
    async () => NO_ACCOUNT,
  );

  assert.equal(confirmed, false);
});

test("an account that is never a managed ChatGPT one stays unconfirmed after one read", async () => {
  for (const unmanaged of [NO_ACCOUNT, { account: { type: "apiKey" } }, {}, null, "chatgpt"]) {
    let reads = 0;
    const confirmed = await confirmManagedChatgptAccount(Promise.resolve(), async () => {
      reads += 1;
      return unmanaged;
    });

    assert.equal(confirmed, false);
    assert.equal(reads, 1);
  }
});

test("a failed read surfaces its own error instead of a bare rejection", async () => {
  await assert.rejects(
    confirmManagedChatgptAccount(Promise.resolve(), async () => {
      throw new Error("OpenAI Codex app-server timed out waiting for account/read.");
    }),
    /timed out waiting for account\/read/,
  );
});

test("subscription auth is limited to trusted self-hosted installs, in any execution mode", () => {
  assert.match(subscriptionUnavailableReasonFor({ multiTenant: true }) ?? "", /self-hosted/);
  assert.equal(subscriptionUnavailableReasonFor({ multiTenant: false }), null);
});
