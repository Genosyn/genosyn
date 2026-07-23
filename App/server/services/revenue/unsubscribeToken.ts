import crypto from "node:crypto";

import { normalizeEmail } from "../../lib/emailAddress.js";

/**
 * Signed unsubscribe links.
 *
 * An unsubscribe URL is reached by a recipient who is not signed in, from a
 * mail client that may fetch it years after the message was sent. That shapes
 * every decision here:
 *
 * - **No expiry.** An unsubscribe link that stops working is a compliance
 *   failure and, practically, a spam complaint. Tokens are valid forever.
 * - **Self-describing.** The address rides *inside* the token, so the endpoint
 *   can suppress the right mailbox even if the Contact row was since deleted.
 * - **Signed, not encrypted.** There is nothing secret in it — the recipient
 *   already knows their own address. We only need to stop a stranger
 *   unsubscribing somebody else, which a MAC does.
 * - **Constant-time comparison**, so the signature cannot be brute-forced a
 *   byte at a time.
 *
 * The secret is passed in rather than read from config, so the logic is
 * testable without booting the app; {@link unsubscribeSecret} is the wrapper
 * that supplies the real one.
 */

/** Bumping this invalidates every old link, so treat it as a breaking change. */
const TOKEN_VERSION = "u1";

export type UnsubscribePayload = {
  /** Company that sent the mail — scopes the suppression we write. */
  companyId: string;
  /** Contact the mail was addressed to, when we knew one. */
  contactId: string | null;
  /** The address to suppress. Normalized at sign time. */
  email: string;
};

type WirePayload = { c: string; k: string | null; e: string };

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadPart: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payloadPart).digest("base64url");
}

/**
 * Derive the signing key from the instance encryption secret rather than using
 * it directly, so a leaked unsubscribe token can never be replayed against
 * another subsystem that shares the same secret.
 */
export function deriveUnsubscribeSecret(encryptionSecret: string): string {
  return crypto
    .createHmac("sha256", encryptionSecret)
    .update("genosyn:unsubscribe:v1")
    .digest("hex");
}

/**
 * Build the opaque token that rides in an unsubscribe URL.
 *
 * Throws on an unusable address: a link we cannot resolve back to a mailbox is
 * worse than no link, because the recipient clicks it and nothing happens.
 */
export function signUnsubscribeToken(
  payload: UnsubscribePayload,
  secret: string,
): string {
  const email = normalizeEmail(payload.email);
  if (!email) throw new Error("signUnsubscribeToken: unusable email address");
  if (!payload.companyId) throw new Error("signUnsubscribeToken: companyId required");
  if (!secret) throw new Error("signUnsubscribeToken: secret required");

  const wire: WirePayload = {
    c: payload.companyId,
    k: payload.contactId || null,
    e: email,
  };
  // Sign the encoded string, not the object, so verification never depends on
  // JSON key ordering surviving a round-trip.
  const part = b64url(JSON.stringify(wire));
  return `${TOKEN_VERSION}.${part}.${sign(part, secret)}`;
}

/**
 * Verify and decode. Returns null for every failure mode — wrong version,
 * tampered payload, tampered signature, malformed JSON, missing fields.
 * Callers must not distinguish between them to the recipient.
 */
export function verifyUnsubscribeToken(
  token: string | null | undefined,
  secret: string,
): UnsubscribePayload | null {
  if (typeof token !== "string" || !token || !secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, payloadPart, signature] = parts;
  if (version !== TOKEN_VERSION) return null;
  if (!payloadPart || !signature) return null;

  const expected = sign(payloadPart, secret);
  // Both sides are hex/base64url of a fixed length, but compare through the
  // digest helper anyway so a length mismatch cannot throw.
  if (!constantTimeEqual(signature, expected)) return null;

  let wire: WirePayload;
  try {
    wire = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!wire || typeof wire !== "object") return null;
  if (typeof wire.c !== "string" || !wire.c) return null;
  if (typeof wire.e !== "string") return null;
  const email = normalizeEmail(wire.e);
  if (!email) return null;
  const contactId = typeof wire.k === "string" && wire.k ? wire.k : null;

  return { companyId: wire.c, contactId, email };
}

/** Local copy so this module has no dependency beyond node crypto. */
function constantTimeEqual(actual: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(actual).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * The RFC 8058 header pair that makes Gmail and Outlook render a native
 * "Unsubscribe" button next to the sender name.
 *
 * `List-Unsubscribe-Post` is what upgrades it to *one-click*: the mail client
 * POSTs the URL itself and never opens a browser. That endpoint must therefore
 * accept an unauthenticated POST and must not require JavaScript — see
 * `routes/unsubscribe.ts`.
 *
 * The mailto fallback matters for older clients, and Gmail's bulk-sender rules
 * expect at least one of the two to be present on marketing mail.
 */
export function listUnsubscribeHeaders(
  url: string,
  mailto?: string | null,
): Record<string, string> {
  const targets = [`<${url}>`];
  const address = normalizeEmail(mailto);
  if (address) targets.push(`<mailto:${address}?subject=unsubscribe>`);
  return {
    "List-Unsubscribe": targets.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** The browser-facing URL a recipient clicks. */
export function unsubscribeUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/u/${token}`;
}
