import assert from "node:assert/strict";
import test from "node:test";
import type { AIModel } from "../db/entities/AIModel.js";
import { decryptSecret } from "../lib/secret.js";
import {
  configWithSubscriptionAccessToken,
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

test("repository materialization is isolated or omitted when subscription auth can run", () => {
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

test("subscription auth rejects shared and same-UID host-shell deployments", () => {
  assert.match(
    subscriptionUnavailableReasonFor({
      multiTenant: true,
      codingToolsExecutionMode: "disabled",
      bubblewrapAvailable: false,
    }) ?? "",
    /self-hosted/,
  );
  assert.match(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsExecutionMode: "host",
      bubblewrapAvailable: true,
    }) ?? "",
    /bubblewrap isolation/,
  );
  assert.equal(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsExecutionMode: "bubblewrap",
      bubblewrapAvailable: true,
    }),
    null,
  );
  assert.match(
    subscriptionUnavailableReasonFor({
      multiTenant: false,
      codingToolsExecutionMode: "bubblewrap",
      bubblewrapAvailable: false,
    }) ?? "",
    /working bubblewrap/,
  );
});
