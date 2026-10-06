import crypto from "node:crypto";

/** SHA-256 as unpadded base64url — the PKCE S256 transform. */
export function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

/** Constant-time comparison that also tolerates unequal lengths. */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 32 random bytes encode to exactly 43 base64url characters. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export type Sealer = {
  /** Encrypt and authenticate `plaintext`, bound to `context`. */
  seal(plaintext: string, context: string): string;
  /** Null for anything tampered with, sealed under another key, or another context. */
  open(sealed: string, context: string): string | null;
};

const VERSION = "v1";

/**
 * AES-256-GCM under a key derived from the operator's secret.
 *
 * `context` is authenticated but not stored, so a token sealed for one step or
 * one provider cannot be presented as another.
 */
export function createSealer(secret: string): Sealer {
  const key = Buffer.from(
    crypto.hkdfSync("sha256", secret, "genosyn-connect", "sealed-context", 32),
  );
  return {
    seal(plaintext, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString("base64url"),
        Buffer.concat([body, tag]).toString("base64url"),
      ].join(".");
    },
    open(sealed, context) {
      const [version, ivText, payloadText, extra] = sealed.split(".");
      if (version !== VERSION || !ivText || !payloadText || extra !== undefined) return null;
      try {
        const iv = Buffer.from(ivText, "base64url");
        const payload = Buffer.from(payloadText, "base64url");
        if (iv.length !== 12 || payload.length < 16) return null;
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(payload.subarray(payload.length - 16));
        return Buffer.concat([
          decipher.update(payload.subarray(0, payload.length - 16)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
