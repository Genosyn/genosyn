import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * Append-only record of every notification email the platform attempted to
 * deliver. Stored per-company when the send happened inside a company
 * context (invitations, alerts, …); `companyId` is null for system emails
 * that fire before the user is in a company (signup welcome, password
 * reset).
 *
 * The body is captured as plain text only and capped to keep DB size
 * predictable — the rendered HTML is not persisted. `errorMessage` is the
 * upstream provider's failure string when `status === "failed"`.
 */
export type EmailLogStatus = "sent" | "failed" | "skipped";

/**
 * Where the message went out from. Reflects the resolved transport, not the
 * configured-but-unused providers.
 */
export type EmailLogTransport =
  | "smtp"
  | "sendgrid"
  | "mailgun"
  | "resend"
  | "postmark"
  | "config_smtp"
  | "console";

/**
 * Why this email was sent. Used to filter the logs page.
 */
export type EmailLogPurpose =
  | "invitation"
  | "password_reset"
  | "welcome"
  | "test"
  | "other";

@Entity("email_logs")
@Index(["companyId", "createdAt"])
@Index(["status"])
export class EmailLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Null for system-level sends (signup welcome, forgot-password). */
  @Column({ type: "varchar", nullable: true })
  companyId!: string | null;

  /** Resolved provider row id, when sent through a company provider. */
  @Column({ type: "varchar", nullable: true })
  providerId!: string | null;

  @Column({ type: "varchar" })
  transport!: EmailLogTransport;

  @Column({ type: "varchar", default: "other" })
  purpose!: EmailLogPurpose;

  @Column({ type: "varchar" })
  toAddress!: string;

  @Column({ type: "varchar", default: "" })
  fromAddress!: string;

  @Column({ type: "varchar" })
  subject!: string;

  /** Plain-text body, capped at ~16KB on insert. */
  @Column({ type: "text", default: "" })
  bodyPreview!: string;

  @Column({ type: "varchar", default: "sent" })
  status!: EmailLogStatus;

  /** Upstream error string when status === "failed", else empty. */
  @Column({ type: "varchar", default: "" })
  errorMessage!: string;

  /** Provider-returned message id where available (SMTP, SendGrid, …). */
  @Column({ type: "varchar", default: "" })
  messageId!: string;

  /** User who triggered the send when known (test sends, manual invites). */
  @Column({ type: "varchar", nullable: true })
  triggeredByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
