import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type PhoneMessageDirection = "inbound" | "outbound";

/**
 * Where a text is. Inbound texts are `received`; outbound ones follow
 * Twilio's own lifecycle, reported back through the status callback.
 */
export type PhoneMessageStatus =
  | "received"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "undelivered"
  | "failed";

/**
 * One text sent or received on a {@link PhoneNumber}.
 *
 * `providerSid` is Twilio's message sid (`SM…` / `MM…`) and is unique, which is
 * what makes delivery idempotent: Twilio retries a webhook it did not see
 * acknowledged, and the inbound poller can see a text the webhook already
 * delivered. Whoever inserts the row first handles the text; everyone else
 * finds it there. An outbound text has no sid until Twilio accepts it.
 *
 * `occurredAt` is when the text was sent or received according to Twilio —
 * kept apart from `createdAt` because a text fetched by the poller can arrive
 * here a minute after it reached the phone network.
 *
 * Bodies are stored as received. They are untrusted: an inbound text is
 * written by a stranger, and anything that shows it to a model frames it as
 * data. Texts are visible to owners and admins, never to the wider company —
 * a verification code is as sensitive as the account it unlocks.
 */
@Entity("phone_messages")
// Ends in `id`, so a page of one number's texts newest first — keyset on
// (occurredAt, id) — is read in index order, ties and all.
@Index(["phoneNumberId", "occurredAt", "id"])
@Index(["companyId", "occurredAt"])
@Index(["providerSid"], { unique: true, where: '"providerSid" IS NOT NULL' })
export class PhoneMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  phoneNumberId!: string;

  /** The AI Employee the number belonged to when the text was sent or received. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: "varchar" })
  direction!: PhoneMessageDirection;

  /** E.164, a short code, or an alphanumeric sender id. */
  @Column({ type: "varchar" })
  fromNumber!: string;

  @Column({ type: "varchar" })
  toNumber!: string;

  @Column({ type: "varchar", nullable: true })
  providerSid!: string | null;

  @Column({ type: "varchar" })
  status!: PhoneMessageStatus;

  @Column({ type: dateTimeColumnType })
  occurredAt!: Date;

  /** Twilio error code for a failed send, when it gave one. */
  @Column({ type: "integer", nullable: true })
  errorCode!: number | null;

  @Column({ type: "varchar", default: "" })
  errorMessage!: string;

  /** Member who sent this from the app; null when the AI Employee sent it. */
  @Column({ type: "varchar", nullable: true })
  sentByUserId!: string | null;

  /** The Run an AI-sent text was part of, for provenance. */
  @Column({ type: "varchar", nullable: true })
  runId!: string | null;

  /** True when the AI Employee wrote this as an automatic reply. */
  @Column({ type: "boolean", default: false })
  autoReply!: boolean;

  /** JSON `[{contentType, url}]` for picture messages. Empty when there are none. */
  @Column({ type: "text", default: "" })
  mediaJson!: string;

  @Column({ type: "text", default: "" })
  body!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
