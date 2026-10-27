import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { CustomerChannelReplyMode } from "../../../shared/customerChannels.js";

/**
 * A **Customer channel** — one channel on an external chat surface, linked to
 * one {@link Customer}, where an AI Employee keeps notes and may answer.
 *
 * Today that is a Slack channel the company's Slack app was invited to, and
 * most often a Slack Connect channel shared with the customer's own workspace.
 * Linking one changes three things about that channel, and only that channel:
 *
 *  - **Every message is kept**, not just the ones that @-mention the app, as
 *    {@link CustomerChannelMessage} rows.
 *  - **The employee writes notes** about what was said onto the Customer's
 *    timeline (a `note` Activity) and files the commitments it heard as
 *    Follow-ups — from a restricted turn whose one tool submits them, so the
 *    words people typed in the channel never drive a company tool.
 *  - **Every reply is written for the customer.** The people reading a
 *    customer channel include people outside the company, so a reply there is
 *    composed from {@link instructions} — what a Member wrote for this channel —
 *    and never from the employee's Soul, Memory, Skills or company tools,
 *    whoever asked. That holds for a linked Member too: their authority is for
 *    a direct message, not for a room the customer can read.
 *
 * The row belongs to the company. `employeeId` is an assignment like a Phone
 * number's, and is cleared when the employee is deleted; until an admin picks
 * another, messages are still kept and nothing is written or posted.
 */
@Entity("customer_channels")
@Index(["companyId"])
@Index(["customerId"])
@Index(["employeeId"])
@Index(["connectionId", "externalChannelId"], { unique: true })
export class CustomerChannel {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Provider id of the Connection — `"slack"` today. */
  @Column({ type: "varchar" })
  provider!: string;

  @Column({ type: "varchar" })
  connectionId!: string;

  /** The platform's id for the channel (Slack `C…` / `G…`). */
  @Column({ type: "varchar" })
  externalChannelId!: string;

  /** The channel's name when it was last read from the platform, without `#`. */
  @Column({ type: "varchar", default: "" })
  name!: string;

  /** True for a channel shared with another organization (Slack Connect). */
  @Column({ type: "boolean", default: false })
  shared!: boolean;

  @Column({ type: "varchar" })
  customerId!: string;

  /** Who works the channel. Null once that employee is deleted. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: "varchar", default: "mentions" })
  replyMode!: CustomerChannelReplyMode;

  /**
   * Everything the AI Employee may say to the people in this channel. Written
   * by a Member; empty means the cautious default in `customerChannels/replies.ts`.
   */
  @Column({ type: "text", default: "" })
  instructions!: string;

  /** When the newest message in the channel arrived. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastMessageAt!: Date | null;

  /** When notes were last written onto the Customer's timeline. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastNotedAt!: Date | null;

  /** When the employee last tried to write notes, whether or not it worked. */
  @Column({ type: dateTimeColumnType, nullable: true })
  notesAttemptedAt!: Date | null;

  /** Why the last attempt wrote nothing, in words an admin can act on. */
  @Column({ type: "varchar", default: "" })
  notesError!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
