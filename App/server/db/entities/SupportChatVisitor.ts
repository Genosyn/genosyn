import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One browser talking to one Chat widget: a stranger with a token. Their token is
 * a bearer credential kept only as a hash, so a copy of the database opens nothing,
 * and it reaches the rows stamped with this visitor's id and no others.
 *
 * `pendingEmail` is what they typed, and it is only a claim: anyone can type anyone's
 * address. It earns one fixed-text email and nothing else. `email` is set once a
 * person presses Confirm on the link in that email, and only then does it become
 * the Ticket's requester, match a Customer or receive a reply.
 *
 * `lastSeq` is the visitor's own message sequence, taken under this row's lock, so
 * the widget's cursor never skips a row the way a timestamp can.
 */
@Entity("support_chat_visitors")
@Index(["companyId"])
@Index(["widgetId", "createdAt"])
@Index(["tokenHash"], { unique: true })
@Index(["pendingEmailTokenHash"], { unique: true })
@Index(["lastSeq", "createdAt"])
export class SupportChatVisitor {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  widgetId!: string;

  /** Null once they ended the chat: nothing opens it after that. */
  @Column({ type: "varchar", nullable: true })
  tokenHash!: string | null;

  /** Whatever they typed. Proves nothing, like the name on an email. */
  @Column({ type: "varchar", default: "" })
  name!: string;

  /** Confirmed by a person pressing a button on a link sent to it. */
  @Column({ type: "varchar", default: "" })
  email!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  emailConfirmedAt!: Date | null;

  /** Typed, and not confirmed. Never a requester, never matched to anyone. */
  @Column({ type: "varchar", default: "" })
  pendingEmail!: string;

  /** Set when the confirmation email is sent. Only its hash is kept. */
  @Column({ type: "varchar", nullable: true })
  pendingEmailTokenHash!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  pendingEmailSentAt!: Date | null;

  /** The last number handed to a row of this visitor's conversation. */
  @Column({ type: "int", default: 0 })
  lastSeq!: number;

  /** The last row their open widget showed them. */
  @Column({ type: "int", default: 0 })
  readSeq!: number;

  /** The last row an email already carried to them. */
  @Column({ type: "int", default: 0 })
  emailedSeq!: number;

  /** When their token last worked, to the hour; it lapses after a month unused. */
  @Column({ type: dateTimeColumnType })
  lastSeenAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
