import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * Review queue row produced from one Gmail attachment.
 *
 * Source-message/index is the cheap idempotency key before bytes are fetched;
 * `contentHash` becomes the cross-message dedupe key after review/backfill.
 */
@Entity("revenue_document_candidates")
@Index(["companyId", "status", "createdAt"])
@Index(["companyId", "mailMessageId", "attachmentIndex"], { unique: true })
@Index(["companyId", "contentHash"])
@Index(
  "UQ_revenue_document_candidates_gmail_attachment",
  ["companyId", "gmailMessageId", "gmailAttachmentId"],
  {
    unique: true,
    where: `"gmailMessageId" <> '' AND "gmailAttachmentId" <> ''`,
  },
)
export class RevenueDocumentCandidate {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  mailMessageId!: string;

  @Column({ type: "int" })
  attachmentIndex!: number;

  /** Immutable Gmail provenance, retained even if the local Mail row is removed. */
  @Column({ type: "varchar", default: "" })
  gmailMessageId!: string;

  @Column({ type: "varchar", default: "" })
  gmailThreadId!: string;

  @Column({ type: "varchar", default: "" })
  gmailAttachmentId!: string;

  @Column({ type: "varchar" })
  filename!: string;

  @Column({ type: "varchar" })
  mimeType!: string;

  @Column({ type: "bigint", default: 0 })
  sizeBytes!: number;

  @Column({ type: "varchar", default: "" })
  contentHash!: string;

  @Column({ type: "varchar" })
  proposedKind!: string;

  @Column({ type: "varchar", nullable: true })
  proposedResourceType!: "account" | "contact" | "deal" | "partnership" | null;

  @Column({ type: "varchar", nullable: true })
  proposedResourceId!: string | null;

  @Column({ type: "int" })
  confidence!: number;

  @Column({ type: "text" })
  alternativesJson!: string;

  @Column({ type: "varchar" })
  status!: "pending" | "processing" | "accepted" | "rejected" | "duplicate";

  /**
   * Short lease used while Gmail bytes are fetched and persisted. A token
   * prevents a stale reviewer from finalizing a claim recovered by another
   * process.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  processingAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  processingToken!: string | null;

  @Column({ type: "varchar", nullable: true })
  revenueDocumentId!: string | null;

  @Column({ type: "text", default: "" })
  reviewNote!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  reviewedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  reviewedByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
