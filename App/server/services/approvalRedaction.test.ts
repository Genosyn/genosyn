import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { redactSensitiveText } from "./approvalRedaction.js";

/**
 * The one redaction grammar every boundary shares: Approval previews, TLDRs, and
 * a chat turn's recorded steps and thinking, which scrub text still arriving.
 */

describe("a value with no closing quote", () => {
  test("costs the same however many backslashes it holds", () => {
    // Each backslash used to double the work: 26 of these froze the whole server's
    // event loop for 26 seconds, and it would be 7 minutes at 30.
    const body = Array.from({ length: 200 }, () => "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC").join("\\n");
    for (const text of [
      `{"private_key": "x${body}`,
      `{"token": "x${body}`,
      `password="x${body}`,
      `secret='x${body}`,
    ]) {
      const started = performance.now();
      redactSensitiveText(text);
      assert.ok(performance.now() - started < 500, `took too long on ${text.slice(0, 20)}`);
    }
  });

  test("still reads a backslash and what follows it as part of the value", () => {
    assert.equal(
      redactSensitiveText('{"password": "two \\"quoted\\" words"} and on'),
      '{"password": "[redacted]"} and on',
    );
    assert.equal(
      redactSensitiveText('token = "line one\\\nline two" and on'),
      "token = [redacted] and on",
    );
    assert.equal(redactSensitiveText("secret='it\\'s here' and on"), "secret=[redacted] and on");
    assert.equal(
      redactSensitiveText('{"secret": "ends in a backslash\\\\", "next": 1}'),
      '{"secret": "[redacted]", "next": 1}',
    );
  });
});

describe("a private key", () => {
  const body = Array.from({ length: 5 }, (_, i) => `KEYLINE${i}${"A".repeat(50)}`).join("\n");
  const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;

  test("whole, is replaced whole", () => {
    assert.equal(redactSensitiveText(`before\n${key}\nafter`), "before\n[redacted private key]\nafter");
  });

  test("still arriving, or clipped after its start, goes from where it starts", () => {
    const text = redactSensitiveText(`before\n${key.slice(0, 120)}`);
    assert.equal(text, "before\n[redacted private key]");
  });

  test("clipped before its end goes up to where it ends", () => {
    const text = redactSensitiveText(`${key.slice(60)}\nafter`);
    assert.equal(text, "[redacted private key]\nafter");
  });

  test("two of them, and one cut off after, all go", () => {
    const text = redactSensitiveText(`${key}\nmiddle\n${key}\nthen\n${key.slice(0, 100)}`);
    assert.equal(
      text,
      "[redacted private key]\nmiddle\n[redacted private key]\nthen\n[redacted private key]",
    );
  });

  test("a certificate is public, and stays", () => {
    const certificate = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";
    assert.equal(redactSensitiveText(certificate), certificate);
  });
});
