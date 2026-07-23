import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Why an address is on the list. All of them block equally; the distinction is
 * for the human reading the audit trail, and for deciding what can be undone.
 *
 * - `unsubscribe` — they asked. Only a human may remove this, and the UI warns.
 * - `bounce`      — the address is dead. Mailing it again costs sender reputation.
 * - `complaint`   — marked as spam. The most expensive signal there is.
 * - `manual`      — somebody added it deliberately.
 * - `imported`    — carried in from another system's opt-out list.
 */
export type SuppressionReason =
  | "unsubscribe"
  | "bounce"
  | "complaint"
  | "manual"
  | "imported";

export const SUPPRESSION_REASONS: SuppressionReason[] = [
  "unsubscribe",
  "bounce",
  "complaint",
  "manual",
  "imported",
];

/**
 * An address this company must not email. See ROADMAP.md M32.
 *
 * Checked at the single outbound choke-point in `services/mail/actions.ts`, so
 * it covers every path equally: a human pressing Send, a bulk send from the
 * draft review queue, a Sequence step, and an AI employee calling `send_mail`.
 * There is deliberately no way to send that bypasses it.
 *
 * Scoped per company rather than per mail account. A person who unsubscribes
 * from one of your mailboxes has not consented to hear from another one, and
 * the reputational damage of getting that wrong lands on the whole domain.
 *
 * `email` is stored already normalized by `lib/emailAddress.ts` — lowercased,
 * display name stripped, and explicitly **not** canonicalized for Gmail dots or
 * plus-tags. Over-matching here silently drops mail the user never asked us to
 * drop, and they have no way to discover why.
 *
 * Rows are effectively permanent. Removing one is a deliberate human act with a
 * confirmation, because the cheapest way to get a sending domain blocklisted is
 * to mail somebody who already said no.
 */
@Entity("suppressions")
@Index(["companyId", "email"], { unique: true })
@Index(["companyId", "reason"])
export class Suppression {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Normalized lowercase address. Unique per company. */
  @Column({ type: "varchar" })
  email!: string;

  @Column({ type: "varchar", default: "manual" })
  reason!: SuppressionReason;

  /**
   * Where it came from — `sequence:<slug>`, `unsubscribe-link`, `mail-sync`,
   * `import:<filename>`. Free text; this is an audit aid, not a discriminator.
   */
  @Column({ type: "varchar", default: "" })
  source!: string;

  /** The Contact at the time, when we knew one. Not a live join — they may be deleted. */
  @Column({ type: "varchar", nullable: true })
  contactId!: string | null;

  @Column({ type: "text", default: "" })
  notes!: string;

  /** Null when the recipient did it themselves through an unsubscribe link. */
  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
