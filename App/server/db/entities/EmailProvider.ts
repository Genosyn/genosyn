import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Per-company configured email provider used to send notification emails
 * (invitations, password resets, alerts, etc.). One company can register
 * multiple providers and mark one as default; non-default rows are kept
 * around so a user can switch back without re-entering credentials.
 *
 * `kind` selects which transport adapter in `services/emailTransports.ts`
 * decrypts and uses `encryptedConfig`. Shapes per kind:
 *   - smtp     : { host, port, secure, user, pass }
 *   - sendgrid : { apiKey }
 *   - mailgun  : { apiKey, domain, region: "us" | "eu" }
 *   - resend   : { apiKey }
 *   - postmark : { serverToken }
 *
 * `fromAddress` is required and used as the envelope from. `replyTo` is
 * optional. Credentials live encrypted with the same sessionSecret-derived
 * key as Secrets / IntegrationConnections / AIModel apikeys.
 */
export type EmailProviderKind =
  | "smtp"
  | "sendgrid"
  | "mailgun"
  | "resend"
  | "postmark";

export type EmailProviderTestStatus = "ok" | "failed";

@Entity("email_providers")
@Index(["companyId"])
@Index(["companyId", "isDefault"])
export class EmailProvider {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Human label, e.g. "Acme Mailgun (production)". */
  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  kind!: EmailProviderKind;

  /** Envelope from — `Acme <no-reply@acme.com>` or just `no-reply@acme.com`. */
  @Column({ type: "varchar" })
  fromAddress!: string;

  /** Optional reply-to header. Empty string when unset. */
  @Column({ type: "varchar", default: "" })
  replyTo!: string;

  /** AES-256-GCM ciphertext wrapping the kind-specific JSON config. */
  @Column({ type: "text" })
  encryptedConfig!: string;

  @Column({ type: "boolean", default: false })
  isDefault!: boolean;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @Column({ type: "datetime", nullable: true })
  lastTestedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  lastTestStatus!: EmailProviderTestStatus | null;

  @Column({ type: "varchar", default: "" })
  lastTestMessage!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
