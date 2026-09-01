import type { MailAccount } from "../../db/entities/MailAccount.js";
import type { MailMessage } from "../../db/entities/MailMessage.js";
import {
  privateHostAllowed,
  safeFetchBuffer,
  type SafeFetchResult,
} from "../../lib/outboundUrl.js";
import { headerValue, type GmailHeader } from "./gmailClient.js";
import { mailboxForAccount } from "./mailbox/index.js";
import type { Mailbox } from "./mailbox/types.js";

export const ONE_CLICK_UNSUBSCRIBE_BODY = "List-Unsubscribe=One-Click";
const MAX_UNSUBSCRIBE_URL_CHARS = 4_096;
const MAX_UNSUBSCRIBE_RESPONSE_BYTES = 64 * 1_024;
const UNSUBSCRIBE_TIMEOUT_MS = 15_000;

export type MailUnsubscribeResult = {
  /** Safe for audits: no path or query token from the sender is retained. */
  host: string;
  status: number;
};

export type MailUnsubscribeDependencies = {
  mailbox?: (account: MailAccount) => Promise<Mailbox>;
  post?: (url: URL, init: RequestInit) => Promise<SafeFetchResult>;
};

/**
 * Whose `Authentication-Results` verdict this mailbox is allowed to believe.
 *
 * RFC 8058 requires a valid DKIM signature covering both one-click headers.
 * Genosyn does not verify DKIM itself — it binds the *receiving* server's
 * already-computed verdict back to the exact signature. That only works if we
 * know which `authserv-id` belongs to the receiving server, because an
 * `Authentication-Results` header written by anyone else is sender-supplied
 * text an attacker controls.
 *
 * For a Gmail mailbox that is `mx.google.com`, always. For an IMAP mailbox it
 * is whatever the company's own MX calls itself, which Genosyn has no way to
 * learn — so the answer is "nobody", one-click unsubscribe is unavailable
 * there, and {@link resolveOneClickUnsubscribe} says so. Failing closed is the
 * only safe direction: the alternative is trusting a `dkim=pass` line the
 * sender wrote about themselves.
 */
export function trustedAuthservId(account: MailAccount): string {
  return account.provider === "gmail" ? "mx.google.com" : "";
}

/**
 * Perform the standardized RFC 8058 one-click action advertised by the exact
 * message that triggered the rule.
 *
 * This intentionally does not visit footer/body links, execute HTML, issue a
 * speculative GET, or send a `mailto:` message. Those fallbacks can confirm a
 * live address to a spammer or turn hostile email content into navigation.
 */
export async function unsubscribeFromMessage(
  account: MailAccount,
  message: MailMessage,
  dependencies: MailUnsubscribeDependencies = {},
): Promise<MailUnsubscribeResult> {
  const target = await resolveOneClickUnsubscribe(account, message, dependencies);

  const init: RequestInit = {
    method: "POST",
    headers: {
      accept: "text/plain, text/html;q=0.5, */*;q=0.1",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Genosyn mail rules",
    },
    body: ONE_CLICK_UNSUBSCRIBE_BODY,
  };
  const response = await (dependencies.post ?? postOneClick)(target, init);
  if (!response.ok) {
    throw new Error(`The one-click unsubscribe endpoint returned HTTP ${response.status}.`);
  }
  return { host: new URL(response.url || target.toString()).hostname, status: response.status };
}

/**
 * Everything that has to hold before Genosyn will speak to an unsubscribe
 * endpoint, with the URL as the reward. Split out of
 * {@link unsubscribeFromMessage} so a caller that only wants to know whether
 * the button is *offerable* runs the identical checks rather than a looser
 * copy of them — see {@link oneClickUnsubscribeAvailable}.
 */
