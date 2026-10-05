import { dateTimeColumnType } from "./columnTypes.js";
import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

/**
 * How far the address indexer (`services/mail/addressIndex.ts`) has read one
 * mailbox. Kept off `MailAccount` because whole-row saves of that entity would
 * write a stale cursor back over a newer one.
 */
@Entity("mail_address_index_states")
@Index(["companyId"])
export class MailAddressIndexState {
  /** The MailAccount this cursor belongs to. */
  @PrimaryColumn({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /**
   * The last indexed message's `createdAt`, exactly as the database returns it
   * as text. SQLite holds both second- and millisecond-precision values in that
   * column, so a value round-tripped through a JS `Date` would no longer equal
   * the stored one.
   */
  @Column({ type: "varchar", default: "" })
  cursorAt!: string;

  /** The last indexed message's id — the tiebreak within one `createdAt`. */
  @Column({ type: "varchar", default: "" })
  cursorId!: string;

  /** When the indexer first reached the end of the mailbox; null while it is
   * still reading mail mirrored before it existed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  caughtUpAt!: Date | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
