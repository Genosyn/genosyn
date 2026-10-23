import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type BackupKind = "manual" | "scheduled" | "uploaded";
export type BackupStatus = "running" | "completed" | "failed";

/**
 * One row per backup archive written to `<dataDir>/Backup/`. The filename is
 * relative to that folder — the absolute path is resolved at serve time so
 * moving `dataDir` doesn't invalidate history. Rows are only removed when the
 * user deletes a backup from the UI.
 */
@Entity("backups")
@Index(["createdAt"])
export class Backup {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  filename!: string;

  @Column({ type: "integer", default: 0 })
  sizeBytes!: number;

  @Column({ type: "varchar", default: "manual" })
  kind!: BackupKind;

  @Column({ type: "varchar", default: "running" })
  status!: BackupStatus;

  @Column({ type: "text", default: "" })
  errorMessage!: string;

  /**
   * Whether every attempt to copy this backup off-box is recorded as a
   * `BackupCopy`. False for backups taken before copies were recorded, for
   * archives found on disk without a row, and for a row a restore brought back
   * mid-backup — for those, a destination with no copy row is "not recorded",
   * never "not copied", until daily verification looks for it there.
   */
  @Column({ type: "boolean", default: false })
  copiesTracked!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  completedAt!: Date | null;
}
