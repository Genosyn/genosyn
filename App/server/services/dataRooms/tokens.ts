import crypto from "node:crypto";

import type { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import { decryptSecret, encryptSecret } from "../../lib/secret.js";
import { getPublicUrl } from "../publicUrl.js";

/**
 * A guest's private link. The token in it is 256 random bits and the only
 * credential a guest holds: only its hash finds the guest, and an encrypted
 * copy (scoped to the company) lets an owner or admin copy the link again.
 */

const TOKEN_BYTES = 32;
export const GUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateGuestToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashGuestToken(token: string): string {
  if (!token || token.length > 512) return "";
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function guestTokenColumns(
  companyId: string,
  token: string,
): { tokenHash: string; tokenEncrypted: string } {
  return {
    tokenHash: hashGuestToken(token),
    tokenEncrypted: encryptSecret(token, `company:${companyId}`),
  };
}

/** The guest's token, or null when it cannot be read back or no longer matches. */
export function guestToken(
  guest: Pick<DataRoomGuest, "tokenEncrypted" | "tokenHash">,
): string | null {
  try {
    const token = decryptSecret(guest.tokenEncrypted);
    return hashGuestToken(token) === guest.tokenHash ? token : null;
  } catch {
    return null;
  }
}

export function guestLinkForToken(token: string): string {
  return `${getPublicUrl()}/room/${encodeURIComponent(token)}`;
}

export function guestLink(
  guest: Pick<DataRoomGuest, "tokenEncrypted" | "tokenHash">,
): string | null {
  const token = guestToken(guest);
  return token ? guestLinkForToken(token) : null;
}
