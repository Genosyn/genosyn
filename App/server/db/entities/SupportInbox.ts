import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { SupportAiMode } from "../../../shared/support.js";
import { dateTimeColumnType } from "./columnTypes.js";

export type SupportInboxStatus = "active" | "paused";
export type SupportImportStatus = "none" | "pending" | "done";

/**
 * A mailbox, and which mail on it counts as support.
 *
 * It holds no credential and reads no mail of its own: a `MailAccount` keeps the
 * mirror in step with the mail server, and this row says what to make of it. An
 * empty `addressesJson` means everything sent to the mailbox; a list means only
 * mail addressed to those addresses, which is how a person's own inbox can watch
 * for support@ and leave the rest of their mail alone. One mailbox may hold
 * several inboxes — support@ and billing@ on one Google Workspace account — and
 * an address always wins over a whole-mailbox inbox.
 *
 * Deleting an inbox leaves its tickets: `inboxId` then dangles to nothing, and
 * the tickets stay readable. They are the company's record of what customers
 * asked, which should not depend on a mailbox staying connected.
 */
@Entity("support_inboxes")
@Index(["companyId"])
@Index(["accountId"])
export class SupportInbox {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "active" })
  status!: SupportInboxStatus;

  /**
   * Who replies come from. Empty answers from the address the customer wrote to,
   * which on someone's own mailbox is the alias they were watching for.
   */
  @Column({ type: "varchar", default: "" })
  fromAddress!: string;

  /** The name recipients see beside it. Empty uses the mailbox's own. */
  @Column({ type: "varchar", default: "" })
  fromName!: string;

  @Column({ type: "varchar", default: "draft" })
  aiMode!: SupportAiMode;

  /** Null uses the AI Employee on Support's settings. */
  @Column({ type: "varchar", nullable: true })
  aiEmployeeId!: string | null;

  /** The most replies an AI Employee may send on its own from this inbox in a day. */
  @Column({ type: "int", default: 100 })
  autoReplyDailyLimit!: number;

  /** Whether a new ticket gets the one automatic "we got your email". */
  @Column({ type: "boolean", default: false })
  acknowledge!: boolean;

  /** Archive the conversation in the mailbox when its ticket is solved. */
  @Column({ type: "boolean", default: false })
  archiveOnSolve!: boolean;

  /**
   * Mail sent before this never becomes a ticket, so connecting a mailbox with
   * ten years in it does not open ten years of tickets. Set from how far back
   * the owners chose to import.
   */
  @Column({ type: dateTimeColumnType })
  watchFrom!: Date;

  @Column({ type: "varchar", default: "none" })
  importStatus!: SupportImportStatus;

  @Column({ type: "int", default: 0 })
  importedCount!: number;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** JSON array of lower-case addresses; empty means everything sent to the mailbox. */
  @Column({ type: "text", default: "[]" })
  addressesJson!: string;

  /** What this inbox's AI Employee should know beyond Support's own instructions. */
  @Column({ type: "text", default: "" })
  aiInstructions!: string;

  @Column({ type: "text", default: "" })
  signature!: string;

  /** The acknowledgement's text. Null is the default text. */
  @Column({ type: "text", nullable: true })
  acknowledgementBody!: string | null;
}
