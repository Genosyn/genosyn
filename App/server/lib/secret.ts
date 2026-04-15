import crypto from "node:crypto";
import { config } from "../../config.js";

/**
 * Symmetric secret encryption for at-rest storage of API keys (and anything
 * else sensitive we stash in configJson blobs).
 *
 * Key is derived from `config.sessionSecret` via SHA-256. This is a pragmatic
 * MVP choice for a self-hostable app — the same secret that protects cookies
 * also protects stored API keys. Users who rotate `sessionSecret` will
 * invalidate stored keys and need to reconnect models. A dedicated KMS is
 * post-V1 (see ROADMAP "Secrets vault").
 */
function key(): Buffer {
  return crypto.createHash("sha256").update(config.sessionSecret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv | tag | ciphertext, base64
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/** Mask for display: `sk-...abc123` → `sk-…c123`. */
export function maskSecret(s: string): string {
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}
