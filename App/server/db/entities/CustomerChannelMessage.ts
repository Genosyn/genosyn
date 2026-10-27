import { dateTimeColumnType } from "./columnTypes.js";
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Who wrote a message in a customer channel, as far as the platform can say.
 *
 *  - `customer` — someone outside the company's own workspace (a Slack
 *    Connect member of the customer's organization).
 *  - `team` — someone in the company's own workspace.
 *  - `employee` — the AI Employee's own reply, recorded as it was sent.
 */
export type CustomerChannelAuthorKind = "customer" | "team" | "employee";

/**
 * One message in a {@link CustomerChannel}, kept so the AI Employee can write
 * notes about it and read the thread it is answering in.
 *
 * Kept as it arrives rather than fetched back from the platform later: Slack
 * pages channel history slowly and, for most apps, a few messages a minute at
 * most, so a busy shared channel could never be caught up on. The copy is
 * working material, not the record — the Customer's timeline is — so rows
 * already written into notes are pruned after a while.
 *
 * Everything in `text` was typed by somebody in the channel, the customer
 * included, and is only ever shown to a model as quoted material.
 */
@Entity("customer_channel_messages")
@Index(["companyId"])
@Index(["customerChannelId", "postedAt"])
@Index(["customerChannelId", "notedAt"])
@Index(["customerChannelId", "threadKey"])
@Index(["customerChannelId", "externalMessageId"], {
  unique: true,
  where: '"externalMessageId" IS NOT NULL',
})
export class CustomerChannelMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  customerChannelId!: string;

  /**
   * The platform's id for the message (`<channel>:<ts>` on Slack). Also the
   * idempotency key: Slack sends a mention as two events, and redelivers what
   * it thinks was missed.
   */
  @Column({ type: "varchar", nullable: true })
  externalMessageId!: string | null;

  /** The thread the message belongs to — its own id for a top-level message. */
  @Column({ type: "varchar", default: "" })
  threadKey!: string;

  @Column({ type: "varchar" })
  authorKind!: CustomerChannelAuthorKind;

  /** The platform's user id, or the AI Employee's id for its own replies. */
  @Column({ type: "varchar", default: "" })
  authorExternalId!: string;

  /** Best-effort display name. Never used for authorization. */
  @Column({ type: "varchar", default: "" })
  authorLabel!: string;

  @Column({ type: dateTimeColumnType })
  postedAt!: Date;

  /** When the message went into notes on the Customer's timeline. */
  @Column({ type: dateTimeColumnType, nullable: true })
  notedAt!: Date | null;

  /**
   * When an answer to this message was claimed. Set once, by a conditional
   * update, so a mention Slack delivers twice is still answered once.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  replyClaimedAt!: Date | null;

  /** After every column a query filters on, so SQLite never reads past it — AGENTS.md §7. */
  @Column({ type: "text", default: "" })
  text!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
