import crypto from "node:crypto";
import { config } from "../../config.js";

const VERSION = "v2";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Derive an independent data-encryption key for a company, user, or the
 * instance. The scope is authenticated and stored alongside the ciphertext;
 * callers never need to persist a second lookup field just to decrypt it.
 */
function scopedKey(master: string, scope: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(master, "utf8"),
      Buffer.from("genosyn-secret-v2", "utf8"),
      Buffer.from(scope, "utf8"),
      KEY_BYTES,
    ),
  );
}

function legacyKey(): Buffer {
  return crypto.createHash("sha256").update(config.sessionSecret).digest();
}

export function encryptSecret(plaintext: string, scope = "instance"): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    scopedKey(config.security.encryptionSecret, scope),
    iv,
  );
  cipher.setAAD(Buffer.from(`${VERSION}:${scope}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    Buffer.from(scope, "utf8").toString("base64url"),
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptV2(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("Unsupported encrypted-secret format");
  }
  const scope = Buffer.from(parts[1], "base64url").toString("utf8");
  if (!scope || scope.length > 256) throw new Error("Invalid encrypted-secret scope");
  const iv = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  const encrypted = Buffer.from(parts[4], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Invalid encrypted-secret payload");
  }

  const masters = [config.security.encryptionSecret, ...config.security.previousEncryptionSecrets];
  for (const master of masters) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", scopedKey(master, scope), iv);
      decipher.setAAD(Buffer.from(`${VERSION}:${scope}`, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
      // Try the next rotation key.
    }
  }
  throw new Error("Encrypted secret could not be decrypted with the configured key ring");
}

/** Read both scoped v2 ciphertexts and legacy sessionSecret-derived rows. */
export function decryptSecret(blob: string): string {
  if (blob.startsWith(`${VERSION}.`)) return decryptV2(blob);
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("Invalid encrypted-secret payload");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", legacyKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** Mask for display: `sk-...abc123` → `sk-…c123`. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}
