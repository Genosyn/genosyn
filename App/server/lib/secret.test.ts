import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { config } from "../../config.js";
import { decryptSecret, encryptSecret } from "./secret.js";

test("round-trips scoped authenticated ciphertext", () => {
  const encrypted = encryptSecret("tenant credential", "company:alpha");
  assert.match(encrypted, /^v2\./);
  assert.equal(decryptSecret(encrypted), "tenant credential");
  assert.throws(() => decryptSecret(`${encrypted.slice(0, -1)}A`));
});

test("reads legacy session-secret ciphertexts during rotation", () => {
  const key = crypto.createHash("sha256").update(config.sessionSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
  const blob = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  assert.equal(decryptSecret(blob), "legacy");
});
