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

test("repository materialization is isolated or omitted when subscription auth can run", () => {
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
      codingToolsExecutionMode: "bubblewrap",
    }),
    true,
  );
  assert.equal(
    shouldMaterializeRepositoriesForTurnFor({
      authMode: "subscription",
      codingToolsEnabled: true,
      codingToolsExecutionMode: "host",
    }),
    false,
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

test("an account Codex already knows about is confirmed without a refresh", async () => {
  const reads: Array<{ refreshToken: boolean }> = [];
  const confirmed = await confirmManagedChatgptAccount(async (params) => {
    reads.push(params);
    return MANAGED_ACCOUNT;
  });

  assert.equal(confirmed, true);
  assert.deepEqual(reads, [{ refreshToken: false }]);
});

test("a session written during sign-in is confirmed by the refreshing read", async () => {
  // Regression: the app-server answers from the credential snapshot it booted
  // with, so the session a device login just wrote appears only after a
  // refresh. Rejecting the first empty answer failed every completed sign-in.
  const reads: Array<{ refreshToken: boolean }> = [];
  const confirmed = await confirmManagedChatgptAccount(async (params) => {
    reads.push(params);
    return params.refreshToken ? MANAGED_ACCOUNT : NO_ACCOUNT;
  });

  assert.equal(confirmed, true);
  assert.deepEqual(reads, [{ refreshToken: false }, { refreshToken: true }]);
});

test("an account that is never a managed ChatGPT one stays unconfirmed", async () => {
  for (const unmanaged of [NO_ACCOUNT, { account: { type: "apiKey" } }, {}, null, "chatgpt"]) {
    const reads: Array<{ refreshToken: boolean }> = [];
    const confirmed = await confirmManagedChatgptAccount(async (params) => {
      reads.push(params);
      return unmanaged;
    });

    assert.equal(confirmed, false);
    assert.deepEqual(reads, [{ refreshToken: false }, { refreshToken: true }]);
  }
});

test("a failed refreshing read surfaces its own error instead of a bare rejection", async () => {
  await assert.rejects(
    confirmManagedChatgptAccount(async (params) => {
      if (!params.refreshToken) return NO_ACCOUNT;
      throw new Error("OpenAI Codex app-server timed out waiting for account/read.");
    }),
    /timed out waiting for account\/read/,
  );
});

test("subscription auth accepts safe disabled and isolated bubblewrap deployments", () => {
  for (const codingToolsExecutionMode of ["disabled", "host", "bubblewrap"] as const) {
    assert.match(
      subscriptionUnavailableReasonFor({
        multiTenant: true,
        codingToolsEnabled: true,
        codingToolsExecutionMode,
        bubblewrapAvailable: true,
      }) ?? "",
      /self-hosted/,
    );
  }
  assert.match(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsEnabled: true,
      codingToolsExecutionMode: "host",
      bubblewrapAvailable: true,
    }) ?? "",
    /host-process tools/,
  );
  assert.equal(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsEnabled: true,
      codingToolsExecutionMode: "disabled",
      bubblewrapAvailable: false,
    }),
    null,
  );
  assert.equal(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsEnabled: true,
      codingToolsExecutionMode: "bubblewrap",
      bubblewrapAvailable: true,
    }),
    null,
  );
  assert.match(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsEnabled: true,
      codingToolsExecutionMode: "bubblewrap",
      bubblewrapAvailable: false,
    }) ?? "",
    /working bubblewrap/,
  );
  assert.equal(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsEnabled: false,
      codingToolsExecutionMode: "bubblewrap",
      bubblewrapAvailable: false,
    }),
    null,
  );
  assert.match(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsEnabled: false,
      codingToolsExecutionMode: "host",
      bubblewrapAvailable: false,
    }) ?? "",
    /host-process tools/,
  );
});
