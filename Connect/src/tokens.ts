import crypto from "node:crypto";
import { z } from "zod";
import type { Sealer } from "./secrets.js";

/**
 * Connect keeps no state. Everything a later step of a sign-in needs travels
 * with the sign-in itself: sealed into the request id the consent page
 * carries, then into the `state` the provider hands back. A browser can carry
 * these tokens but not read or change them, and a token sealed for one
 * provider or one step is not accepted for another.
 *
 * The credential at the end is the one thing that must reach the installation,
 * so it goes back through the browser encrypted to a key only the installation
 * holds: Connect learned that key when the installation's server started the
 * sign-in, and nothing else ever sees it unsealed.
 */

const base64url = (min: number, max: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`));

/** What `authorize` needs from `start`. */
export type RequestContext = {
  version: 2;
  expiresAt: number;
  browserChallenge: string;
  installationOrigin: string;
  returnUrl: string;
  /** The installation's own correlation value, echoed back untouched. */
  state: string;
  resultKey: string;
  /** Everything requested upstream, identity scopes first. */
  scopes: string[];
  /** The OAuth client the sign-in started under. */
  clientId: string;
};

/** What `callback` needs from `authorize`; it rides in the provider's `state`. */
export type CallbackContext = {
  version: 2;
  expiresAt: number;
  /** Digest of the nonce in the consenting browser's cookie. */
  nonceHash: string;
  /** This service's own PKCE verifier for the provider. */
  codeVerifier: string;
  clientId: string;
  returnUrl: string;
  state: string;
  resultKey: string;
};

const requestSchema = z
  .object({
    version: z.literal(2),
    expiresAt: z.number().int().positive(),
    browserChallenge: base64url(43, 43),
    installationOrigin: z.string().min(1).max(512),
    returnUrl: z.string().min(1).max(512),
    state: base64url(16, 128),
    resultKey: base64url(43, 43),
    scopes: z.array(z.string().min(1).max(256)).min(1).max(40),
    clientId: z.string().min(1).max(512),
  })
  .strict();

const callbackSchema = z
  .object({
    version: z.literal(2),
    expiresAt: z.number().int().positive(),
    nonceHash: base64url(43, 43),
    codeVerifier: base64url(43, 128),
    clientId: z.string().min(1).max(512),
    returnUrl: z.string().min(1).max(512),
    state: base64url(16, 128),
    resultKey: base64url(43, 43),
  })
  .strict();

/** A sealed token as it appears in a URL or form: `v1.<iv>.<ciphertext>`. */
export const SEALED_TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,6000}$/;

export type Tokens = ReturnType<typeof createTokens>;

export function createTokens(sealer: Sealer, providerId: string, now: () => number = Date.now) {
  const requestContext = `connect-request:v2:${providerId}`;
  const callbackContext = `connect-callback:v2:${providerId}`;

  function open<T extends { expiresAt: number }>(
    token: string,
    context: string,
    schema: z.ZodType<T>,
  ): T | null {
    const plaintext = sealer.open(token, context);
    if (plaintext === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(plaintext);
    } catch {
      return null;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.expiresAt <= now()) return null;
    return parsed.data;
  }

  return {
    sealRequest(value: Omit<RequestContext, "version">): string {
      return sealer.seal(JSON.stringify({ version: 2, ...value }), requestContext);
    },
    /** Null for anything expired, tampered with, sealed elsewhere, or for another provider. */
    openRequest(token: string): RequestContext | null {
      return open(token, requestContext, requestSchema);
    },
    sealCallback(value: Omit<CallbackContext, "version">): string {
      return sealer.seal(JSON.stringify({ version: 2, ...value }), callbackContext);
    },
    openCallback(token: string): CallbackContext | null {
      return open(token, callbackContext, callbackSchema);
    },
  };
}

/** True only for the canonical base64url encoding of exactly 32 bytes. */
export function isResultKey(value: string): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

function resultAad(providerId: string, state: string): Buffer {
  return Buffer.from(`genosyn-connect-result:v2:${providerId}:${state}`);
}

/**
 * AES-256-GCM under the installation's key, bound to the provider and the
 * installation's `state`, so a result cannot be replayed into another sign-in.
 * Format: `<iv>.<ciphertext and tag>`, both unpadded base64url.
 */
export function encryptResult(
  resultKey: string,
  providerId: string,
  state: string,
  plaintext: string,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(resultKey, "base64url"), iv);
  cipher.setAAD(resultAad(providerId, state));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${Buffer.concat([body, cipher.getAuthTag()]).toString("base64url")}`;
}

/** The installation's side of {@link encryptResult}; null for anything not sealed to it. */
export function decryptResult(
  resultKey: string,
  providerId: string,
  state: string,
  sealed: string,
): string | null {
  const [ivText, payloadText, extra] = sealed.split(".");
  if (!ivText || !payloadText || extra !== undefined || !isResultKey(resultKey)) return null;
  try {
    const iv = Buffer.from(ivText, "base64url");
    const payload = Buffer.from(payloadText, "base64url");
    if (iv.length !== 12 || payload.length < 17) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(resultKey, "base64url"),
      iv,
    );
    decipher.setAAD(resultAad(providerId, state));
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    return Buffer.concat([
      decipher.update(payload.subarray(0, payload.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
