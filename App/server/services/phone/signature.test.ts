import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { twilioSignature, urlPortVariants, verifyTwilioSignature } from "./signature.js";

/**
 * The signature is the only credential the phone webhooks have, so the two
 * things worth pinning are that it is computed exactly as Twilio computes it —
 * checked against the example Twilio publishes — and that every way of being
 * wrong is refused.
 */

const VECTOR = {
  authToken: "12345",
  url: "https://mycompany.com/myapp.php?foo=1&bar=2",
  params: {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  },
  expected: "0/KCTR6DLpKmkAf8muzZqo1nDgQ=",
};

describe("Twilio webhook signatures", () => {
  test("match the example in Twilio's security documentation", () => {
    assert.equal(twilioSignature(VECTOR.authToken, VECTOR.url, VECTOR.params), VECTOR.expected);
    assert.equal(
      verifyTwilioSignature({
        authToken: VECTOR.authToken,
        signature: VECTOR.expected,
        urls: [VECTOR.url],
        params: VECTOR.params,
      }),
      true,
    );
  });

  test("hold whichever default-port spelling of the URL Twilio signed", () => {
    const withPort = "https://mycompany.com:443/myapp.php?foo=1&bar=2";
    const signature = twilioSignature(VECTOR.authToken, withPort, VECTOR.params);
    assert.equal(
      verifyTwilioSignature({
        authToken: VECTOR.authToken,
        signature,
        urls: [VECTOR.url],
        params: VECTOR.params,
      }),
      true,
    );
    assert.deepEqual(urlPortVariants("http://example.com:8471/a"), ["http://example.com:8471/a"]);
  });

  test("refuse a wrong token, a changed parameter, another path, or no signature", () => {
    const base = {
      authToken: VECTOR.authToken,
      signature: VECTOR.expected,
      urls: [VECTOR.url],
      params: VECTOR.params,
    };
    assert.equal(verifyTwilioSignature({ ...base, authToken: "54321" }), false);
    assert.equal(
      verifyTwilioSignature({ ...base, params: { ...VECTOR.params, Digits: "9999" } }),
      false,
    );
    assert.equal(
      verifyTwilioSignature({ ...base, urls: ["https://mycompany.com/other.php?foo=1&bar=2"] }),
      false,
    );
    assert.equal(verifyTwilioSignature({ ...base, signature: undefined }), false);
    assert.equal(verifyTwilioSignature({ ...base, signature: "" }), false);
    assert.equal(verifyTwilioSignature({ ...base, authToken: "" }), false);
  });

  test("sign repeated parameters in sorted order, independent of arrival order", () => {
    const a = twilioSignature("token", "https://x.test/hook", { Event: ["b", "a"], Z: "1" });
    const b = twilioSignature("token", "https://x.test/hook", { Z: "1", Event: ["a", "b"] });
    assert.equal(a, b);
  });
});
