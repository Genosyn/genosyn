import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * A file attached to a Base record. Bytes live on disk under
 * `data/companies/<slug>/base-attachments/<uuid>.<ext>`; only metadata sits in
 * sqlite so large binaries don't bloat the DB.
 *
 * Uploader is either a human Member (`uploadedByUserId`) or an AI Employee
 * (`uploadedByEmployeeId`) — exactly one is set, matching how
 * {@link BaseRecordComment} attributes authorship.
 *
 * `companyId` is denormalized so the download handler can resolve the
 * on-disk path without re-walking record → table → base → company.
 */
@Entity("base_record_attachments")
export class BaseRecordAttachment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  recordId!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  filename!: string;

  @Column({ type: "varchar", default: "application/octet-stream" })
  mimeType!: string;

  @Column({ type: "bigint", default: 0 })
  sizeBytes!: number;

  /** Relative to `data/companies/<slug>/base-attachments/`. */
  @Column({ type: "varchar" })
  storageKey!: string;

  @Column({ type: "varchar", nullable: true })
  uploadedByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  uploadedByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
