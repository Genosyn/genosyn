import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * One address on one mirrored message's From, To or Cc line — the index that
 * answers "which mail involved this person, or anyone at this company?".
 *
 * `MailMessage` keeps its recipients as raw header strings, display names and
 * all, and a `LIKE` over them reads every row of a mailbox that can hold
 * hundreds of thousands of messages, on the event loop. These narrow rows are
 * looked up through an index instead. Bcc is left out, as it is when Revenue
 * links mail to Contacts, and so is the mailbox's own address, which is on
 * nearly every message and never anyone's counterparty.
 *
 * Keyed by (messageId, address) rather than a generated id: that is the row's
 * identity anyway, and every extra index on a table this size is another
 * random write per row.
 *
 * Written by the address indexer (`services/mail/addressIndex.ts`), which walks
 * each mailbox in arrival order. Rows of a message deleted on its own stay
 * behind until their mailbox is purged; readers load the matched messages by
 * id and skip any that are gone.
 */
@Entity("mail_message_addresses")
@Index(["companyId", "address"])
@Index(["companyId", "baseDomain"])
@Index(["accountId"])
export class MailMessageAddress {
  /** Local MailMessage id. */
  @PrimaryColumn({ type: "varchar" })
  messageId!: string;

  /** Lowercased, without a display name. */
  @PrimaryColumn({ type: "varchar" })
  address!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The mailbox (MailAccount) holding the message. */
  @Column({ type: "varchar" })
  accountId!: string;

  /**
   * The address's domain reduced to its registered name — `acme.com` for
   * `ops@eu.acme.com`, `acme.co.uk` for `ap@mail.acme.co.uk` — so everyone at
   * a company, subdomains included, is one equality lookup away. See
   * `baseDomainOf`.
   */
  @Column({ type: "varchar" })
  baseDomain!: string;
}
