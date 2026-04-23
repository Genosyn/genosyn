import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * A file uploaded as part of a {@link ChannelMessage}. The bytes live on disk
 * under `data/companies/<slug>/attachments/<uuid>.<ext>` (see
 * services/uploads.ts) so large files don't bloat sqlite. We store the
 * original filename for the download prompt + mime type for inline image
 * rendering.
 *
 * `messageId` is nullable because uploads happen in two phases: the client
 * POSTs the file first (getting back an attachment id), then sends a message
 * referencing the ids. If the user abandons the composer, the row lingers
 * until a nightly sweep cleans orphans — until then the file is unreachable
 * from the UI, which is fine for v1.
 */
@Entity("attachments")
@Index(["messageId"])
export class Attachment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", nullable: true })
  messageId!: string | null;

  @Column({ type: "varchar" })
  filename!: string;

  @Column({ type: "varchar", default: "application/octet-stream" })
  mimeType!: string;

  @Column({ type: "bigint", default: 0 })
  sizeBytes!: number;

  /** Relative to `data/companies/<slug>/attachments/`. */
  @Column({ type: "varchar" })
  storageKey!: string;

  @Column({ type: "varchar", nullable: true })
  uploadedByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
