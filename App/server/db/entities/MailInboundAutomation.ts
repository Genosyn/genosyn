import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type MailInboundAutomationStatus = "queued" | "running" | "succeeded" | "failed";

/**
 * Durable outbox entry for the rules and Pipelines triggered by one inbound
 * Gmail message. The unique Gmail key is the replay guard: a failed sync can
 * safely revisit history without launching the same automation twice.
 */
@Entity("mail_inbound_automations")
@Index(["companyId"])
@Index(["accountId", "status"])
@Index(["accountId", "gmailMessageId"], { unique: true })
export class MailInboundAutomation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar" })
  messageId!: string;

  @Column({ type: "varchar" })
  gmailMessageId!: string;

  @Column({ type: "varchar", default: "queued" })
  status!: MailInboundAutomationStatus;

  @Column({ type: dateTimeColumnType, nullable: true })
  startedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  @Column({ type: "text", default: "" })
  errorMessage!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
