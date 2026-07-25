import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIModel } from "../db/entities/AIModel.js";
import { encryptSecret } from "../lib/secret.js";
import { previewBaseURL, readCustomEndpoint } from "./customEndpoint.js";

function endpoint(config: Record<string, unknown>, authMode: AIModel["authMode"] = "customEndpoint") {
  return {
    authMode,
    configJson: JSON.stringify(config),
  } as AIModel;
}

describe("previewBaseURL", () => {
  test("reduces valid URLs to a host-only display value", () => {
    assert.equal(previewBaseURL(" http://localhost:11434/v1 "), "localhost:11434");
    assert.equal(previewBaseURL("https://api.together.xyz/v1"), "api.together.xyz");
    assert.equal(previewBaseURL("https://user:pass@example.com/path"), "example.com");
  });

  test("returns trimmed input when it is not a URL", () => {
    assert.equal(previewBaseURL(" local model "), "local model");
    assert.equal(previewBaseURL("   "), "");
  });
});

describe("readCustomEndpoint", () => {
  test("decrypts a complete endpoint and trims operator input", () => {
    const parsed = readCustomEndpoint(
      endpoint({
        baseURLEncrypted: encryptSecret(" http://models.internal:8000/v1 "),
        apiKeyEncrypted: encryptSecret("secret-key"),
        modelId: " qwen-32b ",
      }),
    );
    assert.deepEqual(parsed, {
      baseURL: "http://models.internal:8000/v1",
      apiKey: "secret-key",
      modelId: "qwen-32b",
    });
  });

  test("allows a custom endpoint with no API key", () => {
    const parsed = readCustomEndpoint(
      endpoint({
        baseURLEncrypted: encryptSecret("http://localhost:11434/v1"),
        modelId: "llama",
      }),
    );
    assert.equal(parsed?.apiKey, null);
  });

  test("drops a corrupt optional key without losing a usable endpoint", () => {
    const parsed = readCustomEndpoint(
      endpoint({
        baseURLEncrypted: encryptSecret("http://localhost:11434/v1"),
        apiKeyEncrypted: "not-ciphertext",
        modelId: "llama",
      }),
    );
    assert.equal(parsed?.apiKey, null);
    assert.equal(parsed?.modelId, "llama");
  });

  test("rejects wrong modes, malformed JSON, and missing required fields", () => {
    assert.equal(readCustomEndpoint(endpoint({}, "apikey")), null);
    assert.equal(readCustomEndpoint({ authMode: "customEndpoint", configJson: "{" } as AIModel), null);
    assert.equal(readCustomEndpoint(endpoint({ modelId: "llama" })), null);
    assert.equal(
      readCustomEndpoint(endpoint({ baseURLEncrypted: encryptSecret("http://host/v1") })),
      null,
    );
    assert.equal(
      readCustomEndpoint(
        endpoint({ baseURLEncrypted: "bad", modelId: "llama" }),
      ),
      null,
    );
  });

  test("rejects a decrypted base URL that is blank", () => {
    assert.equal(
      readCustomEndpoint(
        endpoint({
          baseURLEncrypted: encryptSecret("   "),
          modelId: "llama",
        }),
      ),
      null,
    );
  });
});
