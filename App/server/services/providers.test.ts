import assert from "node:assert/strict";
import test from "node:test";
import type { AIModel, AuthMode, Provider } from "../db/entities/AIModel.js";
import { isModelConnected, PROVIDERS } from "./providers.js";

function model(authMode: AuthMode, configJson: string): AIModel {
  return { authMode, configJson } as AIModel;
}

test("provider catalogue exposes exactly the supported model APIs", () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ["anthropic", "custom", "openai"]);

  for (const [provider, spec] of Object.entries(PROVIDERS) as [
    Provider,
    (typeof PROVIDERS)[Provider],
  ][]) {
    assert.ok(spec.label.length > 0, `${provider} needs a label`);
    assert.equal(spec.supportsApiKey, provider !== "custom");
    assert.equal(spec.supportsCustomEndpoint, provider === "custom");
    assert.equal(spec.apiKeyEnv === null, provider === "custom");
  }
});

test("API-key models require a non-blank encrypted credential", () => {
  assert.equal(isModelConnected(model("apikey", '{"apiKeyEncrypted":"v2:ciphertext"}')), true);
  assert.equal(isModelConnected(model("apikey", '{"apiKeyEncrypted":""}')), false);
  assert.equal(isModelConnected(model("apikey", '{"apiKeyEncrypted":"   "}')), false);
  assert.equal(isModelConnected(model("apikey", '{"apiKeyEncrypted":42}')), false);
  assert.equal(isModelConnected(model("apikey", '{"apiKeyPreview":"...last4"}')), false);
});

test("custom models require a non-blank encrypted base URL but not an API key", () => {
  assert.equal(
    isModelConnected(model("customEndpoint", '{"baseURLEncrypted":"v2:ciphertext"}')),
    true,
  );
  assert.equal(
    isModelConnected(
      model(
        "customEndpoint",
        '{"baseURLEncrypted":"v2:ciphertext","apiKeyEncrypted":""}',
      ),
    ),
    true,
  );
  assert.equal(isModelConnected(model("customEndpoint", '{"baseURLEncrypted":"\\t"}')), false);
  assert.equal(isModelConnected(model("customEndpoint", '{"modelId":"local-model"}')), false);
});

test("malformed or non-object model configuration is disconnected", () => {
  for (const configJson of ["", "{", "null", "[]", '"ciphertext"', "42"]) {
    assert.equal(isModelConnected(model("apikey", configJson)), false, configJson);
  }
});

test("unknown authentication modes fail closed", () => {
  const unknown = model("apikey", '{"apiKeyEncrypted":"v2:ciphertext"}');
  unknown.authMode = "oauth" as AuthMode;
  assert.equal(isModelConnected(unknown), false);
});