async function resolveOneClickUnsubscribe(
  account: MailAccount,
  message: MailMessage,
  dependencies: MailUnsubscribeDependencies = {},
): Promise<URL> {
  if (message.accountId !== account.id) {
    throw new Error("The unsubscribe message does not belong to this mailbox.");
  }
  if (/\b(?:SPAM|TRASH)\b/.test(message.labelIds ?? "")) {
    throw new Error(
      "Genosyn will not unsubscribe from mail the mail server marked as spam or trash.",
    );
  }
  const authservId = trustedAuthservId(account);
  if (!authservId) {
    throw new Error(
      "One-click unsubscribe needs a receiving server whose DKIM verdict Genosyn can trust, which it only has for Gmail mailboxes.",
    );
  }
  const mailbox = await (dependencies.mailbox ?? mailboxForAccount)(account);
  const headers = await mailbox.getMessageHeaders(message.gmailMessageId);
  const target = oneClickUnsubscribeUrl(
    headerValue(headers, "List-Unsubscribe"),
    headerValue(headers, "List-Unsubscribe-Post"),
  );
  if (!target) {
    throw new Error("This email does not provide a safe HTTPS one-click unsubscribe method.");
  }
  // The operator allowlist exists for explicitly configured Integrations and
  // local model endpoints. An email sender must never inherit that exception
  // to the public-network policy. Rejecting the hostname here also means the
  // socket-time DNS policy will not waive a later rebinding answer for it.
  if (privateHostAllowed(target.hostname)) {
    throw new Error("One-click unsubscribe endpoints must use the public network.");
  }
  if (!hasAuthenticatedOneClickHeaders(headers, authservId)) {
    throw new Error(
      "This email does not provide a DKIM-authenticated one-click unsubscribe method.",
    );
  }
  return target;
}

/**
 * Can this exact message be unsubscribed from safely?
 *
 * AI analysis asks this before it is allowed to offer an Unsubscribe button,
 * so the affordance is decided by the same checks the click will run — never
 * by the model's reading of the email, which is the attacker's text. Any
 * failure, including a mail server outage, answers no: a button that errors
 * when pressed is worse than no button.
 */
export async function oneClickUnsubscribeAvailable(
  account: MailAccount,
  message: MailMessage,
  dependencies: MailUnsubscribeDependencies = {},
): Promise<{ available: boolean; host: string }> {
  try {
    const target = await resolveOneClickUnsubscribe(account, message, dependencies);
    return { available: true, host: target.hostname };
  } catch {
    return { available: false, host: "" };
  }
}

type TrustedDkimResult = {
  domain: string;
  selector: string;
  signaturePrefix: string;
};

/**
 * RFC 8058 requires one valid DKIM signature whose `h=` tag covers both
 * one-click headers. The receiving server has already performed the
 * cryptographic check, so bind its trusted Authentication-Results verdict back
 * to the exact DKIM-Signature using domain, selector, and the reported
 * `header.b` prefix. `authservId` names the only server whose verdict counts —
 * see {@link trustedAuthservId}.
 */
export function hasAuthenticatedOneClickHeaders(
  headers: GmailHeader[] | undefined,
  authservId: string,
): boolean {
  const listHeaders = headerValues(headers, "List-Unsubscribe");
  const postHeaders = headerValues(headers, "List-Unsubscribe-Post");
  if (listHeaders.length !== 1 || postHeaders.length !== 1) return false;

  if (!authservId) return false;
  const passingResults = headerValues(headers, "Authentication-Results").flatMap((value) =>
    trustedDkimResults(value, authservId),
  );
  if (passingResults.length === 0) return false;

  const signatures = headerValues(headers, "DKIM-Signature")
    .map(dkimSignatureTags)
    .filter((signature) => signature !== null);
  return passingResults.some((result) => {
    const matching = signatures.filter(
      (signature) =>
        result.domain === signature.domain &&
        result.selector === signature.selector &&
        signature.signatureData.startsWith(result.signaturePrefix),
    );
    // Authentication-Results identifies a signature only by its tuple and a
    // b= prefix. If two raw signatures share that identity, an invalid one
    // could falsely claim the one-click headers in h=. Ambiguity must fail
    // closed instead of borrowing the pass verdict from the other header.
    if (matching.length !== 1) return false;
    const [signature] = matching;
    return (
      signature.headers.includes("list-unsubscribe") &&
      signature.headers.includes("list-unsubscribe-post")
    );
  });
}

