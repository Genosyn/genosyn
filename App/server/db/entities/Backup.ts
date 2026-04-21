import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

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

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  completedAt!: Date | null;
}
