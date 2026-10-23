import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Where one backup's copy on one off-box destination stands.
 *
 *   - `pending` → waiting its turn: copies go to one destination at a time.
 *   - `copying` → being copied there right now.
 *   - `copied`  → it arrived whole, or daily verification found it there.
 *   - `failed`  → it didn't arrive; {@link BackupCopy.error} says why.
 *   - `missing` → daily verification looked and it isn't there (any more).
 *   - `removed` → off-box retention deleted it there on purpose.
 *
 * Written by the delivery itself (`services/backupDestinations.ts`), by
 * off-box retention, and by daily verification, which is the only one that
 * may say anything about a backup taken before copies were recorded — and
 * only what it actually finds on the destination. Rows go with their backup
 * and with their destination; there are no foreign keys in this codebase, so
 * the services delete them explicitly.
 */
export type BackupCopyStatus = "pending" | "copying" | "copied" | "failed" | "missing" | "removed";

@Entity("backup_copies")
@Index(["backupId", "destinationId"], { unique: true })
@Index(["destinationId"])
export class BackupCopy {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  backupId!: string;

  @Column({ type: "varchar" })
  destinationId!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: BackupCopyStatus;

  /** Why the copy isn't there, in the destination's own words; empty otherwise. */
  @Column({ type: "text", default: "" })
  error!: string;

  /** When the latest attempt to copy it there began; null until one has. */
  @Column({ type: dateTimeColumnType, nullable: true })
  startedAt!: Date | null;

  /** When it arrived; null when daily verification found it without seeing it arrive. */
  @Column({ type: dateTimeColumnType, nullable: true })
  copiedAt!: Date | null;

  /** When daily verification last looked for it on the destination. */
  @Column({ type: dateTimeColumnType, nullable: true })
  checkedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
