import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { config } from "../../config.js";
import { decryptSecret, encryptSecret } from "./secret.js";

test("round-trips scoped authenticated ciphertext", () => {
  const encrypted = encryptSecret("tenant credential", "company:alpha");
  assert.match(encrypted, /^v2\./);
  assert.equal(decryptSecret(encrypted), "tenant credential");
  // Tamper a character mid-payload rather than the final one. The last
  // base64 character carries padding bits that don't all survive a decode,
  // so overwriting it is not guaranteed to change the ciphertext — whenever
  // that character already equals the replacement the "tampered" string is
  // byte-identical to the original, decryption succeeds, and the expected
  // exception never fires (~6% of runs, since padding restricts the final
  // character to 16 values). A mid-payload swap always changes real bytes,
  // so the GCM auth tag rejects it deterministically.
  const body = encrypted.slice("v2.".length);
  const at = Math.floor(body.length / 2);
  const tampered = `v2.${body.slice(0, at)}${body[at] === "A" ? "B" : "A"}${body.slice(at + 1)}`;
  assert.notEqual(tampered, encrypted);
  assert.throws(() => decryptSecret(tampered));
});

test("reads legacy session-secret ciphertexts during rotation", () => {
  const key = crypto.createHash("sha256").update(config.sessionSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
  const blob = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  assert.equal(decryptSecret(blob), "legacy");
});
