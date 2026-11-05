import type { GmailHeader } from "./gmailClient.js";
import { authResultProperty } from "./unsubscribe.js";

/**
 * Whether an email really came from the address on its `From:` line, as far as
 * the mailbox's own receiving server could tell.
 *
 * `From:` is free text, so anyone can write `no-reply@google.com`. What decides
 * here is the verdict the receiving server wrote, and only that server's: the
 * topmost `Authentication-Results` header, which it adds last, and whose
 * authserv-id must be the mailbox's own (`trustedAuthservId`). A sender can
 * include as many `Authentication-Results: mx.google.com; dmarc=pass` lines of
 * its own as it likes, lower down, and none of them is read.
 *
 * From there it asks for DMARC passing for the From domain, or a DKIM signature
 * that passed from that domain or a parent of it. Anything less fails closed, with
 * the reason, including a mailbox whose receiving server Genosyn can't identify,
 * which is every IMAP mailbox today. Trust here is what lets an email-started
 * session use the AI Employee's full tools, so "probably fine" reads as no.
 */

export type SenderVerdict = {
  verified: boolean;
  /** Which check passed, when one did. */
  how: "dmarc" | "dkim" | null;
  /** The address it verified, or the reason it didn't. */
  detail: string;
};

function header(headers: readonly GmailHeader[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((row) => row.name.toLowerCase() === lower).map((row) => row.value);
}

/** The one address on a `From:` line, or null when there isn't exactly one. */
function fromAddress(value: string): string | null {
  // Quoted display names and comments can hold anything, so they go first.
  const bare = value
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
  const angle = [...bare.matchAll(/<([^<>]+)>/g)];
  if (angle.length > 1) return null;
  const address = (angle.length === 1 ? angle[0][1] : bare).trim().toLowerCase();
  if (/[\s,;]/.test(address)) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? address : null;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).replace(/\.$/, "");
}

function cleanDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
}

/** Does this signing domain speak for this From domain: the same, or a parent of it. */
function aligned(signer: string, fromDomain: string): boolean {
  if (!signer || !signer.includes(".")) return false;
  return fromDomain === signer || fromDomain.endsWith(`.${signer}`);
}

/**
 * The receiving server's verdict on `fromEmail`, from a message's headers in the
 * order the message carries them. `authservId` names the one server whose verdict
 * counts; empty means there isn't one.
 */
export function verifySender(args: {
  headers: readonly GmailHeader[];
  authservId: string;
  fromEmail: string;
}): SenderVerdict {
  const refuse = (detail: string): SenderVerdict => ({ verified: false, how: null, detail });
  if (!args.authservId) {
    return refuse("This mailbox's receiving server can't be identified, so no sender verifies.");
  }
  const claimed = args.fromEmail.trim().toLowerCase();
  const fromLines = header(args.headers, "From");
  if (fromLines.length !== 1) return refuse("The email doesn't have exactly one From header.");
  const onTheLine = fromAddress(fromLines[0]);
  if (!onTheLine || onTheLine !== claimed) {
    return refuse("The From header doesn't name exactly the sender we recorded.");
  }

  // The topmost one: the last thing added, by the server that received it.
  const [topmost] = header(args.headers, "Authentication-Results");
  if (!topmost) return refuse("The receiving server left no verdict on this email.");
  const [authserv, ...segments] = topmost.split(";");
  if (authserv?.trim().toLowerCase() !== args.authservId) {
    return refuse("The newest verdict on this email isn't from this mailbox's receiving server.");
  }

  const fromDomain = domainOf(claimed);
  for (const segment of segments) {
    if (!/^\s*dmarc\s*=\s*pass\b/i.test(segment)) continue;
    if (cleanDomain(authResultProperty(segment, "header.from")) === fromDomain) {
      return { verified: true, how: "dmarc", detail: claimed };
    }
  }
  for (const segment of segments) {
    if (!/^\s*dkim\s*=\s*pass\b/i.test(segment)) continue;
    const identity = authResultProperty(segment, "header.i");
    const signer =
      cleanDomain(authResultProperty(segment, "header.d")) ||
      cleanDomain(identity.slice(identity.lastIndexOf("@") + 1));
    if (aligned(signer, fromDomain)) return { verified: true, how: "dkim", detail: claimed };
  }
  return refuse("Neither DMARC nor an aligned DKIM signature passed for this sender.");
}
