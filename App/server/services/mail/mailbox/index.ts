import type { MailAccount } from "../../../db/entities/MailAccount.js";
import type { IntegrationConnection } from "../../../db/entities/IntegrationConnection.js";
import { decryptConnectionConfig, getConnection } from "../../integrations.js";
import { parseImapConnectionConfig, type ImapConnectionConfig } from "../imapClient.js";
import { GmailMailbox } from "./gmail.js";
import { ImapMailbox } from "./imap.js";
import type { Mailbox } from "./types.js";

/**
 * Resolve the backend for one mailbox.
 *
 * This is the seam every caller in the Email section goes through, and it is
 * the only place that knows which providers exist. `actions.ts`, the drafts
 * queue, the attachment reader and the unsubscribe path all take a
 * {@link Mailbox} and never ask what is behind it.
 */

/** The Connection behind a mailbox, with a message worth reading when it is gone. */
export async function connectionForAccount(account: MailAccount): Promise<IntegrationConnection> {
  const conn = await getConnection(account.companyId, account.connectionId);
  if (!conn) {
    throw new Error(
      "The connection behind this mailbox was deleted. Remove the mailbox and connect it again.",
    );
  }
  return conn;
}

/** The stored IMAP/SMTP credentials for an `imap` mailbox. */
export async function imapConfigForAccount(account: MailAccount): Promise<ImapConnectionConfig> {
  const conn = await connectionForAccount(account);
  if (conn.provider !== "imap") {
    throw new Error("This mailbox is not an IMAP mailbox.");
  }
  return parseImapConnectionConfig(decryptConnectionConfig(conn) as Record<string, unknown>);
}

/**
 * The mailbox for an account.
 *
 * Built per call rather than cached: an adapter holds credentials, and a
 * long-lived one could outlive a reconnect and keep using the credentials the
 * company has already replaced. The expensive part — the IMAP socket — is
 * pooled separately in `imapClient.ts`, keyed by account, so building a fresh
 * adapter costs a decrypt and nothing else.
 */
export async function mailboxForAccount(account: MailAccount): Promise<Mailbox> {
  if (account.provider === "imap") {
    return new ImapMailbox(account, await imapConfigForAccount(account));
  }
  return new GmailMailbox(account);
}

export { GmailMailbox } from "./gmail.js";
export { ImapMailbox } from "./imap.js";
export * from "./types.js";
