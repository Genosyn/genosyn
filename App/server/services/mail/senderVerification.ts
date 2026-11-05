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
 * session use the browser and Vault logins, so "probably fine" reads as no.
 *
 * It vouches for the domain, not the address. Anyone able to send authenticated
 * mail from a domain can write any address at it, so an owner's exact address is
 * only as strong as that domain's own controls.
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

/**
 * A verdict with what senders can write taken out, or null when it can't be read.
 *
 * Comments and quoted strings are where a server repeats a sender's own words: the
 * MAIL FROM it was given, say. `;` and `=` inside them mean nothing, so a sender's
 * `(;dmarc=pass header.from=google.com;)` must not read as a result (RFC 8601).
 */
function withoutSendersWords(value: string): string | null {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && (quoted || depth > 0)) {
      index += 1;
      continue;
    }
    if (quoted) {
      if (char === '"') {
        quoted = false;
        out += char;
      } else {
        // A domain or an address reads the same; nothing else needs to survive.
        out += /[a-z0-9.@_+-]/i.test(char) ? char : "_";
      }
      continue;
    }
    if (depth > 0) {
      // A quote here is a sender's MAIL FROM, repeated by the server. A `)` inside it
      // closes this comment read one way and not the other, and what follows it could
      // then read as a result. There's no safe reading, so there isn't one.
      if (char === '"') return null;
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      continue;
    }
    if (char === "(") depth = 1;
    else if (char === ")") return null;
    else {
      if (char === '"') quoted = true;
      out += char;
    }
  }
  return depth === 0 && !quoted ? out : null;
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

  // Fetched from another mailbox, so this server received it from that one, not
  // from whoever wrote it. Nothing here vouches for the sender.
  if (header(args.headers, "X-Gmail-Fetch-Info").length > 0) {
    return refuse("This email was fetched from another mailbox, so its sender can't be verified.");
  }

  // The topmost one: the last thing added, by the server that received it.
  const [topmost] = header(args.headers, "Authentication-Results");
  if (!topmost) return refuse("The receiving server left no verdict on this email.");
  const verdict = withoutSendersWords(topmost);
  if (verdict === null) return refuse("The verdict on this email can't be read.");
  const [authserv, ...segments] = verdict.split(";");
  if (authserv?.trim().toLowerCase() !== args.authservId) {
    return refuse("The newest verdict on this email isn't from this mailbox's receiving server.");
  }
  // Only mail with no return address has this, and what follows it is whatever the
  // sending server called itself, printed as it said it.
  if (segments.some((segment) => /(?:^|\s)smtp\.helo\s*=/i.test(segment))) {
    return refuse("This email has no return address to check its sender against.");
  }
  if (segments.some((segment) => /^\s*dmarc\s*=\s*(fail|permerror|temperror)\b/i.test(segment))) {
    return refuse("DMARC didn't pass for this sender.");
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