function headerValues(headers: GmailHeader[] | undefined, name: string): string[] {
  const lower = name.toLowerCase();
  return (headers ?? [])
    .filter((header) => header.name.toLowerCase() === lower)
    .map((header) => header.value);
}

function trustedDkimResults(value: string, trusted: string): TrustedDkimResult[] {
  const [authservId, ...segments] = value.split(";");
  // Only the receiving border MTA's verdict is trusted; sender-supplied
  // Authentication-Results fields are attacker-controlled text.
  if (authservId?.trim().toLowerCase() !== trusted) return [];

  const results: TrustedDkimResult[] = [];
  for (const segment of segments) {
    if (!/^\s*dkim\s*=\s*pass\b/i.test(segment)) continue;
    const identity = authResultProperty(segment, "header.i");
    const domain = authResultProperty(segment, "header.d") || identityDomain(identity);
    const selector = authResultProperty(segment, "header.s");
    const signaturePrefix = authResultProperty(segment, "header.b");
    if (!domain || !selector || signaturePrefix.length < 6) continue;
    results.push({
      domain: domain.toLowerCase().replace(/\.$/, ""),
      selector: selector.toLowerCase(),
      signaturePrefix,
    });
  }
  return results;
}

function authResultProperty(segment: string, property: string): string {
  const escaped = property.replace(".", "\\.");
  const match = segment.match(
    new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]+)"|([^\\s;()]+))`, "i"),
  );
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function identityDomain(identity: string): string {
  const at = identity.lastIndexOf("@");
  return (at >= 0 ? identity.slice(at + 1) : identity).trim();
}

function dkimSignatureTags(value: string): {
  domain: string;
  selector: string;
  signatureData: string;
  headers: string[];
} | null {
  const tags = new Map<string, string>();
  for (const part of value.split(";")) {
    const equals = part.indexOf("=");
    if (equals <= 0) continue;
    tags.set(part.slice(0, equals).trim().toLowerCase(), part.slice(equals + 1).trim());
  }
  const domain = (tags.get("d") ?? "").toLowerCase().replace(/\.$/, "");
  const selector = (tags.get("s") ?? "").toLowerCase();
  const signatureData = (tags.get("b") ?? "").replace(/\s+/g, "");
  const signedHeaders = (tags.get("h") ?? "")
    .split(":")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (!domain || !selector || !signatureData) return null;
  return { domain, selector, signatureData, headers: signedHeaders };
}

/** Extract URI targets without treating commas inside angle-bracket URIs as separators. */
export function listUnsubscribeTargets(header: string): string[] {
  const targets: string[] = [];
  const bracketed = header.matchAll(/<([^<>]+)>/g);
  for (const match of bracketed) {
    const value = match[1]?.trim();
    if (value) targets.push(value);
  }
  if (targets.length > 0) return targets;
  return header
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Return the first advertised HTTPS target only when RFC 8058 one-click is explicit. */
export function oneClickUnsubscribeUrl(
  listUnsubscribe: string,
  listUnsubscribePost: string,
): URL | null {
  if (!/^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i.test(listUnsubscribePost)) {
    return null;
  }
  const bracketed = Array.from(listUnsubscribe.matchAll(/<([^<>]+)>/g));
  const residue = listUnsubscribe.replace(/<[^<>]+>/g, "").replace(/[\s,]/g, "");
  if (bracketed.length === 0 || residue) return null;

  const webTargets: URL[] = [];
  for (const match of bracketed) {
    const raw = match[1]?.trim() ?? "";
    if (!raw || raw.length > MAX_UNSUBSCRIBE_URL_CHARS) return null;
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") webTargets.push(url);
    } catch {
      return null;
    }
  }
  if (webTargets.length !== 1) return null;
  const [target] = webTargets;
  if (target.protocol !== "https:" || target.username || target.password) return null;
  return target;
}

async function postOneClick(url: URL, init: RequestInit): Promise<SafeFetchResult> {
  return safeFetchBuffer(url, init, {
    maxBytes: MAX_UNSUBSCRIBE_RESPONSE_BYTES,
    timeoutMs: UNSUBSCRIBE_TIMEOUT_MS,
    allowedProtocols: ["https:"],
    maxRedirects: 0,
  });
}
