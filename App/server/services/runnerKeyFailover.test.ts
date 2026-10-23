import assert from "node:assert/strict";
import { test } from "node:test";

import { apiKeyFailoverLine } from "./runner.js";

test("a Run log says which key was refused, why, and which key took over — by preview only", () => {
  assert.equal(
    apiKeyFailoverLine({ from: "sk-…0001", to: "sk-…0002", status: 429, kind: "rate_limit" }),
    "[model] The provider refused API key sk-…0001 (rate-limited, HTTP 429); the request moved to the next key, sk-…0002. See the API keys under this AI Model's Advanced settings.",
  );
  for (const [kind, words] of [
    ["auth", "invalid or revoked"],
    ["permission", "not allowed to do this"],
    ["billing", "out of credit or a billing problem"],
    ["quota", "out of quota"],
  ] as const) {
    assert.match(
      apiKeyFailoverLine({ from: "sk-…0001", to: "sk-…0002", status: 401, kind }),
      new RegExp(`\\(${words}, HTTP 401\\)`),
    );
  }
});
