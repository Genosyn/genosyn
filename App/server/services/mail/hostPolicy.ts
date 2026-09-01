import { config } from "../../../config.js";
import { assertPublicOutboundHost } from "../../lib/outboundUrl.js";

/**
 * Where a company's own mailbox connection is allowed to point.
 *
 * Defence in depth, not a hole being closed. `imap` is already in
 * `SHARED_SAAS_BLOCKED_PROVIDERS`, so a shared install refuses to *create* one
 * of these Connections at all — that is the primary control and it stays the
 * primary control.
 *
 * What was missing is the second half of the pattern this codebase uses
 * everywhere else: the invariant enforced at the operation rather than only at
 * the door. `memberBrowsersEnabled` re-derives its answer per call rather than
 * trusting a boot check; `assertRepositoryWorkAllowed` sits on the operation
 * because a session is a mutation reached by a second door. The mail engine
 * had no such seam, so a Connection row that predates the flag — an install
 * that flips `multiTenant` on, or a restore that carries one in — would still
 * be synced, and `imapflow` and `nodemailer` both open a raw TCP socket to a
 * host the tenant named. `installOutboundNetworkPolicy` patches the HTTP
 * agents and the undici dispatcher and never sees either of them.
 *
 * `routes/mail.ts` accepts the host as a free string and the port as any
 * integer from 1 to 65535, so once such a row exists there is nothing else
 * bounding where it dials.
 *
 * Multi-tenant only, for the same reason the transactional guard is: a
 * self-hosted install pointing at a mail server on its own LAN is ordinary and
 * correct, and that admin already owns the network. Shared SaaS boots with an
 * empty `outboundPrivateHostAllowlist`, which `validateRuntimeSecurity`
 * enforces, so there is no hosted way around it.
 */

/** 143 is STARTTLS submission, 993 implicit TLS. Nothing else is IMAP. */
export const ALLOWED_IMAP_PORTS = new Set([143, 993]);

/** Matches the transactional allowlist: submission, implicit TLS, relay, 2525. */
export const ALLOWED_MAIL_SMTP_PORTS = new Set([25, 465, 587, 2525]);

export type MailProtocol = "imap" | "smtp";

function allowedPortsFor(protocol: MailProtocol): Set<number> {
  return protocol === "imap" ? ALLOWED_IMAP_PORTS : ALLOWED_MAIL_SMTP_PORTS;
}

function portListFor(protocol: MailProtocol): string {
  return [...allowedPortsFor(protocol)].join(", ");
}

/**
 * Refuse a mailbox endpoint a hosted tenant must not be able to reach.
 *
 * Called at the operation — the moment a client is built or a message is sent
 * — as well as at the route, so a row that predates this check (or one written
 * by any other door) cannot be used to reach a private address either.
 */
export async function assertMailHostAllowed(
  protocol: MailProtocol,
  host: string,
  port: number,
): Promise<void> {
  if (!config.security.multiTenant) return;
  if (!host.trim()) return; // A provider-derived default; nothing tenant-supplied to check.
  if (!allowedPortsFor(protocol).has(port)) {
    throw new Error(
      `${protocol.toUpperCase()} port ${port} is not allowed. Use ${portListFor(protocol)}.`,
    );
  }
  await assertPublicOutboundHost(host);
}

/** Both halves of one mailbox connection, checked together. */
export async function assertMailConnectionAllowed(config_: {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}): Promise<void> {
  await assertMailHostAllowed("imap", config_.imapHost, config_.imapPort);
  await assertMailHostAllowed("smtp", config_.smtpHost, config_.smtpPort);
}
