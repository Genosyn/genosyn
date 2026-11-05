import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { SupportConfidence, SupportDraftStatus } from "../../../shared/support.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * A reply an AI Employee wrote, waiting for or decided by a person.
 *
 * A row of its own, rather than a field on the ticket, because what happened to
 * each one is the evidence for trusting it further: how many went out untouched,
 * how many were edited first, how many were thrown away, per topic. Only one is
 * `ready` on a ticket at a time; a newer message supersedes the last.
 */
@Entity("support_drafts")
@Index(["ticketId", "status"])
@Index(["companyId", "createdAt"])
export class SupportDraft {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  ticketId!: string;

  @Column({ type: "varchar", default: "ready" })
  status!: SupportDraftStatus;

  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /** The customer's message this answers. */
  @Column({ type: "varchar", nullable: true })
  basedOnMessageId!: string | null;

  /** The model says the Articles it was shown answer this. */
  @Column({ type: "boolean", default: false })
  answerable!: boolean;

  @Column({ type: "varchar", default: "low" })
  confidence!: SupportConfidence;

  /** The customer's message tried to instruct the AI Employee. */
  @Column({ type: "boolean", default: false })
  injectionDetected!: boolean;

  /** A person changed the words before it went out. */
  @Column({ type: "boolean", default: false })
  editedBeforeSend!: boolean;

  /** The topic it was written under, kept for reporting how each topic's drafts fare. */
  @Column({ type: "varchar", nullable: true })
  topicKey!: string | null;

  @Column({ type: "varchar", nullable: true })
  sentMessageId!: string | null;

  /** The Member who sent or discarded it. Null when it went out on its own. */
  @Column({ type: "varchar", nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  decidedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: "text", default: "" })
  body!: string;

  /** The reply in the company's working language, when written in another. */
  @Column({ type: "text", default: "" })
  translation!: string;

  /** JSON `SupportCitation[]`: only quotes the server found word for word. */
  @Column({ type: "text", default: "[]" })
  citationsJson!: string;

  /** For the company's people: what is missing or uncertain. Never sent. */
  @Column({ type: "text", default: "" })
  note!: string;

  /** JSON string array: each check that kept it from going out on its own. */
  @Column({ type: "text", default: "[]" })
  holdReasonsJson!: string;

  /** The question the Articles could not answer, in general terms. Feeds knowledge gaps. */
  @Column({ type: "text", default: "" })
  gapQuestion!: string;
}
