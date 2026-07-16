import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type MailLabelType = "system" | "user";

/**
 * Local mirror of one Gmail label. System labels (INBOX, SENT, STARRED, …)
 * are Gmail-defined; user labels are the account owner's own taxonomy and
 * the vocabulary AI employees categorize into. Refreshed on every sync pass.
 */
@Entity("mail_labels")
@Index(["accountId"])
@Index(["accountId", "gmailLabelId"], { unique: true })
export class MailLabel {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar" })
  gmailLabelId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "user" })
  labelType!: MailLabelType;

  /** Gmail background color hex when the user set one; empty otherwise. */
  @Column({ type: "varchar", default: "" })
  color!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
