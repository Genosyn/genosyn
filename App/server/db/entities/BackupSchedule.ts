import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from "typeorm";

export type BackupFrequency = "daily" | "weekly" | "monthly";

/**
 * Singleton row (id='default') holding the recurring-backup configuration
 * and the retention policy. The row always exists — {@link getBackupSchedule}
 * creates it lazily on first read. Modelled as an entity rather than a dotfile
 * so the settings page can round-trip through the same TypeORM repo as
 * everything else.
 */
@Entity("backup_schedules")
export class BackupSchedule {
  @PrimaryColumn({ type: "varchar" })
  id!: string;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  @Column({ type: "varchar", default: "daily" })
  frequency!: BackupFrequency;

  /** Hour of day (0-23, server local time) the schedule fires. */
  @Column({ type: "integer", default: 3 })
  hour!: number;

  /** Sunday=0..Saturday=6. Only used when frequency = "weekly". */
  @Column({ type: "integer", default: 0 })
  dayOfWeek!: number;

  /** 1..28. Only used when frequency = "monthly". Capped at 28 so it fires
   * every month regardless of length. */
  @Column({ type: "integer", default: 1 })
  dayOfMonth!: number;

  @Column({ type: "datetime", nullable: true })
  lastRunAt!: Date | null;

  /**
   * When true, archives older than {@link retentionDays} are deleted from
   * `<dataDir>/Backup/`. Independent of {@link enabled} — an install that only
   * ever takes manual backups still accumulates them, so retention is not
   * gated on the recurring schedule being on.
   */
  @Column({ type: "boolean", default: false })
  retentionEnabled!: boolean;

  /** Age (in days) past which an archive is eligible for deletion. */
  @Column({ type: "integer", default: 30 })
  retentionDays!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}
