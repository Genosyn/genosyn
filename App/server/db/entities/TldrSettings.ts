import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export const TLDR_CADENCES = [
  "four_hours",
  "eight_hours",
  "twelve_hours",
  "daily",
  "weekly",
] as const;

export type TldrCadence = (typeof TLDR_CADENCES)[number];

/**
 * One company's TLDR policy.
 *
 * The selected AI Employee supplies the judgement and voice; `nextRunAt` is
 * the durable scheduler cursor. `lastCoveredAt` advances only after a ready
 * TLDR (or an empty source window), so a failed generation is folded into the
 * next attempt instead of silently losing that interval.
 */
@Entity("tldr_settings")
@Index(["companyId"], { unique: true })
@Index(["enabled", "nextRunAt"])
export class TldrSettings {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  @Column({ type: "varchar", default: "daily" })
  cadence!: TldrCadence;

  @Column({ type: dateTimeColumnType, nullable: true })
  nextRunAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastCoveredAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastGeneratedAt!: Date | null;

  /** Most recent generation claim, whether it produced a TLDR or failed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastAttemptAt!: Date | null;

  /** The durable in-flight claim. Cleared on success, empty input, or failure. */
  @Column({ type: "varchar", nullable: true })
  activeTldrId!: string | null;

  /** Latest actionable generation error for the settings page. */
  @Column({ type: "text", default: "" })
  lastError!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
